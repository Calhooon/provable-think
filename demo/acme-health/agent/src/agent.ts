/**
 * `TriageAgent` — the Acme Health demo's clinical-triage Think agent.
 *
 * Wraps `Think<Env>` with `withProvenance(...HIPAA_PRESET, ...)` so every
 * lifecycle hook anchors to BSV mainnet through provable-think. Workers AI
 * provides the model (Kimi K2.6 per DECISIONS.md §1).
 *
 * Multi-conversation contract (added 2026-04-29):
 *   - One DO. Many conversations. Each conversation has its own per-chain
 *     sequence + chain head + Project Think Session messages.
 *   - Each WebSocket connection holds one *active* conversationId in its
 *     hibernation-safe `state`. Server-pushed events tagged with a
 *     conversationId are only fanned out to connections whose active matches.
 *   - The package's `setActiveConversation()` re-points the in-flight commit
 *     bucket; we call it before each `runTriageTurn` so hook commits anchor
 *     under the right chain.
 *   - Think's `session` is re-pointed via `agent.session.forSession(convId)`
 *     so the LLM sees the right per-conversation message history.
 */

import { createWorkersAI } from "workers-ai-provider";
import { Think } from "@cloudflare/think";
import {
  withProvenance,
  HIPAA_PRESET,
  HIPAA_COMPLIANCE_OFFICER_SCOPE,
  HIPAA_EXTERNAL_AUDITOR_SCOPE,
  hipaaPatientScope,
  type CommitEvent,
  type CommitErrorEvent,
  type GrantScope,
  type HookKind,
} from "provable-think";
import type { LanguageModel, ToolSet } from "ai";
import type { Connection, WSMessage } from "agents";
import type { AgentEventEnvelope, ConversationSummary, Env } from "./types.js";
import {
  handleClose,
  handleConnect,
  handleMessage,
} from "./websocket.js";

const ARC_URLS_FALLBACK = [
  "https://arc.gorillapool.io",
  "https://api.taal.com/arc",
];

const SYSTEM_PROMPT =
  "You are an Acme Health clinical-triage assistant. The patient describes symptoms; " +
  "you provide a guideline-grounded, conservative recommendation. You always include " +
  "'this is not a substitute for professional medical advice' and you escalate to ED " +
  "for red-flag symptoms (chest pain + diaphoresis, focal neuro deficits, suspected " +
  "sepsis, etc.). You speak plainly, not in marketing voice.";

/**
 * Module-level pointer to the active agent instance. Typed as `unknown` so
 * TypeScript doesn't try to resolve `TriageAgent` while computing
 * `TriageAgent`'s own base — `withProvenance(...)`'s config below holds a
 * closure over this variable, and naming the class type here would create
 * a cycle TS reports as "recursively references itself".
 */
let _activeInstance: unknown;

interface CommitBroadcaster {
  _handleCommit(event: CommitEvent): void;
  _handleCommitError(event: CommitErrorEvent): void;
}

/** Per-connection hibernation-safe state. */
export interface ConnectionState {
  /** Conversation this connection is currently viewing (drives broadcast filtering). */
  activeConversationId: string | null;
}

const provenanceConfig = {
  ...HIPAA_PRESET,
  identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
  anchor: {
    network: "mainnet" as const,
    arcUrls: ARC_URLS_FALLBACK,
  },
  // Opt into onChunk anchoring for the v0.2 wave-5 16-hook gate.
  // The wrapper applies a per-turn first-chunk-only latch so this
  // produces ONE commit per chat turn, not one per token. The other
  // hooks anchor unconditionally (config.commit acts as an opt-in
  // for the cost-sensitive ones; for the gate, listing them all is
  // fine — onChunk is the only currently-gated-by-flag hook).
  commit: [
    "beforeTurn",
    "beforeStep",
    "beforeToolCall",
    "afterToolCall",
    "onStepFinish",
    "onChunk",
    "onChatResponse",
    "onChatRecovery",
    "getModel",
    "fiberStart",
    "stash",
    "fiberRecovered",
    "extensionAuthored",
    "getTools",
    "configureSession",
  ] as HookKind[],
  storage: {
    primary: "r2" as const,
    r2: { binding: "ENVELOPES", pathPrefix: "acme-health" },
  },
  disclosure: {
    ...HIPAA_PRESET.disclosure,
    defaultRecipients: [{ id: "self", counterparty: "self" as const }],
    envelopeServerUrl: "https://acme-health-agent.dev-a3e.workers.dev",
  },
  onCommit: async (event: CommitEvent) => {
    (_activeInstance as CommitBroadcaster | undefined)?._handleCommit(event);
  },
  onCommitError: async (event: CommitErrorEvent) => {
    (_activeInstance as CommitBroadcaster | undefined)?._handleCommitError(event);
  },
};

