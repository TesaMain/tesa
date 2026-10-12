// Camada on-chain do painel de demo (e do script de setup): leitura de estado, propostas
// da Squads, aprovação, execução e controles do operador. Sem APIs do Node: roda no browser.
import { AnchorProvider, BN, BorshCoder, BorshInstructionCoder, EventParser, Program, type Idl } from "@anchor-lang/core";
import * as multisig from "@sqds/multisig";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import policyIdl from "./idl/tesa_policy.json";
import swapIdl from "./idl/mock_swap.json";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const DECIMALS = 6;
const E9 = 1_000_000_000n;
const BPS = 10_000n;
/** Folga do min_out sobre a cotação, como a tolerância que o backend pediria à Jupiter. */
export const QUOTE_TOLERANCE_BPS = 50n;

export type DemoConfig = {
  cluster: string;
  rpcUrl: string;
  createdAt: string;
  multisig: string;
  vault: string;
  usdcMint: string;
  usdyMint: string;
  vaultUsdc: string;
  vaultUsdy: string;
  swapConfig: string;
  reserveUsdc: string;
  priceFeed: string;
  policy: string;
  position: string;
  keys: Record<Role, number[]>;
};

/** Papéis da seção 3.1, mais o operador da demo (NAV da Ondo, mercado simulado, faucet de USDC). */
export type Role = "tesa" | "cfo" | "controller" | "operator";
export const HUMANS = ["cfo", "controller"] as const;
export type Human = (typeof HUMANS)[number];

export const ROLE_LABEL: Record<Role, string> = {
  tesa: "Tesa key",
  cfo: "CFO",
  controller: "Controller",
  operator: "Demo operator",
};

// ---------------------------------------------------------------- formatting

export const toUnits = (amount: number | string) => {
  const [int, frac = ""] = String(amount).replace(/,/g, "").split(".");
  return BigInt(int || "0") * 10n ** BigInt(DECIMALS) + BigInt((frac + "000000").slice(0, DECIMALS));
};
export const fromUnits = (u: bigint) => Number(u) / 10 ** DECIMALS;
export const fmt = (u: bigint, digits = 2) =>
  fromUnits(u).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
export const fmtPrice = (e9: bigint) => (Number(e9) / 1e9).toFixed(4);
export const big = (x: { toString(): string } | number | bigint) => BigInt(x.toString());

// ---------------------------------------------------------------- policy math (espelha o programa)

export const usdyValue = (units: bigint, priceE9: bigint) => (units * priceE9) / E9;
export const quoteOut = (dir: Direction, amountIn: bigint, priceE9: bigint, haircutBps: bigint) =>
  dir === "allocate"
    ? (((amountIn * E9) / priceE9) * (BPS - haircutBps)) / BPS
    : (((amountIn * priceE9) / E9) * (BPS - haircutBps)) / BPS;
export const minOutFor = (quote: bigint) => (quote * (BPS - QUOTE_TOLERANCE_BPS)) / BPS;

// ---------------------------------------------------------------- errors

/** Mensagens para quem assiste à demo, pelo nome do erro no log do Anchor. */
export const ERROR_TEXT: Record<string, string> = {
  ExceedsMaxOp: "Above the per-operation cap set in the policy.",
  YieldCapExceeded: "Would push USDY above the maximum share of the treasury.",
  BelowMinLiquidity: "Would leave less USDC than the liquidity floor.",
  SlippageExceeded: "Swap price deviated from the USDY NAV beyond the allowed slippage.",
  BelowMinOut: "Received less than the minimum quoted when the proposal was made.",
  AmountInMismatch: "More left the vault than the operation declared.",
  UnexpectedBalanceChange: "Vault balances moved in an unexpected direction.",
  Paused: "The policy is paused.",
  StalePrice: "The USDY reference price is too old.",
  InsufficientBalance: "The vault does not hold enough to cover this operation.",
  ZeroAmount: "The amount must be greater than zero.",
  ConstraintSeeds: "Built for an older operation number; another operation executed first.",
  Unauthorized: "This key is not allowed to do that in the multisig.",
  InvalidProposalStatus: "The proposal is not in a state that allows this.",
  AlreadyApproved: "This member already approved.",
  AlreadyRejected: "This member already rejected.",
  AlreadyCancelled: "This member already voted to cancel.",
  NotAMember: "This key is not a member of the multisig.",
};

