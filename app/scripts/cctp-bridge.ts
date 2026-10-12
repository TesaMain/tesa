// Transferência CCTP real: USDC de Ethereum Sepolia para uma conta USDC na Solana devnet.
//
//   npx tsx scripts/cctp-bridge.ts <amount USDC> [solana owner, padrão: carteira local]
//
// Usa a carteira Sepolia de ~/.config/tesa/sepolia-demo.json (ETH para gás + USDC de teste da Circle).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import type { Hex } from "viem";
import {
  CCTP,
  burnOnSepolia,
  createUsdcAccountIx,
  fastTransferMaxFee,
  receiveMessageIx,
  sepoliaBalances,
  usdcTokenAccount,
  waitForAttestation,
} from "../src/cctp";

const SOLANA_RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const amountArg = process.argv[2];
if (!amountArg) {
  console.error("usage: npx tsx scripts/cctp-bridge.ts <amount USDC> [solana owner]");
  process.exit(1);
}
const amount = BigInt(Math.round(Number(amountArg) * 1e6));
const evmKey = (JSON.parse(readFileSync(`${homedir()}/.config/tesa/sepolia-demo.json`, "utf8")) as { privateKey: Hex }).privateKey;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const owner = new PublicKey(process.argv[3] ?? payer.publicKey.toBase58());
const conn = new Connection(SOLANA_RPC, "confirmed");
const fmt = (u: bigint) => (Number(u) / 1e6).toFixed(6);
const t = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

async function usdcOnSolana(account: PublicKey) {
  const info = await conn.getAccountInfo(account, "confirmed");
  return info ? info.data.readBigUInt64LE(64) : null;
}

async function main() {
  const before = await sepoliaBalances(evmKey);
  console.log(`Sepolia ${before.address}: ${Number(before.eth) / 1e18} ETH, ${fmt(before.usdc)} USDC`);
  const recipient = usdcTokenAccount(owner);
  console.log(`Solana devnet recipient: owner ${owner.toBase58()} → USDC account ${recipient.toBase58()}`);

  if ((await usdcOnSolana(recipient)) === null) {
    const tx = new Transaction().add(createUsdcAccountIx(payer.publicKey, owner));
    const sig = await conn.sendTransaction(tx, [payer]);
    await conn.confirmTransaction(sig, "confirmed");
    console.log(`  created recipient USDC account: ${sig}`);
  }
  const startBal = (await usdcOnSolana(recipient)) ?? 0n;

  const t0 = Date.now();
  // RESUME=<hash do burn> retoma uma transferência já queimada e atestada (só falta o mint).
  let burnHash = process.env.RESUME;
  if (burnHash) {
    console.log(`\n1) Resuming burn ${CCTP.sepolia.explorerTx(burnHash)}`);
  } else {
    const { bps, maxFee } = await fastTransferMaxFee(amount);
    console.log(`\n1) Burn ${fmt(amount)} USDC on Sepolia (Fast Transfer, fee ${bps} bps, maxFee ${fmt(maxFee)})`);
    const burned = await burnOnSepolia(evmKey, amount, recipient, maxFee);
    if (burned.approveHash) console.log(`   approve: ${CCTP.sepolia.explorerTx(burned.approveHash)}`);
    burnHash = burned.burnHash;
    console.log(`   burn:    ${CCTP.sepolia.explorerTx(burnHash)}  (${t(t0)})`);
  }

  console.log(`2) Waiting for Circle's attestation…`);
  let last = "";
  const att = await waitForAttestation(burnHash, (s) => {
    if (s !== last) console.log(`   ${t(t0)} ${s}`);
    last = s;
  });
  console.log(`   attested (${t(t0)})`);

  console.log(`3) Mint on Solana devnet (receiveMessage)`);
  const tx = new Transaction().add(await receiveMessageIx(conn, payer.publicKey, att, recipient));
  const sig = await conn.sendTransaction(tx, [payer], { skipPreflight: false });
  await conn.confirmTransaction(sig, "confirmed");
  console.log(`   mint:    https://solscan.io/tx/${sig}?cluster=devnet  (${t(t0)})`);

  const endBal = (await usdcOnSolana(recipient)) ?? 0n;
  console.log(`\nRecipient USDC: ${fmt(startBal)} → ${fmt(endBal)} (+${fmt(endBal - startBal)}) in ${t(t0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