export class TriageAgent extends withProvenance(Think<Env>, provenanceConfig) {
  /** Debug roster — not the broadcast fanout target. See {@link broadcastEvent}. */
  connectedClients: Set<WebSocket> = new Set();

  /**
   * Pre-stashed metadata for the in-flight commit. Set by `runTriageTurn`
   * before it calls `commitSync()`; read by `_handleCommit()` so the
   * broadcasted CommitEvent includes the scope tags the caller used.
   *
   * Keyed by conversationId so concurrent commits across conversations
   * don't clobber each other (Project Think serializes turns globally
   * today, but the keying is forward-safe).
   */
  pendingCommitMeta: Map<string, { scopeTags: string[]; r2PathPrefix: string }> =
    new Map();

  /**
   * Latch: did we already anchor `configureSession` for this DO lifetime?
   * Set to true on the first chat turn. Triage anchors configureSession
   * once per DO boot (cold-start) — it's an agent-scoped hook, not a
   * per-turn one.
   */
  configureSessionAnchored = false;

  /** Cached agent identity pub key (set on onStart so sync hooks can use it). */
  private identityPubHexCache: string | undefined;

  override async onStart(): Promise<void> {
    // Think's constructor monkey-patches `this.onStart` to a wrapper that
    // calls `configureSession` before delegating here (think.js line
    // 43–58). In WS-only DOs, partyserver's lifecycle path doesn't
    // always invoke that wrapper, so the configureSession audit anchor
    // can miss its firing window. We force the audit anchor here, ON
    // EVERY ACTIVATION, so the on-chain trail of "agent shape at boot"
    // is always present for v0.2-#33 / TECHNICAL §13. The shadow
    // installed in withProvenance's constructor handles the actual
    // commit; we just need to call into it.
    _activeInstance = this;
    try {
      // Get the identity key first so __pt_init has run + the default
      // conversation exists by the time configureSession's commit fires.
      this.identityPubHexCache = await this.getIdentityPublicKey();
    } catch {
      /* Will retry next time getIdentityPublicKey is called. */
    }

    // Sidecar tables MUST be created before eager persona grants. On a
    // fresh DO cold-boot, ensureDemoPersonaGrant tries to SELECT from
    // triage_demo_grants — if the table doesn't exist yet, the cached-
    // grant lookup silently returns null AND the subsequent INSERT
    // throws (also caught silently). The grant gets issued in agent
    // grant storage but is never persisted to the demo cache, so the
    // next /grant/persona call mints a SECOND keypair with a SECOND
    // grant — and envelopes sealed against the first grant don't
    // decrypt with the second's private key. (See runtime comments at
    // the top of agent.ts for the multi-conversation contract.)
    try {
      const sql = (
        this as unknown as { ctx: { storage: { sql: { exec: (q: string) => unknown } } } }
      ).ctx.storage.sql;
      // Mirror per-commit metadata that lives in the encrypted envelope
      // header (scope_tags, envelope_key) so WS replay-on-subscribe doesn't
      // need to read R2 per row. Now keyed by (conversation_id, txid).
      sql.exec(
        "CREATE TABLE IF NOT EXISTS triage_commit_meta (" +
          "conversation_id TEXT NOT NULL, " +
          "txid TEXT NOT NULL, " +
          "scope_tags_json TEXT NOT NULL, " +
          "envelope_key TEXT NOT NULL, " +
          "fee_sats INTEGER NOT NULL, " +
          "arc_url TEXT, " +
          "ts INTEGER NOT NULL, " +
          "PRIMARY KEY (conversation_id, txid)" +
          ")",
      );
      // Persistent demo persona grants — single CO/Patient/External keypair
      // per persona, reused across every browser session AND every conversation.
      // The grants are agent-scoped (not conversation-scoped) because a real
      // Compliance Officer should see PHI events across every patient
      // conversation under their oversight.
      sql.exec(
        "CREATE TABLE IF NOT EXISTS triage_demo_grants (" +
          "persona TEXT PRIMARY KEY, " +
          "priv_hex TEXT NOT NULL, " +
          "pub_hex TEXT NOT NULL, " +
          "grant_id TEXT NOT NULL, " +
          "label TEXT NOT NULL, " +
          "scope_json TEXT NOT NULL, " +
          "granted_at INTEGER NOT NULL" +
          ")",
      );
    } catch (e) {
      console.warn("[agent] sidecar init failed:", (e as Error).message);
    }

    // Eagerly issue the agent-scoped persona grants (Compliance Officer,
    // External Auditor, Patient) so any commit that fires from now on
    // includes them in its recipient list. Without this, configureSession
    // at boot lands sealed only to `self` and no demo persona can
    // decrypt it. Now safe to call because the persistence table is
    // already created above — first-boot grant minting persists its
    // keypair, and subsequent /grant/persona calls return the cached
    // grant rather than minting a competing one.
    try {
      // All three personas eagerly issued so commits from any code path
      // (configureSession at boot, getModel/getTools at first turn,
      // chat-turn hooks) seal to the full audit matrix.
      await this.ensureDemoPersonaGrant("compliance-officer");
      await this.ensureDemoPersonaGrant("external-auditor");
      await this.ensureDemoPersonaGrant("patient");
    } catch (e) {
      console.warn("[agent] eager persona grants failed:", (e as Error).message);
    }
    // configureSession is now anchored from the first runTriageTurn (see
    // triage.ts) rather than here. partyserver's onStart context wasn't
    // reliably keeping the ctx.waitUntil-deferred commit alive — we'd see
    // the wrapper invoked but the commit silently dropped. Triage-turn
    // anchoring is deterministic because the WS message handler awaits
    // the full pipeline. Dedupe per DO lifetime via __configureSessionAnchored.

    // Auto-seed a curated demo conversation on cold-boot so first-time
    // visitors land in rich content (8 anchored hooks, decryptable agent
    // reply, full triage flow) rather than an empty pane. Idempotent —
    // skipped if any non-default, non-gate conv already exists. Runs in
    // ctx.waitUntil so the onStart handler returns immediately while the
    // 3-step warm-up scenario plays out in the background.
    try {
      const existing = await this.listConversations({ status: "all" });
      const hasDemoConv = existing.some(
        (c) =>
          c.id !== "default" &&
          !c.title?.toLowerCase().includes("wave ") &&
          !c.title?.toLowerCase().includes("16-hook gate") &&
          !c.title?.toLowerCase().includes("quality-gate"),
      );
      if (!hasDemoConv) {
        const ctxRef = (
          this as unknown as { ctx: { waitUntil(p: Promise<unknown>): void } }
        ).ctx;
        ctxRef.waitUntil(
          (async () => {
            try {
              // Run all three warm-up turns into a fresh seed conv. The
              // gate's persona-scope filter relies on eager grants
              // (issued above), so commits here will seal to all three
              // personas + self.
              await this.runSeedScenario();
            } catch (e) {
              console.warn(
                "[agent] auto-seed scenario failed:",
                (e as Error).message,
              );
            }
          })(),
        );
      }
    } catch (e) {
      console.warn("[agent] auto-seed precheck failed:", (e as Error).message);
    }
  }

