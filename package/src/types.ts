/**
 * Public types for `provable-think`.
 *
 * `ProvenanceConfig` is the single configuration object passed to
 * `withProvenance(BaseClass, config)`. It governs identity, storage,
 * commit policy, and broadcast behaviour.
 *
 * Every field is documented here so that `TECHNICAL.md` §3.1 and the
 * type signature stay in lockstep.
 */

import type { WalletProtocol } from "@bsv/sdk";

/**
 * Hook kinds we know how to commit. Maps to the byte enum in TECHNICAL.md §5.6.
 * The list deliberately mirrors the documented Project Think lifecycle hooks
 * (`packages/think/src/think.ts:802–942`) plus the durable-execution surface
 * (`packages/agents/src/index.ts:3139–3199`).
 */
export type HookKind =
  | "beforeTurn"
  | "beforeStep"
  | "beforeToolCall"
  | "afterToolCall"
  | "onStepFinish"
  | "onChunk"
  | "onChatResponse"
  | "onChatRecovery"
  | "getModel"
  | "fiberStart"
  | "stash"
  | "fiberRecovered"
  | "extensionAuthored"
  | "paymentBRC29"
  | "keyRotation"
  | "stepMerkleRoot"
  // v0.2 additions (2026-04-29):
  | "getTools"
  | "configureSession";

/**
 * Byte values for each hook kind in the OP_RETURN PRT1 wire format.
 * Reserved range 0x80–0xFE for extensions. 0xFF = step Merkle root.
 *
 * v0.2 added 0x10 (getTools) and 0x11 (configureSession) to round out
 * Project Think's surface. Prior allocations are stable.
 */
export const HOOK_KIND_BYTES: Record<HookKind, number> = {
  beforeTurn: 0x01,
  beforeStep: 0x02,
  beforeToolCall: 0x03,
  afterToolCall: 0x04,
  onStepFinish: 0x05,
  onChunk: 0x06,
  onChatResponse: 0x07,
  onChatRecovery: 0x08,
  getModel: 0x09,
  fiberStart: 0x0a,
  stash: 0x0b,
  fiberRecovered: 0x0c,
  extensionAuthored: 0x0d,
  paymentBRC29: 0x0e,
  keyRotation: 0x0f,
  getTools: 0x10,
  configureSession: 0x11,
  stepMerkleRoot: 0xff,
};

/** BRC-43 protocol IDs we use. Security level 2 = per-counterparty. */
export const PROVABLE_THINK_COMMIT_PROTOCOL: WalletProtocol = [
  2,
  "provable think commitment v1",
];

export interface ProvenanceConfig {
  /**
   * Agent identity keypair.
   *
   * Resolution order at runtime (first match wins):
   *   1. `identity.privateKeyHex` (static, set in code)
   *   2. `identity.envBinding` → `this.env[binding]` (runtime, recommended for prod)
   *   3. (v0.2) auto-derive from `this.ctx.id` + tenant salt, persisted in DO storage
   */
  identity?: {
    /** Static hex-encoded 32-byte private key. Discouraged for prod. */
    privateKeyHex?: string;
    /**
     * Worker env binding name to read the hex priv key from at runtime.
     * Default: `"AGENT_PRIVATE_KEY_HEX"`. Set the actual value via
     * `wrangler secret put AGENT_PRIVATE_KEY_HEX`.
     */
    envBinding?: string;
    mode?: "per-do" | "per-tenant";
    tenantId?: string;
    /** BRC-42 invoice-number prefix for derivations. */
    derivationContext?: string;
  };

  /** Wallet Worker (Calhooon/bsv-wallet-infra-cloudflare) endpoint. */
  walletInfra?: {
    /** e.g. https://wallet.acme.com or https://wallet-infra.x402agency.com (eval). */
    endpoint: string;
    /** Optional: pin the wallet Worker's identity pubkey for additional auth-key pinning. */
    expectedIdentityKey?: string;
  };

