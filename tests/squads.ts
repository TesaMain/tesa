import * as anchor from "@anchor-lang/core";
import { BN, BorshCoder, EventParser, Program } from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import { createMint, getAccount, getOrCreateAssociatedTokenAccount, mintTo, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { TesaPolicy } from "../target/types/tesa_policy";
import { MockSwap } from "../target/types/mock_swap";
import { fixBlockhashCache } from "./utils";

const { PublicKey, Keypair, SystemProgram, Transaction, TransactionMessage, ComputeBudgetProgram } = anchor.web3;
type PublicKeyT = anchor.web3.PublicKey;
type KeypairT = anchor.web3.Keypair;
type IxT = anchor.web3.TransactionInstruction;
const { Permission, Permissions } = multisig.types;

// M2: o vault agora é o vault PDA de um multisig Squads v4 (seção 3.1 do CLAUDE.md).
// A chave da Tesa só propõe; CFO e Controller aprovam (2 de 2) e um deles executa.
// A transação interna é a da seção 3.5: begin_op → swap → end_op, executada via CPI da Squads.

const USDC = (n: number) => new BN(n).mul(new BN(1_000_000));
const E9 = new BN(1_000_000_000);
const BPS = new BN(10_000);
const PRICE_114 = new BN(1_140_000_000);
const HAIRCUT_BPS = 20;

const BASE_PARAMS = {
  maxYieldBps: 7000,
  minLiquidUsdc: USDC(10_000),
  maxOpUsdc: USDC(50_000),
  maxSlippageBps: 100,
  maxPriceAgeSecs: 3600,
};

describe("squads (M2)", () => {
  const envProvider = anchor.AnchorProvider.env();
  // Ver tesa_policy.ts: conexão em "confirmed" por causa dos helpers do spl-token.
  const connection = new anchor.web3.Connection(envProvider.connection.rpcEndpoint, "confirmed");
  const provider = new anchor.AnchorProvider(connection, envProvider.wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  const conn = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const policyProgram = anchor.workspace.TesaPolicy as Program<TesaPolicy>;
  const swapProgram = anchor.workspace.MockSwap as Program<MockSwap>;
  const eventParser = new EventParser(policyProgram.programId, new BorshCoder(policyProgram.idl));

  const cfo = Keypair.generate();
  const controller = Keypair.generate();
  const tesaKey = Keypair.generate();
  const createKey = Keypair.generate();
  const usdyMintKp = Keypair.generate();

  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vault] = multisig.getVaultPda({ multisigPda, index: 0 });

  const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKeyT) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  const usdyMint = usdyMintKp.publicKey;
  const swapConfig = pda([Buffer.from("config"), usdyMint.toBuffer()], swapProgram.programId);
  const reserveUsdc = pda([Buffer.from("reserve"), swapConfig.toBuffer()], swapProgram.programId);
  const policy = pda([Buffer.from("policy"), vault.toBuffer()], policyProgram.programId);
  const position = pda([Buffer.from("position"), vault.toBuffer()], policyProgram.programId);
  const priceFeed = pda(
    [Buffer.from("price_feed"), usdyMint.toBuffer(), payer.publicKey.toBuffer()],
    policyProgram.programId
  );
  const opReceipt = (nonce: BN) =>
    pda([Buffer.from("op"), vault.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)], policyProgram.programId);

  let usdcMint: PublicKeyT;
  let vaultUsdc: PublicKeyT;
  let vaultUsdy: PublicKeyT;

  // ---------- helpers da política ----------

  const balances = async () => ({
    usdc: new BN((await getAccount(conn, vaultUsdc)).amount.toString()),
    usdy: new BN((await getAccount(conn, vaultUsdy)).amount.toString()),
  });
  const fetchPolicy = () => policyProgram.account.policy.fetch(policy);
  const fetchPosition = () => policyProgram.account.position.fetch(position);
  const allocOut = (amountIn: BN, price = PRICE_114, haircut = HAIRCUT_BPS) =>
    amountIn.mul(E9).div(price).mul(BPS.subn(haircut)).div(BPS);
  const redeemOut = (amountIn: BN, price = PRICE_114, haircut = HAIRCUT_BPS) =>
    amountIn.mul(price).div(E9).mul(BPS.subn(haircut)).div(BPS);

  const setSwap = (price: BN, haircut: number) =>
    swapProgram.methods.setParams(price, haircut).accountsPartial({ admin: payer.publicKey, config: swapConfig }).rpc();

  /** begin_op → swap → end_op, com o vault PDA da Squads como signer. */
  const opIxs = async (dir: "allocate" | "redeem", amountIn: BN, minOut: BN): Promise<IxT[]> => {
    const { opNonce } = await fetchPolicy();
    const receipt = opReceipt(opNonce);
    const tokens = { usdcMint, yieldMint: usdyMint, vaultUsdc, vaultUsdy, priceFeed };
    return [
      await policyProgram.methods
        .beginOp(dir === "allocate" ? { allocate: {} } : { redeem: {} }, amountIn, minOut)
        .accountsPartial({ vault, policy, opReceipt: receipt, ...tokens, systemProgram: SystemProgram.programId })
        .instruction(),
      await swapProgram.methods
        .swap(dir === "allocate", amountIn)
        .accountsPartial({
          user: vault,
          config: swapConfig,
          reserveUsdc,
          usdyMint,
          userUsdc: vaultUsdc,
          userUsdy: vaultUsdy,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
      await policyProgram.methods
        .endOp()
        .accountsPartial({ vault, policy, position, opReceipt: receipt, ...tokens })
        .instruction(),
    ];
  };

  // ---------- helpers da Squads ----------

  const sendAs = (ixs: IxT[], signers: KeypairT[]) =>
    anchor.web3.sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

  const nextIndex = async () => {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda, "confirmed");
    return BigInt(ms.transactionIndex.toString()) + 1n;
  };

  /** A chave da Tesa (só Initiate) cria a vault transaction e a proposta numa transação. */
  const propose = async (ixs: IxT[], memo: string) => {
    const transactionIndex = await nextIndex();
    const transactionMessage = new TransactionMessage({
      payerKey: vault,
      recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
      instructions: ixs,
    });
    await sendAs(
      [
        multisig.instructions.vaultTransactionCreate({
          multisigPda,
          transactionIndex,
          creator: tesaKey.publicKey,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionMessage,
          memo,
        }),
        multisig.instructions.proposalCreate({ multisigPda, transactionIndex, creator: tesaKey.publicKey }),
      ],
      [tesaKey]
    );
    return transactionIndex;
  };

  const approve = (member: KeypairT, transactionIndex: bigint) =>
    sendAs([multisig.instructions.proposalApprove({ multisigPda, transactionIndex, member: member.publicKey })], [member]);

  const cancel = (member: KeypairT, transactionIndex: bigint) =>
    sendAs([multisig.instructions.proposalCancelV2({ multisigPda, transactionIndex, member: member.publicKey })], [member]);

  /** Execução: o compute budget fica na transação externa (não pode ir dentro da vault transaction). */
  const execute = async (member: KeypairT, transactionIndex: bigint) => {
    const { instruction } = await multisig.instructions.vaultTransactionExecute({
      connection: conn,
      multisigPda,
      transactionIndex,
      member: member.publicKey,
    });
    return sendAs([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), instruction], [member]);
  };

  const proposalStatus = async (transactionIndex: bigint) => {
    const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex });
    return (await multisig.accounts.Proposal.fromAccountAddress(conn, proposalPda, "confirmed")).status.__kind;
  };

  /** Proposta → 2 aprovações → execução pelo CFO. Devolve a assinatura da execução. */
  const proposeApproveExecute = async (ixs: IxT[], memo: string) => {
    const idx = await propose(ixs, memo);
    await approve(cfo, idx);
    await approve(controller, idx);
    return { idx, sig: await execute(cfo, idx) };
  };

  const errorText = async (e: any): Promise<string> => {
    let logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
    if (!logs.length && typeof e?.getLogs === "function") {
      logs = (await e.getLogs(conn).catch(() => [])) ?? [];
    }
    return `${e?.message ?? e}\n${logs.join("\n")}`;
  };

  const expectError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e) {
      const text = await errorText(e);
      assert.include(text, `Error Code: ${code}`, `esperava ${code}, veio:\n${text}`);
      return;
    }
    assert.fail(`esperava falha com ${code}, mas a transação passou`);
  };

  const opEvents = async (sig: string) => {
    const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return [...eventParser.parseLogs(tx?.meta?.logMessages ?? [])].filter(
      (ev) => ev.name.toLowerCase() === "opexecuted"
    );
  };

  // ---------- setup ----------

  before(async () => {
    await fixBlockhashCache(conn);
    // Valores modestos para rodar também na devnet: humanos só pagam taxas; a chave da Tesa
    // paga o aluguel das vault transactions e propostas.
    const fund = (to: PublicKeyT, sol: number) =>
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: sol * 1e9 });
    await sendAs([fund(cfo.publicKey, 0.02), fund(controller.publicKey, 0.02), fund(tesaKey.publicKey, 0.15)], [payer]);

    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
    await sendAs(
      [
        multisig.instructions.multisigCreateV2({
          treasury: programConfig.treasury,
          creator: payer.publicKey,
          multisigPda,
          configAuthority: null,
          threshold: 2,
          members: [
            { key: cfo.publicKey, permissions: Permissions.all() },
            { key: controller.publicKey, permissions: Permissions.all() },
            { key: tesaKey.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate]) },
          ],
          timeLock: 0,
          createKey: createKey.publicKey,
          rentCollector: null,
        }),
        // SOL no vault: ele paga o aluguel de Policy, Position e OpReceipt.
        fund(vault, 0.05),
      ],
      [payer, createKey]
    );

    usdcMint = await createMint(conn, payer, payer.publicKey, null, 6);
    await createMint(conn, payer, swapConfig, payer.publicKey, 6, usdyMintKp);
    // As ATAs do vault são criadas no onboarding (README, decisão 3). O dono é um PDA (off-curve).
    vaultUsdc = (await getOrCreateAssociatedTokenAccount(conn, payer, usdcMint, vault, true)).address;
    vaultUsdy = (await getOrCreateAssociatedTokenAccount(conn, payer, usdyMint, vault, true)).address;
    await mintTo(conn, payer, usdcMint, vaultUsdc, payer, BigInt(USDC(100_000).toString()));

    await swapProgram.methods
      .initialize(PRICE_114, HAIRCUT_BPS)
      .accountsPartial({
        admin: payer.publicKey,
        config: swapConfig,
        reserveUsdc,
        usdcMint,
        usdyMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await mintTo(conn, payer, usdcMint, reserveUsdc, payer, BigInt(USDC(1_000_000).toString()));

    const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
    await policyProgram.methods
      .initPriceFeed(PRICE_114, new BN((t ?? Math.floor(Date.now() / 1000)) - 5))
      .accountsPartial({ authority: payer.publicKey, priceFeed, yieldMint: usdyMint })
      .rpc();
  });

  // ---------- multisig ----------

  it("multisig tem as permissões da seção 3.1 (2 de 2; Tesa só Initiate)", async () => {
    const ms = await multisig.accounts.Multisig.fromAccountAddress(conn, multisigPda);
    assert.equal(ms.threshold, 2);
    const perms = (k: PublicKeyT) => ms.members.find((m) => m.key.equals(k))!.permissions;
    for (const human of [cfo, controller]) {
      for (const p of [Permission.Initiate, Permission.Vote, Permission.Execute]) {
        assert.isTrue(Permissions.has(perms(human.publicKey), p));
      }
    }
    assert.isTrue(Permissions.has(perms(tesaKey.publicKey), Permission.Initiate));
    assert.isFalse(Permissions.has(perms(tesaKey.publicKey), Permission.Vote));
    assert.isFalse(Permissions.has(perms(tesaKey.publicKey), Permission.Execute));
  });

  it("initialize_policy via vault transaction: o vault PDA é a autoridade", async () => {
    const ix = await policyProgram.methods
      .initializePolicy(BASE_PARAMS)
      .accountsPartial({ vault, policy, position, usdcMint, yieldMint: usdyMint, priceFeed })
      .instruction();
    const { idx } = await proposeApproveExecute([ix], "initialize_policy");

    assert.equal(await proposalStatus(idx), "Executed");
    const p = await fetchPolicy();
    assert.ok(p.vault.equals(vault));
    assert.ok(p.maxOpUsdc.eq(USDC(50_000)));
  });

  // ---------- quem pode o quê ----------

  it("a chave da Tesa propõe, mas não aprova nem executa", async () => {
    const ix = await policyProgram.methods.setPaused(false).accountsPartial({ vault, policy }).instruction();
    const idx = await propose([ix], "teste de permissoes");
    await expectError(approve(tesaKey, idx), "Unauthorized");

    await approve(cfo, idx);
    await approve(controller, idx);
    assert.equal(await proposalStatus(idx), "Approved");
    await expectError(execute(tesaKey, idx), "Unauthorized");

    await cancel(cfo, idx);
    await cancel(controller, idx);
    assert.equal(await proposalStatus(idx), "Cancelled");
  });

  it("com 1 de 2 aprovações a proposta não executa", async () => {
    const ix = await policyProgram.methods.setPaused(true).accountsPartial({ vault, policy }).instruction();
    const idx = await propose([ix], "pausar");
    await approve(cfo, idx);
    assert.equal(await proposalStatus(idx), "Active");
    await expectError(execute(cfo, idx), "InvalidProposalStatus");
    assert.isFalse((await fetchPolicy()).paused);

    // Uma rejeição já impede o 2 de 2: a proposta fica Rejected.
    await sendAs(
      [multisig.instructions.proposalReject({ multisigPda, transactionIndex: idx, member: controller.publicKey })],
      [controller]
    );
    assert.equal(await proposalStatus(idx), "Rejected");
  });

  // ---------- operações ----------

  it("alocação begin_op → swap → end_op executada pelo vault da Squads", async () => {
    const amountIn = USDC(20_000);
    const expected = allocOut(amountIn);
    const before = await balances();

    const { idx, sig } = await proposeApproveExecute(await opIxs("allocate", amountIn, expected), "alocacao 20000");

    assert.equal(await proposalStatus(idx), "Executed");
    const after = await balances();
    assert.ok(before.usdc.sub(after.usdc).eq(amountIn));
    assert.ok(after.usdy.sub(before.usdy).eq(expected));

    const pos = await fetchPosition();
    assert.ok(pos.usdyUnits.eq(expected));
    assert.ok(pos.costBasisUsdc.eq(amountIn));
    assert.ok((await fetchPolicy()).opNonce.eqn(1));
    assert.isNull(await conn.getAccountInfo(opReceipt(new BN(0))), "OpReceipt ficou aberto");

    // O evento é emitido dentro da CPI da Squads e continua legível nos logs da execução.
    const events = await opEvents(sig);
    assert.lengthOf(events, 1);
    assert.ok(events[0].data.vault.equals(vault));
    assert.ok(events[0].data.amountOut.eq(expected));
  });

  it("alocação acima do teto falha on-chain mesmo aprovada, e nada muda", async () => {
    const before = await balances();
    const { opNonce } = await fetchPolicy();
    const amountIn = USDC(60_000); // max_op_usdc = 50.000

    const idx = await propose(await opIxs("allocate", amountIn, allocOut(amountIn)), "alocacao 60000");
    await approve(cfo, idx);
    await approve(controller, idx);
    await expectError(execute(cfo, idx), "ExceedsMaxOp");

    const after = await balances();
    assert.ok(after.usdc.eq(before.usdc) && after.usdy.eq(before.usdy), "saldos mudaram");
    assert.ok((await fetchPolicy()).opNonce.eq(opNonce));
    assert.equal(await proposalStatus(idx), "Approved");

    // Seção 4: o backend cancela a proposta (com os votos dos humanos) e cria outra.
    await cancel(cfo, idx);
    await cancel(controller, idx);
    assert.equal(await proposalStatus(idx), "Cancelled");
  });

  it("cotação piora entre aprovação e execução: end_op reverte o swap (SlippageExceeded)", async () => {
    const before = await balances();
    const amountIn = USDC(5_000);
    const idx = await propose(await opIxs("allocate", amountIn, new BN(1)), "alocacao 5000");
    await approve(cfo, idx);
    await approve(controller, idx);

    await setSwap(PRICE_114, 300); // 3% de haircut > max_slippage_bps (1%)
    try {
      await expectError(execute(controller, idx), "SlippageExceeded");
    } finally {
      await setSwap(PRICE_114, HAIRCUT_BPS);
    }
    const after = await balances();
    assert.ok(after.usdc.eq(before.usdc) && after.usdy.eq(before.usdy), "swap não foi revertido");
    await cancel(cfo, idx);
    await cancel(controller, idx);
  });

  it("resgate USDY → USDC via vault transaction realiza o resultado", async () => {
    const pos0 = await fetchPosition();
    const amountIn = pos0.usdyUnits.divn(2);
    const expected = redeemOut(amountIn);
    const before = await balances();

    const { sig } = await proposeApproveExecute(await opIxs("redeem", amountIn, expected), "resgate");

    const after = await balances();
    assert.ok(before.usdy.sub(after.usdy).eq(amountIn));
    assert.ok(after.usdc.sub(before.usdc).eq(expected));
    const pos = await fetchPosition();
    assert.ok(pos.usdyUnits.eq(pos0.usdyUnits.sub(amountIn)));
    const costOut = pos0.costBasisUsdc.mul(amountIn).div(pos0.usdyUnits);
    assert.ok(pos.realizedPnlUsdc.eq(expected.sub(costOut)));
    assert.lengthOf(await opEvents(sig), 1);
  });

  it("proposta antiga com nonce desatualizado não executa", async () => {
    // Duas propostas montadas com o mesmo op_nonce: a segunda fica inválida após a primeira.
    const a = await propose(await opIxs("allocate", USDC(1_000), new BN(1)), "op A");
    const b = await propose(await opIxs("allocate", USDC(1_000), new BN(1)), "op B");
    for (const idx of [a, b]) {
      await approve(cfo, idx);
      await approve(controller, idx);
    }
    await execute(cfo, a);
    await expectError(execute(cfo, b), "ConstraintSeeds");
    await cancel(cfo, b);
    await cancel(controller, b);
  });
});