  /**
   * Stable identity for the agent. Used by the frontend's "agent id" pill.
   * Distinct from any conversation id.
   */
  get agentId(): string {
    return (
      (this as unknown as { name?: string }).name ?? "acme-health-demo"
    );
  }

  override getSystemPrompt(): string {
    return SYSTEM_PROMPT;
  }

  /**
   * Identity-only session config. We don't use Think's context blocks /
   * compaction / skills (the triage flow is one-shot RAG via
   * `lookupGuideline`), so we just return the session unchanged. This
   * exists so the v0.2 audit anchor for `configureSession` has something
   * to wrap — without an explicit override Think's base default returns
   * the session, which would still fire our wrapper, but then we lose
   * the ability to evolve the per-agent config story later without
   * touching the package.
   */
  override configureSession<S>(session: S): S {
    return session;
  }

  override getModel(): LanguageModel {
    const env = (this as unknown as { env: Env }).env;
    return createWorkersAI({ binding: env.AI } as unknown as Parameters<typeof createWorkersAI>[0])(
      "@cf/moonshotai/kimi-k2.6",
    );
  }

  /**
   * Tool surface for the audit anchor. Mirrors the *conceptual* tool the
   * triage flow exercises (`lookupGuideline` from guidelines.ts). The
   * triage flow doesn't go through Vercel AI's tool framework — it calls
   * the lookup directly — but the audit trail should still record
   * "agent had this tool available when it served this turn." Calling
   * `agent.getTools()` once at turn start fires the `getTools` hook commit
   * via the withProvenance wrapper.
   *
   * We cast to ToolSet because the Vercel AI SDK's `Tool<>` shape requires
   * a Zod inputSchema we don't need (the agent never invokes this through
   * Think's tool runtime — it's just a declarative manifest for the audit
   * trail). The wrapper hashes `{ name, description }` for the on-chain
   * payload; full schemas would just bloat OP_RETURN.
   */
  override getTools(): ToolSet {
    const tools = {
      clinical_guideline_lookup: {
        description:
          "Look up the canonical clinical guideline for a symptom keyword (cardiac, headache, back pain, respiratory, diabetes, colorectal screening, or general triage).",
      },
    };
    return tools as unknown as ToolSet;
  }

