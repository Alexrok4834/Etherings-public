use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable,
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::Hasher,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const CONFIG_SEED: &[u8] = b"silver-config";
const DESIGN_SEED: &[u8] = b"silver-design-set";
const OPEN_SEED: &[u8] = b"silver-open";
const RING_SEED: &[u8] = b"silver-ring-state";
const CONFIG_V1_LEN: usize = 65;
const CONFIG_V2_LEN: usize = 145;
const DESIGN_HEADER_LEN: usize = 104;
const MAX_DESIGNS: usize = 42;
const MAX_URI_BYTES: usize = 200;
const MAX_ENTRY_BYTES: usize = 38 + MAX_URI_BYTES;
const OPERATION_LEN: usize = 226;
const RING_LEN: usize = 217;
const DESIGN_MAGIC: &[u8; 8] = b"ERSDSV1\0";
const OPERATION_MAGIC: &[u8; 8] = b"ERSOPV1\0";
const RING_MAGIC: &[u8; 8] = b"ERSRNGV1";
const DESIGN_DOMAIN: &[u8; 30] = b"ETHERINGS_SILVER_DESIGN_SET_V1";

fn le_u16(bytes: &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u32(bytes: &[u8]) -> Result<u32, ProgramError> {
    Ok(u32::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn check_programdata_authority(
    program_id: &Pubkey,
    programdata: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    let expected =
        Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id()).0;
    if !authority.is_signer
        || programdata.key != &expected
        || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len()
            < bpf_loader_upgradeable::UpgradeableLoaderState::size_of_programdata_metadata()
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
        _ => Err(ProgramError::IllegalOwner),
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

fn config_authority(program_id: &Pubkey, config: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let expected = Pubkey::find_program_address(&[CONFIG_SEED], program_id).0;
    if config.key != &expected || config.owner != program_id || config.data_len() != CONFIG_V2_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = config.try_borrow_data()?;
    if data[0] != 2 {
        return Err(ProgramError::InvalidAccountData);
    }
    let authority = Pubkey::new_from_array(
        data[1..33]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    if authority == Pubkey::default() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(authority)
}

fn check_config_authority(
    program_id: &Pubkey,
    config: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    if !authority.is_signer || config_authority(program_id, config)? != *authority.key {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}

fn parse_design(
    program_id: &Pubkey,
    design_key: &Pubkey,
    data: &[u8],
    expected_authority: &Pubkey,
    require_frozen: bool,
) -> Result<([u8; 32], u64, u16), ProgramError> {
    if data.len() < DESIGN_HEADER_LEN || &data[0..8] != DESIGN_MAGIC || data[8] != 1 {
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
        || data.len() != DESIGN_HEADER_LEN + capacity * MAX_ENTRY_BYTES
        || data[24..56] != expected_authority.to_bytes()
        || Pubkey::find_program_address(&[DESIGN_SEED, &version.to_le_bytes()], program_id).0
            != *design_key
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let end = DESIGN_HEADER_LEN
        .checked_add(used)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if end > data.len() || data[end..].iter().any(|byte| *byte != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut hasher = Hasher::default();
    hasher.hash(DESIGN_DOMAIN);
    hasher.hash(program_id.as_ref());
    hasher.hash(design_key.as_ref());
    hasher.hash(&version.to_le_bytes());
    hasher.hash(&count.to_le_bytes());
    let mut cursor = DESIGN_HEADER_LEN;
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
            || data[entry_end - 32..entry_end]
                .iter()
                .all(|byte| *byte == 0)
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

fn selected_entry(data: &[u8], index: u16) -> Result<(u32, [u8; 32]), ProgramError> {
    let count = le_u16(&data[12..14])?;
    if index >= count {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut cursor = DESIGN_HEADER_LEN;
    for current in 0..count {
        let id = le_u32(&data[cursor..cursor + 4])?;
        let uri_len = le_u16(&data[cursor + 4..cursor + 6])? as usize;
        let entry_end = cursor + 38 + uri_len;
        if current == index {
            return Ok((
                id,
                data[entry_end - 32..entry_end]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ));
        }
        cursor = entry_end;
    }
    Err(ProgramError::InvalidAccountData)
}

// Test-only unbiased byte rejection. This isolates stored-set selection; it is not the
// production field-stream mapping required by the reveal contract.
fn fixture_index(randomness: &[u8; 32], count: u16) -> Result<u16, ProgramError> {
    if count == 0 || count > MAX_DESIGNS as u16 {
        return Err(ProgramError::InvalidAccountData);
    }
    let modulus = count as u16;
    let limit = 256u16 - (256u16 % modulus);
    randomness
        .iter()
        .map(|byte| *byte as u16)
        .find(|value| *value < limit)
        .map(|value| value % modulus)
        .ok_or(ProgramError::InvalidInstructionData)
}

fn initialize_config_v1(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    if instruction.len() != 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
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
        CONFIG_V1_LEN,
        &[CONFIG_SEED, &[bump]],
    )?;
    let mut data = config.try_borrow_mut_data()?;
    data[0] = 1;
    data[1..33].copy_from_slice(authority.key.as_ref());
    data[33..65].copy_from_slice(&instruction[1..33]);
    Ok(())
}

fn migrate_config_v2(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_programdata_authority(program_id, programdata, authority)?;
    let expected = Pubkey::find_program_address(&[CONFIG_SEED], program_id).0;
    if config.key != &expected
        || config.owner != program_id
        || config.data_len() != CONFIG_V1_LEN
        || !authority.is_writable
        || !config.is_writable
    {
        return Err(ProgramError::InvalidAccountData);
    }
    {
        let data = config.try_borrow_data()?;
        if data[0] != 1 || data[1..33] != authority.key.to_bytes() {
            return Err(ProgramError::IllegalOwner);
        }
    }
    let required = Rent::get()?.minimum_balance(CONFIG_V2_LEN);
    let missing = required.saturating_sub(config.lamports());
    if missing > 0 {
        invoke(
            &system_instruction::transfer(authority.key, config.key, missing),
            &[authority.clone(), config.clone(), system.clone()],
        )?;
    }
    config.realloc(CONFIG_V2_LEN, false)?;
    let mut data = config.try_borrow_mut_data()?;
    data[0] = 2;
    data[65..].fill(0);
    data[65..73].copy_from_slice(&1u64.to_le_bytes());
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
    check_config_authority(program_id, config, authority)?;
    let version = le_u64(&instruction[1..9])?;
    let capacity = le_u16(&instruction[9..11])? as usize;
    let next_version = le_u64(&config.try_borrow_data()?[65..73])?;
    let version_bytes = version.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(&[DESIGN_SEED, &version_bytes], program_id);
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
        DESIGN_HEADER_LEN + capacity * MAX_ENTRY_BYTES,
        &[DESIGN_SEED, &version_bytes, &[bump]],
    )?;
    {
        let mut data = design.try_borrow_mut_data()?;
        data[0..8].copy_from_slice(DESIGN_MAGIC);
        data[8] = 1;
        data[10..12].copy_from_slice(&(capacity as u16).to_le_bytes());
        data[16..24].copy_from_slice(&version.to_le_bytes());
        data[24..56].copy_from_slice(authority.key.as_ref());
        data[88..96].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    }
    config.try_borrow_mut_data()?[65..73].copy_from_slice(
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
    check_config_authority(program_id, config, authority)?;
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
    let expected_authority = config_authority(program_id, config)?;
    let mut data = design.try_borrow_mut_data()?;
    parse_design(program_id, design.key, &data, &expected_authority, false)?;
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
        let mut cursor = DESIGN_HEADER_LEN;
        let mut last = 0u32;
        for _ in 0..count {
            last = le_u32(&data[cursor..cursor + 4])?;
            cursor += 38 + le_u16(&data[cursor + 4..cursor + 6])? as usize;
        }
        if id <= last {
            return Err(ProgramError::InvalidInstructionData);
        }
    }
    let start = DESIGN_HEADER_LEN + used;
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
    check_config_authority(program_id, config, authority)?;
    if design.owner != program_id || !design.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_authority = config_authority(program_id, config)?;
    let commitment = {
        let data = design.try_borrow_data()?;
        if data[9] != 0 {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        parse_design(program_id, design.key, &data, &expected_authority, false)?.0
    };
    let mut data = design.try_borrow_mut_data()?;
    if le_u16(&data[12..14])? == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
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
    check_config_authority(program_id, config, authority)?;
    if design.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_authority = config_authority(program_id, config)?;
    let (commitment, version, _) = {
        let data = design.try_borrow_data()?;
        let parsed = parse_design(program_id, design.key, &data, &expected_authority, true)?;
        if data[56..88] != parsed.0 {
            return Err(ProgramError::InvalidAccountData);
        }
        parsed
    };
    let mut data = config.try_borrow_mut_data()?;
    data[73..105].copy_from_slice(design.key.as_ref());
    data[105..113].copy_from_slice(&version.to_le_bytes());
    data[113..145].copy_from_slice(&commitment);
    Ok(())
}

fn begin_open_fixture(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    if instruction.len() != 41 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    let operation = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if !payer.is_signer || !payer.is_writable || design.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let box_mint: [u8; 32] = instruction[1..33]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let operation_number = le_u64(&instruction[33..41])?;
    if operation_number == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let authority = config_authority(program_id, config)?;
    let (commitment, version, count) = {
        let config_data = config.try_borrow_data()?;
        if config_data[73..105] != design.key.to_bytes() {
            return Err(ProgramError::InvalidAccountData);
        }
        let design_data = design.try_borrow_data()?;
        let parsed = parse_design(program_id, design.key, &design_data, &authority, true)?;
        if config_data[105..113] != parsed.1.to_le_bytes()
            || config_data[113..145] != parsed.0
            || design_data[56..88] != parsed.0
        {
            return Err(ProgramError::InvalidAccountData);
        }
        parsed
    };
    let operation_bytes = operation_number.to_le_bytes();
    let (expected, bump) =
        Pubkey::find_program_address(&[OPEN_SEED, &box_mint, &operation_bytes], program_id);
    if operation.key != &expected || !operation.is_writable {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(
        operation,
        payer,
        system,
        program_id,
        OPERATION_LEN,
        &[OPEN_SEED, &box_mint, &operation_bytes, &[bump]],
    )?;
    let mut data = operation.try_borrow_mut_data()?;
    data[0..8].copy_from_slice(OPERATION_MAGIC);
    data[8] = 1;
    data[9] = 1;
    data[10..18].copy_from_slice(&operation_number.to_le_bytes());
    data[18..50].copy_from_slice(&box_mint);
    data[50..82].copy_from_slice(design.key.as_ref());
    data[82..90].copy_from_slice(&version.to_le_bytes());
    data[90..92].copy_from_slice(&count.to_le_bytes());
    data[92..124].copy_from_slice(&commitment);
    Ok(())
}

fn finalize_fixture(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    if instruction.len() != 65 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let operation = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    let ring = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if !payer.is_signer
        || !payer.is_writable
        || operation.owner != program_id
        || operation.data_len() != OPERATION_LEN
        || !operation.is_writable
        || design.owner != program_id
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let randomness: [u8; 32] = instruction[1..33]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let ring_mint: [u8; 32] = instruction[33..65]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let (box_mint, design_key, version, count, commitment) = {
        let data = operation.try_borrow_data()?;
        if &data[0..8] != OPERATION_MAGIC || data[8] != 1 || data[9] != 1 {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        (
            <[u8; 32]>::try_from(&data[18..50]).map_err(|_| ProgramError::InvalidAccountData)?,
            Pubkey::new_from_array(
                data[50..82]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidAccountData)?,
            ),
            le_u64(&data[82..90])?,
            le_u16(&data[90..92])?,
            <[u8; 32]>::try_from(&data[92..124]).map_err(|_| ProgramError::InvalidAccountData)?,
        )
    };
    if design.key != &design_key {
        return Err(ProgramError::InvalidAccountData);
    }
    let (parsed_commitment, parsed_version, parsed_count, index, design_id, content_hash) = {
        let data = design.try_borrow_data()?;
        let authority = Pubkey::new_from_array(
            data[24..56]
                .try_into()
                .map_err(|_| ProgramError::InvalidAccountData)?,
        );
        let parsed = parse_design(program_id, design.key, &data, &authority, true)?;
        if data[56..88] != parsed.0
            || parsed.0 != commitment
            || parsed.1 != version
            || parsed.2 != count
        {
            return Err(ProgramError::InvalidAccountData);
        }
        let index = fixture_index(&randomness, count)?;
        let selected = selected_entry(&data, index)?;
        (parsed.0, parsed.1, parsed.2, index, selected.0, selected.1)
    };
    let (expected_ring, bump) = Pubkey::find_program_address(&[RING_SEED, &ring_mint], program_id);
    if ring.key != &expected_ring || !ring.is_writable {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(
        ring,
        payer,
        system,
        program_id,
        RING_LEN,
        &[RING_SEED, &ring_mint, &[bump]],
    )?;
    {
        let mut data = ring.try_borrow_mut_data()?;
        data[0..8].copy_from_slice(RING_MAGIC);
        data[8] = 1;
        data[9..41].copy_from_slice(&ring_mint);
        data[41..73].copy_from_slice(operation.key.as_ref());
        data[73..105].copy_from_slice(&box_mint);
        data[105..137].copy_from_slice(design.key.as_ref());
        data[137..145].copy_from_slice(&parsed_version.to_le_bytes());
        data[145..147].copy_from_slice(&parsed_count.to_le_bytes());
        data[147..149].copy_from_slice(&index.to_le_bytes());
        data[149..153].copy_from_slice(&design_id.to_le_bytes());
        data[153..185].copy_from_slice(&content_hash);
        data[185..217].copy_from_slice(&randomness);
    }
    let mut data = operation.try_borrow_mut_data()?;
    data[9] = 2;
    data[124..126].copy_from_slice(&index.to_le_bytes());
    data[126..130].copy_from_slice(&design_id.to_le_bytes());
    data[130..162].copy_from_slice(&content_hash);
    data[162..194].copy_from_slice(&randomness);
    data[194..226].copy_from_slice(&ring_mint);
    if parsed_commitment != commitment {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: &[u8],
) -> ProgramResult {
    match instruction.first() {
        Some(0) => initialize_config_v1(program_id, accounts, instruction),
        Some(1) if instruction.len() == 1 => migrate_config_v2(program_id, accounts),
        Some(2) => create_design_set(program_id, accounts, instruction),
        Some(3) => append_design(program_id, accounts, instruction),
        Some(4) if instruction.len() == 1 => freeze_design_set(program_id, accounts),
        Some(5) if instruction.len() == 1 => activate_design_set(program_id, accounts),
        Some(6) => begin_open_fixture(program_id, accounts, instruction),
        Some(7) => finalize_fixture(program_id, accounts, instruction),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_bounds_and_layouts_are_fixed() {
        assert_eq!(DESIGN_HEADER_LEN + MAX_DESIGNS * MAX_ENTRY_BYTES, 10_100);
        assert_eq!(CONFIG_V2_LEN, 145);
        assert_eq!(OPERATION_LEN, 226);
        assert_eq!(RING_LEN, 217);
    }

    #[test]
    fn fixture_selection_rejects_tail_and_selects_within_count() {
        let mut randomness = [255u8; 32];
        randomness[1] = 4;
        assert_eq!(fixture_index(&randomness, 3).unwrap(), 1);
        assert_eq!(fixture_index(&[1u8; 32], 2).unwrap(), 1);
        assert_eq!(
            fixture_index(&[0u8; 32], 0),
            Err(ProgramError::InvalidAccountData)
        );
    }
}
