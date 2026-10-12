// Cria o cofre de demonstração do painel numa rede pública (testnet por padrão):
// multisig Squads v4 com as permissões da seção 3.1, USDC/USDY simulados, swap simulado,
// preço de referência, política inicializada pelo vault e uma alocação de histórico.
// Grava src/demo-config.json, que o painel lê.
//
//   RPC_URL=https://api.testnet.solana.com CLUSTER=testnet npx tsx scripts/setup-demo.ts
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
import { TesaDemo, TOKEN_PROGRAM_ID, minOutFor, quoteOut, toUnits, fmt, type DemoConfig, type Role, type TxResult } from "../src/chain";

const RPC_URL = process.env.RPC_URL ?? "https://api.testnet.solana.com";
const CLUSTER = process.env.CLUSTER ?? "testnet";
const OUT = process.env.OUT ?? "src/demo-config.json";
const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const PRICE_START = 1_120_000_000n; // NAV de US$1,12 na alocação de histórico
const PRICE_NOW = 1_141_000_000n; // NAV publicado depois: o rendimento aparece no painel
const HAIRCUT_BPS = 20;
const POLICY = {
  maxYieldBps: 7000,
  minLiquidUsdc: new BN(toUnits(10_000).toString()),
  maxOpUsdc: new BN(toUnits(50_000).toString()),
  maxSlippageBps: 100,
  maxPriceAgeSecs: 3600,
};

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
  const usdcMint = usdcMintKp.publicKey;
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

  step("Simulated USDC and USDY, vault token accounts, 100,000 USDC in the vault");
  must(
    await demo.send(
      [
        ...(await createMintIxs(op, usdcMint, op)),
        ...(await createMintIxs(op, usdyMint, swapConfig)),
        createAtaIx(op, vault, usdcMint),
        createAtaIx(op, vault, usdyMint),
        mintToIx(usdcMint, ata(vault, usdcMint), op, toUnits(100_000)),
      ],
      [keys.operator, usdcMintKp, usdyMintKp]
    ),
    "mints + vault ATAs"
  );

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
        mintToIx(usdcMint, demo.pk.reserveUsdc, op, toUnits(5_000_000)),
        await demo.policyProgram.methods
          .initPriceFeed(new BN(PRICE_START.toString()), new BN(now - 2))
          .accountsPartial({ authority: op, priceFeed: demo.pk.priceFeed, yieldMint: usdyMint })
          .instruction(),
      ],
      [keys.operator]
    ),
    "mock swap + price feed"
  );

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

  step("History: allocate 30,000 USDC at NAV 1.12, then the NAV rises to 1.141");
  const amount = toUnits(30_000);
  const quote = quoteOut("allocate", amount, PRICE_START, BigInt(HAIRCUT_BPS));
  await flow(await demo.opIxs("allocate", amount, minOutFor(quote)), "Allocate 30,000 USDC");
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
