/**
 * Shared types for the Acme Health demo agent worker.
 *
 * The `AgentEventEnvelope` union below is the wire format the DO emits to
 * subscribed WebSocket clients. The frontend's `web/src/types/agent-events.ts`
 * mirrors this shape; keep the two in lockstep.
 *
 * Multi-conversation contract: most server-pushed events carry a
 * `conversationId` so the frontend can route them to the correct per-tab
 * bucket, and the agent only fans them out to connections currently selected
 * to view that conversation. Connection-level events (`hello`,
 * `conversation-list`, `conversation-created`) carry no conversationId and
 * fan out unconditionally.
 */

import type {
  Ai,
  DurableObjectNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

export interface Env {
  TRIAGE_AGENT: DurableObjectNamespace;
  AI: Ai;
  ENVELOPES: R2Bucket;
  AGENT_PRIVATE_KEY_HEX?: string;
  TAAL_API_KEY?: string;
  ARC_URLS?: string;
  DEMO_MODE?: string;
  CORS_ORIGIN?: string;
}

/**
 * Compact view of a conversation for tab-bar rendering.
 * Built by the agent from `pt_conversations` + the latest `pt_commits` row.
 */
export interface ConversationSummary {
  id: string;
  title: string;
  /** 0 if no commits yet. */
  commitCount: number;
  /** Latest sequence in this conversation's chain. */
  latestSequence: number;
  /** Latest tx_status — drives the tab status dot (✓ / propagating / failure). */
  latestTxStatus: string | null;
  createdAt: number;
  lastActiveAt: number;
  status: "active" | "archived";
}

/**
 * Wire-format the agent emits to subscribed WebSocket clients. Keep this
 * stable — the frontend's types/agent-events.ts mirrors it.
 */
export type AgentEventEnvelope =
  // ── Connection-scope events (no conversationId) ──────────────────
  | {
      kind: "hello";
      agentIdentityPubHex: string;
      agentId: string;
      conversations: ConversationSummary[];
      /**
       * The conversation this connection has been auto-selected to view, or
       * null if none exist yet. The frontend can override via
       * `select-conversation` or `new-conversation`.
       */
      activeConversationId: string | null;
    }
  | { kind: "conversation-list"; conversations: ConversationSummary[] }
  | {
      kind: "conversation-created";
      conversation: ConversationSummary;
      /** True if the server set this connection's active to the new conv. */
      activated: boolean;
    }
  | {
      kind: "conversation-selected";
      conversationId: string;
    }
  // ── Conversation-scope events (filtered by connection's active conv) ──
  | {
      kind: "patient-message";
      conversationId: string;
      ts: string;
      text: string;
    }
  | {
      kind: "agent-token";
      conversationId: string;
      ts: string;
      delta: string;
    }
  | {
      kind: "agent-message";
      conversationId: string;
      ts: string;
      text: string;
    }
  | {
      kind: "commit";
      conversationId: string;
      ts: string;
      sequence: number;
      hookKind: string;
      scopeTags: string[];
      txid: string;
      txStatus: string;
      commitHash: string;
      envelopeKey: string;
      feeSats: number;
      arcUrl: string;
    }
  | {
      kind: "commit-error";
      conversationId: string;
      ts: string;
      sequence?: number;
      hookKind: string;
      error: string;
    }
  | {
      kind: "tamper";
      conversationId: string;
      ts: string;
      sequence: number;
      envelopeKey: string;
    }
  | {
      kind: "info";
      conversationId: string;
      ts: string;
      text: string;
    };

/**
 * Wire-format for client → server messages over the WebSocket. The agent
 * accepts these via {@link handleMessage}; everything else is ignored.
 */
export type ClientMessage =
  | {
      kind: "patient-message";
      /** Optional — falls back to the connection's active conversation. */
      conversationId?: string;
      text: string;
    }
  | {
      kind: "list-conversations";
    }
  | {
      kind: "select-conversation";
      conversationId: string;
    }
  | {
      kind: "new-conversation";
      /** Optional title; server auto-generates from the first message if absent. */
      title?: string;
      /** Default true: server makes this connection active on the new conv. */
      activate?: boolean;
    };