  /** Storage backend(s) for encrypted envelopes. R2 default; UHRP optional. */
  storage?: {
    primary: "r2" | "uhrp" | "do-sql";
    r2?: { binding: string; pathPrefix?: string };
    uhrp?: { endpoint: string; retentionMinutes: number };
  };

  /** Which hook kinds to commit. Defaults to all. */
  commit?: HookKind[];

  /** Encryption policy. */
  encryption?: {
    algorithm?: "aes-256-gcm";
    contextSize?: "step" | "hook";
  };

  /** Selective-disclosure defaults. */
  disclosure?: {
    rotationPolicy?: "monthly" | "quarterly" | "manual";
    defaultScopes?: string[];
    /**
     * Default recipients every envelope is sealed to. Each recipient receives
     * a content-key wrap they can decrypt. The default is a single "self"
     * grant so the agent itself can always decrypt its own past events. Add
     * additional recipients here (e.g. compliance officer pubkey) to seal
     * envelopes to multiple parties at create-time.
     */
    defaultRecipients?: Array<{
      id: string;
      counterparty: "self" | "anyone" | string;
      scope?: {
        tags?: string[];
        hookKinds?: HookKind[];
        fromIso?: string;
        toIso?: string;
        agentIds?: string[];
      };
    }>;
    /**
     * Public HTTPS base URL where verifiers can fetch encrypted envelopes
     * (typically your agent Worker's `/envelope` endpoint). Stamped into
     * each issued ViewingCapability so auditors don't need separate wiring.
     * Example: "https://acme-agent.example.com"
     */
    envelopeServerUrl?: string;

    /**
     * Optional pre-seal redaction. When `enabled` and `transform` are both
     * set, every payload is rewritten by the transform before it's
     * canonicalized + hashed for the on-chain commitment + sealed into the
     * envelope. Used by `HIPAA_PRESET` to wire Safe-Harbor inferred-PHI
     * redaction; operators with their own DLP can disable by setting
     * `redaction: { enabled: false }`.
     */
    redaction?: {
      enabled?: boolean;
      transform?: (payload: unknown, hookKind: HookKind) => unknown;
    };
  };

  /** On-chain anchor settings. */
  anchor?: {
    network?: "mainnet" | "testnet";
    /** Comma-separated ARC URLs (raced in parallel). Default: GorillaPool + TaaL. */
    arcUrls?: string[];
    /** TaaL-only API key. Auth header is only sent to TaaL endpoints. */
    taalApiKey?: string;
    /** Sat/kb fee rate. TaaL standard = 100. */
    feeSatsPerKb?: number;
    /** Fire and forget vs block on commitment ack. Default true. */
    asyncCommit?: boolean;
  };

  /** Logging hooks. */
  onCommit?: (event: CommitEvent) => void | Promise<void>;
  onCommitError?: (event: CommitErrorEvent) => void | Promise<void>;
}

/** Reported via `onCommit` after each successful chain anchor. */
export interface CommitEvent {
  /** Conversation this commit belongs to (per-conversation chain). */
  conversationId: string;
  hookKind: HookKind;
  /** Per-conversation sequence number. Starts at 1 within each conversation. */
  sequence: number;
  txid: string;
  txStatus?: string;
  payloadLen: number;
  inputSats: number;
  changeSats: number;
  feeSats: number;
  arcUrl: string;
  elapsedMs: number;
  /**
   * Scope tags this commit was sealed under (mirrors the envelope header's
   * scopeTags). Single source of truth so the broadcaster doesn't have to
   * re-derive from per-call state. Empty array when no scope is configured.
   */
  scopeTags: string[];
}

/** Reported via `onCommitError` for any commitment that failed to anchor. */
export interface CommitErrorEvent {
  conversationId: string;
  hookKind: HookKind;
  sequence: number;
  error: string;
  arcAttempts?: Array<{
    url: string;
    txStatus?: string;
    error?: string;
  }>;
}
