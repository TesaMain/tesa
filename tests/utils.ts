import * as anchor from "@anchor-lang/core";

/**
 * O Surfpool do `anchor test` (modo "transaction") avança ~31 blocos por transação; o blockhash
 * que o web3.js guarda em cache por 30s expira em ~5 transações ("Blockhash not found").
 * Lá o cache é desligado. No solana-test-validator ele fica ligado: sem cache, o web3.js espera
 * um blockhash finalizado novo a cada transação, o que é lento e estoura logo após a subida.
 */
export async function fixBlockhashCache(conn: anchor.web3.Connection) {
  const version = (await conn.getVersion()) as Record<string, unknown>;
  if (version["surfnet-version"]) {
    (conn as any)._disableBlockhashCaching = true;
  }
}