  // ── Multi-conversation runtime ────────────────────────────────────

  /**
   * Read the per-connection active conversation. Returns null if the
   * connection hasn't been auto-selected onto one yet (only happens
   * for a brand-new agent with no conversations).
   */
  getConnectionConversation(connection: Connection): string | null {
    const state = connection.state as ConnectionState | undefined | null;
    return state?.activeConversationId ?? null;
  }

  /** Set this connection's active conversation. Survives hibernation. */
  setConnectionConversation(connection: Connection, conversationId: string): void {
    connection.setState({ activeConversationId: conversationId });
  }

  /**
   * Build {@link ConversationSummary} for every active conversation,
   * decorating each with its latest commit's sequence + tx_status so
   * the frontend tab bar can render status dots.
   */
  async listConversationSummaries(): Promise<ConversationSummary[]> {
    // Filter out the package's "default" fallback conversation. It's
    // created by withProvenance's __pt_init for single-conversation
    // legacy support; cold-boot commits whose `setActiveConversation`
    // hasn't run yet land there. We don't want it in the tab bar,
    // global ticker, or counters — the demo's identity is per-user
    // conversation, not the system-internal fallback bucket.
    const conversations = (
      await this.listConversations({ status: "active" })
    ).filter((c) => c.id !== "default");
    if (conversations.length === 0) return [];
    const sql = (
      this as unknown as {
        ctx: { storage: { sql: { exec: (q: string, ...b: unknown[]) => { toArray: () => unknown[] } } } };
      }
    ).ctx.storage.sql;

    // Bulk-fetch the latest commit per conversation. SQLite GROUP BY MAX()
    // pattern: use a correlated subquery so we get the row matching the
    // group's max sequence.
    const summaries: ConversationSummary[] = [];
    for (const conv of conversations) {
      const rows = sql
        .exec(
          "SELECT sequence, tx_status FROM pt_commits " +
            "WHERE conversation_id = ? AND txid IS NOT NULL " +
            "ORDER BY sequence DESC LIMIT 1",
          conv.id,
        )
        .toArray() as Array<{ sequence: number; tx_status: string | null }>;
      const countRow = sql
        .exec(
          "SELECT COUNT(*) AS n FROM pt_commits " +
            "WHERE conversation_id = ? AND txid IS NOT NULL",
          conv.id,
        )
        .toArray() as Array<{ n: number }>;
      summaries.push({
        id: conv.id,
        title: conv.title,
        commitCount: Number(countRow[0]?.n ?? 0),
        latestSequence: Number(rows[0]?.sequence ?? 0),
        latestTxStatus: rows[0]?.tx_status ?? null,
        createdAt: conv.createdAt,
        lastActiveAt: conv.lastActiveAt,
        status: conv.status,
      });
    }
    return summaries;
  }

