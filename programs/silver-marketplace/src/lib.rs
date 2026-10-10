use solana_program::{
    account_info::AccountInfo,
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
use spl_token_2022::{
    extension::{metadata_pointer::MetadataPointer, transfer_hook::TransferHook,
        BaseStateWithExtensions, StateWithExtensions},
    instruction as token_instruction,
    state::{Account as TokenAccount, Mint},
};
use spl_transfer_hook_interface::get_extra_account_metas_address_and_bump_seed;
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed};
use silver_first_entry_alpha::{
    canonical_meta_list, lifecycle_extra_meta, lifecycle_matches,
    ring_state_extra_meta, ring_state_matches, state_extra_meta,
    COLLECTION_SEED, LIFECYCLE_SEED, MINT_SEED, RING_STATE_LEN,
    RING_STATE_SEED, STATE_SEED, TRANSFER_STATE_LEN,
};

mod marketplace;

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo],
    data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(21) => marketplace::configure(program_id, accounts, data),
        Some(22) => marketplace::list(program_id, accounts, data),
        Some(23) => marketplace::cancel(program_id, accounts, data),
        Some(24) => marketplace::buy(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn check_upgrade_authority(program_id: &Pubkey, programdata: &AccountInfo,
    signer: &AccountInfo) -> ProgramResult {
    let (expected, _) = Pubkey::find_program_address(
        &[program_id.as_ref()], &bpf_loader_upgradeable::id());
    if !signer.is_signer || programdata.key != &expected
        || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len() < UpgradeableLoaderState::size_of_programdata_metadata()
    { return Err(ProgramError::InvalidAccountData); }
    let data = programdata.try_borrow_data()?;
    let state: UpgradeableLoaderState = bincode::deserialize(
        &data[..UpgradeableLoaderState::size_of_programdata_metadata()])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData { upgrade_authority_address: Some(authority), .. }
            if authority == *signer.key => Ok(()),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

fn create_pda<'a>(account: &AccountInfo<'a>, payer: &AccountInfo<'a>,
    system: &AccountInfo<'a>, owner: &Pubkey, space: usize, seeds: &[&[u8]])
    -> ProgramResult {
    if account.owner != &system_program::id() || account.data_len() != 0
        || !account.is_writable || !payer.is_signer || !payer.is_writable
        || system.key != &system_program::id()
    { return Err(ProgramError::InvalidAccountData); }
    let rent = Rent::get()?.minimum_balance(space);
    if account.lamports() == 0 {
        invoke_signed(&system_instruction::create_account(payer.key, account.key,
            rent, space as u64, owner), &[payer.clone(), account.clone(), system.clone()],
            &[seeds])
    } else {
        invoke_signed(&system_instruction::allocate(account.key, space as u64),
            &[account.clone(), system.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(account.key, owner),
            &[account.clone(), system.clone()], &[seeds])?;
        if account.lamports() < rent {
            invoke(&system_instruction::transfer(payer.key, account.key,
                rent - account.lamports()),
                &[payer.clone(), account.clone(), system.clone()])?;
        }
        Ok(())
    }
}
