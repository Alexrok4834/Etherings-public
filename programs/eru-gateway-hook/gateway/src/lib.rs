use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions, Sysvar},
};
use spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as TokenMint,
};

entrypoint!(process_instruction);

const CONFIG_LEN: usize = 330;
const MINT: std::ops::Range<usize> = 33..65;
const TREASURY: std::ops::Range<usize> = 65..97;
const HOOK: std::ops::Range<usize> = 97..129;
const RESERVE: std::ops::Range<usize> = 129..161;
const STAGE: usize = 169;
const SOURCE: std::ops::Range<usize> = 170..202;
const RECIPIENT: std::ops::Range<usize> = 202..234;
const USER: std::ops::Range<usize> = 234..266;
const PRINCIPAL: std::ops::Range<usize> = 266..274;
const FEE: std::ops::Range<usize> = 274..282;
const ACTIVE_NONCE: std::ops::Range<usize> = 282..290;
const GAME_ATTESTOR: std::ops::Range<usize> = 290..322;
const CONFIG_EPOCH: std::ops::Range<usize> = 322..330;
const CONFIG_SEED: &[u8] = b"eru-config";
const NONCE_SEED: &[u8] = b"nonce";
const COOPER_OP_SEED: &[u8] = b"cooper-level-up";
const COOPER_ARGS_LEN: usize = 107;
const SILVER_OP_SEED: &[u8] = b"silver-level-up";
const SILVER_ARGS_LEN: usize = 123;
const SILVER_PROGRAM: Pubkey = solana_program::pubkey!("3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX");
const SILVER_PAID_SEED: &[u8] = b"silver-paid-gateway";
const BREED_OP_SEED: &[u8] = b"cooper-breeding";
const BREED_ISSUER_SEED: &[u8] = b"cooper-breeding-issuer";
const BOX_URI: &str = "ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png";
const BOX_HASH: [u8; 32] = [0xe8, 0x65, 0x89, 0xee, 0x25, 0xbc, 0xaa, 0x5c,
    0x2a, 0x5d, 0xc8, 0xa7, 0x08, 0xad, 0xec, 0xce, 0x79, 0x55, 0x95, 0x5a,
    0x25, 0x29, 0x31, 0x07, 0x96, 0xd5, 0xa0, 0xfe, 0x3d, 0xb6, 0x7d, 0x37];

fn uuid_text(bytes: &[u8]) -> Result<String, ProgramError> {
    if bytes.len() != 16 { return Err(ProgramError::InvalidInstructionData); }
    let mut result = String::with_capacity(36);
    for (index, byte) in bytes.iter().enumerate() {
        if matches!(index, 4 | 6 | 8 | 10) { result.push('-'); }
        use std::fmt::Write;
        write!(&mut result, "{byte:02x}").map_err(|_| ProgramError::InvalidInstructionData)?;
    }
    Ok(result)
}

fn hex_text(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        let _ = write!(&mut result, "{byte:02x}");
    }
    result
}

fn breeding_cost(first_uses: u8, second_uses: u8) -> Option<(u64, u64)> {
    match (first_uses, second_uses) {
        (0, 0) => Some((150, 30_000_000_000)),
        (0, 1) | (1, 0) => Some((200, 40_000_000_000)),
        (1, 1) => Some((250, 50_000_000_000)),
        _ => None,
    }
}

fn create_pda<'a>(
    account: &AccountInfo<'a>, payer: &AccountInfo<'a>, system: &AccountInfo<'a>,
    owner: &Pubkey, space: usize, seeds: &[&[u8]],
) -> ProgramResult {
    if account.owner != &system_program::id() || account.data_len() != 0
        || !account.is_writable || !payer.is_signer || !payer.is_writable
        || system.key != &system_program::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let rent = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, account.key, rent, space as u64, owner),
            &[payer.clone(), account.clone(), system.clone()], &[seeds],
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
        &[account.clone(), system.clone()], &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, owner),
        &[account.clone(), system.clone()], &[seeds],
    )
}