  /**
   * Send a connection-scope event (hello, conversation-list, etc.) to a
   * single connection. Use {@link broadcastEvent} for conversation-scope
   * events that should fan out by activeConversationId.
   */
  sendToConnection(connection: Connection, envelope: AgentEventEnvelope): void {
    try {
      connection.send(JSON.stringify(envelope));
    } catch {
      /* swallow — peer gone */
    }
  }

  /**
   * Fan out an event to all connections, optionally filtered by
   * conversationId. If the envelope has a `conversationId`, only
   * connections whose active conversation matches will receive it.
   * Connection-scope events (hello, conversation-list, conversation-created,
   * conversation-selected) bypass filtering and reach all peers.
   */
  broadcastEvent(envelope: AgentEventEnvelope): void {
    const payload = JSON.stringify(envelope);
    const targetConvId =
      "conversationId" in envelope ? envelope.conversationId : null;
    const self = this as unknown as { getConnections?: () => Iterable<Connection> };
    const conns = self.getConnections?.();
    if (!conns) {
      // Fallback for environments where partyserver hasn't initialized
      // (test, early-startup) — broadcast to whatever raw sockets we have.
      // No filtering possible; this path is only hit during DO bootstrap.
      for (const ws of this.connectedClients) {
        if (
          ws.readyState === WebSocket.READY_STATE_CLOSING ||
          ws.readyState === WebSocket.READY_STATE_CLOSED
        ) {
          continue;
        }
        try {
          ws.send(payload);
        } catch {
          /* swallow */
        }
      }
      return;
    }
    for (const conn of conns) {
      if (targetConvId !== null) {
        const active = this.getConnectionConversation(conn);
        if (active !== targetConvId) continue;
      }
      try {
        conn.send(payload);
      } catch {
        /* swallow — peer is gone, will be cleaned on close */
      }
    }
  }

