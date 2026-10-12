use anchor_lang::prelude::*;

use crate::constants::{BPS_DENOMINATOR, PRICE_SCALE};
use crate::errors::TesaError;

/// Converte unidades atômicas do ativo de rendimento em unidades atômicas de USDC
/// ao preço `price_e9` (USD por 1 unidade inteira, 9 casas). Arredonda para baixo.
pub fn yield_to_usdc(units: u64, price_e9: u64, yield_decimals: u8, usdc_decimals: u8) -> Result<u64> {
    let num = (units as u128)
        .checked_mul(price_e9 as u128)
        .and_then(|v| v.checked_mul(10u128.pow(usdc_decimals as u32)))
        .ok_or(TesaError::MathOverflow)?;
    let den = (PRICE_SCALE as u128)
        .checked_mul(10u128.pow(yield_decimals as u32))
        .ok_or(TesaError::MathOverflow)?;
    u64::try_from(num / den).map_err(|_| TesaError::MathOverflow.into())
}

/// `value / total <= bps / 10_000`, sem divisão.
pub fn within_bps(value: u64, total: u64, bps: u16) -> bool {
    (value as u128) * (BPS_DENOMINATOR as u128) <= (total as u128) * (bps as u128)
}

/// `got >= fair * (1 - bps / 10_000)`: só desvio adverso conta.
pub fn within_slippage(got: u64, fair: u64, bps: u16) -> bool {
    (got as u128) * (BPS_DENOMINATOR as u128)
        >= (fair as u128) * ((BPS_DENOMINATOR - bps as u64) as u128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_at_nav() {
        // 1.000000 USDY a US$1,14 = 1.140000 USDC
        assert_eq!(yield_to_usdc(1_000_000, 1_140_000_000, 6, 6).unwrap(), 1_140_000);
        // decimais diferentes: 1 unidade com 8 casas -> 6 casas
        assert_eq!(yield_to_usdc(100_000_000, 2_000_000_000, 8, 6).unwrap(), 2_000_000);
    }

    #[test]
    fn bps_checks() {
        assert!(within_bps(70, 100, 7000));
        assert!(!within_bps(71, 100, 7000));
        assert!(within_slippage(99, 100, 100));
        assert!(!within_slippage(98, 100, 100));
        assert!(within_slippage(150, 100, 0));
    }
}
