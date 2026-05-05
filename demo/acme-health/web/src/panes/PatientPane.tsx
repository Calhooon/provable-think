import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowUp,
  BookOpen,
  Loader2,
  Sparkles,
  Stethoscope,
  User,
} from "lucide-react";
import {
  Pane,
  Badge,
  EmptyState,
  MarkdownText,
} from "../components";
import { useAppStore, type CommitDescriptor } from "../store";
import { sendPatientMessage, agentExplorerBase } from "../lib/agent-client";
import { motion as motionTokens } from "../lib/tokens";
import { cn } from "../lib/cn";
import type { AgentEventEnvelope } from "../types/agent-events";

const SAMPLE_QUESTION =
  "I'm 67, T2DM x12yr, hypertensive. Intermittent chest pressure for 3 days when climbing stairs. Should I be worried?";

interface ToolCallSlot {
  /** Stable order key. */
  index: number;
  /** "Looking up cardiac symptoms…" → "Consulted ACC/AHA 2023". */
  status: "pending" | "consulted";
  /** Human label of the keyword the agent is looking up. */
  queryLabel?: string;
  /** Final guideline name once lookup returns. */
  guidelineName?: string;
}

interface Turn {
  patientText: string;
  patientTs: string;
  toolCalls: ToolCallSlot[];
  agentText: string;
  agentTs: string;
  agentStreaming: boolean;
  /** Commits attributable to this turn — used for the provenance footer. */
  commits: CommitDescriptor[];
}

/**
 * Project the WebSocket event stream into chat turns. Each turn opens
 * with a `patient-message`; subsequent tool-call commits accumulate as
 * tool slots; agent tokens stream into the agent block; final reply
 * seals it. Commits attributable to the turn (any commit landing
 * between this turn's open and the next turn's open) attach for the
 * provenance footer.
 */
function selectTurns(
  events: AgentEventEnvelope[],
  commits: CommitDescriptor[],
  replyByTxid: Record<string, string> = {},
): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  let toolIndex = 0;

  // Sort by timestamp before walking. WS replay-on-subscribe sends the
  // sidecar commits first (in chain-sequence order) and the
  // patient-message stream second — without sorting, every commit lands
  // before the turn-opening patient-message and gets dropped (`if (!cur)
  // continue`). Sort restores chronological order so commits attach to
  // their owning turn even on cold-load of a past conversation.
  const sorted = [...events].sort((a, b) => {
    const ta = "ts" in a && a.ts ? Date.parse(a.ts) : 0;
    const tb = "ts" in b && b.ts ? Date.parse(b.ts) : 0;
    return ta - tb;
  });

  for (const ev of sorted) {
    if (ev.kind === "patient-message") {
      if (cur) cur.agentStreaming = false;
      cur = {
        patientText: ev.text,
        patientTs: ev.ts,
        toolCalls: [],
        agentText: "",
        agentTs: ev.ts,
        agentStreaming: true,
        commits: [],
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (ev.kind === "info" && /Looked up:/i.test(ev.text)) {
      const name = ev.text.replace(/Looked up:\s*/i, "").trim();
      const slot = cur.toolCalls[cur.toolCalls.length - 1];
      if (slot && slot.status === "pending") {
        slot.status = "consulted";
        slot.guidelineName = name;
      } else {
        cur.toolCalls.push({
          index: toolIndex++,
          status: "consulted",
          guidelineName: name,
        });
      }
    } else if (ev.kind === "agent-token") {
      cur.agentText += ev.delta;
      cur.agentTs = ev.ts;
    } else if (ev.kind === "agent-message") {
      cur.agentText = ev.text;
      cur.agentTs = ev.ts;
      cur.agentStreaming = false;
    } else if (ev.kind === "commit") {
      // Hydrate the most recent turn with relevant commit data.
      if (ev.hookKind === "beforeToolCall") {
        // Open a new tool slot in pending state. The label is hidden in
        // the commit payload, but we don't have it here — leave queryLabel
        // empty; the subsequent `info` event will fill it in.
        cur.toolCalls.push({
          index: toolIndex++,
          status: "pending",
        });
      }
      cur.commits.push(commits.find((c) => c.txid === ev.txid)!);
      cur.commits = cur.commits.filter(Boolean);
    }
  }
  // Reconstruct any reply text we missed live (turn ran while no client
  // connected — gate, refresh-after-turn, multi-tab cold-load) from the
  // `onChatResponse` envelope itself. The chain is the source of truth:
  // the reply was sealed into the envelope and is recoverable for any
  // persona in scope (CO/Patient: PHI+treatment; External Auditor:
  // operations). Without this, the chat thread looks blank even though
  // the audit trail is fully populated on chain.
  for (const turn of turns) {
    if (turn.agentText && !turn.agentStreaming) continue;
    const reply = turn.commits.find((c) => c.hookKind === "onChatResponse");
    if (!reply) continue;
    const fromChain = replyByTxid[reply.txid];
    if (!fromChain) continue;
    turn.agentText = fromChain;
    turn.agentStreaming = false;
  }
  return turns;
}

/**
 * Walk the active persona's verifications, parse the envelope plaintext
 * for every `onChatResponse` commit, and return a txid → reply-text map.
 * Plaintext format is `<32-byte prevHash>{canonical-JSON}` — the prev
 * hash is binary so we anchor parsing on the JSON's `{"hookKind"` prefix
 * rather than `indexOf('{')` (the prev hash can contain a stray `{`).
 */
function buildReplyByTxid(
  verifications: Record<string, { plaintext?: string; outOfScope?: boolean }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [txid, v] of Object.entries(verifications)) {
    if (!v?.plaintext || v.outOfScope) continue;
    const start = v.plaintext.indexOf('{"hookKind"');
    if (start < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(v.plaintext.slice(start));
    } catch {
      continue;
    }
    const obj = parsed as {
      hookKind?: string;
      payload?: { reply?: unknown };
    };
    if (obj.hookKind !== "onChatResponse") continue;
    if (typeof obj.payload?.reply !== "string") continue;
    out[txid] = obj.payload.reply;
  }
  return out;
}

