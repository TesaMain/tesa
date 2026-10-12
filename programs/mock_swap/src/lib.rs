//! Swap simulado para localnet/devnet, onde não há USDY nem Jupiter.
//!
//! USDC -> USDY: recebe USDC numa reserva e cunha USDY (o config é a mint authority).
//! USDY -> USDC: queima USDY e paga USDC da reserva.
//! O preço e um "haircut" (slippage simulado) são configuráveis pelo admin.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("2khHAreRkYwwB2RTEJMzcsfsYdV9N1Pepp3Win8sxKUB");

pub const PRICE_SCALE: u128 = 1_000_000_000;
pub const BPS: u128 = 10_000;

#[program]
pub mod mock_swap {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, price_e9: u64, haircut_bps: u16) -> Result<()> {
        require!(
            ctx.accounts.usdc_mint.decimals == ctx.accounts.usdy_mint.decimals,
            MockSwapError::DecimalsMismatch
        );
        require!(
            ctx.accounts.usdy_mint.mint_authority == COption::Some(ctx.accounts.config.key()),
            MockSwapError::WrongMintAuthority
        );
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.usdy_mint = ctx.accounts.usdy_mint.key();
        config.bump = ctx.bumps.config;
        config.set(price_e9, haircut_bps)
    }

    pub fn set_params(ctx: Context<SetParams>, price_e9: u64, haircut_bps: u16) -> Result<()> {
        ctx.accounts.config.set(price_e9, haircut_bps)
    }

    pub fn swap(ctx: Context<Swap>, usdc_to_usdy: bool, amount_in: u64) -> Result<()> {
        let config = &ctx.accounts.config;
        let usdy_mint_key = config.usdy_mint;
        let seeds: &[&[u8]] = &[b"config", usdy_mint_key.as_ref(), &[config.bump]];
        let signer = &[seeds];
        let token_program = ctx.accounts.token_program.key();
        let haircut = BPS - config.haircut_bps as u128;

        if usdc_to_usdy {
            let out = (amount_in as u128 * PRICE_SCALE / config.price_e9 as u128) * haircut / BPS;
            token::transfer(
                CpiContext::new(
                    token_program,
                    Transfer {
                        from: ctx.accounts.user_usdc.to_account_info(),
                        to: ctx.accounts.reserve_usdc.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;
            token::mint_to(
                CpiContext::new_with_signer(
                    token_program,
                    MintTo {
                        mint: ctx.accounts.usdy_mint.to_account_info(),
                        to: ctx.accounts.user_usdy.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                out as u64,
            )?;
        } else {
            let out = (amount_in as u128 * config.price_e9 as u128 / PRICE_SCALE) * haircut / BPS;
            token::burn(
                CpiContext::new(
                    token_program,
                    Burn {
                        mint: ctx.accounts.usdy_mint.to_account_info(),
                        from: ctx.accounts.user_usdy.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                amount_in,
            )?;
            token::transfer(
                CpiContext::new_with_signer(
                    token_program,
                    Transfer {
                        from: ctx.accounts.reserve_usdc.to_account_info(),
                        to: ctx.accounts.user_usdc.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                out as u64,
            )?;
        }
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdy_mint: Pubkey,
    pub price_e9: u64,
    pub haircut_bps: u16,
    pub bump: u8,
}

impl Config {
    fn set(&mut self, price_e9: u64, haircut_bps: u16) -> Result<()> {
        require!(price_e9 > 0 && haircut_bps < 10_000, MockSwapError::InvalidParams);
        self.price_e9 = price_e9;
        self.haircut_bps = haircut_bps;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub usdc_mint: Account<'info, Mint>,
    /// O mint precisa ter sido criado com o config PDA como mint authority.
    pub usdy_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config", usdy_mint.key().as_ref()],
        bump
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = admin,
        seeds = [b"reserve", config.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = config
    )]
    pub reserve_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub usdy_mint: Account<'info, Mint>,
    #[account(
        seeds = [b"config", usdy_mint.key().as_ref()],
        bump = config.bump,
        has_one = usdy_mint
    )]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"reserve", config.key().as_ref()], bump)]
    pub reserve_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = config.usdc_mint, token::authority = user)]
    pub user_usdc: Account<'info, TokenAccount>,
    #[account(mut, token::mint = usdy_mint, token::authority = user)]
    pub user_usdy: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum MockSwapError {
    #[msg("USDC e USDY simulados precisam ter os mesmos decimais")]
    DecimalsMismatch,
    #[msg("Parâmetros inválidos")]
    InvalidParams,
    #[msg("O config PDA precisa ser a mint authority do USDY simulado")]
    WrongMintAuthority,
}
