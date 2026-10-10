use super::*;

const CONFIG_SEED_MARKET: &[u8] = b"silver-market-config";
const LISTING_SEED: &[u8] = b"silver-market-listing";
const AUTH_SEED: &[u8] = b"silver-market-authority";
const CONFIG_LEN: usize = 137;
const LISTING_LEN: usize = 320;
const MAGIC: &[u8; 8] = b"ERSMKV1\0";
const SQUADS_VAULT: Pubkey = solana_program::pubkey!("4GbtPK23i68P8p86C6XALpBkUPVwbxpMLWVV9FSztNpk");
const ACTIVE: u8 = 1;
const SOLD: u8 = 3;
const CANCELLED: u8 = 4;

fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(bytes.get(offset..offset + 8)
        .ok_or(ProgramError::InvalidAccountData)?.try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?))
}

fn read_key(bytes: &[u8], offset: usize) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(bytes.get(offset..offset + 32)
        .ok_or(ProgramError::InvalidAccountData)?.try_into()
        .map_err(|_| ProgramError::InvalidAccountData)?))
}

fn listing_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[LISTING_SEED, mint.as_ref()], program_id)
}

pub(super) fn listing_address(program_id: &Pubkey, mint: &Pubkey) -> Pubkey {
    listing_pda(program_id, mint).0
}

fn authority_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AUTH_SEED], program_id)
}

fn market_metas(market: &Pubkey, is_ring: bool)
    -> Result<Vec<ExtraAccountMeta>, ProgramError> {
    Ok(vec![
        ExtraAccountMeta::new_with_pubkey(market, false, false)?,
        ExtraAccountMeta::new_external_pda_with_seeds(
            if is_ring { 6 } else { 7 },
            &[Seed::Literal { bytes: LISTING_SEED.to_vec() },
              Seed::AccountKey { index: 1 }], false, true)?,
    ])
}

fn check_config(program_id: &Pubkey, config: &AccountInfo) -> ProgramResult {
    if *config.key != Pubkey::find_program_address(&[CONFIG_SEED_MARKET], program_id).0
        || config.owner != program_id || config.data_len() != CONFIG_LEN
    { return Err(ProgramError::InvalidAccountData); }
    let data = config.try_borrow_data()?;
    if data[0] != 1 || read_key(&data, 1)? != SQUADS_VAULT
        || read_u64(&data, 33)? == 0
        || read_key(&data, 41)? == Pubkey::default()
        || read_key(&data, 73)? == Pubkey::default()
        || read_key(&data, 105)? == Pubkey::default()
    { return Err(ProgramError::InvalidAccountData); }
    Ok(())
}

// Squads Vault must sign through its existing 2-of-3 authority path.
pub(super) fn configure(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 105 || accounts.len() != 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [vault, programdata, config, system] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_upgrade_authority(program_id, programdata, vault)?;
    let version = read_u64(data, 1)?;
    let royalty = read_key(data, 9)?;
    let platform = read_key(data, 41)?;
    let silver = read_key(data, 73)?;
    if !vault.is_signer || !vault.is_writable || !config.is_writable
        || *system.key != system_program::id()
        || *config.key != Pubkey::find_program_address(&[CONFIG_SEED_MARKET], program_id).0
        || version == 0 || royalty == Pubkey::default()
        || platform == Pubkey::default()
        || silver == Pubkey::default() || silver == *program_id
    { return Err(ProgramError::InvalidInstructionData); }
    if config.owner == &system_program::id() && config.data_len() == 0 {
        if version != 1 { return Err(ProgramError::InvalidInstructionData); }
        let bump = Pubkey::find_program_address(&[CONFIG_SEED_MARKET], program_id).1;
        create_pda(config, vault, system, program_id, CONFIG_LEN,
            &[CONFIG_SEED_MARKET, &[bump]])?;
    } else {
        check_config(program_id, config)?;
        if read_u64(&config.try_borrow_data()?, 33)?.checked_add(1) != Some(version)
        { return Err(ProgramError::InvalidInstructionData); }
    }
    let mut bytes = config.try_borrow_mut_data()?;
    bytes[0] = 1;
    bytes[1..33].copy_from_slice(vault.key.as_ref());
    bytes[33..41].copy_from_slice(&version.to_le_bytes());
    bytes[41..73].copy_from_slice(royalty.as_ref());
    bytes[73..105].copy_from_slice(platform.as_ref());
    bytes[105..137].copy_from_slice(silver.as_ref());
    Ok(())
}

