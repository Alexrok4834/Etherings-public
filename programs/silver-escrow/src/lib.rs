use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token_2022::{spl_token_2022, Token2022},
    token_interface::{Mint, TokenAccount},
};
use orao_solana_vrf::{
    program::OraoVrf,
    state::{NetworkState, RandomnessV2},
    CONFIG_ACCOUNT_SEED, RANDOMNESS_ACCOUNT_SEED,
};
use spl_token_2022::extension::{
    transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
};

declare_id!("AhyY2PMrSTXGg2zdX7vcXFr7HKoUQytazhoBGGWcZxFg");

const SILVER_PROGRAM: Pubkey = pubkey!("4mMhB6MhMUT3TfYjpPmrwULwf7iqLjCsafoDGBfoy3yN");

#[program]
pub mod silver_escrow_proof {
    use super::*;

    pub fn begin_open(
        ctx: Context<BeginOpen>,
        seed: [u8; 32],
        design_version: u64,
        design_commitment: [u8; 32],
    ) -> Result<()> {
        let mint = ctx.accounts.box_mint.key();
        let state = ctx.accounts.box_state.try_borrow_data()?;
        require!(
            state.len() == 204 && state[0..4] == [3, 1, 1, 1],
            ProofError::WrongBox
        );
        require!(state[36..68] == mint.to_bytes(), ProofError::WrongBox);
        require!(
            Pubkey::find_program_address(&[b"silver-mint", &state[4..36]], &SILVER_PROGRAM).0
                == mint,
            ProofError::WrongBox
        );
        require!(
            Pubkey::find_program_address(&[b"silver-state", mint.as_ref()], &SILVER_PROGRAM).0
                == ctx.accounts.box_state.key(),
            ProofError::WrongBox
        );
        require!(
            Pubkey::find_program_address(&[b"silver-collection"], &SILVER_PROGRAM)
                .0
                .to_bytes()
                == state[68..100],
            ProofError::WrongBox
        );
        let cooldown_until = i64::from_le_bytes(state[196..204].try_into().unwrap());
        require!(
            Clock::get()?.unix_timestamp >= cooldown_until,
            ProofError::Cooldown
        );
        drop(state);
        require!(
            ctx.accounts.box_mint.supply == 1 && ctx.accounts.box_mint.decimals == 0,
            ProofError::WrongBox
        );
        require!(
            ctx.accounts.box_mint.to_account_info().owner == &spl_token_2022::id(),
            ProofError::WrongBox
        );
        let box_mint_info = ctx.accounts.box_mint.to_account_info();
        let mint_data = box_mint_info.try_borrow_data()?;
        let mint_state = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)
            .map_err(|_| error!(ProofError::WrongBox))?;
        let hook = mint_state
            .get_extension::<TransferHook>()
            .map_err(|_| error!(ProofError::WrongBox))?;
        require!(
            Option::<Pubkey>::from(hook.program_id) == Some(SILVER_PROGRAM),
            ProofError::WrongBox
        );
        drop(mint_data);
        require!(
            ctx.accounts.user_box.amount == 1 && ctx.accounts.escrow_box.amount == 0,
            ProofError::WrongBox
        );
        require!(
            ctx.accounts.extra_metas.key()
                == spl_transfer_hook_interface::get_extra_account_metas_address(
                    &mint,
                    &SILVER_PROGRAM
                ),
            ProofError::WrongBox
        );
        require!(
            ctx.accounts.extra_metas.owner == &SILVER_PROGRAM
                && ctx.accounts.box_state.owner == &SILVER_PROGRAM,
            ProofError::WrongBox
        );
        require!(
            design_version != 0 && design_commitment != [0; 32],
            ProofError::Design
        );

