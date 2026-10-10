use super::*;

const LISTING_SEED: &[u8] = b"silver-market-listing";
const MAGIC: &[u8; 8] = b"ERSMKV1\0";
const LISTING_LEN: usize = 320;
const CANONICAL_MARKET: Pubkey = solana_program::pubkey!("BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j");
const SQUADS_VAULT: Pubkey = solana_program::pubkey!("4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk");

fn governed_program(program: &AccountInfo, programdata: &AccountInfo) -> ProgramResult {
    let expected = Pubkey::find_program_address(
        &[program.key.as_ref()], &bpf_loader_upgradeable::id()).0;
    if !program.executable || program.owner != &bpf_loader_upgradeable::id()
        || *programdata.key != expected || programdata.owner != &bpf_loader_upgradeable::id()
        || programdata.data_len() < UpgradeableLoaderState::size_of_programdata_metadata()
    { return Err(ProgramError::InvalidAccountData); }
    let program_state: UpgradeableLoaderState = bincode::deserialize(
        &program.try_borrow_data()?)
        .map_err(|_| ProgramError::InvalidAccountData)?;
    if !matches!(program_state, UpgradeableLoaderState::Program {
        programdata_address,
    } if programdata_address == expected) {
        return Err(ProgramError::InvalidAccountData);
    }
    let bytes = programdata.try_borrow_data()?;
    let state: UpgradeableLoaderState = bincode::deserialize(
        &bytes[..UpgradeableLoaderState::size_of_programdata_metadata()])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    match state {
        UpgradeableLoaderState::ProgramData {
            upgrade_authority_address: Some(authority), ..
        } if authority == SQUADS_VAULT => Ok(()),
        _ => Err(ProgramError::InvalidAccountData),
    }
}

