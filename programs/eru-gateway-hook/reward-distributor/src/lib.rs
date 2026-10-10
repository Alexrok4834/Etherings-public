use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    program::{invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions, Sysvar},
};
use spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::{Account as TokenAccount, Mint},
};

entrypoint!(process_instruction);

const CONFIG_SEED: &[u8] = b"reward-config";
const PAYOUT_SEED: &[u8] = b"reward-payout";
const DELEGATE_SEED: &[u8] = b"reward-delegate";
const DRAW_AUTH_SEED: &[u8] = b"reward-draw-auth";
const DRAW_RESULT_SEED: &[u8] = b"reward-draw-result";
const ADMIN_AUTH_SEED: &[u8] = b"reward-admin-auth";
const ADMIN_RESULT_SEED: &[u8] = b"reward-admin-result";
const CONFIG_LEN: usize = 161;
const PAYOUT_LEN: usize = 106;
const DRAW_AUTH_LEN: usize = 33;
const DRAW_RESULT_LEN: usize = 49;
const DRAW_ERU_AMOUNT: u64 = 5_000_000_000;
const ADMIN_MAX_AMOUNT: u64 = 50_000_000_000;
const ADMIN_TOTAL_AMOUNT: u64 = 20_000_000_000_000;
const ADMIN_AUTH_LEN: usize = 49;
const ADMIN_RESULT_LEN: usize = 33;

