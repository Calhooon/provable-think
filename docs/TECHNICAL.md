# `provable-think` — Technical Specification

**Status:** Draft v0.4 (2026-04-28 — post-Phase-2.4b)
**Audience:** Engineers integrating with Cloudflare's Agent SDK / Project Think.
**Companion docs:** [`THREAT-MODEL.md`](./THREAT-MODEL.md) (STRIDE matrices), [`SECURITY.md`](./SECURITY.md) (vulnerability disclosure).
**Implementation language:** TypeScript only (agent Worker). Sibling UHRP Worker is Rust→WASM.

**v0.4 architecture (current alpha — what we shipped):** **One** open-source Cloudflare Worker (`provable-think`, this package). Holds its own per-DO funding wallet in DO SQLite; builds + signs OP_RETURN commitments locally; broadcasts via a multi-ARC race (`arc.gorillapool.io` + `api.taal.com/arc`) with `X-WaitFor: SEEN_ON_NETWORK`. Encrypted envelopes live in **Cloudflare R2** (default) or — when the operator opts in — in [`Calhooon/bsv-storage-cloudflare`](https://github.com/Calhooon/bsv-storage-cloudflare) (self-hosted UHRP, content-addressed, multi-host; live at `https://bsv-storage-cloudflare.dev-a3e.workers.dev` with public reads at `https://pub-0c965344954142909622d4c2aed91f87.r2.dev`).

**v3.0 architecture (future target):** the funding wallet splits out into [`Calhooon/bsv-wallet-infra-cloudflare`](https://github.com/Calhooon/bsv-wallet-infra-cloudflare), a separate Rust→WASM CF Worker. Same `provable-think` agent, but `createAction`/`processAction` route over JSON-RPC to the wallet Worker — separating funding-wallet keys from agent-identity keys for defense-in-depth. Wire-compatible drop-in for `storage.babbage.systems`. Eval instance at `wallet-infra.x402agency.com`.

**What changed since v0.3:** v0.3 specified a full Path D architecture with the wallet Worker as the broadcast path. We pivoted during build (`bsv-wallet-infra-cloudflare` is alpha with three known production bugs blocking v0.1 dependence on it) and shipped a self-funded agent-Worker design instead. UHRP storage was promoted from "optional NanoStore" to a first-class option backed by the user's own `bsv-storage-cloudflare`. Wire format moved from 138-byte fixed CBOR to ~145–148-byte variable DER + JSON envelope. Cost is ~10× lower than v0.3 estimated (~36 sats/commit, not ~390). All Phase 1, 2.1, 2.2, 2.3, 2.4, 2.4b gates verified end-to-end on BSV mainnet; see §13 Verification Ledger for txids.

---

## 1. What `provable-think` is

`provable-think` is a higher-order class wrapper for [`@cloudflare/think`](https://blog.cloudflare.com/project-think/) agents. It instruments every documented Project Think lifecycle hook — `beforeTurn`, `beforeStep`, `beforeToolCall`, `afterToolCall`, `onStepFinish`, `onChunk`, `onChatResponse`, `onChatRecovery`, fiber checkpoints, and self-authored extension authoring — and emits a cryptographically signed, hash-chained, optionally encrypted commitment of each event to the BSV blockchain.

The on-chain artifact is small (~145–148 bytes per commitment; ~36 sats per commit at TaaL's standard 100 sats/kb fee rate). The full transcript is encrypted under per-event AES-256-GCM keys and stored off-chain — **Cloudflare R2 by default, or [`Calhooon/bsv-storage-cloudflare`](https://github.com/Calhooon/bsv-storage-cloudflare) for content-addressed multi-host UHRP** (the user's self-hosted Rust→WASM CF Worker, protocol-compatible with `nanostore.babbage.systems`). Decryption is gated by **selectively-disclosed viewing keys** issued by the agent operator to specific auditors and scoped by date range, tag, agent ID, or hook kind.

The chain anchors **immutability**. The keys gate **disclosure**. Together: a tamper-evident, third-party-verifiable, regulator-friendly audit trail for autonomous AI agents — without leaking proprietary content to anyone who isn't authorized.

This document specifies the wire formats, cryptographic constructions, API surface, performance characteristics, and threat model. Every claim about Project Think's surface is anchored on `~/bsv/cf-agents` source as of 2026-04-28.

---

## 1.5 Protocol alignment

`provable-think` composes existing BSV standards rather than inventing new ones. The wire formats and cryptographic constructions in this document map directly onto canonical BRC specifications:

| Concern | BRC | What it provides | TS reference |
|---|---|---|---|
| Mutual authentication (agent ↔ verifier, agent ↔ tool) | **BRC-103** + **BRC-104** | Peer-to-peer mutual auth; HTTP transport (`/.well-known/auth`, `x-bsv-auth-*` headers, signed payloads). Supersedes BRC-31 (Authrite). | `@bsv/sdk` `AuthFetch` (`/src/auth/clients/AuthFetch.ts`) |
| Key derivation (identity, content keys, viewing keys) | **BRC-42** + **BRC-43** | ECDH-based child-key derivation with invoice-number protocol IDs (`<level>-<protocolID>-<keyID>`). | `@bsv/sdk` `PrivateKey.deriveChild()`, `deriveSharedSecret()` |
| Hash-chained event sequencing | **BRC-60** (semantics) | State-machine event chain — incremental sequence number + hash-of-prev-event. We deviate from BRC-60's "single non-final transaction" mechanism by anchoring **each event in its own transaction** for forensic granularity per event. The hash-chain semantics are identical. | (we implement; rust-bsv-worm `onchain/proofs.rs` is a behavioral reference) |
| Encrypted envelopes (per-recipient content-key wrapping) | **BRC-78** | Portable encrypted messages — AES-256-GCM with sender ID + recipient ID + key ID + ciphertext + IV. We use BRC-78 to wrap per-step content keys for each authorized auditor. | `@bsv/sdk` `SymmetricKey` / `AESGCM`; envelope assembly is straight binary serialization per BRC-78 §3 |
| Plaintext encryption | Raw AES-256-GCM with header-bound AAD (the same primitive BRC-78 uses internally) | Encrypts the actual hook payload; BRC-78 wraps the *key* to that payload, not the plaintext, to keep multi-recipient overhead small. | `@bsv/sdk` `AESGCM` |
| Off-tx message signing (audit manifests, viewing capabilities) | **BRC-77** | Canonical signature serialization (`0x42423301` magic + signer ID + verifier ID + key ID + DER signature). | `@bsv/sdk` ECDSA + Writer |
| Wallet — crypto subset | **BRC-100** | `getPublicKey`, `createSignature`, `verifySignature`, `encrypt`, `decrypt`, `createHmac`, `verifyHmac`, key-linkage reveal. Done **in-Worker** in the agent Worker. | `@bsv/sdk` `ProtoWallet` (constructor takes a `PrivateKey`; pure TS, runs in CF Workers) |
| Wallet — transaction surface (v0.1) | **BRC-100** subset | `createAction` for BRC-29 P2PKH payments to satisfy AuthFetch's BRC-105 402 retry contract. The agent Worker has its own per-DO funding-UTXO pool (DO SQLite); `createAction` is implemented in `package/src/wallet.ts` via the rich-wallet `paymentSupport` option (`makeMinimalWallet(wallet, paymentSupport)`). OP_RETURN commitments use the parallel `runCommitPipeline` path, also in-Worker. | `package/src/{wallet.ts, broadcast-pipeline.ts}` — agent-internal, no external service dep |
| Wallet — transaction surface (v3.0 target) | **BRC-100** full | `createAction`, `signAction`, `processAction`, `internalizeAction`, `listOutputs`, `listActions`, `getBalance`, `abortAction` — all delegated to [`Calhooon/bsv-wallet-infra-cloudflare`](https://github.com/Calhooon/bsv-wallet-infra-cloudflare) over HTTPS JSON-RPC 2.0 with BRC-103/104 mutual auth. Funding-wallet keys segregate from agent-identity keys (defense in depth). | `@bsv/wallet-toolbox` `StorageClient` (TS) → wallet Worker (Rust→WASM, drop-in `storage.babbage.systems` replacement). v3.0 cutover requires the wallet Worker's three known alpha bugs to clear (SQLITE_TOOBIG on BEEF compaction, WoC rate-limit hits, orphan-tx starvation). |
| 402 micropayment | **BRC-29** + **BRC-105** | BRC-29 is the BSV P2PKH payment with derivation prefix/suffix; BRC-105 is the HTTP service monetization framework (BSV's x402 analog). | `@bsv/sdk` `AuthFetch` handles 402 retry automatically |
| Identity certificates (optional) | **BRC-52** | Identity certificates with selective field disclosure and UTXO-based revocation. Available if tenants want to bind agent identity keys to externally-issued certs. | `@bsv/sdk` `/src/auth/certificate/` |

This alignment is intentional: each BRC has reference TS implementations and a community of verifiers. Composing them gives us free interoperability and avoids the "yet another BSV format" critique.

---

## 2. Architecture

### 2.1 v0.4 (current — what we shipped)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  User code (inside the Cloudflare Durable Object):                      │
│    class MyAgent extends withProvenance(Think<Env>, config) {}          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Agent Worker — `provable-think` (pure TS, runs in the DO)              │
│                                                                         │
│  DO SQLite holds: per-DO agent identity priv (from AGENT_PRIVATE_KEY_HEX│
│  env binding); funding UTXO pool (pt_utxos); chain head (pt_state);     │
│  commit journal (pt_commits); selective-disclosure grants (pt_grants).  │
│  ProtoWallet wraps the priv key for BRC-100 crypto.                     │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Hook interceptor (beforeTurn, beforeStep, beforeToolCall,         │  │
│  │   afterToolCall, onStepFinish, onChunk, onChatResponse,           │  │
│  │   onChatRecovery, onFiberRecovered)                               │  │
│  │   ↓                                                               │  │
│  │ Canonical-JSON serialize hook payload                             │  │
│  │   → seal envelope: random per-event AES-256-GCM content key,      │  │
│  │       AAD-bound JSON header, wrap content key to N recipients     │  │
│  │       via ProtoWallet.encrypt (BRC-2 / BRC-42 ECDH)               │  │
│  │   ↓                                                               │  │
│  │ Build PRT1 OP_RETURN: magic + hookKind + sequence + plaintext     │  │
│  │   hash + derived pubkey + DER signature                           │  │
│  │   → reserve UTXO from pt_utxos                                    │  │
│  │   → build tx, sign locally, multi-ARC race                        │  │
│  │      (GorillaPool + TaaL, X-WaitFor: SEEN_ON_NETWORK, 30s cap)    │  │
│  │   → on success: mark UTXO spent, register change UTXO, advance    │  │
│  │      chain head, write envelope to R2 (or UHRP)                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
       │                            │                            │
       ▼                            ▼                            ▼
┌──────────────────┐   ┌──────────────────────┐   ┌────────────────────┐
│ Cloudflare R2    │   │ bsv-storage-cloud-   │   │ BSV mainnet via    │
│ (default,        │   │ flare (UHRP, opt-in) │   │ multi-ARC race:    │
│ envelope JSON)   │   │ • POST /upload       │   │ • arc.gorillapool  │
│ {prefix}/{tenant}│   │   (BRC-103/104 +     │   │   .io (open)       │
│ /{agent-short}/  │   │   BRC-105 402 paid;  │   │ • api.taal.com/arc │
│ {YYYY-MM}/       │   │   1000 sats current) │   │   (Bearer auth)    │
│ {seq:0-padded}.  │   │ • PUT to presigned   │   │ Returns when ANY   │
│ env.json         │   │   R2 URL             │   │ ARC reports        │
│                  │   │ • GET /find?uhrpUrl  │   │ SEEN_ON_NETWORK    │
│                  │   │   = uhrp://<hash>    │   │ (or worst case     │
│                  │   │ • Public read at     │   │ ANNOUNCED + retry) │
│                  │   │   pub-*.r2.dev/cdn/  │   │                    │
└──────────────────┘   └──────────────────────┘   └────────────────────┘
                                                            │
                                                            ▼
                                                  Project Think DO
                                                  (Cloudflare runtime;
                                                   the agent's host)
```

**Three external surfaces, four trust dependencies.** The agent Worker holds *both* the per-agent identity keys *and* the funding-wallet keys — both derived from the same `AGENT_PRIVATE_KEY_HEX` env binding. v0.1 trust dependencies: (1) your Cloudflare runtime; (2) R2 (or `bsv-storage-cloudflare`) for ciphertext durability; (3) ARC providers (GorillaPool + TaaL) for tx propagation; (4) BSV consensus for immutability. **No third party touches your audit trail when you self-host R2 + UHRP.**

The wrapper preserves the full `Think<Env>` surface (every hook the user overrides still works). Provenance is additive: it never blocks or alters agent decisions. By default, commitments are emitted asynchronously with `ctx.waitUntil()` so they don't add latency to the agent's execution path. A `commitSync(hookKind, payload)` method is also available for tests and for cases where the operator wants to know the txid before responding.

### 2.2 v3.0 (future — split funding into a separate Worker)

Same agent Worker, but `createAction`/`processAction` calls go over HTTPS+JSON-RPC to a separate `bsv-wallet-infra-cloudflare` Worker. Agent-identity keys stay in the agent Worker; funding-wallet keys move to the wallet Worker. Defense in depth: a compromise of one Worker doesn't expose both key classes. Wire-compatible drop-in for `storage.babbage.systems`, so audit-tooling that's already wired against Babbage continues to work via URL swap. Eval instance running today at `wallet-infra.x402agency.com`; v3.0 cutover blocked on three known alpha bugs in the wallet Worker (SQLITE_TOOBIG on BEEF compaction, WoC rate-limit hits, orphan-tx starvation).

---

## 3. The `withProvenance()` API

### 3.1 Type signature

The actual shipped shape from `package/src/types.ts` (every field below is consumed by code paths in `package/src/with-provenance.ts` or `package/src/broadcast-pipeline.ts`):

```typescript
import type { WalletProtocol } from "@bsv/sdk";

export type HookKind =
  | "beforeTurn" | "beforeStep" | "beforeToolCall" | "afterToolCall"
  | "onStepFinish" | "onChunk" | "onChatResponse" | "onChatRecovery"
  | "getModel" | "fiberStart" | "stash" | "fiberRecovered"
  | "extensionAuthored" | "paymentBRC29" | "keyRotation" | "stepMerkleRoot";

export interface ProvenanceConfig {
  /**
   * Agent identity keypair. Resolution order at runtime:
   *   1. identity.privateKeyHex (static, set in code) — discouraged for prod
   *   2. identity.envBinding → this.env[binding] (recommended; default
   *      "AGENT_PRIVATE_KEY_HEX" — set via `wrangler secret put`)
   *   3. (v0.2 future) auto-derive from this.ctx.id + tenant salt
   */
  identity?: {
    privateKeyHex?: string;
    envBinding?: string;                // default "AGENT_PRIVATE_KEY_HEX"
    mode?: "per-do" | "per-tenant";     // v0.1 ignores; per-do effective
    tenantId?: string;
    derivationContext?: string;         // BRC-43 invoiceNumber prefix
  };

  /**
   * Wallet Worker (Calhooon/bsv-wallet-infra-cloudflare) endpoint.
   * v0.1: defined here for forward-compat but NOT consumed — the agent
   * Worker self-funds. v3.0: createAction routes here over JSON-RPC.
   */
  walletInfra?: {
    endpoint: string;
    expectedIdentityKey?: string;
  };

  /** Encrypted-envelope storage. R2 default. */
  storage?: {
    primary: "r2" | "uhrp" | "do-sql";
    r2?: { binding: string; pathPrefix?: string };          // CF R2 binding name
    uhrp?: { endpoint: string; retentionMinutes: number };  // see §6.2
  };

  /** Which hook kinds to commit. Default: all. */
  commit?: HookKind[];

  /** Encryption policy. AES-256-GCM only in v0.1. */
  encryption?: {
    algorithm?: "aes-256-gcm";
    contextSize?: "step" | "hook";        // v0.1 ignores; per-event keys (§5.2)
  };

  /** Selective-disclosure defaults. */
  disclosure?: {
    rotationPolicy?: "monthly" | "quarterly" | "manual";
    defaultScopes?: string[];

    /**
     * Recipients every envelope is sealed to at create-time. Default is
     * a single "self" grant (agent can decrypt its own past events).
     * Add additional fixed recipients (compliance officer, etc.) here;
     * runtime grantViewingKey() adds time-bounded scoped recipients on top.
     */
    defaultRecipients?: Array<{
      id: string;
      counterparty: "self" | "anyone" | string;             // recipient pub hex
      scope?: { tags?: string[]; hookKinds?: HookKind[];
                fromIso?: string; toIso?: string; agentIds?: string[]; };
    }>;

    /**
     * Public HTTPS base URL where verifiers fetch /commit-info + /envelope.
     * Stamped into every issued ViewingCapability so auditors don't need
     * separate wiring. Example: "https://acme-agent.example.com"
     */
    envelopeServerUrl?: string;
  };

  /** On-chain anchor settings. */
  anchor?: {
    network?: "mainnet" | "testnet";
    /** ARCs raced in parallel (§11.7). Default: GorillaPool + TaaL. */
    arcUrls?: string[];
    /** TaaL-only API key (sent only on TaaL endpoints). */
    taalApiKey?: string;
    /** Sat/kb fee rate. Default 100 (the canonical TaaL/GorillaPool floor). */
    feeSatsPerKb?: number;
    /** Fire-and-forget vs block on commitment ack. Default true. */
    asyncCommit?: boolean;
  };

  /** Logging hooks. */
  onCommit?: (event: CommitEvent) => void | Promise<void>;
  onCommitError?: (event: CommitErrorEvent) => void | Promise<void>;
}

export function withProvenance<TBase extends new (...args: any[]) => any>(
  Base: TBase,
  config: ProvenanceConfig,
): TBase;
```

The HOC accepts any constructor (the type relaxes from `Think<Env>` to `new (...args: any[]) => any` because the DurableObject base class has a complex generic signature that isn't worth strong-typing for v0.1; the relaxation is internal to the package and doesn't affect downstream agent code, which still extends `Think<Env>` directly).

### 3.2 Minimum viable usage

```typescript
import { Think } from "@cloudflare/think";
import { withProvenance } from "provable-think";

export class ComplianceAgent extends withProvenance(Think<Env>, {
  identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },        // wrangler secret
  storage:  { primary: "r2", r2: { binding: "PROVENANCE_BUCKET" } },
  anchor:   { network: "mainnet" },
  disclosure: {
    envelopeServerUrl: "https://acme-agent.example.com",    // your worker's public URL
  },
}) {
  // your agent code unchanged
}
```

Wrangler config:

```jsonc
{
  "name": "acme-agent",
  "main": "src/index.ts",
  "durable_objects": {
    "bindings": [{ "name": "AGENT", "class_name": "ComplianceAgent" }]
  },
  "r2_buckets": [
    { "binding": "PROVENANCE_BUCKET", "bucket_name": "acme-agent-provenance" }
  ]
}
```

Plus `wrangler secret put AGENT_PRIVATE_KEY_HEX` (32-byte hex; generate with `bsv-cli`, `openssl rand -hex 32` + ECDSA-validate, or any BSV wallet's "export priv key" path). Fund the agent's address with a small UTXO via the `topUp()` method or by sending P2PKH directly to the agent's funding address.

That's it. Every hook fires a commitment. The agent Worker self-funds chain commits from its DO-SQLite UTXO pool; rich-wallet `createAction` is available via `agent.getAuthFetch()` for downstream BRC-105 paid endpoints (UHRP upload, future paid tools).

### 3.3 Operator-side runtime API

The HOC exposes a `ProvenanceAgentAPI` interface on the agent instance (`package/src/with-provenance.ts:ProvenanceAgentAPI`):

```typescript
// Funding + identity inspection
agent.getFundingAddress():      Promise<string>;          // P2PKH address derived from AGENT_PRIVATE_KEY_HEX
agent.getIdentityPublicKey():   Promise<string>;          // 33-byte compressed pub hex
agent.getFundingBalance():      Promise<{ confirmed: number; unconfirmed: number; utxos: number }>;

// Funding ops
agent.topUp(args: { txid: string; vout: number; satoshis: number; lockingScriptHex: string }): Promise<void>;
agent.syncFromMainnet():        Promise<{ scanned: number; added: number; kept: number }>;

// Committing (programmatic; hook-driven commits don't need this)
agent.commitSync(hookKind: HookKind, payload: number[]): Promise<CommitOutcome>;

// Selective disclosure
agent.grantViewingKey(args: {
  recipientPubHex: string;                                // 33-byte compressed pub
  scope?: { tags?, hookKinds?, fromIso?, toIso?, agentIds? };
  validUntil?: number;                                    // unix ms
}): Promise<ViewingCapability>;
agent.revokeViewingKey(id: string):    Promise<void>;
agent.listViewingKeys():               Promise<ViewingCapability[]>;
agent.exportAuditManifest():           Promise<AuditManifest>;

// Outbound paid HTTP (BRC-103/104 + BRC-105)
agent.getAuthFetch():                  Promise<AuthFetch>;  // for tools that need 402-retry
```

A `ViewingCapability` is the serializable bundle the operator hands to the auditor (out-of-band: PGP'd email, secure portal, signed Slack DM). It contains `id`, `recipientPubHex`, `agentIdentityPubHex`, `scope`, `validUntil`, and `envelopeServerUrl` so the verifier CLI works against any operator without per-deployment wiring. The capability itself does NOT contain the auditor's priv key — the auditor holds that locally and never gives it to the operator.

#### Scope-tag vocabularies (HIPAA)

The `scope.tags` field accepts arbitrary strings, but for HIPAA-deploying operators `provable-think` ships a fixed canonical vocabulary that maps directly onto 45 CFR use-and-disclosure categories: `PHI`, `treatment`, `payment`, `operations`, `de-identified`, `marketing`, `research`, `limited-data-set`. Each tag is grounded in a specific 45 CFR citation so a compliance officer can issue a `ViewingCapability` whose scope language is identical to the language a HIPAA auditor already uses. The full taxonomy is exported from `package/src/presets/hipaa.ts`. The taxonomy is exported as `HIPAA_SCOPE_TAGS` from `package/src/presets/hipaa.ts` so operator code can reference tags by symbol rather than risking string-literal typos. The `hipaa.*` prefix is reserved for future preset-internal tags.

`exportAuditManifest()` returns the full list of granted/revoked/active capabilities for compliance reporting (HIPAA 45 CFR 164.312(b) audit playbook material in Phase 2.5).

`rotateIdentity()` is on the v0.5 roadmap, not in v0.1. v0.1's revocation is forward-only via `revokeViewingKey()`.

### 3.4 Auditor-side CLI

The standalone `provable-think-verify` binary (`package/cli/src/cli.ts`). Verbatim output from a real Phase 2.4 mainnet run (txid abbreviated):

```
$ provable-think-verify --txid ea0d9f71ebf0080b64f15a2a41abc7e5416684f809165403b0d9ddf52ee074da \
                        --capability ./auditor-cap.json

OK    read capability — id=auditor-alice recipient=02ab12cd34ef5678…
OK    capability validity
OK    envelope server URL — https://acme-agent.example.com
OK    fetch tx from WhatsOnChain — 350 bytes
OK    parse PRT1 payload — seq=4 hookKind=0x03 commitHash=8f3a1e7b29c4d05f…
OK    fetch commit-info from operator — seq=4 envelopeKey=provable-think-e2e/default/02b22aed1ca8fdf4/2026-04/000000000004.env.json
OK    chain commit hash matches operator record
OK    agent identity pubkey matches capability
OK    fetch envelope — 2 recipients
OK    decrypt envelope as auditor — 187 bytes plaintext
OK    verify plaintext hash matches on-chain commitment — 8f3a1e7b29c4d05f…

=== INTEGRITY OK — txid ea0d9f71ebf0080b64f15a2a41abc7e5416684f809165403b0d9ddf52ee074da ===
agent identity: 02b22aed1ca8fdf486c948b6acb8c7fe6821c3b8310e9e544f424dc88247fe3f66
sequence:       4
hook kind:      beforeToolCall
committed at:   2026-04-28T17:42:09.331Z
commit hash:    8f3a1e7b29c4d05f…

PLAINTEXT:
{"hookKind":"beforeToolCall","ts":"2026-04-28T17:42:09.331Z","payload":{"tool":"clinical_lookup","args":{"patient_dx":"E11.9","query":"first-line therapy"}}}
```

For CI / programmatic use, `--json` emits a single object on stdout with `{ ok, txid, steps, envelopeKey, plaintext, plaintextHash, header }`.

Failure modes (from §7): wrong recipient identity → step 10 AEAD failure; tampered ciphertext → step 10 AEAD failure; envelope swap → step 11 plaintext-hash mismatch; capability for the wrong agent → step 8 identity mismatch; operator drift → step 7 commit-hash mismatch.

---

## 4. Hook → commitment mapping

Every signature below is verified against `~/bsv/cf-agents/packages/think/src/think.ts` (recon 2026-04-28, package version 0.4.1) and `~/bsv/cf-agents/packages/agents/src/index.ts` (package version 0.11.6). Line numbers are point-in-time.

| Hook | v0.1 Status | Source | Captured payload | Why it matters |
|---|---|---|---|---|
| `getModel()` | ⏳ v0.2 | `think.ts:733–735` | model name + provider + temperature + system prompt hash | Defends against silent model swap. *Which* brain decided. |
| `getTools()` | ⏳ v0.2 | `think.ts:746–748` | tool names + JSON-schema hash per tool | Anchors the agent's capability surface at decision time. |
| `configureSession(session)` | ⏳ v0.2 | `think.ts:766–768` | session ID + parent ID (if forked) + tags | Anchors session identity and lineage on forks. |
| `beforeTurn(ctx: TurnContext)` | ✓ v0.1 | `think.ts:802–804` | input message hash + context-block hashes + parent step hash | Anchors *what the agent saw* before responding. Defends against prompt-injection forensics ("agent saw X but I claim it saw Y"). |
| `beforeStep(ctx: PrepareStepContext)` | ✓ v0.1 | `think.ts:839–841` | model+tools snapshot, step plan if returned | Per-step plan anchor — the "what I'm about to attempt." |
| `beforeToolCall(ctx: ToolCallContext)` | ✓ v0.1 | `think.ts:890–892` | tool name + args hash + decision (allow/deny/transform) | Anchors *intent* before any external side effect. |
| `afterToolCall(ctx: ToolCallResultContext)` | ✓ v0.1 | `think.ts:917` | tool name + result hash + duration + error if any | Anchors *what came back*. Defends against doctored API responses. |
| `onStepFinish(ctx: StepContext)` | ✓ v0.1 | `think.ts:923` | Merkle root over all hooks fired this step | One canonical anchor per step; gap detection unit. |
| `onChunk(ctx: ChunkContext)` | ✓ v0.1 (opt-in) | `think.ts:930` | (sampled) chunk index + text hash | Optional — high-rate. Off by default; enable via `commit: ["onChunk", …]`. Useful for stream-evidence cases. |
| `onChatResponse(result: ChatResponseResult)` | ✓ v0.1 | `think.ts:942` | final response hash + finish reason + token usage | Anchors *the decision the user/customer received*. Critical for non-repudiation. |
| `onChatRecovery(ctx: ChatRecoveryContext)` | ✓ v0.1 | `think.ts:2790–2793` | recovery cause + restored prefix hash + new strategy | Anchors stream-recovery transitions. Defends against "the recovered turn isn't what was originally answered." |
| `runFiber()` start | ⏳ v0.2 | `agents/index.ts:3139` | fiber name + initial args hash | Anchors durable-execution start. |
| `stash(data)` | ⏳ v0.2 | `agents/index.ts:3176` | stash hash + sequence within fiber | Anchors checkpoints inside a fiber. The agent's "memory" between hibernations. |
| `onFiberRecovered(ctx)` | ✓ v0.1 | `agents/index.ts:3193` | original fiber id + last stash hash + recovery reason | Anchors hibernation→wake transitions. Defends against state corruption during recovery. |
| Extension authoring (via `ExtensionManager`) | ⏳ v0.2 | `think.ts:954–1027` | extension source SHA-256 + manifest hash + declared permissions | **Killer hook.** When the agent writes its own TypeScript at runtime, the source + permissions are committed *before* execution. |
| 402 retry (BRC-29 / BRC-105 payment within `beforeToolCall`) | ✓ v0.1 (commit kind 0x0E) | implementation-defined | payment txid + amount + recipient pubkey | Anchors what the agent paid for and why. BRC-105 is BSV's HTTP service monetization framework (the x402 analog); BRC-29 is the underlying P2PKH payment with derivation prefix/suffix. Coexists with Cloudflare's `agents/x402` (EVM); selectable per tool. |

v0.1 covers the 9 *runtime* hooks where the agent is actually doing work. The decision-anchoring hooks (`getModel`/`getTools`/`configureSession`) and the durable-execution start hooks (`runFiber`/`stash`) are wire-format-reserved (HOOK_KIND_BYTES enum has slots for them) but not yet intercepted. v0.2 will round-trip those for full lifecycle coverage. `extensionAuthored` is the highest-leverage v0.2 add — it's the cryptographic anchor for self-authored TypeScript runtime code (§11.5).

Hooks not on this list (e.g., `getSystemPrompt`) are read-only and don't carry per-event state.

### 4.1 What "captured payload" means

Each captured payload is a structured object we serialize canonically (deterministic JSON: keys sorted, no whitespace, UTF-8) before hashing. The full plaintext goes into the off-chain envelope; only the hash of the canonical serialization goes on-chain. Sensitive fields (PII, raw model outputs, tool arguments) live in the encrypted envelope and reach the chain only as a 32-byte commitment.

---

## 5. Cryptographic constructions

### 5.1 Identity hierarchy

**v0.1 (current — flat).** The env binding `AGENT_PRIVATE_KEY_HEX` is the per-agent identity priv key directly (`A_id`). There is no tenant master and no BRC-42 chain to derive `A_id` from. Per-event signing and per-recipient key wrapping all derive *off* `A_id` using BRC-42:

```
AGENT_PRIVATE_KEY_HEX        ← env var or wrangler secret
   │
   = A_id (per-agent identity priv)
       │
       ├─ BRC-42(A_id, [2,"provable think commitment v1"], keyID=str(seq))
       │     ↳ per-event signing pubkey (33 bytes, compressed)  → embedded in OP_RETURN
       │
       └─ ProtoWallet.encrypt({ counterparty: recipient_pub })   ← BRC-2 → BRC-42 ECDH internally
             ↳ per-recipient wrap of the random AES-256 content key
```

The agent's identity public key (`A_id_pub`) — which the verifier reconstructs the per-event derivations from — is the cryptographic answer to *"who did this?"*. Unlike a Cloudflare account ID, it's verifiable by anyone holding a chain anchor.

**v0.2+ (target — hierarchical).** A future `identity.mode = "per-tenant"` configuration will let an operator hold a tenant master priv `M` and derive `A_id = BRC-42(M, agent_id)`, so all agents in a tenant are provably linked. v0.1 ships flat because adding a layer that no current code path consumes would be premature complexity.

### 5.2 Per-event content keys

```
contentKey = Random(32)        // fresh AES-256 key per envelope, not derived
```

Every sealed envelope gets a freshly-generated random 32-byte AES-256 key (`package/src/envelope.ts:130`). Content keys are NOT derived from the agent identity — they are pure entropy, used once, then wrapped per-recipient and discarded.

This is a deliberate departure from the HKDF-derived design in earlier drafts. Random per-event keys give:

- **Forward secrecy on accidental key compromise.** A leaked content key reveals exactly one envelope, never others.
- **No re-derivation requirement.** The agent doesn't have to remember how to re-derive each historical content key — recipients hold their wrapped copy.
- **Simpler verifier story.** Audit-time decryption requires only the recipient's identity priv key + the wrapped key from the envelope. No HKDF salt-reconstruction.

The trade-off is one extra `Random(32)` per event, which is negligible compared to the AEAD encrypt + per-recipient wrap that already happens.

A future `encryption.mode = "derived"` option may add HKDF-derived content keys for use cases where stateless re-derivation matters (cold-storage replay, multi-region key escrow). Out of scope for v0.1.

### 5.3 AEAD encryption

```
contentKey       = Random(32)                                    // §5.2
sym              = SymmetricKey(contentKey)
ciphertextBytes  = sym.encrypt(plaintextBytes)                   // AES-256-GCM
```

`@bsv/sdk`'s `SymmetricKey.encrypt` returns an **IV-prepended ciphertext** (RFC 5116 framing). The 12-byte IV is the first 12 bytes of `ciphertextBytes`; the 16-byte GCM tag is appended at the end. Wire-level we keep that framing intact and store the whole blob in `envelope.ciphertextHex`. The envelope's `ivHex` field is therefore **the empty string** — kept as a structural placeholder so a future v2 envelope format can store IV separately without breaking field positions.

The plaintext is the canonical-JSON serialization of the hook payload. Header binding (so a swapped `sequence` or `hookKind` invalidates decryption) is achieved at the *commitment-hash* level, not via GCM AAD: the on-chain `commitHash = SHA-256(prevHash || canonical(payload))` already binds payload to chain position; if a verifier finds `recomputed_plaintext_hash != envelope.header.plaintextHash` or `envelope.header.plaintextHash != commitHash`'s payload contribution, the envelope is rejected. This sidesteps a class of AAD-canonicalization footguns at the cost of one extra hash check at verify time.

### 5.4 Hash chain (BRC-60-aligned)

Each commitment links to its predecessor using BRC-60 state-machine event-chain semantics (incremental sequence + hash-of-prev-event). We deviate from BRC-60's "single non-final transaction packing" by anchoring **each event in its own transaction** — the trade-off is more on-chain footprint in exchange for per-event forensic granularity (each sequence number has a discrete txid + block height).

The exact construction (`package/src/broadcast-pipeline.ts:178–192`):

```
{ sequence, prevHash } = state.reserveNextSequence()

chainBoundPayload = prevHash_bytes || canonical_json_bytes(hook_payload)
commitHash        = SHA-256(chainBoundPayload)              // 32 bytes
derivedPubkey     = ProtoWallet.getPublicKey({              // BRC-42 derived
                      protocolID: [2, "provable think commitment v1"],
                      keyID:      str(sequence),
                      counterparty: "self",
                    })
signature         = ProtoWallet.createSignature({           // DER, ~70-72 bytes
                      hashToDirectlySign: commitHash,
                      protocolID: [2, "provable think commitment v1"],
                      keyID:      str(sequence),
                      counterparty: "self",
                    })
```

`prevHash` for sequence 0 is `"00…00"` (32 zero bytes); thereafter each commit's `prevHash` is the previous commit's `commitHash`. State is held in DO SQLite (`package/src/state.ts pt_state` table); the chain head advances atomically with broadcast acknowledgement.

Sequences are agent-scoped, contiguous, monotonic. Gap detection is straightforward: any verifier walking the chain who finds `sequence[k+1] != sequence[k] + 1` raises an alarm.

Two notable design choices:

1. **Per-event derived signing key (not raw `A_id`).** The signature on chain is produced by a BRC-42-derived child key whose derivation parameters include `sequence`. That gives two properties: (a) on-chain signatures don't directly expose `A_id`'s signing surface; (b) a verifier with `A_id_pub` can recompute every per-event pubkey deterministically and check the OP_RETURN's embedded pubkey matches.
2. **Hash binds to `prevHash`, not to a structured-fields tuple.** The hash input is just `prevHash_bytes || canonical_json(payload)` — simpler than `proto || version || tenant_id || agent_id || sequence || …` and equivalent in security as long as `payload` carries the structural fields canonically. This is what the verifier CLI reproduces in step 5 of §7.

### 5.5 Selective-disclosure viewing keys

When the operator grants a scoped capability via `agent.grantViewingKey({ recipientPubHex, scope, ... })`, every subsequent envelope whose event matches the scope (hookKind / tags / time range) gets an extra recipient row. The wrap is performed via `ProtoWallet.encrypt`, which is BRC-2 over BRC-42 internally:

```
keyID = `${tenant}/${agent}/${sequence}/${recipient.id}`
wrappedKey = wallet.encrypt({
  plaintext:    contentKey,                           // 32-byte AES key
  protocolID:   [2, "provable think envelope wrap v1"],
  keyID,
  counterparty: recipient.counterparty,               // 33-byte recipient pub OR "self"
})
```

`wallet.encrypt` derives the symmetric wrap key from `ECDH(A_id_priv, recipient_pub)` (BRC-42), splits it on protocolID+keyID, and AES-256-GCM-encrypts the content key. The wire field is `envelope.recipients[].wrappedHex`.

At decrypt time the recipient does the mirror operation with their own priv key + the agent's pub key:

```
contentKey = recipient_wallet.decrypt({
  ciphertext:   bytes(wrappedHex),
  protocolID:   [2, "provable think envelope wrap v1"],
  keyID,                                              // same string
  counterparty: A_id_pub,                             // recipient sees agent's pub here
})
plaintext  = SymmetricKey(contentKey).decrypt(ciphertextBytes)
verifyEnvelopeIntegrity(envelope, plaintext)          // SHA-256 == envelope.header.plaintextHash
```

The `keyID` carries `tenant/agent/sequence/recipientId` so the same recipient identity used across multiple agents/sequences is cryptographically separated. This is what `package/src/envelope.ts:147` produces and what was verified end-to-end in the Phase 2.3 mainnet gate (txid `717ce2e9…`).

**Revocation.** Two layers:

- *Runtime revocation* (`agent.revokeViewingKey({ id })`): subsequent events stop including that recipient row. Already-broadcast envelopes still contain the recipient's wrap and can be decrypted by them — selective disclosure is forward-controllable, not retroactively retractable.
- *Identity rotation* (future `agent.rotateIdentity()`, not in v0.1): operator generates a new `A_id_priv'`, emits a `KeyRotation` commitment on chain. Old chain remains valid up to the rotation; new events sign under the new key. Revocation of past disclosure is impossible by construction (envelope-encryption property).

For GDPR Article 17 plaintext erasure: the encrypted bytes can be deleted from R2/UHRP independently of the chain. The chain commitment hash remains, but no one can ever decrypt the plaintext again. Verifiers see "sequence N existed; payload no longer recoverable" — a meaningful audit trail that respects erasure.

### 5.6 Wire format: OP_RETURN payload

Variable length, ~145–148 bytes total (depends on DER signature length, typically 70–72 bytes). All multi-byte fields big-endian. Layout (`package/src/commitment.ts:118–129`):

```
Offset  Size   Field
─────────────────────────────────────────────────────
  0      4    Magic "PRT1" (0x50 0x52 0x54 0x31)
  4      1    Hook kind enum (HOOK_KIND_BYTES)
  5      4    Sequence number (BE, agent-scoped, monotonic)
  9     32    Commitment hash (SHA-256 of prevHash || canonical(payload))
 41     33    Per-event derived signing pubkey (BRC-42, compressed secp256k1)
 74      1    DER signature length byte (typically 0x46–0x48, range 0x46–0x49)
 75      v    DER ECDSA signature over the commitment hash
─────────────────────────────────────────────────────
Total: 75 + sig_len = ~145–148 bytes
```

The 1-byte length prefix on the DER signature exists because `@bsv/sdk@2.0.13`'s `Signature.toCompact()` is parameterized in a way that conflicted with how the spike was broadcasting; we standardized on DER + length prefix during Phase 1 and locked that in. A future PRT2 wire format may switch to a fixed 64-byte compact signature once we standardize the recovery+compressed argument shape across `@bsv/sdk` versions.

The OP_RETURN locking script is `OP_FALSE OP_RETURN <payload>` — the leading `OP_FALSE` makes the output provably unspendable, which miners reliably classify as data-carrier (BRC-18 / BRC-60 convention).

The Hook kind enum:

```
0x01 BeforeTurn         0x02 BeforeStep         0x03 BeforeToolCall
0x04 AfterToolCall      0x05 OnStepFinish       0x06 OnChunk
0x07 OnChatResponse     0x08 OnChatRecovery     0x09 GetModel
0x0A FiberStart         0x0B Stash              0x0C FiberRecovered
0x0D ExtensionAuthored  0x0E PaymentBRC29       0x0F KeyRotation
0xFF StepMerkleRoot
```

Reserved range `0x80–0xFE` for extensions.

### 5.7 Wire format: off-chain envelope

JSON-encoded (UTF-8, no whitespace, keys sorted at encode time). Shape from `package/src/envelope.ts:SealedEnvelope`:

```jsonc
{
  "header": {
    "v":             "provable-think/v1",
    "tenant":        "acme",
    "agent":         "agent-7",
    "sequence":      1024,
    "hookKind":      "beforeToolCall",
    "ts":            "2026-04-28T14:12:09.331Z",
    "scopeTags":     ["compliance.read", "regulated.pii"],
    "prevHash":      "<32 bytes hex of prior commitHash>",
    "plaintextHash": "<32 bytes hex of SHA-256(canonical_json(payload))>"
  },
  "ivHex":         "",                                 // empty: IV is embedded in ciphertext
  "ciphertextHex": "<IV(12) || AES-GCM ciphertext || tag(16), all hex>",
  "recipients": [
    {
      "id":           "self",
      "counterparty": "self",
      "keyID":        "acme/agent-7/1024/self",
      "wrappedHex":   "<BRC-2 wrap of contentKey, hex>"
    },
    {
      "id":           "auditor-alice",
      "counterparty": "02ab…",                         // alice's compressed pub (hex)
      "keyID":        "acme/agent-7/1024/auditor-alice",
      "wrappedHex":   "<BRC-2 wrap of contentKey, hex>",
      "scope":        { "tags": ["compliance.read"], "hookKinds": ["beforeToolCall"] }
    }
  ]
}
```

JSON (not CBOR) was chosen for v0.1 because:
- R2 stores it directly as `application/json`; no decode tooling needed for an auditor opening the file.
- Verifier CLI debugging is human-readable.
- Canonical-JSON re-serialization is well-understood (sorted keys, no whitespace).

A future PRT2 wire format may switch to deterministic CBOR for ~30% size reduction; v0.1 prioritizes readability over wire compactness.

There is no `commit_txid` or `storage_url` field inside the envelope — those would create a circular reference (the envelope's plaintext hash is part of the commit hash, which determines the txid). Instead, the verifier discovers the envelope via the agent's `/commit-info?txid=…` endpoint (§6.4), which maps txid → R2 storage key (or UHRP url) at lookup time.

---

## 6. Envelope storage backends

This section covers where the **encrypted hook payload envelopes** live. Wallet UTXO state is *separate* — in v0.1 it lives in the agent Worker's DO SQLite (`pt_utxos` table); in v3.0 it will move to `bsv-wallet-infra-cloudflare`'s D1 + R2.

### 6.1 R2 (default)

Cloudflare-native. Bucket key (`package/src/storage-r2.ts:envelopeKey`):

```
{path_prefix}/{tenant_id}/{agent_id}/{YYYY-MM}/{sequence:zero-padded-12}.env.json
```

Defaults: `path_prefix = "provable-think"`, sequence padded to 12 digits, month granularity (not day) so a single agent firing thousands of events per day stays in one prefix per month.

Configured via wrangler:

```jsonc
{
  "r2_buckets": [
    { "binding": "PROVENANCE_BUCKET", "bucket_name": "acme-agent-provenance" }
  ]
}
```

Pros: zero-ingress for CF-hosted agents, lifecycle policies, IAM, native to the Worker runtime. Cons: operator controls the storage layer (mitigated by the chain anchor — the *integrity* doesn't depend on R2; an operator who deletes an envelope leaves the on-chain commitment hash dangling, which an auditor can detect).

### 6.2 `bsv-storage-cloudflare` UHRP (distributed option)

The [Universal Hash Resolution Protocol (UHRP)](https://projectbabbage.com/docs/uhrp/intro) is a content-addressed, distributed storage layer where files are referenced by their hash and resolvable across multiple hosts — analogous to IPFS but BSV-native. Any host serving the same hash satisfies the auditor.

`provable-think` ships with first-class support for [`Calhooon/bsv-storage-cloudflare`](https://github.com/Calhooon/bsv-storage-cloudflare), a self-hosted Rust→WASM Cloudflare Worker that's protocol-compatible with Babbage's `nanostore.babbage.systems`. Default endpoint:

```
https://bsv-storage-cloudflare.dev-a3e.workers.dev          ← upload (auth + 402)
https://pub-0c965344954142909622d4c2aed91f87.r2.dev/<name>  ← public-read (no auth)
```

Both URLs are configurable; the public-read base typically points at the operator's own R2 public bucket / custom domain.

**Upload flow** (`package/src/storage-uhrp.ts:uploadEnvelopeToUhrp`):

1. `POST /upload` via `AuthFetch` (BRC-103/104 mutual auth). Body: `{ fileSize, retentionPeriod }`.
2. Server replies **402 Payment Required** with BRC-105 headers (`derivationPrefix`, sats required).
3. `AuthFetch` automatically pays via the agent's rich-wallet `createAction` (BRC-29 P2PKH with derivation), retries the original POST with `x-bsv-payment` header.
4. Server replies 200 with `{ uploadURL, requiredHeaders }` — a presigned R2 PUT URL.
5. Worker PUTs the envelope JSON bytes to that URL with the required headers.
6. Public read URL = `${publicUrlBase}/${fileName}` where `fileName` is parsed from the presigned URL's path-after-bucket.

Verified mainnet round-trip: Phase 2.4b txid `0dbaf548…` (chain) + UHRP blob at `https://pub-0c965344954142909622d4c2aed91f87.r2.dev/cdn/8rvFVMzqCCCJ5EGG7bWSwK`. Cost: 1000 sats UHRP upload + 36 sats chain commit = 1036 sats total ≈ $0.0003 at $25/BSV.

**Why distributed storage matters for compliance:**

- Operator-controlled R2 means the operator can technically delete or hide envelopes (we'd detect this at audit time via missing-sequence alarms, but it's still a control surface).
- UHRP is content-addressed and multi-host: an envelope written to one UHRP host can be mirrored to others, and the resolution is hash-driven rather than location-driven. The chain commitment includes the hash; any host serving that hash satisfies the auditor.
- For high-regulation use cases (federal, EU AI Act high-risk systems), this is meaningfully stronger: the *operator* cannot make envelopes disappear, only revoke decryption keys. The encrypted bytes persist on the network as long as any host pins them.

**Babbage's `nanostore.babbage.systems`** is a protocol-compatible alternative — same UHRP wire shape, hosted by Babbage. Operators who don't want to self-host can point `endpoint` there instead. Self-hosted is the v0.1 default because it gives the operator full custody of the storage layer (and the per-upload economics).

Configured via:

```typescript
storage: {
  primary: "uhrp",
  uhrp: {
    endpoint:      "https://bsv-storage-cloudflare.dev-a3e.workers.dev",
    publicUrlBase: "https://pub-0c965344954142909622d4c2aed91f87.r2.dev",
    retentionMinutes: 525600,   // 1 year
  },
  fallback: "r2",                // mirror to R2 too
}
```

Recommended for: regulated industries, government, multi-party consortia where no single party should be able to suppress evidence.

### 6.3 DO SQLite (small/fast-path)

For very small envelopes (< 4KB) or testing, store inline in `this.ctx.storage.sql`. We expose a `storage: { primary: "do-sql" }` option; it's not recommended for production because DO storage isn't durable across DO migration in the way R2/UHRP are.

### 6.4 Discovery: `/commit-info` and `/envelope` endpoints

For the auditor to find an envelope given a chain `txid`, the operator's agent Worker exposes two public endpoints (`package/test-worker/src/index.ts` is the reference implementation):

```
GET /commit-info?txid=<64-hex>     →  { txid, sequence, hookKind, commitHash, ts,
                                        envelopeKey, agentIdentityPubHex }

GET /envelope?key=<r2-key>         →  raw SealedEnvelope JSON (encrypted; no auth needed)
```

`/commit-info` reads the operator's `pt_commits` SQL table (`txid → sequence, hookKind, commit_hash, created_at`), reconstructs the R2 storage key from the timestamp + sequence + agent identity, and returns the full lookup tuple. `/envelope` is a thin R2 proxy — encrypted blobs are safe to expose without auth because decryption requires the recipient's identity priv key.

This replaces the v0.3 design's "signed manifest" approach. Discovery via live endpoint has three advantages:

1. **No manifest staleness.** Each lookup hits the operator's current state.
2. **No bulk index to publish.** The operator needn't repeatedly publish a (potentially huge) signed manifest.
3. **Cross-check at audit time.** The operator-reported `commitHash` (from their record) is compared against the chain's `commitHash` (from the OP_RETURN); divergence is caught in step 7 of the verification protocol below.

A signed-manifest mode (for offline auditors or air-gapped verification) remains on the roadmap; v0.1 ships with the live-discovery model because it's simpler and stronger for the common audit case.

---

## 7. Verification protocol

The standalone `provable-think-verify` CLI (`package/cli/src/cli.ts`) implements an 11-step pipeline. All 11 steps were verified in the Phase 2.4 mainnet gate (txid `ea0d9f71…`).

```
Input:  --txid <hex>                         the on-chain commitment
        --capability <path/to/cap.json>      issued out-of-band by operator
        [--envelope-server-url <url>]        overrides capability default

  1. read capability                                  capability JSON parses; id + recipientPubHex present
  2. capability validity                              capability.validUntil (if set) is in the future
  3. envelope server URL                              operator endpoint resolved (CLI flag > capability default)
  4. fetch tx from WhatsOnChain                       GET https://api.whatsonchain.com/v1/bsv/main/tx/<txid>/hex
  5. parse PRT1 payload                               find PRT1 magic in OP_RETURN; extract hookKind/seq/commitHash/derivedPub/DER-sig
  6. fetch commit-info from operator                  GET ${envServer}/commit-info?txid=<txid>
  7. chain commit hash matches operator record        prt1.commitHash === commitInfo.commitHash    (catches operator drift)
  8. agent identity pubkey matches capability         commitInfo.agentIdentityPubHex === capability.agentIdentityPubHex (catches misissued cap)
  9. fetch envelope                                   GET ${envServer}/envelope?key=<commitInfo.envelopeKey>
 10. decrypt envelope as auditor                      ProtoWallet(auditorPrivKey).decrypt(wrappedHex; counterparty=agentPub) → contentKey;
                                                      SymmetricKey(contentKey).decrypt(ciphertextHex) → plaintext bytes
 11. verify plaintext hash matches on-chain commit    SHA-256(plaintext) === envelope.header.plaintextHash
                                                      (the chain's commitHash binds prevHash + plaintextBytes; mismatch = tamper)
```

Failure semantics:
- Step 5 fail → tx exists but isn't a PRT1 commitment.
- Step 7 fail → operator's record doesn't match the chain (operator drift, replay, wrong txid).
- Step 8 fail → capability was issued for a different agent (misissue).
- Step 10 fail → wrong recipient identity OR ciphertext tampered (AEAD reject).
- Step 11 fail → envelope plaintext doesn't match the chain's commitment (envelope swap or partial tamper).

Output formats:
- Default (human): one `OK   <step>` or `FAIL <step>` line per step on stderr, then a final `=== INTEGRITY OK ===` block with sequence / hookKind / commit hash / decrypted plaintext.
- `--json`: a single `{ ok, txid, steps, envelopeKey, plaintext, plaintextHash, header }` JSON object on stdout (for CI / programmatic auditors).

Exit code: `0` on full integrity pass; `1` on any step failure.

**Chain-walk extension (not yet in v0.1 CLI).** The library exposes the discrete steps as async functions, so callers can extend with: fetch envelope at sequence N-1, verify `(its plaintextHash binds-into commitHash[N-1])`, and that `commitHash[N-1]` appears as `prevHash[N]` in the OP_RETURN at sequence N. Walking back to genesis (sequence 0) detects gaps and out-of-order anchoring. Roadmap item for v0.5; not blocking v0.1 single-event integrity.

---

## 8. Performance

### 8.1 Per-hook latency

| Operation | Typical | Worst |
|---|---|---|
| BRC-42 / HKDF derive | < 1 ms | 5 ms |
| AES-256-GCM encrypt (typical step ≤ 50 KB) | < 1 ms | 5 ms |
| ECDSA sign (commit hash) | 1–3 ms | 10 ms |
| R2 PUT (typical 50 KB) | 50–150 ms | 500 ms |
| UHRP upload | 200–800 ms | 2000 ms |
| BSV broadcast (ARC) | 100–400 ms | 1500 ms |
| **Total (async, off critical path)** | **0 ms agent-perceived** | — |
| **Total (sync, blocking)** | **150–600 ms** | **3000 ms** |

By default `anchor.asyncCommit = true`: the wrapper enqueues the broadcast via `ctx.waitUntil()` and returns control to the agent immediately. The agent never blocks on chain. If a broadcast fails, it's retried on the next hook (`anchor.retryPolicy`).

For sync mode (used when the operator wants the agent to *actually wait* for the commitment before proceeding — useful when the next agent action depends on the commitment being public, e.g., a payment recipient verifying), set `asyncCommit: false`. Expect ~300 ms median added latency per hook.

### 8.2 Batching for high-rate agents

For agents that fire > 1 hook/sec sustained, single-hook commits become wasteful. Two batching modes:

- **`per-step`**: Buffer all hooks within a step; emit one commitment per step containing a Merkle root of the per-hook commitments. One on-chain write per step. Auditor walks the Merkle tree to verify any individual hook.
- **`merkle-step`**: Same, but with explicit inclusion proofs per hook so individual hooks can be verified without fetching the whole step.

Batching is configured per agent via `anchor.batchPolicy`. Default `per-hook` for most workloads; switch to `per-step` for streaming agents.

### 8.3 Cost

Empirical numbers from 7 mainnet broadcasts during Phases 1, 2.1, 2.2, 2.3, 2.4, 2.4b (verified ledger in §13). Default fee rate `100 sats/kb` (the canonical TaaL/GorillaPool minimum).

| Component | Bytes | Sats |
|---|---|---|
| OP_RETURN payload (PRT1, ~145–148 bytes) | ~146 | — |
| Full tx (1 input, 1 OP_RETURN out, 1 P2PKH change out) | ~256 | — |
| **Per-commit chain fee at 100 sats/kb** | — | **~36** |

So the per-event chain cost is **~36 sats ≈ $0.000009 at $25/BSV** (~9 millionths of a dollar). Round up to $0.00001 for budgeting:

- 1 million commitments ≈ $10
- 100 million commitments ≈ $1,000
- 1 billion commitments ≈ $10,000

These numbers are **~10× lower** than the ~390-sat estimate in earlier drafts, which assumed a 1 sat/byte rate and an over-large tx envelope. The new numbers are derived from actual broadcast outcomes (see your local credentials file cost ledger).

**With UHRP (`bsv-storage-cloudflare`) storage**, add the per-upload BRC-105 payment (currently 1000 sats per envelope at the reference deployment's pricing — operator-configurable in their `bsv-storage-cloudflare` deployment):

| Storage | Per-event total | Per-million |
|---|---|---|
| R2 only (default) | ~36 sats ≈ $0.000009 | ~$10 |
| R2 + UHRP mirror | ~1036 sats ≈ $0.00026 | ~$260 |

R2-only suits operators who control their own storage layer. UHRP adds anti-suppression at ~30× the per-event cost — still well under a cent per event, still well under a dollar per 100K events.

Compare to: a single L2 rollup commitment on Ethereum (volatile but typically $0.001–$0.05 per OP_RETURN-equivalent at network-busy times); Bitcoin Core (which doesn't allow OP_RETURNs of this size at competitive cost); or a notarization SaaS like OpenTimestamps batched aggregator (free for small volumes but no per-event provenance and no encrypted payload integration).

---

## 9. Failure modes

| Scenario | Behavior | Recovery |
|---|---|---|
| BSV broadcast fails (ARC outage) | Commitment retried on next hook; pending queue persisted in DO storage | Auto-retry; if pending > N, agent emits warning log |
| R2 PUT fails | Envelope cached in DO storage; flushed on next successful PUT | Same |
| UHRP host unavailable | Fall back to `storage.fallback` if configured | Operator should always configure R2 fallback for UHRP |
| Key rotation mid-step | Step is sealed under old key; rotation commitment fires; subsequent steps under new key | Auditor sees rotation event in chain |
| Fiber recovery (Project Think hibernated DO wakes elsewhere) | `onFiberRecovered` fires; commitment includes original fiber id + last stash hash + recovery cause | Chain proof attests the same identity key resumed at the committed checkpoint |
| Agent identity key compromise (v0.1: AGENT_PRIVATE_KEY_HEX leak) | Operator generates a new key, swaps the wrangler secret, redeploys. Old chain remains valid up to the cutover; new commitments sign under the new key. v0.5 will add an in-band `KeyRotation` commitment that anchors the cutover atomically on chain. | High severity — this key both signs commits and funds them. v3.0 splits these (identity in agent Worker, funding in wallet Worker) so the blast radius narrows. |
| Operator deletes envelope from R2 | Verifier detects: chain has commitment, R2 returns 404, auditor sees "envelope missing for sequence N" | If UHRP fallback was configured, verifier finds it there. If not, missing-envelope alarm. |
| Operator tampers envelope | AEAD tag fails; verifier reports "INTEGRITY FAILURE at sequence N" | No silent corruption possible |
| Operator backdates a commitment | Block height of the OP_RETURN tx is the wall-clock authority. Verifier compares envelope timestamp to block time and flags drift > tolerance | Default tolerance: 1 hour |
| Sequence gap (operator suppresses commitments) | Verifier walking the chain finds `sequence[k+1] - sequence[k] > 1`; raises gap alarm | We recommend auditors walk the full chain at audit time, not just sample |

---

## 10. Threat model

### 10.1 In scope

- **Operator dishonesty (post-hoc)**: operator cannot rewrite, suppress, or fabricate agent history without detection.
- **Operator dishonesty (compelled)**: operator can selectively disclose by issuing scoped viewing keys; cannot be compelled to disclose more than a court orders without changing crypto.
- **Network MITM** on agent ↔ tools/APIs (when BRC-103/104 mutual auth is used for outbound calls — `@bsv/sdk`'s `AuthFetch` supplies this; see `agents/x402` and BRC-105 integration in §11.4).
- **Replay attacks**: BRC-60-aligned sequence numbers and per-step nonces prevent replay.
- **Identity impersonation**: per-agent identity keypair (used in BRC-103/104 mutual auth and commitment signatures) prevents impersonation given key custody.
- **Storage tampering**: AEAD + on-chain hash makes tampering detectable.
- **Model swap detection**: `getModel()` commits the model name at decision time.
- **Tool-result tampering**: `afterToolCall` commits the result hash; doctored API responses caught.
- **Self-authored extension forensics**: extension source + permissions committed before execution.

### 10.2 Out of scope (explicit)

- **Compromised agent endpoint at runtime**: if the Cloudflare Durable Object is itself executing malicious code, our commitments faithfully record what it did — they don't prevent it. Defense-in-depth via Cloudflare's sandbox model, not us.
- **Compromised auditor**: if an auditor leaks the plaintext they were authorized to read, that's outside our crypto. Forward rotation limits future leakage, not past.
- **Social engineering**: an operator tricked into granting a viewing key to the wrong recipient is a process failure, not a crypto failure.
- **Collusion between operator and auditor**: if the parties whose adversarial relationship we depend on are colluding, the chain still records facts but the disclosure semantics break down. (This is a property of all audit systems.)
- **BSV consensus failure**: a 51% attack on BSV would let an attacker rewrite history. We treat this as out-of-scope for the same reason TLS treats a broken SHA-256 as out-of-scope: it's a foundational assumption.
- **Plaintext model outputs revealing themselves through other channels**: if the agent's tool calls leak state through side channels (e.g., timing), we can't detect that.
- **Quantum attacks against secp256k1 or AES-256**: addressed by future post-quantum upgrade path; not addressed today.

### 10.3 Adversary capabilities table

| Adversary | Can | Cannot |
|---|---|---|
| **Public observer** | Read on-chain commitments (hash + sig + sequence). | Decrypt anything. Identify content. Identify model used. Identify decisions made. |
| **Network MITM** | Observe encrypted envelopes in transit (if intercepted in flight). | Decrypt. Modify undetectably. Substitute envelopes. |
| **Storage operator (R2 / UHRP host)** | Delete or alter ciphertext. | Forge new commitments (no agent priv key). Alter chain history. Decrypt without viewing key. |
| **Storage operator (`bsv-storage-cloudflare` UHRP host)** | Delete or refuse to serve encrypted blobs. Mirror them to other hosts. Charge per-upload (BRC-105). | Forge new commitments (no agent priv key). Decrypt without viewing key. Tamper undetectably (any byte change invalidates the on-chain plaintext-hash check). When self-hosted, this actor is the operator themselves. |
| **Wallet Worker operator (bsv-wallet-infra-cloudflare host)** *(v3.0 only — not present in v0.1)* | Refuse to broadcast. Race competing transactions. Inspect funding UTXO topology. | Forge past commitments (no agent identity priv key — agent Worker holds it). Decrypt envelopes. Tamper with already-mined chain entries. v0.1: this actor doesn't exist; the agent Worker broadcasts directly. |
| **Cloudflare account admin** | Inspect agent runtime; stop the agent; modify Durable Object code. In v0.1 this admin also holds funding-wallet keys (consolidated in the agent Worker). v3.0 splits these across two Workers in (potentially) different CF accounts. | Forge past commitments (chain immutability). Decrypt past envelopes if they don't have the agent's priv key cached. |
| **Operator (master key holder)** | Issue/revoke viewing keys. Rotate identity. Selectively destroy `CK_step` values for plaintext erasure. | Rewrite past chain (commitments are public). Forge auditor signatures. Bypass chain ordering. |
| **Authorized auditor** | Decrypt envelopes within their scope. Verify chain integrity. | Decrypt out-of-scope. Forge new commitments. Read other auditors' scopes. |
| **BSV miner (single block)** | Refuse to include a transaction (delaying anchoring). | Tamper with already-mined commitments. |

---

## 11. Integration with existing Cloudflare primitives

### 11.1 Workspace (`packages/think/src/think.ts:547`)

The agent's `WorkspaceLike` (virtual filesystem, optionally R2-backed) is treated as a regular tool by `provable-think`. File reads and writes that flow through workspace tools fire `beforeToolCall` / `afterToolCall` hooks like any other, and their commitments include the file path + content hash. Workspace operations are thus auditable end-to-end without special-casing.

### 11.2 Sessions / FTS5

Project Think persists chat sessions and supports FTS5 search over them (`assistant_messages`, `assistant_fts`). Session forks fire `configureSession`, which we commit. Compactions fire as a special hook (`onCompaction`) — covered by the `0x80–0xFE` reserved range.

### 11.3 Codemode

When an agent uses `@cloudflare/codemode` to emit a single program instead of many tool calls, we commit the program source hash + execution result. The fine-grained hook commitments inside the codemode-generated program still fire if those calls go through the standard tool surface; pure in-isolate code (no external calls) is captured as one commitment for the whole program.

### 11.4 `agents/x402` coexistence

Cloudflare ships `agents/x402` (peer deps `@x402/core`, `@x402/evm`) for EVM-based payments. `provable-think`'s 402 hook is configured per-tool: the `beforeToolCall` interceptor checks tool metadata for a `paymentRail` field. Default rails:

- `evm` → defer to `agents/x402` (no change in CF behavior; we just commit the resulting tx hash).
- `bsv` → use BRC-29 (P2PKH payment with derivation) over BRC-105 (HTTP service monetization). The agent Worker uses `@bsv/sdk`'s `AuthFetch` to handle the 402 handshake. **In v0.1 the outgoing payment transaction is built by the agent Worker's own rich-wallet `createAction`** (`package/src/wallet.ts:makeMinimalWallet` with `paymentSupport`), funded from the agent's DO-SQLite UTXO pool, and broadcast via the same multi-ARC race the chain commitments use. This was end-to-end verified in the Phase 2.4b UHRP gate (txid `0dbaf548…`, 1000-sat BRC-105 paid upload). In v3.0 the rich `createAction` will route to `bsv-wallet-infra-cloudflare`'s `createAction`/`processAction` over JSON-RPC, separating funding-wallet keys from agent-identity keys.
- `none` → no payment, just the ordinary commitment.

The commitment kind for any 402 retry is `0x0E PaymentBRC29` (or `0x0E` with a flag for non-BRC rails). The point is: **`provable-think` does not replace `agents/x402`. It records every payment any rail makes**, and offers BSV as an additional rail for the cases where sub-cent fees and on-chain provenance matter.

### 11.5 ExtensionManager

`packages/think/src/think.ts:954–1027` exposes `ExtensionManager.load(manifest, source)` and `restore()`. We hook both: every load commits the manifest hash + source hash + declared permissions; every restore commits the resumption + verifies the source hash hasn't changed since the original load. **An extension whose source is altered between load and restore fails its restoration and emits a tamper alarm.**

This is the single most-undersold property of the design. Cloudflare's pitch for self-authored extensions is "auditable, revocable TypeScript." `provable-think` is what makes "auditable" mean something cryptographically.

### 11.6 `@bsv/wallet-toolbox` integration (v3.0 only — not used in v0.1)

`@bsv/wallet-toolbox`'s `StorageClient` (the TypeScript HTTP/JSON-RPC client) is the integration path **for v3.0 Path D production**, where the agent Worker delegates `createAction`/`processAction`/`internalizeAction` to `bsv-wallet-infra-cloudflare` via JSON-RPC. **We do NOT use `@bsv/wallet-toolbox` in v0.1 at all** — neither the client nor the server side. v0.1 ships with only `@bsv/sdk@2.0.13` (`ProtoWallet` + `AuthFetch` + `Beef` + primitives) plus our own `MinimalWallet` adapter (`package/src/wallet.ts`) that implements just enough `WalletInterface` for `AuthFetch` to handle BRC-105 paid endpoints. The server-side `StorageServer` / `Wallet` / `StorageKnex` / `StorageIdb` paths require `better-sqlite3` / Express / IndexedDB and are NOT Worker-compatible — they're replaced by the Rust→WASM wallet Worker in v3.0. Keeping `@bsv/wallet-toolbox` out of v0.1 keeps the package tree small (the alpha state of `bsv-wallet-infra-cloudflare` was the immediate driver, but the lighter dep tree is a happy side-effect).

### 11.7 Multi-ARC race + propagation guarantees

ARC (Application Resource Channel) is the BSV mainnet broadcast endpoint. There are multiple production ARC operators; the spec lets a transaction be submitted to any of them. We discovered during Phase 1 that **a single ARC submission is not a reliable propagation guarantee** — TaaL alone consistently stalls at `ANNOUNCED_TO_NETWORK` (the tx is announced but no peer has acknowledged seeing it), and the broadcast can hang for minutes before a confirmation arrives.

`provable-think` mitigates this with a **multi-ARC race**:

```
DEFAULT_MAINNET_ARC_URLS = [
  "https://arc.gorillapool.io",       // tried first — fastest to SEEN_ON_NETWORK in our tests
  "https://api.taal.com/arc",          // fallback / second mover
]
```

The `package/src/arc.ts:broadcastArcRace` function POSTs the same Extended-Format (EF) tx hex to **all** configured ARCs in parallel, with the `X-WaitFor: SEEN_ON_NETWORK` header on each request. The race resolves as soon as **any single ARC** returns a status of `SEEN_ON_NETWORK` (or stronger — `ACCEPTED_BY_NETWORK`, `MINED`). Other in-flight requests are not cancelled (one extra successful broadcast is harmless; a duplicate-submission error from any ARC is treated as success).

Empirical findings from the verification ledger (§13):
- GorillaPool reaches `SEEN_ON_NETWORK` in ~200–800 ms in 95% of broadcasts.
- TaaL alone reaches `SEEN_ON_NETWORK` in ~40% of broadcasts within 10 s; the remaining 60% stall at `ANNOUNCED_TO_NETWORK` and time out.
- Race wins were 6/7 GorillaPool, 1/7 TaaL across our gate broadcasts.

**Important:** ARC's `rawTx` field accepts hex/EF format only — it does NOT auto-detect BEEF. We learned this during Phase 1 when ARC returned `400 InvalidArgument` on BEEF submissions. The package always submits EF format (`Transaction.toHexEF()`). For SPV-completeness in downstream consumers, BEEF is constructed off-path by the verifier, not the broadcaster.

The package's own ARC client is a hand-rolled fetch-based implementation rather than `@bsv/sdk`'s built-in `ARC` class, because the SDK class calls Node's `https.request` (not Cloudflare-Worker-compatible). This is the single largest patch the package applies on top of stock `@bsv/sdk` to make it Worker-native; everything else (`ProtoWallet`, `AuthFetch`, `Beef`, primitives) runs unchanged.

Operators can configure any ARC list via `anchor.arcUrls`. For testnet or private chains, this same code path works against any ARC-compatible endpoint.

---

## 12. Reference implementation

`provable-think` is **pure TypeScript, Worker-native**. The SDK and protocol primitives we consume:

| Capability | Source | Notes |
|---|---|---|
| BRC-100 crypto subset (in-Worker) | `@bsv/sdk@2.0.13` `ProtoWallet` (`~/bsv/ts-sdk`) | `getPublicKey`, `createSignature`, `verifySignature`, `encrypt`, `decrypt`, `createHmac`, `verifyHmac`, key-linkage reveal. Constructed from a `PrivateKey`. Pure-TS, CF-Worker-compatible. |
| BRC-100 transaction subset (in-Worker, v0.1) | `package/src/wallet.ts:makeMinimalWallet` | Hand-rolled `MinimalWallet` adapter satisfying the slice of `WalletInterface` that `AuthFetch` requires. Rich-mode `createAction` (when `paymentSupport` is provided) builds BRC-29 P2PKH payment txs from the agent's DO-SQLite UTXO pool. Sufficient for v0.1's BRC-105 paid-API consumption (UHRP upload, future paid tools). |
| BRC-100 transaction subset (delegated, v3.0 target) | `Calhooon/bsv-wallet-infra-cloudflare` (forthcoming) — Rust→WASM Cloudflare Worker | `createAction`, `signAction`, `processAction`, `internalizeAction`, `listOutputs`, `listActions`, `getBalance`, `abortAction`, certificate ops. Wire-compatible drop-in replacement for `storage.babbage.systems`. JSON-RPC 2.0 + BRC-103/104 mutual auth. Routed via `@bsv/wallet-toolbox`'s `StorageClient` once cut over. **Not used in v0.1** — alpha status (SQLITE_TOOBIG on BEEF compaction, WoC rate-limit hits, orphan-tx starvation) blocked the dependency, so v0.1 ships self-funded. |
| Auth (`AuthFetch`) for tool 402 retries | `@bsv/sdk` `AuthFetch` | Wraps `fetch` with BRC-103/104 mutual auth + automatic 402 retry. Used inside `beforeToolCall` for tools that require BRC-105 payment. Verified end-to-end against `bsv-storage-cloudflare`'s `/upload` endpoint in Phase 2.4b. |
| ARC broadcast (multi-host race) | `package/src/arc.ts` (hand-rolled fetch-based) | `@bsv/sdk`'s built-in `ARC` class calls Node `https.request` (not Worker-compatible), so we ship our own. Defaults to `arc.gorillapool.io` first, `api.taal.com/arc` fallback; required `X-WaitFor: SEEN_ON_NETWORK`. See §11.7. |
| BEEF / AtomicBEEF (verifier-side SPV) | `@bsv/sdk` `Beef`, `MerklePath` | For verifying chain anchors in the auditor's CLI / browser dashboard. v0.1 verifier (`package/cli/src/cli.ts`) trusts WhatsOnChain + cross-checks operator's reported commitHash against on-chain commitHash; full BEEF SPV is a v0.5 roadmap item. |
| Crypto primitives — secp256k1, ECDSA, hashes | `@bsv/sdk` primitives | Pure TS, no Node-only paths in core. |
| UHRP upload (optional path, v0.1 default) | `Calhooon/bsv-storage-cloudflare` (live: `https://bsv-storage-cloudflare.dev-a3e.workers.dev`) | Self-hosted Rust→WASM CF Worker, R2-backed, BRC-103/104 + BRC-105. Protocol-compatible with `nanostore.babbage.systems` (which remains a usable alternative). See §6.2. |

**Behavioral references** (different runtime; used to validate our TS implementation matches known-good behavior):

| Reference | What it shows | Status |
|---|---|---|
| `~/bsv/rust-bsv-worm/` | Hash-chained on-chain proofs, BRC-29 payment + refund, agent loop semantics. Rust + native runtime. | Production at scale; behavioral reference for "what correct looks like." |
| `~/bsv/bsv-storage-cloudflare/` (live: `bsv-storage-cloudflare.dev-a3e.workers.dev`) | UHRP host, BRC-103/104 + BRC-105 paid upload, R2-backed, content-addressed lookups. Rust→WASM CF Worker. | **v0.1 first-class storage backend.** Verified end-to-end in Phase 2.4b (UHRP blob `cdn/8rvFVMzqCCCJ5EGG7bWSwK`, 1000-sat paid upload). |
| `~/bsv/rust-wallet-infra/` (renaming → `Calhooon/bsv-wallet-infra-cloudflare`) | The wallet Worker we'll depend on in v3.0. Rust→WASM CF Worker; D1 + R2 + KV; JSON-RPC 2.0; BRC-31 → BRC-103/104 mutual auth. | Live at `wallet-infra.x402agency.com`; status alpha (SQLITE_TOOBIG on BEEF compaction, WoC rate-limit hits, orphan-tx starvation). v0.1 does NOT depend on it — those bugs blocked the dep, which is why v0.1 ships with the in-Worker rich-wallet pattern. |
| `~/bsv/rust-middleware/poc-server/` | BRC-105 / x402 over BSV on a Cloudflare Worker (Rust→WASM). | Live at `poc-server.dev-a3e.workers.dev`; reference for the 402 wire format. |
| `~/bsv/wallet-toolbox-examples/` | `pushdrop.ts` (closest analog to OP_RETURN broadcast pattern), `internalizeWalletPayment.ts` (refund flow), `brc29.ts` (key-derived payment). | Patterns to copy; older SDK pinning means types/signatures need re-validation against `@bsv/sdk@2.0.13`. |
| `~/bsv/BRCs/` | Canonical specs (BRC-29 §invoice number format, BRC-42 §test vectors, BRC-60 §state machine event chains, BRC-77 §signature serialization, BRC-78 §encrypted message serialization, BRC-103 §handshake, BRC-104 §HTTP transport, BRC-105 §payment headers). | Single source of truth for wire-format claims in this doc. |

The reference implementation of `provable-think` lives at `Calhooon/provable-think` (private during build-out). v0.1 shipped as `provable-think@0.1.0-alpha.0` with the package layout described in the README. The Phase 1 spike (key derivation → OP_RETURN build → ARC broadcast → real txid on mainnet) validated `@bsv/sdk` + `ProtoWallet` running cleanly inside a CF Worker DO; Phases 2.1–2.4b then layered hook coverage, envelope encryption, selective disclosure, the verifier CLI, and UHRP storage on top. v3.0 is the cutover to two-Worker Path D once `bsv-wallet-infra-cloudflare`'s alpha bugs are addressed.

---

## 13. Verification ledger

Every quality gate for v0.1 was anchored on BSV mainnet. The txids below are the *evidence* that the wire formats, encryption, selective disclosure, verifier CLI, and UHRP integration all work end-to-end against real money. Anyone can fetch these txs from any BSV indexer and re-run the verifier CLI against them.

| Phase | Gate | Mainnet txid | What it proves |
|---|---|---|---|
| 1 | Worker spike: `@bsv/sdk` + `ProtoWallet` build + sign + broadcast OP_RETURN from a CF Worker DO | [`e61a305f…`](https://whatsonchain.com/tx/e61a305fea6cef851a47f174c260a94ad73a79d53ef15c58250dfa1f66fa5679) (mined block 946792) | The hardest "is this even possible" risk: pure-TS BSV crypto runs in a Cloudflare Worker. |
| 1 | Multi-ARC race (GorillaPool reached `SEEN_ON_NETWORK`) | [`5ad0e6ae…`](https://whatsonchain.com/tx/5ad0e6aeb9b7a860dba04579b2787f0dfd47b5fd575b0e14954ab2d972a0fa45) | Propagation is reliable when GorillaPool is in the race. |
| 2.1 | Full HOC + real broadcast through `provable-think@0.1.0-alpha.0` test worker | [`635f2f38…`](https://whatsonchain.com/tx/635f2f38c70a73ab58a9f68f1faa53943a9670301e375785d749355bd63194df) | Every Project Think hook → mainnet PRT1, end-to-end through the actual published HOC. |
| 2.2 | Phase 2.2 envelope sealed + R2 stored + chain anchored + unseal round-trip integrity verified | [`0732135f…`](https://whatsonchain.com/tx/0732135f8936ab8feca5383a71f6883485323b04883c94c9b9133d8ac9f077d8) | PHI never on chain — only the SHA-256. Plaintext recoverable only via the recipient's wrapped key. |
| 2.3 | Selective-disclosure end-to-end: grant → commit (sealed to self + auditor, recipientCount=2) → external auditor decrypted via their own privkey + BRC-42 ECDH | [`717ce2e9…`](https://whatsonchain.com/tx/717ce2e93be8b9aa0029eb527d5d41e8062a2479dbf58c91796fdbd128204adc) | Selective disclosure works against an *independent* auditor key, not just round-trip-to-self. |
| 2.4 | Standalone `provable-think-verify` CLI: 11-step pipeline against a real mainnet commitment | [`ea0d9f71…`](https://whatsonchain.com/tx/ea0d9f71ebf0080b64f15a2a41abc7e5416684f809165403b0d9ddf52ee074da) (+ `94979ff8…`, `21fcaa9c…`) | All 11 verification steps green. The CLI is the auditor's interface; this gate proves it. |
| 2.4b | UHRP distributed-storage option: chain commit + BRC-105 paid upload + public-read fetch + integrity verify TRUE | [`0dbaf548…`](https://whatsonchain.com/tx/0dbaf548d5bc3b8e4790b6dbd38d84bb33133eb92c253fd457cb2193cc44daca) (+ `39335139…`) plus UHRP blob at [`pub-…r2.dev/cdn/8rvFVMzqCCCJ5EGG7bWSwK`](https://pub-0c965344954142909622d4c2aed91f87.r2.dev/cdn/8rvFVMzqCCCJ5EGG7bWSwK) | Self-hosted UHRP via `bsv-storage-cloudflare` works. Auditor cannot be cut off from the encrypted blob by the operator. |
| 2.5 | Pre-flight canary: HIPAA_PRESET wired into the test worker, single onChatResponse round-trip with redaction enabled | [`7ab32c60…`](https://whatsonchain.com/tx/7ab32c60fefe9c74ace1799142d72b5bd05f3d1b41c9bf44208ade11a3d688de) | The HIPAA preset spread (preset + identity + storage + envelopeServerUrl) compiles, broadcasts, and round-trips end-to-end before scaling to the gate scenario. Per the never-lose-sats discipline. |
| 2.5 | HIPAA clinical-triage gate — `beforeToolCall` (input PHI), tagged `["PHI","treatment"]` | [`8ca306f6…`](https://whatsonchain.com/tx/8ca306f6386c7ea29cd35c0db7d3250eafbdcef1b07dd70e5b21acb1ae16bc07) (sequence 11) | First step of the persona-scoped scenario. CO + Patient decrypt; External Auditor correctly excluded ("no recipient" — scope mismatch). Direct-PHI strings (name, DOB, MRN, address, ZIP, phone, email) **absent from the on-chain payload AND from every authorized persona's decrypted plaintext** — Safe-Harbor markers in their place. |
| 2.5 | HIPAA clinical-triage gate — `afterToolCall` (tool result), tagged `["PHI","treatment"]` | [`902b70c6…`](https://whatsonchain.com/tx/902b70c68bed8ea8bc056b73a8c18b8a89dbc03986732f04de391c6d03d5ab9f) (sequence 12) | Same scope filter applies: CO + Patient decrypt; External Auditor still scope-mismatched. Plaintext SHA-256 binds to on-chain commitHash. |
| 2.5 | HIPAA clinical-triage gate — `onChatResponse` (triage decision + QA archival), tagged `["PHI","treatment","operations"]` | [`d0c73e61…`](https://whatsonchain.com/tx/d0c73e61104d239d4698bf6672d2bc02461da07e601ab32ab50250dee07b615d) (sequence 13) | Adding `operations` widens the audience to the External HIPAA Auditor (scope: `operations` + `de-identified`). All three personas decrypt, all three see the *redacted* plaintext — PHI never reaches the auditor in cleartext even though they hold a valid grant. The complete persona × event matrix (3 × 3) lands exactly as the HIPAA scope taxonomy specifies. |
| 2.6 | Acme Health Three-Pane Theater public demo — real Workers AI clinical-triage agent on Cloudflare, every Project Think hook anchored to BSV mainnet, 11-step verifier visualized live in-page | Address `1FBeCanYSByZp9EvJpJL1WVycLwN5cWsCp` history (4+ commits in block 946838 + ongoing). Live URL: [acme-health.pages.dev](https://acme-health.pages.dev/) ↔ [acme-health-agent.dev-a3e.workers.dev](https://acme-health-agent.dev-a3e.workers.dev/). Sample broadcasts: [`14f8c01e…`](https://whatsonchain.com/tx/14f8c01ef07240972e3032e7f3639471907e24a8cdd25a463d40d71d7410789a), [`d17a0bc8…`](https://whatsonchain.com/tx/d17a0bc879ad889afe1a1b9a4cb260be9b49439149ab6e165f0b394c4f2dfcddc), [`31fb769c…`](https://whatsonchain.com/tx/31fb769c869c5ad9ad6ca54d8296b21af28dba22e6f12bbba8e48a48227bbb48). | The conversion artifact for Cloudflare BD + enterprise CISO conversations. Free-form Workers AI (kimi-k2.6) + HIPAA preset + persona-scoped 11-step verifier + REAL R2 tamper buttons + public observer panel. Anyone can type a clinical question, watch real BSV broadcasts land, click any txid → WhatsOnChain. |
| 2.6.1 | **Multi-conversation isolation gate** (2026-04-29) — two parallel patient conversations on the same agent, each with its own per-conversation chain (sequence counters start at 1 in each conv), each anchored to a master chain over the conversation's genesis hash. Switching tabs in the UI swaps every pane to that conv's view; auditor verification scoped per-conv. Real R2 envelopes; collision-free path includes conversationId. Verified end-to-end: chest-pain conv (`c2a0a7d1…`/`61924f45…`/`d73a58d0…`) and headache conv (`5c3aa161…`/`f46d7ae3…`/`17b22b74…`) — six commits, all `SEEN_ON_NETWORK`, zero cross-conversation leakage in commits / envelopes / chat / verifications. | The "real ChatGPT-like multi-thread experience" gate. Cloudflare BD demo can now narrate "every patient gets their own audit-grade chain" with proof. Each conv is a self-contained verification unit; an attacker who silently deletes one conversation breaks the master chain. See `demo/acme-health/MULTI-CONVERSATION-PLAN.md`. |

Cumulative spend across all v0.1 + v0.1.x gates (Phases 1 → 2.5): ~5644 sats ≈ $0.00143 at $25/BSV. The full per-broadcast cost ledger lives in `<your-local-credentials-file>` (gitignored, not in this repo) (gitignored).

For the auditor: every txid above is independently verifiable. Run `npx provable-think-verify --txid <txid> --capability <issued.json>` against the operator's `/commit-info` endpoint and you get the 11-step report from §7. No special auditor tooling, no faith required.

---

## 14. Open design questions

These are *not* deficiencies — they're decisions deferred to implementation:

1. **Quantum-resistance roadmap.** ECDSA + AES-256 are fine today; NIST AI RMF v2 may require post-quantum signatures by 2030. Approach: add a `commit.alg = "dilithium3"` flag and dual-sign during transition.
2. **Chain anchor latency for sub-100ms agent loops.** ARC submission is ~100–400 ms. For ultra-low-latency agents, we may add a "deferred anchor" mode where commitments accumulate in a Merkle tree and a single anchor fires every N seconds. Trade-off: gap detection becomes coarser.
3. **Cross-tenant disclosure.** A common ask: "Auditor X can read across multiple tenants." Currently requires a viewing key per tenant. We may add a tenant-federation construct in v2.
4. **Erasure-friendly storage.** GDPR Article 17 erasure is supported via plaintext-bytes deletion (encrypted blob removed from R2/UHRP, chain commitment retained). The chain commitment structure already supports this (it commits the *plaintext hash*, not the ciphertext); needs a CLI flow.
5. **Auditor-side replay attacks.** If an auditor records the wire format of envelopes they decrypted and replays them later, they can't gain new information — but they can use it to argue "the operator showed me X before." Mitigation: auditor-side timestamps signed by the auditor on receipt. Possibly out-of-scope for v1.
6. **Chain-walk verifier extension.** v0.1's CLI verifies single events. A v0.5 extension walks `prevHash` backward to detect gaps and out-of-order anchoring across a whole agent's history. Library functions are already exposed for this; just needs CLI orchestration.

---

## 15. Versioning and stability

`provable-think` follows semver. The wire format (§5.6, §5.7) is versioned independently. Any wire-format change increments the magic prefix (`PRT1` → `PRT2`); old verifiers continue to work on old commitments forever. We will not break existing audits.

---

*Last updated: 2026-04-29 (revision v0.4.1 — multi-conversation gate added to §13). Per-conversation commit chains landed; envelope path layout extended to include conversationId; master chain anchors each conv's genesis. Schema reset; old DO orphaned. See `demo/acme-health/MULTI-CONVERSATION-PLAN.md` for the design log. Original v0.4 footer follows: 2026-04-28 (revision v0.4). v0.4 reconciles every claim in this doc against the shipped v0.1.0-alpha.0 package and the seven verified mainnet quality gates in §13. Major changes from v0.3: §1.5 split wallet-tx into v0.1 (in-Worker) / v3.0 (delegated); §2 architecture rebuilt for the actual three-external-surface topology; §5 wire formats rewritten against `package/src/*` ground truth (random per-event content keys, IV-embedded ciphertext, prevHash-bound commit hash, ProtoWallet.encrypt BRC-2 wrap, ~145–148-byte variable PRT1, JSON envelope); §6.2 reframed around `bsv-storage-cloudflare`; §7 replaced with the actual 11-step CLI pipeline; §8.3 economics recomputed at ~36 sats/commit (10× lower than v0.3's estimate); §11.4 rich-wallet pattern; §11.6 marked v3.0-only; §11.7 multi-ARC race added; §12 reference table corrected; §13 Verification Ledger added. Cf-agents references verified against `@cloudflare/think@0.4.1` and `agents@0.11.6`. BSV SDK references verified against `@bsv/sdk@2.0.13`.*
