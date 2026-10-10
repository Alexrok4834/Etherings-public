use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::Hasher,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const CONFIG_SEED: &[u8] = b"design-config";
const DESIGN_SEED: &[u8] = b"silver-design-set";
const CONFIG_LEN: usize = 113;
const HEADER_LEN: usize = 104;
const MAX_DESIGNS: usize = 42;
const MAX_URI_BYTES: usize = 200;
const MAX_ENTRY_BYTES: usize = 38 + MAX_URI_BYTES;
const MAGIC: &[u8; 8] = b"ERSDSV1\0";
const DOMAIN: &[u8; 30] = b"ETHERINGS_SILVER_DESIGN_SET_V1";

fn le_u16(bytes: &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u32(bytes: &[u8]) -> Result<u32, ProgramError> {
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn check_programdata_authority(
    program_id: &Pubkey,
    programdata: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let (expected, _) =
        Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id());
    if !authority.is_signer
        || programdata.key != &expected
        || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len() < bpf_loader_upgradeable::UpgradeableLoaderState::size_of_programdata_metadata()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = programdata.try_borrow_data()?;
    let state: bpf_loader_upgradeable::UpgradeableLoaderState = bincode::deserialize(
        &data[..bpf_loader_upgradeable::UpgradeableLoaderState::size_of_programdata_metadata()],
    )
    .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        bpf_loader_upgradeable::UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(found),
            ..
        } if found == *authority.key => Ok(()),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

fn create_pda<'a>(
    account: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    if account.lamports() != 0 || !account.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            account.key,
            Rent::get()?.minimum_balance(space),
            space as u64,
            owner,
        ),
        &[payer.clone(), account.clone(), system.clone()],
        &[seeds],
    )
}