        let cpi_accounts = orao_solana_vrf::cpi::accounts::RequestV2 {
            payer: ctx.accounts.user.to_account_info(),
            network_state: ctx.accounts.network_state.to_account_info(),
            treasury: ctx.accounts.treasury.to_account_info(),
            request: ctx.accounts.request.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        orao_solana_vrf::cpi::request_v2(
            CpiContext::new(ctx.accounts.vrf.to_account_info(), cpi_accounts),
            seed,
        )?;

        let mut ix = spl_token_2022::instruction::transfer_checked(
            &spl_token_2022::id(),
            &ctx.accounts.user_box.key(),
            &mint,
            &ctx.accounts.escrow_box.key(),
            &ctx.accounts.user.key(),
            &[],
            1,
            0,
        )?;
        ix.accounts.extend([
            AccountMeta::new_readonly(ctx.accounts.extra_metas.key(), false),
            AccountMeta::new(ctx.accounts.box_state.key(), false),
            AccountMeta::new_readonly(SILVER_PROGRAM, false),
        ]);
        invoke(
            &ix,
            &[
                ctx.accounts.user_box.to_account_info(),
                ctx.accounts.box_mint.to_account_info(),
                ctx.accounts.escrow_box.to_account_info(),
                ctx.accounts.user.to_account_info(),
                ctx.accounts.extra_metas.to_account_info(),
                ctx.accounts.box_state.to_account_info(),
                ctx.accounts.silver_program.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
        )?;

        let op = &mut ctx.accounts.operation;
        op.beneficial_owner = ctx.accounts.user.key();
        op.box_mint = mint;
        op.escrow_box = ctx.accounts.escrow_box.key();
        op.request = ctx.accounts.request.key();
        op.seed = seed;
        op.design_version = design_version;
        op.design_commitment = design_commitment;
        op.phase = 1;
        op.ring_mint = Pubkey::default();
        op.begin_slot = Clock::get()?.slot;
        Ok(())
    }

    pub fn finalize_open(ctx: Context<FinalizeOpen>) -> Result<()> {
        let op = &mut ctx.accounts.operation;
        require!(op.phase == 1, ProofError::AlreadyFinalized);
        require!(
            ctx.accounts.request.seed() == &op.seed
                && ctx.accounts.request.client() == &op.beneficial_owner,
            ProofError::WrongRequest
        );
        require!(
            ctx.accounts.request.fulfilled().is_some(),
            ProofError::PendingRandomness
        );
        require!(
            ctx.accounts.escrow_box.amount == 1
                && ctx.accounts.escrow_box.owner == ctx.accounts.escrow_authority.key(),
            ProofError::WrongBox
        );
        require!(
            ctx.accounts.box_mint.supply == 1 && ctx.accounts.box_mint.decimals == 0,
            ProofError::WrongBox
        );
        let mint = ctx.accounts.box_mint.key();
        let bump = ctx.bumps.escrow_authority;
        let signer_seeds: &[&[u8]] = &[b"escrow", mint.as_ref(), &[bump]];
        let signer = &[signer_seeds];
        let burn = spl_token_2022::instruction::burn_checked(
            &spl_token_2022::id(),
            &ctx.accounts.escrow_box.key(),
            &mint,
            &ctx.accounts.escrow_authority.key(),
            &[],
            1,
            0,
        )?;
        invoke_signed(
            &burn,
            &[
                ctx.accounts.escrow_box.to_account_info(),
                ctx.accounts.box_mint.to_account_info(),
                ctx.accounts.escrow_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            signer,
        )?;
        let mint_ring = spl_token_2022::instruction::mint_to_checked(
            &spl_token_2022::id(),
            &ctx.accounts.ring_mint.key(),
            &ctx.accounts.ring_token.key(),
            &ctx.accounts.escrow_authority.key(),
            &[],
            1,
            0,
        )?;
        invoke_signed(
            &mint_ring,
            &[
                ctx.accounts.ring_mint.to_account_info(),
                ctx.accounts.ring_token.to_account_info(),
                ctx.accounts.escrow_authority.to_account_info(),
                ctx.accounts.token_program.to_account_info(),
            ],
            signer,
        )?;
        op.ring_mint = ctx.accounts.ring_mint.key();
        op.phase = 2;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct BeginOpen<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, mint::decimals = 0, mint::token_program = token_program)]
    pub box_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = box_mint, token::authority = user, token::token_program = token_program)]
    pub user_box: InterfaceAccount<'info, TokenAccount>,
    #[account(init, payer = user, associated_token::mint = box_mint, associated_token::authority = escrow_authority, associated_token::token_program = token_program)]
    pub escrow_box: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: PDA has no private key and only signs the proof program's CPIs.
    #[account(seeds = [b"escrow", box_mint.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(init, payer = user, space = 8 + Opening::LEN, seeds = [b"opening", box_mint.key().as_ref()], bump)]
    pub operation: Account<'info, Opening>,
    /// CHECK: Verified against the disposable Silver program ID and canonical PDA/data above.
    #[account(mut)]
    pub box_state: UncheckedAccount<'info>,
    /// CHECK: Verified against the canonical ExtraAccountMetaList PDA above.
    pub extra_metas: UncheckedAccount<'info>,
    /// CHECK: Fixed test-only Silver program whose bytecode is separately pinned.
    #[account(address = SILVER_PROGRAM)]
    pub silver_program: UncheckedAccount<'info>,
    #[account(mut, seeds = [CONFIG_ACCOUNT_SEED], bump, seeds::program = orao_solana_vrf::ID)]
    pub network_state: Account<'info, NetworkState>,
    /// CHECK: Matches the ORAO NetworkState treasury.
    #[account(mut, address = network_state.config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: ORAO initializes exactly this seed-derived PDA in the CPI.
    #[account(mut, seeds = [RANDOMNESS_ACCOUNT_SEED, &seed], bump, seeds::program = orao_solana_vrf::ID)]
    pub request: UncheckedAccount<'info>,
    pub vrf: Program<'info, OraoVrf>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FinalizeOpen<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: Address pinned by operation; signer not required.
    #[account(address = operation.beneficial_owner)]
    pub beneficial_owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"opening", box_mint.key().as_ref()], bump, constraint = operation.box_mint == box_mint.key() && operation.escrow_box == escrow_box.key() && operation.request == request.key())]
    pub operation: Account<'info, Opening>,
    #[account(mut, address = operation.box_mint, mint::token_program = token_program)]
    pub box_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, address = operation.escrow_box, token::mint = box_mint, token::authority = escrow_authority, token::token_program = token_program)]
    pub escrow_box: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Exact PDA signer for Box burn and Ring mint only.
    #[account(seeds = [b"escrow", box_mint.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(address = operation.request)]
    pub request: Account<'info, RandomnessV2>,
    #[account(init, payer = keeper, seeds = [b"ring", box_mint.key().as_ref()], bump, mint::decimals = 0, mint::authority = escrow_authority, mint::token_program = token_program)]
    pub ring_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = keeper, associated_token::mint = ring_mint, associated_token::authority = beneficial_owner, associated_token::token_program = token_program)]
    pub ring_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Opening {
    pub beneficial_owner: Pubkey,
    pub box_mint: Pubkey,
    pub escrow_box: Pubkey,
    pub request: Pubkey,
    pub seed: [u8; 32],
    pub design_version: u64,
    pub design_commitment: [u8; 32],
    pub phase: u8,
    pub ring_mint: Pubkey,
    pub begin_slot: u64,
}

impl Opening {
    pub const LEN: usize = 32 * 6 + 8 + 1 + 32 + 8;
}

#[error_code]
pub enum ProofError {
    #[msg("Canonical disposable Box validation failed")]
    WrongBox,
    #[msg("Box cooldown is still active")]
    Cooldown,
    #[msg("Design commitment is missing")]
    Design,
    #[msg("Opening has already been finalized")]
    AlreadyFinalized,
    #[msg("Bound ORAO request does not match")]
    WrongRequest,
    #[msg("Bound ORAO request has not been fulfilled")]
    PendingRandomness,
}
