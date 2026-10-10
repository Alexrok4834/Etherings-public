use solana_program::{
    account_info::{next_account_info, AccountInfo},
    bpf_loader_upgradeable::{self, UpgradeableLoaderState},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    hash::{hashv, Hasher},
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_option::COption,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions::{load_current_index_checked, load_instruction_at_checked}, Sysvar},
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
use spl_associated_token_account::get_associated_token_address_with_program_id;
use spl_transfer_hook_interface::{
    get_extra_account_metas_address_and_bump_seed,
    instruction::{ExecuteInstruction, TransferHookInstruction},
};
use spl_tlv_account_resolution::{account::ExtraAccountMeta, seeds::Seed, state::ExtraAccountMetaList};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
mod marketplace_hook;

#[cfg(all(feature = "alpha-opening-candidate", feature = "disposable-orao-cpi-proof"))]
compile_error!("alpha-opening-candidate cannot include disposable-orao-cpi-proof");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const STATE_LEN: usize = 188;
pub const TRANSFER_STATE_LEN: usize = STATE_LEN + 16;
const DIRECT_TRANSFER_COOLDOWN_SECONDS: i64 = 48 * 60 * 60;
const CONFIG_V1_LEN: usize = 65;
const CONFIG_V2_LEN: usize = 145;
const COLLECTION_LEN: usize = 66;
const DESIGN_HEADER_LEN: usize = 104;
const MAX_DESIGNS: usize = 42;
const MAX_URI_BYTES: usize = 200;
const MAX_ENTRY_BYTES: usize = 38 + MAX_URI_BYTES;
const DESIGN_MAGIC: &[u8; 8] = b"ERSDSV1\0";
const DESIGN_DOMAIN: &[u8; 30] = b"ETHERINGS_SILVER_DESIGN_SET_V1";
const LIFECYCLE_LEN: usize = 128;
const LIFECYCLE_MAGIC: &[u8; 8] = b"ERSBLV1\0";
const LIFECYCLE_VERSION: u8 = 1;
const LIFECYCLE_PHASE_SEALED: u8 = 0;
pub const MINT_SEED: &[u8] = b"silver-mint";
pub const STATE_SEED: &[u8] = b"silver-state";
const AUTHORITY_SEED: &[u8] = b"silver-authority";
pub const COLLECTION_SEED: &[u8] = b"silver-collection";
const CONFIG_SEED: &[u8] = b"silver-config";
const DESIGN_SEED: &[u8] = b"silver-design-set";
pub const LIFECYCLE_SEED: &[u8] = b"silver-lifecycle";
const OPEN_SEED: &[u8] = b"silver-open";
const ESCROW_SEED: &[u8] = b"silver-escrow";
const SERIES_SEED: &[u8] = b"silver-nft-series";
const SERIES_MAGIC: &[u8; 8] = b"ERSERV1\0";
const SERIES_LEN: usize = 24;
const SERIES_BOX: u8 = 1;
const SERIES_RING: u8 = 2;
const SERIES_SILVER: u8 = 1;
const SERIES_MARKER: &str = "ETHERINGS_NFT_V1";
const ORAO_REQUEST_SEED: &[u8] = b"orao-vrf-randomness-request";
const ORAO_CONFIG_SEED: &[u8] = b"orao-vrf-network-configuration";
const ORAO_CLASSIC_PROGRAM: Pubkey = solana_program::pubkey!("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const COMPUTE_BUDGET_PROGRAM: Pubkey = solana_program::pubkey!("ComputeBudget111111111111111111111111111111");
const BEGIN_OPEN_PREPARE: u8 = 12;
const BEGIN_OPEN_COMMIT: u8 = 13;
const FINALIZE_PREFLIGHT: u8 = 14;
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const FINALIZE_OPEN: u8 = 15;
const OPEN_OPERATION_LEN: usize = 320;
const OPEN_OPERATION_MAGIC: &[u8; 8] = b"ERSOPV1\0";
const LIFECYCLE_PHASE_OPENING: u8 = 1;
const ORAO_RANDOMNESS_DOMAIN: &[u8; 36] = b"ETHERINGS_ORAO_CLASSIC_RANDOMNESS_V1";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
pub const RING_STATE_SEED: &[u8] = b"silver-ring-state";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const RING_MINT_SEED: &[u8] = b"silver-ring-mint";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const RING_STATE_MAGIC: &[u8; 8] = b"ERSRGV1\0";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
pub const RING_STATE_LEN: usize = 576;
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_LEVEL_UP: u8 = 16;
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_PAID_LEVEL_UP: u8 = 18;
const DRAW_BOX_ISSUE: u8 = 19;
const BREED_BOX_ISSUE: u8 = 20;
const ADMIN_BOX_ISSUE: u8 = 21;
const BREEDING_GATEWAY_PROGRAM: Pubkey = solana_program::pubkey!("Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF");
const BREEDING_GATEWAY_ISSUER_SEED: &[u8] = b"cooper-breeding-issuer";
const BREEDING_BOX_TOKEN_SEED: &[u8] = b"silver-breeding-box-token";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const ERU_GATEWAY_PROGRAM: Pubkey = solana_program::pubkey!("Fd3D2dS7RhCwNY4zBag1nDLyZ9ZRsLiKoDnJJu5WnXvF");
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_PAID_GATEWAY_SEED: &[u8] = b"silver-paid-gateway";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_ALLOCATE_POINTS: u8 = 17;
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_PROGRESS_SEED: &[u8] = b"silver-progress";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_PROGRESS_MAGIC: &[u8; 8] = b"ERSPRV1\0";
#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
const SILVER_PROGRESS_LEN: usize = 128;

struct BeginOpenTxKeys {
    user: Pubkey,
    mint: Pubkey,
    user_box: Pubkey,
    escrow_box: Pubkey,
    state: Pubkey,
    lifecycle: Pubkey,
    extra_metas: Pubkey,
    operation: Pubkey,
    config: Pubkey,
    design: Pubkey,
    collection: Pubkey,
    network: Pubkey,
    treasury: Pubkey,
    request: Pubkey,
    orao: Pubkey,
    token_program: Pubkey,
    instructions_sysvar: Pubkey,
    system: Pubkey,
    market_program: Option<Pubkey>,
    listing: Option<Pubkey>,
}

fn validate_begin_open_tx_graph(
    program_id: &Pubkey,
    instructions: &[Instruction],
    prepare_index: usize,
    keys: &BeginOpenTxKeys,
) -> ProgramResult {
    if prepare_index.checked_add(3) != Some(instructions.len())
        || instructions[..prepare_index].iter().any(|ix| ix.program_id != COMPUTE_BUDGET_PROGRAM)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let prepare = &instructions[prepare_index];
    let transfer = &instructions[prepare_index + 1];
    let commit = &instructions[prepare_index + 2];
    if prepare.program_id != *program_id
        || prepare.data.len() != 33
        || prepare.data[0] != BEGIN_OPEN_PREPARE
        || prepare.data[1..].iter().all(|byte| *byte == 0)
        || commit.program_id != *program_id
        || commit.data.len() != 33
        || commit.data[0] != BEGIN_OPEN_COMMIT
        || commit.data[1..] != prepare.data[1..]
        || commit.accounts != prepare.accounts
        || prepare.accounts.len() != if keys.listing.is_some() { 20 } else { 18 }
        || keys.listing.is_some() != keys.market_program.is_some()
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut required = vec![
        AccountMeta::new(keys.user, true),
        AccountMeta::new_readonly(keys.mint, false),
        AccountMeta::new(keys.user_box, false),
        AccountMeta::new(keys.escrow_box, false),
        AccountMeta::new(keys.state, false),
        AccountMeta::new(keys.lifecycle, false),
        AccountMeta::new_readonly(keys.extra_metas, false),
        AccountMeta::new(keys.operation, false),
        AccountMeta::new_readonly(keys.config, false),
        AccountMeta::new_readonly(keys.design, false),
        AccountMeta::new_readonly(keys.collection, false),
        AccountMeta::new(keys.network, false),
        AccountMeta::new(keys.treasury, false),
        AccountMeta::new(keys.request, false),
        AccountMeta::new_readonly(keys.orao, false),
        AccountMeta::new_readonly(keys.token_program, false),
        AccountMeta::new_readonly(keys.instructions_sysvar, false),
        AccountMeta::new_readonly(keys.system, false),
    ];
    if let Some(market) = keys.market_program {
        required.push(AccountMeta::new_readonly(market, false));
    }
    if let Some(listing) = keys.listing {
        required.push(AccountMeta::new(listing, false));
    }
    if prepare.accounts != required {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut expected_transfer = token_instruction::transfer_checked(
        &spl_token_2022::id(), &keys.user_box, &keys.mint,
        &keys.escrow_box, &keys.user, &[], 1, 0,
    )?;
    // Instructions Sysvar exposes the message-wide writable privilege.
    expected_transfer.accounts[3] = AccountMeta::new(keys.user, true);
    expected_transfer.accounts.extend([
        AccountMeta::new_readonly(keys.extra_metas, false),
        AccountMeta::new(keys.state, false),
        AccountMeta::new(keys.lifecycle, false),
    ]);
    if let Some(market) = keys.market_program {
        expected_transfer.accounts.push(AccountMeta::new_readonly(market, false));
    }
    if let Some(listing) = keys.listing {
        expected_transfer.accounts.push(AccountMeta::new(listing, false));
    }
    expected_transfer.accounts.push(AccountMeta::new_readonly(*program_id, false));
    if transfer.program_id != expected_transfer.program_id
        || transfer.data != expected_transfer.data
        || transfer.accounts != expected_transfer.accounts
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn validate_begin_open_tx_sysvar(
    program_id: &Pubkey,
    instructions_sysvar: &AccountInfo,
    keys: &BeginOpenTxKeys,
    commit: bool,
) -> ProgramResult {
    let current = usize::from(load_current_index_checked(instructions_sysvar)?);
    let prepare_index = if commit { current.checked_sub(2).ok_or(ProgramError::InvalidInstructionData)? } else { current };
    let mut instructions = Vec::with_capacity(prepare_index + 3);
    for index in 0..prepare_index + 3 {
        instructions.push(load_instruction_at_checked(index, instructions_sysvar)?);
    }
    if load_instruction_at_checked(prepare_index + 3, instructions_sysvar).is_ok() {
        return Err(ProgramError::InvalidInstructionData);
    }
    validate_begin_open_tx_graph(program_id, &instructions, prepare_index, keys)
}

struct BeginOpenPreflight<'a> {
    config_key: &'a Pubkey,
    config_owner: &'a Pubkey,
    config: &'a [u8],
    design_key: &'a Pubkey,
    design_owner: &'a Pubkey,
    design: &'a [u8],
    mint: &'a Pubkey,
    state_key: &'a Pubkey,
    state_owner: &'a Pubkey,
    state: &'a [u8],
    lifecycle_key: &'a Pubkey,
    lifecycle_owner: &'a Pubkey,
    lifecycle: &'a [u8],
    user: &'a Pubkey,
    user_signed: bool,
    token_owner: &'a Pubkey,
    token_amount: u64,
    now: i64,
    seed: &'a [u8; 32],
    orao_program: &'a Pubkey,
    orao_executable: bool,
    network_key: &'a Pubkey,
    network_owner: &'a Pubkey,
    request_key: &'a Pubkey,
    request_owner: &'a Pubkey,
    request_data_len: usize,
    operation_key: &'a Pubkey,
    operation_owner: &'a Pubkey,
    operation_data_len: usize,
}

struct BeginOpenBinding {
    owner: Pubkey,
    box_mint: Pubkey,
    operation_number: u64,
    request: Pubkey,
    seed: [u8; 32],
    design_version: u64,
    design_count: u16,
    design_commitment: [u8; 32],
}

// Read-only first slice: no ORAO request, escrow transfer, or lifecycle write may precede these checks.
fn validate_begin_open_preflight(
    program_id: &Pubkey,
    input: &BeginOpenPreflight<'_>,
) -> Result<BeginOpenBinding, ProgramError> {
    if input.config_key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0
        || input.config_owner != program_id
        || input.config.len() != CONFIG_V2_LEN
        || input.config[0] != 2
        || input.config[1..33].iter().all(|byte| *byte == 0)
        || input.design_owner != program_id
        || input.config[73..105] != input.design_key.to_bytes()
        || input.user == &Pubkey::default()
        || !input.user_signed
        || input.token_owner != input.user
        || input.token_amount != 1
        || input.seed.iter().all(|byte| *byte == 0)
        || input.orao_program != &ORAO_CLASSIC_PROGRAM
        || !input.orao_executable
        || input.network_key != &Pubkey::find_program_address(
            &[ORAO_CONFIG_SEED], &ORAO_CLASSIC_PROGRAM,
        ).0
        || input.network_owner != &ORAO_CLASSIC_PROGRAM
        || input.request_owner != &system_program::id()
        || input.request_data_len != 0
        || input.operation_owner != &system_program::id()
        || input.operation_data_len != 0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let authority = Pubkey::new_from_array(input.config[1..33].try_into().unwrap());
    let (commitment, version, count) = parse_design_set(
        program_id, input.design_key, input.design, &authority, true,
    )?;
    if input.config[105..113] != version.to_le_bytes()
        || input.config[113..145] != commitment
        || input.state.len() != TRANSFER_STATE_LEN
        || input.state_owner != program_id
        || input.state[0..4] != [3, 1, 1, 1]
        || input.state[36..68] != input.mint.to_bytes()
        || input.state[68..100]
            != Pubkey::find_program_address(&[COLLECTION_SEED], program_id).0.to_bytes()
        || input.mint
            != &Pubkey::find_program_address(&[MINT_SEED, &input.state[4..36]], program_id).0
        || input.state_key
            != &Pubkey::find_program_address(&[STATE_SEED, input.mint.as_ref()], program_id).0
        || input.lifecycle_key
            != &Pubkey::find_program_address(&[LIFECYCLE_SEED, input.mint.as_ref()], program_id).0
        || input.lifecycle_owner != program_id
        || !lifecycle_matches(input.lifecycle, input.mint)
        || input.now < i64::from_le_bytes(input.state[196..204].try_into().unwrap())
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let operation_number = le_u64(&input.lifecycle[48..56])?;
    if input.operation_key != &Pubkey::find_program_address(
        &[OPEN_SEED, input.mint.as_ref(), &operation_number.to_le_bytes()], program_id,
    ).0 || input.request_key != &Pubkey::find_program_address(
        &[ORAO_REQUEST_SEED, input.seed], &ORAO_CLASSIC_PROGRAM,
    ).0 {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(BeginOpenBinding {
        owner: *input.user,
        box_mint: *input.mint,
        operation_number,
        request: *input.request_key,
        seed: *input.seed,
        design_version: version,
        design_count: count,
        design_commitment: commitment,
    })
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn normalize_orao_randomness(
    orao_program: &Pubkey,
    request: &Pubkey,
    seed: &[u8; 32],
    fulfilled: &[u8; 64],
) -> [u8; 32] {
    hashv(&[
        ORAO_RANDOMNESS_DOMAIN,
        orao_program.as_ref(),
        request.as_ref(),
        seed,
        fulfilled,
    ]).to_bytes()
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
#[derive(Debug, PartialEq, Eq)]
struct SilverOutcome {
    attributes: [u8; 4],
    visual_index: u16,
    design_id: u32,
    content_hash: [u8; 32],
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn sample_silver_field(
    randomness: &[u8; 32],
    box_mint: &Pubkey,
    field_tag: &[u8],
    range: u32,
) -> Result<u32, ProgramError> {
    if field_tag.is_empty() || range == 0 {
        return Err(ProgramError::InvalidArgument);
    }
    let mut counter = 0u32;
    loop {
        let digest = hashv(&[
            b"ETHERINGS_SILVER_V1",
            randomness,
            box_mint.as_ref(),
            field_tag,
            &counter.to_le_bytes(),
        ]).to_bytes();
        let candidate = u32::from_le_bytes(digest[..4].try_into().unwrap());
        if let Some(value) = reduce_silver_sample(candidate, range) {
            return Ok(value);
        }
        counter = counter.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    }
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn reduce_silver_sample(candidate: u32, range: u32) -> Option<u32> {
    if range == 0 {
        return None;
    }
    let limit = ((1u64 << 32) / u64::from(range)) * u64::from(range);
    (u64::from(candidate) < limit).then_some(candidate % range)
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn derive_silver_outcome(
    randomness: &[u8; 32],
    box_mint: &Pubkey,
    design: &[u8],
    count: u16,
) -> Result<SilverOutcome, ProgramError> {
    if count == 0 || usize::from(count) > MAX_DESIGNS || design.len() < DESIGN_HEADER_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut attributes = [0u8; 4];
    for (value, tag) in attributes.iter_mut().zip([
        b"comfort".as_slice(), b"charm", b"quality", b"luck",
    ]) {
        *value = 10 + sample_silver_field(randomness, box_mint, tag, 21)? as u8;
    }
    let visual_index = sample_silver_field(randomness, box_mint, b"visual", u32::from(count))? as u16;
    let mut cursor = DESIGN_HEADER_LEN;
    for index in 0..count {
        let header_end = cursor.checked_add(6).ok_or(ProgramError::ArithmeticOverflow)?;
        if header_end > design.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        let design_id = le_u32(&design[cursor..cursor + 4])?;
        let uri_len = usize::from(le_u16(&design[cursor + 4..header_end])?);
        let entry_end = header_end.checked_add(uri_len)
            .and_then(|end| end.checked_add(32))
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if design_id == 0 || uri_len == 0 || uri_len > MAX_URI_BYTES || entry_end > design.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        if index == visual_index {
            return Ok(SilverOutcome {
                attributes,
                visual_index,
                design_id,
                content_hash: design[entry_end - 32..entry_end].try_into().unwrap(),
            });
        }
        cursor = entry_end;
    }
    Err(ProgramError::InvalidAccountData)
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn selected_design_uri(design: &[u8], index: u16) -> Result<String, ProgramError> {
    let mut cursor = DESIGN_HEADER_LEN;
    for current in 0..=index {
        let header_end = cursor.checked_add(6).ok_or(ProgramError::ArithmeticOverflow)?;
        if header_end > design.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        let uri_len = usize::from(le_u16(&design[cursor + 4..header_end])?);
        let end = header_end.checked_add(uri_len)
            .and_then(|value| value.checked_add(32))
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if uri_len < 8 || uri_len > MAX_URI_BYTES || end > design.len() {
            return Err(ProgramError::InvalidAccountData);
        }
        if current == index {
            let uri = std::str::from_utf8(&design[header_end..header_end + uri_len])
                .map_err(|_| ProgramError::InvalidAccountData)?;
            if !uri.starts_with("ipfs://") || !uri.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
                return Err(ProgramError::InvalidAccountData);
            }
            return Ok(uri.to_string());
        }
        cursor = end;
    }
    Err(ProgramError::InvalidAccountData)
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn validate_fulfilled_request(
    request: &Pubkey,
    seed: &[u8; 32],
    beneficiary: &Pubkey,
    randomness: &orao_solana_vrf::state::RandomnessV2,
) -> Result<[u8; 32], ProgramError> {
    if randomness.seed() != seed || randomness.client() != beneficiary {
        return Err(ProgramError::InvalidAccountData);
    }
    let fulfilled = randomness.fulfilled().ok_or(ProgramError::InvalidAccountData)?;
    Ok(normalize_orao_randomness(
        &ORAO_CLASSIC_PROGRAM, request, seed, &fulfilled.randomness,
    ))
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn validate_finalize_operation(
    program_id: &Pubkey,
    mint: &Pubkey,
    operation_key: &Pubkey,
    operation: &[u8],
    lifecycle: &[u8],
) -> Result<(Pubkey, Pubkey, [u8; 32]), ProgramError> {
    if operation.len() != OPEN_OPERATION_LEN || lifecycle.len() != LIFECYCLE_LEN
        || operation[0..8] != *OPEN_OPERATION_MAGIC
        || operation[8] != 1 || operation[9] != LIFECYCLE_PHASE_OPENING
        || operation[10..16].iter().any(|byte| *byte != 0)
        || operation[24..56] != mint.to_bytes()
        || operation[56..88].iter().all(|byte| *byte == 0)
        || operation[88..120].iter().all(|byte| *byte == 0)
        || operation[120..152].iter().all(|byte| *byte == 0)
        || operation[152..184].iter().all(|byte| *byte == 0)
        || operation[258..266].iter().all(|byte| *byte == 0)
        || operation[266..306].iter().any(|byte| *byte != 0)
        || operation[306] != 1 || operation[307..].iter().any(|byte| *byte != 0)
        || lifecycle[0..8] != *LIFECYCLE_MAGIC
        || lifecycle[8] != LIFECYCLE_VERSION
        || lifecycle[9] != LIFECYCLE_PHASE_OPENING
        || lifecycle[10..16].iter().any(|byte| *byte != 0)
        || lifecycle[16..48] != mint.to_bytes()
        || lifecycle[56..88] != operation_key.to_bytes()
        || lifecycle[88..120].iter().any(|byte| *byte != 0)
        || lifecycle[120..128].iter().all(|byte| *byte == 0)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let operation_number = le_u64(&operation[16..24])?;
    if operation_number == 0
        || *operation_key != Pubkey::find_program_address(
            &[OPEN_SEED, mint.as_ref(), &operation_number.to_le_bytes()], program_id,
        ).0
        || le_u64(&lifecycle[48..56])?
            != operation_number.checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let owner = Pubkey::new_from_array(operation[56..88].try_into().unwrap());
    let request = Pubkey::new_from_array(operation[120..152].try_into().unwrap());
    let seed = operation[152..184].try_into().unwrap();
    Ok((owner, request, seed))
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn finalize_readonly_preflight(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data != [FINALIZE_PREFLIGHT] || accounts.len() != 11 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let keeper = &accounts[0];
    let mint = &accounts[1];
    let state = &accounts[2];
    let lifecycle = &accounts[3];
    let operation = &accounts[4];
    let escrow = &accounts[5];
    let config = &accounts[6];
    let design = &accounts[7];
    let request = &accounts[8];
    let orao = &accounts[9];
    let token_program = &accounts[10];
    if !keeper.is_signer || keeper.key == &Pubkey::default()
        || *orao.key != ORAO_CLASSIC_PROGRAM || !orao.executable
        || *token_program.key != spl_token_2022::id()
        || operation.owner != program_id || lifecycle.owner != program_id
        || state.owner != program_id || config.owner != program_id
        || design.owner != program_id || request.owner != &ORAO_CLASSIC_PROGRAM
        || mint.owner != token_program.key || escrow.owner != token_program.key
        || *config.key != Pubkey::find_program_address(&[CONFIG_SEED], program_id).0
        || *state.key != Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id).0
        || *lifecycle.key != Pubkey::find_program_address(&[LIFECYCLE_SEED, mint.key.as_ref()], program_id).0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let operation_data = operation.try_borrow_data()?;
    let lifecycle_data = lifecycle.try_borrow_data()?;
    let (beneficiary, bound_request, seed) = validate_finalize_operation(
        program_id, mint.key, operation.key, &operation_data, &lifecycle_data,
    )?;
    let escrow_authority = Pubkey::find_program_address(
        &[ESCROW_SEED, mint.key.as_ref()], program_id,
    ).0;
    if *escrow.key != get_associated_token_address_with_program_id(
        &escrow_authority, mint.key, token_program.key,
    ) || operation_data[88..120] != escrow.key.to_bytes()
        || *request.key != bound_request
        || *request.key != Pubkey::find_program_address(
            &[ORAO_REQUEST_SEED, &seed], &ORAO_CLASSIC_PROGRAM,
        ).0
        || operation_data[184..216] != design.key.to_bytes()
    {
        return Err(ProgramError::InvalidSeeds);
    }
    let config_data = config.try_borrow_data()?;
    let design_data = design.try_borrow_data()?;
    if config_data.len() != CONFIG_V2_LEN || config_data[0] != 2
        || config_data[1..33].iter().all(|byte| *byte == 0)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let authority = Pubkey::new_from_array(config_data[1..33].try_into().unwrap());
    let (commitment, version, count) = parse_design_set(
        program_id, design.key, &design_data, &authority, true,
    )?;
    if operation_data[216..224] != version.to_le_bytes()
        || operation_data[224..226] != count.to_le_bytes()
        || operation_data[226..258] != commitment
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state_data = state.try_borrow_data()?;
    if state_data.len() != TRANSFER_STATE_LEN
        || state_data[0..4] != [3, 1, 1, 1]
        || state_data[36..68] != mint.key.to_bytes()
        || state_data[68..100] != Pubkey::find_program_address(
            &[COLLECTION_SEED], program_id,
        ).0.to_bytes()
        || *mint.key != Pubkey::find_program_address(
            &[MINT_SEED, &state_data[4..36]], program_id,
        ).0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint_data = mint.try_borrow_data()?;
    let token_mint = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if token_mint.base.supply != 1 || token_mint.base.decimals != 0
        || token_mint.base.mint_authority != COption::None
        || token_mint.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(token_mint.get_extension::<TransferHook>()?.program_id)
            != Some(*program_id)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let escrow_data = escrow.try_borrow_data()?;
    let escrow_token = StateWithExtensions::<TokenAccount>::unpack(&escrow_data)?;
    if escrow_token.base.mint != *mint.key || escrow_token.base.owner != escrow_authority
        || escrow_token.base.amount != 1
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let request_data = request.try_borrow_data()?;
    let randomness = orao_solana_vrf::state::RandomnessV2::try_deserialize(
        &mut request_data.as_ref(),
    ).map_err(|_| ProgramError::InvalidAccountData)?;
    if randomness.fulfilled().is_none() {
        solana_program::msg!("finalize-preflight: request pending");
        return Err(ProgramError::InvalidAccountData);
    }
    let normalized = validate_fulfilled_request(request.key, &seed, &beneficiary, &randomness)?;
    let _outcome = derive_silver_outcome(&normalized, mint.key, &design_data, count)?;
    solana_program::program::set_return_data(&normalized);
    Ok(())
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn finalize_open(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data != [FINALIZE_OPEN] || accounts.len() != 22 {
        return Err(ProgramError::InvalidInstructionData);
    }
    finalize_readonly_preflight(program_id, &accounts[..11], &[FINALIZE_PREFLIGHT])?;
    let keeper = &accounts[0];
    let box_mint = &accounts[1];
    let lifecycle = &accounts[3];
    let operation = &accounts[4];
    let escrow = &accounts[5];
    let config = &accounts[6];
    let design = &accounts[7];
    let request = &accounts[8];
    let token_program = &accounts[10];
    let escrow_authority = &accounts[11];
    let ring_mint = &accounts[12];
    let ring_token = &accounts[13];
    let ring_state = &accounts[14];
    let ring_metas = &accounts[15];
    let beneficiary = &accounts[16];
    let mint_authority = &accounts[17];
    let system = &accounts[18];
    let ata_program = &accounts[19];
    let collection = &accounts[20];
    let series = &accounts[21];
    let (expected_escrow_authority, escrow_bump) = Pubkey::find_program_address(
        &[ESCROW_SEED, box_mint.key.as_ref()], program_id,
    );
    let (expected_mint_authority, authority_bump) = Pubkey::find_program_address(
        &[AUTHORITY_SEED], program_id,
    );
    let (expected_ring_mint, ring_bump) = Pubkey::find_program_address(
        &[RING_MINT_SEED, box_mint.key.as_ref(), operation.key.as_ref()], program_id,
    );
    let (expected_ring_state, ring_state_bump) = Pubkey::find_program_address(
        &[RING_STATE_SEED, ring_mint.key.as_ref()], program_id,
    );
    let (expected_metas, metas_bump) = get_extra_account_metas_address_and_bump_seed(
        ring_mint.key, program_id,
    );
    if !keeper.is_signer || !keeper.is_writable
        || !box_mint.is_writable || !escrow.is_writable
        || !lifecycle.is_writable || !operation.is_writable
        || !ring_mint.is_writable || !ring_token.is_writable
        || !ring_state.is_writable || !ring_metas.is_writable
        || *escrow_authority.key != expected_escrow_authority
        || *mint_authority.key != expected_mint_authority
        || *ring_mint.key != expected_ring_mint
        || *ring_state.key != expected_ring_state
        || *ring_metas.key != expected_metas
        || *ring_token.key != get_associated_token_address_with_program_id(
            beneficiary.key, ring_mint.key, token_program.key,
        )
        || *ata_program.key != spl_associated_token_account::id()
        || *system.key != system_program::id()
        || beneficiary.key.as_ref() != &operation.try_borrow_data()?[56..88]
    {
        return Err(ProgramError::InvalidAccountData);
    }
    check_collection(program_id, config, collection)?;
    let (normalized, outcome, uri, commit_slot) = {
        let op = operation.try_borrow_data()?;
        let seed: [u8; 32] = op[152..184].try_into().unwrap();
        let commit_slot = le_u64(&op[258..266])?;
        let request_data = request.try_borrow_data()?;
        let randomness = orao_solana_vrf::state::RandomnessV2::try_deserialize(
            &mut request_data.as_ref(),
        ).map_err(|_| ProgramError::InvalidAccountData)?;
        let normalized = validate_fulfilled_request(request.key, &seed, beneficiary.key, &randomness)?;
        let design_data = design.try_borrow_data()?;
        let count = le_u16(&op[224..226])?;
        let outcome = derive_silver_outcome(&normalized, box_mint.key, &design_data, count)?;
        let uri = selected_design_uri(&design_data, outcome.visual_index)?;
        (normalized, outcome, uri, commit_slot)
    };
    let clock = Clock::get()?;
    if commit_slot == 0 || clock.slot < commit_slot {
        return Err(ProgramError::InvalidAccountData);
    }
    let ring_mint_seeds: &[&[u8]] = &[
        RING_MINT_SEED, box_mint.key.as_ref(), operation.key.as_ref(), &[ring_bump],
    ];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, box_mint.key.as_ref(), &[escrow_bump]];
    let serial = assign_serial(program_id, series, keeper, system, SERIES_RING)?;
    let mint_space = ExtensionType::try_calculate_account_len::<Mint>(&[
        ExtensionType::MetadataPointer, ExtensionType::TransferHook,
    ])?;
    create_pda(ring_mint, keeper, system, token_program.key, mint_space, ring_mint_seeds)?;
    let metadata_rent = Rent::get()?.minimum_balance(
        mint_space.checked_add(768).ok_or(ProgramError::ArithmeticOverflow)?,
    );
    if ring_mint.lamports() < metadata_rent {
        invoke(&system_instruction::transfer(
            keeper.key, ring_mint.key, metadata_rent - ring_mint.lamports(),
        ), &[keeper.clone(), ring_mint.clone(), system.clone()])?;
    }
    invoke(&spl_token_2022::extension::metadata_pointer::instruction::initialize(
        token_program.key, ring_mint.key, None, Some(*ring_mint.key),
    )?, &[ring_mint.clone(), token_program.clone()])?;
    invoke(&spl_token_2022::extension::transfer_hook::instruction::initialize(
        token_program.key, ring_mint.key, None, Some(*program_id),
    )?, &[ring_mint.clone(), token_program.clone()])?;
    invoke(&token_instruction::initialize_mint2(
        token_program.key, ring_mint.key, mint_authority.key, None, 0,
    )?, &[ring_mint.clone(), token_program.clone()])?;
    invoke_signed(&metadata_instruction::initialize(
        token_program.key, ring_mint.key, mint_authority.key, ring_mint.key,
        mint_authority.key, "EtheRings Silver Ring".to_string(),
        "ESRG".to_string(), uri.clone(),
    ), &[ring_mint.clone(), mint_authority.clone(), token_program.clone()],
        &[authority_seeds])?;
    for (key, value) in [
        ("kind", "SILVER_RING".to_string()),
        ("rarity", "SILVER".to_string()),
        ("series", SERIES_MARKER.to_string()),
        ("serial", serial.to_string()),
        ("collection", collection.key.to_string()),
        ("design_id", outcome.design_id.to_string()),
        ("content_hash", hex(&outcome.content_hash)),
    ] {
        invoke_signed(&metadata_instruction::update_field(
            token_program.key, ring_mint.key, mint_authority.key,
            Field::Key(key.to_string()), value,
        ), &[ring_mint.clone(), mint_authority.clone(), token_program.clone()],
            &[authority_seeds])?;
    }
    let ata_ix = spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        keeper.key, beneficiary.key, ring_mint.key, token_program.key,
    );
    invoke(&ata_ix, &[
        keeper.clone(), ring_token.clone(), beneficiary.clone(), ring_mint.clone(),
        system.clone(), token_program.clone(), ata_program.clone(),
    ])?;
    let token_data = ring_token.try_borrow_data()?;
    let token = StateWithExtensions::<TokenAccount>::unpack(&token_data)?;
    if token.base.mint != *ring_mint.key || token.base.owner != *beneficiary.key
        || token.base.amount != 0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(token_data);
    create_pda(ring_state, keeper, system, program_id, RING_STATE_LEN,
        &[RING_STATE_SEED, ring_mint.key.as_ref(), &[ring_state_bump]])?;
    {
        let mut state = ring_state.try_borrow_mut_data()?;
        state.fill(0);
        state[0..8].copy_from_slice(RING_STATE_MAGIC);
        state[8] = 1;
        state[9] = 2;
        state[16..48].copy_from_slice(ring_mint.key.as_ref());
        state[48..80].copy_from_slice(box_mint.key.as_ref());
        state[80..112].copy_from_slice(operation.key.as_ref());
        state[112..144].copy_from_slice(beneficiary.key.as_ref());
        state[144..176].copy_from_slice(collection.key.as_ref());
        state[176..208].copy_from_slice(request.key.as_ref());
        state[208..240].copy_from_slice(&operation.try_borrow_data()?[226..258]);
        state[240..248].copy_from_slice(&operation.try_borrow_data()?[216..224]);
        state[248..250].copy_from_slice(&outcome.visual_index.to_le_bytes());
        state[250..254].copy_from_slice(&outcome.design_id.to_le_bytes());
        state[254..286].copy_from_slice(&outcome.content_hash);
        state[286..290].copy_from_slice(&outcome.attributes);
        state[290] = 1;
        state[291] = 100;
        state[296] = 1;
        state[297..299].copy_from_slice(&operation.try_borrow_data()?[224..226]);
        state[304..312].copy_from_slice(&commit_slot.to_le_bytes());
        state[312..320].copy_from_slice(&clock.slot.to_le_bytes());
        state[336..338].copy_from_slice(&(uri.len() as u16).to_le_bytes());
        state[338..338 + uri.len()].copy_from_slice(uri.as_bytes());
        state[544..576].copy_from_slice(&normalized);
        if !ring_state_matches(program_id, ring_mint.key, &state) {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let extra = [ring_state_extra_meta()?];
    create_pda(ring_metas, keeper, system, program_id,
        ExtraAccountMetaList::size_of(extra.len())?,
        &[b"extra-account-metas", ring_mint.key.as_ref(), &[metas_bump]])?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ring_metas.try_borrow_mut_data()?, &extra,
    )?;
    invoke_signed(&token_instruction::burn_checked(
        token_program.key, escrow.key, box_mint.key, escrow_authority.key, &[], 1, 0,
    )?, &[escrow.clone(), box_mint.clone(), escrow_authority.clone(), token_program.clone()],
        &[escrow_seeds])?;
    invoke_signed(&token_instruction::mint_to_checked(
        token_program.key, ring_mint.key, ring_token.key, mint_authority.key, &[], 1, 0,
    )?, &[ring_mint.clone(), ring_token.clone(), mint_authority.clone(), token_program.clone()],
        &[authority_seeds])?;
    invoke_signed(&token_instruction::set_authority(
        token_program.key, ring_mint.key, None, AuthorityType::MintTokens,
        mint_authority.key, &[],
    )?, &[ring_mint.clone(), mint_authority.clone(), token_program.clone()],
        &[authority_seeds])?;
    {
        let mut op = operation.try_borrow_mut_data()?;
        op[9] = 2;
        op[266..298].copy_from_slice(ring_mint.key.as_ref());
        op[298..306].copy_from_slice(&clock.slot.to_le_bytes());
    }
    {
        let mut life = lifecycle.try_borrow_mut_data()?;
        life[9] = 2;
        life[88..120].copy_from_slice(ring_mint.key.as_ref());
    }
    Ok(())
}

fn le_u16(bytes: &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u32(bytes: &[u8]) -> Result<u32, ProgramError> {
    Ok(u32::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

fn le_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes.try_into().map_err(|_| ProgramError::InvalidAccountData)?,
    ))
}

pub fn state_extra_meta() -> Result<ExtraAccountMeta, ProgramError> {
    ExtraAccountMeta::new_with_seeds(
        &[Seed::Literal { bytes: STATE_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
        false, true,
    )
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
pub fn ring_state_extra_meta() -> Result<ExtraAccountMeta, ProgramError> {
    ExtraAccountMeta::new_with_seeds(
        &[Seed::Literal { bytes: RING_STATE_SEED.to_vec() }, Seed::AccountKey { index: 1 }],
        false, true,
    )
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn ring_progression_matches(state: &[u8]) -> bool {
    let level = state[290];
    if !(1..=20).contains(&level) || state[291] != 100
        || state[300..304].iter().any(|byte| *byte != 0)
    {
        return false;
    }
    let earned = 6u32 * u32::from(level - 1);
    let unspent = u32::from_le_bytes(state[292..296].try_into().unwrap());
    let initial_total = u32::from(state[299]);
    let attributes = &state[286..290];
    let current_total = attributes.iter().map(|value| u32::from(*value)).sum::<u32>() + unspent;
    unspent <= earned
        && attributes.iter().all(|value| (10..=30 + earned).contains(&u32::from(*value)))
        && if level == 1 {
            initial_total == 0 && (40..=120).contains(&current_total)
        } else {
            (40..=120).contains(&initial_total) && current_total == initial_total + earned
        }
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
pub fn ring_state_matches(program_id: &Pubkey, mint: &Pubkey, state: &[u8]) -> bool {
    if state.len() != RING_STATE_LEN || state[0..8] != *RING_STATE_MAGIC
        || state[8] != 1 || state[9] != 2
        || state[10..16].iter().any(|byte| *byte != 0)
        || state[16..48] != mint.to_bytes()
        || state[48..80].iter().all(|byte| *byte == 0)
        || state[80..112].iter().all(|byte| *byte == 0)
        || state[112..144].iter().all(|byte| *byte == 0)
        || state[144..176] != Pubkey::find_program_address(&[COLLECTION_SEED], program_id).0.to_bytes()
        || state[176..208].iter().all(|byte| *byte == 0)
        || state[208..240].iter().all(|byte| *byte == 0)
        || le_u64(&state[240..248]).unwrap_or(0) == 0
        || le_u16(&state[297..299]).unwrap_or(0) == 0
        || le_u16(&state[297..299]).unwrap_or(u16::MAX) > MAX_DESIGNS as u16
        || le_u16(&state[248..250]).unwrap_or(u16::MAX)
            >= le_u16(&state[297..299]).unwrap_or(0)
        || le_u32(&state[250..254]).unwrap_or(0) == 0
        || state[254..286].iter().all(|byte| *byte == 0)
        || !ring_progression_matches(state)
        || state[296] != 1
        || le_u64(&state[304..312]).unwrap_or(0) == 0
        || le_u64(&state[312..320]).unwrap_or(0) < le_u64(&state[304..312]).unwrap_or(u64::MAX)
        || state[538..544].iter().any(|byte| *byte != 0)
    {
        return false;
    }
    let box_mint = &state[48..80];
    let operation = &state[80..112];
    if *mint != Pubkey::find_program_address(&[RING_MINT_SEED, box_mint, operation], program_id).0 {
        return false;
    }
    let uri_len = usize::from(le_u16(&state[336..338]).unwrap_or(0));
    uri_len >= 8 && uri_len <= MAX_URI_BYTES
        && state[338..338 + uri_len].starts_with(b"ipfs://")
        && state[338..338 + uri_len].iter().all(|byte| (0x21..=0x7e).contains(byte))
        && state[338 + uri_len..538].iter().all(|byte| *byte == 0)
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn check_owned_ring(program_id: &Pubkey, user: &AccountInfo, mint: &AccountInfo,
    ring: &AccountInfo, token: &AccountInfo) -> ProgramResult {
    if !user.is_signer || ring.owner != program_id || !ring.is_writable
        || ring.key != &Pubkey::find_program_address(
            &[RING_STATE_SEED, mint.key.as_ref()], program_id).0
        || mint.owner != &spl_token_2022::id()
        || token.owner != &spl_token_2022::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let mint_bytes = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_bytes)?;
    if mint_state.base.supply != 1 || mint_state.base.decimals != 0
        || mint_state.base.mint_authority != COption::None
        || mint_state.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(mint_state.get_extension::<TransferHook>()?.program_id)
            != Some(*program_id)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let token_bytes = token.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccount>::unpack(&token_bytes)?;
    if token_state.base.mint != *mint.key || token_state.base.owner != *user.key
        || token_state.base.amount != 1
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let state = ring.try_borrow_data()?;
    if !ring_state_matches(program_id, mint.key, &state)
        || i64::from_le_bytes(state[328..336].try_into().unwrap()) > Clock::get()?.unix_timestamp
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn apply_silver_level_up(state: &mut [u8], expected: u8, target: u8, ert: u64) -> ProgramResult {
    if !(1..20).contains(&expected) || target != expected + 1
        || state[290] != expected
        || ert != 5 * (u64::from(target) + 1)
        || !ring_progression_matches(state)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let unspent = u32::from_le_bytes(state[292..296].try_into().unwrap());
    let next = unspent.checked_add(6).ok_or(ProgramError::ArithmeticOverflow)?;
    if expected == 1 {
        state[299] = state[286..290].iter().copied().sum();
    }
    state[290] = target;
    state[292..296].copy_from_slice(&next.to_le_bytes());
    if !ring_progression_matches(state) { return Err(ProgramError::InvalidAccountData); }
    Ok(())
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn silver_level_up(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], paid: bool) -> ProgramResult {
    // The attested instruction binds the database operation, its ERT reservation,
    // and Alpha account separately from the wallet signature and Ring mint.
    if data.len() != (if paid { 83 } else { 59 })
        || accounts.len() != (if paid { 20 } else { 8 })
        || paid != matches!(data[2], 5 | 20)
        || [3..19, 19..35, 35..51].iter()
            .any(|range| data[range.clone()].iter().all(|byte| *byte == 0))
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let user = &accounts[0];
    let issuer = &accounts[1];
    let config = &accounts[2];
    let mint = &accounts[3];
    let ring = &accounts[4];
    let token = &accounts[5];
    let replay = &accounts[6];
    let system = &accounts[7];
    if !user.is_writable || !issuer.is_signer || config.owner != program_id
        || config.key != &Pubkey::find_program_address(&[CONFIG_SEED], program_id).0
        || config.data_len() != CONFIG_V2_LEN
    {
        return Err(ProgramError::InvalidAccountData);
    }
    {
        let bytes = config.try_borrow_data()?;
        if bytes[0] != 2 || bytes[33..65] != issuer.key.to_bytes() {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    check_owned_ring(program_id, user, mint, ring, token)?;
    let ert = u64::from_le_bytes(data[51..59].try_into().unwrap());
    let (expected_replay, bump) = Pubkey::find_program_address(
        &[SILVER_PROGRESS_SEED, mint.key.as_ref(), &data[3..19]], program_id);
    if replay.key != &expected_replay { return Err(ProgramError::InvalidSeeds); }
    if replay.owner != &system_program::id() || replay.data_len() != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    {
        let mut preview = ring.try_borrow_data()?.to_vec();
        apply_silver_level_up(&mut preview, data[1], data[2], ert)?;
    }
    if paid {
        let gateway = &accounts[8];
        let gateway_config = &accounts[9];
        let source = &accounts[10];
        let eru_mint = &accounts[11];
        let treasury = &accounts[12];
        let meta = &accounts[13];
        let instructions = &accounts[14];
        let token_program = &accounts[15];
        let hook = &accounts[16];
        let gateway_nonce = &accounts[17];
        let gateway_operation = &accounts[18];
        let authority = &accounts[19];
        let (expected_authority, authority_bump) = Pubkey::find_program_address(
            &[SILVER_PAID_GATEWAY_SEED], program_id);
        if gateway.key != &ERU_GATEWAY_PROGRAM || !gateway.executable
            || authority.key != &expected_authority || issuer.key == user.key
        {
            return Err(ProgramError::InvalidAccountData);
        }
        let principal: u64 = if data[2] == 5 { 38_000_000_000 } else { 75_000_000_000 };
        let mut gateway_data = Vec::with_capacity(124);
        gateway_data.push(4);
        gateway_data.extend_from_slice(&principal.to_le_bytes());
        gateway_data.extend_from_slice(&data[59..75]); // nonce and expiry slot
        // Gateway operation layout: principal, nonce, expiry, operation,
        // reservation, canonical Silver mint, account, levels, ERT, auth, epoch.
        gateway_data.extend_from_slice(&data[3..35]);
        gateway_data.extend_from_slice(mint.key.as_ref());
        gateway_data.extend_from_slice(&data[35..51]);
        gateway_data.extend_from_slice(&data[1..3]);
        gateway_data.extend_from_slice(&data[51..59]);
        gateway_data.push(1);
        gateway_data.extend_from_slice(&data[75..83]);
        if gateway_data.len() != 124 { return Err(ProgramError::InvalidInstructionData); }
        let gateway_accounts = [
            AccountMeta::new(*source.key, false), AccountMeta::new(*eru_mint.key, false),
            AccountMeta::new(*treasury.key, false), AccountMeta::new(*treasury.key, false),
            AccountMeta::new_readonly(*user.key, true),
            AccountMeta::new_readonly(*issuer.key, true),
            AccountMeta::new(*gateway_config.key, false),
            AccountMeta::new_readonly(*meta.key, false),
            AccountMeta::new_readonly(*instructions.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
            AccountMeta::new_readonly(*hook.key, false),
            AccountMeta::new(*gateway_nonce.key, false),
            AccountMeta::new(*user.key, true),
            AccountMeta::new_readonly(*system.key, false),
            AccountMeta::new(*gateway_operation.key, false),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new_readonly(*config.key, false),
        ];
        invoke_signed(&Instruction {
            program_id: *gateway.key, accounts: gateway_accounts.to_vec(),
            data: gateway_data,
        }, &[
            source.clone(), eru_mint.clone(), treasury.clone(), user.clone(),
            issuer.clone(), gateway_config.clone(), meta.clone(), instructions.clone(),
            token_program.clone(), hook.clone(), gateway_nonce.clone(), system.clone(),
            gateway_operation.clone(), authority.clone(), config.clone(), gateway.clone(),
        ], &[&[SILVER_PAID_GATEWAY_SEED, &[authority_bump]]])?;
    }
    create_pda(replay, user, system, program_id, SILVER_PROGRESS_LEN,
        &[SILVER_PROGRESS_SEED, mint.key.as_ref(), &data[3..19], &[bump]])?;
    {
        let mut bytes = replay.try_borrow_mut_data()?;
        bytes.fill(0);
        bytes[0..8].copy_from_slice(SILVER_PROGRESS_MAGIC);
        bytes[8] = data[1];
        bytes[9] = data[2];
        bytes[16..48].copy_from_slice(mint.key.as_ref());
        bytes[48..80].copy_from_slice(user.key.as_ref());
        bytes[80..96].copy_from_slice(&data[3..19]);
        bytes[96..112].copy_from_slice(&data[19..35]);
        bytes[112..128].copy_from_slice(&data[35..51]);
    }
    apply_silver_level_up(&mut ring.try_borrow_mut_data()?, data[1], data[2], ert)
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn apply_silver_allocation(state: &mut [u8], data: &[u8]) -> ProgramResult {
    if data.len() != 14 || state[290] != data[1]
        || state[292..296] != data[2..6]
        || state[286..290] != data[6..10]
        || !ring_progression_matches(state)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let spend = data[10..14].iter().map(|value| u32::from(*value)).sum::<u32>();
    let unspent = u32::from_le_bytes(state[292..296].try_into().unwrap());
    if spend == 0 || spend > unspent {
        return Err(ProgramError::InvalidInstructionData);
    }
    for index in 0..4 {
        state[286 + index] = state[286 + index].checked_add(data[10 + index])
            .ok_or(ProgramError::ArithmeticOverflow)?;
    }
    state[292..296].copy_from_slice(&(unspent - spend).to_le_bytes());
    if !ring_progression_matches(state) { return Err(ProgramError::InvalidAccountData); }
    Ok(())
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn silver_allocate_points(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 14 || accounts.len() != 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    check_owned_ring(program_id, &accounts[0], &accounts[1], &accounts[2], &accounts[3])?;
    apply_silver_allocation(&mut accounts[2].try_borrow_mut_data()?, data)
}

pub fn lifecycle_extra_meta() -> Result<ExtraAccountMeta, ProgramError> {
    ExtraAccountMeta::new_with_seeds(
        &[
            Seed::Literal { bytes: LIFECYCLE_SEED.to_vec() },
            Seed::AccountKey { index: 1 },
        ],
        false,
        true,
    )
}

pub fn canonical_meta_list(extra: &[ExtraAccountMeta]) -> Result<Vec<u8>, ProgramError> {
    let mut bytes = vec![0; ExtraAccountMetaList::size_of(extra.len())?];
    ExtraAccountMetaList::init::<ExecuteInstruction>(&mut bytes, extra)?;
    Ok(bytes)
}

pub fn lifecycle_matches(data: &[u8], mint: &Pubkey) -> bool {
    data.len() == LIFECYCLE_LEN
        && &data[0..8] == LIFECYCLE_MAGIC
        && data[8] == LIFECYCLE_VERSION
        && data[9] == LIFECYCLE_PHASE_SEALED
        && data[10..16].iter().all(|byte| *byte == 0)
        && data[16..48] == mint.to_bytes()
        && u64::from_le_bytes(data[48..56].try_into().unwrap()) > 0
        && u64::from_le_bytes(data[48..56].try_into().unwrap()) < u64::MAX
        && data[56..120].iter().all(|byte| *byte == 0)
        && data[120..128].iter().any(|byte| *byte != 0)
}

fn migrate_box_lifecycle_v1(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data != [11] || accounts.len() != 10 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let collection = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let token_account = next_account_info(iter)?;
    let extra_metas = next_account_info(iter)?;
    let lifecycle = next_account_info(iter)?;
    let system = next_account_info(iter)?;

    check_upgrade_authority(program_id, programdata, vault)?;
    check_config_v2_authority(program_id, config, vault)?;
    check_collection(program_id, config, collection)?;
    if !vault.is_writable
        || mint.owner != &spl_token_2022::id()
        || state.owner != program_id
        || state.data_len() != TRANSFER_STATE_LEN
        || token_account.owner != &spl_token_2022::id()
        || !lifecycle.is_writable
        || extra_metas.owner != program_id
        || !extra_metas.is_writable
        || system.key != &system_program::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let expected_state = Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id).0;
    let (expected_lifecycle, lifecycle_bump) =
        Pubkey::find_program_address(&[LIFECYCLE_SEED, mint.key.as_ref()], program_id);
    let (expected_metas, metas_bump) =
        get_extra_account_metas_address_and_bump_seed(mint.key, program_id);
    if state.key != &expected_state
        || lifecycle.key != &expected_lifecycle
        || extra_metas.key != &expected_metas
    {
        return Err(ProgramError::InvalidSeeds);
    }
    {
        let bytes = state.try_borrow_data()?;
        if bytes[0] != 3
            || bytes[1] != 1
            || bytes[2] != 1
            || bytes[3] != 1
            || bytes[36..68] != mint.key.to_bytes()
            || bytes[68..100] != collection.key.to_bytes()
            || Pubkey::find_program_address(&[MINT_SEED, &bytes[4..36]], program_id).0 != *mint.key
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    let pointer = mint_state.get_extension::<MetadataPointer>()?;
    let hook = mint_state.get_extension::<TransferHook>()?;
    if mint_state.base.decimals != 0
        || mint_state.base.supply != 1
        || mint_state.base.mint_authority != COption::None
        || mint_state.base.freeze_authority != COption::None
        || Option::<Pubkey>::from(pointer.metadata_address) != Some(*mint.key)
        || Option::<Pubkey>::from(pointer.authority).is_some()
        || Option::<Pubkey>::from(hook.program_id) != Some(*program_id)
        || Option::<Pubkey>::from(hook.authority).is_some()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(mint_data);
    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccount>::unpack(&token_data)?;
    if token_state.base.mint != *mint.key || token_state.base.amount != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(token_data);

    let old_extra = [state_extra_meta()?];
    let new_extra = [state_extra_meta()?, lifecycle_extra_meta()?];
    let new_meta_bytes = canonical_meta_list(&new_extra)?;
    if lifecycle.owner == program_id {
        if !lifecycle_matches(&lifecycle.try_borrow_data()?, mint.key)
            || extra_metas.try_borrow_data()?.as_ref() != new_meta_bytes.as_slice()
        {
            return Err(ProgramError::InvalidAccountData);
        }
        return Ok(());
    }
    if lifecycle.owner != &system_program::id()
        || lifecycle.data_len() != 0
        || extra_metas.try_borrow_data()?.as_ref() != canonical_meta_list(&old_extra)?.as_slice()
    {
        return Err(ProgramError::InvalidAccountData);
    }

    extra_metas.realloc(0, false)?;
    extra_metas.assign(&system_program::id());
    create_pda(
        extra_metas,
        vault,
        system,
        program_id,
        new_meta_bytes.len(),
        &[b"extra-account-metas", mint.key.as_ref(), &[metas_bump]],
    )?;
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut extra_metas.try_borrow_mut_data()?,
        &new_extra,
    )?;
    create_pda(
        lifecycle,
        vault,
        system,
        program_id,
        LIFECYCLE_LEN,
        &[LIFECYCLE_SEED, mint.key.as_ref(), &[lifecycle_bump]],
    )?;
    {
        let mut bytes = lifecycle.try_borrow_mut_data()?;
        bytes.fill(0);
        bytes[0..8].copy_from_slice(LIFECYCLE_MAGIC);
        bytes[8] = LIFECYCLE_VERSION;
        bytes[9] = LIFECYCLE_PHASE_SEALED;
        bytes[16..48].copy_from_slice(mint.key.as_ref());
        bytes[48..56].copy_from_slice(&1u64.to_le_bytes());
        bytes[120..128].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    }
    Ok(())
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

fn market_delegate_allowed(program_id: &Pubkey, authority: &AccountInfo,
    source: &AccountInfo, destination: &AccountInfo, mint: &Pubkey,
    from: &TokenAccount, to: &TokenAccount, market: Option<&AccountInfo>,
    listing: Option<&AccountInfo>, extra: &AccountInfo, is_ring: bool) -> bool {
    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    { marketplace_hook::market_transfer_authority(program_id, authority, source, destination,
        mint, from, to, market, listing, extra, is_ring) }
    #[cfg(not(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof"))))]
    { let _ = (program_id, authority, source, destination, mint, from, to,
        market, listing, extra, is_ring); false }
}

fn execute_transfer(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 16 || !matches!(accounts.len(), 6 | 7 | 8 | 9) {
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
    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    let (market, listing) = if state.data_len() == RING_STATE_LEN && accounts.len() == 8 {
        (accounts.get(6), accounts.get(7))
    } else if state.data_len() == TRANSFER_STATE_LEN && accounts.len() == 9 {
        (accounts.get(7), accounts.get(8))
    } else { (None, None) };
    #[cfg(not(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof"))))]
    let (market, listing): (Option<&AccountInfo>, Option<&AccountInfo>) = (None, None);
    if source_token.base.mint != *mint.key || destination_token.base.mint != *mint.key
        || (source_token.base.owner != *authority.key
            && !market_delegate_allowed(program_id, authority, source, destination,
                mint.key, &source_token.base, &destination_token.base,
                market, listing, extra_metas, state.data_len() == RING_STATE_LEN))
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
    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    if state.data_len() == RING_STATE_LEN {
        if !matches!(accounts.len(), 6 | 8)
            || *state.key != Pubkey::find_program_address(
                &[RING_STATE_SEED, mint.key.as_ref()], program_id,
            ).0
            || !marketplace_hook::meta_list_matches(extra_metas, market, true)?
            || mint_state.base.mint_authority != COption::None
            || mint_state.base.freeze_authority != COption::None
            || Option::<Pubkey>::from(mint_state.get_extension::<MetadataPointer>()?.metadata_address)
                != Some(*mint.key)
            || Option::<Pubkey>::from(mint_state.get_extension::<MetadataPointer>()?.authority).is_some()
            || Option::<Pubkey>::from(mint_state.get_extension::<TransferHook>()?.authority).is_some()
        {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut ring = state.try_borrow_mut_data()?;
        if !ring_state_matches(program_id, mint.key, &ring) {
            return Err(ProgramError::InvalidAccountData);
        }
        if source_token.base.owner == *authority.key {
            let clock = Clock::get()?;
            ring[320..328].copy_from_slice(&clock.slot.to_le_bytes());
            ring[328..336].copy_from_slice(&clock.unix_timestamp
                .checked_add(DIRECT_TRANSFER_COOLDOWN_SECONDS)
                .ok_or(ProgramError::ArithmeticOverflow)?.to_le_bytes());
        }
        return Ok(());
    }
    let (expected_state, _) = Pubkey::find_program_address(&[STATE_SEED, mint.key.as_ref()], program_id);
    if state.key != &expected_state || state.data_len() != TRANSFER_STATE_LEN
        || !marketplace_hook::meta_list_matches(extra_metas, market, false)? {
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
    if let Some(lifecycle) = accounts.get(6) {
        let expected = Pubkey::find_program_address(
            &[LIFECYCLE_SEED, mint.key.as_ref()], program_id,
        ).0;
        if lifecycle.key != &expected
            || lifecycle.owner != program_id
            || !lifecycle.is_writable
            || !lifecycle_matches(&lifecycle.try_borrow_data()?, mint.key)
        {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    if source_token.base.owner == *authority.key {
        let clock = Clock::get()?;
        let until = clock.unix_timestamp.checked_add(DIRECT_TRANSFER_COOLDOWN_SECONDS)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        bytes[STATE_LEN..STATE_LEN + 8].copy_from_slice(&clock.slot.to_le_bytes());
        bytes[STATE_LEN + 8..TRANSFER_STATE_LEN].copy_from_slice(&until.to_le_bytes());
    }
    Ok(())
}

fn collection_matches(data: &[u8], vault: &Pubkey, config: &Pubkey) -> bool {
    data.len() == COLLECTION_LEN
        && data[0] == 1
        && data[1..33] == vault.to_bytes()
        && data[33..65] == config.to_bytes()
        && data[65] == 1
}

fn config_layout_matches(data: &[u8]) -> bool {
    matches!((data.first(), data.len()), (Some(1), CONFIG_V1_LEN) | (Some(2), CONFIG_V2_LEN))
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
    if !config_layout_matches(&config_data)
        || !collection_matches(&collection_data, &Pubkey::new_from_array(
            config_data[1..33].try_into().unwrap()), config.key)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

fn migrate_config_v2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data != [6] || accounts.len() != 4 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let vault = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, vault)?;
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config
        || config.owner != program_id
        || config.data_len() != CONFIG_V1_LEN
        || !vault.is_writable
        || !config.is_writable
        || system.key != &system_program::id()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    {
        let bytes = config.try_borrow_data()?;
        if bytes[0] != 1 || bytes[1..33] != vault.key.to_bytes() {
            return Err(ProgramError::InvalidAccountData);
        }
    }
    let rent = Rent::get()?.minimum_balance(CONFIG_V2_LEN);
    if config.lamports() < rent {
        invoke(
            &system_instruction::transfer(vault.key, config.key, rent - config.lamports()),
            &[vault.clone(), config.clone(), system.clone()],
        )?;
    }
    config.realloc(CONFIG_V2_LEN, false)?;
    let mut bytes = config.try_borrow_mut_data()?;
    bytes[0] = 2;
    bytes[CONFIG_V1_LEN..CONFIG_V2_LEN].fill(0);
    bytes[65..73].copy_from_slice(&1u64.to_le_bytes());
    Ok(())
}

fn config_v2_authority(program_id: &Pubkey, config: &AccountInfo) -> Result<Pubkey, ProgramError> {
    let expected = Pubkey::find_program_address(&[CONFIG_SEED], program_id).0;
    if config.key != &expected || config.owner != program_id || config.data_len() != CONFIG_V2_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let data = config.try_borrow_data()?;
    if data[0] != 2 {
        return Err(ProgramError::InvalidAccountData);
    }
    let authority = Pubkey::new_from_array(
        data[1..33]
            .try_into()
            .map_err(|_| ProgramError::InvalidAccountData)?,
    );
    if authority == Pubkey::default() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(authority)
}

fn check_config_v2_authority(
    program_id: &Pubkey,
    config: &AccountInfo,
    authority: &AccountInfo,
) -> ProgramResult {
    if !authority.is_signer || config_v2_authority(program_id, config)? != *authority.key {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}

fn parse_design_set(
    program_id: &Pubkey,
    design_key: &Pubkey,
    data: &[u8],
    expected_authority: &Pubkey,
    require_frozen: bool,
) -> Result<([u8; 32], u64, u16), ProgramError> {
    if data.len() < DESIGN_HEADER_LEN || &data[0..8] != DESIGN_MAGIC || data[8] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    if (require_frozen && data[9] != 1) || (!require_frozen && data[9] > 1) {
        return Err(ProgramError::InvalidAccountData);
    }
    let capacity = le_u16(&data[10..12])? as usize;
    let count = le_u16(&data[12..14])?;
    let used = le_u16(&data[14..16])? as usize;
    let version = le_u64(&data[16..24])?;
    if version == 0
        || capacity == 0
        || capacity > MAX_DESIGNS
        || count as usize > capacity
        || used > capacity * MAX_ENTRY_BYTES
        || data.len() != DESIGN_HEADER_LEN + capacity * MAX_ENTRY_BYTES
        || data[24..56] != expected_authority.to_bytes()
        || Pubkey::find_program_address(&[DESIGN_SEED, &version.to_le_bytes()], program_id).0
            != *design_key
    {
        return Err(ProgramError::InvalidAccountData);
    }
    if (data[9] == 0
        && (data[56..88].iter().any(|byte| *byte != 0)
            || data[96..104].iter().any(|byte| *byte != 0)))
        || (data[9] == 1
            && (data[56..88].iter().all(|byte| *byte == 0)
                || data[96..104].iter().all(|byte| *byte == 0)))
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let end = DESIGN_HEADER_LEN
        .checked_add(used)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    if end > data.len() || data[end..].iter().any(|byte| *byte != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut hasher = Hasher::default();
    hasher.hash(DESIGN_DOMAIN);
    hasher.hash(program_id.as_ref());
    hasher.hash(design_key.as_ref());
    hasher.hash(&version.to_le_bytes());
    hasher.hash(&count.to_le_bytes());
    let mut cursor = DESIGN_HEADER_LEN;
    let mut previous = 0u32;
    for _ in 0..count {
        if cursor + 38 > end {
            return Err(ProgramError::InvalidAccountData);
        }
        let id = le_u32(&data[cursor..cursor + 4])?;
        let uri_len = le_u16(&data[cursor + 4..cursor + 6])? as usize;
        let entry_end = cursor
            .checked_add(38 + uri_len)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        if id == 0
            || id <= previous
            || uri_len == 0
            || uri_len > MAX_URI_BYTES
            || entry_end > end
            || !data[cursor + 6..cursor + 6 + uri_len]
                .iter()
                .all(|byte| (0x21..=0x7e).contains(byte))
            || data[entry_end - 32..entry_end]
                .iter()
                .all(|byte| *byte == 0)
        {
            return Err(ProgramError::InvalidAccountData);
        }
        hasher.hash(&data[cursor..entry_end]);
        cursor = entry_end;
        previous = id;
    }
    let commitment = hasher.result().to_bytes();
    if cursor != end
        || (require_frozen && count == 0)
        || (data[9] == 1 && data[56..88] != commitment)
    {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok((commitment, version, count))
}

fn create_design_set(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != 11 || accounts.len() != 5 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let programdata = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    let system = next_account_info(iter)?;
    check_upgrade_authority(program_id, programdata, authority)?;
    check_config_v2_authority(program_id, config, authority)?;
    let version = le_u64(&data[1..9])?;
    let capacity = le_u16(&data[9..11])? as usize;
    let next_version = le_u64(&config.try_borrow_data()?[65..73])?;
    let version_bytes = version.to_le_bytes();
    let (expected, bump) = Pubkey::find_program_address(&[DESIGN_SEED, &version_bytes], program_id);
    if version == 0
        || version != next_version
        || capacity == 0
        || capacity > MAX_DESIGNS
        || design.key != &expected
        || !authority.is_writable
        || !config.is_writable
        || !design.is_writable
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    create_pda(
        design,
        authority,
        system,
        program_id,
        DESIGN_HEADER_LEN + capacity * MAX_ENTRY_BYTES,
        &[DESIGN_SEED, &version_bytes, &[bump]],
    )?;
    {
        let mut bytes = design.try_borrow_mut_data()?;
        bytes[0..8].copy_from_slice(DESIGN_MAGIC);
        bytes[8] = 1;
        bytes[10..12].copy_from_slice(&(capacity as u16).to_le_bytes());
        bytes[16..24].copy_from_slice(&version.to_le_bytes());
        bytes[24..56].copy_from_slice(authority.key.as_ref());
        bytes[88..96].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    }
    config.try_borrow_mut_data()?[65..73].copy_from_slice(
        &version
            .checked_add(1)
            .ok_or(ProgramError::ArithmeticOverflow)?
            .to_le_bytes(),
    );
    Ok(())
}

fn append_design(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() < 39 || accounts.len() != 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config_v2_authority(program_id, config, authority)?;
    if design.owner != program_id || !design.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let id = le_u32(&data[1..5])?;
    let uri_len = le_u16(&data[5..7])? as usize;
    if uri_len == 0
        || uri_len > MAX_URI_BYTES
        || data.len() != 7 + uri_len + 32
        || id == 0
        || !data[7..7 + uri_len]
            .iter()
            .all(|byte| (0x21..=0x7e).contains(byte))
        || data[7 + uri_len..].iter().all(|byte| *byte == 0)
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let expected_authority = config_v2_authority(program_id, config)?;
    let mut bytes = design.try_borrow_mut_data()?;
    parse_design_set(program_id, design.key, &bytes, &expected_authority, false)?;
    if bytes[9] != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let capacity = le_u16(&bytes[10..12])?;
    let count = le_u16(&bytes[12..14])?;
    let used = le_u16(&bytes[14..16])? as usize;
    if count >= capacity {
        return Err(ProgramError::AccountDataTooSmall);
    }
    if count > 0 {
        let mut cursor = DESIGN_HEADER_LEN;
        let mut last = 0u32;
        for _ in 0..count {
            last = le_u32(&bytes[cursor..cursor + 4])?;
            cursor += 38 + le_u16(&bytes[cursor + 4..cursor + 6])? as usize;
        }
        if id <= last {
            return Err(ProgramError::InvalidInstructionData);
        }
    }
    let start = DESIGN_HEADER_LEN + used;
    let end = start + 38 + uri_len;
    if end > bytes.len() {
        return Err(ProgramError::AccountDataTooSmall);
    }
    bytes[start..start + 4].copy_from_slice(&id.to_le_bytes());
    bytes[start + 4..start + 6].copy_from_slice(&(uri_len as u16).to_le_bytes());
    bytes[start + 6..start + 6 + uri_len].copy_from_slice(&data[7..7 + uri_len]);
    bytes[start + 6 + uri_len..end].copy_from_slice(&data[7 + uri_len..]);
    bytes[12..14].copy_from_slice(&(count + 1).to_le_bytes());
    bytes[14..16].copy_from_slice(&((used + 38 + uri_len) as u16).to_le_bytes());
    Ok(())
}

fn freeze_design_set(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data != [9] || accounts.len() != 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config_v2_authority(program_id, config, authority)?;
    if design.owner != program_id || !design.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_authority = config_v2_authority(program_id, config)?;
    let commitment = {
        let bytes = design.try_borrow_data()?;
        if bytes[9] != 0 {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        parse_design_set(program_id, design.key, &bytes, &expected_authority, false)?.0
    };
    let mut bytes = design.try_borrow_mut_data()?;
    if le_u16(&bytes[12..14])? == 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    bytes[9] = 1;
    bytes[56..88].copy_from_slice(&commitment);
    bytes[96..104].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    Ok(())
}

fn activate_design_set(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data != [10] || accounts.len() != 3 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let config = next_account_info(iter)?;
    let design = next_account_info(iter)?;
    check_config_v2_authority(program_id, config, authority)?;
    if design.owner != program_id || !config.is_writable {
        return Err(ProgramError::IllegalOwner);
    }
    let expected_authority = config_v2_authority(program_id, config)?;
    let (commitment, version, _) = {
        let bytes = design.try_borrow_data()?;
        parse_design_set(program_id, design.key, &bytes, &expected_authority, true)?
    };
    let mut bytes = config.try_borrow_mut_data()?;
    bytes[73..105].copy_from_slice(design.key.as_ref());
    bytes[105..113].copy_from_slice(&version.to_le_bytes());
    bytes[113..145].copy_from_slice(&commitment);
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

fn next_series_serial(bytes: &mut [u8], kind: u8) -> Result<u64, ProgramError> {
    if bytes.len() != SERIES_LEN || bytes[0..8] != *SERIES_MAGIC || bytes[8] != 1 ||
        bytes[9] != kind || bytes[10] != SERIES_SILVER ||
        bytes[11..16].iter().any(|byte| *byte != 0) {
        return Err(ProgramError::InvalidAccountData);
    }
    let next = u64::from_le_bytes(bytes[16..24].try_into().unwrap())
        .checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    bytes[16..24].copy_from_slice(&next.to_le_bytes());
    Ok(next)
}

fn assign_serial<'a>(program_id: &Pubkey, series: &AccountInfo<'a>,
    payer: &AccountInfo<'a>, system: &AccountInfo<'a>, kind: u8,
) -> Result<u64, ProgramError> {
    if !matches!(kind, SERIES_BOX | SERIES_RING) || !series.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    let kind_seed = [kind];
    let rarity_seed = [SERIES_SILVER];
    let (expected, bump) = Pubkey::find_program_address(
        &[SERIES_SEED, &kind_seed, &rarity_seed], program_id);
    if series.key != &expected { return Err(ProgramError::InvalidSeeds); }
    if series.owner == &system_program::id() {
        create_pda(series, payer, system, program_id, SERIES_LEN,
            &[SERIES_SEED, &kind_seed, &rarity_seed, &[bump]])?;
        let mut bytes = series.try_borrow_mut_data()?;
        bytes.fill(0);
        bytes[0..8].copy_from_slice(SERIES_MAGIC);
        bytes[8] = 1;
        bytes[9] = kind;
        bytes[10] = SERIES_SILVER;
    } else if series.owner != program_id {
        return Err(ProgramError::InvalidAccountData);
    }
    next_series_serial(&mut series.try_borrow_mut_data()?, kind)
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
            CONFIG_V1_LEN,
            &[CONFIG_SEED, &[bump]],
        )?;
        let mut bytes = config.try_borrow_mut_data()?;
        bytes[0] = 1;
        bytes[1..33].copy_from_slice(vault.key.as_ref());
        bytes[33..65].copy_from_slice(issuer.as_ref());
    } else if data[0] == 3 {
        if config.owner != program_id {
            return Err(ProgramError::InvalidAccountData);
        }
        let mut bytes = config.try_borrow_mut_data()?;
        if !config_layout_matches(&bytes) || bytes[1..33] != vault.key.to_bytes() {
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
    if !config_layout_matches(&config_data)
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

fn valid_issue_uri(uri: &str) -> bool {
    uri.starts_with("ipfs://") && uri.len() > "ipfs://".len() &&
        uri.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn issue(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], source: u8) -> ProgramResult {
    let draw = source == DRAW_BOX_ISSUE;
    let breeding = source == BREED_BOX_ISSUE;
    let admin = source == ADMIN_BOX_ISSUE;
    let uri_offset = if breeding { 165 } else if draw || admin { 131 } else { 115 };
    if data.len() < uri_offset || accounts.len() != if breeding { 14 } else { 13 } {
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
    let draw_result_id: Option<&[u8; 16]> = if draw {
        Some(data[113..129].try_into().map_err(|_| ProgramError::InvalidInstructionData)?)
    } else { None };
    let admin_operation_id: Option<&[u8; 16]> = if admin {
        Some(data[113..129].try_into().map_err(|_| ProgramError::InvalidInstructionData)?)
    } else { None };
    let breeding_ids: Option<(&[u8; 16], &[u8; 16], &[u8; 16], u8, u8)> = if breeding {
        let operation_id = data[113..129].try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let first = data[129..145].try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let second = data[145..161].try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        if first == second || data[161] > 1 || data[162] > 1 {
            return Err(ProgramError::InvalidInstructionData);
        }
        Some((operation_id, first, second, data[161], data[162]))
    } else { None };
    let uri_len = u16::from_le_bytes([data[uri_offset - 2], data[uri_offset - 1]]) as usize;
    if uri_len == 0 || uri_len > 160 || data.len() != uri_offset + uri_len {
        return Err(ProgramError::InvalidInstructionData);
    }
    let uri = std::str::from_utf8(&data[uri_offset..])
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if !valid_issue_uri(uri) {
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
    let lifecycle = next_account_info(iter)?;
    let series = next_account_info(iter)?;
    let funder = if breeding { next_account_info(iter)? } else { issuer };
    let (expected_config, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    if config.key != &expected_config || config.owner != program_id ||
        !issuer.is_signer || !issuer.is_writable ||
        !funder.is_signer || !funder.is_writable ||
        (breeding && funder.key != recipient.key) {
        return Err(ProgramError::InvalidAccountData);
    }
    let config_bytes = config.try_borrow_data()?;
    let (gateway_issuer, _) = Pubkey::find_program_address(
        &[BREEDING_GATEWAY_ISSUER_SEED], &BREEDING_GATEWAY_PROGRAM);
    if !config_layout_matches(&config_bytes)
        || (if breeding { issuer.key != &gateway_issuer }
            else { config_bytes[33..65] != issuer.key.to_bytes() }) {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(config_bytes);
    check_collection(program_id, config, collection_account)?;
    let account_string = uuid(account_id);
    let draw_result_string = draw_result_id.map(uuid);
    let admin_operation_string = admin_operation_id.map(uuid);
    let breeding_strings = breeding_ids.map(|(operation, first, second, a, b)|
        (uuid(operation), uuid(first), uuid(second), a.to_string(), b.to_string()));
    let expected_issuance = if let Some((ref operation, ..)) = breeding_strings {
        hashv(&[b"EtheRings:cooper-breeding:issuance:v1\ndevnet\n",
            operation.as_bytes(), b"\n"])
    } else if let Some(ref operation) = admin_operation_string {
        hashv(&[b"EtheRings:admin-box:issuance:v1\ndevnet\n",
            operation.as_bytes(), b"\n"])
    } else if let Some(ref result) = draw_result_string {
        hashv(&[
            b"EtheRings:draw-box:issuance:v1\ndevnet\n",
            result.as_bytes(), b"\n",
        ])
    } else {
        hashv(&[
            b"EtheRings:first-entry:issuance:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
        ])
    };
    if expected_issuance.as_ref() != issuance_id {
        return Err(ProgramError::InvalidInstructionData);
    }
    let issuance_hex = hex(issuance_id);
    let recipient_string = recipient.key.to_string();
    let expected_digest = if let Some((ref operation, ref first, ref second,
        ref first_uses, ref second_uses)) = breeding_strings {
        hashv(&[
            b"EtheRings:cooper-breeding:binding:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
            recipient_string.as_bytes(), b"\n",
            operation.as_bytes(), b"\n", first.as_bytes(), b"\n",
            second.as_bytes(), b"\n", first_uses.as_bytes(), b"\n",
            second_uses.as_bytes(), b"\n", issuance_hex.as_bytes(), b"\n",
        ])
    } else if let Some(ref operation) = admin_operation_string {
        hashv(&[b"EtheRings:admin-box:binding:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
            recipient_string.as_bytes(), b"\n",
            operation.as_bytes(), b"\n", issuance_hex.as_bytes(), b"\n"])
    } else if let Some(ref result) = draw_result_string {
        hashv(&[
            b"EtheRings:draw-box:binding:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
            recipient_string.as_bytes(), b"\n",
            result.as_bytes(), b"\n",
            issuance_hex.as_bytes(), b"\n",
        ])
    } else {
        hashv(&[
            b"EtheRings:first-entry:entitlement:v1\ndevnet\n",
            account_string.as_bytes(), b"\n",
            recipient_string.as_bytes(), b"\n",
            issuance_hex.as_bytes(), b"\n",
        ])
    };
    if expected_digest.as_ref() != entitlement_digest {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (expected_breeding_token, breeding_token_bump) =
        Pubkey::find_program_address(&[BREEDING_BOX_TOKEN_SEED, issuance_id], program_id);
    if token_program.key != &spl_token_2022::id()
        || (if breeding { token_account.key != &expected_breeding_token }
            else { !token_account.is_signer })
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
    let (expected_lifecycle, lifecycle_bump) =
        Pubkey::find_program_address(&[LIFECYCLE_SEED, mint.key.as_ref()], program_id);
    if extra_metas.key != &expected_metas || lifecycle.key != &expected_lifecycle {
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
    let serial = assign_serial(program_id, series, funder, system, SERIES_BOX)?;
    create_pda(mint, funder, system, token_program.key, mint_space, mint_seeds)?;
    let funded_size = mint_space
        .checked_add(if breeding { 1024 } else { 768 })
        .ok_or(ProgramError::InvalidAccountData)?;
    let final_rent = Rent::get()?.minimum_balance(funded_size);
    if mint.lamports() < final_rent {
        invoke(
            &system_instruction::transfer(funder.key, mint.key, final_rent - mint.lamports()),
            &[funder.clone(), mint.clone(), system.clone()],
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
        ("rarity", "SILVER".to_string()),
        ("series", SERIES_MARKER.to_string()),
        ("serial", serial.to_string()),
        ("issuance_source", if breeding { "cooper-breeding" }
            else if admin { "admin-grant" }
            else if draw { "draw" } else { "first-entry" }.to_string()),
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
    if let Some(result) = draw_result_string {
        invoke_signed(
            &metadata_instruction::update_field(
                token_program.key, mint.key, authority.key,
                Field::Key("draw_result_id".to_string()), result,
            ),
            &[mint.clone(), authority.clone(), token_program.clone()],
            &[authority_seeds],
        )?;
    }
    if let Some(operation) = admin_operation_string {
        invoke_signed(
            &metadata_instruction::update_field(
                token_program.key, mint.key, authority.key,
                Field::Key("admin_operation_id".to_string()), operation,
            ),
            &[mint.clone(), authority.clone(), token_program.clone()],
            &[authority_seeds],
        )?;
    }
    if let Some((operation, first, second, first_uses, second_uses)) = breeding_strings {
        for (key, value) in [
            ("breeding_operation_id", operation),
            ("breeding_first_parent", first),
            ("breeding_second_parent", second),
            ("breeding_first_uses", first_uses),
            ("breeding_second_uses", second_uses),
        ] {
            invoke_signed(&metadata_instruction::update_field(
                token_program.key, mint.key, authority.key,
                Field::Key(key.to_string()), value,
            ), &[mint.clone(), authority.clone(), token_program.clone()],
            &[authority_seeds])?;
        }
    }

    let token_space = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
        ExtensionType::TransferHookAccount,
    ])?;
    if breeding {
        create_pda(token_account, funder, system, token_program.key, token_space,
            &[BREEDING_BOX_TOKEN_SEED, issuance_id, &[breeding_token_bump]])?;
    } else {
        invoke(
            &system_instruction::create_account(
                funder.key,
                token_account.key,
                Rent::get()?.minimum_balance(token_space),
                token_space as u64,
                token_program.key,
            ),
            &[funder.clone(), token_account.clone(), system.clone()],
        )?;
    }
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
        funder,
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
    create_pda(
        lifecycle,
        funder,
        system,
        program_id,
        LIFECYCLE_LEN,
        &[LIFECYCLE_SEED, mint.key.as_ref(), &[lifecycle_bump]],
    )?;
    {
        let mut lifecycle_bytes = lifecycle.try_borrow_mut_data()?;
        lifecycle_bytes.fill(0);
        lifecycle_bytes[0..8].copy_from_slice(LIFECYCLE_MAGIC);
        lifecycle_bytes[8] = LIFECYCLE_VERSION;
        lifecycle_bytes[9] = LIFECYCLE_PHASE_SEALED;
        lifecycle_bytes[16..48].copy_from_slice(mint.key.as_ref());
        lifecycle_bytes[48..56].copy_from_slice(&1u64.to_le_bytes());
        lifecycle_bytes[120..128].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
    }
    let extra = [state_extra_meta()?, lifecycle_extra_meta()?];
    create_pda(extra_metas, funder, system, program_id,
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
    solana_program::msg!("validate: collection");
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
    solana_program::msg!("validate: addresses");
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
    solana_program::msg!("validate: state");
    let mint_data = mint.try_borrow_data()?;
    let mint_state = StateWithExtensions::<Mint>::unpack(&mint_data)?;
    if mint_state.base.decimals != 0
        || mint_state.base.supply != 1
        || mint_state.base.mint_authority != COption::None
        || mint_state.base.freeze_authority != COption::None
    {
        return Err(ProgramError::InvalidAccountData);
    }
    solana_program::msg!("validate: mint-base");
    let pointer = mint_state.get_extension::<MetadataPointer>()?;
    let hook = mint_state.get_extension::<TransferHook>()?;
    if Option::<Pubkey>::from(pointer.metadata_address) != Some(*mint.key)
        || Option::<Pubkey>::from(pointer.authority).is_some()
        || Option::<Pubkey>::from(hook.program_id) != Some(*program_id)
        || Option::<Pubkey>::from(hook.authority).is_some()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    solana_program::msg!("validate: mint-extensions");
    let token_data = token_account.try_borrow_data()?;
    let token_state = StateWithExtensions::<TokenAccount>::unpack(&token_data)?;
    if token_state.base.mint != *mint.key
        || token_state.base.owner != *owner.key
        || token_state.base.amount != 1
    {
        return Err(ProgramError::InvalidAccountData);
    }
    solana_program::msg!("validate: token");
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
        #[cfg(feature = "disposable-orao-cpi-proof")]
        Some(12) => disposable_orao_request(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(&BEGIN_OPEN_PREPARE) => prepare_begin_open(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(&BEGIN_OPEN_COMMIT) => commit_begin_open(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "alpha-opening-candidate"), not(feature = "disposable-orao-cpi-proof")))]
        Some(&FINALIZE_PREFLIGHT) => finalize_readonly_preflight(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(&FINALIZE_OPEN) => finalize_open(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(&SILVER_LEVEL_UP) => silver_level_up(program_id, accounts, data, false),
        Some(&SILVER_PAID_LEVEL_UP) => silver_level_up(program_id, accounts, data, true),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(&SILVER_ALLOCATE_POINTS) => silver_allocate_points(program_id, accounts, data),
        Some(0) => issue(program_id, accounts, data, 0),
        Some(&DRAW_BOX_ISSUE) => issue(program_id, accounts, data, DRAW_BOX_ISSUE),
        Some(&BREED_BOX_ISSUE) => issue(program_id, accounts, data, BREED_BOX_ISSUE),
        Some(&ADMIN_BOX_ISSUE) => issue(program_id, accounts, data, ADMIN_BOX_ISSUE),
        Some(1) => validate(program_id, accounts, data),
        Some(2) | Some(3) => configure(program_id, accounts, data),
        Some(4) => initialize_collection(program_id, accounts, data),
        Some(5) => migrate_transfer_state(program_id, accounts, data),
        Some(6) => migrate_config_v2(program_id, accounts, data),
        Some(7) => create_design_set(program_id, accounts, data),
        Some(8) => append_design(program_id, accounts, data),
        Some(9) => freeze_design_set(program_id, accounts, data),
        Some(10) => activate_design_set(program_id, accounts, data),
        Some(11) => migrate_box_lifecycle_v1(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(25) => marketplace_hook::migrate_metas(program_id, accounts, data),
        #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
        Some(26) => marketplace_hook::lazy_migrate_metas(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn prepare_begin_open(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 33 || !matches!(accounts.len(), 18 | 20) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: [u8; 32] = data[1..].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let user = &accounts[0];
    let mint = &accounts[1];
    let user_box = &accounts[2];
    let escrow_box = &accounts[3];
    let state = &accounts[4];
    let lifecycle = &accounts[5];
    let extra_metas = &accounts[6];
    let operation = &accounts[7];
    let config = &accounts[8];
    let design = &accounts[9];
    let collection = &accounts[10];
    let network = &accounts[11];
    let treasury = &accounts[12];
    let request = &accounts[13];
    let orao = &accounts[14];
    let token_program = &accounts[15];
    let instructions_sysvar = &accounts[16];
    let system = &accounts[17];
    let market = accounts.get(18);
    let listing = accounts.get(19);
    let old_metas = canonical_meta_list(&[state_extra_meta()?, lifecycle_extra_meta()?])?;
    let meta_data = extra_metas.try_borrow_data()?;
    if let (Some(market), Some(listing)) = (market, listing) {
        let mut metas = vec![state_extra_meta()?, lifecycle_extra_meta()?];
        metas.extend(marketplace_hook::market_metas(market.key, false)?);
        if meta_data.as_ref() != canonical_meta_list(&metas)?.as_slice()
            || marketplace_hook::listing_is_active(market, listing, mint.key)?
        { return Err(ProgramError::InvalidAccountData); }
    } else if meta_data.as_ref() != old_metas.as_slice() {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(meta_data);
    if !user.is_signer || !user.is_writable || !user_box.is_writable
        || !escrow_box.is_writable || !state.is_writable || !lifecycle.is_writable
        || !operation.is_writable || !network.is_writable || !treasury.is_writable
        || !request.is_writable || *token_program.key != spl_token_2022::id()
        || *system.key != system_program::ID
        || *extra_metas.key != get_extra_account_metas_address_and_bump_seed(mint.key, program_id).0
        || extra_metas.owner != program_id
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let keys = BeginOpenTxKeys {
        user: *user.key, mint: *mint.key, user_box: *user_box.key,
        escrow_box: *escrow_box.key, state: *state.key,
        lifecycle: *lifecycle.key, extra_metas: *extra_metas.key,
        operation: *operation.key,
        config: *config.key, design: *design.key, collection: *collection.key,
        network: *network.key, treasury: *treasury.key, request: *request.key,
        orao: *orao.key, token_program: *token_program.key,
        instructions_sysvar: *instructions_sysvar.key, system: *system.key,
        market_program: market.map(|account| *account.key),
        listing: listing.map(|account| *account.key),
    };
    validate_begin_open_tx_sysvar(program_id, instructions_sysvar, &keys, false)?;
    let (escrow_authority, _) = Pubkey::find_program_address(&[ESCROW_SEED, mint.key.as_ref()], program_id);
    if *escrow_box.key != get_associated_token_address_with_program_id(
        &escrow_authority, mint.key, token_program.key,
    ) || escrow_box.owner != token_program.key {
        return Err(ProgramError::InvalidAccountData);
    }
    let escrow_data = escrow_box.try_borrow_data()?;
    let escrow = StateWithExtensions::<TokenAccount>::unpack(&escrow_data)?;
    if escrow.base.mint != *mint.key || escrow.base.owner != escrow_authority
        || escrow.base.amount != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(escrow_data);
    let state_data = state.try_borrow_data()?;
    if state_data.len() != TRANSFER_STATE_LEN {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut validation_data = vec![1];
    validation_data.extend_from_slice(&state_data[4..36]);
    drop(state_data);
    validate(program_id, &[
        mint.clone(), state.clone(), user_box.clone(), user.clone(),
        config.clone(), collection.clone(),
    ], &validation_data)?;
    if network.owner != &ORAO_CLASSIC_PROGRAM {
        return Err(ProgramError::InvalidAccountData);
    }
    let network_data = network.try_borrow_data()?;
    let network_state = orao_solana_vrf::state::NetworkState::try_deserialize(
        &mut network_data.as_ref(),
    ).map_err(|_| ProgramError::InvalidAccountData)?;
    if network_state.config.treasury != *treasury.key {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(network_data);
    let config_data = config.try_borrow_data()?;
    let design_data = design.try_borrow_data()?;
    let state_data = state.try_borrow_data()?;
    let lifecycle_data = lifecycle.try_borrow_data()?;
    let user_box_data = user_box.try_borrow_data()?;
    let token = StateWithExtensions::<TokenAccount>::unpack(&user_box_data)?;
    let binding = validate_begin_open_preflight(program_id, &BeginOpenPreflight {
        config_key: config.key, config_owner: config.owner, config: &config_data,
        design_key: design.key, design_owner: design.owner, design: &design_data,
        mint: mint.key, state_key: state.key, state_owner: state.owner, state: &state_data,
        lifecycle_key: lifecycle.key, lifecycle_owner: lifecycle.owner, lifecycle: &lifecycle_data,
        user: user.key, user_signed: user.is_signer,
        token_owner: &token.base.owner, token_amount: token.base.amount,
        now: Clock::get()?.unix_timestamp, seed: &seed,
        orao_program: orao.key, orao_executable: orao.executable,
        network_key: network.key, network_owner: network.owner,
        request_key: request.key, request_owner: request.owner,
        request_data_len: request.data_len(), operation_key: operation.key,
        operation_owner: operation.owner, operation_data_len: operation.data_len(),
    })?;
    drop(user_box_data);
    drop(lifecycle_data);
    drop(state_data);
    drop(design_data);
    drop(config_data);
    let (_, bump) = Pubkey::find_program_address(
        &[OPEN_SEED, mint.key.as_ref(), &binding.operation_number.to_le_bytes()], program_id,
    );
    create_pda(operation, user, system, program_id, OPEN_OPERATION_LEN,
        &[OPEN_SEED, mint.key.as_ref(), &binding.operation_number.to_le_bytes(), &[bump]])?;
    {
        let mut bytes = operation.try_borrow_mut_data()?;
        bytes.fill(0);
        bytes[0..8].copy_from_slice(OPEN_OPERATION_MAGIC);
        bytes[8] = 1;
        bytes[9] = 0;
        bytes[16..24].copy_from_slice(&binding.operation_number.to_le_bytes());
        bytes[24..56].copy_from_slice(binding.box_mint.as_ref());
        bytes[56..88].copy_from_slice(binding.owner.as_ref());
        bytes[88..120].copy_from_slice(escrow_box.key.as_ref());
        bytes[120..152].copy_from_slice(binding.request.as_ref());
        bytes[152..184].copy_from_slice(&binding.seed);
        bytes[184..216].copy_from_slice(design.key.as_ref());
        bytes[216..224].copy_from_slice(&binding.design_version.to_le_bytes());
        bytes[224..226].copy_from_slice(&binding.design_count.to_le_bytes());
        bytes[226..258].copy_from_slice(&binding.design_commitment);
        bytes[258..266].copy_from_slice(&Clock::get()?.slot.to_le_bytes());
        bytes[306] = 1;
    }
    let ix = orao_request_instruction(*user.key, *network.key, *treasury.key, *request.key, seed);
    invoke(&ix, &[
        user.clone(), network.clone(), treasury.clone(), request.clone(),
        system.clone(), orao.clone(),
    ])?;
    Ok(())
}

#[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
fn commit_begin_open(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 33 || !matches!(accounts.len(), 18 | 20) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let user = &accounts[0];
    let mint = &accounts[1];
    let user_box = &accounts[2];
    let escrow_box = &accounts[3];
    let state = &accounts[4];
    let lifecycle = &accounts[5];
    let extra_metas = &accounts[6];
    let operation = &accounts[7];
    let request = &accounts[13];
    let token_program = &accounts[15];
    let keys = BeginOpenTxKeys {
        user: *user.key, mint: *mint.key, user_box: *user_box.key,
        escrow_box: *escrow_box.key, state: *state.key,
        lifecycle: *lifecycle.key, extra_metas: *extra_metas.key,
        operation: *operation.key,
        config: *accounts[8].key, design: *accounts[9].key,
        collection: *accounts[10].key, network: *accounts[11].key,
        treasury: *accounts[12].key, request: *request.key,
        orao: *accounts[14].key, token_program: *token_program.key,
        instructions_sysvar: *accounts[16].key, system: *accounts[17].key,
        market_program: accounts.get(18).map(|account| *account.key),
        listing: accounts.get(19).map(|account| *account.key),
    };
    validate_begin_open_tx_sysvar(program_id, &accounts[16], &keys, true)?;
    if !user.is_signer || !operation.is_writable || operation.owner != program_id
        || operation.data_len() != OPEN_OPERATION_LEN
        || !state.is_writable || state.owner != program_id
        || !lifecycle.is_writable || lifecycle.owner != program_id
        || user_box.owner != token_program.key || escrow_box.owner != token_program.key
        || *token_program.key != spl_token_2022::id()
        || request.owner != &ORAO_CLASSIC_PROGRAM
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let op = operation.try_borrow_data()?;
    let life = lifecycle.try_borrow_data()?;
    if op[0..8] != *OPEN_OPERATION_MAGIC || op[8] != 1 || op[9] != 0
        || op[10..16].iter().any(|byte| *byte != 0)
        || op[24..56] != mint.key.to_bytes()
        || op[56..88] != user.key.to_bytes()
        || op[88..120] != escrow_box.key.to_bytes()
        || op[120..152] != request.key.to_bytes()
        || op[152..184] != data[1..]
        || op[306] != 1
        || op[266..306].iter().any(|byte| *byte != 0)
        || op[307..].iter().any(|byte| *byte != 0)
        || !lifecycle_matches(&life, mint.key)
        || op[16..24] != life[48..56]
        || *operation.key != Pubkey::find_program_address(
            &[OPEN_SEED, mint.key.as_ref(), &life[48..56]], program_id,
        ).0
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let (escrow_authority, _) = Pubkey::find_program_address(&[ESCROW_SEED, mint.key.as_ref()], program_id);
    if *escrow_box.key != get_associated_token_address_with_program_id(
        &escrow_authority, mint.key, token_program.key,
    ) {
        return Err(ProgramError::InvalidAccountData);
    }
    let request_data = request.try_borrow_data()?;
    let randomness = orao_solana_vrf::state::RandomnessV2::try_deserialize(
        &mut request_data.as_ref(),
    ).map_err(|_| ProgramError::InvalidAccountData)?;
    if randomness.seed() != &op[152..184] || randomness.client() != user.key {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(request_data);
    let source_data = user_box.try_borrow_data()?;
    let destination_data = escrow_box.try_borrow_data()?;
    let source = StateWithExtensions::<TokenAccount>::unpack(&source_data)?;
    let destination = StateWithExtensions::<TokenAccount>::unpack(&destination_data)?;
    if source.base.mint != *mint.key || source.base.owner != *user.key
        || source.base.amount != 0 || destination.base.mint != *mint.key
        || destination.base.owner != escrow_authority || destination.base.amount != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(destination_data);
    drop(source_data);
    let clock = Clock::get()?;
    let state_data = state.try_borrow_data()?;
    if state_data.len() != TRANSFER_STATE_LEN
        || state_data[36..68] != mint.key.to_bytes()
        || state_data[STATE_LEN..STATE_LEN + 8] != clock.slot.to_le_bytes()
        || state_data[STATE_LEN + 8..TRANSFER_STATE_LEN]
            != clock.unix_timestamp.checked_add(DIRECT_TRANSFER_COOLDOWN_SECONDS)
                .ok_or(ProgramError::ArithmeticOverflow)?.to_le_bytes()
    {
        return Err(ProgramError::InvalidAccountData);
    }
    drop(state_data);
    drop(op);
    drop(life);
    operation.try_borrow_mut_data()?[9] = LIFECYCLE_PHASE_OPENING;
    let mut life = lifecycle.try_borrow_mut_data()?;
    life[9] = LIFECYCLE_PHASE_OPENING;
    let next_operation = u64::from_le_bytes(life[48..56].try_into().unwrap())
        .checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?;
    life[48..56].copy_from_slice(&next_operation.to_le_bytes());
    life[56..88].copy_from_slice(operation.key.as_ref());
    Ok(())
}

fn orao_request_instruction(
    payer: Pubkey, network: Pubkey, treasury: Pubkey, request: Pubkey, seed: [u8; 32],
) -> solana_program::instruction::Instruction {
    solana_program::instruction::Instruction {
        program_id: ORAO_CLASSIC_PROGRAM,
        accounts: orao_solana_vrf::accounts::RequestV2 {
            payer,
            network_state: network,
            treasury,
            request,
            system_program: system_program::ID,
        }.to_account_metas(None),
        data: orao_solana_vrf::instruction::RequestV2 { seed }.data(),
    }
}

#[cfg(feature = "disposable-orao-cpi-proof")]
fn disposable_orao_request(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() != 33 || accounts.len() != 6 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed: [u8; 32] = data[1..].try_into().map_err(|_| ProgramError::InvalidInstructionData)?;
    let payer = &accounts[0];
    let network = &accounts[1];
    let treasury = &accounts[2];
    let request = &accounts[3];
    let system = &accounts[4];
    let orao = &accounts[5];
    let expected_network = Pubkey::find_program_address(&[ORAO_CONFIG_SEED], &ORAO_CLASSIC_PROGRAM).0;
    let expected_request = Pubkey::find_program_address(&[ORAO_REQUEST_SEED, &seed], &ORAO_CLASSIC_PROGRAM).0;
    if !payer.is_signer || !payer.is_writable || !network.is_writable || !treasury.is_writable
        || !request.is_writable || *network.key != expected_network || *request.key != expected_request
        || *system.key != system_program::ID || *orao.key != ORAO_CLASSIC_PROGRAM
        || !orao.executable
    {
        return Err(ProgramError::InvalidAccountData);
    }
    let ix = orao_request_instruction(*payer.key, *network.key, *treasury.key, *request.key, seed);
    invoke(&ix, accounts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_counter_is_typed_monotonic_and_fail_closed() {
        let mut box_series = [0u8; SERIES_LEN];
        box_series[0..8].copy_from_slice(SERIES_MAGIC);
        box_series[8] = 1;
        box_series[9] = SERIES_BOX;
        box_series[10] = SERIES_SILVER;
        assert_eq!(next_series_serial(&mut box_series, SERIES_BOX), Ok(1));
        assert_eq!(next_series_serial(&mut box_series, SERIES_BOX), Ok(2));
        assert_eq!(next_series_serial(&mut box_series, SERIES_RING),
            Err(ProgramError::InvalidAccountData));
        assert_eq!(u64::from_le_bytes(box_series[16..24].try_into().unwrap()), 2);
        let mut ring_series = box_series;
        ring_series[9] = SERIES_RING;
        ring_series[16..24].fill(0);
        assert_eq!(next_series_serial(&mut ring_series, SERIES_RING), Ok(1));
        ring_series[11] = 1;
        assert_eq!(next_series_serial(&mut ring_series, SERIES_RING),
            Err(ProgramError::InvalidAccountData));
        ring_series[11] = 0;
        ring_series[16..24].copy_from_slice(&u64::MAX.to_le_bytes());
        assert_eq!(next_series_serial(&mut ring_series, SERIES_RING),
            Err(ProgramError::ArithmeticOverflow));
        assert_eq!(u64::from_le_bytes(ring_series[16..24].try_into().unwrap()), u64::MAX);
    }

    #[cfg(not(feature = "disposable-orao-cpi-proof"))]
    #[test]
    fn opening_dispatch_is_explicit_per_build() {
        let program = Pubkey::new_unique();
        let keys: Vec<_> = (0..22).map(|_| Pubkey::new_unique()).collect();
        let owners = vec![Pubkey::default(); 22];
        let mut lamports = vec![0u64; 22];
        let mut data = vec![Vec::<u8>::new(); 22];
        let accounts: Vec<_> = keys.iter().zip(owners.iter())
            .zip(lamports.iter_mut()).zip(data.iter_mut())
            .map(|(((key, owner), lamports), data)| {
                AccountInfo::new(key, false, false, lamports, data.as_mut_slice(), owner, false, 0)
            }).collect();
        for (opcode, account_count) in [(12, 18), (13, 18), (14, 11), (15, 22)] {
            let mut instruction = vec![opcode];
            if opcode == 12 || opcode == 13 {
                instruction.extend_from_slice(&[7u8; 32]);
            }
            let result = process_instruction(&program, &accounts[..account_count], &instruction);
            let routed = result != Err(ProgramError::InvalidInstructionData);
            let expected = if opcode == 14 {
                cfg!(all(feature = "local-opening-proof", not(feature = "alpha-opening-candidate")))
            } else {
                cfg!(feature = "local-opening-proof")
            };
            assert_eq!(routed, expected, "opcode {opcode}: {result:?}");
        }
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn finalize_uses_exact_frozen_design_uri_and_rejects_invalid_uri() {
        let mut design = vec![0u8; DESIGN_HEADER_LEN];
        for (id, uri) in [(1u32, b"ipfs://first".as_slice()),
            (2u32, b"ipfs://second".as_slice())] {
            design.extend_from_slice(&id.to_le_bytes());
            design.extend_from_slice(&(uri.len() as u16).to_le_bytes());
            design.extend_from_slice(uri);
            design.extend_from_slice(&[id as u8; 32]);
        }
        assert_eq!(selected_design_uri(&design, 0).unwrap(), "ipfs://first");
        assert_eq!(selected_design_uri(&design, 1).unwrap(), "ipfs://second");
        assert!(selected_design_uri(&design, 2).is_err());
        let second_uri = DESIGN_HEADER_LEN + 6 + b"ipfs://first".len() + 32 + 6;
        let mut changed = design.clone();
        changed[second_uri] = b'x';
        assert!(selected_design_uri(&changed, 1).is_err());
        let mut changed = design.clone();
        changed[second_uri + 7] = b' ';
        assert!(selected_design_uri(&changed, 1).is_err());
        let mut changed = design;
        let second_len = second_uri - 2;
        changed[second_len..second_len + 2].copy_from_slice(&7u16.to_le_bytes());
        assert!(selected_design_uri(&changed, 1).is_err());
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn ring_hook_state_requires_canonical_identity_and_typed_outcome() {
        let program = Pubkey::new_unique();
        let box_mint = Pubkey::new_unique();
        let operation = Pubkey::new_unique();
        let ring_mint = Pubkey::find_program_address(
            &[RING_MINT_SEED, box_mint.as_ref(), operation.as_ref()], &program,
        ).0;
        let mut ring = vec![0u8; RING_STATE_LEN];
        ring[0..8].copy_from_slice(RING_STATE_MAGIC);
        ring[8] = 1;
        ring[9] = 2;
        ring[16..48].copy_from_slice(ring_mint.as_ref());
        ring[48..80].copy_from_slice(box_mint.as_ref());
        ring[80..112].copy_from_slice(operation.as_ref());
        ring[112..144].copy_from_slice(Pubkey::new_unique().as_ref());
        ring[144..176].copy_from_slice(Pubkey::find_program_address(&[COLLECTION_SEED], &program).0.as_ref());
        ring[176..208].copy_from_slice(Pubkey::new_unique().as_ref());
        ring[208..240].fill(1);
        ring[240..248].copy_from_slice(&1u64.to_le_bytes());
        ring[248..250].copy_from_slice(&2u16.to_le_bytes());
        ring[250..254].copy_from_slice(&3u32.to_le_bytes());
        ring[254..286].fill(3);
        ring[286..290].copy_from_slice(&[26, 24, 29, 21]);
        ring[290] = 1;
        ring[291] = 100;
        ring[296] = 1;
        ring[297..299].copy_from_slice(&3u16.to_le_bytes());
        ring[304..312].copy_from_slice(&10u64.to_le_bytes());
        ring[312..320].copy_from_slice(&11u64.to_le_bytes());
        let uri = b"ipfs://bafy-test";
        ring[336..338].copy_from_slice(&(uri.len() as u16).to_le_bytes());
        ring[338..338 + uri.len()].copy_from_slice(uri);
        ring[544..576].fill(4);
        assert!(ring_state_matches(&program, &ring_mint, &ring));
        assert!(ring_state_extra_meta().is_ok());
        assert!(!ring_state_matches(&program, &Pubkey::new_unique(), &ring));
        for index in [8, 9, 16, 48, 80, 144, 286, 290,
            291, 296, 297, 304, 336, 338, 538] {
            let mut changed = ring.clone();
            changed[index] ^= 0xff;
            assert!(!ring_state_matches(&program, &ring_mint, &changed), "byte {index}");
        }
        let mut changed = ring.clone();
        changed[248..250].copy_from_slice(&3u16.to_le_bytes());
        assert!(!ring_state_matches(&program, &ring_mint, &changed));
        for field in [176..208, 208..240, 240..248, 250..254, 254..286, 312..320] {
            let mut changed = ring.clone();
            changed[field].fill(0);
            assert!(!ring_state_matches(&program, &ring_mint, &changed));
        }
        assert!(ring_state_matches(&program, &ring_mint, &ring));
        let mut progressed = ring.clone();
        progressed[290] = 2;
        progressed[292..296].copy_from_slice(&6u32.to_le_bytes());
        progressed[299] = 100; // 26 + 24 + 29 + 21 at initial generation.
        assert!(ring_state_matches(&program, &ring_mint, &progressed));
        progressed[286] += 1;
        progressed[292..296].copy_from_slice(&5u32.to_le_bytes());
        assert!(ring_state_matches(&program, &ring_mint, &progressed));
        progressed[292..296].copy_from_slice(&6u32.to_le_bytes());
        assert!(!ring_state_matches(&program, &ring_mint, &progressed));
        progressed[292..296].copy_from_slice(&5u32.to_le_bytes());
        progressed[299] = 0;
        assert!(!ring_state_matches(&program, &ring_mint, &progressed));

        let mut upgraded = ring.clone();
        assert_eq!(apply_silver_level_up(&mut upgraded, 1, 2, 14),
            Err(ProgramError::InvalidInstructionData));
        assert_eq!(apply_silver_level_up(&mut upgraded, 1, 2, 15), Ok(()));
        assert_eq!(upgraded[290], 2);
        assert_eq!(u32::from_le_bytes(upgraded[292..296].try_into().unwrap()), 6);
        assert_eq!(upgraded[299], 100);
        assert!(ring_state_matches(&program, &ring_mint, &upgraded));
        assert_eq!(apply_silver_level_up(&mut upgraded, 1, 2, 15),
            Err(ProgramError::InvalidInstructionData));
        let mut allocation = [0u8; 14];
        allocation[0] = SILVER_ALLOCATE_POINTS;
        allocation[1] = 2;
        allocation[2..6].copy_from_slice(&6u32.to_le_bytes());
        allocation[6..10].copy_from_slice(&upgraded[286..290]);
        allocation[10] = 1;
        assert_eq!(apply_silver_allocation(&mut upgraded, &allocation), Ok(()));
        assert_eq!(upgraded[286], 27);
        assert_eq!(u32::from_le_bytes(upgraded[292..296].try_into().unwrap()), 5);
        assert!(ring_state_matches(&program, &ring_mint, &upgraded));
        assert_eq!(apply_silver_allocation(&mut upgraded, &allocation),
            Err(ProgramError::InvalidInstructionData));
        assert_eq!(apply_silver_level_up(&mut upgraded, 2, 3, 20), Ok(()));
        assert_eq!(apply_silver_level_up(&mut upgraded, 3, 4, 25), Ok(()));
        assert_eq!(apply_silver_level_up(&mut upgraded, 4, 5, 30), Ok(()));
        for level in 6..=20 {
            assert_eq!(apply_silver_level_up(&mut upgraded, level - 1, level,
                5 * (u64::from(level) + 1)), Ok(()));
        }
        assert_eq!(upgraded[290], 20);
        assert_eq!(u32::from_le_bytes(upgraded[292..296].try_into().unwrap()), 113);
        assert!(ring_state_matches(&program, &ring_mint, &upgraded));
        assert_eq!(apply_silver_level_up(&mut upgraded, 20, 21, 110),
            Err(ProgramError::InvalidInstructionData));
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn silver_outcome_matches_independent_node_vector_and_frozen_entry() {
        let randomness: [u8; 32] = core::array::from_fn(|i| i as u8);
        let mint = Pubkey::new_from_array(core::array::from_fn(|i| (i + 32) as u8));
        let mut design = vec![0u8; DESIGN_HEADER_LEN];
        for id in 1..=3u32 {
            design.extend_from_slice(&id.to_le_bytes());
            design.extend_from_slice(&1u16.to_le_bytes());
            design.push(b'x');
            design.extend_from_slice(&[id as u8; 32]);
        }
        let result = derive_silver_outcome(&randomness, &mint, &design, 3).unwrap();
        assert_eq!(result, SilverOutcome {
            attributes: [26, 24, 29, 21],
            visual_index: 2,
            design_id: 3,
            content_hash: [3; 32],
        });
        assert_ne!(derive_silver_outcome(&randomness, &Pubkey::new_unique(), &design, 3)
            .unwrap(), result);
        assert_eq!(derive_silver_outcome(&randomness, &mint, &design, 0),
            Err(ProgramError::InvalidAccountData));
        assert_eq!(derive_silver_outcome(&randomness, &mint, &design[..DESIGN_HEADER_LEN], 3),
            Err(ProgramError::InvalidAccountData));
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn silver_rejection_boundary_is_unbiased_for_attribute_and_visual_ranges() {
        for range in [3u32, 21, 26, 42] {
            let limit = ((1u64 << 32) / u64::from(range)) * u64::from(range);
            assert_eq!(reduce_silver_sample((limit - 1) as u32, range),
                Some(((limit - 1) % u64::from(range)) as u32));
            if limit < (1u64 << 32) {
                assert_eq!(reduce_silver_sample(limit as u32, range), None);
                assert_eq!(reduce_silver_sample(u32::MAX, range), None);
            }
            assert_eq!(reduce_silver_sample(0, range), Some(0));
        }
        assert_eq!(reduce_silver_sample(1, 0), None);
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    fn hex32(value: &str) -> [u8; 32] {
        assert_eq!(value.len(), 64);
        core::array::from_fn(|index| {
            u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).unwrap()
        })
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn finalize_normalization_matches_owner_approved_raw_byte_vectors() {
        let zero = [0u8; 32];
        let zero64 = [0u8; 64];
        assert_eq!(normalize_orao_randomness(
            &Pubkey::new_from_array(zero), &Pubkey::new_from_array(zero), &zero, &zero64,
        ), hex32("e8d3c38c6997ff1405968031da7599c9dd68c78b6a181170882784509bce5a7c"));
        let program: [u8; 32] = core::array::from_fn(|i| i as u8);
        let request: [u8; 32] = core::array::from_fn(|i| (i + 32) as u8);
        let seed: [u8; 32] = core::array::from_fn(|i| (i + 64) as u8);
        let fulfilled: [u8; 64] = core::array::from_fn(|i| (i + 96) as u8);
        let expected = hex32("1c195663f76d9ab80d2329788771ee667c2a5543666d6e914314dc276d55a3cf");
        assert_eq!(normalize_orao_randomness(
            &Pubkey::new_from_array(program), &Pubkey::new_from_array(request),
            &seed, &fulfilled,
        ), expected);
        let mut changed_seed = seed;
        changed_seed[31] ^= 1;
        assert_ne!(normalize_orao_randomness(
            &Pubkey::new_from_array(program), &Pubkey::new_from_array(request),
            &changed_seed, &fulfilled,
        ), expected);
        let repeated_program = [0xff; 32];
        let repeated_request = [0xa5; 32];
        let repeated_seed = [0x5a; 32];
        let repeated_fulfilled: [u8; 64] = core::array::from_fn(|i| (i + 0xc0) as u8);
        assert_eq!(normalize_orao_randomness(
            &Pubkey::new_from_array(repeated_program),
            &Pubkey::new_from_array(repeated_request), &repeated_seed, &repeated_fulfilled,
        ), hex32("64c417f17f48fcdc3907bf2089e19d52d8a329eb09e8398235187d52cbfade5d"));
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn finalize_requires_fulfilled_request_for_exact_client_and_seed() {
        use orao_solana_vrf::state::{FulfilledRequest, PendingRequest, RandomnessV2, RequestAccount};
        let owner = Pubkey::new_unique();
        let request = Pubkey::new_unique();
        let seed = [9u8; 32];
        let fulfilled = RandomnessV2 { request: RequestAccount::Fulfilled(FulfilledRequest {
            client: owner, seed, randomness: [7u8; 64],
        }) };
        assert!(validate_fulfilled_request(&request, &seed, &owner, &fulfilled).is_ok());
        let pending = RandomnessV2 { request: RequestAccount::Pending(PendingRequest {
            client: owner, seed, responses: vec![],
        }) };
        assert_eq!(validate_fulfilled_request(&request, &seed, &owner, &pending),
            Err(ProgramError::InvalidAccountData));
        let other = Pubkey::new_unique();
        assert_eq!(validate_fulfilled_request(&request, &seed, &other, &fulfilled),
            Err(ProgramError::InvalidAccountData));
        let wrong_seed = [8u8; 32];
        assert_eq!(validate_fulfilled_request(&request, &wrong_seed, &owner, &fulfilled),
            Err(ProgramError::InvalidAccountData));
    }

    #[cfg(all(feature = "local-opening-proof", not(feature = "disposable-orao-cpi-proof")))]
    #[test]
    fn finalize_operation_requires_exact_opening_lifecycle_without_mutation() {
        let program = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let request = Pubkey::new_unique();
        let escrow = Pubkey::new_unique();
        let number = 1u64;
        let operation_key = Pubkey::find_program_address(
            &[OPEN_SEED, mint.as_ref(), &number.to_le_bytes()], &program,
        ).0;
        let mut operation = vec![0u8; OPEN_OPERATION_LEN];
        operation[0..8].copy_from_slice(OPEN_OPERATION_MAGIC);
        operation[8] = 1;
        operation[9] = LIFECYCLE_PHASE_OPENING;
        operation[16..24].copy_from_slice(&number.to_le_bytes());
        operation[24..56].copy_from_slice(mint.as_ref());
        operation[56..88].copy_from_slice(owner.as_ref());
        operation[88..120].copy_from_slice(escrow.as_ref());
        operation[120..152].copy_from_slice(request.as_ref());
        operation[152..184].fill(9);
        operation[258..266].copy_from_slice(&1u64.to_le_bytes());
        operation[306] = 1;
        let mut lifecycle = vec![0u8; LIFECYCLE_LEN];
        lifecycle[0..8].copy_from_slice(LIFECYCLE_MAGIC);
        lifecycle[8] = LIFECYCLE_VERSION;
        lifecycle[9] = LIFECYCLE_PHASE_OPENING;
        lifecycle[16..48].copy_from_slice(mint.as_ref());
        lifecycle[48..56].copy_from_slice(&2u64.to_le_bytes());
        lifecycle[56..88].copy_from_slice(operation_key.as_ref());
        lifecycle[120..128].copy_from_slice(&1u64.to_le_bytes());
        let baseline = (operation.clone(), lifecycle.clone());
        assert_eq!(validate_finalize_operation(
            &program, &mint, &operation_key, &operation, &lifecycle,
        ), Ok((owner, request, [9u8; 32])));
        for index in [9, 16, 24, 258, 266, 306, 307] {
            let mut changed = operation.clone();
            changed[index] ^= 1;
            assert!(validate_finalize_operation(
                &program, &mint, &operation_key, &changed, &lifecycle,
            ).is_err(), "operation byte {index}");
        }
        for index in [9, 16, 48, 56, 88, 120] {
            let mut changed = lifecycle.clone();
            changed[index] ^= 1;
            assert!(validate_finalize_operation(
                &program, &mint, &operation_key, &operation, &changed,
            ).is_err(), "lifecycle byte {index}");
        }
        assert!(validate_finalize_operation(
            &program, &mint, &Pubkey::new_unique(), &operation, &lifecycle,
        ).is_err());
        assert_eq!((operation, lifecycle), baseline);
    }

    #[test]
    fn begin_open_requires_exact_atomic_top_level_graph() {
        let program = Pubkey::new_unique();
        let keys = BeginOpenTxKeys {
            user: Pubkey::new_unique(), mint: Pubkey::new_unique(),
            user_box: Pubkey::new_unique(), escrow_box: Pubkey::new_unique(),
            state: Pubkey::new_unique(), lifecycle: Pubkey::new_unique(),
            extra_metas: Pubkey::new_unique(), operation: Pubkey::new_unique(),
            config: Pubkey::new_unique(), design: Pubkey::new_unique(),
            collection: Pubkey::new_unique(), network: Pubkey::new_unique(),
            treasury: Pubkey::new_unique(), request: Pubkey::new_unique(),
            orao: ORAO_CLASSIC_PROGRAM, token_program: spl_token_2022::id(),
            instructions_sysvar: solana_program::sysvar::instructions::id(),
            system: system_program::ID,
            market_program: None,
            listing: None,
        };
        let mut accounts = vec![
            AccountMeta::new(keys.user, true),
            AccountMeta::new_readonly(keys.mint, false),
            AccountMeta::new(keys.user_box, false),
            AccountMeta::new(keys.escrow_box, false),
            AccountMeta::new(keys.state, false),
            AccountMeta::new(keys.lifecycle, false),
            AccountMeta::new_readonly(keys.extra_metas, false),
            AccountMeta::new(keys.operation, false),
            AccountMeta::new_readonly(keys.config, false),
            AccountMeta::new_readonly(keys.design, false),
            AccountMeta::new_readonly(keys.collection, false),
            AccountMeta::new(keys.network, false),
            AccountMeta::new(keys.treasury, false),
            AccountMeta::new(keys.request, false),
            AccountMeta::new_readonly(keys.orao, false),
            AccountMeta::new_readonly(keys.token_program, false),
            AccountMeta::new_readonly(keys.instructions_sysvar, false),
            AccountMeta::new_readonly(keys.system, false),
        ];
        let seed = [7u8; 32];
        let mut prepare_data = vec![BEGIN_OPEN_PREPARE];
        prepare_data.extend_from_slice(&seed);
        let mut commit_data = vec![BEGIN_OPEN_COMMIT];
        commit_data.extend_from_slice(&seed);
        let prepare = Instruction { program_id: program, accounts: accounts.clone(), data: prepare_data };
        let mut transfer = token_instruction::transfer_checked(
            &spl_token_2022::id(), &keys.user_box, &keys.mint,
            &keys.escrow_box, &keys.user, &[], 1, 0,
        ).unwrap();
        transfer.accounts[3] = AccountMeta::new(keys.user, true);
        transfer.accounts.extend([
            AccountMeta::new_readonly(keys.extra_metas, false),
            AccountMeta::new(keys.state, false),
            AccountMeta::new(keys.lifecycle, false),
            AccountMeta::new_readonly(program, false),
        ]);
        let commit = Instruction { program_id: program, accounts, data: commit_data };
        let graph = vec![prepare.clone(), transfer.clone(), commit.clone()];
        assert_eq!(validate_begin_open_tx_graph(&program, &graph, 0, &keys), Ok(()));
        let budget = Instruction { program_id: COMPUTE_BUDGET_PROGRAM, accounts: vec![], data: vec![2, 0, 0, 0, 0] };
        let with_budget = vec![budget.clone(), prepare.clone(), transfer.clone(), commit.clone()];
        assert_eq!(validate_begin_open_tx_graph(&program, &with_budget, 1, &keys), Ok(()));
        assert!(validate_begin_open_tx_graph(&program, &graph[..2], 0, &keys).is_err());
        assert!(validate_begin_open_tx_graph(&program, &[transfer.clone(), prepare.clone(), commit.clone()], 1, &keys).is_err());
        assert!(validate_begin_open_tx_graph(&program, &[prepare.clone(), commit.clone(), transfer.clone()], 0, &keys).is_err());
        let mut extra = graph.clone();
        extra.push(budget);
        assert!(validate_begin_open_tx_graph(&program, &extra, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[1].data[1] = 2;
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[1].accounts[2].pubkey = Pubkey::new_unique();
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[1].accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[2].data[1] ^= 1;
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[0].accounts[0].is_signer = false;
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[0].accounts[8].is_writable = true;
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
        let mut wrong = graph.clone();
        wrong[0].accounts[14].is_signer = true;
        assert!(validate_begin_open_tx_graph(&program, &wrong, 0, &keys).is_err());
    }

    #[cfg(not(feature = "disposable-orao-cpi-proof"))]
    #[test]
    fn release_dispatch_rejects_disposable_orao_opcode() {
        assert_eq!(process_instruction(&Pubkey::new_unique(), &[], &[12]),
            Err(ProgramError::InvalidInstructionData));
    }

    #[cfg(feature = "disposable-orao-cpi-proof")]
    #[test]
    fn orao_request_v2_uses_official_sdk_abi_and_signers() {
        let payer = Pubkey::new_unique();
        let network = Pubkey::new_unique();
        let treasury = Pubkey::new_unique();
        let request = Pubkey::new_unique();
        let seed = [19u8; 32];
        let ix = orao_request_instruction(payer, network, treasury, request, seed);
        assert_eq!(ix.program_id, ORAO_CLASSIC_PROGRAM);
        assert_eq!(ix.data.len(), 40);
        assert_eq!(&ix.data[..8], &solana_program::hash::hash(b"global:request_v2").to_bytes()[..8]);
        assert_eq!(&ix.data[8..], &seed);
        let expected = [(payer, true, true), (network, false, true),
            (treasury, false, true), (request, false, true),
            (system_program::ID, false, false)];
        for (actual, (key, signer, writable)) in ix.accounts.iter().zip(expected) {
            assert_eq!((actual.pubkey, actual.is_signer, actual.is_writable),
                (key, signer, writable));
        }
        assert_eq!(ix.accounts.len(), 5);
    }

    #[test]
    fn begin_open_preflight_binds_box_design_and_fresh_orao_request_without_writes() {
        let program = Pubkey::new_unique();
        let authority = Pubkey::new_unique();
        let user = Pubkey::new_unique();
        let outsider = Pubkey::new_unique();
        let issuance_id = [7u8; 32];
        let (mint, _) = Pubkey::find_program_address(&[MINT_SEED, &issuance_id], &program);
        let state_key = Pubkey::find_program_address(&[STATE_SEED, mint.as_ref()], &program).0;
        let lifecycle_key = Pubkey::find_program_address(&[LIFECYCLE_SEED, mint.as_ref()], &program).0;
        let design_key = Pubkey::find_program_address(&[DESIGN_SEED, &1u64.to_le_bytes()], &program).0;
        let config_key = Pubkey::find_program_address(&[CONFIG_SEED], &program).0;
        let operation_key = Pubkey::find_program_address(
            &[OPEN_SEED, mint.as_ref(), &1u64.to_le_bytes()], &program,
        ).0;
        let seed = [9u8; 32];
        let request_key = Pubkey::find_program_address(
            &[ORAO_REQUEST_SEED, &seed], &ORAO_CLASSIC_PROGRAM,
        ).0;
        let network_key = Pubkey::find_program_address(
            &[ORAO_CONFIG_SEED], &ORAO_CLASSIC_PROGRAM,
        ).0;

        let mut design = vec![0u8; DESIGN_HEADER_LEN + MAX_ENTRY_BYTES];
        design[0..8].copy_from_slice(DESIGN_MAGIC);
        design[8] = 1;
        design[9] = 1;
        design[10..12].copy_from_slice(&1u16.to_le_bytes());
        design[12..14].copy_from_slice(&1u16.to_le_bytes());
        let uri = b"ipfs://cid";
        let used = 38 + uri.len();
        design[14..16].copy_from_slice(&(used as u16).to_le_bytes());
        design[16..24].copy_from_slice(&1u64.to_le_bytes());
        design[24..56].copy_from_slice(authority.as_ref());
        design[96..104].copy_from_slice(&1u64.to_le_bytes());
        design[104..108].copy_from_slice(&1u32.to_le_bytes());
        design[108..110].copy_from_slice(&(uri.len() as u16).to_le_bytes());
        design[110..110 + uri.len()].copy_from_slice(uri);
        design[110 + uri.len()..142 + uri.len()].fill(1);
        let mut hasher = Hasher::default();
        for part in [DESIGN_DOMAIN.as_slice(), program.as_ref(), design_key.as_ref(),
            &1u64.to_le_bytes(), &1u16.to_le_bytes(), &design[104..104 + used]] {
            hasher.hash(part);
        }
        let commitment = hasher.result().to_bytes();
        design[56..88].copy_from_slice(&commitment);
        let mut config = vec![0u8; CONFIG_V2_LEN];
        config[0] = 2;
        config[1..33].copy_from_slice(authority.as_ref());
        config[73..105].copy_from_slice(design_key.as_ref());
        config[105..113].copy_from_slice(&1u64.to_le_bytes());
        config[113..145].copy_from_slice(&commitment);
        let mut state = vec![0u8; TRANSFER_STATE_LEN];
        state[0..4].copy_from_slice(&[3, 1, 1, 1]);
        state[4..36].copy_from_slice(&issuance_id);
        state[36..68].copy_from_slice(mint.as_ref());
        state[68..100].copy_from_slice(
            Pubkey::find_program_address(&[COLLECTION_SEED], &program).0.as_ref(),
        );
        state[196..204].copy_from_slice(&9i64.to_le_bytes());
        let mut lifecycle = vec![0u8; LIFECYCLE_LEN];
        lifecycle[0..8].copy_from_slice(LIFECYCLE_MAGIC);
        lifecycle[8] = LIFECYCLE_VERSION;
        lifecycle[9] = LIFECYCLE_PHASE_SEALED;
        lifecycle[16..48].copy_from_slice(mint.as_ref());
        lifecycle[48..56].copy_from_slice(&1u64.to_le_bytes());
        lifecycle[120..128].copy_from_slice(&1u64.to_le_bytes());
        let baseline = (config.clone(), design.clone(), state.clone(), lifecycle.clone());
        let input = BeginOpenPreflight {
            config_key: &config_key, config_owner: &program, config: &config,
            design_key: &design_key,
            design_owner: &program, design: &design, mint: &mint, state_key: &state_key,
            state_owner: &program, state: &state, lifecycle_key: &lifecycle_key,
            lifecycle_owner: &program, lifecycle: &lifecycle,
            user: &user, user_signed: true, token_owner: &user, token_amount: 1,
            now: 10, seed: &seed, orao_program: &ORAO_CLASSIC_PROGRAM,
            orao_executable: true, network_key: &network_key,
            network_owner: &ORAO_CLASSIC_PROGRAM,
            request_key: &request_key, request_owner: &system_program::id(),
            request_data_len: 0, operation_key: &operation_key,
            operation_owner: &system_program::id(), operation_data_len: 0,
        };
        let binding = validate_begin_open_preflight(&program, &input).unwrap();
        assert_eq!(binding.owner, user);
        assert_eq!(binding.box_mint, mint);
        assert_eq!(binding.operation_number, 1);
        assert_eq!(binding.request, request_key);
        assert_eq!(binding.seed, seed);
        assert_eq!(binding.design_version, 1);
        assert_eq!(binding.design_count, 1);
        assert_eq!(binding.design_commitment, commitment);
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { user_signed: false, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { state_owner: &outsider, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { orao_executable: false, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { network_owner: &outsider, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { token_owner: &outsider, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { token_amount: 0, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { now: 8, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { request_key: &outsider, ..input }).is_err());
        let zero_seed = [0u8; 32];
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { seed: &zero_seed, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { operation_key: &outsider, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { operation_owner: &program, ..input }).is_err());
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { request_owner: &ORAO_CLASSIC_PROGRAM, ..input }).is_err());
        let mut wrong_config = config.clone();
        wrong_config[113] ^= 1;
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { config: &wrong_config, ..input }).is_err());
        let mut changed_design = design.clone();
        changed_design[110] ^= 1;
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { design: &changed_design, ..input }).is_err());
        let mut opening = lifecycle.clone();
        opening[9] = 1;
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { lifecycle: &opening, ..input }).is_err());
        let mut wrong_state = state.clone();
        wrong_state[36] ^= 1;
        assert!(validate_begin_open_preflight(&program,
            &BeginOpenPreflight { state: &wrong_state, ..input }).is_err());
        assert_eq!((config, design, state, lifecycle), baseline);
    }

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
    fn config_layout_accepts_only_exact_v1_and_v2() {
        let mut v1 = [0u8; CONFIG_V1_LEN];
        v1[0] = 1;
        assert!(config_layout_matches(&v1));
        v1[0] = 2;
        assert!(!config_layout_matches(&v1));

        let mut v2 = [0u8; CONFIG_V2_LEN];
        v2[0] = 2;
        assert!(config_layout_matches(&v2));
        v2[0] = 1;
        assert!(!config_layout_matches(&v2));
        assert!(!config_layout_matches(&v2[..CONFIG_V2_LEN - 1]));
    }

    #[test]
    fn design_set_v1_bounds_are_fixed() {
        assert_eq!(DESIGN_HEADER_LEN + MAX_DESIGNS * MAX_ENTRY_BYTES, 10_100);
        assert_eq!(MAX_URI_BYTES, 200);
        assert_eq!(DESIGN_DOMAIN.len(), 30);
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
    fn box_issue_uri_is_canonical_ipfs_only() {
        assert!(valid_issue_uri("ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png"));
        assert!(!valid_issue_uri("ipfs://"));
        assert!(!valid_issue_uri("https://example.invalid/box.png"));
        assert!(!valid_issue_uri("ipfs://cid/box.png\n"));
    }

    #[test]
    fn state_address_is_bound_to_mint() {
        let program = Pubkey::new_unique();
        let (a, _) = Pubkey::find_program_address(&[STATE_SEED, &[1u8; 32]], &program);
        let (b, _) = Pubkey::find_program_address(&[STATE_SEED, &[2u8; 32]], &program);
        assert_ne!(a, b);
    }

    #[test]
    fn box_lifecycle_v1_layout_is_fixed() {
        let mint = Pubkey::new_unique();
        let mut data = [0u8; LIFECYCLE_LEN];
        data[0..8].copy_from_slice(LIFECYCLE_MAGIC);
        data[8] = LIFECYCLE_VERSION;
        data[9] = LIFECYCLE_PHASE_SEALED;
        data[16..48].copy_from_slice(mint.as_ref());
        data[48..56].copy_from_slice(&1u64.to_le_bytes());
        data[120..128].copy_from_slice(&7u64.to_le_bytes());
        assert!(lifecycle_matches(&data, &mint));
        data[48..56].copy_from_slice(&2u64.to_le_bytes());
        assert!(lifecycle_matches(&data, &mint));
        data[48..56].copy_from_slice(&0u64.to_le_bytes());
        assert!(!lifecycle_matches(&data, &mint));
        data[48..56].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(!lifecycle_matches(&data, &mint));
        data[48..56].copy_from_slice(&1u64.to_le_bytes());
        data[9] = 1;
        assert!(!lifecycle_matches(&data, &mint));
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
