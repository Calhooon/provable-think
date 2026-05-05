import { create } from "zustand";
import type {
  AgentEventEnvelope,
  ConversationSummary,
  Persona,
  ViewingCapability,
} from "./types/agent-events";

export type ConnectionState = "connecting" | "open" | "closed" | "error";

const ACTIVE_CONV_LS_KEY = "acme-health.activeConversationId";

// Cached projection of `commit` events for fast pane render.
export interface CommitDescriptor {
  sequence: number;
  hookKind: string;
  scopeTags: string[];
  txid: string;
  txStatus: string;
  commitHash: string;
  envelopeKey: string;
  feeSats: number;
  arcUrl: string;
  ts: string;
}

/**
 * Per-step verification status. Mirrors the standalone
 * `provable-think-verify` CLI's 11-step pipeline (TECHNICAL §7) — but
 * runs in-page so a viewer sees the pipeline animate live as each step
 * completes. The two sources of truth (CLI / in-page) match exactly when
 * both are pointed at the same txid + capability.
 */
export type VerificationStepStatus = "pending" | "running" | "ok" | "fail";

export interface VerificationStep {
  key: string;
  label: string;
  status: VerificationStepStatus;
  detail?: string;
}

export interface VerificationResult {
  persona: Persona;
  txid: string;
  status: "pending" | "running" | "ok" | "fail" | "tamper";
  steps: VerificationStep[];
  outOfScope?: boolean;
  /**
   * Step 4 (WoC fetch) failed — transport / rate-limit / network. Distinct
   * from a real integrity failure so the UI can render it amber-not-red
   * and explain "verifier unavailable, chain anchor is still fine."
   */
  upstreamUnavailable?: boolean;
  plaintext?: string;
  error?: string;
  updatedAt: number;
}

export interface ExchangeRate {
  rateUsd: number;
  fetchedAt: number;
}

/**
 * One conversation's local view: chat messages, anchored commits, per-persona
 * verification results, and a per-conversation `selectedTxid` for the hero
 * pin. All buckets are keyed by `conversationId` in {@link AppState}.
 */
export interface ConversationData {
  /** Server-side summary mirror — auto-updated from `conversation-list` and `commit` events. */
  summary: ConversationSummary;
  /** Patient + agent chat events for this conversation, in order. */
  events: AgentEventEnvelope[];
  /** Anchored commits, in order. */
  commits: CommitDescriptor[];
  /** persona × txid → verification (per-conversation so personas don't bleed across). */
  verifications: Record<Persona, Record<string, VerificationResult>>;
  /** Hero pin within this conversation. `null` = follow latest. */
  selectedTxid: string | null;
}

export interface AppState {
  // ── Connection / agent identity ──────────────────────────────────
  agentIdentityPubHex: string | null;
  agentId: string | null;
  connectionState: ConnectionState;

  // ── Conversations ────────────────────────────────────────────────
  /** Ordered list of conversation ids (newest-active first). */
  conversationIds: string[];
  /** Per-conversation data buckets. */
  conversations: Record<string, ConversationData>;
  /** The conversation the UI is currently viewing. */
  activeConversationId: string | null;

  // ── Cross-conversation ───────────────────────────────────────────
  persona: Persona;
  capabilities: Record<Persona, ViewingCapability | null>;
  exchangeRate: ExchangeRate | null;

  // ── Actions ──────────────────────────────────────────────────────
  pushEvent(event: AgentEventEnvelope): void;
  setPersona(persona: Persona): void;
  setCapability(persona: Persona, cap: ViewingCapability | null): void;
  setConnectionState(state: ConnectionState): void;
  upsertVerification(
    conversationId: string,
    persona: Persona,
    result: VerificationResult,
  ): void;
  patchVerification(
    conversationId: string,
    persona: Persona,
    txid: string,
    patch: Partial<VerificationResult>,
  ): void;
  setExchangeRate(rate: ExchangeRate): void;
  /** Hero-pin within a conversation. */
  setSelectedTxid(conversationId: string, txid: string | null): void;
  /** Switch the UI's active conversation. Persists to localStorage. */
  selectConversation(conversationId: string): void;
  /** Replace the conversation list (e.g., from `conversation-list` event). */
  setConversations(summaries: ConversationSummary[]): void;
  reset(): void;
}

