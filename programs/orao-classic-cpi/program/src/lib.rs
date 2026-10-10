use anchor_lang::prelude::*;
use orao_solana_vrf::{program::OraoVrf, state::NetworkState, CONFIG_ACCOUNT_SEED, RANDOMNESS_ACCOUNT_SEED};

declare_id!("5sySrqzMcqTgKSm8uUCHQ1LGcwb6iVQgN1k6HQqdgpwS");

#[program]
pub mod orao_classic_cpi_proof {
    use super::*;

    pub fn begin(ctx: Context<Begin>, seed: [u8; 32]) -> Result<()> {
        let cpi_accounts = orao_solana_vrf::cpi::accounts::RequestV2 {
            payer: ctx.accounts.payer.to_account_info(),
            network_state: ctx.accounts.network_state.to_account_info(),
            treasury: ctx.accounts.treasury.to_account_info(),
            request: ctx.accounts.request.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        orao_solana_vrf::cpi::request_v2(
            CpiContext::new(ctx.accounts.vrf.to_account_info(), cpi_accounts),
            seed,
        )?;

        let operation = &mut ctx.accounts.operation;
        operation.payer = ctx.accounts.payer.key();
        operation.seed = seed;
        operation.request = ctx.accounts.request.key();
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32])]
pub struct Begin<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + OperationState::LEN,
        seeds = [b"operation", payer.key().as_ref()],
        bump
    )]
    pub operation: Account<'info, OperationState>,
    #[account(mut, seeds = [CONFIG_ACCOUNT_SEED], bump, seeds::program = orao_solana_vrf::ID)]
    pub network_state: Account<'info, NetworkState>,
    /// CHECK: The configured SOL treasury is checked against the ORAO NetworkState.
    #[account(mut, address = network_state.config.treasury)]
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: ORAO validates and initializes this exact request PDA in the CPI.
    #[account(mut, seeds = [RANDOMNESS_ACCOUNT_SEED, &seed], bump, seeds::program = orao_solana_vrf::ID)]
    pub request: UncheckedAccount<'info>,
    pub vrf: Program<'info, OraoVrf>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct OperationState {
    pub payer: Pubkey,
    pub seed: [u8; 32],
    pub request: Pubkey,
}

impl OperationState {
    pub const LEN: usize = 32 + 32 + 32;
}
