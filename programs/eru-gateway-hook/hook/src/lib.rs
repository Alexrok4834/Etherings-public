use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::{instructions, Sysvar},
};
use spl_token_2022::{
    extension::{transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as TokenMint,
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, state::ExtraAccountMetaList};
use spl_transfer_hook_interface::instruction::{ExecuteInstruction, TransferHookInstruction};

entrypoint!(process_instruction);

const CONFIG_LEN: usize = 330;
const CONFIG_SEED: &[u8] = b"eru-config";
const COOPER_OP_SEED: &[u8] = b"cooper-level-up";
const BREED_OP_SEED: &[u8] = b"cooper-breeding";
const SILVER_OP_SEED: &[u8] = b"silver-level-up";
const SILVER_PROGRAM: Pubkey = solana_program::pubkey!("3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX");
const GATEWAY_PROGRAM: Pubkey = solana_program::pubkey!("Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF");
// The approved Devnet-only Reward Distributor is itself Vault-upgradeable.
// Testnet uses a separately reviewed binary with its own fresh program ID.
const DEVNET_DISTRIBUTOR: Pubkey = solana_program::pubkey!("GjQwhUwa1XfwFVicqhJqA2oUHV2GaLrJ7o2GR6b1UzjH");

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

fn key(data: &[u8], start: usize) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(
        data.get(start..start + 32)
            .ok_or(ProgramError::InvalidAccountData)?
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn number(data: &[u8], start: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        data.get(start..start + 8)
            .ok_or(ProgramError::InvalidAccountData)?
            .try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let list = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let payer = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], config.owner);
    if !payer.is_signer || !payer.is_writable || system.key != &solana_program::system_program::id()
        || config.key != &expected_config || mint.owner != &spl_token_2022::id()
        || config.data_len() != CONFIG_LEN || config.try_borrow_data()?[0] != 1
        || key(&config.try_borrow_data()?, 33)? != *mint.key
        || key(&config.try_borrow_data()?, 97)? != *program_id
        || key(&config.try_borrow_data()?, 1)? != *payer.key
    {
        return Err(ProgramError::InvalidAccountData);
    }
    check_upgrade_authority(program_id, programdata, payer)?;
    {
        let mint_data = mint.try_borrow_data()?;
        let state = StateWithExtensions::<TokenMint>::unpack(&mint_data)?;
        let transfer_hook = state.get_extension::<TransferHook>()?;
        if state.base.decimals != 9 || state.base.mint_authority != COption::Some(*payer.key)
            || Option::<Pubkey>::from(transfer_hook.authority) != Some(*payer.key)
            || Option::<Pubkey>::from(transfer_hook.program_id) != Some(*program_id)
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let (expected, bump) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()], program_id,
    );
    if list.key != &expected || list.data_len() != 0
        || list.owner != &solana_program::system_program::id()
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let metas = [
        ExtraAccountMeta::new_with_pubkey(&instructions::id(), false, false)?,
        ExtraAccountMeta::new_with_pubkey(config.key, false, false)?,
    ];
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let rent = Rent::get()?.minimum_balance(size);
    let seeds: &[&[u8]] = &[b"extra-account-metas", mint.key.as_ref(), &[bump]];
    if list.lamports() == 0 {
        invoke_signed(
            &system_instruction::create_account(payer.key, list.key, rent, size as u64, program_id),
            &[payer.clone(), list.clone(), system.clone()], &[seeds],
        )?;
    } else {
        if list.lamports() < rent {
            invoke(
                &system_instruction::transfer(payer.key, list.key, rent - list.lamports()),
                &[payer.clone(), list.clone(), system.clone()],
            )?;
        }
        invoke_signed(
            &system_instruction::allocate(list.key, size as u64),
            &[list.clone(), system.clone()], &[seeds],
        )?;
        invoke_signed(
            &system_instruction::assign(list.key, program_id),
            &[list.clone(), system.clone()], &[seeds],
        )?;
    }
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut list.try_borrow_mut_data()?, &metas)?;
    Ok(())
}