const INITIAL_CAPABILITIES: Record<Persona, ViewingCapability | null> = {
  "compliance-officer": null,
  patient: null,
  "external-auditor": null,
};

function emptyVerifications(): Record<Persona, Record<string, VerificationResult>> {
  return {
    "compliance-officer": {},
    patient: {},
    "external-auditor": {},
  };
}

function emptyConvData(summary: ConversationSummary): ConversationData {
  return {
    summary,
    events: [],
    commits: [],
    verifications: emptyVerifications(),
    selectedTxid: null,
  };
}

function loadActiveFromStorage(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONV_LS_KEY);
  } catch {
    return null;
  }
}

function persistActive(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(ACTIVE_CONV_LS_KEY);
    else localStorage.setItem(ACTIVE_CONV_LS_KEY, id);
  } catch {
    /* private mode / disabled storage — silently noop */
  }
}

declare global {
  interface Window {
    __acmeStore?: typeof useAppStore;
  }
}

export const useAppStore = create<AppState>((set) => ({
  agentIdentityPubHex: null,
  agentId: null,
  connectionState: "closed",

  conversationIds: [],
  conversations: {},
  activeConversationId: null,

  persona: "compliance-officer",
  capabilities: { ...INITIAL_CAPABILITIES },
  exchangeRate: null,

  pushEvent(event) {
    set((state) => {
      // Connection-scope events
      if (event.kind === "hello") {
        const conversations: Record<string, ConversationData> = {};
        for (const s of event.conversations) {
          // Preserve any existing data (e.g., chat history) on reconnect; this
          // matters when the browser reconnects after a transient drop.
          conversations[s.id] = state.conversations[s.id]
            ? { ...state.conversations[s.id]!, summary: s }
            : emptyConvData(s);
        }
        const ids = event.conversations.map((s) => s.id);
        // Resolve initial active: localStorage > server-suggested > first.
        const ls = loadActiveFromStorage();
        const active =
          (ls && ids.includes(ls) && ls) ||
          event.activeConversationId ||
          ids[0] ||
          null;
        if (active !== ls) persistActive(active);
        return {
          agentIdentityPubHex: event.agentIdentityPubHex,
          agentId: event.agentId,
          conversationIds: ids,
          conversations,
          activeConversationId: active,
        } as Partial<AppState>;
      }

      if (event.kind === "conversation-list") {
        const conversations = { ...state.conversations };
        const ids: string[] = [];
        for (const s of event.conversations) {
          conversations[s.id] = conversations[s.id]
            ? { ...conversations[s.id]!, summary: s }
            : emptyConvData(s);
          ids.push(s.id);
        }
        // Drop conversations the server no longer reports.
        for (const id of Object.keys(conversations)) {
          if (!ids.includes(id)) delete conversations[id];
        }
        let activeConversationId = state.activeConversationId;
        if (activeConversationId && !ids.includes(activeConversationId)) {
          activeConversationId = ids[0] ?? null;
          persistActive(activeConversationId);
        }
        return {
          conversationIds: ids,
          conversations,
          activeConversationId,
        } as Partial<AppState>;
      }

      if (event.kind === "conversation-created") {
        const conversations = { ...state.conversations };
        if (!conversations[event.conversation.id]) {
          conversations[event.conversation.id] = emptyConvData(event.conversation);
        } else {
          conversations[event.conversation.id] = {
            ...conversations[event.conversation.id]!,
            summary: event.conversation,
          };
        }
        const conversationIds = [
          event.conversation.id,
          ...state.conversationIds.filter((id) => id !== event.conversation.id),
        ];
        let activeConversationId = state.activeConversationId;
        if (event.activated) {
          activeConversationId = event.conversation.id;
          persistActive(activeConversationId);
        }
        return {
          conversations,
          conversationIds,
          activeConversationId,
        } as Partial<AppState>;
      }

      if (event.kind === "conversation-selected") {
        if (state.conversations[event.conversationId]) {
          persistActive(event.conversationId);
          return { activeConversationId: event.conversationId };
        }
        return {};
      }

      // Conversation-scope events from here down.
      const convId = event.conversationId;
      let convData = state.conversations[convId];
      if (!convData) {
        // Server can emit events for a conversation we haven't yet been told
        // about (e.g., live new-conversation creation by another tab). Lazy
        // bootstrap an empty bucket — `conversation-list` will follow soon
        // and fill in the title.
        convData = emptyConvData({
          id: convId,
          title: convId,
          commitCount: 0,
          latestSequence: 0,
          latestTxStatus: null,
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
          status: "active",
        });
      }

      // Idempotency for events the server can replay on `select-conversation`
      // and `hello`: dedupe `commit` by txid and `patient-message` by
      // (text, ts) — both are deterministic. Otherwise switching tabs
      // back-and-forth would dupe the chat thread + commit list.
      if (event.kind === "commit") {
        if (convData.commits.some((c) => c.txid === event.txid)) {
          // Already projected — re-pointing summary's latest is fine if
          // the new event has a fresher tx_status.
          const newTxStatus = event.txStatus || convData.summary.latestTxStatus;
          const updated: ConversationData = {
            ...convData,
            summary: { ...convData.summary, latestTxStatus: newTxStatus },
          };
          return {
            conversations: { ...state.conversations, [convId]: updated },
          } as Partial<AppState>;
        }
      } else if (
        event.kind === "patient-message" ||
        event.kind === "agent-message" ||
        event.kind === "info"
      ) {
        // Dedupe on text only (within this conversation): the live broadcast
        // and the post-decrypt chat-reconstruction inject the same text but
        // with different timestamps (one is broadcast time, one is the
        // commit ts). Patients don't send identical text twice in a session,
        // so text-equality is sufficient to suppress the dupe.
        const dup = convData.events.some(
          (e) => e.kind === event.kind && "text" in e && e.text === event.text,
        );
        if (dup) return {};
      }

      const updatedConv: ConversationData = {
        ...convData,
        events: [...convData.events, event],
      };

      if (event.kind === "commit") {
        updatedConv.commits = [
          ...convData.commits,
          {
            sequence: event.sequence,
            hookKind: event.hookKind,
            scopeTags: event.scopeTags,
            txid: event.txid,
            txStatus: event.txStatus,
            commitHash: event.commitHash,
            envelopeKey: event.envelopeKey,
            feeSats: event.feeSats,
            arcUrl: event.arcUrl,
            ts: event.ts,
          },
        ];
        updatedConv.summary = {
          ...convData.summary,
          // Source of truth is the local commits array (already deduped by
          // the txid guard above). The server-pushed summary count gets
          // overridden as commits arrive; this avoids double-counting when
          // hello says N AND the agent replays N commit events on top.
          commitCount: updatedConv.commits.length,
          latestSequence: Math.max(
            convData.summary.latestSequence,
            event.sequence,
          ),
          latestTxStatus: event.txStatus || convData.summary.latestTxStatus,
          lastActiveAt: Date.now(),
        };
      }

      const conversationIds = [
        convId,
        ...state.conversationIds.filter((id) => id !== convId),
      ];

      return {
        conversations: { ...state.conversations, [convId]: updatedConv },
        conversationIds,
      } as Partial<AppState>;
    });
  },

  setPersona(persona) {
    set({ persona });
  },

  setCapability(persona, cap) {
    set((state) => ({
      capabilities: { ...state.capabilities, [persona]: cap },
    }));
  },

  setConnectionState(connectionState) {
    set({ connectionState });
  },

  upsertVerification(conversationId, persona, result) {
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return {};
      const updatedConv: ConversationData = {
        ...conv,
        verifications: {
          ...conv.verifications,
          [persona]: { ...conv.verifications[persona], [result.txid]: result },
        },
      };
      return {
        conversations: { ...state.conversations, [conversationId]: updatedConv },
      };
    });
  },

  patchVerification(conversationId, persona, txid, patch) {
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return {};
      const cur = conv.verifications[persona]?.[txid];
      if (!cur) return {};
      const updatedConv: ConversationData = {
        ...conv,
        verifications: {
          ...conv.verifications,
          [persona]: {
            ...conv.verifications[persona],
            [txid]: { ...cur, ...patch, updatedAt: Date.now() },
          },
        },
      };
      return {
        conversations: { ...state.conversations, [conversationId]: updatedConv },
      };
    });
  },

  setExchangeRate(rate) {
    set({ exchangeRate: rate });
  },

  setSelectedTxid(conversationId, txid) {
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return {};
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: { ...conv, selectedTxid: txid },
        },
      };
    });
  },

  selectConversation(conversationId) {
    set((state) => {
      if (!state.conversations[conversationId]) return {};
      persistActive(conversationId);
      return { activeConversationId: conversationId };
    });
  },

  setConversations(summaries) {
    set((state) => {
      const conversations = { ...state.conversations };
      const ids: string[] = [];
      for (const s of summaries) {
        conversations[s.id] = conversations[s.id]
          ? { ...conversations[s.id]!, summary: s }
          : emptyConvData(s);
        ids.push(s.id);
      }
      for (const id of Object.keys(conversations)) {
        if (!ids.includes(id)) delete conversations[id];
      }
      let active = state.activeConversationId;
      if (active && !ids.includes(active)) {
        active = ids[0] ?? null;
        persistActive(active);
      }
      return {
        conversations,
        conversationIds: ids,
        activeConversationId: active,
      };
    });
  },

  reset() {
    persistActive(null);
    set({
      agentIdentityPubHex: null,
      agentId: null,
      connectionState: "closed",
      conversationIds: [],
      conversations: {},
      activeConversationId: null,
      persona: "compliance-officer",
      capabilities: { ...INITIAL_CAPABILITIES },
      // exchangeRate intentionally NOT reset — it's not session-scoped.
    });
  },
}));

