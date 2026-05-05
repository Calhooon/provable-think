import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, ArrowDownRight } from "lucide-react";
import { useAppStore, type CommitDescriptor } from "../store";
import { agentBaseUrl, getInfo } from "../lib/agent-client";
import {
  formatUsd,
  satsToUsd,
} from "../lib/exchange-rate";
import { cn } from "../lib/cn";

interface BalanceState {
  address?: string;
  balance: number;
}

function formatSats(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Header pill: the agent's funding wallet balance, lifted from the
 * remote `/info` endpoint. Click → opens the address on the ledger explorer.
 *
 * On every successful commit, the chip itself pulses a subtle amber
 * brighten + a SIBLING delta pill (`-36 sat`) slides in to its right
 * for ~1.4s. The sibling layout means the delta gets its own breathing
 * room in the header flex — no overlap, no choppy absolute float.
 *
 * USD valuation reads live from the WoC exchange rate stored at
 * `useAppStore().exchangeRate`. Falls back to "—" until first rate
 * fetch lands rather than guessing or hardcoding $25/BSV.
 */
export function BalanceChip() {
  // Wallet pulse should react to ANY commit on ANY conversation — funding
  // is shared so a fee landing in conv-A still drains the same wallet
  // you're paying out of for conv-B. Subscribe to the conv map and project
  // inside useMemo so we don't allocate a new array on every store update.
  const conversations = useAppStore((s) => s.conversations);
  const conversationIds = useAppStore((s) => s.conversationIds);
  const commits = useMemo<CommitDescriptor[]>(() => {
    const out: CommitDescriptor[] = [];
    for (const id of conversationIds) {
      const conv = conversations[id];
      if (conv) out.push(...conv.commits);
    }
    return out;
  }, [conversations, conversationIds]);
  const exchangeRate = useAppStore((s) => s.exchangeRate);
  const [state, setState] = useState<BalanceState>({ balance: 0 });
  const [delta, setDelta] = useState<number | null>(null);
  const [pulse, setPulse] = useState(false);
  const lastCommitTxidRef = useRef<string | null>(null);
  const optimisticBalRef = useRef<number | null>(null);

  // Initial fetch + poll loop.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    async function tick() {
      try {
        const info = await getInfo();
        const bal =
          typeof info.balance === "number"
            ? info.balance
            : (info.balance?.confirmed ?? 0) + (info.balance?.unconfirmed ?? 0);
        if (!cancelled) {
          setState({ address: info.address, balance: bal });
          optimisticBalRef.current = bal;
        }
      } catch {
        /* swallow — chip stays at last known */
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, 30000);
      }
    }
    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // React to commits: deltify + optimistically decrement balance until
  // the next /info poll catches up.
  useEffect(() => {
    const last = commits[commits.length - 1];
    if (!last || last.txid === lastCommitTxidRef.current) return;
    lastCommitTxidRef.current = last.txid;
    const fee = last.feeSats;
    if (!fee || fee <= 0) return;
    setDelta(fee);
    setPulse(true);
    optimisticBalRef.current = (optimisticBalRef.current ?? state.balance) - fee;
    setState((s) => ({ ...s, balance: optimisticBalRef.current ?? s.balance }));
    const t1 = window.setTimeout(() => setDelta(null), 1700);
    const t2 = window.setTimeout(() => setPulse(false), 700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [commits, state.balance]);

  const woc = useMemo(
    () =>
      state.address
        ? `https://whatsonchain.com/address/${state.address}`
        : agentBaseUrl,
    [state.address],
  );

  const balText = formatSats(state.balance);
  const usdText = formatUsd(satsToUsd(state.balance, exchangeRate?.rateUsd ?? null));

  return (
    <div className="inline-flex items-center gap-1.5">
      <motion.a
        href={woc}
        target="_blank"
        rel="noopener noreferrer"
        animate={pulse ? { scale: [1, 1.03, 1] } : { scale: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full",
          "border border-[color:var(--color-wallet)]/30 bg-[color:var(--color-wallet-bg)]",
          "text-xs font-medium text-[color:var(--color-wallet)] font-mono tabular-nums",
          "hover:border-[color:var(--color-wallet)]/60 transition-colors",
          "whitespace-nowrap",
        )}
        title={`Agent funding · ${state.address ?? "address loading…"} · click to open the ledger explorer`}
      >
        <Wallet className="w-3 h-3 flex-none" aria-hidden="true" />
        <span className="hidden sm:inline text-[10px] uppercase tracking-wider opacity-70">
          funding
        </span>
        <span className="font-semibold">{usdText}</span>
      </motion.a>
      <AnimatePresence>
        {delta !== null && (
          <motion.span
            key={`${delta}-${lastCommitTxidRef.current}`}
            initial={{ opacity: 0, x: -8, width: 0 }}
            animate={{ opacity: 1, x: 0, width: "auto" }}
            exit={{ opacity: 0, x: 8 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "inline-flex items-center gap-0.5 overflow-hidden",
              "text-[11px] font-mono font-semibold",
              "px-2 py-1 rounded-full",
              "bg-[color:var(--color-tamper)]/10 text-[color:var(--color-tamper)]",
              "border border-[color:var(--color-tamper)]/25",
              "whitespace-nowrap pointer-events-none",
            )}
            aria-hidden="true"
          >
            <ArrowDownRight className="w-3 h-3 flex-none" />
            <span>−{"<1¢"}</span>
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