fn check_asset(program_id: &Pubkey, silver: &Pubkey, mint: &AccountInfo, state: &AccountInfo,
    lifecycle: &AccountInfo, extra: &AccountInfo) -> Result<bool, ProgramError>
{
    if mint.owner != &spl_token_2022::id() || state.owner != silver
        || extra.owner != silver
        || *extra.key != get_extra_account_metas_address_and_bump_seed(mint.key, silver).0
    { return Err(ProgramError::InvalidAccountData); }
    let mint_data = mint.try_borrow_data()?;
    let token_mint = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if token_mint.base.decimals != 0 || token_mint.base.supply != 1
        || token_mint.base.mint_authority != COption::None
        || token_mint.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(token_mint.get_extension::<TransferHook>()?.program_id)
            != Some(*silver)
        || Option::<Pubkey>::from(token_mint.get_extension::<MetadataPointer>()?.metadata_address)
            != Some(*mint.key)
        || Option::<Pubkey>::from(token_mint.get_extension::<MetadataPointer>()?.authority).is_some()
        || Option::<Pubkey>::from(token_mint.get_extension::<TransferHook>()?.authority).is_some()
        || token_mint.get_extension::<spl_token_2022::extension::permanent_delegate::PermanentDelegate>().is_ok()
    { return Err(ProgramError::InvalidAccountData); }
    let bytes = state.try_borrow_data()?;
    if state.data_len() == RING_STATE_LEN {
        if *state.key != Pubkey::find_program_address(
                &[RING_STATE_SEED, mint.key.as_ref()], silver).0
            || !ring_state_matches(silver, mint.key, &bytes)
            || i64::from_le_bytes(bytes[328..336].try_into().unwrap())
                > Clock::get()?.unix_timestamp
            || {
                let mut metas = vec![ring_state_extra_meta()?];
                metas.extend(market_metas(program_id, true)?);
                extra.try_borrow_data()?.as_ref() != canonical_meta_list(&metas)?.as_slice()
            }
        { return Err(ProgramError::InvalidAccountData); }
        Ok(true)
    } else {
        if state.data_len() != TRANSFER_STATE_LEN || bytes[0..4] != [3, 1, 1, 1]
            || bytes[36..68] != mint.key.to_bytes()
            || Pubkey::find_program_address(
                &[MINT_SEED, &bytes[4..36]], silver).0 != *mint.key
            || bytes[68..100] != Pubkey::find_program_address(
                &[COLLECTION_SEED], silver).0.to_bytes()
            || *state.key != Pubkey::find_program_address(
                &[STATE_SEED, mint.key.as_ref()], silver).0
            || i64::from_le_bytes(bytes[196..204].try_into().unwrap())
                > Clock::get()?.unix_timestamp
            || *lifecycle.key != Pubkey::find_program_address(
                &[LIFECYCLE_SEED, mint.key.as_ref()], silver).0
            || lifecycle.owner != silver
            || !lifecycle_matches(&lifecycle.try_borrow_data()?, mint.key)
            || {
                let mut metas = vec![state_extra_meta()?, lifecycle_extra_meta()?];
                metas.extend(market_metas(program_id, false)?);
                extra.try_borrow_data()?.as_ref() != canonical_meta_list(&metas)?.as_slice()
            }
        { return Err(ProgramError::InvalidAccountData); }
        Ok(false)
    }
}

fn check_listing(program_id: &Pubkey, listing: &AccountInfo, mint: &Pubkey)
    -> Result<u64, ProgramError>
{
    if *listing.key != listing_pda(program_id, mint).0
        || listing.owner != program_id || listing.data_len() != LISTING_LEN
    { return Err(ProgramError::InvalidAccountData); }
    let bytes = listing.try_borrow_data()?;
    if bytes[0..8] != *MAGIC || bytes[8] != 1
        || read_key(&bytes, 16)? != *mint || read_u64(&bytes, 192)? == 0
        || read_key(&bytes, 272)? == Pubkey::default()
        || bytes[304..].iter().any(|value| *value != 0)
    { return Err(ProgramError::InvalidAccountData); }
    read_u64(&bytes, 192)
}