// Owner-authorized one-time upgrade is part of M's first LIST transaction.
// M signs its PDA; no seller or backend can impersonate this CPI caller.
pub(super) fn lazy_migrate_metas(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8])
    -> ProgramResult {
    if data != [26] || accounts.len() != 14 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [seller, mint, state, lifecycle, source, extra, listing, market_authority,
        market, market_programdata, silver_programdata, config, token_program, system]
        = accounts else { return Err(ProgramError::NotEnoughAccountKeys); };
    if *market.key != CANONICAL_MARKET || !market.executable
        || *market_authority.key != Pubkey::find_program_address(
            &[b"silver-market-authority"], market.key).0
        || !market_authority.is_signer || !seller.is_signer || !seller.is_writable
        || !extra.is_writable || *token_program.key != spl_token_2022::id()
        || *system.key != system_program::id() || mint.owner != token_program.key
        || source.owner != token_program.key || state.owner != program_id
        || extra.owner != program_id
        || *extra.key != get_extra_account_metas_address_and_bump_seed(mint.key, program_id).0
        || *listing.key != listing_address(market.key, mint.key)
        || listing.owner != &system_program::id() || listing.data_len() != 0
        || *config.key != Pubkey::find_program_address(
            &[b"silver-market-config"], market.key).0
        || config.owner != market.key || config.data_len() != 137
    { return Err(ProgramError::InvalidAccountData); }
    // The executing Silver program's ProgramData PDA is unique to program_id;
    // M additionally proves that its executable account points at its PDA.
    let expected_silver_programdata = Pubkey::find_program_address(
        &[program_id.as_ref()], &bpf_loader_upgradeable::id()).0;
    if *silver_programdata.key != expected_silver_programdata
        || silver_programdata.owner != &bpf_loader_upgradeable::id()
        || silver_programdata.data_len()
            < UpgradeableLoaderState::size_of_programdata_metadata()
    { return Err(ProgramError::InvalidAccountData); }
    let silver_data = silver_programdata.try_borrow_data()?;
    let silver_state: UpgradeableLoaderState = bincode::deserialize(
        &silver_data[..UpgradeableLoaderState::size_of_programdata_metadata()])
        .map_err(|_| ProgramError::InvalidAccountData)?;
    if !matches!(silver_state, UpgradeableLoaderState::ProgramData {
        upgrade_authority_address: Some(authority), ..
    } if authority == SQUADS_VAULT) {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(silver_data);
    governed_program(market, market_programdata)?;
    let config_bytes = config.try_borrow_data()?;
    if config_bytes[0] != 1 || config_bytes[1..33] != SQUADS_VAULT.to_bytes()
        || u64::from_le_bytes(config_bytes[33..41].try_into().unwrap()) == 0
        || config_bytes[41..73].iter().all(|byte| *byte == 0)
        || config_bytes[73..105].iter().all(|byte| *byte == 0)
        || config_bytes[105..137] != program_id.to_bytes()
    { return Err(ProgramError::InvalidAccountData); }
    drop(config_bytes);
    let mint_data = mint.try_borrow_data()?;
    let minted = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if minted.base.decimals != 0 || minted.base.supply != 1
        || minted.base.mint_authority != COption::None
        || minted.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(minted.get_extension::<TransferHook>()?.program_id)
            != Some(*program_id)
        || Option::<Pubkey>::from(minted.get_extension::<MetadataPointer>()?.metadata_address)
            != Some(*mint.key)
        || Option::<Pubkey>::from(minted.get_extension::<MetadataPointer>()?.authority).is_some()
        || Option::<Pubkey>::from(minted.get_extension::<TransferHook>()?.authority).is_some()
        || minted.get_extension::<spl_token_2022::extension::permanent_delegate::PermanentDelegate>().is_ok()
    { return Err(ProgramError::InvalidAccountData); }
    drop(mint_data);
    let source_data = source.try_borrow_data()?;
    let owned = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
    if owned.base.owner != *seller.key || owned.base.mint != *mint.key
        || owned.base.amount != 1 || owned.base.delegate != COption::None
    { return Err(ProgramError::InvalidAccountData); }
    drop(source_data);
    let is_ring = state.data_len() == RING_STATE_LEN;
    let mut metas = if is_ring {
        if *state.key != Pubkey::find_program_address(
            &[RING_STATE_SEED, mint.key.as_ref()], program_id).0
            || !ring_state_matches(program_id, mint.key, &state.try_borrow_data()?)
            || i64::from_le_bytes(state.try_borrow_data()?[328..336].try_into().unwrap())
                > Clock::get()?.unix_timestamp
        { return Err(ProgramError::InvalidAccountData); }
        vec![ring_state_extra_meta()?]
    } else {
        let bytes = state.try_borrow_data()?;
        if bytes.len() != TRANSFER_STATE_LEN || bytes[0..4] != [3, 1, 1, 1]
            || bytes[36..68] != mint.key.to_bytes()
            || Pubkey::find_program_address(
                &[MINT_SEED, &bytes[4..36]], program_id).0 != *mint.key
            || bytes[68..100] != Pubkey::find_program_address(
                &[COLLECTION_SEED], program_id).0.to_bytes()
            || i64::from_le_bytes(bytes[196..204].try_into().unwrap())
                > Clock::get()?.unix_timestamp
            || *state.key != Pubkey::find_program_address(
                &[STATE_SEED, mint.key.as_ref()], program_id).0
            || *lifecycle.key != Pubkey::find_program_address(
                &[LIFECYCLE_SEED, mint.key.as_ref()], program_id).0
            || lifecycle.owner != program_id
            || !lifecycle_matches(&lifecycle.try_borrow_data()?, mint.key)
        { return Err(ProgramError::InvalidAccountData); }
        vec![state_extra_meta()?, lifecycle_extra_meta()?]
    };
    if extra.try_borrow_data()?.as_ref() != canonical_meta_list(&metas)?.as_slice() {
        return Err(ProgramError::InvalidAccountData);
    }
    metas.extend(market_metas(market.key, is_ring)?);
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let rent = Rent::get()?.minimum_balance(size);
    if extra.lamports() < rent {
        invoke(&system_instruction::transfer(seller.key, extra.key,
            rent - extra.lamports()),
            &[seller.clone(), extra.clone(), system.clone()])?;
    }
    extra.realloc(size, false)?;
    extra.try_borrow_mut_data()?.fill(0);
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut extra.try_borrow_mut_data()?, &metas)
}

