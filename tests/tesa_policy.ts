import * as anchor from "@anchor-lang/core";
import { BN, BorshCoder, EventParser, Program } from "@anchor-lang/core";
import {
  createMint,
  createTransferInstruction,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { TesaPolicy } from "../target/types/tesa_policy";
import { MockSwap } from "../target/types/mock_swap";
import { fixBlockhashCache } from "./utils";

const { PublicKey, Keypair, SystemProgram, Transaction } = anchor.web3;
type PublicKeyT = anchor.web3.PublicKey;
type IxT = anchor.web3.TransactionInstruction;

// M1: o "vault" é um Keypair que faz o papel do vault PDA da Squads (M2 troca pela Squads).
// Todas as operações seguem a forma da seção 3.5: begin_op → swap → end_op, lado a lado.

const USDC = (n: number) => new BN(n).mul(new BN(1_000_000));
const E9 = new BN(1_000_000_000);
const BPS = new BN(10_000);
const PRICE_114 = new BN(1_140_000_000); // US$1,14
const PRICE_115 = new BN(1_150_000_000);
const HAIRCUT_BPS = 20; // slippage simulado de 0,2%

const BASE_PARAMS = {
  maxYieldBps: 7000,
  minLiquidUsdc: USDC(10_000),
  maxOpUsdc: USDC(50_000),
  maxSlippageBps: 100,
  maxPriceAgeSecs: 3600,
};

describe("tesa_policy", () => {
  const envProvider = anchor.AnchorProvider.env();
  // Conexão em "confirmed" para que os helpers do spl-token (que confirmam no commitment da
  // conexão) não corram contra a simulação "confirmed" das transações seguintes.
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

  const vault = Keypair.generate();
  const usdyMintKp = Keypair.generate();
  const staleOracle = Keypair.generate();

  const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKeyT) =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  const usdyMint = usdyMintKp.publicKey;
  const swapConfig = pda([Buffer.from("config"), usdyMint.toBuffer()], swapProgram.programId);
  const reserveUsdc = pda([Buffer.from("reserve"), swapConfig.toBuffer()], swapProgram.programId);
  const policy = pda([Buffer.from("policy"), vault.publicKey.toBuffer()], policyProgram.programId);
  const position = pda([Buffer.from("position"), vault.publicKey.toBuffer()], policyProgram.programId);
  const priceFeed = pda(
    [Buffer.from("price_feed"), usdyMint.toBuffer(), payer.publicKey.toBuffer()],
    policyProgram.programId
  );
  const stalePriceFeed = pda(
    [Buffer.from("price_feed"), usdyMint.toBuffer(), staleOracle.publicKey.toBuffer()],
    policyProgram.programId
  );
  const opReceipt = (nonce: BN) =>
    pda(
      [Buffer.from("op"), vault.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      policyProgram.programId
    );

  let usdcMint: PublicKeyT;
  let vaultUsdc: PublicKeyT;
  let vaultUsdy: PublicKeyT;
  let swapPrice = PRICE_114;
  let swapHaircut = HAIRCUT_BPS;

  // ---------- helpers ----------

  const chainNow = async () => {
    const t = await conn.getBlockTime(await conn.getSlot("confirmed"));
    return t ?? Math.floor(Date.now() / 1000);
  };

  const balances = async () => ({
    usdc: new BN((await getAccount(conn, vaultUsdc)).amount.toString()),
    usdy: new BN((await getAccount(conn, vaultUsdy)).amount.toString()),
  });

  const fetchPolicy = () => policyProgram.account.policy.fetch(policy);
  const fetchPosition = () => policyProgram.account.position.fetch(position);

  const allocOut = (amountIn: BN) =>
    amountIn.mul(E9).div(swapPrice).mul(BPS.subn(swapHaircut)).div(BPS);
  const redeemOut = (amountIn: BN) =>
    amountIn.mul(swapPrice).div(E9).mul(BPS.subn(swapHaircut)).div(BPS);

  const setSwap = async (price: BN, haircut: number) => {
    await swapProgram.methods
      .setParams(price, haircut)
      .accountsPartial({ admin: payer.publicKey, config: swapConfig })
      .rpc();
    swapPrice = price;
    swapHaircut = haircut;
  };

  const updatePolicy = (params: typeof BASE_PARAMS, feed = priceFeed, signer = vault) =>
    policyProgram.methods
      .updatePolicy(params)
      .accountsPartial({ vault: signer.publicKey, policy, priceFeed: feed })
      .signers([signer])
      .rpc();

  const beginIx = async (dir: "allocate" | "redeem", amountIn: BN, minOut: BN, feed = priceFeed) => {
    const { opNonce } = await fetchPolicy();
    return policyProgram.methods
      .beginOp(dir === "allocate" ? { allocate: {} } : { redeem: {} }, amountIn, minOut)
      .accountsPartial({
        vault: vault.publicKey,
        policy,
        opReceipt: opReceipt(opNonce),
        usdcMint,
        yieldMint: usdyMint,
        vaultUsdc,
        vaultUsdy,
        priceFeed: feed,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  };

  const swapIx = (dir: "allocate" | "redeem", amountIn: BN) =>
    swapProgram.methods
      .swap(dir === "allocate", amountIn)
      .accountsPartial({
        user: vault.publicKey,
        config: swapConfig,
        reserveUsdc,
        usdyMint,
        userUsdc: vaultUsdc,
        userUsdy: vaultUsdy,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

  const endIx = async () => {
    const { opNonce } = await fetchPolicy();
    return policyProgram.methods
      .endOp()
      .accountsPartial({
        vault: vault.publicKey,
        policy,
        position,
        opReceipt: opReceipt(opNonce),
        usdcMint,
        yieldMint: usdyMint,
        vaultUsdc,
        vaultUsdy,
        priceFeed,
      })
      .instruction();
  };

  const send = (ixs: IxT[]) => provider.sendAndConfirm(new Transaction().add(...ixs), [vault]);

  /** begin_op → swap → [extra] → end_op numa única transação. */
  const runOp = async (opts: {
    dir: "allocate" | "redeem";
    amountIn: BN;
    minOut: BN;
    swapAmount?: BN;
    extra?: IxT[];
  }) =>
    send([
      await beginIx(opts.dir, opts.amountIn, opts.minOut),
      await swapIx(opts.dir, opts.swapAmount ?? opts.amountIn),
      ...(opts.extra ?? []),
      await endIx(),
    ]);

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

  /** Falha + atomicidade: saldos, nonce e posição não mudam. */
  const expectOpRejected = async (p: Promise<unknown>, code: string) => {
    const before = await balances();
    const { opNonce } = await fetchPolicy();
    const pos = await fetchPosition();
    await expectError(p, code);
    const after = await balances();
    assert.ok(after.usdc.eq(before.usdc), "USDC mudou após falha");
    assert.ok(after.usdy.eq(before.usdy), "USDY mudou após falha");
    assert.ok((await fetchPolicy()).opNonce.eq(opNonce), "nonce mudou após falha");
    assert.ok((await fetchPosition()).usdyUnits.eq(pos.usdyUnits), "posição mudou após falha");
    assert.isNull(await conn.getAccountInfo(opReceipt(opNonce)), "OpReceipt ficou aberto");
  };

  const opEvents = async (sig: string) => {
    const tx = await conn.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    return [...eventParser.parseLogs(tx?.meta?.logMessages ?? [])].filter(
      (ev) => ev.name.toLowerCase() === "opexecuted"
    );
  };

  // ---------- setup ----------

  before(async () => {
    await fixBlockhashCache(conn);
    // SOL para o vault pagar o aluguel do OpReceipt e para o oráculo velho.
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault.publicKey, lamports: 1e9 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: staleOracle.publicKey, lamports: 1e8 })
      )
    );

    // USDC simulado e USDY simulado (mint authority = config do swap simulado).
    usdcMint = await createMint(conn, payer, payer.publicKey, null, 6);
    await createMint(conn, payer, swapConfig, payer.publicKey, 6, usdyMintKp);

    vaultUsdc = (await getOrCreateAssociatedTokenAccount(conn, payer, usdcMint, vault.publicKey)).address;
    vaultUsdy = (await getOrCreateAssociatedTokenAccount(conn, payer, usdyMint, vault.publicKey)).address;
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

    const now = await chainNow();
    await policyProgram.methods
      .initPriceFeed(PRICE_114, new BN(now - 5))
      .accountsPartial({ authority: payer.publicKey, priceFeed, yieldMint: usdyMint })
      .rpc();
    // Feed com NAV de 2 horas atrás, para o teste de preço velho.
    await policyProgram.methods
      .initPriceFeed(PRICE_114, new BN(now - 7200))
      .accountsPartial({ authority: staleOracle.publicKey, priceFeed: stalePriceFeed, yieldMint: usdyMint })
      .signers([staleOracle])
      .rpc();
  });

  // ---------- administração ----------

  it("initialize_policy cria Policy e Position", async () => {
    await policyProgram.methods
      .initializePolicy(BASE_PARAMS)
      .accountsPartial({
        vault: vault.publicKey,
        policy,
        position,
        usdcMint,
        yieldMint: usdyMint,
        priceFeed,
      })
      .signers([vault])
      .rpc();

    const p = await fetchPolicy();
    assert.ok(p.vault.equals(vault.publicKey));
    assert.ok(p.usdcMint.equals(usdcMint));
    assert.ok(p.yieldMint.equals(usdyMint));
    assert.ok(p.priceFeed.equals(priceFeed));
    assert.equal(p.maxYieldBps, 7000);
    assert.ok(p.maxOpUsdc.eq(USDC(50_000)));
    assert.isFalse(p.paused);
    assert.ok(p.opNonce.eqn(0));

    const pos = await fetchPosition();
    assert.ok(pos.usdyUnits.eqn(0));
    assert.ok(pos.costBasisUsdc.eqn(0));
  });

  it("update_policy rejeita parâmetros inválidos", async () => {
    await expectError(updatePolicy({ ...BASE_PARAMS, maxYieldBps: 10_001 }), "InvalidParams");
    await expectError(updatePolicy({ ...BASE_PARAMS, maxOpUsdc: new BN(0) }), "InvalidParams");
  });

  it("só o vault altera a política", async () => {
    const attacker = Keypair.generate();
    await expectError(updatePolicy({ ...BASE_PARAMS, maxOpUsdc: USDC(1e9) }, priceFeed, attacker), "ConstraintSeeds");
  });

  // ---------- alocação: sucesso ----------

  it("aloca 20.000 USDC em USDY (begin → swap → end)", async () => {
    const amountIn = USDC(20_000);
    const expected = allocOut(amountIn);
    const before = await balances();

    const sig = await runOp({ dir: "allocate", amountIn, minOut: expected });

    const after = await balances();
    assert.ok(before.usdc.sub(after.usdc).eq(amountIn));
    assert.ok(after.usdy.sub(before.usdy).eq(expected));

    const pos = await fetchPosition();
    assert.ok(pos.usdyUnits.eq(expected));
    assert.ok(pos.costBasisUsdc.eq(amountIn));
    assert.ok(pos.lastOpTs.gtn(0));
    assert.ok((await fetchPolicy()).opNonce.eqn(1));
    assert.isNull(await conn.getAccountInfo(opReceipt(new BN(0))), "OpReceipt deveria estar fechado");

    const events = await opEvents(sig);
    assert.lengthOf(events, 1);
    const d = events[0].data as any;
    assert.ok(new BN(d.amountOut ?? d.amount_out).eq(expected));
    assert.ok(new BN(d.refPriceE9 ?? d.ref_price_e9).eq(PRICE_114));
  });

  // ---------- verificações de end_op (seção 3.4) ----------

  it("1. falha se recebido < min_out", async () => {
    const amountIn = USDC(5_000);
    await expectOpRejected(
      runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn).addn(1) }),
      "BelowMinOut"
    );
  });

  it("2. falha se o preço efetivo desvia além de max_slippage_bps", async () => {
    await setSwap(PRICE_114, 300); // swap entrega 3% a menos; política aceita 1%
    try {
      await expectOpRejected(
        runOp({ dir: "allocate", amountIn: USDC(5_000), minOut: new BN(1) }),
        "SlippageExceeded"
      );
    } finally {
      await setSwap(PRICE_114, HAIRCUT_BPS);
    }
  });

  it("3. falha se USDY / caixa total passa de max_yield_bps", async () => {
    // já há ~20% em USDY; limite em 30% e alocação de mais 20% → ~40%
    await updatePolicy({ ...BASE_PARAMS, maxYieldBps: 3000 });
    try {
      const amountIn = USDC(20_000);
      await expectOpRejected(
        runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn) }),
        "YieldCapExceeded"
      );
    } finally {
      await updatePolicy(BASE_PARAMS);
    }
  });

  it("4. falha se o USDC fica abaixo de min_liquid_usdc", async () => {
    // 80k de USDC − 15k = 65k < 70k de colchão
    await updatePolicy({ ...BASE_PARAMS, minLiquidUsdc: USDC(70_000) });
    try {
      const amountIn = USDC(15_000);
      await expectOpRejected(
        runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn) }),
        "BelowMinLiquidity"
      );
    } finally {
      await updatePolicy(BASE_PARAMS);
    }
  });

  it("5a. falha se sai do cofre mais que amount_in (rota drena o vault)", async () => {
    const amountIn = USDC(5_000);
    const thief = await getOrCreateAssociatedTokenAccount(conn, payer, usdcMint, Keypair.generate().publicKey);
    const drain = createTransferInstruction(vaultUsdc, thief.address, vault.publicKey, 1_000_000);
    await expectOpRejected(
      runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn), extra: [drain] }),
      "AmountInMismatch"
    );
  });

  it("5b. falha se o swap gasta valor diferente do declarado no begin_op", async () => {
    await expectOpRejected(
      runOp({ dir: "allocate", amountIn: USDC(10_000), minOut: new BN(1), swapAmount: USDC(9_000) }),
      "AmountInMismatch"
    );
  });

  // ---------- verificações de begin_op ----------

  it("begin_op falha acima do teto por operação", async () => {
    const amountIn = USDC(60_000);
    await expectOpRejected(runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn) }), "ExceedsMaxOp");
  });

  it("set_paused bloqueia novas operações", async () => {
    await policyProgram.methods
      .setPaused(true)
      .accountsPartial({ vault: vault.publicKey, policy })
      .signers([vault])
      .rpc();
    try {
      const amountIn = USDC(1_000);
      await expectOpRejected(runOp({ dir: "allocate", amountIn, minOut: allocOut(amountIn) }), "Paused");
    } finally {
      await policyProgram.methods
        .setPaused(false)
        .accountsPartial({ vault: vault.publicKey, policy })
        .signers([vault])
        .rpc();
    }
  });

  it("falha com preço de referência velho", async () => {
    await updatePolicy(BASE_PARAMS, stalePriceFeed);
    try {
      const amountIn = USDC(1_000);
      await expectOpRejected(
        send([await beginIx("allocate", amountIn, allocOut(amountIn), stalePriceFeed)]),
        "StalePrice"
      );
    } finally {
      await updatePolicy(BASE_PARAMS, priceFeed);
    }
  });

  it("falha se a conta de preço não é a da política", async () => {
    const amountIn = USDC(1_000);
    await expectError(
      send([await beginIx("allocate", amountIn, allocOut(amountIn), stalePriceFeed)]),
      "PriceFeedMismatch"
    );
  });

  it("cancel_op fecha um OpReceipt órfão", async () => {
    const { opNonce } = await fetchPolicy();
    const amountIn = USDC(1_000);
    await send([await beginIx("allocate", amountIn, allocOut(amountIn))]);
    assert.isNotNull(await conn.getAccountInfo(opReceipt(opNonce)));

    await policyProgram.methods
      .cancelOp()
      .accountsPartial({ vault: vault.publicKey, policy, opReceipt: opReceipt(opNonce) })
      .signers([vault])
      .rpc();
    assert.isNull(await conn.getAccountInfo(opReceipt(opNonce)));
    assert.ok((await fetchPolicy()).opNonce.eq(opNonce));
  });

  // ---------- resgate ----------

  it("resgate falha se recebido < min_out", async () => {
    const amountIn = (await fetchPosition()).usdyUnits.divn(2);
    await expectOpRejected(
      runOp({ dir: "redeem", amountIn, minOut: redeemOut(amountIn).addn(1) }),
      "BelowMinOut"
    );
  });

  it("resgata metade do USDY após valorização e realiza o rendimento", async () => {
    // NAV sobe de 1,14 para 1,15
    await policyProgram.methods
      .setPrice(PRICE_115, new BN(await chainNow()))
      .accountsPartial({ authority: payer.publicKey, priceFeed })
      .rpc();
    await setSwap(PRICE_115, HAIRCUT_BPS);

    const posBefore = await fetchPosition();
    const amountIn = posBefore.usdyUnits.divn(2);
    const expected = redeemOut(amountIn);
    const costOut = posBefore.costBasisUsdc.mul(amountIn).div(posBefore.usdyUnits);
    const before = await balances();

    const sig = await runOp({ dir: "redeem", amountIn, minOut: expected });

    const after = await balances();
    assert.ok(before.usdy.sub(after.usdy).eq(amountIn));
    assert.ok(after.usdc.sub(before.usdc).eq(expected));

    const pos = await fetchPosition();
    assert.ok(pos.usdyUnits.eq(posBefore.usdyUnits.sub(amountIn)));
    assert.ok(pos.costBasisUsdc.eq(posBefore.costBasisUsdc.sub(costOut)));
    assert.ok(pos.realizedPnlUsdc.eq(expected.sub(costOut)));
    assert.ok(pos.realizedPnlUsdc.gtn(0), "rendimento realizado deveria ser positivo");
    assert.lengthOf(await opEvents(sig), 1);
  });

  it("resgate não é bloqueado pelo teto de alocação", async () => {
    // cofre já acima do novo limite (0%): resgatar reduz a exposição e deve passar
    await updatePolicy({ ...BASE_PARAMS, maxYieldBps: 0 });
    try {
      const amountIn = USDC(1_000);
      await runOp({ dir: "redeem", amountIn, minOut: redeemOut(amountIn) });
    } finally {
      await updatePolicy(BASE_PARAMS);
    }
  });
});
