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

const CONFIG_LEN: usize = 290;
const CONFIG_SEED: &[u8] = b"eru-config";

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
        || key(&config_data, 97)? != *program_id
        || key(&config_data, 170)? != *source.key
        || key(&config_data, 234)? != *authority.key
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let ix = instructions::load_instruction_at_checked(
        instructions::load_current_index_checked(sysvar)? as usize, sysvar,
    )?;
    let (expected_replay, _) = Pubkey::find_program_address(
        &[b"nonce", config.key.as_ref(), authority.key.as_ref()], config.owner,
    );
    if config.owner != &ix.program_id || ix.accounts.len() != 13 || ix.data.len() != 25
        || ix.accounts[0].pubkey != *source.key
        || ix.accounts[1].pubkey != *mint.key
        || ix.accounts[4].pubkey != *authority.key
        || !ix.accounts[4].is_signer
        || ix.accounts[5].pubkey != *config.key
        || ix.accounts[6].pubkey != *list.key
        || ix.accounts[7].pubkey != *sysvar.key
        || ix.accounts[8].pubkey != *mint.owner
        || ix.accounts[9].pubkey != *program_id
        || ix.accounts[10].pubkey != expected_replay
        || !ix.accounts[11].is_signer || !ix.accounts[11].is_writable
        || ix.accounts[12].pubkey != solana_program::system_program::id()
        || ix.data[0] != if config_data[169] == 3 { 2 } else { 1 }
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