pub(super) fn market_metas(market: &Pubkey, is_ring: bool)
    -> Result<Vec<ExtraAccountMeta>, ProgramError> {
    let market_index = if is_ring { 6 } else { 7 };
    Ok(vec![
        ExtraAccountMeta::new_with_pubkey(market, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(market_index,
            &[Seed::Literal { bytes: LISTING_SEED.to_vec() },
              Seed::AccountKey { index: 1 }], false, true)?,
    ])
}

pub(super) fn meta_list_matches(extra: &AccountInfo, market: Option<&AccountInfo>,
    is_ring: bool) -> Result<bool, ProgramError> {
    let mut metas = if is_ring { vec![ring_state_extra_meta()?] }
        else { vec![state_extra_meta()?, lifecycle_extra_meta()?] };
    let old = canonical_meta_list(&metas)?;
    let bytes = extra.try_borrow_data()?;
    if bytes.as_ref() == old.as_slice() { return Ok(market.is_none()); }
    let Some(market) = market else { return Ok(false); };
    if !market.executable { return Ok(false); }
    metas.extend(market_metas(market.key, is_ring)?);
    Ok(bytes.as_ref() == canonical_meta_list(&metas)?.as_slice())
}

pub(super) fn listing_address(market: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[LISTING_SEED, mint.as_ref()], market).0
}

pub(super) fn listing_is_active(market: &AccountInfo, listing: &AccountInfo,
    mint: &Pubkey) -> Result<bool, ProgramError> {
    if !market.executable || *listing.key != listing_address(market.key, mint) {
        return Err(ProgramError::InvalidSeeds);
    }
    if listing.owner == &system_program::id() && listing.data_len() == 0 {
        return Ok(false);
    }
    if listing.owner != market.key || listing.data_len() != LISTING_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let bytes = listing.try_borrow_data()?;
    if bytes[0..8] != *MAGIC || bytes[8] != 1 || bytes[16..48] != mint.to_bytes() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(bytes[9] == 1)
}

// Token-2022 applies the token and delegate changes before invoking the Hook.
// BUYING is an ephemeral listing phase set by Marketplace M inside its atomic
// buy; M -> Token-2022 -> Silver S has no indirect re-entry.
pub(super) fn market_transfer_authority(program_id: &Pubkey,
    authority: &AccountInfo, source: &AccountInfo, destination: &AccountInfo,
    mint: &Pubkey, from: &TokenAccount, to: &TokenAccount,
    market: Option<&AccountInfo>, listing: Option<&AccountInfo>,
    extra_metas: &AccountInfo, is_ring: bool) -> bool {
    let (Some(market), Some(listing)) = (market, listing) else { return false; };
    let mut metas = if is_ring {
        let Ok(state) = ring_state_extra_meta() else { return false; };
        vec![state]
    } else {
        let (Ok(state), Ok(lifecycle)) = (state_extra_meta(), lifecycle_extra_meta())
            else { return false; };
        vec![state, lifecycle]
    };
    let Ok(market_metas) = market_metas(market.key, is_ring) else { return false; };
    metas.extend(market_metas);
    let Ok(expected) = canonical_meta_list(&metas) else { return false; };
    if !market.executable || market.key == program_id
        || *authority.key != Pubkey::find_program_address(
            &[b"silver-market-authority"], market.key).0
        || extra_metas.try_borrow_data().ok().is_none_or(|data| data.as_ref() != expected.as_slice())
        || listing.owner != market.key || listing.data_len() != LISTING_LEN
        || *listing.key != listing_address(market.key, mint)
        || from.amount != 0 || from.delegate != COption::None
        || from.delegated_amount != 0 || to.amount != 1
        || from.mint != *mint || to.mint != *mint
    { return false; }
    let Ok(bytes) = listing.try_borrow_data() else { return false; };
    bytes[0..8] == *MAGIC && bytes[8] == 1 && bytes[9] == 2
        && bytes[10] == if is_ring { 2 } else { 1 }
        && bytes[16..48] == mint.to_bytes()
        && bytes[48..80] == from.owner.to_bytes()
        && bytes[80..112] == source.key.to_bytes()
        && bytes[112..120].iter().any(|value| *value != 0)
        && bytes[120..128].iter().any(|value| *value != 0)
        && bytes[128..160].iter().any(|value| *value != 0)
        && bytes[160..192].iter().any(|value| *value != 0)
        && bytes[192..200].iter().any(|value| *value != 0)
        && bytes[200..232] == to.owner.to_bytes()
        && bytes[232..264] == destination.key.to_bytes()
        && bytes[272..304] == program_id.to_bytes()
}