export type TxResult = {
  signature: string;
  ok: boolean;
  error?: string;
  errorText?: string;
  ms: number;
  logs: string[];
};

export const explorerTx = (sig: string, cluster: string) => `https://solscan.io/tx/${sig}?cluster=${cluster}`;
export const explorerAccount = (addr: string, cluster: string) =>
  `https://solscan.io/account/${addr}?cluster=${cluster}`;

function errorFrom(logs: string[], err: unknown): string | undefined {
  for (const l of logs) {
    const m = l.match(/Error Code: (\w+)/);
    if (m) return m[1];
  }
  return err ? JSON.stringify(err) : undefined;
}

// ---------------------------------------------------------------- state types

export type Direction = "allocate" | "redeem";

export type VaultState = {
  slot: number;
  chainTime: number;
  policy: {
    maxYieldBps: number;
    minLiquidUsdc: bigint;
    maxOpUsdc: bigint;
    maxSlippageBps: number;
    maxPriceAgeSecs: number;
    paused: boolean;
    opNonce: bigint;
  };
  position: { usdyUnits: bigint; costBasisUsdc: bigint; realizedPnlUsdc: bigint; lastOpTs: number };
  price: { priceE9: bigint; publishTs: number };
  market: { priceE9: bigint; haircutBps: number };
  usdc: bigint;
  usdy: bigint;
  sol: Record<Role | "vault", number>;
  multisig: { threshold: number; transactionIndex: bigint; members: { key: string; mask: number }[] };
};

export type ProposalView = {
  index: bigint;
  status: string;
  approved: string[];
  rejected: string[];
  cancelled: string[];
  summary: string;
  kind: "allocate" | "redeem" | "pause" | "resume" | "init" | "other";
  amountIn?: bigint;
  minOut?: bigint;
};

export type ActivityItem = {
  signature: string;
  ok: boolean;
  time: number | null;
  title: string;
  detail: string;
  error?: string;
};

// ---------------------------------------------------------------- client

const readOnlyWallet = (pk: PublicKey) => ({
  publicKey: pk,
  signTransaction: async <T>(tx: T) => tx,
  signAllTransactions: async <T>(txs: T[]) => txs,
});

export class TesaDemo {
  readonly conn: Connection;
  readonly cfg: DemoConfig;
  readonly keys: Record<Role, Keypair>;
  readonly policyProgram: Program;
  readonly swapProgram: Program;
  readonly eventParser: EventParser;
  readonly pk: {
    multisig: PublicKey;
    vault: PublicKey;
    usdcMint: PublicKey;
    usdyMint: PublicKey;
    vaultUsdc: PublicKey;
    vaultUsdy: PublicKey;
    swapConfig: PublicKey;
    reserveUsdc: PublicKey;
    priceFeed: PublicKey;
    policy: PublicKey;
    position: PublicKey;
  };
  private activityCache = new Map<string, ActivityItem>();

  constructor(cfg: DemoConfig, conn?: Connection) {
    this.cfg = cfg;
    this.conn = conn ?? new Connection(cfg.rpcUrl, "confirmed");
    this.keys = Object.fromEntries(
      (Object.keys(cfg.keys) as Role[]).map((r) => [r, Keypair.fromSecretKey(Uint8Array.from(cfg.keys[r]))])
    ) as Record<Role, Keypair>;
    const provider = new AnchorProvider(this.conn, readOnlyWallet(this.keys.operator.publicKey) as never, {
      commitment: "confirmed",
    });
    this.policyProgram = new Program(policyIdl as Idl, provider);
    this.swapProgram = new Program(swapIdl as Idl, provider);
    this.eventParser = new EventParser(this.policyProgram.programId, new BorshCoder(this.policyProgram.idl));
    const p = (s: string) => new PublicKey(s);
    this.pk = {
      multisig: p(cfg.multisig),
      vault: p(cfg.vault),
      usdcMint: p(cfg.usdcMint),
      usdyMint: p(cfg.usdyMint),
      vaultUsdc: p(cfg.vaultUsdc),
      vaultUsdy: p(cfg.vaultUsdy),
      swapConfig: p(cfg.swapConfig),
      reserveUsdc: p(cfg.reserveUsdc),
      priceFeed: p(cfg.priceFeed),
      policy: p(cfg.policy),
      position: p(cfg.position),
    };
  }

