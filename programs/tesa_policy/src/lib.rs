//! Programa de política de tesouraria da Tesa.
//!
//! O vault da Squads é a única autoridade. A transação executada pelo vault é
//! `begin_op → swap (Jupiter ou mock) → end_op`, lado a lado: o programa nunca
//! chama o swap via CPI e valida apenas resultados (saldos antes/depois).
use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod math;
pub mod state;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9oTWN6zV7bZfdqtSNRXJ92tSmuGJLqaetsGTQkC2L8wB");

#[program]
pub mod tesa_policy {
    use super::*;

    /// Cria `Policy` e `Position` do vault.
    pub fn initialize_policy(ctx: Context<InitializePolicy>, params: PolicyParams) -> Result<()> {
        instructions::initialize_policy::handler(ctx, params)
    }

    /// Altera limites (e, opcionalmente, a conta de preço de referência).
    pub fn update_policy(ctx: Context<UpdatePolicy>, params: PolicyParams) -> Result<()> {
        instructions::update_policy::handler(ctx, params)
    }

    /// Emergência: bloqueia novas operações.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    /// Valida o pedido contra a política e fotografa os saldos em `OpReceipt`.
    pub fn begin_op(
        ctx: Context<BeginOp>,
        direction: Direction,
        amount_in: u64,
        min_out: u64,
    ) -> Result<()> {
        instructions::begin_op::handler(ctx, direction, amount_in, min_out)
    }

    /// Valida o resultado do swap, atualiza `Position`, emite evento e fecha `OpReceipt`.
    pub fn end_op(ctx: Context<EndOp>) -> Result<()> {
        instructions::end_op::handler(ctx)
    }

    /// Fecha um `OpReceipt` órfão (begin_op executado sem end_op na mesma transação).
    pub fn cancel_op(ctx: Context<CancelOp>) -> Result<()> {
        instructions::cancel_op::handler(ctx)
    }

    /// Cria a conta de preço de referência mantida pela Tesa (seção 3.6, alternativa 2).
    pub fn init_price_feed(ctx: Context<InitPriceFeed>, price_e9: u64, publish_ts: i64) -> Result<()> {
        instructions::price_feed::init_handler(ctx, price_e9, publish_ts)
    }

    /// Publica um novo NAV do USDY.
    pub fn set_price(ctx: Context<SetPrice>, price_e9: u64, publish_ts: i64) -> Result<()> {
        instructions::price_feed::set_handler(ctx, price_e9, publish_ts)
    }
}