if (typeof window !== "undefined") {
  window.__acmeStore = useAppStore;
}

// ───── Selector helpers ─────
// Read these from your component to filter by the active conversation in O(1).

export function selectActiveConv(s: AppState): ConversationData | null {
  if (!s.activeConversationId) return null;
  return s.conversations[s.activeConversationId] ?? null;
}

export function selectActiveCommits(s: AppState): CommitDescriptor[] {
  return selectActiveConv(s)?.commits ?? [];
}

export function selectActiveEvents(s: AppState): AgentEventEnvelope[] {
  return selectActiveConv(s)?.events ?? [];
}

export function selectActiveVerifications(
  s: AppState,
): Record<string, VerificationResult> {
  const conv = selectActiveConv(s);
  if (!conv) return {};
  return conv.verifications[s.persona] ?? {};
}

export function selectActiveSelectedTxid(s: AppState): string | null {
  return selectActiveConv(s)?.selectedTxid ?? null;
}

/** Total commit count across ALL conversations — for the hero banner counter. */
export function selectTotalCommits(s: AppState): number {
  let n = 0;
  for (const id of s.conversationIds) {
    n += s.conversations[id]?.commits.length ?? 0;
  }
  return n;
}

/** Total mainnet sat spend across ALL conversations — for the hero banner. */
export function selectTotalSats(s: AppState): number {
  let n = 0;
  for (const id of s.conversationIds) {
    for (const c of s.conversations[id]?.commits ?? []) {
      n += c.feeSats;
    }
  }
  return n;
}