  /** Called from the `onCommit` config hook. */
  _handleCommit(event: CommitEvent): void {
    // The package's CommitEvent now carries conversationId + sequence
    // directly (post per-conversation chains). We still hydrate
    // commit_hash + envelope_key from the local DO state because those
    // aren't on the event.
    const conversationId = event.conversationId;
    // Don't WS-broadcast commits that land in the package's "default"
    // fallback conversation. They're valid on-chain commitments (the
    // chain is fine), but the demo UI doesn't show the default bucket
    // anywhere — broadcasting them would cause the frontend to
    // lazy-bootstrap a hidden "default" conversation that pollutes the
    // global ticker. The pt_commits row is still written by the package,
    // so a future verify by txid still works.
    if (conversationId === "default") {
      return;
    }
    let commitHash = "";
    let envelopeKey = "";
    const meta = this.pendingCommitMeta.get(conversationId);
    // Prefer the package's authoritative scopeTags (mirrors the envelope
    // header). Fall back to pendingCommitMeta only for legacy callers that
    // pre-stage scope without passing it through to commitSync.
    const scopeTags = event.scopeTags?.length ? event.scopeTags : (meta?.scopeTags ?? []);
    const r2PathPrefix = meta?.r2PathPrefix ?? "acme-health";
    try {
      const sql = (
        this as unknown as {
          ctx: {
            storage: {
              sql: {
                exec: (q: string, ...b: unknown[]) => { toArray: () => unknown[] };
              };
            };
          };
        }
      ).ctx.storage.sql;
      const rows = sql
        .exec(
          "SELECT commit_hash, created_at FROM pt_commits " +
            "WHERE conversation_id = ? AND sequence = ? LIMIT 1",
          conversationId,
          event.sequence,
        )
        .toArray() as Array<{
          commit_hash: string;
          created_at: number;
        }>;
      const row = rows[0];
      if (row) {
        commitHash = row.commit_hash;
        const month = new Date(row.created_at).toISOString().slice(0, 7);
        const agentShort = this.identityPubHexCache?.slice(0, 16) ?? "";
        // Path layout from package's storage-r2.envelopeKey():
        //   {prefix}/{tenant}/{agent}/{conversationId}/{YYYY-MM}/{seq:012}.env.json
        envelopeKey = `${r2PathPrefix}/default/${agentShort}/${conversationId}/${month}/${String(event.sequence).padStart(12, "0")}.env.json`;
      }
    } catch (e) {
      console.warn("[agent] _handleCommit hydration failed", (e as Error).message);
    }
    const tsMs = Date.now();
    const ts = new Date(tsMs).toISOString();
    this.broadcastEvent({
      kind: "commit",
      conversationId,
      ts,
      sequence: event.sequence,
      hookKind: event.hookKind,
      scopeTags,
      txid: event.txid,
      txStatus: event.txStatus ?? "",
      commitHash,
      envelopeKey,
      feeSats: event.feeSats,
      arcUrl: event.arcUrl,
    });
    // Sidecar mirror — used by replayRecentCommits() on conv switch.
    try {
      const sql = (
        this as unknown as {
          ctx: { storage: { sql: { exec: (q: string, ...b: unknown[]) => unknown } } };
        }
      ).ctx.storage.sql;
      sql.exec(
        "INSERT OR REPLACE INTO triage_commit_meta " +
          "(conversation_id, txid, scope_tags_json, envelope_key, fee_sats, arc_url, ts) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        conversationId,
        event.txid,
        JSON.stringify(scopeTags),
        envelopeKey,
        event.feeSats,
        event.arcUrl ?? "",
        tsMs,
      );
    } catch (e) {
      console.warn("[agent] triage_commit_meta write failed:", (e as Error).message);
    }
  }

  /**
   * Fetch a persisted demo persona grant from `triage_demo_grants`.
   * Agent-scoped (not conversation-scoped) so a Compliance Officer's key
   * decrypts PHI events across every patient conversation.
   */
  async getDemoPersonaGrant(persona: string): Promise<{
    privHex: string;
    pubHex: string;
    grantId: string;
    label: string;
    scope: import("provable-think").GrantScope;
    capability: import("provable-think").ViewingCapability;
  } | null> {
    try {
      const sql = (
        this as unknown as {
          ctx: { storage: { sql: { exec: (q: string, ...b: unknown[]) => { toArray: () => unknown[] } } } };
        }
      ).ctx.storage.sql;
      const rows = sql
        .exec(
          "SELECT priv_hex, pub_hex, grant_id, label, scope_json, granted_at FROM triage_demo_grants WHERE persona = ? LIMIT 1",
          persona,
        )
        .toArray() as Array<{
          priv_hex: string;
          pub_hex: string;
          grant_id: string;
          label: string;
          scope_json: string;
          granted_at: number;
        }>;
      const row = rows[0];
      if (!row) return null;
      const scope = JSON.parse(row.scope_json) as import("provable-think").GrantScope;
      const agentIdentityPubHex = await this.getIdentityPublicKey();
      const capability: import("provable-think").ViewingCapability = {
        id: row.grant_id,
        recipientPubHex: row.pub_hex,
        agentIdentityPubHex,
        scope,
        label: row.label,
        grantedAt: row.granted_at,
        envelopeStoragePrefix: `acme-health/default/${agentIdentityPubHex.slice(0, 16)}/`,
        envelopeServerUrl: provenanceConfig.disclosure.envelopeServerUrl ?? "",
      };
      return {
        privHex: row.priv_hex,
        pubHex: row.pub_hex,
        grantId: row.grant_id,
        label: row.label,
        scope,
        capability,
      };
    } catch (e) {
      console.warn("[agent] getDemoPersonaGrant failed:", (e as Error).message);
      return null;
    }
  }

