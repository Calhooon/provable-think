/**
 * `withProvenance` — higher-order class wrapper that adds BSV-mainnet anchored
 * provenance to a Cloudflare Project Think agent.
 *
 * v0.1.0-alpha scope:
 *   - Intercepts every documented Project Think lifecycle hook AND the durable-
 *     execution hooks from the underlying `agents` package.
 *   - Each hook fires a real mainnet PRT1 OP_RETURN broadcast via multi-ARC
 *     race (no "pending wiring" placeholders).
 *   - Per-DO funding wallet kept in DO SQLite. Operator deposits funding via
 *     `agent.topUp(...)`; the agent spends a small UTXO per commit.
 *   - Hook commitments are async via `ctx.waitUntil` so they never block the
 *     agent's response path.
 *
 * v0.2 layers in BRC-78 multi-recipient envelope encryption + R2 storage; the
 * commitment surface here is already stable.
 */

import {
  Hash,
  PrivateKey,
  ProtoWallet,
  Transaction,
  Utils,
} from "@bsv/sdk";
import {
  fundingAddressFromPubHex,
  runCommitPipeline,
  type CommitOutcome,
} from "./broadcast-pipeline.js";
import {
  ProvenanceState,
  type SqlStorageLike,
} from "./state.js";
import type {
  CommitErrorEvent,
  CommitEvent,
  HookKind,
  ProvenanceConfig,
} from "./types.js";

// ====================================================================
// Types — the minimal subset of the Project Think + Agent surface we touch
// ====================================================================

/**
 * Hook surface that `withProvenance` instruments. Documentation type — the
 * HOC does NOT impose this as a constraint on the input base class, because
 * `ctx` and `env` are protected fields on `DurableObject` / `Agent` /
 * `Think`, and structural typing rejects protected → public narrowing.
 *
 * The runtime contract is simply: the base class must (a) inherit from
 * `DurableObject` (so `this.ctx.storage.sql` and `this.env` exist), and
 * (b) have any subset of the Project Think hooks listed below. Methods not
 * present on the base get override-no-op'd by the HOC.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ThinkLike {
  beforeTurn?(ctx: any): any;
  beforeStep?(ctx: any): any;
  beforeToolCall?(ctx: any): any;
  afterToolCall?(ctx: any): any;
  onStepFinish?(ctx: any): any;
  onChunk?(ctx: any): any;
  onChatResponse?(result: any): any;
  onChatRecovery?(ctx: any): any;
  onFiberRecovered?(ctx: any): any;
  // v0.2 additions: anchor what model + tool surface the agent was using
  // when it served a turn, and the agent's session config at boot.
  getModel?(): any;
  getTools?(): any;
  configureSession?(session: any): any;
  getSystemPrompt?(): string;
  fetch?(req: Request): any;
  // Inherited from base `Agent` (cf agents package). Two-arg form:
  // `runFiber(name: string, fn: (ctx: { id; stash; snapshot }) => Promise<T>)`.
  runFiber?(name: string, fn: (ctx: any) => any): any;
  // Inherited from base `Agent`. Writes a snapshot blob to the active
  // fiber's `cf_agents_runs.snapshot`. Throws if called outside a fiber.
  stash?(data: unknown): void;
  // Set by Think's `_initializeExtensions` when `extensionLoader` is
  // configured. We don't reference its internal type here (it lives in
  // a separate dist file and is opaque to us); we wrap its `load()`
  // method post-instantiation to fire `extensionAuthored`.
  extensionManager?: {
    load(manifest: unknown, source: string): Promise<unknown>;
  };
}

/** Mixin-style constructor type. Tolerant of varying constructor signatures. */
type AnyCtor<T = any> = new (...args: any[]) => T;
/* eslint-enable @typescript-eslint/no-explicit-any */

// ====================================================================
// PHI-safe summaries for the chat()-path lifecycle hooks
// ====================================================================
//
// Project Think hands these wrappers a `ctx` argument that includes the
// full conversation `messages` array (PHI), tool outputs (PHI), and
// streaming chunk text (PHI). We can't anchor that raw payload under
// `["operations"]` scope without leaking PHI to anyone with the
// operations grant.
//
// Instead, each summarizer extracts ops-only metadata: timing, hook
// shape, derived counts, sha256 digests. Auditors holding the
// operations grant can verify *that* the inference loop ran and *what
// shape* it had — they just can't read the user data inside.
//
// Users who want a fuller audit (with PHI) can override pendingCommitMeta
// to widen scope on a per-conversation basis (the triage demo does this
// for `onChatResponse` via WIDE_SCOPE).
//
// The summary lives at module scope so it can run from the wrapper
// closure without re-creating per-instance.

interface MessageLike { role?: string; parts?: Array<{ type?: string }>; }

function safeMessageCount(messages: unknown): number {
  return Array.isArray(messages) ? messages.length : 0;
}

function safeStringLength(v: unknown): number {
  return typeof v === "string" ? v.length : 0;
}

function summarizeBeforeTurn(ctx: unknown): Record<string, unknown> {
  const c = (ctx ?? {}) as {
    system?: string;
    messages?: MessageLike[];
    tools?: Record<string, unknown>;
    model?: { modelId?: string; provider?: string };
    continuation?: boolean;
  };
  return {
    messageCount: safeMessageCount(c.messages),
    systemPromptLength: safeStringLength(c.system),
    toolNameCount: c.tools && typeof c.tools === "object" ? Object.keys(c.tools).length : 0,
    modelId: c.model?.modelId ?? "unknown",
    provider: c.model?.provider ?? "unknown",
    continuation: c.continuation === true,
  };
}

function summarizeBeforeStep(ctx: unknown): Record<string, unknown> {
  const c = (ctx ?? {}) as {
    stepNumber?: number;
    messages?: MessageLike[];
    finishReason?: string;
  };
  return {
    stepNumber: typeof c.stepNumber === "number" ? c.stepNumber : -1,
    messageCount: safeMessageCount(c.messages),
  };
}

function summarizeOnStepFinish(ctx: unknown): Record<string, unknown> {
  const c = (ctx ?? {}) as {
    stepNumber?: number;
    finishReason?: string;
    toolCalls?: Array<{ toolName?: string }>;
    text?: string;
  };
  return {
    stepNumber: typeof c.stepNumber === "number" ? c.stepNumber : -1,
    finishReason: typeof c.finishReason === "string" ? c.finishReason : "unknown",
    toolCallCount: Array.isArray(c.toolCalls) ? c.toolCalls.length : 0,
    toolNames: Array.isArray(c.toolCalls)
      ? c.toolCalls.map((t) => t?.toolName ?? "").filter(Boolean)
      : [],
    textLength: safeStringLength(c.text),
  };
}

