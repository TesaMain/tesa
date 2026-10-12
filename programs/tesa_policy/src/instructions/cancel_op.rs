use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::*;

/// Recupera a política se um `begin_op` foi executado sem o `end_op` correspondente
/// (o recibo do nonce atual ficaria preso e bloquearia o próximo `begin_op`).
#[derive(Accounts)]
pub struct CancelOp<'info> {
    #[account(mut)]
    pub vault: Signer<'info>,
    #[account(
        seeds = [POLICY_SEED, vault.key().as_ref()],
        bump = policy.bump,
        has_one = vault
    )]
    pub policy: Account<'info, Policy>,
    #[account(
        mut,
        close = vault,
        seeds = [OP_SEED, vault.key().as_ref(), &policy.op_nonce.to_le_bytes()],
        bump = op_receipt.bump
    )]
    pub op_receipt: Account<'info, OpReceipt>,
}

pub fn handler(_ctx: Context<CancelOp>) -> Result<()> {
    Ok(())
}