fn check_upgrade_authority(program_id: &Pubkey, programdata: &AccountInfo, signer: &AccountInfo) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(
        &[program_id.as_ref()], &bpf_loader_upgradeable::id(),
    );
    if !signer.is_signer || programdata.key != &expected
        || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len() < UpgradeableLoaderState::size_of_programdata_metadata()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = programdata.try_borrow_data()?;
    let state: UpgradeableLoaderState = bincode::deserialize(
        &data[..UpgradeableLoaderState::size_of_programdata_metadata()],
    ).map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData { upgrade_authority_address: Some(authority), .. }
            if authority == *signer.key => Ok(()),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

fn put_key(data: &mut [u8], range: std::ops::Range<usize>, key: &Pubkey) {
    data[range].copy_from_slice(key.as_ref());
}

fn put_u64(data: &mut [u8], range: std::ops::Range<usize>, value: u64) {
    data[range].copy_from_slice(&value.to_le_bytes());
}

fn read_u64(data: &[u8], range: std::ops::Range<usize>) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(data[range].try_into().map_err(|_| ProgramError::InvalidAccountData)?))
}

fn configure(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let issuer = next_account_info(iter)?;
    let game_attestor = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let treasury = next_account_info(iter)?;
    let hook = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let (expected_config, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config || !config.is_writable || config.owner != &system_program::id()
        || config.data_len() != 0 || !issuer.is_writable || !issuer.is_signer
        || system.key != &system_program::id() || mint.owner != &spl_token_2022::id()
        || !hook.executable || game_attestor.key == issuer.key
        || game_attestor.key == &Pubkey::default()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    check_upgrade_authority(program_id, programdata, issuer)?;
    {
        let mint_data = mint.try_borrow_data()?;
        let state = StateWithExtensions::<TokenMint>::unpack(&mint_data)?;
        let transfer_hook = state.get_extension::<TransferHook>()?;
        if state.base.decimals != 9 || state.base.mint_authority != COption::Some(*issuer.key)
            || Option::<Pubkey>::from(transfer_hook.authority) != Some(*issuer.key)
            || Option::<Pubkey>::from(transfer_hook.program_id) != Some(*hook.key)
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    create_pda(config, issuer, system, program_id, CONFIG_LEN, &[CONFIG_SEED, &[bump]])?;
    let mut data = config.try_borrow_mut_data()?;
    if data.len() != CONFIG_LEN || data[0] != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    data[0] = 1;
    put_key(&mut data, 1..33, issuer.key);
    put_key(&mut data, MINT, mint.key);
    put_key(&mut data, TREASURY, treasury.key);
    put_key(&mut data, HOOK, hook.key);
    put_key(&mut data, RESERVE, reserve.key);
    put_key(&mut data, GAME_ATTESTOR, game_attestor.key);
    put_u64(&mut data, CONFIG_EPOCH, 1);
    Ok(())
}

fn transfer<'a>(
    source: &AccountInfo<'a>, mint: &AccountInfo<'a>, destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>, meta_list: &AccountInfo<'a>, sysvar: &AccountInfo<'a>,
    config: &AccountInfo<'a>, hook: &AccountInfo<'a>, token_program: &AccountInfo<'a>, amount: u64,
) -> ProgramResult {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key, source.key, mint.key, destination.key, authority.key,
        &[], amount, 9,
    )?;
    ix.accounts.push(AccountMeta::new_readonly(*meta_list.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*sysvar.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*config.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*hook.key, false));
    invoke(&ix, &[
        source.clone(), mint.clone(), destination.clone(), authority.clone(),
        meta_list.clone(), sysvar.clone(), config.clone(), hook.clone(), token_program.clone(),
    ])
}

fn burn<'a>(
    source: &AccountInfo<'a>, mint: &AccountInfo<'a>, authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>, amount: u64,
) -> ProgramResult {
    let ix = spl_token_2022::instruction::burn_checked(
        token_program.key, source.key, mint.key, authority.key, &[], amount, 9,
    )?;
    invoke(&ix, &[
        source.clone(), mint.clone(), authority.clone(), token_program.clone(),
    ])
}