function summarizeOnChunk(ctx: unknown): Record<string, unknown> {
  // The chunk shape varies (text-delta, tool-call, etc.); we record the
  // discriminator + minimal counts. NEVER anchor `text` content here —
  // that's where PHI would leak through the operations scope.
  const c = (ctx ?? {}) as { chunk?: { type?: string } | string };
  if (typeof c.chunk === "string") {
    return { chunkKind: "string", textLength: c.chunk.length };
  }
  const type = (c.chunk as { type?: string } | undefined)?.type ?? "unknown";
  return { chunkKind: type };
}

function summarizeOnChatRecovery(ctx: unknown): Record<string, unknown> {
  const c = (ctx ?? {}) as {
    streamId?: string;
    requestId?: string;
    partialText?: string;
    partialParts?: unknown[];
    recoveryData?: unknown;
    messages?: MessageLike[];
    createdAt?: number;
  };
  return {
    streamId: typeof c.streamId === "string" ? c.streamId : "",
    requestId: typeof c.requestId === "string" ? c.requestId : "",
    partialTextLength: safeStringLength(c.partialText),
    partialPartCount: Array.isArray(c.partialParts) ? c.partialParts.length : 0,
    hasRecoveryData: c.recoveryData != null,
    messageCount: safeMessageCount(c.messages),
    createdAt: typeof c.createdAt === "number" ? c.createdAt : null,
  };
}

function summarizeFiberRecovered(ctx: unknown): Record<string, unknown> {
  const c = (ctx ?? {}) as {
    id?: string;
    name?: string;
    snapshot?: unknown;
    createdAt?: number;
  };
  return {
    fiberId: typeof c.id === "string" ? c.id : "",
    fiberName: typeof c.name === "string" ? c.name : "",
    hasSnapshot: c.snapshot != null,
    createdAt: typeof c.createdAt === "number" ? c.createdAt : null,
  };
}

// ====================================================================
// Exposed instance API on every wrapped agent
// ====================================================================

/**
 * Methods automatically available on every `withProvenance(...)` agent
 * instance (in addition to whatever the base class exposes).
 */
export interface ProvenanceAgentAPI {
  /** Stable mainnet P2PKH address that funds this agent's commitments. */
  getFundingAddress(): Promise<string>;

  /** This agent's BRC-100 identity public key (compressed, 33 bytes hex). */
  getIdentityPublicKey(): Promise<string>;

  /**
   * Total available sats in the agent's funding wallet. Each commit consumes
   * ~30 sats in fees (at 100 sat/kb), so a 10,000-sat top-up funds ~300 events.
   */
  getFundingBalance(): Promise<number>;

  /**
   * Deposit a funding UTXO. Pass the raw transaction hex of a transaction
   * containing an output that pays this agent's funding address. Specify
   * which output index funds the agent.
   */
  topUp(args: {
    rawTxHex: string;
    outputIndex: number;
    valueSatoshis: number;
  }): Promise<{ accepted: true; available: number }>;

  /**
   * Re-fetch UTXOs from a public block-explorer (WhatsOnChain by default)
   * and ingest any unspent outputs at the funding address that aren't
   * already tracked. Useful when an external wallet has paid us.
   */
  syncFromMainnet(args?: { explorer?: "whatsonchain" }): Promise<{
    discovered: number;
    totalAvailable: number;
  }>;

  /**
   * The conversation id currently active for hook commits. Changes via
   * {@link setActiveConversation}. Defaults to `"default"` for legacy
   * single-conversation agents that haven't opted into multi-conversation.
   */
  getActiveConversationId(): Promise<string>;

  /**
   * Set the conversation upcoming hook commits will anchor under. The
   * conversation must already exist (call {@link createConversation} first).
   */
  setActiveConversation(conversationId: string): Promise<void>;

  /**
   * Create a new conversation: seeds a fresh per-conversation chain head and
   * anchors its genesis hash to the master chain. The conversation id may be
   * a UUID, slug, or any unique string. Pass `setActive: true` to also make
   * it the active conversation for upcoming commits.
   */
  createConversation(args: {
    id: string;
    title: string;
    setActive?: boolean;
  }): Promise<import("./state.js").ConversationRecord>;

  /** List conversations on this agent. */
  listConversations(opts?: {
    status?: "active" | "archived" | "all";
  }): Promise<import("./state.js").ConversationRecord[]>;

  /** Rename an existing conversation. */
  renameConversation(args: { id: string; title: string }): Promise<void>;

  /** Archive a conversation (still queryable, hidden from default list). */
  archiveConversation(id: string): Promise<void>;

  /**
   * Demo / recovery: mark every non-spent UTXO in the local pool as `spent`.
   *
   * Use case: if a parent broadcast orphans (`SEEN_IN_ORPHAN_MEMPOOL`), every
   * child commit chained off its change UTXO inherits the orphan status and
   * never propagates. The local pool retains the contaminated change UTXO as
   * `available`, so subsequent commits keep failing in cascade. `purgeFundingPool()`
   * clears all such ghost UTXOs so the operator can re-fund cleanly via
   * `topUp()` or `syncFromMainnet()`.
   *
   * Returns the number of UTXOs purged. Idempotent.
   */
  purgeFundingPool(): Promise<{ purged: number; fundingAddress: string }>;

  /**
   * Demo / recovery: wipe ALL chain state — commits, conversations, master
   * chain, viewing-key grants — and re-seed master_head at genesis. Preserves
   * the funding wallet (`pt_utxos`) and the cached agent identity pubkey, so
   * the same address keeps the same balance after the reset.
   *
   * Use case: a long-running demo accumulates cold-boot anchors,
   * abandoned conversations, and stale grants that visually clutter the
   * UI without representing real user activity. After this returns, the
   * frontend's counters drop to 0 and the next user message starts a
   * fresh chain.
   *
   * The package re-creates its `default` fallback conversation on the
   * next `__pt_init` call (single-conv legacy support); everything else
   * is gone. Returns per-table counts of what was wiped.
   */
  resetChain(): Promise<{
    commits: number;
    conversations: number;
    masterChain: number;
    grants: number;
  }>;

  /**
   * Synchronously emit a single commit, bypassing `ctx.waitUntil`. The caller
   * awaits the full broadcast pipeline and gets back the commitment outcome
   * (txid, propagation status, fee, etc.).
   *
   * Use this for tests or when the operator wants to know the commitment
   * result before responding to the user. Production agent paths should use
   * the automatic hook overrides which fire-and-forget via ctx.waitUntil.
   */
  commitSync(
    hookKind: HookKind,
    payload: unknown,
    opts?: {
      /**
       * Per-commit scope-tag override (replaces the class-time
       * `disclosure.defaultScopes`). Used by HIPAA scenarios where individual
       * events carry different scope subsets (e.g., one event tagged
       * `["PHI","treatment"]`, another tagged `["PHI","operations"]`).
       */
      scopeTags?: string[];
    },
  ): Promise<import("./broadcast-pipeline.js").CommitOutcome>;