fn check_config(
    program_id: &Pubkey,
    config: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let expected = Pubkey::find_program_address(&[CONFIG_SEED], program_id).0;
    if config.key != &expected || config.owner != program_id || config.data_len() != CONFIG_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = config.try_borrow_data()?;
    if data[0] != 1 || data[1..33] != authority.key.to_bytes() || !authority.is_signer {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}

fn parse_and_commit(
    program_id: &Pubkey,
    design_key: &Pubkey,
    data: &[u8],
    require_frozen: bool,
) -> Result<([u8; 32], u64, u16), ProgramError> {
    if data.len() < HEADER_LEN || &data[0..8] != MAGIC || data[8] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    if (require_frozen && data[9] != 1) || (!require_frozen && data[9] > 1) {
        return Err(ProgramError::InvalidAccountData);
    }
    let capacity = le_u16(&data[10..12])? as usize;
    let count = le_u16(&data[12..14])?;
    let used = le_u16(&data[14..16])? as usize;
    let version = le_u64(&data[16..24])?;
    if version == 0
        || capacity == 0
        || capacity > MAX_DESIGNS
        || count as usize > capacity
        || used > capacity * MAX_ENTRY_BYTES
        || data.len() != HEADER_LEN + capacity * MAX_ENTRY_BYTES
        || Pubkey::find_program_address(&[DESIGN_SEED, &version.to_le_bytes()], program_id).0
            != *design_key
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let end = HEADER_LEN
        .checked_add(used)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if end > data.len() || data[end..].iter().any(|byte| *byte != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut hasher = Hasher::default();
    hasher.hash(DOMAIN);
    hasher.hash(program_id.as_ref());
    hasher.hash(design_key.as_ref());
    hasher.hash(&version.to_le_bytes());
    hasher.hash(&count.to_le_bytes());
    let mut cursor = HEADER_LEN;
    let mut previous = 0u32;
    for _ in 0..count {
        if cursor + 38 > end {
            return Err(ProgramError::InvalidAccountData);
        }
        let id = le_u32(&data[cursor..cursor + 4])?;
        let uri_len = le_u16(&data[cursor + 4..cursor + 6])? as usize;
        let entry_end = cursor
            .checked_add(38 + uri_len)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if id == 0
            || id <= previous
            || uri_len == 0
            || uri_len > MAX_URI_BYTES
            || entry_end > end
            || !data[cursor + 6..cursor + 6 + uri_len]
                .iter()
                .all(|byte| (0x21..=0x7e).contains(byte))
            || data[entry_end - 32..entry_end].iter().all(|byte| *byte == 0)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        hasher.hash(&data[cursor..entry_end]);
        cursor = entry_end;
        previous = id;
    }
    if cursor != end || (require_frozen && count == 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((hasher.result().to_bytes(), version, count))
}

fn initialize_config(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_programdata_authority(program_id, programdata, authority)?;
    let (expected, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected || !authority.is_writable || !config.is_writable {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(
        config,
        authority,
        system,
        program_id,
        CONFIG_LEN,
        &[CONFIG_SEED, &[bump]],
    )?;
    let mut data = config.try_borrow_mut_data()?;
    data.fill(0);
    data[0] = 1;
    data[1..33].copy_from_slice(authority.key.as_ref());
    data[105..113].copy_from_slice(&1u64.to_le_bytes());
    Ok(())
}

fn create_design_set(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    if instruction.len() != 11 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_config(program_id, config, authority)?;
    let version = le_u64(&instruction[1..9])?;
    let capacity = le_u16(&instruction[9..11])? as usize;
    let next_version = {
        let data = config.try_borrow_data()?;
        le_u64(&data[105..113])?
    };
    let version_seed = version.to_le_bytes();
    let (expected, bump) =
        Pubkey::find_program_address(&[DESIGN_SEED, &version_seed], program_id);
    if version != next_version
        || capacity == 0
        || capacity > MAX_DESIGNS
        || design.key != &expected
        || !design.is_writable
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    create_pda(
        design,
        authority,
        system,
        program_id,
        HEADER_LEN + capacity * MAX_ENTRY_BYTES,
        &[DESIGN_SEED, &version_seed, &[bump]],
    )?;
    {
        let mut data = design.try_borrow_mut_data()?;
        data.fill(0);
        data[0..8].copy_from_slice(MAGIC);
        data[8] = 1;
        data[9] = 0;
        data[10..12].copy_from_slice(&(capacity as u16).to_le_bytes());
        data[16..24].copy_from_slice(&version.to_le_bytes());
        data[24..56].copy_from_slice(authority.key.as_ref());
        data[88..96].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    }
    let mut config_data = config.try_borrow_mut_data()?;
    config_data[105..113].copy_from_slice(
        &version
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .to_le_bytes(),
    );
    Ok(())
}

fn append_design(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    if instruction.len() < 39 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config(program_id, config, authority)?;
    if design.owner != program_id || !design.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let id = le_u32(&instruction[1..5])?;
    let uri_len = le_u16(&instruction[5..7])? as usize;
    if uri_len == 0
        || uri_len > MAX_URI_BYTES
        || instruction.len() != 7 + uri_len + 32
        || id == 0
        || !instruction[7..7 + uri_len]
            .iter()
            .all(|byte| (0x21..=0x7e).contains(byte))
        || instruction[7 + uri_len..].iter().all(|byte| *byte == 0)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut data = design.try_borrow_mut_data()?;
    parse_and_commit(program_id, design.key, &data, false)?;
    if data[9] != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let capacity = le_u16(&data[10..12])?;
    let count = le_u16(&data[12..14])?;
    let used = le_u16(&data[14..16])? as usize;
    if count >= capacity {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if count > 0 {
        let mut cursor = HEADER_LEN;
        let mut last = 0u32;
        for _ in 0..count {
            last = le_u32(&data[cursor..cursor + 4])?;
            let len = le_u16(&data[cursor + 4..cursor + 6])? as usize;
            cursor += 38 + len;
        }
        if id <= last {
            return Err(ProgramError::InvalidInstructionData);
        }
    }
    let start = HEADER_LEN + used;
    let end = start + 38 + uri_len;
    if end > data.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    data[start..start + 4].copy_from_slice(&id.to_le_bytes());
    data[start + 4..start + 6].copy_from_slice(&(uri_len as u16).to_le_bytes());
    data[start + 6..start + 6 + uri_len].copy_from_slice(&instruction[7..7 + uri_len]);
    data[start + 6 + uri_len..end].copy_from_slice(&instruction[7 + uri_len..]);
    data[12..14].copy_from_slice(&(count + 1).to_le_bytes());
    data[14..16].copy_from_slice(&((used + 38 + uri_len) as u16).to_le_bytes());
    Ok(())
}

fn freeze_design_set(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config(program_id, config, authority)?;
    if design.owner != program_id || !design.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let commitment = {
        let data = design.try_borrow_data()?;
        if data[9] != 0 || le_u16(&data[12..14])? == 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        parse_and_commit(program_id, design.key, &data, false)?.0
    };
    let mut data = design.try_borrow_mut_data()?;
    data[9] = 1;
    data[56..88].copy_from_slice(&commitment);
    data[96..104].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    Ok(())
}

fn activate_design_set(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config(program_id, config, authority)?;
    if design.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let (commitment, version, _) = {
        let data = design.try_borrow_data()?;
        let parsed = parse_and_commit(program_id, design.key, &data, true)?;
        if data[56..88] != parsed.0 {
            return Err(ProgramError::InvalidAccountData);
        }
        parsed
    };
    let mut data = config.try_borrow_mut_data()?;
    data[33..65].copy_from_slice(design.key.as_ref());
    data[65..73].copy_from_slice(&version.to_le_bytes());
    data[73..105].copy_from_slice(&commitment);
    Ok(())
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    match instruction.first() {
        Some(0) if instruction.len() == 1 => initialize_config(program_id, accounts),
        Some(1) => create_design_set(program_id, accounts, instruction),
        Some(2) => append_design(program_id, accounts, instruction),
        Some(3) if instruction.len() == 1 => freeze_design_set(program_id, accounts),
        Some(4) if instruction.len() == 1 => activate_design_set(program_id, accounts),
        _ => {
            msg!("unknown DesignSet proof instruction");
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_layout_bounds_match_contract() {
        assert_eq!(HEADER_LEN + MAX_ENTRY_BYTES, 342);
        assert_eq!(HEADER_LEN + MAX_DESIGNS * MAX_ENTRY_BYTES, 10_100);
        assert_eq!(MAGIC.len(), 8);
        assert_eq!(DOMAIN.len(), 30);
        assert_eq!(bpf_loader_upgradeable::UpgradeableLoaderState::size_of_programdata_metadata(), 45);
    }
}
