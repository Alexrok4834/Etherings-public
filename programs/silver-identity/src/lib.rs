use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token_2022::{
    extension::{
        metadata_pointer::MetadataPointer, transfer_hook::TransferHook,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::{self as token_instruction, AuthorityType},
    state::{Account as TokenAccount, Mint},
};
use spl_token_metadata_interface::{instruction as metadata_instruction, state::Field};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const STATE_LEN: usize = 172;
const MINT_SEED: &[u8] = b"silver-mint";
const STATE_SEED: &[u8] = b"silver-state";
const AUTHORITY_SEED: &[u8] = b"silver-authority";
const COLLECTION_SEED: &[u8] = b"silver-collection";

fn check_upgrade_authority(
    program_id: &Pubkey,
    programdata: &AccountInfo,
    signer: &AccountInfo,
) -> ProgramResult {
    let (expected, _) =
        Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id());
    if !signer.is_signer
        || programdata.key != &expected
        || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len() < UpgradeableLoaderState::size_of_programdata_metadata()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = programdata.try_borrow_data()?;
    let state: UpgradeableLoaderState = bincode::deserialize(
        &data[..UpgradeableLoaderState::size_of_programdata_metadata()],
    )
    .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(authority),
            ..
        } if authority == *signer.key => Ok(()),
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
    if account.owner != &system_program::id()
        || account.data_len() != 0
        || !account.is_writable
        || !payer.is_signer
        || !payer.is_writable
        || system.key != &system_program::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let rent = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(
                payer.key,
                account.key,
                rent,
                space as u64,
                owner,
            ),
            &[payer.clone(), account.clone(), system.clone()],
            &[seeds],
        );
    }
    if account.lamports() < rent {
        invoke(
            &system_instruction::transfer(payer.key, account.key, rent - account.lamports()),
            &[payer.clone(), account.clone(), system.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, space as u64),
        &[account.clone(), system.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, owner),
        &[account.clone(), system.clone()],
        &[seeds],
    )
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 0xf) as usize] as char);
    }
    result
}

fn issue(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 68 || !matches!(data[1], 1 | 2) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let kind = data[1];
    let issuance_id: &[u8; 32] = data[2..34]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let content_hash: &[u8; 32] = data[34..66]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let uri_len = u16::from_le_bytes([data[66], data[67]]) as usize;
    if uri_len == 0 || uri_len > 160 || data.len() != 68 + uri_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let uri = std::str::from_utf8(&data[68..])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if !uri.starts_with("https://") {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let admin = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let token_account = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, admin)?;
    if token_program.key != &spl_token_2022::id()
        || !token_account.is_signer
        || !token_account.is_writable
        || token_account.owner != &system_program::id()
        || token_account.data_len() != 0
        || !admin.is_writable
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_mint, mint_bump) =
        Pubkey::find_program_address(&[MINT_SEED, issuance_id], program_id);
    let (expected_state, state_bump) =
        Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    let (expected_authority, authority_bump) =
        Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    if mint.key != &expected_mint
        || state.key != &expected_state
        || authority.key != &expected_authority
    {
        return Err(ProgramError::InvalidSeeds);
    }

    let name = if kind == 1 {
        "EtheRings Silver Box"
    } else {
        "EtheRings Silver Ring"
    };
    let symbol = if kind == 1 { "ESBX" } else { "ESRG" };
    let (collection, _) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
        ExtensionType::TransferHook,
    ])?;
    let mint_bump_seed = [mint_bump];
    let mint_seeds: &[&[u8]] = &[MINT_SEED, issuance_id, &mint_bump_seed];
    let authority_bump_seed = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &authority_bump_seed];
    create_pda(mint, admin, system, token_program.key, mint_space, mint_seeds)?;
    let funded_size = mint_space
        .checked_add(768)
        .ok_or(ProgramError::InvalidAccountData)?;
    let final_rent = Rent::get()?.minimum_balance(funded_size);
    if mint.lamports() < final_rent {
        invoke(
            &system_instruction::transfer(admin.key, mint.key, final_rent - mint.lamports()),
            &[admin.clone(), mint.clone(), system.clone()],
        )?;
    }
    invoke(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            token_program.key,
            mint.key,
            None,
            Some(*mint.key),
        )?,
        &[mint.clone(), token_program.clone()],
    )?;
    invoke(
        &spl_token_2022::extension::transfer_hook::instruction::initialize(
            token_program.key,
            mint.key,
            None,
            Some(*program_id),
        )?,
        &[mint.clone(), token_program.clone()],
    )?;
    invoke(
        &token_instruction::initialize_mint2(
            token_program.key,
            mint.key,
            authority.key,
            None,
            0,
        )?,
        &[mint.clone(), token_program.clone()],
    )?;
    invoke_signed(
        &metadata_instruction::initialize(
            token_program.key,
            mint.key,
            authority.key,
            mint.key,
            authority.key,
            name.to_string(),
            symbol.to_string(),
            uri.to_string(),
        ),
        &[mint.clone(), authority.clone(), token_program.clone()],
        &[authority_seeds],
    )?;
    for (key, value) in [
        ("content_hash", hex(content_hash)),
        ("collection", collection.to_string()),
        ("issuance_id", hex(issuance_id)),
        ("kind", if kind == 1 { "SILVER_BOX" } else { "SILVER_RING" }.to_string()),
    ] {
        invoke_signed(
            &metadata_instruction::update_field(
                token_program.key,
                mint.key,
                authority.key,
                Field::Key(key.to_string()),
                value,
            ),
            &[mint.clone(), authority.clone(), token_program.clone()],
            &[authority_seeds],
        )?;
    }

    let token_space = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
        ExtensionType::TransferHookAccount,
    ])?;
    invoke(
        &system_instruction::create_account(
            admin.key,
            token_account.key,
            Rent::get()?.minimum_balance(token_space),
            token_space as u64,
            token_program.key,
        ),
        &[admin.clone(), token_account.clone(), system.clone()],
    )?;
    invoke(
        &token_instruction::initialize_account3(
            token_program.key,
            token_account.key,
            mint.key,
            recipient.key,
        )?,
        &[token_account.clone(), mint.clone(), token_program.clone()],
    )?;
    invoke_signed(
        &token_instruction::mint_to_checked(
            token_program.key,
            mint.key,
            token_account.key,
            authority.key,
            &[],
            1,
            0,
        )?,
        &[mint.clone(), token_account.clone(), authority.clone(), token_program.clone()],
        &[authority_seeds],
    )?;
    invoke_signed(
        &token_instruction::set_authority(
            token_program.key,
            mint.key,
            None,
            AuthorityType::MintTokens,
            authority.key,
            &[],
        )?,
        &[mint.clone(), authority.clone(), token_program.clone()],
        &[authority_seeds],
    )?;

    let state_bump_seed = [state_bump];
    create_pda(
        state,
        admin,
        system,
        program_id,
        STATE_LEN,
        &[STATE_SEED, mint.key.as_ref(), &state_bump_seed],
    )?;
    let mut bytes = state.try_borrow_mut_data()?;
    bytes[0] = 1;
    bytes[1] = kind;
    bytes[2] = if kind == 1 { 1 } else { 2 };
    bytes[3] = state_bump;
    bytes[4..36].copy_from_slice(issuance_id);
    bytes[36..68].copy_from_slice(mint.key.as_ref());
    bytes[68..100].copy_from_slice(collection.as_ref());
    bytes[100..132].copy_from_slice(recipient.key.as_ref());
    bytes[132..164].copy_from_slice(content_hash);
    bytes[164..172].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    Ok(())
}