export function PatientPane() {
  // The chat thread is per-conversation. Read events + commits from the
  // active conversation's bucket; switching tabs swaps the entire thread
  // history for the user.
  const activeConvId = useAppStore((s) => s.activeConversationId);
  const events = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.events ?? [] : [],
  );
  const commits = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.commits ?? [] : [],
  );
  // Verifications carry the decrypted envelope plaintext for every commit
  // the active persona is in scope for. Used as the source-of-truth for
  // agent replies when the live token stream wasn't observed (gate-only
  // run, refresh-after-turn) — the chain is the canonical record.
  const persona = useAppStore((s) => s.persona);
  const verifications = useAppStore((s) =>
    activeConvId ? s.conversations[activeConvId]?.verifications[persona] ?? {} : {},
  );
  const connectionState = useAppStore((s) => s.connectionState);
  const [input, setInput] = useState("");
  const replyByTxid = useMemo(
    () => buildReplyByTxid(verifications),
    [verifications],
  );
  const turns = useMemo(
    () => selectTurns(events, commits, replyByTxid),
    [events, commits, replyByTxid],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [
    turns.length,
    turns[turns.length - 1]?.agentText.length,
    turns[turns.length - 1]?.toolCalls.length,
  ]);

  const isConnected = connectionState === "open";
  const lastTurn = turns[turns.length - 1];
  const isAgentBusy = lastTurn?.agentStreaming === true;

  function submit() {
    const text = input.trim();
    if (!text || !isConnected || isAgentBusy) return;
    // Pass activeConvId so the agent routes the message into the
    // currently-viewed conversation. If activeConvId is null, the agent
    // auto-creates one from the message text — that's the empty-agent
    // first-message UX.
    sendPatientMessage(text, activeConvId ?? undefined);
    setInput("");
  }

  return (
    <Pane
      title="Patient"
      badge={
        <Badge variant={isConnected ? "confirmed" : "default"} className="font-mono">
          <ConnectionDot live={isConnected} />
          <span>{isConnected ? "live" : connectionState}</span>
        </Badge>
      }
    >
      <div className="flex flex-col h-full min-h-0 -mx-4 -mb-4">
        <div
          ref={scrollRef}
          className={cn(
            "flex-1 overflow-y-auto px-4 py-4 space-y-4",
            "min-h-[320px] scroll-smooth",
          )}
        >
          {turns.length === 0 ? (
            <PatientEmptyState
              onSampleClick={() => isConnected && setInput(SAMPLE_QUESTION)}
              isConnected={isConnected}
            />
          ) : (
            <AnimatePresence initial={false}>
              {turns.map((turn, i) => (
                <TurnGroup key={`${turn.patientTs}-${i}`} turn={turn} />
              ))}
            </AnimatePresence>
          )}
        </div>
        <Composer
          input={input}
          onChange={setInput}
          onSubmit={submit}
          isConnected={isConnected}
          isAgentBusy={isAgentBusy}
        />
      </div>
    </Pane>
  );
}

// ─────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────