fn fee(price: u64, bps: u128) -> Result<u64, ProgramError> {
    let numerator = u128::from(price).checked_mul(bps)
        .and_then(|n| n.checked_add(9_999)).ok_or(ProgramError::ArithmeticOverflow)?;
    u64::try_from(numerator / 10_000).map_err(|_| ProgramError::ArithmeticOverflow)
}

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

// Seller-authorized LIST upgrades an exact legacy EAM once, atomically. The
// extra four read-only accounts prove both pinned programs remain Vault-governed.
pub(super) fn list(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 17 || accounts.len() != 15 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [seller, config, mint, state, lifecycle, source, listing, authority,
        extra, token_program, system, silver_program, silver_programdata,
        market_program, market_programdata] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let price = read_u64(data, 1)?;
    let nonce = read_u64(data, 9)?;
    if price == 0 || nonce == 0 || !seller.is_signer || !seller.is_writable
        || !source.is_writable || !listing.is_writable || !extra.is_writable
        || *authority.key != authority_pda(program_id).0
        || *token_program.key != spl_token_2022::id()
        || *system.key != system_program::id()
    { return Err(ProgramError::InvalidInstructionData); }
    check_config(program_id, config)?;
    let silver = read_key(&config.try_borrow_data()?, 105)?;
    if *silver_program.key != silver || !silver_program.executable
        || *market_program.key != *program_id || !market_program.executable
    { return Err(ProgramError::InvalidAccountData); }
    governed_program(silver_program, silver_programdata)?;
    governed_program(market_program, market_programdata)?;
    if source.owner != token_program.key { return Err(ProgramError::InvalidAccountData); }
    let source_data = source.try_borrow_data()?;
    let token = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
    if token.base.owner != *seller.key || token.base.mint != *mint.key
        || token.base.amount != 1 || token.base.delegate != COption::None
    { return Err(ProgramError::InvalidAccountData); }
    drop(source_data);
    let (expected, bump) = listing_pda(program_id, mint.key);
    if *listing.key != expected { return Err(ProgramError::InvalidSeeds); }
    let is_ring = state.data_len() == RING_STATE_LEN;
    let legacy = if is_ring { vec![ring_state_extra_meta()?] }
        else { vec![state_extra_meta()?, lifecycle_extra_meta()?] };
    if extra.owner != &silver
        || *extra.key != get_extra_account_metas_address_and_bump_seed(mint.key, &silver).0
    { return Err(ProgramError::InvalidAccountData); }
    let has_legacy_eam = extra.try_borrow_data()?.as_ref()
        == canonical_meta_list(&legacy)?.as_slice();
    if has_legacy_eam {
        if nonce != 1 || listing.owner != &system_program::id()
            || listing.data_len() != 0
        { return Err(ProgramError::InvalidAccountData); }
        let (_, authority_bump) = authority_pda(program_id);
        let metas = [
            AccountMeta::new(*seller.key, true), AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*state.key, false),
            AccountMeta::new_readonly(*lifecycle.key, false),
            AccountMeta::new_readonly(*source.key, false), AccountMeta::new(*extra.key, false),
            AccountMeta::new_readonly(*listing.key, false),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new_readonly(*market_program.key, false),
            AccountMeta::new_readonly(*market_programdata.key, false),
            AccountMeta::new_readonly(*silver_programdata.key, false),
            AccountMeta::new_readonly(*config.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*system.key, false),
        ];
        invoke_signed(&Instruction { program_id: silver, accounts: metas.to_vec(),
            data: vec![26] },
            &[seller.clone(), mint.clone(), state.clone(), lifecycle.clone(), source.clone(),
                extra.clone(), listing.clone(), authority.clone(), market_program.clone(),
                market_programdata.clone(), silver_programdata.clone(), config.clone(),
                token_program.clone(), system.clone(), silver_program.clone()],
            &[&[AUTH_SEED, &[authority_bump]]])?;
    }
    let is_ring = check_asset(program_id, &silver, mint, state, lifecycle, extra)?;
    if listing.owner == &system_program::id() && listing.data_len() == 0 {
        if nonce != 1 { return Err(ProgramError::InvalidInstructionData); }
        create_pda(listing, seller, system, program_id, LISTING_LEN,
            &[LISTING_SEED, mint.key.as_ref(), &[bump]])?;
    } else {
        let prior = check_listing(program_id, listing, mint.key)?;
        let bytes = listing.try_borrow_data()?;
        if !matches!(bytes[9], SOLD | CANCELLED)
            || prior.checked_add(1) != Some(nonce)
        { return Err(ProgramError::InvalidAccountData); }
    }
    invoke(&token_instruction::approve_checked(token_program.key, source.key,
        mint.key, authority.key, seller.key, &[], 1, 0)?,
        &[source.clone(), mint.clone(), authority.clone(), seller.clone(),
            token_program.clone()])?;
    let config_data = config.try_borrow_data()?;
    let mut bytes = listing.try_borrow_mut_data()?;
    bytes.fill(0);
    bytes[0..8].copy_from_slice(MAGIC);
    bytes[8] = 1;
    bytes[9] = ACTIVE;
    bytes[10] = if is_ring { 2 } else { 1 };
    bytes[16..48].copy_from_slice(mint.key.as_ref());
    bytes[48..80].copy_from_slice(seller.key.as_ref());
    bytes[80..112].copy_from_slice(source.key.as_ref());
    bytes[112..120].copy_from_slice(&price.to_le_bytes());
    bytes[120..128].copy_from_slice(&config_data[33..41]);
    bytes[128..160].copy_from_slice(&config_data[41..73]);
    bytes[160..192].copy_from_slice(&config_data[73..105]);
    bytes[192..200].copy_from_slice(&nonce.to_le_bytes());
    bytes[264..272].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    bytes[272..304].copy_from_slice(silver.as_ref());
    Ok(())
}

