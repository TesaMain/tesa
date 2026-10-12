use anchor_lang::prelude::*;

#[constant]
pub const POLICY_SEED: &[u8] = b"policy";

#[constant]
pub const POSITION_SEED: &[u8] = b"position";

#[constant]
pub const OP_SEED: &[u8] = b"op";

#[constant]
pub const PRICE_FEED_SEED: &[u8] = b"price_feed";

/// Preços são USD por 1 unidade inteira do ativo, com 9 casas decimais.
#[constant]
pub const PRICE_SCALE: u64 = 1_000_000_000;

pub const BPS_DENOMINATOR: u64 = 10_000;