fn execute(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let iter = &mut accounts.iter();
    let source = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let destination = next_account_info(iter)?;
    let authority = next_account_info(iter)?;
    let list = next_account_info(iter)?;
    let sysvar = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let (expected, _) = Pubkey::find_program_address(
        &[b"extra-account-metas", mint.key.as_ref()], program_id,
    );
    if list.key != &expected || list.owner != program_id || sysvar.key != &instructions::id()
        || config.data_len() != CONFIG_LEN
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_data = config.try_borrow_data()?;
    if config_data[0] != 1 || key(&config_data, 33)? != *mint.key
        || key(&config_data, 97)? != *program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    let ix = instructions::load_instruction_at_checked(
        instructions::load_current_index_checked(sysvar)? as usize, sysvar,
    )?;
    // A one-purpose delegated reserve transfer may only originate from the
    // pinned Distributor's typed claim. Direct Token-2022/Squads transfers and
    // every existing Gateway branch retain their original guards below.
    if ix.program_id == DEVNET_DISTRIBUTOR {
        // Token-2022 strips the delegate signer flag when invoking the Hook;
        // the Distributor CPI itself proves PDA signing and delegate allowance.
        if ix.data.len() != 17 || ix.data[0] != 2 || ix.accounts.len() != 11 ||
            config_data[169] != 0 || key(&config_data, 129)? != *source.key ||
            amount != number(&ix.data, 9)? ||
            *authority.key != Pubkey::find_program_address(
                &[b"reward-delegate"], &DEVNET_DISTRIBUTOR).0 ||
            ix.accounts[0].pubkey != Pubkey::find_program_address(
                &[b"reward-config"], &DEVNET_DISTRIBUTOR).0 ||
            ix.accounts[1].pubkey != Pubkey::find_program_address(
                &[b"reward-payout", &ix.data[1..9]], &DEVNET_DISTRIBUTOR).0 ||
            ix.accounts[2].pubkey != *source.key ||
            ix.accounts[3].pubkey != *mint.key ||
            ix.accounts[4].pubkey != *destination.key || !ix.accounts[4].is_writable ||
            ix.accounts[5].pubkey != *authority.key ||
            ix.accounts[6].pubkey != *config.key ||
            ix.accounts[7].pubkey != *list.key ||
            ix.accounts[8].pubkey != *sysvar.key ||
            ix.accounts[9].pubkey != *mint.owner ||
            ix.accounts[10].pubkey != *program_id {
            return Err(ProgramError::InvalidInstructionData);
        }
        return Ok(());
    }
    if key(&config_data, 170)? != *source.key ||
        key(&config_data, 234)? != *authority.key {
        return Err(ProgramError::InvalidAccountData);
    }
    if ix.program_id == SILVER_PROGRAM && ix.data.len() == 83
        && ix.data[0] == 18 && ix.accounts.len() == 20
    {
        let target = ix.data[2];
        let (principal, ert) = match (ix.data[1], target) {
            (4, 5) => (38_000_000_000, 30),
            (19, 20) => (75_000_000_000, 105),
            _ => return Err(ProgramError::InvalidInstructionData),
        };
        let fee = (principal * 2) / 100;
        let (silver_config, _) = Pubkey::find_program_address(
            &[b"silver-config"], &SILVER_PROGRAM);
        let (gateway_config, _) = Pubkey::find_program_address(
            &[CONFIG_SEED], &GATEWAY_PROGRAM);
        let (gateway_operation, _) = Pubkey::find_program_address(
            &[SILVER_OP_SEED, config.key.as_ref(), authority.key.as_ref(), &ix.data[3..19]],
            &GATEWAY_PROGRAM);
        let (gateway_nonce, _) = Pubkey::find_program_address(
            &[b"nonce", config.key.as_ref(), authority.key.as_ref()], &GATEWAY_PROGRAM);
        let (silver_authority, _) = Pubkey::find_program_address(
            &[b"silver-paid-gateway"], &SILVER_PROGRAM);
        if config.owner != &GATEWAY_PROGRAM || config.key != &gateway_config
            || config_data[169] != 2 || amount != fee
            || number(&config_data, 266)? != principal
            || number(&config_data, 274)? != fee
            || number(&config_data, 282)? != number(&ix.data, 59)?
            || number(&ix.data, 51)? != ert
            || destination.key != &key(&config_data, 65)?
            || ix.accounts[0].pubkey != *authority.key || !ix.accounts[0].is_signer
            || ix.accounts[1].pubkey == *authority.key || !ix.accounts[1].is_signer
            || ix.accounts[2].pubkey != silver_config
            || ix.accounts[8].pubkey != GATEWAY_PROGRAM
            || ix.accounts[9].pubkey != *config.key
            || ix.accounts[10].pubkey != *source.key
            || ix.accounts[11].pubkey != *mint.key
            || ix.accounts[12].pubkey != *destination.key
            || ix.accounts[13].pubkey != *list.key
            || ix.accounts[14].pubkey != *sysvar.key
            || ix.accounts[15].pubkey != *mint.owner
            || ix.accounts[16].pubkey != *program_id
            || ix.accounts[17].pubkey != gateway_nonce
            || ix.accounts[18].pubkey != gateway_operation
            || ix.accounts[19].pubkey != silver_authority
        {
            return Err(ProgramError::InvalidInstructionData);
        }
        return Ok(());
    }
    let (expected_replay, _) = Pubkey::find_program_address(
        &[b"nonce", config.key.as_ref(), authority.key.as_ref()], config.owner,
    );
    let typed_cooper = if ix.data.len() == 108 && ix.accounts.len() == 15
        && ix.data[0] == 1 && config_data[169] == 2
    {
        let (operation_replay, _) = Pubkey::find_program_address(
            &[COOPER_OP_SEED, config.key.as_ref(), authority.key.as_ref(), &ix.data[25..41]],
            &ix.program_id,
        );
        ix.accounts[14].pubkey == operation_replay && ix.accounts[14].is_writable
    } else {
        false
    };
    let typed_breeding = if ix.program_id == GATEWAY_PROGRAM
        && ix.data.len() == 124 && ix.accounts.len() == 26
        && ix.data[0] == 5 && config_data[169] == 2
    {
        let (operation_replay, _) = Pubkey::find_program_address(
            &[BREED_OP_SEED, config.key.as_ref(), authority.key.as_ref(),
              &ix.data[25..41]], &GATEWAY_PROGRAM);
        let (issuer, _) = Pubkey::find_program_address(
            &[b"cooper-breeding-issuer"], &GATEWAY_PROGRAM);
        ix.accounts[14].pubkey == operation_replay
            && ix.accounts[14].is_writable
            && ix.accounts[15].pubkey == issuer
            && ix.accounts[16].pubkey == SILVER_PROGRAM
    } else {
        false
    };
    let typed_game = typed_cooper || typed_breeding;
    let shift = usize::from(typed_game);
    if config.owner != &ix.program_id
        || !(typed_game || (ix.accounts.len() == 13 && ix.data.len() == 25))
        || ix.accounts[0].pubkey != *source.key
        || ix.accounts[1].pubkey != *mint.key
        || ix.accounts[4].pubkey != *authority.key
        || !ix.accounts[4].is_signer
        || (typed_game && (ix.accounts[5].pubkey != key(&config_data, 290)?
            || !ix.accounts[5].is_signer || ix.accounts[5].pubkey == *authority.key))
        || ix.accounts[5 + shift].pubkey != *config.key
        || ix.accounts[6 + shift].pubkey != *list.key
        || ix.accounts[7 + shift].pubkey != *sysvar.key
        || ix.accounts[8 + shift].pubkey != *mint.owner
        || ix.accounts[9 + shift].pubkey != *program_id
        || ix.accounts[10 + shift].pubkey != expected_replay
        || !ix.accounts[11 + shift].is_signer || !ix.accounts[11 + shift].is_writable
        || ix.accounts[12 + shift].pubkey != solana_program::system_program::id()
        || ix.data[0] != if typed_breeding { 5 }
            else if config_data[169] == 3 { 2 } else { 1 }
        || number(&ix.data, 1)? != number(&config_data, 266)?
        || number(&ix.data, 9)? != number(&config_data, 282)?
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let expected_destination = match config_data[169] {
        1 | 3 => key(&config_data, 202)?,
        2 => key(&config_data, 65)?,
        _ => return Err(ProgramError::InvalidAccountData),
    };
    let expected_amount = if config_data[169] == 2 {
        number(&config_data, 274)?
    } else {
        number(&config_data, 266)?
    };
    if destination.key != &expected_destination || amount != expected_amount
        || ix.accounts[2].pubkey != key(&config_data, 202)?
        || ix.accounts[3].pubkey != key(&config_data, 65)?
        || (config_data[169] == 3 && key(&config_data, 129)? != *source.key)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data == [0xA0] {
        return initialize(program_id, accounts);
    }
    match TransferHookInstruction::unpack(data)? {
        TransferHookInstruction::Execute { amount } => execute(program_id, accounts, amount),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
