import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  KeyRound,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  Lock,
  ZapOff,
  ArrowDown,
} from "lucide-react";
import { Pane, Badge, EmptyState, PersonaToggle, ScopeChip } from "../components";
import {
  useAppStore,
  type CommitDescriptor,
  type VerificationResult,
  type VerificationStep,
} from "../store";
import { motion as motionTokens } from "../lib/tokens";
import { cn } from "../lib/cn";
import { tamperEnvelope } from "../lib/agent-client";
import { fireTamperDetected } from "../components/TamperFlash";
import { reverifyOne, swapToWrongKey } from "../lib/verifier";
import type { Persona } from "../types/agent-events";

function personaLabel(p: Persona): string {
  switch (p) {
    case "compliance-officer": return "Compliance Officer";
    case "patient": return "Patient";
    case "external-auditor": return "External HIPAA Auditor";
  }
}

function personaScopeText(p: Persona): string {
  switch (p) {
    case "compliance-officer":
      return "Sees: every event tagged PHI (the umbrella scope).";
    case "patient":
      return "Sees: every event from their own clinical session.";
    case "external-auditor":
      return "Sees: only events tagged operations (QA review) or de-identified.";
  }
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

export function AuditorPane() {
  // Auditor verifies the active conversation's chain. Persona is global —
  // a CO key sees PHI events across every conversation, but the current
  // pane only renders the chain in front of the user.
  const persona = useAppStore((s) => s.persona);
  const setPersona = useAppStore((s) => s.setPersona);
  const activeConvId = useAppStore((s) => s.activeConversationId);
  const commits = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.commits ?? [] : [],
  );
  const verifications = useAppStore((s) => {
    if (!activeConvId) return {} as Record<string, VerificationResult>;
    return s.conversations[activeConvId]?.verifications[persona] ?? {};
  });
  // Coverage HUD: count how many of the active conv's commits are
  // decryptable per persona. The numbers update live as verifications
  // resolve. CISO sees at a glance "CO 8/8 · Patient 3/8 · External 6/8"
  // — the persona scope filter made viscerally legible.
  const allVerifications = useAppStore((s) =>
    activeConvId
      ? s.conversations[activeConvId]?.verifications ?? null
      : null,
  );
  const coverage = useMemo(() => {
    const total = commits.length;
    const counts = {
      "compliance-officer": 0,
      patient: 0,
      "external-auditor": 0,
    } as Record<Persona, number>;
    if (!allVerifications) return { total, counts };
    for (const p of [
      "compliance-officer",
      "patient",
      "external-auditor",
    ] as Persona[]) {
      const ver = allVerifications[p] ?? {};
      for (const c of commits) {
        const v = ver[c.txid];
        if (v?.outOfScope) continue;
        if (v?.plaintext) counts[p]++;
      }
    }
    return { total, counts };
  }, [allVerifications, commits]);
  const selectedTxid = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.selectedTxid ?? null : null,
  );
  const setSelectedTxidStore = useAppStore((s) => s.setSelectedTxid);
  const setSelectedTxid = (txid: string | null) => {
    if (activeConvId) setSelectedTxidStore(activeConvId, txid);
  };

  // Newest first.
  const ordered = useMemo(() => [...commits].reverse(), [commits]);
  const latest = ordered[0];
  const heroCommit =
    (selectedTxid && ordered.find((c) => c.txid === selectedTxid)) || latest;
  const isPinned = selectedTxid !== null && heroCommit?.txid === selectedTxid;
  const heroResult = heroCommit ? verifications[heroCommit.txid] : undefined;
  const rest = ordered.filter((c) => c.txid !== heroCommit?.txid);

  return (
    <Pane
      title="Auditor verifier"
      badge={<Badge variant="scope">persona</Badge>}
    >
      <div className="flex flex-col gap-3 h-full min-h-0">
        <div className="flex flex-col gap-1.5">
          <PersonaToggle value={persona} onChange={setPersona} />
          <PersonaCoverageRow coverage={coverage} active={persona} onPick={setPersona} />
          <p className="text-xs text-fg-muted px-1 font-mono">
            {personaScopeText(persona)}
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto -mx-4 px-4">
          {ordered.length === 0 ? (
            <EmptyState
              title="No events to audit yet"
              description="When the agent fires a hook, the verifier here independently re-runs the same 11-step CLI pipeline auditors use. Switch persona above to see how the same chain looks under a different viewing key — events you weren't authorized to read appear as 'Not in your view'."
            />
          ) : (
            <div className="flex flex-col gap-3">
              {heroCommit && (
                <HeroVerificationCard
                  commit={heroCommit}
                  result={heroResult}
                  personaLabel={personaLabel(persona)}
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
                            duration: motionTokens.micro,
                            ease: motionTokens.ease,
                          }}
                        >
                          <CompactVerificationRow
                            commit={c}
                            result={verifications[c.txid]}
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

        <TamperBar
          conversationId={activeConvId}
          targetTxid={heroCommit?.txid}
          targetSequence={heroCommit?.sequence}
          targetCommitHash={heroCommit?.commitHash}
          targetIsHero={Boolean(heroCommit)}
          targetIsPinned={isPinned}
          persona={persona}
        />
      </div>
    </Pane>
  );
}

function TamperBar({
  conversationId,
  targetTxid,
  targetSequence,
  targetCommitHash,
  targetIsHero,
  targetIsPinned,
  persona,
}: {
  conversationId: string | null;
  targetTxid?: string;
  targetSequence?: number;
  targetCommitHash?: string;
  targetIsHero: boolean;
  targetIsPinned: boolean;
  persona: Persona;
}) {
  const [busy, setBusy] = useState<"tamper" | "wrong-key" | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const disabled =
    !conversationId ||
    !targetTxid ||
    targetSequence === undefined ||
    busy !== null;

  async function handleTamper() {
    if (!conversationId || !targetTxid || targetSequence === undefined) return;
    setBusy("tamper");
    setFeedback("Mutating envelope ciphertext in R2…");
    try {
      const r = await tamperEnvelope(conversationId, targetSequence);
      if (r.ok) {
        setFeedback(`Envelope ${r.envelopeKey.split("/").pop()} mutated. Re-verifying…`);
        await reverifyOne(persona, targetTxid);
        setFeedback("Tamper detected — verifier reports integrity FAILURE.");
        // Fire the visceral full-screen flash so a CISO sees the
        // immutability story even if their eyes weren't on the auditor
        // pane at the moment of the flip.
        fireTamperDetected({
          conversationId,
          sequence: targetSequence,
          envelopeKey: r.envelopeKey,
          txid: targetTxid,
          commitHash: targetCommitHash,
        });
      } else {
        setFeedback("Tamper request denied (DEMO_MODE off?).");
      }
    } catch (e) {
      setFeedback(`Tamper failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      setTimeout(() => setFeedback(null), 6000);
    }
  }

  async function handleWrongKey() {
    if (!targetTxid) return;
    setBusy("wrong-key");
    setFeedback(`Swapping ${personaLabel(persona)} priv for an unknown key…`);
    const restore = swapToWrongKey(persona);
    try {
      await reverifyOne(persona, targetTxid);
      setFeedback(
        "AEAD silence: plaintext stays sealed. Original key restored.",
      );
    } finally {
      restore();
      await reverifyOne(persona, targetTxid);
      setBusy(null);
      setTimeout(() => setFeedback(null), 6000);
    }
  }

  return (
    <div className="border-t border-border pt-3 -mx-4 px-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={handleTamper}
          className={cn(
            "flex-1 px-3 py-2 rounded-md text-xs font-semibold uppercase tracking-wider",
            "bg-tamper text-white hover:bg-tamper/90 transition-colors",
            "flex items-center justify-center gap-1.5",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
          title="Mutate the hero commit's envelope ciphertext in R2 — the verifier flips to red instantly."
        >
          {busy === "tamper" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <ZapOff className="w-3.5 h-3.5" />
          )}
          Tamper envelope
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={handleWrongKey}
          className={cn(
            "flex-1 px-3 py-2 rounded-md text-xs font-semibold uppercase tracking-wider",
            "border border-tamper text-tamper bg-tamper/5 hover:bg-tamper/10 transition-colors",
            "flex items-center justify-center gap-1.5",
            "disabled:opacity-40 disabled:cursor-not-allowed",
          )}
          title="Use a fresh, unauthorized priv key — AEAD rejects, plaintext stays sealed."
        >
          {busy === "wrong-key" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <KeyRound className="w-3.5 h-3.5" />
          )}
          Try wrong key
        </button>
      </div>
      {feedback ? (
        <p className="text-[11px] text-tamper font-mono leading-tight">
          {feedback}
        </p>
      ) : (
        <p className="text-[11px] text-fg-muted leading-tight">
          {targetIsHero
            ? `Acts on the ${targetIsPinned ? "pinned" : "latest"} commit shown above. The ledger anchor is unchanged — only off-ledger ciphertext is mutated.`
            : "Tampering modifies the actual R2 envelope. The ledger anchor is unchanged — only the off-ledger ciphertext is mutated."}
        </p>
      )}
    </div>
  );
}

function HeroVerificationCard({
  commit,
  result,
  personaLabel,
  pinned,
  onUnpin,
}: {
  commit: CommitDescriptor;
  result: VerificationResult | undefined;
  personaLabel: string;
  pinned: boolean;
  onUnpin: () => void;
}) {
  const status = result?.status ?? "pending";
  const outOfScope = result?.outOfScope === true;
  const upstreamUnavailable = result?.upstreamUnavailable === true;

  let HeaderIcon = Circle;
  let headerColor = "text-fg-muted";
  let headerLabel: string;
  if (status === "ok") {
    HeaderIcon = ShieldCheck;
    headerColor = "text-confirmed";
    headerLabel = "Verified · plaintext recovered";
  } else if (status === "fail" && outOfScope) {
    HeaderIcon = Lock;
    headerColor = "text-scope";
    headerLabel = "Not in your view";
  } else if (status === "fail" && upstreamUnavailable) {
    HeaderIcon = AlertTriangle;
    headerColor = "text-amber-500";
    headerLabel = "Verifier unavailable · upstream throttled";
  } else if (status === "fail") {
    HeaderIcon = ShieldAlert;
    headerColor = "text-tamper";
    headerLabel = "Integrity FAIL · tamper detected";
  } else if (status === "running") {
    HeaderIcon = Loader2;
    headerColor = "text-propagating";
    headerLabel = "Verifying…";
  } else {
    headerLabel = "Pending";
  }

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface px-4 py-4",
        "ring-1 shadow-sm",
        status === "ok" && "border-confirmed/40 ring-confirmed/15",
        status === "fail" && upstreamUnavailable && "border-amber-400/40 bg-amber-400/5 ring-amber-400/15",
        status === "fail" && !outOfScope && !upstreamUnavailable && "border-tamper/50 bg-tamper/5 ring-tamper/15",
        status === "fail" && outOfScope && "border-scope/40 bg-scope/5 ring-scope/15",
        status === "running" && "border-propagating/40 ring-propagating/15",
        status === "pending" && "border-border ring-border",
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">
          {pinned ? "Pinned · auditor view" : "Latest · auditor view"}
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
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <HeaderIcon
              className={cn(
                "w-4 h-4 flex-none",
                headerColor,
                status === "running" && "animate-spin",
              )}
              aria-hidden="true"
            />
            <span className={cn("text-sm font-semibold", headerColor)}>
              {headerLabel}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-fg-secondary">
            <span className="font-mono">{commit.txid.slice(0, 8)}…</span>
            <span className="text-fg-muted">·</span>
            <span>seq {commit.sequence}</span>
            <span className="text-fg-muted">·</span>
            <span className="uppercase tracking-wide text-[11px]">{commit.hookKind}</span>
          </div>
          <ScopeChip tags={commit.scopeTags} className="mt-0.5" />
        </div>
      </div>

      {result && <PipelineList steps={result.steps} />}

      {result?.outOfScope && (
        <p className="mt-2 text-xs text-scope leading-snug">
          The {personaLabel}'s viewing key wasn't on the recipient list when
          this event was sealed — its scope doesn't include the labels on
          this event. The chain still proves this event happened; the
          encryption simply doesn't include this auditor as a reader. Same
          chain, different view by design.
        </p>
      )}
      {result?.status === "fail" && upstreamUnavailable && (
        <p className="mt-2 text-xs text-amber-600 leading-snug">
          The verifier couldn't reach the ledger explorer to fetch this transaction
          — usually a transient rate-limit spike, not a tamper. The chain
          anchor is unchanged. The pipeline will re-run automatically next
          time you switch persona or re-open this commit.
        </p>
      )}
      {result?.status === "fail" && !result.outOfScope && !upstreamUnavailable && (
        <p className="mt-2 text-xs text-tamper leading-snug">
          {result.error}
        </p>
      )}
      {result?.status === "ok" && result.plaintext && (
        <PlaintextPreview plaintext={result.plaintext} />
      )}
    </div>
  );
}

function CompactVerificationRow({
  commit,
  result,
  onClick,
}: {
  commit: CommitDescriptor;
  result: VerificationResult | undefined;
  onClick: () => void;
}) {
  const status = result?.status ?? "pending";
  const outOfScope = result?.outOfScope === true;
  const upstreamUnavailable = result?.upstreamUnavailable === true;

  let Icon = Circle;
  let color = "text-fg-muted";
  let aria = "Pending";
  if (status === "ok") {
    Icon = CheckCircle2;
    color = "text-confirmed";
    aria = "Verified";
  } else if (status === "fail" && outOfScope) {
    Icon = Lock;
    color = "text-scope";
    aria = "Not in your view";
  } else if (status === "fail" && upstreamUnavailable) {
    Icon = AlertTriangle;
    color = "text-amber-500";
    aria = "Verifier unavailable";
  } else if (status === "fail") {
    Icon = ShieldAlert;
    color = "text-tamper";
    aria = "Integrity fail";
  } else if (status === "running") {
    Icon = Loader2;
    color = "text-propagating";
    aria = "Verifying";
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-md border border-border bg-surface/60",
        "px-2.5 py-1.5 flex items-center gap-2",
        "hover:bg-canvas/60 hover:border-border-strong transition-colors",
        "focus:outline-none focus:ring-1 focus:ring-accent/40",
      )}
      title="Click to inspect this commit's full pipeline"
    >
      <Icon
        className={cn(
          "w-3.5 h-3.5 flex-none",
          color,
          status === "running" && "animate-spin",
        )}
        aria-label={aria}
      />
      <span className="text-[10px] text-fg-muted tabular-nums w-8 flex-none">
        seq {commit.sequence}
      </span>
      <span className="text-[11px] uppercase tracking-wide text-fg-secondary truncate flex-1">
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

function PipelineList({ steps }: { steps: VerificationStep[] }) {
  return (
    <ol className="mt-2 space-y-0.5 font-mono">
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={cn(
            "flex items-start gap-2 text-[11px] leading-tight",
            s.status === "fail" ? "text-tamper" : "text-fg-secondary",
          )}
        >
          <span className="flex-none w-4 text-center">{stepGlyph(s.status)}</span>
          <span className="flex-none w-4 text-fg-muted text-right pr-1">
            {String(i + 1).padStart(2, "0")}
          </span>
          <span className="flex-1">
            {s.label}
            {s.detail && (
              <span className="text-fg-muted ml-1.5 font-normal italic">
                {s.detail}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function stepGlyph(status: VerificationStep["status"]): React.ReactNode {
  switch (status) {
    case "ok":
      return <CheckCircle2 className="w-3 h-3 text-confirmed" aria-hidden="true" />;
    case "fail":
      return <XCircle className="w-3 h-3 text-tamper" aria-hidden="true" />;
    case "running":
      return <Loader2 className="w-3 h-3 text-propagating animate-spin" aria-hidden="true" />;
    default:
      return <Circle className="w-3 h-3 text-fg-muted" aria-hidden="true" />;
  }
}

function PlaintextPreview({ plaintext }: { plaintext: string }) {
  const jsonStart = plaintext.indexOf("{");
  const json = jsonStart >= 0 ? plaintext.slice(jsonStart) : plaintext;
  let pretty: string;
  try {
    const parsed = JSON.parse(json);
    pretty = JSON.stringify(parsed, null, 2);
  } catch {
    pretty = json;
  }
  const truncated =
    pretty.length > 600 ? pretty.slice(0, 600) + "\n…" : pretty;
  return (
    <details className="mt-2 group">
      <summary className="text-xs font-medium text-fg-secondary cursor-pointer hover:text-accent-dark inline-flex items-center gap-1">
        Decrypted plaintext
        <span className="text-fg-muted text-[10px] group-open:hidden">▸</span>
        <span className="text-fg-muted text-[10px] hidden group-open:inline">▾</span>
      </summary>
      <pre
        className={cn(
          "mt-1.5 p-2 rounded-md bg-canvas border border-border",
          "text-[10px] leading-snug text-fg-secondary font-mono",
          "max-h-48 overflow-y-auto whitespace-pre-wrap break-all",
        )}
      >
        {truncated}
      </pre>
    </details>
  );
}

/**
 * Live "X / N" coverage row directly below the persona toggle.
 * Each chip shows the count of decryptable events for one persona,
 * highlights the active one, and is clickable to jump to that view.
 *
 * The CISO pitch hinges on this number being instantly legible:
 * "Compliance Officer sees 8 of 8. External Auditor sees 6 of 8 —
 * the operations slice. Patient sees 3 of 8 — only their own clinical
 * events." That's the persona-scope filter expressed as a single row
 * the visitor can absorb in a glance.
 */
function PersonaCoverageRow({
  coverage,
  active,
  onPick,
}: {
  coverage: { total: number; counts: Record<Persona, number> };
  active: Persona;
  onPick: (p: Persona) => void;
}) {
  const personas: Array<{ value: Persona; short: string; tone: string }> = [
    { value: "compliance-officer", short: "CO", tone: "text-confirmed" },
    { value: "patient", short: "Patient", tone: "text-accent" },
    { value: "external-auditor", short: "Auditor", tone: "text-amber-400" },
  ];
  const total = coverage.total;
  return (
    <div className="grid grid-cols-3 gap-1 px-1">
      {personas.map((p) => {
        const visible = coverage.counts[p.value];
        const pct = total === 0 ? 0 : Math.round((visible / total) * 100);
        const isActive = active === p.value;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => onPick(p.value)}
            className={cn(
              "flex flex-col items-start gap-0.5 px-2 py-1 rounded-md border text-left transition-colors",
              "focus:outline-none focus:ring-1 focus:ring-accent/40",
              isActive
                ? "border-accent/40 bg-accent/5"
                : "border-border bg-muted/30 hover:border-border-strong",
            )}
            title={`${p.short} sees ${visible} of ${total} events (${pct}%)`}
          >
            <span className={cn("text-[10px] font-medium uppercase tracking-wider", isActive ? p.tone : "text-fg-muted")}>
              {p.short}
            </span>
            <span className="text-xs font-mono tabular-nums">
              <span className={cn("font-semibold", isActive ? "text-fg" : "text-fg-secondary")}>
                {visible}
              </span>
              <span className="text-fg-muted"> / {total || "—"}</span>
            </span>
            <div className="w-full h-0.5 bg-border/50 rounded-full overflow-hidden">
              <motion.div
                className={cn(
                  "h-full rounded-full",
                  p.value === "compliance-officer" && "bg-confirmed",
                  p.value === "patient" && "bg-accent",
                  p.value === "external-auditor" && "bg-amber-400",
                )}
                initial={{ width: 0 }}
                animate={{ width: `${pct}%` }}
                transition={{ duration: 0.45, ease: "easeOut" }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}
