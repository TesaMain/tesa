use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::TesaError;
use crate::math::{within_bps, within_slippage, yield_to_usdc};
use crate::state::*;

#[derive(Accounts)]
pub struct EndOp<'info> {
    #[account(mut)]
    pub vault: Signer<'info>,
    #[account(
        mut,
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump = policy.bump,
        has_one = vault,
        has_one = price_feed @ TesaError::PriceFeedMismatch
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref()],
        bump = position.bump,
        has_one = vault
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        close = vault,
        seeds = [OP_SEED, vault.key().as_ref(), &policy.op_nonce.to_le_bytes()],
        bump = op_receipt.bump
    )]
    pub op_receipt: Account<'info, OpReceipt>,
    #[account(address = policy.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,
    #[account(address = policy.yield_mint)]
    pub yield_mint: Account<'info, Mint>,
    #[account(associated_token::mint = usdc_mint, associated_token::authority = vault)]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(associated_token::mint = yield_mint, associated_token::authority = vault)]
    pub vault_usdy: Account<'info, TokenAccount>,
    pub price_feed: Account<'info, PriceFeed>,
}

pub fn handler(ctx: Context<EndOp>) -> Result<()> {
    let receipt = &ctx.accounts.op_receipt;
    let policy = &ctx.accounts.policy;
    let usdc_dec = ctx.accounts.usdc_mint.decimals;
    let yield_dec = ctx.accounts.yield_mint.decimals;
    let now = Clock::get()?.unix_timestamp;
    let price = ctx.accounts.price_feed.fresh_price(policy.max_price_age_secs, now)?;
    let to_usdc = |units: u64| yield_to_usdc(units, price, yield_dec, usdc_dec);

    let post_usdc = ctx.accounts.vault_usdc.amount;
    let post_usdy = ctx.accounts.vault_usdy.amount;

    let (pre_in, post_in, pre_out, post_out) = match receipt.direction {
        Direction::Allocate => (receipt.pre_usdc, post_usdc, receipt.pre_usdy, post_usdy),
        Direction::Redeem => (receipt.pre_usdy, post_usdy, receipt.pre_usdc, post_usdc),
    };
    let spent = pre_in.checked_sub(post_in).ok_or(TesaError::UnexpectedBalanceChange)?;
    let received = post_out.checked_sub(pre_out).ok_or(TesaError::UnexpectedBalanceChange)?;

    // 5. A saída do cofre bate exatamente com amount_in.
    require!(spent == receipt.amount_in, TesaError::AmountInMismatch);
    // 1. Recebido >= min_out.
    require!(received >= receipt.min_out, TesaError::BelowMinOut);
    // 2. Preço efetivo vs. referência (só desvio adverso).
    let (got_usdc, fair_usdc) = match receipt.direction {
        Direction::Allocate => (to_usdc(received)?, spent),
        Direction::Redeem => (received, to_usdc(spent)?),
    };
    require!(
        within_slippage(got_usdc, fair_usdc, policy.max_slippage_bps),
        TesaError::SlippageExceeded
    );
    // 3 e 4 só se aplicam a alocações: um resgate sempre reduz a exposição e
    // aumenta o USDC, e não deve ser bloqueado se o cofre já estiver fora da política.
    if receipt.direction == Direction::Allocate {
        let yield_value = to_usdc(post_usdy)?;
        let total = post_usdc.checked_add(yield_value).ok_or(TesaError::MathOverflow)?;
        require!(
            within_bps(yield_value, total, policy.max_yield_bps),
            TesaError::YieldCapExceeded
        );
        require!(post_usdc >= policy.min_liquid_usdc, TesaError::BelowMinLiquidity);
    }

    let position = &mut ctx.accounts.position;
    match receipt.direction {
        Direction::Allocate => {
            position.usdy_units = position.usdy_units.checked_add(received).ok_or(TesaError::MathOverflow)?;
            position.cost_basis_usdc = position.cost_basis_usdc.checked_add(spent).ok_or(TesaError::MathOverflow)?;
        }
        Direction::Redeem => {
            // Custo médio. USDY que entrou no cofre fora da política não tem custo registrado.
            let tracked = spent.min(position.usdy_units);
            let cost_out = if position.usdy_units == 0 {
                0
            } else {
                ((position.cost_basis_usdc as u128) * (tracked as u128) / (position.usdy_units as u128)) as u64
            };
            let pnl = i64::try_from(received as i128 - cost_out as i128).map_err(|_| TesaError::MathOverflow)?;
            position.usdy_units -= tracked;
            position.cost_basis_usdc -= cost_out;
            position.realized_pnl_usdc = position.realized_pnl_usdc.checked_add(pnl).ok_or(TesaError::MathOverflow)?;
        }
    }
    position.last_op_ts = now;

    let policy = &mut ctx.accounts.policy;
    emit!(OpExecuted {
        vault: policy.vault,
        op_nonce: policy.op_nonce,
        direction: receipt.direction,
        amount_in: spent,
        amount_out: received,
        ref_price_e9: price,
        post_usdc,
        post_usdy,
        usdy_units: position.usdy_units,
        cost_basis_usdc: position.cost_basis_usdc,
        realized_pnl_usdc: position.realized_pnl_usdc,
        ts: now,
    });
    policy.op_nonce = policy.op_nonce.checked_add(1).ok_or(TesaError::MathOverflow)?;
    Ok(())
}