  /**
   * Idempotent persona grant issuance for the demo. Returns the cached
   * grant if it exists; otherwise mints a fresh keypair, issues a
   * grantViewingKey to it, persists the (priv, grant) pair in
   * triage_demo_grants so subsequent boots restore the same persona key.
   *
   * Used by both /grant/persona (frontend-driven) and onStart (eager
   * boot-time issuance for CO + External Auditor so commits that fire
   * before any user interaction are still decryptable by these personas).
   * The patient persona is session-bound and not eagerly issued.
   */
  async ensureDemoPersonaGrant(
    persona: "compliance-officer" | "external-auditor" | "patient",
  ): Promise<{ privHex: string; grantId: string }> {
    const cached = await this.getDemoPersonaGrant(persona);
    if (cached) return { privHex: cached.privHex, grantId: cached.grantId };

    const { PrivateKey, Utils } = await import("@bsv/sdk");
    const k = PrivateKey.fromRandom();
    const generatedPrivHex = k.toHex();
    const recipientPubHex = Utils.toHex(k.toPublicKey().encode(true) as number[]);

    let scope: GrantScope;
    let label: string;
    if (persona === "compliance-officer") {
      scope = HIPAA_COMPLIANCE_OFFICER_SCOPE as GrantScope;
      label = "HIPAA Compliance Officer (full PHI scope)";
    } else if (persona === "external-auditor") {
      scope = HIPAA_EXTERNAL_AUDITOR_SCOPE as GrantScope;
      label = "External HIPAA Auditor (operations + de-identified)";
    } else {
      // Patient persona is bound to THIS agent's identity. In the demo,
      // each DO ≈ one agent ≈ one patient persona; the multi-conversation
      // architecture means a single Patient grant can decrypt every
      // conversation on this agent — exactly the demo story.
      const agentShort = (await this.getIdentityPublicKey()).slice(0, 16);
      scope = hipaaPatientScope(agentShort);
      label = "Patient (own session events)";
    }

    const cap = await this.grantViewingKey({
      recipientPubHex,
      scope,
      label,
    });
    await this.saveDemoPersonaGrant(persona, {
      privHex: generatedPrivHex,
      pubHex: recipientPubHex,
      grantId: cap.id,
      label,
      scope,
      capability: cap,
    });
    return { privHex: generatedPrivHex, grantId: cap.id };
  }

  async saveDemoPersonaGrant(
    persona: string,
    grant: {
      privHex: string;
      pubHex: string;
      grantId: string;
      label: string;
      scope: import("provable-think").GrantScope;
      capability: import("provable-think").ViewingCapability;
    },
  ): Promise<void> {
    const sql = (
      this as unknown as {
        ctx: { storage: { sql: { exec: (q: string, ...b: unknown[]) => unknown } } };
      }
    ).ctx.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO triage_demo_grants (persona, priv_hex, pub_hex, grant_id, label, scope_json, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      persona,
      grant.privHex,
      grant.pubHex,
      grant.grantId,
      grant.label,
      JSON.stringify(grant.scope),
      grant.capability.grantedAt ?? Date.now(),
    );
  }