function PatientEmptyState({
  onSampleClick,
  isConnected,
}: {
  onSampleClick: () => void;
  isConnected: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[320px] gap-5 px-4 text-center">
      <div
        className={cn(
          "flex-none w-12 h-12 rounded-2xl",
          "bg-accent/10 text-accent-dark",
          "flex items-center justify-center ring-1 ring-accent/20",
        )}
        aria-hidden="true"
      >
        <Stethoscope className="w-6 h-6" />
      </div>
      <div className="space-y-1.5 max-w-sm">
        <h3 className="text-base font-semibold text-fg leading-tight">
          Acme Health · Clinical triage
        </h3>
        <p className="text-sm text-fg-secondary leading-relaxed">
          Type a clinical question. The agent looks up the relevant
          guideline, synthesizes a recommendation, and anchors every
          step to the public ledger under HIPAA scope tags.
        </p>
      </div>
      <button
        type="button"
        onClick={onSampleClick}
        disabled={!isConnected}
        className={cn(
          "inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full",
          "text-xs font-semibold tracking-wide",
          "bg-accent text-white shadow-sm",
          "hover:bg-accent-dark hover:shadow",
          "transition-all",
          "disabled:opacity-50 disabled:cursor-not-allowed",
        )}
      >
        <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
        Try a sample question
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Turn group — patient bubble + tool calls + agent bubble
// ─────────────────────────────────────────────────────────────

function TurnGroup({ turn }: { turn: Turn }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: motionTokens.pane, ease: motionTokens.ease }}
      className="space-y-3"
    >
      <PatientBubble text={turn.patientText} ts={turn.patientTs} />
      {turn.toolCalls.length > 0 && (
        <div className="space-y-2 pl-1">
          {turn.toolCalls.map((tc) => (
            <ToolCallCard key={tc.index} slot={tc} />
          ))}
        </div>
      )}
      {turn.agentText.length === 0 && turn.agentStreaming ? (
        <AgentThinkingBubble />
      ) : (
        turn.agentText.length > 0 && (
          <AgentBubble
            text={turn.agentText}
            streaming={turn.agentStreaming}
            ts={turn.agentTs}
            commits={turn.commits}
          />
        )
      )}
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Bubbles
// ─────────────────────────────────────────────────────────────

function PatientBubble({ text, ts }: { text: string; ts: string }) {
  return (
    <div className="flex flex-row-reverse items-end gap-2">
      <Avatar role="patient" />
      <div className="flex flex-col items-end max-w-[78%]">
        <div
          className={cn(
            "rounded-2xl rounded-br-md px-3.5 py-2.5",
            "bg-[color:var(--color-bubble-patient)] text-fg",
            "border border-border shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
            "text-sm leading-relaxed whitespace-pre-wrap",
          )}
        >
          {text}
        </div>
        <span className="mt-1 text-[10px] text-fg-muted font-mono">
          Patient · {relativeTime(ts)}
        </span>
      </div>
    </div>
  );
}

function AgentBubble({
  text,
  streaming,
  ts,
  commits,
}: {
  text: string;
  streaming: boolean;
  ts: string;
  commits: CommitDescriptor[];
}) {
  // Find the onChatResponse commit for this turn — that's the canonical
  // anchor for the agent's reply.
  const replyCommit = commits.find((c) => c.hookKind === "onChatResponse");
  return (
    <div className="flex items-end gap-2">
      <Avatar role="agent" />
      <div className="flex flex-col items-start max-w-[88%] flex-1 min-w-0">
        <div
          className={cn(
            "rounded-2xl rounded-bl-md px-3.5 py-2.5",
            "bg-[color:var(--color-bubble-agent)]",
            "border border-[color:var(--color-bubble-agent-border)]/40",
            "shadow-[0_1px_2px_rgba(14,165,233,0.06)]",
            "text-sm leading-relaxed text-fg",
            "w-full",
          )}
        >
          <MarkdownText text={text} />
          {streaming && (
            <span
              className="inline-block w-1.5 h-3.5 ml-0.5 mb-0.5 bg-accent/60 align-middle animate-pulse"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-fg-muted font-mono flex-wrap">
          <span>Acme Health agent · {relativeTime(ts)}</span>
          {replyCommit && (
            <>
              <span className="opacity-50">·</span>
              <a
                href={`${agentExplorerBase}${replyCommit.txid}`}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full",
                  "bg-confirmed/10 text-confirmed border border-confirmed/30",
                  "hover:bg-confirmed/15 transition-colors",
                )}
                title="Anchored on the public ledger — click to verify"
              >
                <span className="w-1 h-1 rounded-full bg-confirmed" aria-hidden="true" />
                anchored · seq {replyCommit.sequence}
              </a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentThinkingBubble() {
  return (
    <div className="flex items-end gap-2">
      <Avatar role="agent" />
      <div
        className={cn(
          "rounded-2xl rounded-bl-md px-3.5 py-3",
          "bg-[color:var(--color-bubble-agent)]",
          "border border-[color:var(--color-bubble-agent-border)]/40",
          "shadow-[0_1px_2px_rgba(14,165,233,0.06)]",
          "text-sm text-fg-secondary",
          "inline-flex items-center gap-2",
        )}
      >
        <span className="text-xs text-accent-dark font-medium">thinking</span>
        <ThinkingDots />
      </div>
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0.25 }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{
            duration: 1.1,
            repeat: Infinity,
            ease: motionTokens.ease,
            delay: i * 0.18,
          }}
          className="w-1.5 h-1.5 rounded-full bg-accent-dark"
        />
      ))}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Tool-call inline card
// ─────────────────────────────────────────────────────────────

function ToolCallCard({ slot }: { slot: ToolCallSlot }) {
  const isPending = slot.status === "pending";
  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: motionTokens.pane, ease: motionTokens.ease }}
      className={cn(
        "ml-9 inline-flex items-center gap-2",
        "rounded-lg border px-2.5 py-1.5 text-xs",
        isPending
          ? "border-propagating/30 bg-propagating/5 text-fg-secondary"
          : "border-accent/25 bg-accent/5 text-fg",
      )}
    >
      {isPending ? (
        <Loader2 className="w-3.5 h-3.5 text-propagating animate-spin flex-none" aria-hidden="true" />
      ) : (
        <BookOpen className="w-3.5 h-3.5 text-accent-dark flex-none" aria-hidden="true" />
      )}
      <span className="text-[10px] uppercase tracking-wider text-fg-muted font-medium">
        {isPending ? "Consulting" : "Consulted"}
      </span>
      <span className="font-medium leading-tight">
        {isPending
          ? "clinical guideline lookup…"
          : slot.guidelineName ?? "guideline retrieved"}
      </span>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────
// Avatar
// ─────────────────────────────────────────────────────────────

function Avatar({ role }: { role: "patient" | "agent" }) {
  return (
    <div
      className={cn(
        "flex-none w-7 h-7 rounded-full flex items-center justify-center",
        role === "patient"
          ? "bg-muted text-fg-secondary"
          : "bg-accent/10 text-accent-dark ring-1 ring-accent/20",
      )}
      aria-hidden="true"
    >
      {role === "patient" ? (
        <User className="w-3.5 h-3.5" />
      ) : (
        <Stethoscope className="w-4 h-4" />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Composer
// ─────────────────────────────────────────────────────────────

function Composer({
  input,
  onChange,
  onSubmit,
  isConnected,
  isAgentBusy,
}: {
  input: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isConnected: boolean;
  isAgentBusy: boolean;
}) {
  const disabled = !isConnected || isAgentBusy;
  return (
    <form
      className={cn(
        "border-t border-border bg-canvas/60 backdrop-blur",
        "px-3 py-3 flex items-end gap-2",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="flex-1 relative">
        <textarea
          value={input}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          disabled={disabled}
          placeholder={
            !isConnected
              ? "Reconnecting…"
              : isAgentBusy
                ? "Agent is responding…"
                : "Describe your symptoms or ask a clinical question…"
          }
          rows={2}
          className={cn(
            "w-full resize-none rounded-xl border border-border bg-surface",
            "px-3.5 py-2.5 pr-12 text-sm leading-relaxed text-fg",
            "placeholder:text-fg-muted",
            "focus:outline-none focus:border-accent focus:ring-2 focus:ring-accent/15",
            "disabled:opacity-60 disabled:cursor-not-allowed",
            "transition-colors",
          )}
        />
        <div className="pointer-events-none absolute bottom-2 right-3 text-[10px] text-fg-muted font-mono opacity-70">
          ⏎ to send · ⇧⏎ newline
        </div>
      </div>
      <button
        type="submit"
        disabled={disabled || !input.trim()}
        className={cn(
          "flex-none w-10 h-10 rounded-xl",
          "bg-accent text-white shadow-sm",
          "hover:bg-accent-dark hover:shadow",
          "transition-all",
          "disabled:opacity-40 disabled:cursor-not-allowed",
          "flex items-center justify-center",
        )}
        aria-label="Send message"
      >
        {isAgentBusy ? (
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowUp className="w-4 h-4" aria-hidden="true" />
        )}
      </button>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────
// Connection dot — pulses when live
// ─────────────────────────────────────────────────────────────

function ConnectionDot({ live }: { live: boolean }) {
  if (!live) return <span className="w-1.5 h-1.5 rounded-full bg-fg-muted" aria-hidden="true" />;
  return (
    <span className="relative flex w-1.5 h-1.5" aria-hidden="true">
      <motion.span
        animate={{ opacity: [0.4, 1, 0.4], scale: [1, 1.6, 1] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: motionTokens.ease }}
        className="absolute inset-0 rounded-full bg-confirmed/50"
      />
      <span className="relative w-1.5 h-1.5 rounded-full bg-confirmed" />
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