fn key(data: &[u8], range: std::ops::Range<usize>) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(data.get(range).ok_or(ProgramError::InvalidAccountData)?
        .try_into().map_err(|_| ProgramError::InvalidAccountData)?))
}
fn number(data: &[u8], range: std::ops::Range<usize>) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(data.get(range).ok_or(ProgramError::InvalidAccountData)?
        .try_into().map_err(|_| ProgramError::InvalidAccountData)?))
}
fn upgrade_authority(program_id: &Pubkey, programdata: &AccountInfo, vault: &AccountInfo) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id());
    if !vault.is_signer || programdata.key != &expected ||
        programdata.owner != &bpf_loader_upgradeable::id() ||
        programdata.data_len() < UpgradeableLoaderState::size_of_programdata_metadata() {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = programdata.try_borrow_data()?;
    let state: UpgradeableLoaderState = bincode::deserialize(
        &data[..UpgradeableLoaderState::size_of_programdata_metadata()]
    ).map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData { upgrade_authority_address: Some(authority), .. }
            if authority == *vault.key => Ok(()),
        _ => Err(ProgramError::InvalidAccountData),
    }
}
fn create<'a>(account: &AccountInfo<'a>, vault: &AccountInfo<'a>, system: &AccountInfo<'a>,
    program_id: &Pubkey, space: usize, seeds: &[&[u8]]) -> ProgramResult {
    if !vault.is_signer || !vault.is_writable || !account.is_writable ||
        system.key != &system_program::id() || account.owner != &system_program::id() ||
        account.data_len() != 0 || account.lamports() != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let rent = Rent::get()?.minimum_balance(space);
    invoke_signed(&system_instruction::create_account(vault.key, account.key, rent,
        space as u64, program_id), &[vault.clone(), account.clone(), system.clone()], &[seeds])
}
fn token(account: &AccountInfo) -> Result<TokenAccount, ProgramError> {
    if account.owner != &spl_token_2022::id() { return Err(ProgramError::InvalidAccountData); }
    Ok(StateWithExtensions::<TokenAccount>::unpack(&account.try_borrow_data()?)?.base)
}
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;
    let gateway_config = next_account_info(iter)?;
    let hook = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || mint.owner != &spl_token_2022::id() || !hook.executable ||
        gateway_config.data_len() != 330 ||
        Pubkey::find_program_address(&[b"eru-config"], gateway_config.owner).0 != *gateway_config.key ||
        key(&gateway_config.try_borrow_data()?, 1..33)? != *vault.key ||
        key(&gateway_config.try_borrow_data()?, 33..65)? != *mint.key ||
        key(&gateway_config.try_borrow_data()?, 97..129)? != *hook.key ||
        key(&gateway_config.try_borrow_data()?, 129..161)? != *reserve.key {
        return Err(ProgramError::InvalidAccountData);
    }
    upgrade_authority(program_id, programdata, vault)?;
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let hook_extension = mint_state.get_extension::<TransferHook>()?;
    if mint_state.base.decimals != 9 ||
        Option::<Pubkey>::from(hook_extension.program_id) != Some(*hook.key) {
        return Err(ProgramError::InvalidAccountData);
    }
    let reserve_state = token(reserve)?;
    if reserve_state.owner != *vault.key || reserve_state.mint != *mint.key ||
        reserve_state.delegate != COption::None { return Err(ProgramError::InvalidAccountData); }
    let (expected, bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected { return Err(ProgramError::InvalidSeeds); }
    create(config, vault, system, program_id, CONFIG_LEN, &[CONFIG_SEED, &[bump]])?;
    let mut data = config.try_borrow_mut_data()?;
    data[0] = 1;
    data[1..33].copy_from_slice(vault.key.as_ref());
    data[33..65].copy_from_slice(mint.key.as_ref());
    data[65..97].copy_from_slice(reserve.key.as_ref());
    data[97..129].copy_from_slice(gateway_config.key.as_ref());
    data[129..161].copy_from_slice(hook.key.as_ref());
    Ok(())
}
fn grant(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if args.len() != 40 { return Err(ProgramError::InvalidInstructionData); }
    let amount = number(args, 16..24)?;
    let nonce = number(args, 24..32)?;
    let expiry = number(args, 32..40)?;
    if args[..16] == [0; 16] || amount == 0 || nonce == 0 ||
        expiry <= Clock::get()?.slot { return Err(ProgramError::InvalidInstructionData); }
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let payout = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let wallet = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        key(&config.try_borrow_data()?, 1..33)? != *vault.key || !vault.is_signer ||
        token(destination)?.owner != *wallet.key ||
        token(destination)?.mint != key(&config.try_borrow_data()?, 33..65)? {
        return Err(ProgramError::InvalidAccountData);
    }
    let nonce_bytes = nonce.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(&[PAYOUT_SEED, &nonce_bytes], program_id);
    if payout.key != &expected { return Err(ProgramError::InvalidSeeds); }
    create(payout, vault, system, program_id, PAYOUT_LEN,
        &[PAYOUT_SEED, &nonce_bytes, &[bump]])?;
    let mut data = payout.try_borrow_mut_data()?;
    data[0] = 1;
    data[1..17].copy_from_slice(&args[..16]);
    data[17..49].copy_from_slice(wallet.key.as_ref());
    data[49..81].copy_from_slice(destination.key.as_ref());
    data[81..89].copy_from_slice(&amount.to_le_bytes());
    data[89..97].copy_from_slice(&nonce_bytes);
    data[97..105].copy_from_slice(&expiry.to_le_bytes());
    Ok(())
}
// Squads authorizes one dedicated Draw attestor. This PDA cannot change the
// reserve delegate allowance or the Distributor's Vault upgrade authority.
fn configure_draw(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let auth = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let attestor = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        key(&config.try_borrow_data()?, 1..33)? != *vault.key ||
        attestor.key == vault.key || attestor.key == &Pubkey::default() {
        return Err(ProgramError::InvalidAccountData);
    }
    upgrade_authority(program_id, programdata, vault)?;
    let (expected, bump) = Pubkey::find_program_address(&[DRAW_AUTH_SEED], program_id);
    if auth.key != &expected { return Err(ProgramError::InvalidSeeds); }
    create(auth, vault, system, program_id, DRAW_AUTH_LEN,
        &[DRAW_AUTH_SEED, &[bump]])?;
    let mut data = auth.try_borrow_mut_data()?;
    data[0] = 1;
    data[1..33].copy_from_slice(attestor.key.as_ref());
    Ok(())
}
// A result marker makes grant once-only by the immutable Draw result UUID,
// independently of the Hook-compatible payout nonce PDA.
fn draw_grant(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    // account UUID, result UUID, exact amount, nonce, expiry slot.
    if args.len() != 56 || args[..16] == [0; 16] || args[16..32] == [0; 16] ||
        number(args, 32..40)? != DRAW_ERU_AMOUNT || number(args, 40..48)? == 0 ||
        number(args, 48..56)? <= Clock::get()?.slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let auth = next_account_info(iter)?;
    let result = next_account_info(iter)?;
    let payout = next_account_info(iter)?;
    let attestor = next_account_info(iter)?;
    let wallet = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        auth.owner != program_id || auth.data_len() != DRAW_AUTH_LEN ||
        auth.key != &Pubkey::find_program_address(&[DRAW_AUTH_SEED], program_id).0 ||
        auth.try_borrow_data()?[0] != 1 ||
        key(&auth.try_borrow_data()?, 1..33)? != *attestor.key ||
        !attestor.is_signer || !attestor.is_writable ||
        attestor.key == &key(&config.try_borrow_data()?, 1..33)? ||
        token(destination)?.owner != *wallet.key ||
        token(destination)?.mint != key(&config.try_borrow_data()?, 33..65)? {
        return Err(ProgramError::InvalidAccountData);
    }
    let (result_key, result_bump) = Pubkey::find_program_address(
        &[DRAW_RESULT_SEED, &args[16..32]], program_id);
    if result.key != &result_key { return Err(ProgramError::InvalidSeeds); }
    let nonce_bytes = number(args, 40..48)?.to_le_bytes();
    let (payout_key, payout_bump) = Pubkey::find_program_address(
        &[PAYOUT_SEED, &nonce_bytes], program_id);
    if payout.key != &payout_key { return Err(ProgramError::InvalidSeeds); }
    create(result, attestor, system, program_id, DRAW_RESULT_LEN,
        &[DRAW_RESULT_SEED, &args[16..32], &[result_bump]])?;
    create(payout, attestor, system, program_id, PAYOUT_LEN,
        &[PAYOUT_SEED, &nonce_bytes, &[payout_bump]])?;
    let mut marker = result.try_borrow_mut_data()?;
    marker[0] = 1;
    marker[1..17].copy_from_slice(&args[..16]);
    marker[17..33].copy_from_slice(&args[16..32]);
    marker[33..41].copy_from_slice(&nonce_bytes);
    marker[41..49].copy_from_slice(&number(args, 48..56)?.to_le_bytes());
    let mut data = payout.try_borrow_mut_data()?;
    data[0] = 1; // Existing claim and Hook semantics stay unchanged.
    data[1..17].copy_from_slice(&args[16..32]);
    data[17..49].copy_from_slice(wallet.key.as_ref());
    data[49..81].copy_from_slice(destination.key.as_ref());
    data[81..89].copy_from_slice(&DRAW_ERU_AMOUNT.to_le_bytes());
    data[89..97].copy_from_slice(&nonce_bytes);
    data[97..105].copy_from_slice(&number(args, 48..56)?.to_le_bytes());
    Ok(())
}
// Squads enables a separate bounded admin issuer once. Draw authorization and
// the existing reserve delegate remain unchanged.
fn configure_admin(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let auth = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let attestor = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        key(&config.try_borrow_data()?, 1..33)? != *vault.key ||
        attestor.key == vault.key || attestor.key == &Pubkey::default() ||
        system.key != &system_program::id() {
        return Err(ProgramError::InvalidAccountData);
    }
    upgrade_authority(program_id, programdata, vault)?;
    let (expected, bump) = Pubkey::find_program_address(&[ADMIN_AUTH_SEED], program_id);
    if auth.key != &expected { return Err(ProgramError::InvalidSeeds); }
    create(auth, vault, system, program_id, ADMIN_AUTH_LEN,
        &[ADMIN_AUTH_SEED, &[bump]])?;
    let mut data = auth.try_borrow_mut_data()?;
    data[0] = 1;
    data[1..33].copy_from_slice(attestor.key.as_ref());
    data[33..41].copy_from_slice(&0u64.to_le_bytes());
    data[41..49].copy_from_slice(&ADMIN_TOTAL_AMOUNT.to_le_bytes());
    Ok(())
}