  /** Lê e decodifica uma conta Anchor (o IDL não é tipado aqui, então `program.account.x` não existe). */
  private async fetchAccount<T>(program: Program, name: string, address: PublicKey): Promise<T> {
    const info = await this.conn.getAccountInfo(address, "confirmed");
    if (!info) throw new Error(`Account ${address.toBase58()} not found`);
    return program.coder.accounts.decode(name, info.data) as T;
  }

  roleOf(key: string): Role | undefined {
    return (Object.keys(this.keys) as Role[]).find((r) => this.keys[r].publicKey.toBase58() === key);
  }

  // ------------------------------------------------------------ reads

  async chainTime(): Promise<number> {
    const slot = await this.conn.getSlot("confirmed");
    return (await this.conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  }

  async state(): Promise<VaultState> {
    const k = this.pk;
    const roles = Object.keys(this.keys) as Role[];
    const addrs = [
      k.policy,
      k.position,
      k.priceFeed,
      k.swapConfig,
      k.vaultUsdc,
      k.vaultUsdy,
      k.multisig,
      k.vault,
      ...roles.map((r) => this.keys[r].publicKey),
    ];
    const [{ context, value: infos }, chainTime] = await Promise.all([
      this.conn.getMultipleAccountsInfoAndContext(addrs, "confirmed"),
      this.chainTime(),
    ]);
    const need = (i: number) => {
      const info = infos[i];
      if (!info) throw new Error(`Account ${addrs[i].toBase58()} not found. Was the demo set up on this cluster?`);
      return info;
    };
    const dec = (prog: Program, name: string, i: number) => prog.coder.accounts.decode(name, need(i).data);
    const policy = dec(this.policyProgram, "policy", 0);
    const position = dec(this.policyProgram, "position", 1);
    const feed = dec(this.policyProgram, "priceFeed", 2);
    const market = dec(this.swapProgram, "config", 3);
    const tokenAmount = (i: number) => need(i).data.readBigUInt64LE(64);
    const [ms] = multisig.accounts.Multisig.fromAccountInfo(need(6));
    const sol = Object.fromEntries(
      roles.map((r, j) => [r, (infos[8 + j]?.lamports ?? 0) / 1e9])
    ) as Record<Role, number>;

    return {
      slot: context.slot,
      chainTime,
      policy: {
        maxYieldBps: policy.maxYieldBps,
        minLiquidUsdc: big(policy.minLiquidUsdc),
        maxOpUsdc: big(policy.maxOpUsdc),
        maxSlippageBps: policy.maxSlippageBps,
        maxPriceAgeSecs: policy.maxPriceAgeSecs,
        paused: policy.paused,
        opNonce: big(policy.opNonce),
      },
      position: {
        usdyUnits: big(position.usdyUnits),
        costBasisUsdc: big(position.costBasisUsdc),
        realizedPnlUsdc: big(position.realizedPnlUsdc),
        lastOpTs: Number(position.lastOpTs),
      },
      price: { priceE9: big(feed.priceE9), publishTs: Number(feed.publishTs) },
      market: { priceE9: big(market.priceE9), haircutBps: market.haircutBps },
      usdc: tokenAmount(4),
      usdy: tokenAmount(5),
      sol: { ...sol, vault: (infos[7]?.lamports ?? 0) / 1e9 },
      multisig: {
        threshold: ms.threshold,
        transactionIndex: big(ms.transactionIndex),
        members: ms.members.map((m) => ({ key: m.key.toBase58(), mask: m.permissions.mask })),
      },
    };
  }

  /** As últimas `count` propostas, da mais nova para a mais antiga. */
  async proposals(latestIndex: bigint, count = 8): Promise<ProposalView[]> {
    const indices: bigint[] = [];
    for (let i = latestIndex; i >= 1n && indices.length < count; i--) indices.push(i);
    if (!indices.length) return [];
    const addrs = indices.flatMap((transactionIndex) => [
      multisig.getProposalPda({ multisigPda: this.pk.multisig, transactionIndex })[0],
      multisig.getTransactionPda({ multisigPda: this.pk.multisig, index: transactionIndex })[0],
    ]);
    const infos = await this.conn.getMultipleAccountsInfo(addrs, "confirmed");
    const out: ProposalView[] = [];
    indices.forEach((index, j) => {
      const pInfo = infos[2 * j];
      const tInfo = infos[2 * j + 1];
      if (!pInfo || !tInfo) return;
      const [proposal] = multisig.accounts.Proposal.fromAccountInfo(pInfo);
      let described: Omit<ProposalView, "index" | "status" | "approved" | "rejected" | "cancelled"> = {
        summary: "Vault transaction",
        kind: "other",
      };
      try {
        const [vtx] = multisig.accounts.VaultTransaction.fromAccountInfo(tInfo);
        described = this.describe(vtx);
      } catch {
        /* conta de outro tipo (config transaction): descrição genérica */
      }
      out.push({
        index,
        status: proposal.status.__kind,
        approved: proposal.approved.map((k) => k.toBase58()),
        rejected: proposal.rejected.map((k) => k.toBase58()),
        cancelled: proposal.cancelled.map((k) => k.toBase58()),
        ...described,
      });
    });
    return out;
  }

  private describe(vtx: multisig.accounts.VaultTransaction) {
    const keys = vtx.message.accountKeys;
    for (const ix of vtx.message.instructions) {
      if (!keys[ix.programIdIndex].equals(this.policyProgram.programId)) continue;
      const decoded = (this.policyProgram.coder.instruction as BorshInstructionCoder).decode(Buffer.from(ix.data));
      if (!decoded) continue;
      const name = decoded.name.replace(/_/g, "").toLowerCase();
      const d = decoded.data as Record<string, unknown>;
      if (name === "beginop") {
        const dir: Direction = "allocate" in (d.direction as object) ? "allocate" : "redeem";
        const amountIn = big(d.amountIn as BN);
        return {
          kind: dir,
          amountIn,
          minOut: big(d.minOut as BN),
          summary:
            dir === "allocate"
              ? `Allocate ${fmt(amountIn, 0)} USDC → USDY`
              : `Redeem ${fmt(amountIn, 2)} USDY → USDC`,
        } as const;
      }
      if (name === "setpaused") {
        return d.paused
          ? ({ kind: "pause", summary: "Pause the policy" } as const)
          : ({ kind: "resume", summary: "Resume the policy" } as const);
      }
      if (name === "initializepolicy") return { kind: "init", summary: "Initialize the policy" } as const;
    }
    return { kind: "other", summary: "Vault transaction" } as const;
  }

  /** Execuções que tocaram a política: sucessos (evento OpExecuted) e falhas on-chain. */
  async activity(limit = 15): Promise<ActivityItem[]> {
    const sigs = await this.conn.getSignaturesForAddress(this.pk.policy, { limit }, "confirmed");
    for (const s of sigs) {
      if (this.activityCache.has(s.signature)) continue;
      const tx = await this.conn.getTransaction(s.signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (!tx) continue;
      const logs = tx.meta?.logMessages ?? [];
      const item: ActivityItem = { signature: s.signature, ok: !s.err, time: s.blockTime ?? null, title: "", detail: "" };
      if (s.err) {
        const code = errorFrom(logs, s.err);
        item.error = code;
        item.title = "Rejected on-chain";
        item.detail = (code && ERROR_TEXT[code]) || code || "Transaction failed";
      } else {
        const ev = [...this.eventParser.parseLogs(logs)].find((e) => e.name.toLowerCase() === "opexecuted");
        if (ev) {
          const d = ev.data as Record<string, BN | object>;
          const alloc = "allocate" in (d.direction as object);
          const inA = big(d.amountIn as BN);
          const outA = big(d.amountOut as BN);
          item.title = alloc ? "Allocation executed" : "Redemption executed";
          item.detail = alloc
            ? `${fmt(inA, 0)} USDC → ${fmt(outA)} USDY at NAV ${fmtPrice(big(d.refPriceE9 as BN))}`
            : `${fmt(inA)} USDY → ${fmt(outA)} USDC at NAV ${fmtPrice(big(d.refPriceE9 as BN))}`;
        } else if (logs.some((l) => /Instruction: SetPaused/.test(l))) {
          item.title = "Policy pause switched";
          item.detail = "Executed by the vault";
        } else if (logs.some((l) => /Instruction: InitializePolicy/.test(l))) {
          item.title = "Policy initialized";
          item.detail = "Executed by the vault";
        } else {
          item.title = "Vault transaction";
          item.detail = "";
        }
      }
      this.activityCache.set(s.signature, item);
    }
    return sigs.map((s) => this.activityCache.get(s.signature)).filter(Boolean) as ActivityItem[];
  }

  // ------------------------------------------------------------ sending

  /**
   * Envia sem simulação de preflight: uma transação que a política rejeita entra num bloco e
   * falha on-chain, com link no explorador (seção 7.2), em vez de parar na simulação local.
   */
  async send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<TxResult> {
    const t0 = performance.now();
    const latest = await this.conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: signers[0].publicKey, ...latest }).add(...ixs);
    tx.sign(...signers);
    const signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
    const conf = await this.conn.confirmTransaction({ signature, ...latest }, "confirmed");
    const ms = performance.now() - t0;
    let logs: string[] = [];
    for (let i = 0; i < 8; i++) {
      const got = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (got) {
        logs = got.meta?.logMessages ?? [];
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const error = conf.value.err ? errorFrom(logs, conf.value.err) : undefined;
    return { signature, ok: !conf.value.err, error, errorText: error && ERROR_TEXT[error], ms, logs };
  }

  // ------------------------------------------------------------ instruction builders

  async opIxs(dir: Direction, amountIn: bigint, minOut: bigint): Promise<TransactionInstruction[]> {
    const { opNonce } = await this.fetchAccount<{ opNonce: BN }>(this.policyProgram, "policy", this.pk.policy);
    const k = this.pk;
    const opReceipt = PublicKey.findProgramAddressSync(
      [Buffer.from("op"), k.vault.toBuffer(), opNonce.toArrayLike(Buffer, "le", 8)],
      this.policyProgram.programId
    )[0];
    const tokens = { usdcMint: k.usdcMint, yieldMint: k.usdyMint, vaultUsdc: k.vaultUsdc, vaultUsdy: k.vaultUsdy, priceFeed: k.priceFeed };
    return [
      await this.policyProgram.methods
        .beginOp(dir === "allocate" ? { allocate: {} } : { redeem: {} }, new BN(amountIn.toString()), new BN(minOut.toString()))
        .accountsPartial({ vault: k.vault, policy: k.policy, opReceipt, ...tokens, systemProgram: SystemProgram.programId })
        .instruction(),
      await this.swapProgram.methods
        .swap(dir === "allocate", new BN(amountIn.toString()))
        .accountsPartial({
          user: k.vault,
          config: k.swapConfig,
          reserveUsdc: k.reserveUsdc,
          usdyMint: k.usdyMint,
          userUsdc: k.vaultUsdc,
          userUsdy: k.vaultUsdy,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction(),
      await this.policyProgram.methods
        .endOp()
        .accountsPartial({ vault: k.vault, policy: k.policy, position: k.position, opReceipt, ...tokens })
        .instruction(),
    ];
  }

  async setPausedIx(paused: boolean) {
    return this.policyProgram.methods.setPaused(paused).accountsPartial({ vault: this.pk.vault, policy: this.pk.policy }).instruction();
  }

  // ------------------------------------------------------------ multisig flow

  /** A chave da Tesa (só Initiate) cria a vault transaction e a proposta numa transação. */
  async propose(ixs: TransactionInstruction[], memo: string, latestIndex?: bigint): Promise<TxResult & { index: bigint }> {
    let current = latestIndex;
    if (current === undefined) {
      const ms = await multisig.accounts.Multisig.fromAccountAddress(this.conn, this.pk.multisig, "confirmed");
      current = big(ms.transactionIndex);
    }
    const transactionIndex = current + 1n;
    const transactionMessage = new TransactionMessage({
      payerKey: this.pk.vault,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: ixs,
    });
    const creator = this.keys.tesa.publicKey;
    const res = await this.send(
      [
        multisig.instructions.vaultTransactionCreate({
          multisigPda: this.pk.multisig,
          transactionIndex,
          creator,
          vaultIndex: 0,
          ephemeralSigners: 0,
          transactionMessage,
          memo,
        }),
        multisig.instructions.proposalCreate({ multisigPda: this.pk.multisig, transactionIndex, creator }),
      ],
      [this.keys.tesa]
    );
    return { ...res, index: transactionIndex };
  }

  vote(role: Role, transactionIndex: bigint, vote: "approve" | "reject" | "cancel") {
    const args = { multisigPda: this.pk.multisig, transactionIndex, member: this.keys[role].publicKey };
    const ix =
      vote === "approve"
        ? multisig.instructions.proposalApprove(args)
        : vote === "reject"
          ? multisig.instructions.proposalReject(args)
          : multisig.instructions.proposalCancelV2(args);
    return this.send([ix], [this.keys[role]]);
  }

  /** O compute budget vai na transação externa: só vale no nível superior (README, decisão M2-1). */
  async execute(role: Role, transactionIndex: bigint) {
    const { instruction } = await multisig.instructions.vaultTransactionExecute({
      connection: this.conn,
      multisigPda: this.pk.multisig,
      transactionIndex,
      member: this.keys[role].publicKey,
    });
    return this.send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), instruction], [this.keys[role]]);
  }

  // ------------------------------------------------------------ operator (demo) controls

  /** Publica o NAV no PriceFeed e leva o mercado simulado ao mesmo preço (o cron da seção 5). */
  async publishNav(priceE9: bigint, haircutBps?: number) {
    const now = await this.chainTime();
    const market = await this.fetchAccount<{ haircutBps: number }>(this.swapProgram, "config", this.pk.swapConfig);
    const op = this.keys.operator.publicKey;
    return this.send(
      [
        await this.policyProgram.methods
          .setPrice(new BN(priceE9.toString()), new BN(now - 2))
          .accountsPartial({ authority: op, priceFeed: this.pk.priceFeed })
          .instruction(),
        await this.swapProgram.methods
          .setParams(new BN(priceE9.toString()), haircutBps ?? market.haircutBps)
          .accountsPartial({ admin: op, config: this.pk.swapConfig })
          .instruction(),
      ],
      [this.keys.operator]
    );
  }

  async setMarketSlippage(haircutBps: number) {
    const market = await this.fetchAccount<{ priceE9: BN }>(this.swapProgram, "config", this.pk.swapConfig);
    return this.send(
      [
        await this.swapProgram.methods
          .setParams(market.priceE9, haircutBps)
          .accountsPartial({ admin: this.keys.operator.publicKey, config: this.pk.swapConfig })
          .instruction(),
      ],
      [this.keys.operator]
    );
  }

  /** Faucet de USDC simulado para o vault (o operador é a mint authority). */
  async mintUsdcToVault(amount: bigint) {
    const data = Buffer.alloc(9);
    data.writeUInt8(7, 0); // MintTo
    data.writeBigUInt64LE(amount, 1);
    return this.send(
      [
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [
            { pubkey: this.pk.usdcMint, isSigner: false, isWritable: true },
            { pubkey: this.pk.vaultUsdc, isSigner: false, isWritable: true },
            { pubkey: this.keys.operator.publicKey, isSigner: true, isWritable: false },
          ],
          data,
        }),
      ],
      [this.keys.operator]
    );
  }
}
