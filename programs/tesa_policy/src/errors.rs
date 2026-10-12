use anchor_lang::prelude::*;

#[error_code]
pub enum TesaError {
    #[msg("Parâmetros de política inválidos")]
    InvalidParams,
    #[msg("USDC e ativo de rendimento precisam ser mints diferentes")]
    SameMint,
    #[msg("Conta de preço não corresponde ao ativo de rendimento da política")]
    PriceFeedMismatch,
    #[msg("Política pausada")]
    Paused,
    #[msg("Valor deve ser maior que zero")]
    ZeroAmount,
    #[msg("Operação acima do teto por operação")]
    ExceedsMaxOp,
    #[msg("Saldo insuficiente no cofre")]
    InsufficientBalance,
    #[msg("Preço de referência inválido")]
    InvalidPrice,
    #[msg("Preço de referência velho")]
    StalePrice,
    #[msg("Saldos do cofre mudaram na direção errada")]
    UnexpectedBalanceChange,
    #[msg("Saída do cofre difere de amount_in")]
    AmountInMismatch,
    #[msg("Recebido abaixo de min_out")]
    BelowMinOut,
    #[msg("Preço efetivo desvia além do slippage máximo")]
    SlippageExceeded,
    #[msg("Alocação no ativo de rendimento acima do limite")]
    YieldCapExceeded,
    #[msg("Saldo de USDC abaixo do colchão mínimo")]
    BelowMinLiquidity,
    #[msg("Overflow aritmético")]
    MathOverflow,
}