// A stale source can always be cancelled, but only the seller's still-current
// delegation is revoked. The listing's terminal nonce remains durable.
pub(super) fn cancel(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 9 || accounts.len() != 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [seller, listing, source, token_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !seller.is_signer || !listing.is_writable || !source.is_writable
        || *token_program.key != spl_token_2022::id()
    { return Err(ProgramError::InvalidAccountData); }
    let mint = read_key(&listing.try_borrow_data()?, 16)?;
    let nonce = check_listing(program_id, listing, &mint)?;
    let bytes = listing.try_borrow_data()?;
    if bytes[9] != ACTIVE || nonce != read_u64(data, 1)?
        || read_key(&bytes, 48)? != *seller.key
        || read_key(&bytes, 80)? != *source.key
    { return Err(ProgramError::InvalidAccountData); }
    drop(bytes);
    if source.owner == token_program.key {
        let source_data = source.try_borrow_data()?;
        let token = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
        let still_delegated = token.base.owner == *seller.key
            && token.base.mint == mint
            && token.base.delegate == COption::Some(authority_pda(program_id).0);
        drop(source_data);
        if still_delegated {
            invoke(&token_instruction::revoke(token_program.key, source.key,
                seller.key, &[])?,
                &[source.clone(), seller.clone(), token_program.clone()])?;
        }
    }
    listing.try_borrow_mut_data()?[9] = CANCELLED;
    Ok(())
}

// buyer, seller, royalty, platform, source, destination, mint, state,
// lifecycle-or-system, extra-metas, listing, market-authority, Token-2022,
// System, Marketplace program, Silver Hook program. If buyer ATA does not exist, its idempotent
// creation must precede this instruction in the same signed transaction.
pub(super) fn buy(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 17 || accounts.len() != 16 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let [buyer, seller, royalty, platform, source, destination, mint, state,
        lifecycle, extra, listing, authority, token_program, system,
        market_program, hook_program]
        = accounts else { return Err(ProgramError::NotEnoughAccountKeys); };
    if !buyer.is_signer || !buyer.is_writable || !seller.is_writable
        || !royalty.is_writable || !platform.is_writable || !source.is_writable
        || !destination.is_writable || !state.is_writable || !listing.is_writable
        || *authority.key != authority_pda(program_id).0
        || *market_program.key != *program_id || !market_program.executable
        || *token_program.key != spl_token_2022::id()
        || *system.key != system_program::id()
    { return Err(ProgramError::InvalidAccountData); }
    let nonce = check_listing(program_id, listing, mint.key)?;
    let bytes = listing.try_borrow_data()?;
    let price = read_u64(&bytes, 112)?;
    let is_ring = bytes[10] == 2;
    if bytes[9] != ACTIVE || nonce != read_u64(data, 1)?
        || price == 0 || price != read_u64(data, 9)?
        || read_key(&bytes, 48)? != *seller.key
        || read_key(&bytes, 80)? != *source.key
        || read_key(&bytes, 128)? != *royalty.key
        || read_key(&bytes, 160)? != *platform.key
        || buyer.key == seller.key || royalty.key == seller.key
        || platform.key == seller.key || royalty.key == buyer.key
        || platform.key == buyer.key
    { return Err(ProgramError::InvalidAccountData); }
    let silver = read_key(&bytes, 272)?;
    drop(bytes);
    if *hook_program.key != silver
        || check_asset(program_id, &silver, mint, state, lifecycle, extra)? != is_ring
        || source.owner != token_program.key || destination.owner != token_program.key
        || source.key == destination.key
    { return Err(ProgramError::InvalidAccountData); }
    let source_data = source.try_borrow_data()?;
    let from = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
    let destination_data = destination.try_borrow_data()?;
    let to = StateWithExtensions::<TokenAccount>::unpack(&destination_data)?;
    if from.base.owner != *seller.key || from.base.mint != *mint.key
        || from.base.amount != 1
        || from.base.delegate != COption::Some(*authority.key)
        || from.base.delegated_amount != 1
        || to.base.owner != *buyer.key || to.base.mint != *mint.key
        || to.base.amount != 0
    { return Err(ProgramError::InvalidAccountData); }
    drop(destination_data);
    drop(source_data);
    let royalty_amount = fee(price, 400)?;
    let platform_amount = fee(price, 200)?;
    let total = price.checked_add(royalty_amount)
        .and_then(|value| value.checked_add(platform_amount))
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if buyer.lamports() < total { return Err(ProgramError::InsufficientFunds); }
    {
        let mut bytes = listing.try_borrow_mut_data()?;
        bytes[9] = 2;
        bytes[200..232].copy_from_slice(buyer.key.as_ref());
        bytes[232..264].copy_from_slice(destination.key.as_ref());
    }
    for (recipient, amount) in [
        (seller, price), (royalty, royalty_amount), (platform, platform_amount)
    ] {
        invoke(&system_instruction::transfer(buyer.key, recipient.key, amount),
            &[buyer.clone(), recipient.clone(), system.clone()])?;
    }
    let mut transfer = token_instruction::transfer_checked(token_program.key,
        source.key, mint.key, destination.key, authority.key, &[], 1, 0)?;
    transfer.accounts.extend([
        AccountMeta::new_readonly(*extra.key, false),
        AccountMeta::new(*state.key, false),
    ]);
    let mut infos = vec![source.clone(), mint.clone(), destination.clone(),
        authority.clone(), extra.clone(), state.clone()];
    if !is_ring {
        transfer.accounts.push(AccountMeta::new(*lifecycle.key, false));
        infos.push(lifecycle.clone());
    }
    transfer.accounts.push(AccountMeta::new_readonly(*market_program.key, false));
    infos.push(market_program.clone());
    transfer.accounts.push(AccountMeta::new(*listing.key, false));
    infos.push(listing.clone());
    transfer.accounts.push(AccountMeta::new_readonly(*hook_program.key, false));
    infos.push(hook_program.clone());
    infos.push(token_program.clone());
    let (_, bump) = authority_pda(program_id);
    invoke_signed(&transfer, &infos, &[&[AUTH_SEED, &[bump]]])?;
    listing.try_borrow_mut_data()?[9] = SOLD;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_lamport_arithmetic() {
        assert_eq!(fee(1, 400), Ok(1));
        assert_eq!(fee(1, 200), Ok(1));
        assert_eq!(fee(100_000_000_000, 400), Ok(4_000_000_000));
        assert_eq!(fee(100_000_000_000, 200), Ok(2_000_000_000));
        assert!(u64::MAX.checked_add(fee(u64::MAX, 400).unwrap()).is_none());
    }
}
