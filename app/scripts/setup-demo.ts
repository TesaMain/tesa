// Cria o cofre de demonstração do painel numa rede pública:
// multisig Squads v4 com as permissões da seção 3.1, USDY e swap simulados, preço de referência,
// política inicializada pelo vault e uma alocação de histórico. Grava src/demo-config.json.
//
//   MODE=cctp npx tsx scripts/setup-demo.ts   devnet; USDC real da Circle chega ao cofre via CCTP
//                                             (Sepolia → Solana), com a carteira de
//                                             ~/.config/tesa/sepolia-demo.json
//   npx tsx scripts/setup-demo.ts             testnet; USDC simulado (100.000)
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as multisig from "@sqds/multisig";
import { BN } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type TransactionInstruction as Ix,
} from "@solana/web3.js";
import type { Hex } from "viem";
import { TesaDemo, TOKEN_PROGRAM_ID, minOutFor, quoteOut, toUnits, fmt, type DemoConfig, type Role, type TxResult } from "../src/chain";
import { CCTP, burnOnSepolia, fastTransferMaxFee, receiveMessageIx, waitForAttestation } from "../src/cctp";

const CCTP_MODE = process.env.MODE === "cctp";
const RPC_URL = process.env.RPC_URL ?? (CCTP_MODE ? "https://api.devnet.solana.com" : "https://api.testnet.solana.com");
const CLUSTER = process.env.CLUSTER ?? (CCTP_MODE ? "devnet" : "testnet");
const OUT = process.env.OUT ?? "src/demo-config.json";
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// Com USDC real (CCTP) os valores são os que o faucet da Circle permite; a política escala junto.
const SCALE = CCTP_MODE
  ? { vault: 20, reserveSeed: 0.9, minLiquid: 2, maxOp: 10, history: 5 }
  : { vault: 100_000, reserveSeed: 5_000_000, minLiquid: 10_000, maxOp: 50_000, history: 30_000 };
const usd = (n: number) => new BN(toUnits(n).toString());

const PRICE_START = 1_120_000_000n; // NAV de US$1,12 na alocação de histórico
const PRICE_NOW = 1_141_000_000n; // NAV publicado depois: o rendimento aparece no painel
const HAIRCUT_BPS = 20;
const POLICY = {
  maxYieldBps: 7000,
  minLiquidUsdc: usd(SCALE.minLiquid),
  maxOpUsdc: usd(SCALE.maxOp),
  maxSlippageBps: 100,
  maxPriceAgeSecs: 3600,
};
const sepoliaKey = CCTP_MODE
  ? (JSON.parse(readFileSync(`${homedir()}/.config/tesa/sepolia-demo.json`, "utf8")) as { privateKey: Hex }).privateKey
  : undefined;

const conn = new Connection(RPC_URL, "confirmed");
const funder = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR ?? `${homedir()}/.config/solana/id.json`, "utf8")))
);

const step = (msg: string) => console.log(`\n▸ ${msg}`);
const must = (r: TxResult, what: string) => {
  if (!r.ok) throw new Error(`${what} failed: ${r.error}\n${r.logs.join("\n")}`);
  console.log(`  ✓ ${what} (${(r.ms / 1000).toFixed(1)}s) ${r.signature}`);
  return r;
};

const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];

const createAtaIx = (payer: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });

async function createMintIxs(payer: PublicKey, mint: PublicKey, authority: PublicKey): Promise<Ix[]> {
  const data = Buffer.alloc(67);
  data.writeUInt8(20, 0); // InitializeMint2
  data.writeUInt8(6, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // sem freeze authority
  return [
    SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: mint,
      lamports: await conn.getMinimumBalanceForRentExemption(82),
      space: 82,
      programId: TOKEN_PROGRAM_ID,
    }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data }),
  ];
}

const transferIx = (from: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint) => {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // Transfer
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
};

const mintToIx = (mint: PublicKey, to: PublicKey, authority: PublicKey, amount: bigint) => {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
};

