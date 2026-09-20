use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::hashv,
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
        metadata_pointer::MetadataPointer,
        transfer_hook::{TransferHook, TransferHookAccount},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction::{self as token_instruction, AuthorityType},
    state::{Account as TokenAccount, Mint},
};
use spl_token_metadata_interface::{instruction as metadata_instruction, state::Field};
use spl_transfer_hook_interface::{
    get_extra_account_metas_address_and_bump_seed,
    instruction::{ExecuteInstruction, TransferHookInstruction},
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const STATE_LEN: usize = 188;
const TRANSFER_STATE_LEN: usize = STATE_LEN + 16;
const DIRECT_TRANSFER_COOLDOWN_SECONDS: i64 = 48 * 60 * 60;
const CONFIG_LEN: usize = 65;
const COLLECTION_LEN: usize = 66;
const MINT_SEED: &[u8] = b"silver-mint";
const STATE_SEED: &[u8] = b"silver-state";
const AUTHORITY_SEED: &[u8] = b"silver-authority";
const COLLECTION_SEED: &[u8] = b"silver-collection";
const CONFIG_SEED: &[u8] = b"silver-config";

fn state_extra_meta() -> Result<ExtraAccountMeta, ProgramError> {
    ExtraAccountMeta::new_with_seeds(
        &[Seed::Literal { bytes: STATE_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
        false, true,
    )
}

fn migrate_transfer_state(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data != [5] || accounts.len() != 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let collection = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let extra_metas = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, vault)?;
    check_collection(program_id, config, collection)?;
    if !vault.is_writable || !state.is_writable || mint.owner != &spl_token_2022::id()
        || state.owner != program_id || state.data_len() != STATE_LEN
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_state, _) = Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    if state.key != &expected_state {
        return Err(ProgramError::InvalidSeeds);
    }
    {
        let bytes = state.try_borrow_data()?;
        if bytes[0] != 2 || bytes[1] != 1 || bytes[2] != 1 || bytes[3] != 1
            || bytes[36..68] != mint.key.to_bytes() || bytes[68..100] != collection.key.to_bytes()
            || Pubkey::find_program_address(&[MINT_SEED, &bytes[4..36]], program_id).0 != *mint.key
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if mint_state.base.decimals != 0 || mint_state.base.supply != 1
        || mint_state.base.mint_authority != COption::None
        || mint_state.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(mint_state.get_extension::<TransferHook>()?.program_id) != Some(*program_id)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(mint_data);
    let (expected_metas, bump) = get_extra_account_metas_address_and_bump_seed(mint.key, program_id);
    if extra_metas.key != &expected_metas {
        return Err(ProgramError::InvalidSeeds);
    }
    let extra = [state_extra_meta()?];
    let extra_len = ExtraAccountMetaList::size_of(extra.len())?;
    let required_rent = Rent::get()?.minimum_balance(TRANSFER_STATE_LEN);
    if state.lamports() < required_rent {
        invoke(&system_instruction::transfer(vault.key, state.key, required_rent - state.lamports()),
            &[vault.clone(), state.clone(), system.clone()])?;
    }
    state.realloc(TRANSFER_STATE_LEN, false)?;
    {
        let mut bytes = state.try_borrow_mut_data()?;
        bytes[0] = 3;
        bytes[STATE_LEN..TRANSFER_STATE_LEN].fill(0);
    }
    create_pda(extra_metas, vault, system, program_id, extra_len,
        &[b"extra-account-metas", mint.key.as_ref(), &[bump]])?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut extra_metas.try_borrow_mut_data()?, &extra,
    )?;
    Ok(())
}

fn execute_transfer(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 16 || accounts.len() != 6 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let amount = match TransferHookInstruction::unpack(data)? {
        TransferHookInstruction::Execute { amount } => amount,
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    if amount != 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let source = &accounts[0];
    let mint = &accounts[1];
    let destination = &accounts[2];
    let authority = &accounts[3];
    let extra_metas = &accounts[4];
    let state = &accounts[5];
    if source.key == destination.key || source.owner != &spl_token_2022::id()
        || destination.owner != &spl_token_2022::id() || mint.owner != &spl_token_2022::id()
        || state.owner != program_id || !state.is_writable || extra_metas.owner != program_id
        || *extra_metas.key != get_extra_account_metas_address_and_bump_seed(mint.key, program_id).0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    ExtraAccountMetaList::check_account_infos::<ExecuteInstruction>(
        accounts, data, program_id, &extra_metas.try_borrow_data()?,
    )?;
    let source_data = source.try_borrow_data()?;
    let destination_data = destination.try_borrow_data()?;
    let source_token = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
    let destination_token = StateWithExtensions::<TokenAccount>::unpack(&destination_data)?;
    if source_token.base.mint != *mint.key || destination_token.base.mint != *mint.key
        || source_token.base.owner != *authority.key
        || !bool::from(source_token.get_extension::<TransferHookAccount>()?.transferring)
        || !bool::from(destination_token.get_extension::<TransferHookAccount>()?.transferring)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if mint_state.base.supply != 1 || mint_state.base.decimals != 0
        || Option::<Pubkey>::from(mint_state.get_extension::<TransferHook>()?.program_id) != Some(*program_id)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_state, _) = Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    if state.key != &expected_state || state.data_len() != TRANSFER_STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut bytes = state.try_borrow_mut_data()?;
    if bytes[0] != 3 || bytes[1] != 1 || bytes[2] != 1 || bytes[3] != 1
        || bytes[36..68] != mint.key.to_bytes()
        || Pubkey::find_program_address(&[MINT_SEED, &bytes[4..36]], program_id).0 != *mint.key
        || bytes[68..100] != Pubkey::find_program_address(&[COLLECTION_SEED], program_id).0.to_bytes()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let clock = Clock::get()?;
    let until = clock.unix_timestamp.checked_add(DIRECT_TRANSFER_COOLDOWN_SECONDS)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    bytes[STATE_LEN..STATE_LEN + 8].copy_from_slice(&clock.slot.to_le_bytes());
    bytes[STATE_LEN + 8..TRANSFER_STATE_LEN].copy_from_slice(&until.to_le_bytes());
    Ok(())
}

fn collection_matches(data: &[u8], vault: &Pubkey, config: &Pubkey) -> bool {
    data.len() == COLLECTION_LEN
        && data[0] == 1
        && data[1..33] == vault.to_bytes()
        && data[33..65] == config.to_bytes()
        && data[65] == 1
}

fn check_collection(
    program_id: &Pubkey,
    config: &AccountInfo,
    collection: &AccountInfo,
) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config || config.owner != program_id
        || collection.key != &expected || collection.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_data = config.try_borrow_data()?;
    let collection_data = collection.try_borrow_data()?;
    if config_data.len() != CONFIG_LEN
        || config_data[0] != 1
        || !collection_matches(&collection_data, &Pubkey::new_from_array(
            config_data[1..33].try_into().unwrap()), config.key)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

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

fn uuid(bytes: &[u8; 16]) -> String {
    let raw = hex(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &raw[..8], &raw[8..12], &raw[12..16], &raw[16..20], &raw[20..]
    )
}

fn configure(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let issuer = Pubkey::new_from_array(data[1..33].try_into().unwrap());
    if issuer == Pubkey::default() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, vault)?;
    let (expected, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected || !vault.is_writable || !config.is_writable {
        return Err(ProgramError::InvalidSeeds);
    }
    if data[0] == 2 {
        create_pda(
            config,
            vault,
            system,
            program_id,
            CONFIG_LEN,
            &[CONFIG_SEED, &[bump]],
        )?;
        let mut bytes = config.try_borrow_mut_data()?;
        bytes[0] = 1;
        bytes[1..33].copy_from_slice(vault.key.as_ref());
        bytes[33..65].copy_from_slice(issuer.as_ref());
    } else if data[0] == 3 {
        if config.owner != program_id || config.data_len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut bytes = config.try_borrow_mut_data()?;
        if bytes[0] != 1 || bytes[1..33] != vault.key.to_bytes() {
            return Err(ProgramError::InvalidAccountData);
        }
        bytes[33..65].copy_from_slice(issuer.as_ref());
    } else {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn initialize_collection(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data != [4] {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let collection = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, vault)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config || config.owner != program_id || !vault.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_data = config.try_borrow_data()?;
    if config_data.len() != CONFIG_LEN || config_data[0] != 1
        || config_data[1..33] != vault.key.to_bytes() {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(config_data);
    let (expected, bump) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    if collection.key != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    create_pda(
        collection, vault, system, program_id, COLLECTION_LEN,
        &[COLLECTION_SEED, &[bump]],
    )?;
    let mut bytes = collection.try_borrow_mut_data()?;
    bytes[0] = 1;
    bytes[1..33].copy_from_slice(vault.key.as_ref());
    bytes[33..65].copy_from_slice(config.key.as_ref());
    bytes[65] = 1;
    Ok(())
}

fn issue(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 115 || accounts.len() != 11 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let account_id: &[u8; 16] = data[1..17]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let issuance_id: &[u8; 32] = data[17..49]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let entitlement_digest: &[u8; 32] = data[49..81]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let content_hash: &[u8; 32] = data[81..113]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let uri_len = u16::from_le_bytes([data[113], data[114]]) as usize;
    if uri_len == 0 || uri_len > 160 || data.len() != 115 + uri_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let uri = std::str::from_utf8(&data[115..])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if !uri.starts_with("https://") {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let issuer = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let token_account = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let collection_account = next_account_info(iter)?;
    let extra_metas = next_account_info(iter)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config || config.owner != program_id ||
        config.data_len() != CONFIG_LEN || !issuer.is_signer || !issuer.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_bytes = config.try_borrow_data()?;
    if config_bytes[0] != 1 || config_bytes[33..65] != issuer.key.to_bytes() {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(config_bytes);
    check_collection(program_id, config, collection_account)?;
    let account_string = uuid(account_id);
    let expected_issuance = hashv(&[
        b"EtheRings:first-entry:issuance:v1\ndevnet\n",
        account_string.as_bytes(), b"\n",
    ]);
    if expected_issuance.as_ref() != issuance_id {
        return Err(ProgramError::InvalidInstructionData);
    }
    let issuance_hex = hex(issuance_id);
    let recipient_string = recipient.key.to_string();
    let expected_digest = hashv(&[
        b"EtheRings:first-entry:entitlement:v1\ndevnet\n",
        account_string.as_bytes(), b"\n",
        recipient_string.as_bytes(), b"\n",
        issuance_hex.as_bytes(), b"\n",
    ]);
    if expected_digest.as_ref() != entitlement_digest {
        return Err(ProgramError::InvalidInstructionData);
    }
    if token_program.key != &spl_token_2022::id()
        || !token_account.is_signer
        || !token_account.is_writable
        || token_account.owner != &system_program::id()
        || token_account.data_len() != 0
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
    let (expected_metas, metas_bump) =
        get_extra_account_metas_address_and_bump_seed(mint.key, program_id);
    if extra_metas.key != &expected_metas {
        return Err(ProgramError::InvalidSeeds);
    }

    let name = "EtheRings Silver Box";
    let symbol = "ESBX";
    let (collection, _) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer,
        ExtensionType::TransferHook,
    ])?;
    let mint_bump_seed = [mint_bump];
    let mint_seeds: &[&[u8]] = &[MINT_SEED, issuance_id, &mint_bump_seed];
    let authority_bump_seed = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &authority_bump_seed];
    create_pda(mint, issuer, system, token_program.key, mint_space, mint_seeds)?;
    let funded_size = mint_space
        .checked_add(768)
        .ok_or(ProgramError::InvalidAccountData)?;
    let final_rent = Rent::get()?.minimum_balance(funded_size);
    if mint.lamports() < final_rent {
        invoke(
            &system_instruction::transfer(issuer.key, mint.key, final_rent - mint.lamports()),
            &[issuer.clone(), mint.clone(), system.clone()],
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
        ("kind", "SILVER_BOX".to_string()),
        ("issuance_source", "first-entry".to_string()),
        ("entitlement_digest", hex(entitlement_digest)),
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
            issuer.key,
            token_account.key,
            Rent::get()?.minimum_balance(token_space),
            token_space as u64,
            token_program.key,
        ),
        &[issuer.clone(), token_account.clone(), system.clone()],
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
        issuer,
        system,
        program_id,
        TRANSFER_STATE_LEN,
        &[STATE_SEED, mint.key.as_ref(), &state_bump_seed],
    )?;
    let mut bytes = state.try_borrow_mut_data()?;
    bytes[0] = 3;
    bytes[1] = 1;
    bytes[2] = 1;
    bytes[3] = 1;
    bytes[4..36].copy_from_slice(issuance_id);
    bytes[36..68].copy_from_slice(mint.key.as_ref());
    bytes[68..100].copy_from_slice(collection.as_ref());
    bytes[100..132].copy_from_slice(recipient.key.as_ref());
    bytes[132..164].copy_from_slice(entitlement_digest);
    bytes[164..180].copy_from_slice(account_id);
    bytes[180..188].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    bytes[STATE_LEN..TRANSFER_STATE_LEN].fill(0);
    drop(bytes);
    let extra = [state_extra_meta()?];
    create_pda(extra_metas, issuer, system, program_id,
        ExtraAccountMetaList::size_of(extra.len())?,
        &[b"extra-account-metas", mint.key.as_ref(), &[metas_bump]])?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut extra_metas.try_borrow_mut_data()?, &extra,
    )?;
    Ok(())
}

fn validate(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 33 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let issuance_id = &data[1..33];
    let iter = &mut accounts.iter();
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let token_account = next_account_info(iter)?;
    let owner = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let collection_account = next_account_info(iter)?;
    check_collection(program_id, config, collection_account)?;
    let (expected_mint, _) = Pubkey::find_program_address(&[MINT_SEED, issuance_id], program_id);
    let (expected_state, _) =
        Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    if mint.key != &expected_mint
        || state.key != &expected_state
        || state.owner != program_id
        || !matches!(state.data_len(), STATE_LEN | TRANSFER_STATE_LEN)
        || mint.owner != &spl_token_2022::id()
        || token_account.owner != &spl_token_2022::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state_data = state.try_borrow_data()?;
    let (collection, _) = Pubkey::find_program_address(&[COLLECTION_SEED], program_id);
    if !matches!((state_data[0], state_data.len()), (2, STATE_LEN) | (3, TRANSFER_STATE_LEN))
        || state_data[1] != 1
        || state_data[2] != 1
        || state_data[3] != 1
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
    if data.len() == 16
        && matches!(TransferHookInstruction::unpack(data), Ok(TransferHookInstruction::Execute { .. }))
    {
        return execute_transfer(program_id, accounts, data);
    }
    match data.first() {
        Some(0) => issue(program_id, accounts, data),
        Some(1) => validate(program_id, accounts, data),
        Some(2) | Some(3) => configure(program_id, accounts, data),
        Some(4) => initialize_collection(program_id, accounts, data),
        Some(5) => migrate_transfer_state(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collection_identity_is_exact() {
        let vault = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let mut data = [0u8; COLLECTION_LEN];
        data[0] = 1;
        data[1..33].copy_from_slice(vault.as_ref());
        data[33..65].copy_from_slice(config.as_ref());
        data[65] = 1;
        assert!(collection_matches(&data, &vault, &config));
        assert!(!collection_matches(&data, &Pubkey::new_unique(), &config));
        assert!(!collection_matches(&data, &vault, &Pubkey::new_unique()));
        data[65] = 0;
        assert!(!collection_matches(&data, &vault, &config));
        data[65] = 1;
        data[0] = 2;
        assert!(!collection_matches(&data, &vault, &config));
        assert!(!collection_matches(&data[..65], &vault, &config));
    }

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

    #[test]
    fn first_entry_digest_matches_backend_alpha_fixture() {
        let account = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
        let account_string = uuid(&account);
        let issuance = hashv(&[
            b"EtheRings:first-entry:issuance:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
        ]);
        assert_eq!(hex(issuance.as_ref()),
            "6e483c1a68694692e4c0315c8786988c23fa67943a7bc5d39a6182380bc29d69");
        let digest = hashv(&[
            b"EtheRings:first-entry:entitlement:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
            b"11111111111111111111111111111111\n",
            hex(issuance.as_ref()).as_bytes(), b"\n",
        ]);
        assert_eq!(hex(digest.as_ref()),
            "9f77fefd1873315c9300814ebe851deff03f6c99b532a9bcf17bb523c404b8e8");
    }
}
