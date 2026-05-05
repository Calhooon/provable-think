// TS mirror of the agent worker's AgentEventEnvelope. Keep in lockstep with
// `demo/acme-health/agent/src/types.ts` — multi-conversation contract.

export interface ConversationSummary {
  id: string;
  title: string;
  commitCount: number;
  latestSequence: number;
  latestTxStatus: string | null;
  createdAt: number;
  lastActiveAt: number;
  status: "active" | "archived";
}

export type AgentEventEnvelope =
  // ── Connection-scope (no conversationId) ────────────────────────
  | {
      kind: "hello";
      agentIdentityPubHex: string;
      agentId: string;
      conversations: ConversationSummary[];
      activeConversationId: string | null;
    }
  | { kind: "conversation-list"; conversations: ConversationSummary[] }
  | {
      kind: "conversation-created";
      conversation: ConversationSummary;
      activated: boolean;
    }
  | {
      kind: "conversation-selected";
      conversationId: string;
    }
  // ── Conversation-scope (carries conversationId; auto-routed in store) ──
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

/** Client → server WS messages. Mirror of agent's ClientMessage. */
export type ClientMessage =
  | {
      kind: "patient-message";
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
      title?: string;
      activate?: boolean;
    };

export type Persona = "compliance-officer" | "patient" | "external-auditor";

export interface ViewingCapability {
  id: string;
  label: string;
  recipientPubHex: string;
  agentIdentityPubHex: string;
  scope: {
    tags?: string[];
    agentIds?: string[];
    hookKinds?: string[];
    fromIso?: string;
    toIso?: string;
  };
  grantedAt: number;
  envelopeStoragePrefix: string;
  envelopeServerUrl: string;
  auditorPrivKeyHex?: string;
}