  /**
   * Replay the last N commits from a single conversation to a freshly-
   * connected (or just-switched) client. Sends fully-hydrated `commit`
   * events byte-identical to live broadcasts so the frontend handles
   * them with the same `pushEvent` path.
   */
  async replayRecentCommits(
    connection: Connection,
    conversationId: string,
    limit = 50,
  ): Promise<void> {
    let rows: Array<{
      sequence: number;
      hook_kind: string;
      txid: string;
      commit_hash: string;
      tx_status: string | null;
      arc_url: string | null;
      created_at: number;
      scope_tags_json: string | null;
      envelope_key: string | null;
      fee_sats: number | null;
    }> = [];
    try {
      const sql = (
        this as unknown as {
          ctx: {
            storage: { sql: { exec: (q: string, ...b: unknown[]) => { toArray: () => unknown[] } } };
          };
        }
      ).ctx.storage.sql;
      // INNER JOIN so we only replay commits that carry sidecar metadata
      // (scope tags + envelope key). Anything older than the multi-conversation
      // schema would lack `conversation_id` on the meta side and be skipped
      // by the join — clean wipe via Step 7 makes that moot.
      rows = sql
        .exec(
          "SELECT pc.sequence, pc.hook_kind, pc.txid, pc.commit_hash, " +
            "pc.tx_status, pc.arc_url, pc.created_at, " +
            "tcm.scope_tags_json, tcm.envelope_key, tcm.fee_sats " +
            "FROM pt_commits pc " +
            "INNER JOIN triage_commit_meta tcm ON tcm.conversation_id = pc.conversation_id " +
            "  AND tcm.txid = pc.txid " +
            "WHERE pc.conversation_id = ? AND pc.txid IS NOT NULL " +
            "ORDER BY pc.sequence DESC LIMIT ?",
          conversationId,
          limit,
        )
        .toArray() as typeof rows;
    } catch (e) {
      console.warn("[agent] replayRecentCommits query failed:", (e as Error).message);
      return;
    }
    // Send chronologically (oldest first) so the frontend's projection
    // sees the same ordering live broadcasts produce.
    for (const row of rows.reverse()) {
      const scopeTags = row.scope_tags_json
        ? (() => {
            try {
              return JSON.parse(row.scope_tags_json) as string[];
            } catch {
              return [];
            }
          })()
        : [];
      let envelopeKey = row.envelope_key ?? "";
      if (!envelopeKey) {
        const month = new Date(row.created_at).toISOString().slice(0, 7);
        const agentShort = this.identityPubHexCache?.slice(0, 16) ?? "";
        envelopeKey = `acme-health/default/${agentShort}/${conversationId}/${month}/${String(row.sequence).padStart(12, "0")}.env.json`;
      }
      const payload: AgentEventEnvelope = {
        kind: "commit",
        conversationId,
        ts: new Date(row.created_at).toISOString(),
        sequence: row.sequence,
        hookKind: row.hook_kind,
        scopeTags,
        txid: row.txid,
        txStatus: row.tx_status ?? "",
        commitHash: row.commit_hash,
        envelopeKey,
        feeSats: row.fee_sats ?? 36,
        arcUrl: row.arc_url ?? "",
      };
      try {
        connection.send(JSON.stringify(payload));
      } catch {
        /* swallow — peer gone */
      }
    }
  }

  _handleCommitError(event: CommitErrorEvent): void {
    this.broadcastEvent({
      kind: "commit-error",
      conversationId: event.conversationId,
      ts: new Date().toISOString(),
      hookKind: event.hookKind,
      sequence: event.sequence,
      error: event.error,
    });
  }

  // ── WebSocket lifecycle (overrides Agent's defaults) ──────────────

  override async onConnect(connection: Connection): Promise<void> {
    await handleConnect(this, connection);
  }

  override async onMessage(
    connection: Connection,
    message: WSMessage,
  ): Promise<void> {
    await handleMessage(this, connection, message);
  }

  override onClose(
    connection: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): void {
    handleClose(this, connection);
  }
}
