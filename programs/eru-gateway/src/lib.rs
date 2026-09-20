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

const CONFIG_LEN: usize = 290;
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
const CONFIG_SEED: &[u8] = b"eru-config";
const NONCE_SEED: &[u8] = b"nonce";

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
        || !hook.executable
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
        Some((&1, args)) => execute(program_id, accounts, args, false),
        Some((&2, args)) => execute(program_id, accounts, args, true),
        Some((&3, [])) => Ok(()),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