fn game_transition(args: &[u8], silver: bool) -> Result<(u64, u64, u64, &[u8], u64, u64), ProgramError> {
    if args.len() != if silver { SILVER_ARGS_LEN } else { COOPER_ARGS_LEN } {
        return Err(ProgramError::InvalidInstructionData);
    }
    let principal = read_u64(args, 0..8)?;
    let nonce = read_u64(args, 8..16)?;
    let expiry_slot = read_u64(args, 16..24)?;
    let operation_id = &args[24..40];
    let reservation_id = &args[40..56];
    let ring_len = if silver { 32 } else { 16 };
    let ring_id = &args[56..56 + ring_len];
    let account_id = &args[56 + ring_len..72 + ring_len];
    let current_level = args[72 + ring_len];
    let target_level = args[73 + ring_len];
    let ert_cost = read_u64(args, 74 + ring_len..82 + ring_len)?;
    let auth_version = args[82 + ring_len];
    let config_epoch = read_u64(args, 83 + ring_len..91 + ring_len)?;
    let (expected_principal, expected_ert) = match (silver, current_level, target_level) {
        (false, 4, 5) => (30_000_000_000, 24),
        (false, 19, 20) => (60_000_000_000, 84),
        (true, 4, 5) => (38_000_000_000, 30),
        (true, 19, 20) => (75_000_000_000, 105),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    if principal != expected_principal || ert_cost != expected_ert || nonce == 0
        || nonce == u64::MAX || operation_id.iter().all(|byte| *byte == 0)
        || reservation_id.iter().all(|byte| *byte == 0)
        || ring_id.iter().all(|byte| *byte == 0)
        || account_id.iter().all(|byte| *byte == 0)
        || auth_version != 1 || config_epoch == 0
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok((principal, nonce, expiry_slot, operation_id, ert_cost, config_epoch))
}

fn execute_game(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8], silver: bool) -> ProgramResult {
    let (principal, nonce, expiry_slot, operation_id, _, config_epoch) = game_transition(args, silver)?;
    if Clock::get()?.slot > expiry_slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee = u64::try_from(
        (u128::from(principal).checked_mul(200).ok_or(ProgramError::ArithmeticOverflow)?
            .checked_add(9999).ok_or(ProgramError::ArithmeticOverflow)?) / 10000,
    ).map_err(|_| ProgramError::ArithmeticOverflow)?;
    let iter = &mut accounts.iter();
    let source = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let treasury = next_account_info(iter)?;
    let user = next_account_info(iter)?;
    let game_attestor = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let meta_list = next_account_info(iter)?;
    let sysvar = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let hook = next_account_info(iter)?;
    let replay = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let operation_replay = next_account_info(iter)?;
    let silver_authority = if silver { Some(next_account_info(iter)?) } else { None };
    let silver_config = if silver { Some(next_account_info(iter)?) } else { None };
    if iter.next().is_some() {
        return Err(ProgramError::InvalidInstructionData);
    }
    if let Some(authority) = silver_authority {
        let (expected, _) = Pubkey::find_program_address(&[SILVER_PAID_SEED], &SILVER_PROGRAM);
        if authority.key != &expected || !authority.is_signer {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if let Some(silver_config) = silver_config {
        let (expected, _) = Pubkey::find_program_address(&[b"silver-config"], &SILVER_PROGRAM);
        if silver_config.key != &expected || silver_config.owner != &SILVER_PROGRAM
            || silver_config.data_len() != 145
        {
            return Err(ProgramError::InvalidAccountData);
        }
        let data = silver_config.try_borrow_data()?;
        if data[0] != 2 || data[33..65] != game_attestor.key.to_bytes() {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    let (expected_replay, replay_bump) = Pubkey::find_program_address(
        &[NONCE_SEED, config.key.as_ref(), user.key.as_ref()], program_id,
    );
    let (expected_operation_replay, operation_bump) = Pubkey::find_program_address(
        &[if silver { SILVER_OP_SEED } else { COOPER_OP_SEED },
          config.key.as_ref(), user.key.as_ref(), operation_id], program_id,
    );
    if !user.is_signer || !game_attestor.is_signer || game_attestor.key == user.key
        || !source.is_writable || !treasury.is_writable
        || !config.is_writable || config.owner != program_id
        || config.key != &expected_config || replay.key != &expected_replay || !replay.is_writable
        || operation_replay.key != &expected_operation_replay || !operation_replay.is_writable
        || recipient.key != treasury.key || !payer.is_signer || !payer.is_writable
        || system.key != &system_program::id()
        || token_program.key != &spl_token_2022::id()
        || sysvar.key != &instructions::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let hook_id = {
        let data = config.try_borrow_data()?;
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Pubkey::new_from_array(data[HOOK].try_into().map_err(|_| ProgramError::InvalidAccountData)?)
    };
    if hook.key != &hook_id || !hook.executable {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_meta, _) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()], &hook_id,
    );
    if meta_list.key != &expected_meta {
        return Err(ProgramError::InvalidSeeds);
    }
    {
        let data = config.try_borrow_data()?;
        if data[0] != 1 || data[STAGE] != 0 || data[MINT] != mint.key.to_bytes()
            || data[TREASURY] != treasury.key.to_bytes()
            || (!silver && data[GAME_ATTESTOR] != game_attestor.key.to_bytes())
            || read_u64(&data, CONFIG_EPOCH)? != config_epoch
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if replay.owner == &system_program::id() && replay.data_len() == 0 {
        create_pda(replay, payer, system, program_id, 8,
            &[NONCE_SEED, config.key.as_ref(), user.key.as_ref(), &[replay_bump]])?;
    }
    if replay.owner != program_id || replay.data_len() != 8
        || nonce <= read_u64(&replay.try_borrow_data()?, 0..8)?
        || operation_replay.owner != &system_program::id() || operation_replay.data_len() != 0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    create_pda(operation_replay, payer, system, program_id, 32,
        &[if silver { SILVER_OP_SEED } else { COOPER_OP_SEED },
          config.key.as_ref(), user.key.as_ref(), operation_id,
            &[operation_bump]])?;
    {
        let mut data = config.try_borrow_mut_data()?;
        data[STAGE] = 2;
        put_key(&mut data, SOURCE, source.key);
        put_key(&mut data, RECIPIENT, treasury.key);
        put_key(&mut data, USER, user.key);
        put_u64(&mut data, PRINCIPAL, principal);
        put_u64(&mut data, FEE, fee);
        put_u64(&mut data, ACTIVE_NONCE, nonce);
    }
    burn(source, mint, user, token_program, principal)?;
    transfer(source, mint, treasury, user, meta_list, sysvar, config, hook, token_program, fee)?;
    {
        let mut data = config.try_borrow_mut_data()?;
        data[STAGE] = 0;
        put_u64(&mut replay.try_borrow_mut_data()?, 0..8, nonce);
        operation_replay.try_borrow_mut_data()?.copy_from_slice(
            solana_program::hash::hash(args).as_ref(),
        );
    }
    Ok(())
}

// A breeding payment has no standalone success path. Its one transaction
// burns principal, transfers the additive fee, consumes replay and invokes
// the pinned Silver program to mint exactly one deterministic Box. Any CPI
// failure rolls back all Token-2022 and Gateway writes.
fn execute_breeding(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if args.len() != 123 || accounts.len() != 26 || args[122] != 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let principal = read_u64(args, 0..8)?;
    let nonce = read_u64(args, 8..16)?;
    let expiry_slot = read_u64(args, 16..24)?;
    let operation_id = &args[24..40];
    let reservation_id = &args[40..56];
    let account_id = &args[56..72];
    let first = &args[72..88];
    let second = &args[88..104];
    let (expected_ert, expected_eru) = breeding_cost(args[104], args[105])
        .ok_or(ProgramError::InvalidInstructionData)?;
    let config_epoch = read_u64(args, 114..122)?;
    if principal != expected_eru || read_u64(args, 106..114)? != expected_ert
        || nonce == 0 || nonce == u64::MAX || config_epoch == 0
        || Clock::get()?.slot > expiry_slot
        || [operation_id, reservation_id, account_id, first, second]
            .iter().any(|bytes| bytes.iter().all(|byte| *byte == 0))
        || first == second
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee = u64::try_from((u128::from(principal) * 200 + 9999) / 10000)
        .map_err(|_| ProgramError::ArithmeticOverflow)?;
    let source = &accounts[0];
    let mint = &accounts[1];
    let recipient = &accounts[2];
    let treasury = &accounts[3];
    let user = &accounts[4];
    let attestor = &accounts[5];
    let config = &accounts[6];
    let meta_list = &accounts[7];
    let sysvar = &accounts[8];
    let token_program = &accounts[9];
    let hook = &accounts[10];
    let replay = &accounts[11];
    let payer = &accounts[12];
    let system = &accounts[13];
    let operation_replay = &accounts[14];
    let breed_issuer = &accounts[15];
    let silver_program = &accounts[16];
    let silver_config = &accounts[17];
    let box_mint = &accounts[18];
    let box_state = &accounts[19];
    let box_token = &accounts[20];
    let box_authority = &accounts[21];
    let collection = &accounts[22];
    let box_extra = &accounts[23];
    let lifecycle = &accounts[24];
    let series = &accounts[25];
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    let (expected_replay, replay_bump) = Pubkey::find_program_address(
        &[NONCE_SEED, config.key.as_ref(), user.key.as_ref()], program_id);
    let (expected_operation, operation_bump) = Pubkey::find_program_address(
        &[BREED_OP_SEED, config.key.as_ref(), user.key.as_ref(), operation_id], program_id);
    let (expected_issuer, issuer_bump) = Pubkey::find_program_address(
        &[BREED_ISSUER_SEED], program_id);
    let (expected_silver_config, _) = Pubkey::find_program_address(
        &[b"silver-config"], &SILVER_PROGRAM);
    if !user.is_signer || !attestor.is_signer || user.key == attestor.key
        || !source.is_writable || !treasury.is_writable || !config.is_writable
        || config.owner != program_id || config.key != &expected_config
        || replay.key != &expected_replay || !replay.is_writable
        || operation_replay.key != &expected_operation || !operation_replay.is_writable
        || recipient.key != treasury.key || !payer.is_signer || !payer.is_writable
        || payer.key != user.key || system.key != &system_program::id()
        || token_program.key != &spl_token_2022::id()
        || sysvar.key != &instructions::id() || breed_issuer.key != &expected_issuer
        || silver_program.key != &SILVER_PROGRAM || !silver_program.executable
        || silver_config.key != &expected_silver_config
        || silver_config.owner != &SILVER_PROGRAM
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_data = config.try_borrow_data()?;
    if config_data.len() != CONFIG_LEN || config_data[0] != 1
        || config_data[STAGE] != 0 || config_data[MINT] != mint.key.to_bytes()
        || config_data[TREASURY] != treasury.key.to_bytes()
        || config_data[GAME_ATTESTOR] != attestor.key.to_bytes()
        || read_u64(&config_data, CONFIG_EPOCH)? != config_epoch
        || config_data[HOOK] != hook.key.to_bytes() || !hook.executable
    {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(config_data);
    let (expected_meta, _) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()], hook.key);
    if meta_list.key != &expected_meta {
        return Err(ProgramError::InvalidSeeds);
    }
    if replay.owner == &system_program::id() && replay.data_len() == 0 {
        create_pda(replay, payer, system, program_id, 8,
            &[NONCE_SEED, config.key.as_ref(), user.key.as_ref(), &[replay_bump]])?;
    }
    if replay.owner != program_id || replay.data_len() != 8
        || nonce <= read_u64(&replay.try_borrow_data()?, 0..8)?
        || operation_replay.owner != &system_program::id()
        || operation_replay.data_len() != 0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    create_pda(operation_replay, payer, system, program_id, 32,
        &[BREED_OP_SEED, config.key.as_ref(), user.key.as_ref(), operation_id,
          &[operation_bump]])?;
    {
        let mut bytes = config.try_borrow_mut_data()?;
        bytes[STAGE] = 2;
        put_key(&mut bytes, SOURCE, source.key);
        put_key(&mut bytes, RECIPIENT, treasury.key);
        put_key(&mut bytes, USER, user.key);
        put_u64(&mut bytes, PRINCIPAL, principal);
        put_u64(&mut bytes, FEE, fee);
        put_u64(&mut bytes, ACTIVE_NONCE, nonce);
    }
    burn(source, mint, user, token_program, principal)?;
    transfer(source, mint, treasury, user, meta_list, sysvar, config, hook, token_program, fee)?;
    {
        let mut bytes = config.try_borrow_mut_data()?;
        bytes[STAGE] = 0;
        put_u64(&mut replay.try_borrow_mut_data()?, 0..8, nonce);
        operation_replay.try_borrow_mut_data()?.copy_from_slice(
            solana_program::hash::hash(args).as_ref());
    }
    let operation_text = uuid_text(operation_id)?;
    let account_text = uuid_text(account_id)?;
    let first_text = uuid_text(first)?;
    let second_text = uuid_text(second)?;
    let wallet_text = user.key.to_string();
    let first_uses = args[104].to_string();
    let second_uses = args[105].to_string();
    let issuance_id = solana_program::hash::hashv(&[
        b"EtheRings:cooper-breeding:issuance:v1\ndevnet\n",
        operation_text.as_bytes(), b"\n",
    ]);
    let issuance_hex = hex_text(issuance_id.as_ref());
    let entitlement = solana_program::hash::hashv(&[
        b"EtheRings:cooper-breeding:binding:v1\ndevnet\n",
        account_text.as_bytes(), b"\n", wallet_text.as_bytes(), b"\n",
        operation_text.as_bytes(), b"\n", first_text.as_bytes(), b"\n",
        second_text.as_bytes(), b"\n", first_uses.as_bytes(), b"\n",
        second_uses.as_bytes(), b"\n", issuance_hex.as_bytes(), b"\n",
    ]);
    let mut silver_data = Vec::with_capacity(165 + BOX_URI.len());
    silver_data.push(20);
    silver_data.extend_from_slice(account_id);
    silver_data.extend_from_slice(issuance_id.as_ref());
    silver_data.extend_from_slice(entitlement.as_ref());
    silver_data.extend_from_slice(&BOX_HASH);
    silver_data.extend_from_slice(operation_id);
    silver_data.extend_from_slice(first);
    silver_data.extend_from_slice(second);
    silver_data.extend_from_slice(&args[104..106]);
    silver_data.extend_from_slice(&(BOX_URI.len() as u16).to_le_bytes());
    silver_data.extend_from_slice(BOX_URI.as_bytes());
    let ix = solana_program::instruction::Instruction {
        program_id: SILVER_PROGRAM,
        accounts: vec![
            AccountMeta::new(*breed_issuer.key, true),
            AccountMeta::new_readonly(*silver_config.key, false),
            AccountMeta::new(*box_mint.key, false),
            AccountMeta::new(*box_state.key, false),
            AccountMeta::new(*box_token.key, false),
            AccountMeta::new_readonly(*user.key, true),
            AccountMeta::new_readonly(*box_authority.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*system.key, false),
            AccountMeta::new_readonly(*collection.key, false),
            AccountMeta::new(*box_extra.key, false),
            AccountMeta::new(*lifecycle.key, false),
            AccountMeta::new(*series.key, false),
            AccountMeta::new(*user.key, true),
        ], data: silver_data,
    };
    invoke_signed(&ix, &[
        breed_issuer.clone(), silver_config.clone(), box_mint.clone(),
        box_state.clone(), box_token.clone(), user.clone(), box_authority.clone(),
        token_program.clone(), system.clone(), collection.clone(), box_extra.clone(),
        lifecycle.clone(), series.clone(), user.clone(), silver_program.clone(),
    ], &[&[BREED_ISSUER_SEED, &[issuer_bump]]])
}

fn execute(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8], reward: bool) -> ProgramResult {
    if args.len() != 24 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let principal = u64::from_le_bytes(args[0..8].try_into().unwrap());
    let nonce = u64::from_le_bytes(args[8..16].try_into().unwrap());
    let expiry_slot = u64::from_le_bytes(args[16..24].try_into().unwrap());
    if principal == 0 || nonce == 0 || nonce == u64::MAX || Clock::get()?.slot > expiry_slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let fee = if reward { 0 } else {
        u64::try_from(
            (u128::from(principal).checked_mul(200).ok_or(ProgramError::ArithmeticOverflow)?
                .checked_add(9999).ok_or(ProgramError::ArithmeticOverflow)?) / 10000,
        ).map_err(|_| ProgramError::ArithmeticOverflow)?
    };
    let iter = &mut accounts.iter();
    let source = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let recipient = next_account_info(iter)?;
    let treasury = next_account_info(iter)?;
    let user = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let meta_list = next_account_info(iter)?;
    let sysvar = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let hook = next_account_info(iter)?;
    let replay = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    let (expected_replay, replay_bump) = Pubkey::find_program_address(
        &[NONCE_SEED, config.key.as_ref(), user.key.as_ref()], program_id,
    );
    if !user.is_signer || !source.is_writable || !recipient.is_writable
        || !config.is_writable || config.owner != program_id
        || config.key != &expected_config || replay.key != &expected_replay || !replay.is_writable
        || !payer.is_signer || !payer.is_writable || system.key != &system_program::id()
        || token_program.key != &spl_token_2022::id()
        || sysvar.key != &instructions::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let hook_id = {
        let data = config.try_borrow_data()?;
        if data.len() != CONFIG_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        Pubkey::new_from_array(data[HOOK].try_into().map_err(|_| ProgramError::InvalidAccountData)?)
    };
    if hook.key != &hook_id || !hook.executable {
        return Err(ProgramError::InvalidAccountData);
    }
    let (expected_meta, _) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()],
        &hook_id,
    );
    if meta_list.key != &expected_meta {
        return Err(ProgramError::InvalidSeeds);
    }
    {
        let data = config.try_borrow_data()?;
        if data.len() != CONFIG_LEN || data[0] != 1 || data[STAGE] != 0
            || data[MINT] != mint.key.to_bytes() || data[TREASURY] != treasury.key.to_bytes()
            || (reward && (data[RESERVE] != source.key.to_bytes() || data[1..33] != user.key.to_bytes()))
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if replay.owner == &system_program::id() && replay.data_len() == 0 {
        create_pda(replay, payer, system, program_id, 8,
            &[NONCE_SEED, config.key.as_ref(), user.key.as_ref(), &[replay_bump]])?;
    }
    if replay.owner != program_id || replay.data_len() != 8
        || nonce <= read_u64(&replay.try_borrow_data()?, 0..8)?
    {
        return Err(ProgramError::InvalidAccountData);
    }
    {
        let mut data = config.try_borrow_mut_data()?;
        data[STAGE] = if reward { 3 } else { 1 };
        put_key(&mut data, SOURCE, source.key);
        put_key(&mut data, RECIPIENT, recipient.key);
        put_key(&mut data, USER, user.key);
        put_u64(&mut data, PRINCIPAL, principal);
        put_u64(&mut data, FEE, fee);
        put_u64(&mut data, ACTIVE_NONCE, nonce);
    }
    transfer(source, mint, recipient, user, meta_list, sysvar, config, hook, token_program, principal)?;
    if !reward {
        config.try_borrow_mut_data()?[STAGE] = 2;
        transfer(source, mint, treasury, user, meta_list, sysvar, config, hook, token_program, fee)?;
    }
    {
        let mut data = config.try_borrow_mut_data()?;
        data[STAGE] = 0;
        put_u64(&mut replay.try_borrow_mut_data()?, 0..8, nonce);
    }
    Ok(())
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.split_first() {
        Some((&0, [])) => configure(program_id, accounts),
        Some((&1, args)) if args.len() == COOPER_ARGS_LEN => execute_game(program_id, accounts, args, false),
        Some((&4, args)) if args.len() == SILVER_ARGS_LEN => execute_game(program_id, accounts, args, true),
        Some((&5, args)) => execute_breeding(program_id, accounts, args),
        Some((&1, args)) => execute(program_id, accounts, args, false),
        Some((&2, args)) => execute(program_id, accounts, args, true),
        Some((&3, [])) => Ok(()),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn breeding_uses_only_approved_counter_matrix() {
        assert_eq!(breeding_cost(0, 0), Some((150, 30_000_000_000)));
        assert_eq!(breeding_cost(0, 1), Some((200, 40_000_000_000)));
        assert_eq!(breeding_cost(1, 0), Some((200, 40_000_000_000)));
        assert_eq!(breeding_cost(1, 1), Some((250, 50_000_000_000)));
        assert_eq!(breeding_cost(2, 0), None);
        assert_eq!(breeding_cost(0, 2), None);
    }

    fn args(current: u8, target: u8, principal: u64, ert_cost: u64) -> Vec<u8> {
        let mut data = vec![0u8; COOPER_ARGS_LEN];
        data[0..8].copy_from_slice(&principal.to_le_bytes());
        data[8..16].copy_from_slice(&1u64.to_le_bytes());
        data[16..24].copy_from_slice(&999u64.to_le_bytes());
        data[24] = 1;
        data[40] = 2; // reservation UUID
        data[56] = 3; // Ring UUID
        data[72] = 4; // Alpha account UUID
        data[88] = current;
        data[89] = target;
        data[90..98].copy_from_slice(&ert_cost.to_le_bytes());
        data[98] = 1; // scoped attestation format
        data[99..107].copy_from_slice(&1u64.to_le_bytes());
        data
    }

    #[test]
    fn cooper_prices_match_existing_progression() {
        assert!(game_transition(&args(4, 5, 30_000_000_000, 24), false).is_ok());
        assert!(game_transition(&args(19, 20, 60_000_000_000, 84), false).is_ok());
    }

    #[test]
    fn cooper_rejects_changed_economics_or_identity() {
        assert!(game_transition(&args(4, 5, 30_000_000_001, 24), false).is_err());
        assert!(game_transition(&args(4, 5, 30_000_000_000, 23), false).is_err());
        assert!(game_transition(&args(5, 6, 30_000_000_000, 28), false).is_err());
        let mut empty_operation = args(4, 5, 30_000_000_000, 24);
        empty_operation[24] = 0;
        assert!(game_transition(&empty_operation, false).is_err());
        let mut empty_reservation = args(4, 5, 30_000_000_000, 24);
        empty_reservation[40] = 0;
        assert!(game_transition(&empty_reservation, false).is_err());
        let mut wrong_epoch = args(4, 5, 30_000_000_000, 24);
        wrong_epoch[99..107].copy_from_slice(&0u64.to_le_bytes());
        assert!(game_transition(&wrong_epoch, false).is_err());
        assert!(game_transition(&empty_operation[..106], false).is_err());
    }

    fn silver_args(current: u8, target: u8, principal: u64, ert: u64) -> Vec<u8> {
        let mut data = vec![0u8; SILVER_ARGS_LEN];
        data[0..8].copy_from_slice(&principal.to_le_bytes());
        data[8..16].copy_from_slice(&1u64.to_le_bytes());
        data[16..24].copy_from_slice(&999u64.to_le_bytes());
        data[24] = 1;
        data[40] = 2;
        data[56] = 3;
        data[88] = 4;
        data[104] = current;
        data[105] = target;
        data[106..114].copy_from_slice(&ert.to_le_bytes());
        data[114] = 1;
        data[115..123].copy_from_slice(&1u64.to_le_bytes());
        data
    }

    #[test]
    fn silver_prices_are_distinct_and_bounded() {
        assert!(game_transition(&silver_args(4, 5, 38_000_000_000, 30), true).is_ok());
        assert!(game_transition(&silver_args(19, 20, 75_000_000_000, 105), true).is_ok());
        assert!(game_transition(&silver_args(4, 5, 30_000_000_000, 24), true).is_err());
        assert!(game_transition(&silver_args(19, 20, 75_000_000_000, 104), true).is_err());
        assert!(game_transition(&silver_args(5, 6, 38_000_000_000, 35), true).is_err());
    }
}
