use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::constants::*;
use crate::errors::TesaError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitPriceFeed<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub yield_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + PriceFeed::INIT_SPACE,
        seeds = [PRICE_FEED_SEED, yield_mint.key().as_ref(), authority.key().as_ref()],
        bump
    )]
    pub price_feed: Account<'info, PriceFeed>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrice<'info> {
    pub authority: Signer<'info>,
    #[account(mut, has_one = authority)]
    pub price_feed: Account<'info, PriceFeed>,
}

fn validate(price_e9: u64, publish_ts: i64) -> Result<()> {
    require!(price_e9 > 0, TesaError::InvalidPrice);
    require!(publish_ts <= Clock::get()?.unix_timestamp, TesaError::InvalidPrice);
    Ok(())
}

pub fn init_handler(ctx: Context<InitPriceFeed>, price_e9: u64, publish_ts: i64) -> Result<()> {
    validate(price_e9, publish_ts)?;
    let feed = &mut ctx.accounts.price_feed;
    feed.authority = ctx.accounts.authority.key();
    feed.yield_mint = ctx.accounts.yield_mint.key();
    feed.price_e9 = price_e9;
    feed.publish_ts = publish_ts;
    feed.bump = ctx.bumps.price_feed;
    Ok(())
}

pub fn set_handler(ctx: Context<SetPrice>, price_e9: u64, publish_ts: i64) -> Result<()> {
    validate(price_e9, publish_ts)?;
    let feed = &mut ctx.accounts.price_feed;
    // NAV não volta no tempo.
    require!(publish_ts >= feed.publish_ts, TesaError::InvalidPrice);
    feed.price_e9 = price_e9;
    feed.publish_ts = publish_ts;
    Ok(())
}