  /**
   * Get an `AuthFetch` instance backed by the agent's rich wallet (with real
   * `createAction` support). Use this to call any BRC-103/104-authenticated
   * service that may charge BRC-105 micropayments — UHRP `/upload`, BRC-105
   * paid tools, etc. AuthFetch handles the 402 retry automatically by
   * building a BRC-29 payment from the agent's funding wallet.
   */
  getAuthFetch(): Promise<import("@bsv/sdk").AuthFetch>;

  // ===== Selective-disclosure issuance API (Phase 2.3) =====

  /**
   * Issue a viewing-key grant to an external auditor. From this point forward
   * every envelope whose scope intersects the grant's scope is sealed to BOTH
   * the existing recipients AND this auditor. Past envelopes are NOT
   * retroactively re-sealed — the grant is forward-only.
   *
   * The auditor receives the returned `ViewingCapability` out-of-band (PGP'd
   * email, secure portal). They use it + their own identity priv key to
   * decrypt envelopes that match their scope.
   */
  grantViewingKey(args: {
    /** 33-byte compressed hex pubkey of the auditor's identity. */
    recipientPubHex: string;
    /** Optional scope filter (tags, hookKinds, date range, agentIds). */
    scope?: import("./state.js").GrantScope;
    /** Human-readable label, e.g. "Acme Compliance Officer Q1 2026". */
    label?: string;
    /** ISO 8601 expiration. */
    validUntil?: string;
  }): Promise<ViewingCapability>;

  /** Revoke a previously-issued grant. Forward-only — past envelopes still decryptable to the recipient. */
  revokeViewingKey(args: { id: string }): Promise<{ revoked: boolean }>;

  /** List all grants issued by this agent. */
  listViewingKeys(): Promise<{
    grants: import("./state.js").GrantRecord[];
  }>;

  /**
   * Export an audit manifest — the list of envelope storage keys + on-chain
   * txids + commitment hashes for events that match the given scope filter.
   * Auditors use this to iterate the verifier without scanning all of R2.
   */
  exportAuditManifest(args?: {
    fromIso?: string;
    toIso?: string;
    hookKinds?: HookKind[];
    agentIds?: string[];
  }): Promise<AuditManifest>;
}

/**
 * Capability bundle the operator hands an auditor out-of-band. The auditor
 * uses it (plus their OWN identity private key) to decrypt envelopes that
 * fall within the grant's scope.
 */
export interface ViewingCapability {
  /** Grant identifier — matches the recipient `id` in each envelope. */
  id: string;
  /** Display label set at grant time. */
  label?: string;
  /** Auditor's compressed-pubkey identity (33-byte hex). */
  recipientPubHex: string;
  /** Agent's compressed-pubkey identity. Auditor needs this for ECDH. */
  agentIdentityPubHex: string;
  /** Scope this grant is authorized for. */
  scope: import("./state.js").GrantScope;
  /** Issuance timestamp (ms epoch). */
  grantedAt: number;
  /** Optional expiry (ms epoch). */
  validUntil?: number;
  /** R2/UHRP path prefix where envelopes for this agent live. */
  envelopeStoragePrefix?: string;
  /** Public HTTPS endpoint (verifier-side) for fetching encrypted envelopes.
   *  e.g., the agent Worker's `/envelope?key=...` route. */
  envelopeServerUrl?: string;
}

/** Audit-manifest entry — one row per chain commitment in the requested scope. */
export interface AuditManifestEntry {
  sequence: number;
  hookKind: string;
  txid: string;
  commitHash: string;
  envelopeStorageKey?: string;
  ts: number;
}

export interface AuditManifest {
  agentIdentityPubHex: string;
  generatedAt: number;
  scope?: {
    fromIso?: string;
    toIso?: string;
    hookKinds?: HookKind[];
    agentIds?: string[];
  };
  entries: AuditManifestEntry[];
}

const STATE_SYMBOL = Symbol.for("provable-think.state");

interface RuntimeState {
  state: ProvenanceState;
  wallet: ProtoWallet;
  identityKey: PrivateKey;
  identityPubHex: string;
  identityAddress: string;
  resolvedConfig: ProvenanceConfig;
}

/**
 * Wrap a Project Think agent class with provenance commitments.
 *
 * Usage:
 * ```ts
 * import { Think } from "@cloudflare/think";
 * import { withProvenance } from "provable-think";
 *
 * export class MyAgent extends withProvenance(Think<Env>, {
 *   identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
 *   anchor: { network: "mainnet" },
 * }) {
 *   getModel() { ... }
 * }
 * ```
 *
 * The returned class extends the input AND implements `ProvenanceAgentAPI`
 * (getFundingAddress, getIdentityPublicKey, getFundingBalance, topUp,
 * syncFromMainnet, commitSync). Type-wise the result is intersected so
 * these methods are visible to the consumer.
 */
