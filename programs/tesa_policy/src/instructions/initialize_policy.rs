use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::errors::TesaError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitializePolicy<'info> {
    #[account(mut)]
    pub vault: Signer<'info>,
    #[account(
        init,
        payer = vault,
        space = 8 + Policy::INIT_SPACE,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = vault,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, vault.key().as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(constraint = yield_mint.key() != usdc_mint.key() @ TesaError::SameMint)]
    pub yield_mint: Account<'info, Mint>,
    #[account(has_one = yield_mint @ TesaError::PriceFeedMismatch)]
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePolicy>, params: PolicyParams) -> Result<()> {
    let vault = ctx.accounts.vault.key();

    let policy = &mut ctx.accounts.policy;
    policy.vault = vault;
    policy.usdc_mint = ctx.accounts.usdc_mint.key();
    policy.yield_mint = ctx.accounts.yield_mint.key();
    policy.paused = false;
    policy.op_nonce = 0;
    policy.bump = ctx.bumps.policy;
    policy.apply(&params, ctx.accounts.price_feed.key())?;

    let position = &mut ctx.accounts.position;
    position.vault = vault;
    position.usdy_units = 0;
    position.cost_basis_usdc = 0;
    position.realized_pnl_usdc = 0;
    position.last_op_ts = 0;
    position.bump = ctx.bumps.position;
    Ok(())
}
