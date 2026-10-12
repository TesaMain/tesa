import { useEffect, useMemo, useState } from "react";
import {
  ERROR_TEXT,
  HUMANS,
  ROLE_LABEL,
  explorerAccount,
  explorerTx,
  fmt,
  fmtPrice,
  fromUnits,
  minOutFor,
  quoteOut,
  toUnits,
  usdyValue,
  type Direction,
  type Human,
  type ProposalView,
  type Role,
  type TxResult,
  type VaultState,
} from "./chain";
import { useDemo, type LogEntry } from "./useDemo";

type Demo = ReturnType<typeof useDemo>;

const pct = (num: bigint, den: bigint) => (den === 0n ? 0 : (Number(num) / Number(den)) * 100);
const bpsPct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const ago = (secs: number) =>
  secs < 60 ? `${Math.max(0, Math.round(secs))}s ago` : secs < 3600 ? `${Math.round(secs / 60)} min ago` : `${(secs / 3600).toFixed(1)} h ago`;

// ------------------------------------------------------------------ app

const PAGES = [
  { id: "operations", label: "Operations", title: "Operations", sub: "Propose, approve and execute treasury operations on the client's vault." },
  { id: "customers", label: "Customers", title: "Fintech customers", sub: "How the vault's yield reaches the fintech's own customers." },
  { id: "policy", label: "Policy", title: "Policy, enforced on-chain", sub: "The treasury rules every operation must pass." },
  { id: "history", label: "History", title: "Vault history", sub: "Every execution that touched the policy, read from the chain." },
  { id: "controls", label: "Demo controls", title: "Demo controls", sub: "Stand-ins for the outside world: the Ondo NAV, the market and Circle's bridge." },
  { id: "script", label: "Demo script", title: "Demo script", sub: "A suggested path through the demo." },
  { id: "how", label: "How it works", title: "How it works", sub: "From Ethereum cash to yield for the fintech's customers." },
] as const;
type PageId = (typeof PAGES)[number]["id"];

const pageFromHash = (): PageId => {
  const h = window.location.hash.slice(1);
  return (PAGES.find((p) => p.id === h)?.id ?? "operations") as PageId;
};

