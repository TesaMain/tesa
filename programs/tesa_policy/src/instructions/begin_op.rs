use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::TesaError;
use crate::math::yield_to_usdc;
use crate::state::*;

#[derive(Accounts)]
pub struct BeginOp<'info> {
    #[account(mut)]
    pub vault: Signer<'info>,
    #[account(
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump = policy.bump,
        has_one = vault,
        has_one = price_feed @ TesaError::PriceFeedMismatch
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        init,
        payer = vault,
        space = 8 + OpReceipt::INIT_SPACE,
        seeds = [OP_SEED, vault.key().as_ref(), &policy.op_nonce.to_le_bytes()],
        bump
    )]
    pub op_receipt: Account<'info, OpReceipt>,
    #[account(address = policy.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(address = policy.yield_mint)]
    pub yield_mint: Account<'info, Mint>,
    /// Saldos são medidos nas ATAs canônicas do vault.
    #[account(associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(associated_token::mint = yield_mint, associated_token::authority = vault)]
    pub vault_usdy: Account<'info, TokenAccount>,
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<BeginOp>, direction: Direction, amount_in: u64, min_out: u64) -> Result<()> {
    let policy = &ctx.accounts.policy;
    require!(!policy.paused, TesaError::Paused);
    require!(amount_in > 0 && min_out > 0, TesaError::ZeroAmount);

    let now = Clock::get()?.unix_timestamp;
    let price = ctx.accounts.price_feed.fresh_price(policy.max_price_age_secs, now)?;

    let pre_usdc = ctx.accounts.vault_usdc.amount;
    let pre_usdy = ctx.accounts.vault_usdy.amount;

    let (op_value_usdc, balance_in) = match direction {
        Direction::Allocate => (amount_in, pre_usdc),
        Direction::Redeem => (
            yield_to_usdc(
                amount_in,
                price,
                ctx.accounts.yield_mint.decimals,
                ctx.accounts.usdc_mint.decimals,
            )?,
            pre_usdy,
        ),
    };
    require!(op_value_usdc <= policy.max_op_usdc, TesaError::ExceedsMaxOp);
    require!(amount_in <= balance_in, TesaError::InsufficientBalance);

    ctx.accounts.op_receipt.set_inner(OpReceipt {
        direction,
        amount_in,
        min_out,
        pre_usdc,
        pre_usdy,
        bump: ctx.bumps.op_receipt,
    });
    Ok(())
}