export function withProvenance<TBase extends AnyCtor>(
  Base: TBase,
  config: ProvenanceConfig,
): TBase & AnyCtor<InstanceType<TBase> & ProvenanceAgentAPI> {
  // We access `ctx` and `env` via casts inside the class — both are present
  // at runtime when the base extends DurableObject / Agent / Think.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  class WithProvenance extends (Base as AnyCtor)
    implements ProvenanceAgentAPI
  {
    private [STATE_SYMBOL]?: RuntimeState;
    private __pt_active_conversation_id: string = "default";
    /**
     * Per-conversation commit chain — serializes commits within a conv so
     * `reserveNextSequence` can't race between the synchronous (commitSync)
     * and the fire-and-forget (commit_async) paths. Without this, when a
     * triage turn calls commitSync then immediately invokes a hook that
     * fires commit_async, both can read the same chain_head and reserve
     * the same sequence number, then both write commits with that sequence
     * — pt_commits PK is (conv, seq) so the second overwrites the first.
     */
    private __pt_commit_locks: Map<string, Promise<unknown>> = new Map();

    constructor(...args: any[]) {
      super(...args);
      // Install method shadows EARLY — must be on `this` before Think's
      // wrapped onStart fires (which is what calls configureSession). See
      // think.js line 43–58: Think's constructor monkey-patches onStart to
      // call configureSession() before the user's onStart runs. If we
      // installed our shadows in __pt_init (which only runs on first
      // explicit init from a hook or RPC method), configureSession would
      // fire AGAINST the unwrapped subclass method. The install itself
      // is purely synchronous (property assignment), so doing it in the
      // constructor is safe — no I/O.
      this.__pt_install_v02_wrappers();
    }

    // ===== Public agent API =====

    async getFundingAddress(): Promise<string> {
      const s = await this.__pt_init();
      return s.identityAddress;
    }

    async getIdentityPublicKey(): Promise<string> {
      const s = await this.__pt_init();
      return s.identityPubHex;
    }

    async getFundingBalance(): Promise<number> {
      const s = await this.__pt_init();
      return s.state.totalAvailableSats();
    }

    async topUp(args: {
      rawTxHex: string;
      outputIndex: number;
      valueSatoshis: number;
    }): Promise<{ accepted: true; available: number }> {
      const s = await this.__pt_init();
      // Validate the tx parses and has the expected output.
      const tx = Transaction.fromHex(args.rawTxHex);
      const out = tx.outputs[args.outputIndex];
      if (!out) {
        throw new Error(
          `topUp: outputIndex ${args.outputIndex} not found in tx`,
        );
      }
      const txid = tx.id("hex") as string;
      s.state.addUtxo({
        txHash: txid,
        txPos: args.outputIndex,
        value: args.valueSatoshis,
        rawTxHex: args.rawTxHex,
        createdAt: Date.now(),
      });
      return { accepted: true, available: s.state.totalAvailableSats() };
    }

    async syncFromMainnet(_args?: {
      explorer?: "whatsonchain";
    }): Promise<{ discovered: number; totalAvailable: number }> {
      const s = await this.__pt_init();
      const url = `https://api.whatsonchain.com/v1/bsv/main/address/${s.identityAddress}/unspent`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(
          `WhatsOnChain returned ${res.status} for address ${s.identityAddress}`,
        );
      }
      const utxos = (await res.json()) as Array<{
        tx_hash: string;
        tx_pos: number;
        value: number;
        height: number;
      }>;
      // Existing outpoints we already track.
      const existing = new Set(
        s.state
          .listAvailableUtxos()
          .map((u) => `${u.txHash}:${u.txPos}`),
      );
      let discovered = 0;
      for (const u of utxos) {
        const key = `${u.tx_hash}:${u.tx_pos}`;
        if (existing.has(key)) continue;
        // Need raw tx hex for EF format. Fetch it.
        const txRes = await fetch(
          `https://api.whatsonchain.com/v1/bsv/main/tx/${u.tx_hash}/hex`,
        );
        if (!txRes.ok) continue;
        const rawHex = (await txRes.text()).trim();
        s.state.addUtxo({
          txHash: u.tx_hash,
          txPos: u.tx_pos,
          value: u.value,
          rawTxHex: rawHex,
          createdAt: Date.now(),
        });
        discovered++;
      }
      return {
        discovered,
        totalAvailable: s.state.totalAvailableSats(),
      };
    }

    async purgeFundingPool(): Promise<{
      purged: number;
      fundingAddress: string;
    }> {
      const s = await this.__pt_init();
      const purged = s.state.purgeAvailableUtxos();
      return { purged, fundingAddress: s.identityAddress };
    }

    async resetChain(): Promise<{
      commits: number;
      conversations: number;
      masterChain: number;
      grants: number;
    }> {
      const s = await this.__pt_init();
      const counts = s.state.purgeChainState();
      // Re-create the package's "default" fallback conversation so
      // subsequent commits that haven't called setActiveConversation
      // yet land in a valid bucket (otherwise reserveNextSequence throws
      // "conversation 'default' not found"). This mirrors the bootstrap
      // logic in __pt_init so post-reset state matches a fresh DO boot.
      s.state.createConversation({ id: "default", title: "Default" });
      this.__pt_active_conversation_id = "default";
      return counts;
    }

    // ===== Conversation management =====

    async getActiveConversationId(): Promise<string> {
      await this.__pt_init();
      return this.__pt_active_conversation_id;
    }

    async setActiveConversation(conversationId: string): Promise<void> {
      const s = await this.__pt_init();
      const conv = s.state.getConversation(conversationId);
      if (!conv) {
        throw new Error(
          `setActiveConversation: conversation '${conversationId}' not found`,
        );
      }
      this.__pt_active_conversation_id = conversationId;
      s.state.touchConversation(conversationId);
    }

    async createConversation(args: {
      id: string;
      title: string;
      setActive?: boolean;
    }): Promise<import("./state.js").ConversationRecord> {
      const s = await this.__pt_init();
      const rec = s.state.createConversation({
        id: args.id,
        title: args.title,
      });
      if (args.setActive) {
        this.__pt_active_conversation_id = args.id;
      }
      return rec;
    }

    async listConversations(opts?: {
      status?: "active" | "archived" | "all";
    }): Promise<import("./state.js").ConversationRecord[]> {
      const s = await this.__pt_init();
      return s.state.listConversations(opts);
    }

    async renameConversation(args: {
      id: string;
      title: string;
    }): Promise<void> {
      const s = await this.__pt_init();
      s.state.renameConversation(args.id, args.title);
    }

    async archiveConversation(id: string): Promise<void> {
      const s = await this.__pt_init();
      s.state.archiveConversation(id);
    }

    // ===== Project Think hook overrides =====

    async beforeTurn(ctx: unknown): Promise<unknown> {
      // Reset per-turn latches so the first chunk of THIS turn anchors
      // (instead of staying suppressed by the previous turn's emit).
      (this as unknown as { __pt_onChunk_anchored_for_turn?: boolean })
        .__pt_onChunk_anchored_for_turn = false;
      this.__pt_commit_async("beforeTurn", summarizeBeforeTurn(ctx), ["operations"]);
      const supr = (Base.prototype as ThinkLike).beforeTurn;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async beforeStep(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async("beforeStep", summarizeBeforeStep(ctx), ["operations"]);
      const supr = (Base.prototype as ThinkLike).beforeStep;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async beforeToolCall(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async("beforeToolCall", ctx);
      const supr = (Base.prototype as ThinkLike).beforeToolCall;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async afterToolCall(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async("afterToolCall", ctx);
      const supr = (Base.prototype as ThinkLike).afterToolCall;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async onStepFinish(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async(
        "onStepFinish",
        summarizeOnStepFinish(ctx),
        ["operations"],
      );
      const supr = (Base.prototype as ThinkLike).onStepFinish;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async onChunk(ctx: unknown): Promise<unknown> {
      // onChunk fires per stream chunk — high-volume (often hundreds per
      // turn). Only commit if explicitly opted in via `config.commit`,
      // AND apply a per-turn latch so one chunk anchor lands per turn
      // instead of a flood. The latch is reset in `beforeTurn` (next turn
      // boundary) — so anchoring captures "the stream started producing
      // tokens at time T" without burning sats on every token.
      if (
        config.commit?.includes("onChunk") &&
        !(this as unknown as { __pt_onChunk_anchored_for_turn?: boolean })
          .__pt_onChunk_anchored_for_turn
      ) {
        (this as unknown as { __pt_onChunk_anchored_for_turn: boolean })
          .__pt_onChunk_anchored_for_turn = true;
        this.__pt_commit_async("onChunk", summarizeOnChunk(ctx), ["operations"]);
      }
      const supr = (Base.prototype as ThinkLike).onChunk;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async onChatResponse(result: unknown): Promise<unknown> {
      this.__pt_commit_async("onChatResponse", result);
      const supr = (Base.prototype as ThinkLike).onChatResponse;
      return typeof supr === "function" ? supr.call(this, result) : undefined;
    }
    async onChatRecovery(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async(
        "onChatRecovery",
        summarizeOnChatRecovery(ctx),
        ["operations"],
      );
      const supr = (Base.prototype as ThinkLike).onChatRecovery;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }
    async onFiberRecovered(ctx: unknown): Promise<unknown> {
      this.__pt_commit_async(
        "fiberRecovered",
        summarizeFiberRecovered(ctx),
        ["operations"],
      );
      const supr = (Base.prototype as ThinkLike).onFiberRecovered;
      return typeof supr === "function" ? supr.call(this, ctx) : undefined;
    }

    // ----- v0.2 hook anchors -----------------------------------------
    //
    // `getModel` and `getTools` are user-implemented SYNCHRONOUS methods
    // Think calls exactly once per `_runInferenceLoop` (once per chat turn,
    // before `beforeTurn` fires — see Think source line 399/418).
    //
    // Why per-instance shadows (not prototype overrides): subclasses
    // typically `override getModel()` to wire up their model. Because JS
    // resolves `this.getModel()` via the prototype chain, the subclass
    // method ALWAYS wins over a base-class implementation — making any
    // base-class wrapper dead code. We instead install instance-level
    // shadows during `__pt_init` (see `__pt_install_v02_wrappers`).
    //
    // Why scope `["operations"]`: model + tool surface are operational
    // metadata, not patient data. Matches the External HIPAA Auditor's
    // grant so they can verify the agent ran on the claimed model.
    //
    // Wrappers MUST return the original value unchanged so Think's model
    // dispatch + tool merge path is unaffected; commit fire-and-forgets via
    // `ctx.waitUntil` so the synchronous critical path stays sub-ms.

    private __pt_install_v02_wrappers(): void {
      const self = this as unknown as {
        __pt_v02_installed?: boolean;
        getModel?: () => unknown;
        getTools?: () => unknown;
        extensionManager?: unknown;
        __pt_commit_async: (
          k: HookKind,
          p: unknown,
          s?: string[],
        ) => void;
      };
      if (self.__pt_v02_installed) return;
      self.__pt_v02_installed = true;

      // ----- getModel -----
      const origGetModel = self.getModel?.bind(this);
      if (typeof origGetModel === "function") {
        self.getModel = () => {
          const model = origGetModel();
          try {
            const m = model as {
              provider?: string;
              modelId?: string;
              model?: string;
            };
            self.__pt_commit_async(
              "getModel",
              {
                provider: m?.provider ?? "unknown",
                modelId: m?.modelId ?? m?.model ?? "unknown",
              },
              ["operations"],
            );
          } catch {
            /* never fail the agent's hot path on an audit anchor */
          }
          return model;
        };
      }

      // ----- getTools -----
      // getTools is OPTIONAL in Project Think (default returns empty set).
      // If the subclass doesn't define one we still want to anchor "the
      // tool surface was empty" so the audit trail is complete. We resolve
      // via the original prototype chain so partyserver / Think defaults
      // are honored.
      const origGetTools = self.getTools?.bind(this);
      self.getTools = () => {
        const tools =
          typeof origGetTools === "function"
            ? (origGetTools() as Record<string, unknown>)
            : {};
        try {
          const toolNames = Object.keys(tools).sort();
          const toolSummaries = toolNames.map((name) => {
            const t = tools[name] as { description?: string } | undefined;
            return { name, description: t?.description ?? "" };
          });
          self.__pt_commit_async(
            "getTools",
            { count: toolNames.length, toolNames, toolSummaries },
            ["operations"],
          );
        } catch {
          /* swallow */
        }
        return tools;
      };

      // ----- configureSession -----
      // Fires ONCE per agent boot (Think's wrapped onStart calls it before
      // the user's onStart — see think.js line 50). Anchors the agent's
      // operational shape: system prompt + identity + class name. The
      // `session` arg is largely opaque (Session API exposes few public
      // accessors), so we hash a stable agent-shape snapshot rather than
      // trying to extract context-block details. The chain commits this
      // shape; auditors can match it against the agent source's
      // configureSession() body.
      const selfWithCfg = self as unknown as {
        configureSession?: (s: unknown) => unknown | Promise<unknown>;
        getSystemPrompt?: () => string;
      };
      const origConfigureSession = selfWithCfg.configureSession?.bind(this);
      if (typeof origConfigureSession === "function") {
        selfWithCfg.configureSession = async (sessionArg: unknown) => {
          const result = await origConfigureSession(sessionArg);
          try {
            // Best-effort agent-shape snapshot. SystemPrompt is the
            // load-bearing field for "did the agent change its system
            // prompt without me knowing"; agentClassName + identityPubHex
            // anchor identity.
            const cls = (this as unknown as { constructor?: { name?: string } })
              .constructor?.name ?? "unknown";
            const sysPrompt = (() => {
              try {
                return (selfWithCfg.getSystemPrompt?.() ?? "").slice(0, 800);
              } catch { return ""; }
            })();
            self.__pt_commit_async(
              "configureSession",
              {
                agentClassName: cls,
                systemPromptPreview: sysPrompt,
                systemPromptLength: sysPrompt.length,
              },
              ["operations"],
            );
          } catch {
            /* swallow */
          }
          return result;
        };
      }

      // ----- runFiber -----
      // Inherited from base `Agent`. Fires every chat turn when
      // `chatRecovery` is true (Think's default). Signature:
      // `runFiber(name: string, fn: (ctx) => Promise<T>): Promise<T>`.
      // Internal chat-turn fibers carry name `"__cf_internal_chat_turn:<requestId>"`.
      // We anchor `{ name, requestId, kind, isInternalChat }` under
      // `["operations"]` scope — fiber lifecycle is operational metadata,
      // not patient data. Auditors can later pair each `fiberStart` with
      // the `fiberRecovered` for the same id to detect interrupted fibers.
      const selfWithFiber = self as unknown as {
        runFiber?: (name: string, fn: (ctx: any) => any) => Promise<unknown>;
      };
      const origRunFiber = selfWithFiber.runFiber?.bind(this);
      if (typeof origRunFiber === "function") {
        selfWithFiber.runFiber = async (
          name: string,
          fn: (ctx: any) => any,
        ) => {
          try {
            const CHAT_PREFIX = "__cf_internal_chat_turn:";
            const isInternalChat =
              typeof name === "string" && name.startsWith(CHAT_PREFIX);
            const requestId = isInternalChat
              ? name.slice(CHAT_PREFIX.length)
              : null;
            self.__pt_commit_async(
              "fiberStart",
              {
                name: typeof name === "string" ? name : "unknown",
                requestId,
                isInternalChat,
                kind: isInternalChat ? "chat-turn" : "user",
              },
              ["operations"],
            );
          } catch {
            /* never fail the agent's hot path on an audit anchor */
          }
          return origRunFiber(name, fn);
        };
      }

      // ----- stash -----
      // Inherited from base `Agent`. Writes `data` into the active
      // fiber's `cf_agents_runs.snapshot` row (must be called inside a
      // `runFiber` callback). The stash hook is the integrity anchor
      // for fiber checkpoints — auditors comparing pre/post-recovery
      // state can verify the snapshot they replayed against the on-
      // chain hash. Payload is `{ snapshotByteCount, snapshotSha256 }`
      // under `["operations"]` scope; the actual snapshot bytes stay
      // off-chain (could be unbounded, often contains conversation
      // state we don't want on chain). We anchor BEFORE invoking the
      // original so a successful commit happens-before the snapshot
      // write — if the snapshot write later fails, the chain still has
      // the integrity anchor and the recovery handler can reconcile.
      const selfWithStash = self as unknown as {
        stash?: (data: unknown) => void;
      };
      const origStash = selfWithStash.stash?.bind(this);
      if (typeof origStash === "function") {
        selfWithStash.stash = (data: unknown) => {
          try {
            // Best-effort canonicalization. JSON.stringify isn't strictly
            // canonical (key order, escape variants) but for an integrity
            // anchor on the agent's own snapshot data structure the same
            // emit-site produces the same bytes deterministically, which is
            // what auditors need for replay verification.
            const json = JSON.stringify(data ?? null);
            const bytes = Utils.toArray(json, "utf8") as number[];
            const digest = Hash.sha256(bytes) as number[];
            self.__pt_commit_async(
              "stash",
              {
                snapshotByteCount: bytes.length,
                snapshotSha256: Utils.toHex(digest),
              },
              ["operations"],
            );
          } catch {
            /* never fail the agent's hot path */
          }
          return origStash(data);
        };
      }

      // ----- extensionAuthored -----
      // Anchors the fact that an extension was loaded (or unloaded) at
      // runtime. Think's `extensionLoader` + `extensionManager.load()`
      // is the surface — `_initializeExtensions` (private, on
      // prototype) creates the manager lazily in onStart. We can't
      // shadow `extensionManager.load` until that field is assigned,
      // so install a property accessor on `this` that wraps the
      // `load()` method on first read AFTER assignment. The wrap is
      // idempotent — repeat reads return the already-wrapped manager.
      try {
        let backing: unknown = self.extensionManager;
        const wrapManager = (mgr: unknown): unknown => {
          if (!mgr || typeof mgr !== "object") return mgr;
          const m = mgr as {
            __pt_load_wrapped?: boolean;
            load?: (manifest: unknown, source: string) => Promise<unknown>;
          };
          if (m.__pt_load_wrapped || typeof m.load !== "function") return mgr;
          const origLoad = m.load.bind(mgr);
          m.load = async (manifest: unknown, source: string) => {
            const result = await origLoad(manifest, source);
            try {
              const mf = (manifest ?? {}) as {
                name?: string;
                version?: string;
                description?: string;
                hooks?: string[];
                tools?: Array<{ name?: string }>;
              };
              const src = typeof source === "string" ? source : "";
              const bytes = Utils.toArray(src, "utf8") as number[];
              const digest = Hash.sha256(bytes) as number[];
              self.__pt_commit_async(
                "extensionAuthored",
                {
                  extensionName: mf.name ?? "unknown",
                  extensionVersion: mf.version ?? "unknown",
                  description: mf.description ?? "",
                  declaredHooks: Array.isArray(mf.hooks) ? mf.hooks : [],
                  toolNames: Array.isArray(mf.tools)
                    ? mf.tools.map((t) => t?.name ?? "").filter(Boolean)
                    : [],
                  sourceByteCount: bytes.length,
                  sourceSha256: Utils.toHex(digest),
                  // Bounded preview so the on-chain plaintext stays
                  // OP_RETURN-safe. Full source goes in the encrypted
                  // envelope on R2 if the demo wants to expose it.
                  sourcePreview: src.slice(0, 256),
                },
                ["operations"],
              );
            } catch {
              /* never block extension loading on an audit anchor */
            }
            m.__pt_load_wrapped = true;
            return result;
          };
          m.__pt_load_wrapped = true;
          return mgr;
        };
        Object.defineProperty(self, "extensionManager", {
          configurable: true,
          enumerable: true,
          get(): unknown {
            return backing;
          },
          set(v: unknown): void {
            backing = wrapManager(v);
          },
        });
        // Honor a pre-existing value (in case Think assigned it before
        // this descriptor took effect — defensive).
        if (backing) backing = wrapManager(backing);
      } catch {
        /* if the host runtime forbids defineProperty, skip silently */
      }
    }

    // ===== Internals =====

    private async __pt_init(): Promise<RuntimeState> {
      const cached = this[STATE_SYMBOL];
      if (cached) return cached;

      // Access ctx/env via cast since the base class is generic. At runtime
      // these are always present (any class extending DurableObject has them).
      const self = this as unknown as {
        ctx: {
          waitUntil?(p: Promise<unknown>): void;
          storage: { sql: SqlStorageLike };
          id?: { name?: string; toString(): string };
        };
        env: Record<string, unknown>;
      };

      // Resolve identity key:
      //   1) explicit static config.identity.privateKeyHex
      //   2) env binding (default: AGENT_PRIVATE_KEY_HEX, configurable)
      //   3) (v0.2) auto-derive from this.ctx.id
      const staticHex = config.identity?.privateKeyHex;
      const bindingName = config.identity?.envBinding ?? "AGENT_PRIVATE_KEY_HEX";
      const envHex = (self.env[bindingName] as string | undefined) ?? undefined;
      const hex = staticHex ?? envHex;
      if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(
          `withProvenance: identity priv key not found. Tried static config.identity.privateKeyHex (=${staticHex ? "set" : "unset"}) and env.${bindingName} (=${envHex ? "set" : "unset"}). v0.1 requires one of them. ` +
            "Auto-derivation from this.ctx.id is planned for v0.2.",
        );
      }
      const identityKey = PrivateKey.fromHex(hex);
      const wallet = new ProtoWallet(identityKey);

      const tenantId = config.identity?.tenantId ?? "default";
      const agentId =
        self.ctx?.id?.name ?? self.ctx?.id?.toString() ?? "unknown";

      const state = new ProvenanceState(
        self.ctx.storage.sql,
        tenantId,
        agentId,
      );
      state.init();
      const identityPubHex = await state.loadIdentityPubHex(wallet);
      const identityAddress = fundingAddressFromPubHex(identityPubHex);

      // Ensure the "default" conversation exists. This keeps single-
      // conversation agents working without explicit conversation management,
      // and gives multi-conversation agents a fallback pre-`createConversation`
      // bucket. Idempotent — only inserts if absent.
      const DEFAULT_CONV_ID = "default";
      if (!state.getConversation(DEFAULT_CONV_ID)) {
        state.createConversation({
          id: DEFAULT_CONV_ID,
          title: "Default",
        });
      }

      const runtime: RuntimeState = {
        state,
        wallet,
        identityKey,
        identityPubHex,
        identityAddress,
        resolvedConfig: config,
      };
      this[STATE_SYMBOL] = runtime;
      return runtime;
    }

    /**
     * Schedule a commit so it does not block the agent's reply path.
     * Uses `ctx.waitUntil` when the runtime supports it (Project Think DO,
     * production); falls back to a bare promise otherwise (tests).
     */
    private __pt_commit_async(
      hookKind: HookKind,
      payload: unknown,
      scopeTags?: string[],
    ): void {
      const promise = this.__pt_commit_safe(hookKind, payload, scopeTags);
      const ctx = (this as unknown as { ctx?: { waitUntil?(p: Promise<unknown>): void } }).ctx;
      if (typeof ctx?.waitUntil === "function") {
        ctx.waitUntil(promise);
      } else {
        // No request context (test, early-startup) — make sure the
        // promise has a catch so an eventual rejection doesn't crash the
        // Worker as an unhandled rejection.
        promise.catch(() => {/* swallow */});
      }
    }

    /** Wrapped to guarantee no agent-facing throw. */
    private async __pt_commit_safe(
      hookKind: HookKind,
      payload: unknown,
      scopeTags?: string[],
    ): Promise<void> {
      try {
        await this.__pt_commit(hookKind, payload, scopeTags);
      } catch (e) {
        const err: CommitErrorEvent = {
          conversationId: this.__pt_active_conversation_id,
          hookKind,
          sequence: -1,
          error: (e as Error).message,
        };
        try {
          await config.onCommitError?.(err);
        } catch {
          /* swallow */
        }
      }
    }

    /**
     * Run the full commit pipeline for a single hook firing. `perCommitScopeTags`
     * (if supplied) overrides `config.disclosure.defaultScopes` for this one
     * commit — used by hooks like `getModel` / `getTools` that fire BEFORE
     * the per-turn scope can be staged via `pendingCommitMeta` and need a
     * scope distinct from the conversation's PHI default.
     *
     * Concurrency: serialized per-conversation via __pt_commit_locks. Both
     * the synchronous `commitSync` path and the fire-and-forget `commit_async`
     * path go through here, so without serialization they can race on
     * `reserveNextSequence` and produce duplicate sequence numbers.
     */
    private async __pt_commit(
      hookKind: HookKind,
      payload: unknown,
      perCommitScopeTags?: string[],
    ): Promise<CommitOutcome> {
      // Capture the active conv NOW (before the await chain) so the lock
      // reflects the caller's intent.
      await this.__pt_init();
      const conversationId = this.__pt_active_conversation_id;
      const prev =
        this.__pt_commit_locks.get(conversationId) ?? Promise.resolve();
      const next = prev.then(
        () => this.__pt_commit_locked(hookKind, payload, conversationId, perCommitScopeTags),
        () => this.__pt_commit_locked(hookKind, payload, conversationId, perCommitScopeTags),
      );
      this.__pt_commit_locks.set(conversationId, next.catch(() => undefined));
      return next;
    }

    /** Inner commit body — runs serially per-conversation via the lock. */
    private async __pt_commit_locked(
      hookKind: HookKind,
      payload: unknown,
      conversationId: string,
      perCommitScopeTags?: string[],
    ): Promise<CommitOutcome> {
      const runtime = await this.__pt_init();

      const canonical = Utils.toArray(
        canonicalize({
          hookKind,
          ts: new Date().toISOString(),
          payload: redactPayloadForCommit(payload, hookKind, config),
        }),
        "utf8",
      );

      // Look up R2 bucket binding at runtime from env (if configured).
      const env = (this as unknown as { env: Record<string, unknown> }).env;
      const r2BindingName = config.storage?.r2?.binding;
      const r2Bucket = r2BindingName
        ? (env[r2BindingName] as
            | import("./storage-r2.js").R2BucketLike
            | undefined)
        : undefined;

      const outcome: CommitOutcome = await runCommitPipeline({
        state: runtime.state,
        wallet: runtime.wallet,
        identityKey: runtime.identityKey,
        identityAddress: runtime.identityAddress,
        hookKind,
        conversationId,
        payloadBytes: canonical,
        options: {
          feeSatsPerKb: config.anchor?.feeSatsPerKb ?? 100,
          arcUrls: config.anchor?.arcUrls,
          // Look up TaaL API key at runtime from env if not in static config.
          taalApiKey:
            config.anchor?.taalApiKey ??
            (env["TAAL_API_KEY"] as string | undefined),
          tenantId: config.identity?.tenantId ?? "default",
          agentId: runtime.identityPubHex.slice(0, 16), // short stable id
          recipients: (config.disclosure?.defaultRecipients ?? [
            { id: "self", counterparty: "self" },
          ]) as import("./envelope.js").RecipientGrant[],
          defaultScopeTags: perCommitScopeTags ?? config.disclosure?.defaultScopes,
          r2Bucket,
          r2PathPrefix: config.storage?.r2?.pathPrefix,
        },
      });

      if (outcome.ok && outcome.txid) {
        const event: CommitEvent = {
          conversationId: outcome.conversationId,
          hookKind,
          sequence: outcome.sequence,
          txid: outcome.txid,
          txStatus: outcome.txStatus,
          payloadLen: outcome.payloadLen,
          inputSats: outcome.inputSats,
          changeSats: outcome.changeSats,
          feeSats: outcome.feeSats,
          arcUrl: outcome.arcUrl ?? "",
          elapsedMs: outcome.elapsedMs,
          scopeTags:
            perCommitScopeTags ?? config.disclosure?.defaultScopes ?? [],
        };
        await config.onCommit?.(event);
      } else {
        const err: CommitErrorEvent = {
          conversationId: outcome.conversationId,
          hookKind,
          sequence: outcome.sequence,
          error: outcome.error ?? "broadcast failed",
          arcAttempts: outcome.arcResult.attempts.map((a) => ({
            url: a.url,
            txStatus: a.txStatus,
            error: a.error,
          })),
        };
        await config.onCommitError?.(err);
      }
      return outcome;
    }

    /** Synchronous commit — for tests or when the caller wants the txid. */
    async commitSync(
      hookKind: HookKind,
      payload: unknown,
      opts?: { scopeTags?: string[] },
    ): Promise<CommitOutcome> {
      return this.__pt_commit(hookKind, payload, opts?.scopeTags);
    }

    /**
     * AuthFetch instance backed by the agent's rich wallet (real `createAction`
     * support so AuthFetch can handle 402 BRC-105 payments via the funding pool).
     */
    async getAuthFetch(): Promise<import("@bsv/sdk").AuthFetch> {
      const runtime = await this.__pt_init();
      const { AuthFetch } = await import("@bsv/sdk");
      const { makeMinimalWallet } = await import("./wallet.js");
      const env = (this as unknown as { env: Record<string, unknown> }).env;
      const richWallet = makeMinimalWallet(runtime.wallet, {
        state: runtime.state,
        identityKey: runtime.identityKey,
        identityAddress: runtime.identityAddress,
        arcUrls: config.anchor?.arcUrls,
        taalApiKey:
          config.anchor?.taalApiKey ??
          (env["TAAL_API_KEY"] as string | undefined),
        feeSatsPerKb: config.anchor?.feeSatsPerKb ?? 100,
      });
      return new AuthFetch(richWallet);
    }

    // ===== Selective-disclosure issuance =====

    async grantViewingKey(args: {
      recipientPubHex: string;
      scope?: import("./state.js").GrantScope;
      label?: string;
      validUntil?: string;
    }): Promise<ViewingCapability> {
      const runtime = await this.__pt_init();
      // Validate recipient pubkey format.
      if (!/^0[23][0-9a-fA-F]{64}$/.test(args.recipientPubHex)) {
        throw new Error(
          `grantViewingKey: recipientPubHex must be a 33-byte compressed pubkey hex (66 chars starting with 02 or 03)`,
        );
      }
      const id =
        `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const validUntilMs = args.validUntil
        ? Date.parse(args.validUntil)
        : undefined;
      runtime.state.recordGrant({
        id,
        recipientPubHex: args.recipientPubHex,
        scope: args.scope ?? {},
        label: args.label,
        validUntil: validUntilMs,
      });
      return {
        id,
        label: args.label,
        recipientPubHex: args.recipientPubHex,
        agentIdentityPubHex: runtime.identityPubHex,
        scope: args.scope ?? {},
        grantedAt: Date.now(),
        validUntil: validUntilMs,
        envelopeStoragePrefix:
          (config.storage?.r2?.pathPrefix ?? "provable-think") +
          `/${config.identity?.tenantId ?? "default"}/${runtime.identityPubHex.slice(0, 16)}/`,
        envelopeServerUrl: config.disclosure?.envelopeServerUrl,
      };
    }

    async revokeViewingKey(args: { id: string }): Promise<{ revoked: boolean }> {
      const runtime = await this.__pt_init();
      return runtime.state.revokeGrant(args.id);
    }

    async listViewingKeys(): Promise<{
      grants: import("./state.js").GrantRecord[];
    }> {
      const runtime = await this.__pt_init();
      return { grants: runtime.state.listAllGrants() };
    }

    async exportAuditManifest(args?: {
      fromIso?: string;
      toIso?: string;
      hookKinds?: HookKind[];
      agentIds?: string[];
    }): Promise<AuditManifest> {
      const runtime = await this.__pt_init();
      const sql = (
        this as unknown as { ctx: { storage: { sql: SqlStorageLike } } }
      ).ctx.storage.sql;
      const fromMs = args?.fromIso ? Date.parse(args.fromIso) : 0;
      const toMs = args?.toIso ? Date.parse(args.toIso) : Date.now();
      const rows = sql
        .exec<{
          sequence: number;
          hook_kind: string;
          txid: string | null;
          commit_hash: string;
          created_at: number;
        }>(
          `SELECT sequence, hook_kind, txid, commit_hash, created_at
           FROM pt_commits
           WHERE created_at >= ? AND created_at <= ? AND txid IS NOT NULL
           ORDER BY sequence ASC`,
          fromMs,
          toMs,
        )
        .toArray()
        .filter((r) => {
          if (args?.hookKinds && args.hookKinds.length > 0) {
            return args.hookKinds.includes(r.hook_kind as HookKind);
          }
          return true;
        });
      const entries: AuditManifestEntry[] = rows.map((r) => ({
        sequence: r.sequence,
        hookKind: r.hook_kind,
        txid: r.txid as string,
        commitHash: r.commit_hash,
        ts: r.created_at,
      }));
      return {
        agentIdentityPubHex: runtime.identityPubHex,
        generatedAt: Date.now(),
        scope: args,
        entries,
      };
    }
  }

  return WithProvenance as unknown as TBase &
    AnyCtor<InstanceType<TBase> & ProvenanceAgentAPI>;
}

// ====================================================================
// Helpers
// ====================================================================

/**
 * Deterministic JSON serializer — sorted keys, no whitespace. Used for
 * canonical payload bytes that get hashed and signed.
 */
function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Pre-seal payload transform. When `disclosure.redaction.enabled` is true and
 * a `transform` is configured (the HIPAA preset wires Safe-Harbor inferred-PHI
 * redaction here), runs the transform before canonicalization. Otherwise the
 * payload passes through unchanged.
 *
 * The transform's output is what gets canonicalized + hashed for the on-chain
 * commitment AND what goes into the envelope. So a configured transform
 * affects both the chain and the encrypted off-chain copy — auditors see
 * already-redacted plaintext.
 */
function redactPayloadForCommit(
  payload: unknown,
  hookKind: HookKind,
  config: ProvenanceConfig,
): unknown {
  const r = config.disclosure?.redaction;
  if (r && r.enabled !== false && typeof r.transform === "function") {
    return r.transform(payload, hookKind);
  }
  return payload;
}