fn validate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 34 || !matches!(data[1], 1 | 2) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let issuance_id = &data[2..34];
    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let token_account = next_account_info(iter)?;
    let owner = next_account_info(iter)?;
    let (expected_mint, _) = Pubkey::find_program_address(&[MINT_SEED, issuance_id], program_id);
    let (expected_state, _) =
        Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    if mint.key != &expected_mint
        || state.key != &expected_state
        || state.owner != program_id
        || state.data_len() != STATE_LEN
        || mint.owner != &spl_token_2022::id()
        || token_account.owner != &spl_token_2022::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state_data = state.try_borrow_data()?;
    let (collection, _) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    if state_data[0] != 1
        || state_data[1] != data[1]
        || state_data[4..36] != *issuance_id
        || state_data[36..68] != mint.key.to_bytes()
        || state_data[68..100] != collection.to_bytes()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if mint_state.base.decimals != 0
        || mint_state.base.supply != 1
        || mint_state.base.mint_authority != COption::None
        || mint_state.base.freeze_authority != COption::None
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let pointer = mint_state.get_extension::<MetadataPointer>()?;
    let hook = mint_state.get_extension::<TransferHook>()?;
    if Option::<Pubkey>::from(pointer.metadata_address) != Some(*mint.key)
        || Option::<Pubkey>::from(pointer.authority).is_some()
        || Option::<Pubkey>::from(hook.program_id) != Some(*program_id)
        || Option::<Pubkey>::from(hook.authority).is_some()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccount>::unpack(&token_data)?;
    if token_state.base.mint != *mint.key
        || token_state.base.owner != *owner.key
        || token_state.base.amount != 1
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match data.first() {
        Some(0) => issue(program_id, accounts, data),
        Some(1) => validate(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issuance_id_selects_one_mint_for_both_kinds() {
        let program = Pubkey::new_unique();
        let id = [7u8; 32];
        let (first, _) = Pubkey::find_program_address(&[MINT_SEED, &id], &program);
        let (again, _) = Pubkey::find_program_address(&[MINT_SEED, &id], &program);
        let (other, _) = Pubkey::find_program_address(&[MINT_SEED, &[8u8; 32]], &program);
        assert_eq!(first, again);
        assert_ne!(first, other);
    }

    #[test]
    fn state_address_is_bound_to_mint() {
        let program = Pubkey::new_unique();
        let (a, _) = Pubkey::find_program_address(&[STATE_SEED, &[1u8; 32]], &program);
        let (b, _) = Pubkey::find_program_address(&[STATE_SEED, &[2u8; 32]], &program);
        assert_ne!(a, b);
    }
}