export function App() {
  const d = useDemo();
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [dir, setDir] = useState<Direction>("allocate");
  const [amount, setAmount] = useState("");
  const cluster = d.demo.cfg.cluster;
  const meta = PAGES.find((p) => p.id === page)!;

  useEffect(() => {
    const onHash = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const s = d.state;
  return (
    <div className="shell">
      <Sidebar demo={d} page={page} />
      <div className="main">
        <header className="page-head">
          <h1>{meta.title}</h1>
          <p>{meta.sub}</p>
        </header>
        {d.loadError && s && <p className="banner warn">Connection to {cluster} is slow: {d.loadError}. Retrying.</p>}
        {!s ? (
          page === "script" ? <Script /> : page === "how" ? <HowItWorks /> : <Loading error={d.loadError} />
        ) : (
          <>
            {page === "operations" && (
              <>
                <Summary s={s} />
                <div className="ops">
                  <div className="ops-main">
                    <Composer d={d} dir={dir} setDir={setDir} amount={amount} setAmount={setAmount} />
                    <Proposals d={d} />
                  </div>
                  <div className="ops-side">
                    <Signers d={d} />
                    <SessionLog log={d.log} cluster={cluster} />
                  </div>
                </div>
              </>
            )}
            {page === "customers" && <Customers s={s} />}
            {page === "policy" && <PolicyCard d={d} />}
            {page === "history" && <History d={d} />}
            {page === "controls" && <Operator d={d} />}
            {page === "script" && <Script />}
            {page === "how" && <HowItWorks />}
          </>
        )}
        <Footer demo={d} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sidebar + summary

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="6" d="M39 18V17A8 8 0 0 0 31 9H17A8 8 0 0 0 9 17V24" />
      <path fill="none" stroke="currentColor" strokeWidth="6" d="M9 30V31A8 8 0 0 0 17 39H31A8 8 0 0 0 39 31V24" />
      <path fill="none" stroke="currentColor" strokeWidth="6" d="M18 21H30M24 21V39" />
    </svg>
  );
}

function Sidebar({ demo: d, page }: { demo: Demo; page: PageId }) {
  const c = d.demo.cfg;
  const pending = d.proposals.filter((p) => p.status === "Active" || p.status === "Approved").length;
  return (
    <aside className="sidebar">
      <div className="brand">
        <Mark />
        <span className="word">Tesa</span>
        <span className="sep" aria-hidden="true" />
        <span className="product">Treasury vault</span>
      </div>
      <nav aria-label="Sections">
        <ul className="nav">
          {PAGES.map((p) => (
            <li key={p.id}>
              <a href={`#${p.id}`} className={page === p.id ? "on" : ""} aria-current={page === p.id ? "page" : undefined}>
                {p.label}
                {p.id === "operations" && pending > 0 && <span className="count num">{pending}</span>}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="side-foot">
        <span className="chip live">
          <span className="dot" aria-hidden="true" />
          Solana {c.cluster}
        </span>
        <a className="link small" href={explorerAccount(c.multisig, c.cluster)} target="_blank" rel="noreferrer">
          Squads multisig ↗
        </a>
        <a className="link small" href={explorerAccount(c.vault, c.cluster)} target="_blank" rel="noreferrer">
          Vault ↗
        </a>
      </div>
    </aside>
  );
}

function Loading({ error }: { error: string | null }) {
  return (
    <section className="loading">
      {error ? (
        <>
          <p className="lbl">Could not read the vault</p>
          <p>{error}</p>
        </>
      ) : (
        <p className="lbl">Reading the vault from Solana…</p>
      )}
    </section>
  );
}

function Summary({ s }: { s: VaultState }) {
  const nav = s.price.priceE9;
  const usdyVal = usdyValue(s.usdy, nav);
  const total = s.usdc + usdyVal;
  const share = pct(usdyVal, total);
  const cap = s.policy.maxYieldBps / 100;
  const posValue = usdyValue(s.position.usdyUnits, nav);
  const unrealized = posValue - s.position.costBasisUsdc;
  const avgCost = s.position.usdyUnits === 0n ? 0n : (s.position.costBasisUsdc * 1_000_000_000n) / s.position.usdyUnits;
  const unrealizedPct = pct(unrealized, s.position.costBasisUsdc);

  return (
    <section className="summary" aria-label="Vault summary">
      <div className="hero">
        <p className="lbl">Treasury value</p>
        <p className="fig num">
          <span className="cur">$</span>
          {fmt(total)}
        </p>
        <p className="sub">
          A fintech's USDC, bridged from Ethereum, earns US Treasury yield through USDY on Solana. The cash stays in the
          client's Squads multisig, under rules enforced on-chain by the <em>Tesa policy</em> program.
        </p>
      </div>
      <dl className="kpis">
        <div>
          <dt className="lbl">USDC · liquid</dt>
          <dd className="num">{fmt(s.usdc)}</dd>
        </div>
        <div>
          <dt className="lbl">USDY · at NAV {fmtPrice(nav)}</dt>
          <dd className="num">
            {fmt(usdyVal)} <small>{fmt(s.usdy)} units</small>
          </dd>
        </div>
        <div>
          <dt className="lbl">Yield earned · unrealized</dt>
          <dd className={`num ${unrealized >= 0n ? "pos" : "neg"}`}>
            {unrealized >= 0n ? "+" : "−"}
            {fmt(unrealized < 0n ? -unrealized : unrealized)} <small>{unrealizedPct.toFixed(2)}% on cost</small>
          </dd>
        </div>
        <div>
          <dt className="lbl">Average cost · realized</dt>
          <dd className="num">
            {avgCost === 0n ? "—" : fmtPrice(avgCost)}{" "}
            <small>
              {s.position.realizedPnlUsdc >= 0n ? "+" : "−"}
              {fmt(s.position.realizedPnlUsdc < 0n ? -s.position.realizedPnlUsdc : s.position.realizedPnlUsdc)} realized
            </small>
          </dd>
        </div>
      </dl>
      <div className="meter" role="img" aria-label={`USDY is ${share.toFixed(1)}% of the treasury; the policy cap is ${cap}%`}>
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${Math.min(100, share)}%` }} />
          <div className="meter-cap" style={{ left: `${cap}%` }}>
            <span>Policy cap {cap}%</span>
          </div>
        </div>
        <div className="meter-legend">
          <span>
            <i className="sw usdy" /> USDY {share.toFixed(1)}%
          </span>
          <span>
            <i className="sw usdc" /> USDC {(100 - share).toFixed(1)}%
          </span>
          <span className="muted">Formula: USDY units × (NAV − average cost), all from on-chain accounts</span>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ demo script

const SCRIPT: { title: string; body: string }[] = [
  { title: "Cash arrives from Ethereum", body: "In Demo controls, bridge USDC with Circle CCTP. It lands in the vault without any signature." },
  { title: "Propose an allocation", body: "In Operations, the CFO picks an amount and the Tesa key proposes it. Tesa can only propose." },
  { title: "Tesa tries to approve", body: "On the new proposal, press “Tesa key tries to approve”. It fails on-chain." },
  { title: "Two humans sign", body: "Approve as CFO and Controller, then execute. Balances and yield update." },
  { title: "Break the rules", body: "Propose more than the per-operation cap (see Policy). Approve it; execution fails on-chain." },
  { title: "Market moves after approval", body: "Approve a proposal, switch the market to stressed in Demo controls, execute: the swap is reverted." },
  { title: "Yield reaches customers", body: "Publish a higher NAV in Demo controls. The vault's yield grows, and so does each customer's share in Customers." },
  { title: "Redeem, timed", body: "Redeem USDY back to USDC. The transaction log shows how long settlement took." },
];

function Script() {
  return (
    <section className="card script" aria-labelledby="script-h">
      <div className="card-head">
        <h2 id="script-h">Demo script</h2>
        <span className="muted small">{SCRIPT.length} steps, about four minutes</span>
      </div>
      <ol className="steps">
        {SCRIPT.map((step, i) => (
          <li key={step.title}>
            <span className="n num">{i + 1}</span>
            <div>
              <p className="step-t">{step.title}</p>
              <p className="step-b">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ------------------------------------------------------------------ composer

function Composer({
  d,
  dir,
  setDir,
  amount,
  setAmount,
}: {
  d: Demo;
  dir: Direction;
  setDir: (x: Direction) => void;
  amount: string;
  setAmount: (x: string) => void;
}) {
  const s = d.state!;
  const units = useMemo(() => {
    try {
      return toUnits(amount || "0");
    } catch {
      return 0n;
    }
  }, [amount]);
  const nav = s.price.priceE9;
  const quote = units > 0n ? quoteOut(dir, units, s.market.priceE9, BigInt(s.market.haircutBps)) : 0n;
  const minOut = minOutFor(quote);
  const opValue = dir === "allocate" ? units : usdyValue(units, nav);

  // Avisos: mostram o que a política vai fazer, mas não bloqueiam (a demo quer a falha on-chain).
  const warnings: string[] = [];
  if (s.policy.paused) warnings.push("The policy is paused: execution will fail.");
  if (opValue > s.policy.maxOpUsdc)
    warnings.push(`Above the ${fmt(s.policy.maxOpUsdc, 0)} USDC per-operation cap: the policy will reject it on-chain.`);
  if (dir === "allocate" && units > 0n) {
    const postUsdc = s.usdc - units;
    const postUsdyVal = usdyValue(s.usdy + quote, nav);
    if (postUsdc < s.policy.minLiquidUsdc)
      warnings.push(`Would leave ${fmt(postUsdc < 0n ? 0n : postUsdc, 0)} USDC, below the ${fmt(s.policy.minLiquidUsdc, 0)} floor.`);
    if (pct(postUsdyVal, postUsdc + postUsdyVal) > s.policy.maxYieldBps / 100)
      warnings.push(`Would put more than ${s.policy.maxYieldBps / 100}% of the treasury in USDY.`);
  }
  const balance = dir === "allocate" ? s.usdc : s.usdy;
  if (units > balance) warnings.push("More than the vault holds.");

  const propose = () =>
    d.run(
      "propose",
      dir === "allocate" ? `Propose: allocate ${fmt(units, 0)} USDC` : `Propose: redeem ${fmt(units)} USDY`,
      ROLE_LABEL.tesa,
      async () => d.demo.propose(await d.demo.opIxs(dir, units, minOut), dir === "allocate" ? "Allocate" : "Redeem")
    );

  return (
    <section className="card composer" id="composer" aria-labelledby="composer-h">
      <div className="card-head">
        <h2 id="composer-h">New operation</h2>
        <span className="muted small">Proposed by the Tesa key, signed by the client</span>
      </div>
      <div className="seg" role="radiogroup" aria-label="Direction">
        {(["allocate", "redeem"] as const).map((x) => (
          <button key={x} role="radio" aria-checked={dir === x} className={dir === x ? "on" : ""} onClick={() => setDir(x)}>
            {x === "allocate" ? "Allocate · USDC → USDY" : "Redeem · USDY → USDC"}
          </button>
        ))}
      </div>
      <div className="amount-row">
        <label htmlFor="amount" className="lbl">
          Amount in {dir === "allocate" ? "USDC" : "USDY"}
        </label>
        <div className="amount">
          <input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="num"
            placeholder="0"
            autoComplete="off"
          />
          <span className="unit">{dir === "allocate" ? "USDC" : "USDY"}</span>
          <button className="btn btn-ghost btn-xs" onClick={() => setAmount(String(fromUnits(balance)))}>
            Max
          </button>
        </div>
        <p className="muted small num">
          Vault holds {fmt(balance)} {dir === "allocate" ? "USDC" : "USDY"} · per-operation cap {fmt(s.policy.maxOpUsdc, 0)} USDC
        </p>
      </div>
      <dl className="quote">
        <div>
          <dt>Expected</dt>
          <dd className="num">
            {fmt(quote)} {dir === "allocate" ? "USDY" : "USDC"}
          </dd>
        </div>
        <div>
          <dt>Minimum received</dt>
          <dd className="num">
            {fmt(minOut)} <small>0.5% tolerance</small>
          </dd>
        </div>
        <div>
          <dt>Market</dt>
          <dd className="num">
            {fmtPrice(s.market.priceE9)} <small>{bpsPct(s.market.haircutBps)} slippage</small>
          </dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <ul className="warnings">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="btn btn-primary" disabled={!!d.busy || units === 0n} onClick={propose}>
          {d.busy === "propose" ? "Proposing…" : "Propose as Tesa key"}
        </button>
        <span className="muted small">Creates a Squads vault transaction: begin_op → swap → end_op</span>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ proposals

const STATUS_CLASS: Record<string, string> = {
  Active: "st-active",
  Approved: "st-approved",
  Executed: "st-executed",
  Rejected: "st-rejected",
  Cancelled: "st-cancelled",
  Executing: "st-active",
  Draft: "st-cancelled",
};

function Proposals({ d }: { d: Demo }) {
  const s = d.state!;
  return (
    <section className="card" aria-labelledby="proposals-h">
      <div className="card-head">
        <h2 id="proposals-h">Proposals</h2>
        <span className="muted small">
          Threshold {s.multisig.threshold} of 2 · {String(s.multisig.transactionIndex)} so far
        </span>
      </div>
      {d.proposals.length === 0 ? (
        <p className="empty">No proposals yet. Use New operation to create the first one.</p>
      ) : (
        <ul className="proposals">
          {d.proposals.map((p) => (
            <ProposalRow key={String(p.index)} d={d} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProposalRow({ d, p }: { d: Demo; p: ProposalView }) {
  const s = d.state!;
  const keyOf = (r: Role) => d.demo.keys[r].publicKey.toBase58();
  const voted = (r: Human, list: string[]) => list.includes(keyOf(r));
  const idx = p.index;
  const tag = `#${idx}`;
  const busy = !!d.busy;
  const isOp = p.kind === "allocate" || p.kind === "redeem";

  const vote = (r: Role, v: "approve" | "reject" | "cancel") =>
    d.run(`${v}-${idx}-${r}`, `${v === "approve" ? "Approve" : v === "reject" ? "Reject" : "Cancel"} ${tag}`, ROLE_LABEL[r], () =>
      d.demo.vote(r, idx, v)
    );

  const execute = async (r: Role) => {
    // O cron de preço da seção 5: republica o NAV se estiver perto de vencer.
    const age = s.chainTime - s.price.publishTs;
    if (isOp && age > s.policy.maxPriceAgeSecs - 300) {
      await d.run("nav", "Refresh NAV before execution (price cron)", ROLE_LABEL.operator, () => d.demo.publishNav(s.price.priceE9));
    }
    await d.run(`exec-${idx}`, `Execute ${tag}: ${p.summary}`, ROLE_LABEL[r], () => d.demo.execute(r, idx));
  };

  return (
    <li className="proposal">
      <div className="p-head">
        <span className="p-idx num">{tag}</span>
        <span className="p-sum">{p.summary}</span>
        <span className={`status ${STATUS_CLASS[p.status] ?? ""}`}>{p.status}</span>
      </div>
      {p.minOut !== undefined && (
        <p className="p-meta num">
          Minimum received {fmt(p.minOut)} {p.kind === "allocate" ? "USDY" : "USDC"}
        </p>
      )}
      <div className="votes">
        {HUMANS.map((r) => {
          // O voto mais recente vence: cancelar vem depois de aprovar.
          const v = voted(r, p.cancelled) ? "cx" : voted(r, p.rejected) ? "no" : voted(r, p.approved) ? "yes" : "";
          const text = { cx: "voted to cancel", no: "rejected", yes: "approved", "": "pending" }[v];
          return (
            <span key={r} className={`vote ${v}`}>
              {ROLE_LABEL[r]} {text}
            </span>
          );
        })}
      </div>
      {p.status === "Active" && (
        <div className="p-actions">
          {HUMANS.filter((r) => !voted(r, p.approved) && !voted(r, p.rejected)).map((r) => (
            <span key={r} className="pair">
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => vote(r, "approve")}>
                Approve as {ROLE_LABEL[r]}
              </button>
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => vote(r, "reject")}>
                Reject
              </button>
            </span>
          ))}
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => vote("tesa", "approve")}>
            Tesa key tries to approve
          </button>
        </div>
      )}
      {p.status === "Approved" && (
        <div className="p-actions">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => execute("cfo")}>
            {d.busy === `exec-${idx}` ? "Executing…" : "Execute as CFO"}
          </button>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => d.run(`exec-${idx}`, `Execute ${tag}`, ROLE_LABEL.tesa, () => d.demo.execute("tesa", idx))}>
            Tesa key tries to execute
          </button>
          {HUMANS.filter((r) => !voted(r, p.cancelled)).map((r) => (
            <button key={r} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => vote(r, "cancel")}>
              Cancel as {ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ on-chain history

function History({ d }: { d: Demo }) {
  const cluster = d.demo.cfg.cluster;
  return (
    <section className="card" aria-labelledby="history-h">
      <div className="card-head">
        <h2 id="history-h">Vault history</h2>
        <a className="muted small link" href={explorerAccount(d.demo.cfg.policy, cluster)} target="_blank" rel="noreferrer">
          Policy account ↗
        </a>
      </div>
      {d.activity.length === 0 ? (
        <p className="empty">Loading executions from the chain…</p>
      ) : (
        <ul className="ledger">
          {d.activity.map((a) => (
            <li key={a.signature} className={a.ok ? "" : "fail"}>
              <span className={`badge ${a.ok ? "ok" : "bad"}`}>{a.ok ? "Executed" : "Rejected"}</span>
              <div className="l-main">
                <p className="l-t">
                  {a.title}
                  {a.error && <code>{a.error}</code>}
                </p>
                <p className="l-d num">{a.detail}</p>
              </div>
              <div className="l-side">
                <span className="muted small num">{a.time ? new Date(a.time * 1000).toLocaleTimeString() : ""}</span>
                <a className="link small" href={explorerTx(a.signature, cluster)} target="_blank" rel="noreferrer">
                  Solscan ↗
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ side cards

/** Clientes finais da fintech (exemplos). Participação fixa no cofre; sub-ledger da API da Tesa. */
const CUSTOMERS = [
  { name: "Lima Bakery", kind: "SMB · São Paulo", share: 4_000 },
  { name: "Costa Logistics", kind: "SMB · Curitiba", share: 3_500 },
  { name: "Rocha Design", kind: "Freelancer · Recife", share: 2_500 },
];
const FINTECH_FEE_BPS = 1_000n;

function Customers({ s }: { s: VaultState }) {
  const nav = s.price.priceE9;
  const total = s.usdc + usdyValue(s.usdy, nav);
  const unrealized = usdyValue(s.position.usdyUnits, nav) - s.position.costBasisUsdc;
  const yieldTotal = unrealized + s.position.realizedPnlUsdc;
  const fee = yieldTotal > 0n ? (yieldTotal * FINTECH_FEE_BPS) / 10_000n : 0n;
  const passed = yieldTotal - fee;
  const of = (x: bigint, bps: number) => (x * BigInt(bps)) / 10_000n;
  const signed = (x: bigint) => `${x >= 0n ? "+" : "−"}${fmt(x < 0n ? -x : x)}`;

  return (
    <section className="card" aria-labelledby="customers-h">
      <div className="card-head">
        <h2 id="customers-h">Fintech customers</h2>
        <span className="muted small">Example accounts</span>
      </div>
      <p className="note">
        The fintech pools its customers' cash in one vault. Tesa's API keeps each customer's stake and passes the yield
        through, pro rata, from the on-chain NAV and position.
      </p>
      <table className="rules customers">
        <thead>
          <tr>
            <th scope="col">Customer</th>
            <th scope="col">Balance</th>
            <th scope="col">Yield</th>
          </tr>
        </thead>
        <tbody>
          {CUSTOMERS.map((c) => (
            <tr key={c.name}>
              <th scope="row">
                {c.name}
                <span className="c-sub">
                  {c.kind} · {c.share / 100}%
                </span>
              </th>
              <td className="num">{fmt(of(total - fee, c.share))}</td>
              <td className={`num ${passed >= 0n ? "pos" : "neg"}`}>{signed(of(passed, c.share))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">
              Fintech fee
              <span className="c-sub">{Number(FINTECH_FEE_BPS) / 100}% of the yield</span>
            </th>
            <td />
            <td className="num">{fmt(fee)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="note">Roadmap: one on-chain sub-account per customer, with shares that track the vault's value.</p>
    </section>
  );
}

function PolicyCard({ d }: { d: Demo }) {
  const s = d.state!;
  const nav = s.price.priceE9;
  const usdyVal = usdyValue(s.usdy, nav);
  const share = pct(usdyVal, s.usdc + usdyVal);
  const age = s.chainTime - s.price.publishTs;
  const fresh = age <= s.policy.maxPriceAgeSecs;

  const rows: { rule: string; limit: string; now: string; ok: boolean | null }[] = [
    { rule: "USDY share of treasury", limit: `≤ ${bpsPct(s.policy.maxYieldBps)}`, now: `${share.toFixed(1)}%`, ok: share <= s.policy.maxYieldBps / 100 },
    { rule: "USDC liquidity floor", limit: `≥ ${fmt(s.policy.minLiquidUsdc, 0)}`, now: fmt(s.usdc, 0), ok: s.usdc >= s.policy.minLiquidUsdc },
    { rule: "Per-operation cap", limit: `${fmt(s.policy.maxOpUsdc, 0)} USDC`, now: "", ok: null },
    { rule: "Slippage vs NAV", limit: `≤ ${bpsPct(s.policy.maxSlippageBps)}`, now: `market ${bpsPct(s.market.haircutBps)}`, ok: s.market.haircutBps <= s.policy.maxSlippageBps },
    { rule: "NAV freshness", limit: `≤ ${s.policy.maxPriceAgeSecs / 60} min`, now: ago(age), ok: fresh },
  ];

  const propose = (paused: boolean) =>
    d.run("pause", paused ? "Propose: pause the policy" : "Propose: resume the policy", ROLE_LABEL.tesa, async () =>
      d.demo.propose([await d.demo.setPausedIx(paused)], paused ? "Pause" : "Resume")
    );

  return (
    <section className="card" aria-labelledby="policy-h">
      <div className="card-head">
        <h2 id="policy-h">Policy, enforced on-chain</h2>
        <span className={`status ${s.policy.paused ? "st-rejected" : "st-executed"}`}>{s.policy.paused ? "Paused" : "Active"}</span>
      </div>
      <table className="rules">
        <thead>
          <tr>
            <th scope="col">Rule</th>
            <th scope="col">Limit</th>
            <th scope="col">Now</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule}>
              <th scope="row">{r.rule}</th>
              <td className="num">{r.limit}</td>
              <td className={`num ${r.ok === null ? "" : r.ok ? "pos" : "neg"}`}>{r.now}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        Checked by <code>begin_op</code> and <code>end_op</code> around every swap. Any breach reverts the whole transaction,
        swap included. Operation #{String(s.policy.opNonce)} is next.
      </p>
      <button className="btn btn-ghost btn-sm" disabled={!!d.busy} onClick={() => propose(!s.policy.paused)}>
        {s.policy.paused ? "Propose resume" : "Propose emergency pause"}
      </button>
    </section>
  );
}

function Signers({ d }: { d: Demo }) {
  const s = d.state!;
  const c = d.demo.cfg;
  const roles: { r: Role; perms: string }[] = [
    { r: "cfo", perms: "Initiate · Vote · Execute" },
    { r: "controller", perms: "Initiate · Vote · Execute" },
    { r: "tesa", perms: "Initiate only" },
  ];
  return (
    <section className="card" aria-labelledby="signers-h">
      <div className="card-head">
        <h2 id="signers-h">Signers</h2>
        <span className="muted small">2 of 2 humans</span>
      </div>
      <ul className="signers">
        {roles.map(({ r, perms }) => {
          const key = d.demo.keys[r].publicKey.toBase58();
          return (
            <li key={r}>
              <div>
                <p className="s-name">{ROLE_LABEL[r]}</p>
                <p className={`s-perm ${r === "tesa" ? "limited" : ""}`}>{perms}</p>
              </div>
              <div className="s-side">
                <a className="link small mono" href={explorerAccount(key, c.cluster)} target="_blank" rel="noreferrer">
                  {short(key)}
                </a>
                <span className={`small num ${s.sol[r] < 0.02 ? "neg" : "muted"}`}>{s.sol[r].toFixed(3)} SOL</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="note">Tesa can propose but never approve or execute: custody stays with the client.</p>
    </section>
  );
}

function Operator({ d }: { d: Demo }) {
  const s = d.state!;
  const nav = s.price.priceE9;
  const bump = (bps: bigint) => (nav * (10_000n + bps)) / 10_000n;
  const op = ROLE_LABEL.operator;
  const busy = !!d.busy;
  return (
    <section className="card operator" aria-labelledby="operator-h">
      <div className="card-head">
        <h2 id="operator-h">Demo controls</h2>
        <span className="muted small">Simulated market and NAV</span>
      </div>
      <div className="op-row">
        <div>
          <p className="lbl">USDY NAV</p>
          <p className="num op-v">
            {fmtPrice(nav)} <small>{ago(s.chainTime - s.price.publishTs)}</small>
          </p>
        </div>
        <div className="op-btns">
          <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => d.run("nav", `Publish NAV ${fmtPrice(bump(25n))}`, op, () => d.demo.publishNav(bump(25n)))}>
            +0.25%
          </button>
          <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => d.run("nav", `Publish NAV ${fmtPrice(bump(100n))}`, op, () => d.demo.publishNav(bump(100n)))}>
            +1%
          </button>
          <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => d.run("nav", "Republish NAV", op, () => d.demo.publishNav(nav))}>
            Refresh
          </button>
        </div>
      </div>
      <div className="op-row">
        <div>
          <p className="lbl">Market slippage</p>
          <p className="num op-v">{bpsPct(s.market.haircutBps)}</p>
        </div>
        <div className="op-btns">
          <button className={`btn btn-xs ${s.market.haircutBps <= 20 ? "btn-on" : "btn-ghost"}`} disabled={busy} onClick={() => d.run("mkt", "Market: normal (0.2%)", op, () => d.demo.setMarketSlippage(20))}>
            Normal
          </button>
          <button className={`btn btn-xs ${s.market.haircutBps >= 300 ? "btn-on" : "btn-ghost"}`} disabled={busy} onClick={() => d.run("mkt", "Market: stressed (3%)", op, () => d.demo.setMarketSlippage(300))}>
            Stressed
          </button>
        </div>
      </div>
      <div className="op-row cctp">
        <div>
          <p className="lbl">Cash from Ethereum · Circle CCTP</p>
          <p className="num op-v">{fmt(s.usdc, 0)} USDC <small>in the vault</small></p>
        </div>
        <div className="op-btns">
          <button
            className="btn btn-ghost btn-xs"
            disabled={busy}
            onClick={() => d.run("mint", "Bridge 50,000 USDC from Ethereum (simulated CCTP)", "Circle CCTP", () => d.demo.mintUsdcToVault(toUnits(50_000)))}
          >
            Bridge 50,000
          </button>
        </div>
        <ol className="cctp-steps">
          <li>Fintech burns USDC on Ethereum</li>
          <li>Circle attests the burn</li>
          <li>USDC is minted on Solana into the vault. The vault signs nothing.</li>
        </ol>
      </div>
      <p className="note">
        These stand in for the outside world: the Ondo NAV feed, the market, and Circle's bridge (simulated here; CCTP runs
        Ethereum Sepolia to Solana devnet). None of them can move money out of the vault.
      </p>
    </section>
  );
}

function SessionLog({ log, cluster }: { log: LogEntry[]; cluster: string }) {
  return (
    <section className="card" aria-labelledby="log-h" aria-live="polite">
      <div className="card-head">
        <h2 id="log-h">Transaction log</h2>
        <span className="muted small">This session</span>
      </div>
      {log.length === 0 ? (
        <p className="empty">Every transaction you send from this page appears here, with its result and settlement time.</p>
      ) : (
        <ul className="txlog">
          {log.map((e) => (
            <LogRow key={e.id} e={e} cluster={cluster} />
          ))}
        </ul>
      )}
    </section>
  );
}

function LogRow({ e, cluster }: { e: LogEntry; cluster: string }) {
  const r: TxResult | undefined = e.result;
  const state = e.pending ? "pending" : r?.ok ? "ok" : "bad";
  return (
    <li className={`tx ${state}`}>
      <p className="tx-t">
        <span className="tx-dot" aria-hidden="true" />
        {e.label}
      </p>
      <p className="tx-m small">
        {e.actor}
        {e.pending && " · sending…"}
        {r && ` · ${r.ok ? "confirmed" : "failed on-chain"} in ${(r.ms / 1000).toFixed(1)} s`}
      </p>
      {r && !r.ok && (
        <p className="tx-err small">
          <code>{r.error}</code> {r.errorText ?? (r.error && ERROR_TEXT[r.error])}
        </p>
      )}
      {e.note && <p className="tx-err small">{e.note}</p>}
      {r && (
        <a className="link small" href={explorerTx(r.signature, cluster)} target="_blank" rel="noreferrer">
          View on Solscan ↗
        </a>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ explainer + footer

function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-h">
      <h2 id="how-h">How one operation runs</h2>
      <div className="flow">
        <div className="flow-step">
          <p className="lbl">Fund</p>
          <p>A fintech built on Ethereum moves USDC to the vault on Solana with Circle CCTP: burn, attest, mint.</p>
        </div>
        <div className="flow-step">
          <p className="lbl">Propose</p>
          <p>The Tesa backend builds the transaction and creates a Squads proposal with a key that can only initiate.</p>
        </div>
        <div className="flow-step">
          <p className="lbl">Approve</p>
          <p>CFO and Controller sign in the client's multisig. Two of two are required. Tesa cannot vote.</p>
        </div>
        <div className="flow-step wide">
          <p className="lbl">Execute, atomically</p>
          <div className="tx-anatomy">
            <span className="seg-a">
              <b>begin_op</b> checks pause, NAV freshness, per-op cap, balance; snapshots balances
            </span>
            <span className="seg-b">
              <b>swap</b> USDC ⇄ USDY (Jupiter in production; simulated here)
            </span>
            <span className="seg-a">
              <b>end_op</b> checks min received, slippage vs NAV, USDY cap, USDC floor, exact outflow; records cost basis
            </span>
          </div>
          <p>
            The policy never calls the swap. It measures vault balances before and after, so it works inside Squads and with
            any route. If any check fails, the whole transaction reverts.
          </p>
        </div>
        <div className="flow-step">
          <p className="lbl">Distribute</p>
          <p>The fintech's customers each see their share of the yield, computed from the on-chain NAV and position.</p>
        </div>
      </div>
    </section>
  );
}

function Footer({ demo: d }: { demo: Demo }) {
  const c = d.demo.cfg;
  return (
    <footer className="foot">
      <p>
        Demo environment on Solana {c.cluster}: simulated USDC and USDY, a simulated swap market and CCTP bridge, example
        fintech customers, and demo keys for every signer held in this page. The Squads v4 multisig and the Tesa policy program (
        <a className="link mono" href={explorerAccount(d.demo.policyProgram.programId.toBase58(), c.cluster)} target="_blank" rel="noreferrer">
          {short(d.demo.policyProgram.programId.toBase58())}
        </a>
        ) are the real on-chain programs. Vault created {new Date(c.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" })}.
      </p>
    </footer>
  );
}
