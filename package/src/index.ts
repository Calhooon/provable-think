/**
 * `provable-think` — public API.
 *
 * v0.1.0-alpha — full Project Think hook coverage with real mainnet PRT1
 * broadcast wiring (multi-ARC race + DO-storage UTXO management). No
 * minimum-viable shortcuts: every hook a Project Think agent fires can
 * become a cryptographically-signed BSV-mainnet anchor.
 *
 * Companion docs:
 *   ../docs/TECHNICAL.md   — full spec, threat model, wire format, BRC alignment
 *   ../docs/ADVANTAGES.md  — business framing, threats addressed, compliance
 *   ../docs/BRIEF.md       — one-page exec summary
 *
 * Roadmap (next):
 *   v0.2  BRC-78 multi-recipient envelope encryption + R2 storage + manifest
 *   v0.3  Selective-disclosure issuance API (grant / revoke / rotate)
 *   v0.4  Verifier CLI + browser dashboard
 *   v0.5  HIPAA / SOX / FedRAMP presets
 *   v1.0  Path D: route broadcast through `bsv-wallet-infra-cloudflare`
 */

export {
  withProvenance,
  type ThinkLike,
  type ProvenanceAgentAPI,
  type ViewingCapability,
  type AuditManifest,
  type AuditManifestEntry,
} from "./with-provenance.js";

export {
  type ProvenanceConfig,
  type CommitEvent,
  type CommitErrorEvent,
  type HookKind,
  HOOK_KIND_BYTES,
  PROVABLE_THINK_COMMIT_PROTOCOL,
} from "./types.js";

export {
  makeMinimalWallet,
  addressFromIdentityPubHex,
} from "./wallet.js";

export {
  broadcastArcRace,
  DEFAULT_MAINNET_ARC_URLS,
  type ArcAttempt,
  type ArcRaceResult,
  type ArcOptions,
} from "./arc.js";

export {
  assembleCommitment,
  buildPrt1OpReturnScript,
  PRT1_MAGIC,
  type AssembleArgs,
  type AssembledCommitment,
} from "./commitment.js";

export {
  ProvenanceState,
  type ProvenanceUtxo,
  type UtxoReservation,
  type ChainHead,
  type SqlStorageLike,
  type GrantScope,
  type GrantRecord,
} from "./state.js";

export {
  runCommitPipeline,
  fundingAddressFromPubHex,
  type CommitOutcome,
  type PipelineOptions,
} from "./broadcast-pipeline.js";

export {
  sealEnvelope,
  unsealEnvelope,
  verifyEnvelopeIntegrity,
  ENVELOPE_WRAP_PROTOCOL,
  type RecipientGrant,
  type EnvelopeHeader,
  type WrappedKeyEntry,
  type SealedEnvelope,
  type SealArgs,
} from "./envelope.js";

export {
  envelopeKey,
  storeEnvelope,
  fetchEnvelope,
  listEnvelopeKeys,
  type R2BucketLike,
  type R2StorageOptions,
} from "./storage-r2.js";

export {
  uploadEnvelopeToUhrp,
  fetchEnvelopeFromUhrp,
  DEFAULT_UHRP_ENDPOINT,
  DEFAULT_UHRP_PUBLIC_URL_BASE,
  type UhrpStorageConfig,
  type UhrpUploadResult,
} from "./storage-uhrp.js";

// HIPAA preset (Phase 2.5) — see docs/HIPAA-SCOPE-TAXONOMY.md and
// docs/HIPAA-AUDIT-PLAYBOOK.md.
export {
  HIPAA_PRESET,
  HIPAA_SCOPE_TAGS,
  HIPAA_SCOPE_TAGS_LIST,
  HIPAA_COMPLIANCE_OFFICER_SCOPE,
  HIPAA_EXTERNAL_AUDITOR_SCOPE,
  hipaaPatientScope,
  applyHipaaRedaction,
  HIPAA_REDACTION_VERSION,
  type HipaaScopeTag,
  type RedactedSpan,
  type RedactionResult,
} from "./presets/hipaa.js";
