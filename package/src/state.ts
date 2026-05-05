/**
 * Per-agent provenance state, persisted in the Durable Object's SQLite store.
 *
 * Owns:
 *   - Monotonic commitment sequence counter (per agent).
 *   - Funding UTXO set (the agent's small wallet kept in DO storage so it can
 *     sign + broadcast OP_RETURN commitments without external state).
 *   - Hash-chain head (prev_hash for the next BRC-60-aligned event).
 *   - Issued viewing-key capabilities (for v0.3 selective disclosure).
 *
 * Schema is created on first init(); migrations are forward-only. Every UTXO
 * is recorded with the raw source-tx hex so we can build EF (BRC-30) format
 * for ARC broadcast without an external lookup.
 */

import { Hash, Utils, type ProtoWallet } from "@bsv/sdk";

export interface ProvenanceUtxo {
  txHash: string; // 32-byte hex
  txPos: number;
  value: number; // satoshis
  rawTxHex: string;
  createdAt: number; // ms epoch when added
}

export interface ChainHead {
  /** Last anchored sequence number (0 = genesis). */
  sequence: number;
  /** Hash of the last commitment, or genesis hash when sequence=0. */
  prevHash: string; // 32-byte hex
}

/** Inflight reservation while a broadcast is mid-flight. */
export interface UtxoReservation {
  utxo: ProvenanceUtxo;
  /** Internal label so we can release on failure. */
  reservationId: string;
}

/** Scope descriptor for a viewing-key grant. */
export interface GrantScope {
  tags?: string[];
  hookKinds?: string[];
  fromIso?: string;
  toIso?: string;
  agentIds?: string[];
}

/** Persisted viewing-key grant record. */
export interface GrantRecord {
  id: string;
  recipientPubHex: string;
  scope: GrantScope;
  label?: string;
  status?: "active" | "revoked";
  grantedAt: number;
  revokedAt?: number;
  validUntil?: number;
}

/**
 * One conversation = one independent commit chain. Each conversation has its
 * own sequence counter starting at 0 and its own chain head. The conversation's
 * genesis hash is anchored to a master chain (see {@link MasterChainEntry}) so
 * an attacker cannot silently delete an entire conversation from the agent.
 */
export interface ConversationRecord {
  id: string;
  title: string;
  /** Per-conversation chain head: starts at {sequence: 0, prevHash: convGenesisHash}. */
  chainHead: ChainHead;
  /** Index into the master chain where this conversation's genesis was anchored. */
  masterSeq: number;
  createdAt: number;
  lastActiveAt: number;
  status: "active" | "archived";
}

/** One row of the master-of-conversations chain. */
export interface MasterChainEntry {
  sequence: number;
  conversationId: string;
  conversationGenesisHash: string;
  prevMasterHash: string;
  ts: number;
}

/**
 * A SQL-storage-like surface (matches Cloudflare Workers' DO `ctx.storage.sql`).
 * Defined locally to avoid pulling in the full `@cloudflare/workers-types`
 * dependency surface — any object with this shape works.
 *
 * Note: Cloudflare's `.one()` THROWS if zero or >1 rows are returned. Use
 * `.toArray()[0]` for "maybe 0 or 1 row" queries; reserve `.one()` for queries
 * that are guaranteed to return exactly one row (e.g. SUM, single-PK lookup
 * after insertion).
 */
export interface SqlStorageLike {
  exec<T = unknown>(query: string, ...bindings: unknown[]): {
    toArray(): T[];
    one(): T;
    rowsRead?: number;
    rowsWritten?: number;
  };
}