// Admin grant has its own operation marker. A different payout nonce cannot
// turn a retry of the same operation into a second grant.
fn admin_grant(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if args.len() != 40 || args[..16] == [0; 16] ||
        !(1..=ADMIN_MAX_AMOUNT).contains(&number(args, 16..24)?) ||
        number(args, 24..32)? == 0 || number(args, 32..40)? <= Clock::get()?.slot {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let auth = next_account_info(iter)?;
    let result = next_account_info(iter)?;
    let payout = next_account_info(iter)?;
    let attestor = next_account_info(iter)?;
    let wallet = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    if iter.next().is_some() || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        auth.owner != program_id || auth.data_len() != ADMIN_AUTH_LEN ||
        auth.key != &Pubkey::find_program_address(&[ADMIN_AUTH_SEED], program_id).0 ||
        auth.try_borrow_data()?[0] != 1 ||
        key(&auth.try_borrow_data()?, 1..33)? != *attestor.key ||
        !attestor.is_signer || !attestor.is_writable ||
        attestor.key == &key(&config.try_borrow_data()?, 1..33)? ||
        token(destination)?.owner != *wallet.key ||
        token(destination)?.mint != key(&config.try_borrow_data()?, 33..65)? ||
        system.key != &system_program::id() {
        return Err(ProgramError::InvalidAccountData);
    }
    let amount = number(args, 16..24)?;
    let used = number(&auth.try_borrow_data()?, 33..41)?;
    if number(&auth.try_borrow_data()?, 41..49)? != ADMIN_TOTAL_AMOUNT ||
        used.checked_add(amount).ok_or(ProgramError::ArithmeticOverflow)? > ADMIN_TOTAL_AMOUNT {
        return Err(ProgramError::InsufficientFunds);
    }
    let (result_key, result_bump) = Pubkey::find_program_address(
        &[ADMIN_RESULT_SEED, &args[..16]], program_id);
    if result.key != &result_key { return Err(ProgramError::InvalidSeeds); }
    let nonce_bytes = number(args, 24..32)?.to_le_bytes();
    let (payout_key, payout_bump) = Pubkey::find_program_address(
        &[PAYOUT_SEED, &nonce_bytes], program_id);
    if payout.key != &payout_key { return Err(ProgramError::InvalidSeeds); }
    create(result, attestor, system, program_id, ADMIN_RESULT_LEN,
        &[ADMIN_RESULT_SEED, &args[..16], &[result_bump]])?;
    create(payout, attestor, system, program_id, PAYOUT_LEN,
        &[PAYOUT_SEED, &nonce_bytes, &[payout_bump]])?;
    let mut marker = result.try_borrow_mut_data()?;
    marker[0] = 1;
    marker[1..17].copy_from_slice(&args[..16]);
    marker[17..25].copy_from_slice(&nonce_bytes);
    marker[25..33].copy_from_slice(&amount.to_le_bytes());
    let mut data = payout.try_borrow_mut_data()?;
    data[0] = 1; // The existing claim and Hook path still verify this payout.
    data[1..17].copy_from_slice(&args[..16]);
    data[17..49].copy_from_slice(wallet.key.as_ref());
    data[49..81].copy_from_slice(destination.key.as_ref());
    data[81..89].copy_from_slice(&amount.to_le_bytes());
    data[89..97].copy_from_slice(&nonce_bytes);
    data[97..105].copy_from_slice(&number(args, 32..40)?.to_le_bytes());
    auth.try_borrow_mut_data()?[33..41].copy_from_slice(&(used + amount).to_le_bytes());
    Ok(())
}
fn claim(program_id: &Pubkey, accounts: &[AccountInfo], args: &[u8]) -> ProgramResult {
    if args.len() != 16 { return Err(ProgramError::InvalidInstructionData); }
    let nonce = number(args, 0..8)?;
    let amount = number(args, 8..16)?;
    let nonce_bytes = nonce.to_le_bytes();
    let iter = &mut accounts.iter();
    let config = next_account_info(iter)?;
    let payout = next_account_info(iter)?;
    let reserve = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let delegate = next_account_info(iter)?;
    let gateway_config = next_account_info(iter)?;
    let meta_list = next_account_info(iter)?;
    let sysvar = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let hook = next_account_info(iter)?;
    if iter.next().is_some() || amount == 0 || config.owner != program_id ||
        config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0 ||
        config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1 ||
        payout.owner != program_id || payout.data_len() != PAYOUT_LEN ||
        payout.key != &Pubkey::find_program_address(&[PAYOUT_SEED, &nonce_bytes], program_id).0 ||
        sysvar.key != &instructions::id() || token_program.key != &spl_token_2022::id() ||
        !hook.executable || key(&config.try_borrow_data()?, 33..65)? != *mint.key ||
        key(&config.try_borrow_data()?, 65..97)? != *reserve.key ||
        key(&config.try_borrow_data()?, 97..129)? != *gateway_config.key ||
        key(&config.try_borrow_data()?, 129..161)? != *hook.key ||
        meta_list.key != &Pubkey::find_program_address(
            &[b"extra-account-metas", mint.key.as_ref()], hook.key).0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = payout.try_borrow_data()?;
    if data[0] != 1 || data[105] != 0 || number(&data, 81..89)? != amount ||
        number(&data, 89..97)? != nonce || Clock::get()?.slot > number(&data, 97..105)? ||
        key(&data, 49..81)? != *destination.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let recipient = key(&data, 17..49)?;
    drop(data);
    let source_state = token(reserve)?;
    let destination_state = token(destination)?;
    let (expected_delegate, bump) = Pubkey::find_program_address(&[DELEGATE_SEED], program_id);
    if delegate.key != &expected_delegate || source_state.owner !=
        key(&config.try_borrow_data()?, 1..33)? ||
        source_state.mint != *mint.key || source_state.delegate != COption::Some(*delegate.key) ||
        source_state.delegated_amount < amount || destination_state.owner != recipient ||
        destination_state.mint != *mint.key {
        return Err(ProgramError::InvalidAccountData);
    }
    payout.try_borrow_mut_data()?[105] = 1;
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program.key, reserve.key, mint.key, destination.key, delegate.key, &[], amount, 9)?;
    ix.accounts.push(AccountMeta::new_readonly(*meta_list.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*sysvar.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*gateway_config.key, false));
    ix.accounts.push(AccountMeta::new_readonly(*hook.key, false));
    invoke_signed(&ix, &[reserve.clone(), mint.clone(), destination.clone(), delegate.clone(),
        meta_list.clone(), sysvar.clone(), gateway_config.clone(), hook.clone(), token_program.clone()],
        &[&[DELEGATE_SEED, &[bump]]])
}
pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.split_first() {
        Some((&0, [])) => initialize(program_id, accounts),
        Some((&1, args)) => grant(program_id, accounts, args),
        Some((&2, args)) => claim(program_id, accounts, args),
        Some((&3, [])) => configure_draw(program_id, accounts),
        Some((&4, args)) => draw_grant(program_id, accounts, args),
        Some((&5, [])) => configure_admin(program_id, accounts),
        Some((&6, args)) => admin_grant(program_id, accounts, args),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