// Squads governs both Silver and the selected Marketplace program before an
// existing mint's EAM may be migrated. The EAM pins M for that mint.
pub(super) fn migrate_metas(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8])
    -> ProgramResult {
    if data != [25] || accounts.len() != 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [vault, silver_programdata, mint, state, lifecycle, extra,
        market, market_programdata, token_program, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_upgrade_authority(program_id, silver_programdata, vault)?;
    check_upgrade_authority(market.key, market_programdata, vault)?;
    if !market.executable || market.key == program_id || !vault.is_writable
        || !extra.is_writable || *token_program.key != spl_token_2022::id()
        || *system.key != system_program::id() || mint.owner != token_program.key
        || state.owner != program_id || extra.owner != program_id
        || *extra.key != get_extra_account_metas_address_and_bump_seed(mint.key, program_id).0
    { return Err(ProgramError::InvalidAccountData); }
    let is_ring = state.data_len() == RING_STATE_LEN;
    if is_ring {
        if *state.key != Pubkey::find_program_address(
            &[RING_STATE_SEED, mint.key.as_ref()], program_id).0
            || !ring_state_matches(program_id, mint.key, &state.try_borrow_data()?)
        { return Err(ProgramError::InvalidAccountData); }
    } else if state.data_len() != TRANSFER_STATE_LEN
        || *state.key != Pubkey::find_program_address(
            &[STATE_SEED, mint.key.as_ref()], program_id).0
        || *lifecycle.key != Pubkey::find_program_address(
            &[LIFECYCLE_SEED, mint.key.as_ref()], program_id).0
        || lifecycle.owner != program_id
        || !lifecycle_matches(&lifecycle.try_borrow_data()?, mint.key)
    { return Err(ProgramError::InvalidAccountData); }
    let mut metas = if is_ring { vec![ring_state_extra_meta()?] }
        else { vec![state_extra_meta()?, lifecycle_extra_meta()?] };
    if extra.try_borrow_data()?.as_ref() != canonical_meta_list(&metas)?.as_slice() {
        return Err(ProgramError::InvalidAccountData);
    }
    metas.extend(market_metas(market.key, is_ring)?);
    let size = ExtraAccountMetaList::size_of(metas.len())?;
    let rent = Rent::get()?.minimum_balance(size);
    if extra.lamports() < rent {
        invoke(&system_instruction::transfer(vault.key, extra.key, rent - extra.lamports()),
            &[vault.clone(), extra.clone(), system.clone()])?;
    }
    extra.realloc(size, false)?;
    extra.try_borrow_mut_data()?.fill(0);
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut extra.try_borrow_mut_data()?, &metas)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_ephemeral_post_transfer_listing_exempts_cooldown() {
        let silver = Pubkey::new_unique();
        let market = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let seller = Pubkey::new_unique();
        let buyer = Pubkey::new_unique();
        let source_key = Pubkey::new_unique();
        let destination_key = Pubkey::new_unique();
        let authority_key = Pubkey::find_program_address(
            &[b"silver-market-authority"], &market).0;
        let listing_key = listing_address(&market, &mint);
        let extra_key = Pubkey::new_unique();
        let token_program = spl_token_2022::id();
        let loader = bpf_loader_upgradeable::id();
        let mut listing_lamports = 1;
        let mut market_lamports = 1;
        let mut source_lamports = 1;
        let mut destination_lamports = 1;
        let mut authority_lamports = 1;
        let mut extra_lamports = 1;
        let mut listing_data = [0u8; LISTING_LEN];
        let mut empty_market = [];
        let mut empty_source = [];
        let mut empty_destination = [];
        let mut empty_authority = [];
        let mut metas = vec![state_extra_meta().unwrap(), lifecycle_extra_meta().unwrap()];
        metas.extend(market_metas(&market, false).unwrap());
        let mut extra_data = canonical_meta_list(&metas).unwrap();
        listing_data[0..8].copy_from_slice(MAGIC);
        listing_data[8] = 1;
        listing_data[9] = 2;
        listing_data[10] = 1;
        listing_data[16..48].copy_from_slice(mint.as_ref());
        listing_data[48..80].copy_from_slice(seller.as_ref());
        listing_data[80..112].copy_from_slice(source_key.as_ref());
        listing_data[112..120].copy_from_slice(&1u64.to_le_bytes());
        listing_data[120..128].copy_from_slice(&1u64.to_le_bytes());
        listing_data[128..160].copy_from_slice(Pubkey::new_unique().as_ref());
        listing_data[160..192].copy_from_slice(Pubkey::new_unique().as_ref());
        listing_data[192..200].copy_from_slice(&1u64.to_le_bytes());
        listing_data[200..232].copy_from_slice(buyer.as_ref());
        listing_data[232..264].copy_from_slice(destination_key.as_ref());
        listing_data[272..304].copy_from_slice(silver.as_ref());
        let market_info = AccountInfo::new(&market, false, false,
            &mut market_lamports, &mut empty_market, &loader, true, 0);
        let source = AccountInfo::new(&source_key, false, true,
            &mut source_lamports, &mut empty_source, &token_program, false, 0);
        let destination = AccountInfo::new(&destination_key, false, true,
            &mut destination_lamports, &mut empty_destination, &token_program, false, 0);
        let authority = AccountInfo::new(&authority_key, false, false,
            &mut authority_lamports, &mut empty_authority, &silver, false, 0);
        let listing = AccountInfo::new(&listing_key, false, true,
            &mut listing_lamports, &mut listing_data, &market, false, 0);
        let extra = AccountInfo::new(&extra_key, false, false,
            &mut extra_lamports, &mut extra_data, &silver, false, 0);
        let mut from = TokenAccount::default();
        from.owner = seller;
        from.mint = mint;
        let mut to = TokenAccount::default();
        to.owner = buyer;
        to.mint = mint;
        to.amount = 1;
        assert!(market_transfer_authority(&silver, &authority, &source,
            &destination, &mint, &from, &to, Some(&market_info), Some(&listing),
            &extra, false));
        listing.try_borrow_mut_data().unwrap()[9] = 1;
        assert!(!market_transfer_authority(&silver, &authority, &source,
            &destination, &mint, &from, &to, Some(&market_info), Some(&listing),
            &extra, false));
        listing.try_borrow_mut_data().unwrap()[9] = 2;
        to.amount = 0;
        assert!(!market_transfer_authority(&silver, &authority, &source,
            &destination, &mint, &from, &to, Some(&market_info), Some(&listing),
            &extra, false));
    }
}