const DDL = [
  // Commitment sequence + chain head + miscellaneous singleton state.
  `CREATE TABLE IF NOT EXISTS pt_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Funding UTXOs the agent can spend to broadcast OP_RETURN commitments.
  // status: 'available' | 'reserved' | 'spent'
  `CREATE TABLE IF NOT EXISTS pt_utxos (
    tx_hash TEXT NOT NULL,
    tx_pos INTEGER NOT NULL,
    value INTEGER NOT NULL,
    raw_tx_hex TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    reservation_id TEXT,
    created_at INTEGER NOT NULL,
    spent_at INTEGER,
    PRIMARY KEY (tx_hash, tx_pos)
  )`,
  // Append-only journal of commitments we've broadcast (for our own records).
  // PRIMARY KEY is (conversation_id, sequence) — sequence numbers are per
  // conversation and start at 1.
  `CREATE TABLE IF NOT EXISTS pt_commits (
    conversation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hook_kind TEXT NOT NULL,
    txid TEXT,
    commit_hash TEXT NOT NULL,
    payload_hex TEXT NOT NULL,
    arc_url TEXT,
    tx_status TEXT,
    elapsed_ms INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, sequence)
  )`,
  // Conversations table — one row per logical conversation/chat thread.
  // chain_head_json stores {sequence, prevHash} for THIS conversation only.
  `CREATE TABLE IF NOT EXISTS pt_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    chain_head_json TEXT NOT NULL,
    master_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  )`,
  // Master chain — appends one entry per conversation creation, anchoring
  // that conversation's genesis hash into a global, tamper-evident sequence.
  // Without this, deleting an entire conversation cleanly leaves no trace.
  `CREATE TABLE IF NOT EXISTS pt_master_chain (
    sequence INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    conversation_genesis_hash TEXT NOT NULL,
    prev_master_hash TEXT NOT NULL,
    ts INTEGER NOT NULL
  )`,
  // Selective-disclosure grants (viewing keys issued to auditors).
  // status: 'active' | 'revoked'. Forward-only — revoking does not retract
  // past envelopes that were sealed to the recipient.
  `CREATE TABLE IF NOT EXISTS pt_grants (
    id TEXT PRIMARY KEY,
    recipient_pub_hex TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER,
    valid_until INTEGER
  )`,
];

const MASTER_GENESIS_PREFIX = "provable-think/v1/master-genesis";
const CONVERSATION_GENESIS_PREFIX = "provable-think/v1/conversation-genesis";

export class ProvenanceState {
  constructor(
    private readonly sql: SqlStorageLike,
    private readonly tenantId: string,
    private readonly agentId: string,
  ) {}

  /** Idempotent: creates tables and seeds the master chain head if absent. */
  init(): void {
    for (const stmt of DDL) {
      this.sql.exec(stmt);
    }
    // Seed the master chain head (singleton in pt_state) if not present.
    // The master chain is *agent-wide* and accumulates one entry per
    // conversation creation. Per-conversation chain heads live in
    // pt_conversations.chain_head_json.
    const head = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM pt_state WHERE key = 'master_head'`,
      )
      .toArray()[0];
    if (!head) {
      const masterGenesisInput = Utils.toArray(
        `${this.tenantId}::${this.agentId}::${MASTER_GENESIS_PREFIX}`,
        "utf8",
      );
      const masterGenesisHash = Utils.toHex(
        Hash.sha256(masterGenesisInput) as number[],
      );
      const headJson = JSON.stringify({
        sequence: 0,
        prevHash: masterGenesisHash,
      });
      this.sql.exec(
        `INSERT INTO pt_state (key, value) VALUES ('master_head', ?)`,
        headJson,
      );
    }
  }

  // ===== master chain (agent-wide) =====

  /** Master chain head — singleton anchoring all conversation genesis hashes. */
  getMasterHead(): ChainHead {
    const row = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM pt_state WHERE key = 'master_head'`,
      )
      .toArray()[0];
    if (!row) {
      throw new Error(
        "ProvenanceState.getMasterHead(): not initialized (call init() first)",
      );
    }
    return JSON.parse(row.value) as ChainHead;
  }

  /**
   * Append a new conversation's genesis hash to the master chain. Atomic with
   * the conversation insert in {@link createConversation}. Returns the master
   * sequence at which this conversation was anchored.
   */
  private appendMaster(
    conversationId: string,
    conversationGenesisHash: string,
  ): number {
    const head = this.getMasterHead();
    const nextSeq = head.sequence + 1;
    const link = Utils.toArray(
      `${head.prevHash}::${conversationId}::${conversationGenesisHash}`,
      "utf8",
    );
    const newMasterHash = Utils.toHex(Hash.sha256(link) as number[]);
    const ts = Date.now();
    this.sql.exec(
      `INSERT INTO pt_master_chain
         (sequence, conversation_id, conversation_genesis_hash, prev_master_hash, ts)
       VALUES (?, ?, ?, ?, ?)`,
      nextSeq,
      conversationId,
      conversationGenesisHash,
      head.prevHash,
      ts,
    );
    this.sql.exec(
      `UPDATE pt_state SET value = ? WHERE key = 'master_head'`,
      JSON.stringify({ sequence: nextSeq, prevHash: newMasterHash }),
    );
    return nextSeq;
  }

  /** List the master chain entries in append order. */
  listMasterChain(): MasterChainEntry[] {
    return this.sql
      .exec<{
        sequence: number;
        conversation_id: string;
        conversation_genesis_hash: string;
        prev_master_hash: string;
        ts: number;
      }>(
        `SELECT sequence, conversation_id, conversation_genesis_hash,
                prev_master_hash, ts
         FROM pt_master_chain ORDER BY sequence ASC`,
      )
      .toArray()
      .map((r) => ({
        sequence: r.sequence,
        conversationId: r.conversation_id,
        conversationGenesisHash: r.conversation_genesis_hash,
        prevMasterHash: r.prev_master_hash,
        ts: r.ts,
      }));
  }

  // ===== conversations =====

  /**
   * Create a new conversation: seeds its per-conversation genesis hash,
   * anchors it to the master chain, and returns the full record. Idempotent
   * by id — calling twice with the same id throws (use {@link getConversation}
   * first).
   */
  createConversation(args: { id: string; title: string }): ConversationRecord {
    const existing = this.getConversation(args.id);
    if (existing) {
      throw new Error(
        `createConversation: conversation '${args.id}' already exists`,
      );
    }
    const genesisInput = Utils.toArray(
      `${this.tenantId}::${this.agentId}::${args.id}::${CONVERSATION_GENESIS_PREFIX}`,
      "utf8",
    );
    const conversationGenesisHash = Utils.toHex(
      Hash.sha256(genesisInput) as number[],
    );
    const masterSeq = this.appendMaster(args.id, conversationGenesisHash);
    const now = Date.now();
    const chainHead: ChainHead = {
      sequence: 0,
      prevHash: conversationGenesisHash,
    };
    this.sql.exec(
      `INSERT INTO pt_conversations
         (id, title, chain_head_json, master_seq, created_at, last_active_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      args.id,
      args.title,
      JSON.stringify(chainHead),
      masterSeq,
      now,
      now,
    );
    return {
      id: args.id,
      title: args.title,
      chainHead,
      masterSeq,
      createdAt: now,
      lastActiveAt: now,
      status: "active",
    };
  }

  getConversation(id: string): ConversationRecord | null {
    const row = this.sql
      .exec<{
        id: string;
        title: string;
        chain_head_json: string;
        master_seq: number;
        created_at: number;
        last_active_at: number;
        status: string;
      }>(
        `SELECT id, title, chain_head_json, master_seq, created_at,
                last_active_at, status
         FROM pt_conversations WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      chainHead: JSON.parse(row.chain_head_json) as ChainHead,
      masterSeq: row.master_seq,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      status: row.status as "active" | "archived",
    };
  }

  listConversations(opts?: {
    status?: "active" | "archived" | "all";
  }): ConversationRecord[] {
    const status = opts?.status ?? "active";
    const where = status === "all" ? "" : "WHERE status = ?";
    const bindings = status === "all" ? [] : [status];
    return this.sql
      .exec<{
        id: string;
        title: string;
        chain_head_json: string;
        master_seq: number;
        created_at: number;
        last_active_at: number;
        status: string;
      }>(
        `SELECT id, title, chain_head_json, master_seq, created_at,
                last_active_at, status
         FROM pt_conversations
         ${where}
         ORDER BY last_active_at DESC`,
        ...bindings,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        title: r.title,
        chainHead: JSON.parse(r.chain_head_json) as ChainHead,
        masterSeq: r.master_seq,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
        status: r.status as "active" | "archived",
      }));
  }

  renameConversation(id: string, title: string): void {
    this.sql.exec(
      `UPDATE pt_conversations SET title = ?, last_active_at = ? WHERE id = ?`,
      title,
      Date.now(),
      id,
    );
  }

  archiveConversation(id: string): void {
    this.sql.exec(
      `UPDATE pt_conversations SET status = 'archived', last_active_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  /** Touch last_active_at; called by the broadcast pipeline on each commit. */
  touchConversation(id: string): void {
    this.sql.exec(
      `UPDATE pt_conversations SET last_active_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  // ===== per-conversation chain head =====

  getChainHead(conversationId: string): ChainHead {
    const conv = this.getConversation(conversationId);
    if (!conv) {
      throw new Error(
        `ProvenanceState.getChainHead(): conversation '${conversationId}' not found`,
      );
    }
    return conv.chainHead;
  }

  /**
   * Atomically reserve the next sequence number for this conversation. The
   * caller computes the new commit hash and then calls
   * {@link advanceChainHead}.
   */
  reserveNextSequence(conversationId: string): {
    sequence: number;
    prevHash: string;
  } {
    const head = this.getChainHead(conversationId);
    return { sequence: head.sequence + 1, prevHash: head.prevHash };
  }

  /** Persist the new chain head for a conversation after a successful commit. */
  advanceChainHead(
    conversationId: string,
    sequence: number,
    newCommitHash: string,
  ): void {
    const headJson = JSON.stringify({ sequence, prevHash: newCommitHash });
    this.sql.exec(
      `UPDATE pt_conversations
         SET chain_head_json = ?, last_active_at = ?
       WHERE id = ?`,
      headJson,
      Date.now(),
      conversationId,
    );
  }

  // ===== UTXOs =====

  listAvailableUtxos(): ProvenanceUtxo[] {
    return this.sql
      .exec<{
        tx_hash: string;
        tx_pos: number;
        value: number;
        raw_tx_hex: string;
        created_at: number;
      }>(
        `SELECT tx_hash, tx_pos, value, raw_tx_hex, created_at
         FROM pt_utxos WHERE status = 'available' ORDER BY value ASC`,
      )
      .toArray()
      .map((r) => ({
        txHash: r.tx_hash,
        txPos: r.tx_pos,
        value: r.value,
        rawTxHex: r.raw_tx_hex,
        createdAt: r.created_at,
      }));
  }

  totalAvailableSats(): number {
    // SUM always returns a single row (even when no UTXOs exist).
    const row = this.sql
      .exec<{ total: number | null }>(
        `SELECT COALESCE(SUM(value), 0) AS total FROM pt_utxos WHERE status = 'available'`,
      )
      .toArray()[0];
    return Number(row?.total ?? 0);
  }

  addUtxo(u: ProvenanceUtxo): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pt_utxos
         (tx_hash, tx_pos, value, raw_tx_hex, status, reservation_id, created_at, spent_at)
       VALUES (?, ?, ?, ?, 'available', NULL, ?, NULL)`,
      u.txHash,
      u.txPos,
      u.value,
      u.rawTxHex,
      u.createdAt,
    );
  }

  /**
   * Reserve the smallest UTXO that is at least `minSats`. Returns null if
   * no suitable UTXO exists (caller must handle insufficient funds).
   */
  reserveUtxo(minSats: number): UtxoReservation | null {
    const row = this.sql
      .exec<{
        tx_hash: string;
        tx_pos: number;
        value: number;
        raw_tx_hex: string;
        created_at: number;
      }>(
        `SELECT tx_hash, tx_pos, value, raw_tx_hex, created_at
         FROM pt_utxos
         WHERE status = 'available' AND value >= ?
         ORDER BY value ASC LIMIT 1`,
        minSats,
      )
      .toArray()[0];
    if (!row) return null;
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.sql.exec(
      `UPDATE pt_utxos SET status = 'reserved', reservation_id = ?
       WHERE tx_hash = ? AND tx_pos = ?`,
      reservationId,
      row.tx_hash,
      row.tx_pos,
    );
    return {
      utxo: {
        txHash: row.tx_hash,
        txPos: row.tx_pos,
        value: row.value,
        rawTxHex: row.raw_tx_hex,
        createdAt: row.created_at,
      },
      reservationId,
    };
  }

  /** Release a reservation back to available. Used on broadcast failure. */
  releaseReservation(reservationId: string): void {
    this.sql.exec(
      `UPDATE pt_utxos SET status = 'available', reservation_id = NULL
       WHERE reservation_id = ?`,
      reservationId,
    );
  }

  /** Mark a reserved UTXO as spent (after successful broadcast). */
  markSpent(reservationId: string): void {
    this.sql.exec(
      `UPDATE pt_utxos SET status = 'spent', spent_at = ?
       WHERE reservation_id = ?`,
      Date.now(),
      reservationId,
    );
  }

  /**
   * Demo recovery: wipe all chain state — commit journal, conversations,
   * master chain, grants — and re-seed `master_head` at genesis. Preserves
   * `pt_utxos` (the funded wallet) and `pt_state.identity_pub_hex` (cached
   * agent identity) so the agent keeps the same address + pubkey + funds.
   *
   * After this returns, the next call to `init()` will re-create the
   * package's "default" conversation (line 1086 of with-provenance.ts);
   * everything else starts fresh at sequence 0.
   *
   * Used by the demo's `/admin/reset-chain` to clean accumulated cold-boot
   * spam without rotating the wallet. Returns the number of rows wiped per
   * table, useful for the API response so the operator can verify.
   */
  purgeChainState(): {
    commits: number;
    conversations: number;
    masterChain: number;
    grants: number;
  } {
    const counts = {
      commits: 0,
      conversations: 0,
      masterChain: 0,
      grants: 0,
    };
    const commitsRow = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pt_commits`)
      .toArray()[0];
    counts.commits = Number(commitsRow?.n ?? 0);
    const convsRow = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pt_conversations`)
      .toArray()[0];
    counts.conversations = Number(convsRow?.n ?? 0);
    const masterRow = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pt_master_chain`)
      .toArray()[0];
    counts.masterChain = Number(masterRow?.n ?? 0);
    const grantsRow = this.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM pt_grants`)
      .toArray()[0];
    counts.grants = Number(grantsRow?.n ?? 0);

    this.sql.exec(`DELETE FROM pt_commits`);
    this.sql.exec(`DELETE FROM pt_conversations`);
    this.sql.exec(`DELETE FROM pt_master_chain`);
    this.sql.exec(`DELETE FROM pt_grants`);
    // Reset master_head to genesis. Same derivation as init().
    const masterGenesisInput = Utils.toArray(
      `${this.tenantId}::${this.agentId}::${MASTER_GENESIS_PREFIX}`,
      "utf8",
    );
    const masterGenesisHash = Utils.toHex(
      Hash.sha256(masterGenesisInput) as number[],
    );
    const headJson = JSON.stringify({
      sequence: 0,
      prevHash: masterGenesisHash,
    });
    this.sql.exec(
      `UPDATE pt_state SET value = ? WHERE key = 'master_head'`,
      headJson,
    );
    return counts;
  }

  /**
   * Demo recovery: mark every non-spent UTXO as spent. Used after an orphan
   * cascade poisons the funding pool with change UTXOs descended from a
   * non-propagating parent. After purge, caller must `topUp()` with a fresh
   * confirmed funding UTXO to keep broadcasting.
   *
   * Returns count of rows mutated.
   */
  purgeAvailableUtxos(): number {
    const rows = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM pt_utxos WHERE status IN ('available', 'reserved')`,
      )
      .toArray();
    const count = Number(rows[0]?.n ?? 0);
    if (count > 0) {
      this.sql.exec(
        `UPDATE pt_utxos SET status = 'spent', spent_at = ?, reservation_id = NULL
         WHERE status IN ('available', 'reserved')`,
        Date.now(),
      );
    }
    return count;
  }

  // ===== commitment journal =====

  recordCommit(args: {
    conversationId: string;
    sequence: number;
    hookKind: string;
    txid: string | null;
    commitHash: string;
    payloadHex: string;
    arcUrl?: string | null;
    txStatus?: string | null;
    elapsedMs?: number | null;
    error?: string | null;
  }): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO pt_commits
         (conversation_id, sequence, hook_kind, txid, commit_hash, payload_hex,
          arc_url, tx_status, elapsed_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args.conversationId,
      args.sequence,
      args.hookKind,
      args.txid,
      args.commitHash,
      args.payloadHex,
      args.arcUrl ?? null,
      args.txStatus ?? null,
      args.elapsedMs ?? null,
      args.error ?? null,
      Date.now(),
    );
  }

  // ===== selective-disclosure grants =====

  /**
   * Issue a new viewing-capability grant. The recipient (an auditor) can
   * then decrypt envelopes whose scope intersects the granted scope, using
   * their own identity priv key + this agent's identity pub key.
   */
  recordGrant(args: {
    id: string;
    recipientPubHex: string;
    scope: GrantScope;
    label?: string;
    validUntil?: number; // ms epoch
  }): void {
    this.sql.exec(
      `INSERT INTO pt_grants (id, recipient_pub_hex, scope_json, label, status, granted_at, valid_until)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args.id,
      args.recipientPubHex,
      JSON.stringify(args.scope),
      args.label ?? null,
      Date.now(),
      args.validUntil ?? null,
    );
  }

  revokeGrant(id: string): { revoked: boolean } {
    const before = this.sql
      .exec<{ status: string }>(
        `SELECT status FROM pt_grants WHERE id = ?`,
        id,
      )
      .toArray()[0];
    if (!before) return { revoked: false };
    if (before.status === "revoked") return { revoked: false };
    this.sql.exec(
      `UPDATE pt_grants SET status = 'revoked', revoked_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
    return { revoked: true };
  }

  /**
   * Return active grants. Caller intersects scope at envelope-sealing time
   * to decide which to include in the per-envelope recipient list.
   */
  listActiveGrants(): GrantRecord[] {
    const now = Date.now();
    return this.sql
      .exec<{
        id: string;
        recipient_pub_hex: string;
        scope_json: string;
        label: string | null;
        granted_at: number;
        valid_until: number | null;
      }>(
        `SELECT id, recipient_pub_hex, scope_json, label, granted_at, valid_until
         FROM pt_grants WHERE status = 'active'
           AND (valid_until IS NULL OR valid_until > ?)`,
        now,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        recipientPubHex: r.recipient_pub_hex,
        scope: JSON.parse(r.scope_json) as GrantScope,
        label: r.label ?? undefined,
        grantedAt: r.granted_at,
        validUntil: r.valid_until ?? undefined,
      }));
  }

  listAllGrants(): GrantRecord[] {
    return this.sql
      .exec<{
        id: string;
        recipient_pub_hex: string;
        scope_json: string;
        label: string | null;
        status: string;
        granted_at: number;
        revoked_at: number | null;
        valid_until: number | null;
      }>(
        `SELECT id, recipient_pub_hex, scope_json, label, status, granted_at, revoked_at, valid_until
         FROM pt_grants ORDER BY granted_at ASC`,
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        recipientPubHex: r.recipient_pub_hex,
        scope: JSON.parse(r.scope_json) as GrantScope,
        label: r.label ?? undefined,
        status: r.status as "active" | "revoked",
        grantedAt: r.granted_at,
        revokedAt: r.revoked_at ?? undefined,
        validUntil: r.valid_until ?? undefined,
      }));
  }

  // ===== identity (cached pubkey) =====

  /** Fetch and cache the agent's identity pubkey. Call once per worker boot. */
  async loadIdentityPubHex(wallet: ProtoWallet): Promise<string> {
    const cached = this.sql
      .exec<{ value: string }>(
        `SELECT value FROM pt_state WHERE key = 'identity_pub_hex'`,
      )
      .toArray()[0];
    if (cached) return cached.value;
    const idRes = await wallet.getPublicKey({ identityKey: true });
    this.sql.exec(
      `INSERT OR REPLACE INTO pt_state (key, value) VALUES ('identity_pub_hex', ?)`,
      idRes.publicKey,
    );
    return idRes.publicKey;
  }
}