async function main() {
  console.log(`Cluster ${CLUSTER} (${RPC_URL}); funder ${funder.publicKey.toBase58()}: ${(await conn.getBalance(funder.publicKey)) / 1e9} SOL`);

  const keys = {
    tesa: Keypair.generate(),
    cfo: Keypair.generate(),
    controller: Keypair.generate(),
    operator: Keypair.generate(),
  } satisfies Record<Role, Keypair>;
  const createKey = Keypair.generate();
  const usdcMintKp = Keypair.generate();
  const usdyMintKp = Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });
  const usdcMint = CCTP_MODE ? CCTP.solana.usdcMint : usdcMintKp.publicKey;
  const usdyMint = usdyMintKp.publicKey;

  // Endereços derivados antes de criar qualquer coisa: o cliente do painel já pode ser montado.
  const policyPid = new PublicKey((await import("../src/idl/tesa_policy.json")).default.address);
  const swapPid = new PublicKey((await import("../src/idl/mock_swap.json")).default.address);
  const pda = (seeds: Buffer[], pid: PublicKey) => PublicKey.findProgramAddressSync(seeds, pid)[0];
  const swapConfig = pda([Buffer.from("config"), usdyMint.toBuffer()], swapPid);
  const cfg: DemoConfig = {
    cluster: CLUSTER,
    rpcUrl: RPC_URL,
    createdAt: new Date().toISOString(),
    multisig: multisigPda.toBase58(),
    vault: vault.toBase58(),
    usdcMint: usdcMint.toBase58(),
    usdyMint: usdyMint.toBase58(),
    vaultUsdc: ata(vault, usdcMint).toBase58(),
    vaultUsdy: ata(vault, usdyMint).toBase58(),
    swapConfig: swapConfig.toBase58(),
    reserveUsdc: pda([Buffer.from("reserve"), swapConfig.toBuffer()], swapPid).toBase58(),
    priceFeed: pda([Buffer.from("price_feed"), usdyMint.toBuffer(), keys.operator.publicKey.toBuffer()], policyPid).toBase58(),
    policy: pda([Buffer.from("policy"), vault.toBuffer()], policyPid).toBase58(),
    position: pda([Buffer.from("position"), vault.toBuffer()], policyPid).toBase58(),
    keys: Object.fromEntries(Object.entries(keys).map(([r, k]) => [r, Array.from(k.secretKey)])) as Record<Role, number[]>,
    ...(sepoliaKey ? { sepoliaKey } : {}),
  };
  // Grava antes de qualquer transação: se algo falhar no meio, as chaves não se perdem.
  writeFileSync(OUT, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`Config (keys included) written to ${OUT}`);
  const demo = new TesaDemo(cfg, conn);
  const op = keys.operator.publicKey;

  step("Funding demo keys and creating the Squads multisig (CFO + Controller: all; Tesa: Initiate only; 2 of 2)");
  const fund = (to: PublicKey, sol: number) =>
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: Math.round(sol * 1e9) });
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
  const { Permission, Permissions } = multisig.types;
  must(
    await demo.send(
      [
        fund(keys.tesa.publicKey, 0.5),
        fund(keys.cfo.publicKey, 0.1),
        fund(keys.controller.publicKey, 0.1),
        fund(op, 0.3),
        fund(vault, 0.1),
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury,
          creator: funder.publicKey,
          multisigPda,
          configAuthority: null,
          threshold: 2,
          members: [
            { key: keys.cfo.publicKey, permissions: Permissions.all() },
            { key: keys.controller.publicKey, permissions: Permissions.all() },
            { key: keys.tesa.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate]) },
          ],
          timeLock: 0,
          createKey: createKey.publicKey,
          // O aluguel de propostas fechadas volta para a chave da Tesa, que o paga.
          rentCollector: keys.tesa.publicKey,
        }),
      ],
      [funder, createKey]
    ),
    "multisig created"
  );

  if (CCTP_MODE) {
    step("Simulated USDY mint and the vault's token accounts (USDC is Circle's devnet USDC)");
    must(
      await demo.send(
        [...(await createMintIxs(op, usdyMint, swapConfig)), createAtaIx(op, vault, usdcMint), createAtaIx(op, vault, usdyMint)],
        [keys.operator, usdyMintKp]
      ),
      "USDY mint + vault ATAs"
    );
  } else {
    step("Simulated USDC and USDY, vault token accounts, 100,000 USDC in the vault");
    must(
      await demo.send(
        [
          ...(await createMintIxs(op, usdcMint, op)),
          ...(await createMintIxs(op, usdyMint, swapConfig)),
          createAtaIx(op, vault, usdcMint),
          createAtaIx(op, vault, usdyMint),
          mintToIx(usdcMint, ata(vault, usdcMint), op, toUnits(SCALE.vault)),
        ],
        [keys.operator, usdcMintKp, usdyMintKp]
      ),
      "mints + vault ATAs"
    );
  }

  step("Simulated market (mock swap) and the USDY reference price");
  const now = await demo.chainTime();
  must(
    await demo.send(
      [
        await demo.swapProgram.methods
          .initialize(new BN(PRICE_START.toString()), HAIRCUT_BPS)
          .accountsPartial({
            admin: op,
            config: swapConfig,
            reserveUsdc: demo.pk.reserveUsdc,
            usdcMint,
            usdyMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction(),
        ...(CCTP_MODE ? [] : [mintToIx(usdcMint, demo.pk.reserveUsdc, op, toUnits(SCALE.reserveSeed))]),
        await demo.policyProgram.methods
          .initPriceFeed(new BN(PRICE_START.toString()), new BN(now - 2))
          .accountsPartial({ authority: op, priceFeed: demo.pk.priceFeed, yieldMint: usdyMint })
          .instruction(),
      ],
      [keys.operator]
    ),
    "mock swap + price feed"
  );

  if (CCTP_MODE) {
    // A reserva do swap simulado paga os resgates; começa com USDC real já trazido para a carteira local.
    step(`Seeding the simulated market's reserve with ${SCALE.reserveSeed} real USDC from the local wallet`);
    must(
      await demo.send([transferIx(ata(funder.publicKey, usdcMint), demo.pk.reserveUsdc, funder.publicKey, toUnits(SCALE.reserveSeed))], [funder]),
      "reserve seeded"
    );

    step(`Real Circle CCTP: ${SCALE.vault} USDC from Ethereum Sepolia into the vault on Solana devnet`);
    const t0 = Date.now();
    const amount = toUnits(SCALE.vault);
    const { maxFee } = await fastTransferMaxFee(amount);
    const { burnHash } = await burnOnSepolia(sepoliaKey!, amount, ata(vault, usdcMint), maxFee);
    console.log(`  ✓ burned on Sepolia (${((Date.now() - t0) / 1000).toFixed(1)}s) ${CCTP.sepolia.explorerTx(burnHash)}`);
    const att = await waitForAttestation(burnHash);
    console.log(`  ✓ attested by Circle (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    must(await demo.send([await receiveMessageIx(conn, funder.publicKey, att, ata(vault, usdcMint))], [funder]), "minted into the vault");
  }

  const flow = async (ixs: Ix[], memo: string) => {
    const p = await demo.propose(ixs, memo);
    const idx = p.index;
    must(p, `#${idx} "${memo}" proposed by the Tesa key`);
    must(await demo.vote("cfo", idx, "approve"), `#${idx} approved by CFO`);
    must(await demo.vote("controller", idx, "approve"), `#${idx} approved by Controller`);
    must(await demo.execute("cfo", idx), `#${idx} executed by CFO`);
  };

  step("initialize_policy through the vault (propose → 2 approvals → execute)");
  await flow(
    [
      await demo.policyProgram.methods
        .initializePolicy(POLICY)
        .accountsPartial({
          vault,
          policy: demo.pk.policy,
          position: demo.pk.position,
          usdcMint,
          yieldMint: usdyMint,
          priceFeed: demo.pk.priceFeed,
        })
        .instruction(),
    ],
    "Initialize the policy"
  );

  step(`History: allocate ${SCALE.history.toLocaleString("en-US")} USDC at NAV 1.12, then the NAV rises to 1.141`);
  const amount = toUnits(SCALE.history);
  const quote = quoteOut("allocate", amount, PRICE_START, BigInt(HAIRCUT_BPS));
  await flow(await demo.opIxs("allocate", amount, minOutFor(quote)), `Allocate ${SCALE.history} USDC`);
  must(await demo.publishNav(PRICE_NOW), "NAV published at 1.141");

  const s = await demo.state();
  console.log(`\nVault: ${fmt(s.usdc)} USDC + ${fmt(s.usdy)} USDY · cost basis ${fmt(s.position.costBasisUsdc)} · nonce ${s.policy.opNonce}`);
  console.log(`\nDemo ready (${OUT})\nMultisig ${cfg.multisig}\nVault    ${cfg.vault}`);
  console.log(`Funder balance left: ${(await conn.getBalance(funder.publicKey)) / 1e9} SOL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
