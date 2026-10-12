import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TesaDemo, type ActivityItem, type DemoConfig, type ProposalView, type TxResult, type VaultState } from "./chain";
import config from "./demo-config.json";

export type LogEntry = {
  id: number;
  at: number;
  label: string;
  actor: string;
  result?: TxResult;
  pending: boolean;
  note?: string;
  /** Link extra (ex.: o burn no Etherscan de uma transferência CCTP). */
  extra?: { href: string; label: string };
};

const STATE_EVERY_MS = 8_000;
const ACTIVITY_EVERY_MS = 20_000;

export function useDemo() {
  const demo = useMemo(() => new TesaDemo(config as DemoConfig), []);
  const [state, setState] = useState<VaultState | null>(null);
  const [proposals, setProposals] = useState<ProposalView[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const s = await demo.state();
      setState(s);
      setProposals(await demo.proposals(s.multisig.transactionIndex));
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [demo]);

  const refreshActivity = useCallback(async () => {
    try {
      setActivity(await demo.activity());
    } catch {
      /* limite da RPC pública: tenta de novo no próximo ciclo */
    }
  }, [demo]);

  useEffect(() => {
    refresh();
    refreshActivity();
    const a = setInterval(refresh, STATE_EVERY_MS);
    const b = setInterval(refreshActivity, ACTIVITY_EVERY_MS);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [refresh, refreshActivity]);

  const pushLog = (entry: Omit<LogEntry, "id" | "at">) => {
    const id = ++seq.current;
    setLog((l) => [{ id, at: Date.now(), ...entry }, ...l].slice(0, 30));
    return id;
  };
  const patchLog = (id: number, patch: Partial<LogEntry>) =>
    setLog((l) => l.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  /** Roda uma ação on-chain com registro no log da sessão e atualização do estado em seguida. */
  const run = useCallback(
    async (key: string, label: string, actor: string, fn: () => Promise<TxResult>) => {
      if (busy) return undefined;
      setBusy(key);
      const id = pushLog({ label, actor, pending: true });
      try {
        const result = await fn();
        patchLog(id, { pending: false, result });
        return result;
      } catch (e) {
        patchLog(id, { pending: false, note: e instanceof Error ? e.message : String(e) });
        return undefined;
      } finally {
        setBusy(null);
        await refresh();
        refreshActivity();
      }
    },
    [busy, refresh, refreshActivity]
  );

  return { demo, state, proposals, activity, loadError, busy, setBusy, log, pushLog, patchLog, run, refresh };
}
