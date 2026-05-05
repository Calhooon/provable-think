import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowUpRight, Activity } from "lucide-react";
import { useAppStore } from "../store";
import { cn } from "../lib/cn";

/**
 * Top-bar live ticker — streams every commit landing on chain, newest
 * on the left, animated in / out. Builds trust through transparency:
 * the visitor watches sequence numbers tick up, the public ledger links go
 * green, sat costs roll past. Bloomberg-terminal energy for AI audit.
 *
 * Pulls from every conversation in the store (not just the active
 * one) so a visitor on Conv A still sees Conv B's commits land — the
 * agent is one wallet, one chain, one audit trail.
 */
export function CommitTicker() {
  const conversations = useAppStore((s) => s.conversations);
  const conversationIds = useAppStore((s) => s.conversationIds);

  // Flatten the most recent commits across every conversation, sort by
  // wall-clock arrival, take the top N. We use the conv events stream
  // (which carries `commit` events with hookKind + txid + sequence) so
  // we get real-time-broadcast freshness.
  const recent = useMemo(() => {
    type Tick = {
      key: string;
      txid: string;
      seq: number;
      hookKind: string;
      conversationId: string;
      ts: number;
    };
    const ticks: Tick[] = [];
    for (const id of conversationIds) {
      const conv = conversations[id];
      if (!conv) continue;
      for (const e of conv.events) {
        if (e.kind !== "commit" || !e.txid) continue;
        // Skip gate/wave-5 conv ticks from the public ticker — same
        // hide-list as ConversationTabs.
        const title = conv.summary?.title?.toLowerCase() ?? "";
        if (
          title.startsWith("wave ") ||
          title.includes("16-hook gate") ||
          title === "quality-gate"
        ) {
          continue;
        }
        ticks.push({
          key: `${e.conversationId}:${e.txid}`,
          txid: e.txid,
          seq: e.sequence ?? 0,
          hookKind: e.hookKind ?? "?",
          conversationId: e.conversationId ?? "?",
          ts: Date.parse(e.ts ?? "") || 0,
        });
      }
    }
    ticks.sort((a, b) => b.ts - a.ts);
    return ticks.slice(0, 6);
  }, [conversations, conversationIds]);

  if (recent.length === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-fg-muted font-mono">
        <Activity className="w-3 h-3 animate-pulse" aria-hidden="true" />
        <span>Awaiting first commit on the public ledger…</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 overflow-hidden">
      <Activity
        className="w-3 h-3 flex-none text-confirmed"
        aria-hidden="true"
      />
      <div className="text-[10px] uppercase tracking-wider text-fg-muted font-medium flex-none">
        Live · public ledger
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-1.5 overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          {recent.map((tick) => (
            <motion.a
              key={tick.key}
              href={`https://whatsonchain.com/tx/${tick.txid}`}
              target="_blank"
              rel="noopener noreferrer"
              initial={{ opacity: 0, x: 24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
              className={cn(
                "shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded",
                "border border-border/60 bg-muted/40 hover:bg-muted hover:border-accent/40",
                "text-[10px] font-mono tabular-nums transition-colors",
                "text-fg-secondary hover:text-fg",
              )}
              title={`seq ${tick.seq} · ${tick.hookKind} · ${tick.txid}`}
            >
              <span className="text-fg-muted">seq</span>
              <span className="font-semibold text-fg">{tick.seq}</span>
              <span className="text-fg-muted">·</span>
              <span className="text-accent">{tick.hookKind}</span>
              <span className="text-fg-muted">·</span>
              <span>{"<1¢"}</span>
              <ArrowUpRight
                className="w-2.5 h-2.5 ml-0.5 opacity-60"
                aria-hidden="true"
              />
            </motion.a>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
