import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Activity, AlertCircle, ArrowDown } from "lucide-react";
import { Pane, Badge, Counter, EmptyState, ScopeChip, TxidPill } from "../components";
import { useAppStore, type CommitDescriptor } from "../store";
import { motion as motionTokens } from "../lib/tokens";
import { cn } from "../lib/cn";
import { formatUsd as formatUsdLib, satsToUsd } from "../lib/exchange-rate";
import { isDramaticHook } from "../lib/hook-kinds";

function formatUsd(sats: number, rateUsd: number | null): string {
  if (rateUsd === null) return "—";
  return `≈ ${formatUsdLib(satsToUsd(sats, rateUsd))}`;
}

function formatSats(n: number): string {
  return n.toLocaleString("en-US");
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export function OperatorPane() {
  // Operator pane mirrors ONLY the active conversation. Hero pane viewers
  // care about a single conversation's chain; the cross-conversation roll
  // up lives in the hero banner counters.
  const activeConvId = useAppStore((s) => s.activeConversationId);
  const commits = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.commits ?? [] : [],
  );
  const events = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.events ?? [] : [],
  );
  const exchangeRate = useAppStore((s) => s.exchangeRate);
  const selectedTxid = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.selectedTxid ?? null : null,
  );
  const setSelectedTxidStore = useAppStore((s) => s.setSelectedTxid);
  const setSelectedTxid = (txid: string | null) => {
    if (activeConvId) setSelectedTxidStore(activeConvId, txid);
  };

  const errorCount = useMemo(
    () => events.filter((e) => e.kind === "commit-error").length,
    [events],
  );
  const totalSats = useMemo(
    () => commits.reduce((s, c) => s + c.feeSats, 0),
    [commits],
  );
  const rateUsd = exchangeRate?.rateUsd ?? null;

  // Newest first.
  const ordered = useMemo(() => [...commits].reverse(), [commits]);
  const latest = ordered[0];
  // selectedTxid pinned; otherwise auto-follow latest.
  const heroCommit =
    (selectedTxid && ordered.find((c) => c.txid === selectedTxid)) || latest;
  const isPinned = selectedTxid !== null && heroCommit?.txid === selectedTxid;
  const rest = ordered.filter((c) => c.txid !== heroCommit?.txid);

  return (
    <Pane
      title="Operator console"
      badge={
        <Badge variant={commits.length > 0 ? "confirmed" : "default"}>
          {commits.length === 0
            ? "idle"
            : `${commits.length} anchored`}
        </Badge>
      }
    >
      <div className="flex flex-col gap-4 h-full min-h-0">
        {/* Counters */}
        <div className="grid grid-cols-2 gap-3">
          <CounterCard
            label="Events anchored"
            value={commits.length}
            icon={<Activity className="w-3.5 h-3.5" aria-hidden="true" />}
          />
          <CounterCard
            label="Anchoring spend"
            value={totalSats}
            format={(n) => formatUsd(n, rateUsd).replace(/^≈\s*/, "")}
            sublabel="less than a thousandth of a cent per receipt"
          />
        </div>

        {errorCount > 0 && (
          <div
            className={cn(
              "rounded-lg border border-tamper/30 bg-tamper/5 px-3 py-2",
              "flex items-center gap-2 text-xs text-tamper",
            )}
            role="alert"
          >
            <AlertCircle className="w-4 h-4" aria-hidden="true" />
            {errorCount} broadcast {errorCount === 1 ? "failure" : "failures"} in this session
          </div>
        )}

        {/* Hero + compact tape feed */}
        <div className="flex-1 min-h-0 overflow-y-auto -mx-4 px-4">
          {commits.length === 0 ? (
            <EmptyState
              title="No commits yet"
              description="Each agent hook fires a real receipt on the public ledger. Send a question in the patient pane to begin — the latest anchor will headline here, with full history below."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {heroCommit && (
                <HeroCommitCard
                  commit={heroCommit}
                  pinned={isPinned}
                  onUnpin={() => setSelectedTxid(null)}
                />
              )}

              {rest.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <div className="px-1 text-[10px] uppercase tracking-wider text-fg-muted font-medium">
                    History · {rest.length} more
                  </div>
                  <ol className="flex flex-col gap-1">
                    <AnimatePresence initial={false}>
                      {rest.map((c) => (
                        <motion.li
                          key={c.txid}
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={{
                            duration: motionTokens.txidEnter,
                            ease: motionTokens.ease,
                          }}
                        >
                          <CompactRow
                            commit={c}
                            onClick={() => setSelectedTxid(c.txid)}
                          />
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Pane>
  );
}

function CounterCard({
  label,
  value,
  format,
  sublabel,
  icon,
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  sublabel?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-canvas/40 px-3 py-3">
      <div className="flex items-center gap-1.5 text-xs text-fg-muted uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <Counter
          value={value}
          format={format}
          label={label}
          className="text-2xl font-semibold text-fg tabular-nums"
        />
        {sublabel && (
          <span className="text-xs text-fg-muted">{sublabel}</span>
        )}
      </div>
    </div>
  );
}

function HeroCommitCard({
  commit,
  pinned,
  onUnpin,
}: {
  commit: CommitDescriptor;
  pinned: boolean;
  onUnpin: () => void;
}) {
  const isMined = commit.txStatus === "MINED";
  const isPropagating =
    commit.txStatus === "SEEN_ON_NETWORK" ||
    commit.txStatus === "ANNOUNCED_TO_NETWORK";
  const isOrphan =
    commit.txStatus === "SEEN_IN_ORPHAN_MEMPOOL" ||
    commit.txStatus === "REJECTED" ||
    commit.txStatus === "DOUBLE_SPEND_ATTEMPTED" ||
    commit.txStatus === "INVALID" ||
    commit.txStatus === "MALFORMED";
  return (
    <div
      className={cn(
        "rounded-xl border bg-surface px-4 py-4 shadow-sm",
        isOrphan
          ? "ring-1 ring-tamper/20 border-tamper/40 bg-tamper/5"
          : "ring-1 ring-accent/20 border-accent/40",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold",
            isOrphan ? "text-tamper" : "text-accent-dark",
          )}
        >
          {isOrphan
            ? `Broadcast failed · ${commit.txStatus}`
            : pinned ? "Pinned commit" : "Latest commit"}
        </span>
        {pinned ? (
          <button
            type="button"
            onClick={onUnpin}
            className={cn(
              "ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded",
              "text-[10px] font-medium text-fg-muted hover:text-fg-secondary",
              "border border-border hover:border-border-strong transition-colors",
            )}
            title="Resume following the latest commit"
          >
            <ArrowDown className="w-3 h-3" aria-hidden="true" />
            Follow latest
          </button>
        ) : (
          <span className="ml-auto text-[10px] text-fg-muted font-mono">
            {relativeTime(commit.ts)}
          </span>
        )}
      </div>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-fg uppercase tracking-wide">
              {commit.hookKind}
            </span>
            <span className="text-xs text-fg-muted">seq {commit.sequence}</span>
            {pinned && (
              <span className="text-xs text-fg-muted">
                · {relativeTime(commit.ts)}
              </span>
            )}
          </div>
          <ScopeChip tags={commit.scopeTags} />
        </div>
        <TxidPill
          txid={commit.txid}
          txStatus={
            isMined
              ? "confirmed"
              : isOrphan
                ? commit.txStatus
                : isPropagating
                  ? "propagating"
                  : "default"
          }
        />
      </div>
    </div>
  );
}

function CompactRow({
  commit,
  onClick,
}: {
  commit: CommitDescriptor;
  onClick: () => void;
}) {
  const isMined = commit.txStatus === "MINED";
  const isPropagating =
    commit.txStatus === "SEEN_ON_NETWORK" ||
    commit.txStatus === "ANNOUNCED_TO_NETWORK";
  const isOrphan =
    commit.txStatus === "SEEN_IN_ORPHAN_MEMPOOL" ||
    commit.txStatus === "REJECTED" ||
    commit.txStatus === "DOUBLE_SPEND_ATTEMPTED" ||
    commit.txStatus === "INVALID" ||
    commit.txStatus === "MALFORMED";
  // De-emphasize lifecycle/plumbing hooks (configureSession, fiberStart,
  // getModel, getTools, stash, etc.) so the dramatic hooks (toolCalls,
  // chat responses, extension authoring) read louder. Same row layout,
  // dimmer ink for lifecycle.
  const dramatic = isDramaticHook(commit.hookKind);
  const dotColor = isMined
    ? "bg-confirmed"
    : isOrphan
      ? "bg-tamper"
      : isPropagating
        ? "bg-propagating"
        : "bg-fg-muted";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-md border bg-surface/60",
        "px-2.5 py-1.5 flex items-center gap-2",
        "hover:bg-canvas/60 hover:border-border-strong transition-colors",
        "focus:outline-none focus:ring-1 focus:ring-accent/40",
        dramatic ? "border-border" : "border-border/60 opacity-70",
      )}
      title={
        dramatic
          ? "Headline event — click to pin as hero"
          : "Lifecycle / audit plumbing — click to pin as hero"
      }
    >
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full flex-none",
          dotColor,
          !dramatic && "opacity-60",
        )}
        aria-hidden="true"
      />
      <span className="text-[10px] text-fg-muted tabular-nums w-8 flex-none">
        seq {commit.sequence}
      </span>
      <span
        className={cn(
          "uppercase tracking-wide truncate flex-1",
          dramatic
            ? "text-[11px] font-semibold text-fg-secondary"
            : "text-[10px] font-normal text-fg-muted",
        )}
      >
        {commit.hookKind}
      </span>
      <span className="text-[10px] font-mono text-fg-muted truncate flex-none max-w-[6rem]">
        {commit.txid.slice(0, 8)}…
      </span>
      <span className="text-[10px] text-fg-muted flex-none">
        {relativeTime(commit.ts)}
      </span>
    </button>
  );
}
