use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub vault: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump = policy.bump,
        has_one = vault
    )]
    pub policy: Account<'info, Policy>,
}

pub fn handler(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
    ctx.accounts.policy.paused = paused;
    Ok(())
}
