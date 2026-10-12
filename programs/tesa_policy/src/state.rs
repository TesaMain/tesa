use anchor_lang::prelude::*;

use crate::constants::BPS_DENOMINATOR;
use crate::errors::TesaError;

/// PDA: ["policy", vault]
#[account]
#[derive(InitSpace)]
pub struct Policy {
    /// Vault PDA da Squads (única autoridade).
    pub vault: Pubkey,
    pub usdc_mint: Pubkey,
    /// USDY
    pub yield_mint: Pubkey,
    /// Ex.: 7000 = no máximo 70% do caixa no ativo de rendimento.
    pub max_yield_bps: u16,
    /// Colchão mínimo em USDC (unidades atômicas).
    pub min_liquid_usdc: u64,
    /// Teto por operação, em USDC (unidades atômicas).
    pub max_op_usdc: u64,
    /// Desvio adverso máximo contra o preço de referência.
    pub max_slippage_bps: u16,
    /// Conta `PriceFeed` do preço de referência.
    pub price_feed: Pubkey,
    pub max_price_age_secs: u32,
    pub paused: bool,
    pub op_nonce: u64,
    pub bump: u8,
}

impl Policy {
    pub fn apply(&mut self, p: &PolicyParams, price_feed: Pubkey) -> Result<()> {
        p.validate()?;
        self.max_yield_bps = p.max_yield_bps;
        self.min_liquid_usdc = p.min_liquid_usdc;
        self.max_op_usdc = p.max_op_usdc;
        self.max_slippage_bps = p.max_slippage_bps;
        self.max_price_age_secs = p.max_price_age_secs;
        self.price_feed = price_feed;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PolicyParams {
    pub max_yield_bps: u16,
    pub min_liquid_usdc: u64,
    pub max_op_usdc: u64,
    pub max_slippage_bps: u16,
    pub max_price_age_secs: u32,
}

impl PolicyParams {
    pub fn validate(&self) -> Result<()> {
        require!(self.max_yield_bps as u64 <= BPS_DENOMINATOR, TesaError::InvalidParams);
        require!(self.max_slippage_bps as u64 <= BPS_DENOMINATOR, TesaError::InvalidParams);
        require!(self.max_op_usdc > 0, TesaError::InvalidParams);
        require!(self.max_price_age_secs > 0, TesaError::InvalidParams);
        Ok(())
    }
}

/// PDA: ["position", vault]
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub vault: Pubkey,
    pub usdy_units: u64,
    /// Custo médio: rendimento auditável on-chain.
    pub cost_basis_usdc: u64,
    pub realized_pnl_usdc: i64,
    pub last_op_ts: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Direction {
    /// USDC -> USDY
    Allocate,
    /// USDY -> USDC
    Redeem,
}

/// PDA: ["op", vault, op_nonce] — existe só durante a transação.
#[account]
#[derive(InitSpace)]
pub struct OpReceipt {
    pub direction: Direction,
    pub amount_in: u64,
    pub min_out: u64,
    pub pre_usdc: u64,
    pub pre_usdy: u64,
    pub bump: u8,
}

/// Preço de referência mantido pela Tesa a partir do NAV publicado pela Ondo.
/// PDA: ["price_feed", yield_mint, authority]
#[account]
#[derive(InitSpace)]
pub struct PriceFeed {
    pub authority: Pubkey,
    pub yield_mint: Pubkey,
    /// USD por 1 unidade inteira do ativo, 9 casas decimais.
    pub price_e9: u64,
    pub publish_ts: i64,
    pub bump: u8,
}

impl PriceFeed {
    /// Preço validado contra a idade máxima permitida pela política.
    pub fn fresh_price(&self, max_age_secs: u32, now: i64) -> Result<u64> {
        require!(self.price_e9 > 0, TesaError::InvalidPrice);
        let age = now.checked_sub(self.publish_ts).ok_or(TesaError::MathOverflow)?;
        require!(age <= max_age_secs as i64, TesaError::StalePrice);
        Ok(self.price_e9)
    }
}

#[event]
pub struct OpExecuted {
    pub vault: Pubkey,
    pub op_nonce: u64,
    pub direction: Direction,
    pub amount_in: u64,
    pub amount_out: u64,
    pub ref_price_e9: u64,
    pub post_usdc: u64,
    pub post_usdy: u64,
    pub usdy_units: u64,
    pub cost_basis_usdc: u64,
    pub realized_pnl_usdc: i64,
    pub ts: i64,
}
