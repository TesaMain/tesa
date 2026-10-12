use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::TesaError;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdatePolicy<'info> {
    pub vault: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump = policy.bump,
        has_one = vault
    )]
    pub policy: Account<'info, Policy>,
    /// Pode ser a mesma conta atual ou uma nova, desde que do mesmo ativo.
    #[account(constraint = price_feed.yield_mint == policy.yield_mint @ TesaError::PriceFeedMismatch)]
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handler(ctx: Context<UpdatePolicy>, params: PolicyParams) -> Result<()> {
    let price_feed = ctx.accounts.price_feed.key();
    ctx.accounts.policy.apply(&params, price_feed)
}
