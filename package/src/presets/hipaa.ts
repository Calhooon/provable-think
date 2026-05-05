/**
 * HIPAA preset for `provable-think`.
 *
 * Importing `HIPAA_PRESET` and spreading it into the `withProvenance` config
 * gives a HIPAA-deploying operator the right defaults for selective-
 * disclosure scoping, encryption, and Safe-Harbor inferred-PHI redaction.
 *
 * Usage:
 *
 *   import { Think } from "@cloudflare/think";
 *   import { withProvenance, HIPAA_PRESET } from "provable-think";
 *
 *   export class TriageAgent extends withProvenance(Think<Env>, {
 *     ...HIPAA_PRESET,
 *     identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
 *     storage:  { primary: "r2", r2: { binding: "PHI_ENVELOPES" } },
 *     anchor:   { network: "mainnet" },
 *     disclosure: {
 *       ...HIPAA_PRESET.disclosure,
 *       envelopeServerUrl: "https://triage-agent.acme.example",
 *     },
 *   }) {}
 *
 * Companion docs:
 *   - `docs/HIPAA-SCOPE-TAXONOMY.md` — the 8 canonical scope tags + 45 CFR
 *     citations + capability-issuance patterns for the three personas.
 *   - `docs/HIPAA-AUDIT-PLAYBOOK.md` — operational walk-through (issuance,
 *     incident response, 6-year retention, BAA addendum template).
 *
 * The preset is intentionally narrow:
 *   - Sets `encryption.algorithm` and `disclosure.defaultScopes` /
 *     `disclosure.rotationPolicy` / `disclosure.redaction` to HIPAA-safe values.
 *   - Does NOT set `identity`, `storage`, `anchor`, or `disclosure.envelopeServerUrl`
 *     — those are per-deployment and the operator must provide them.
 *   - Does NOT add a Compliance Officer pubkey to `defaultRecipients` — the
 *     preset can't know your compliance officer; add them in your config.
 */

import type { HookKind, ProvenanceConfig } from "../types.js";
import { applyHipaaRedaction, HIPAA_REDACTION_VERSION } from "./hipaa-redaction.js";

export { applyHipaaRedaction, HIPAA_REDACTION_VERSION } from "./hipaa-redaction.js";
export type { RedactedSpan, RedactionResult } from "./hipaa-redaction.js";

/**
 * The 8 canonical HIPAA scope tags (`docs/HIPAA-SCOPE-TAXONOMY.md` §2). Frozen
 * vocabulary — names will not change within the `0.x` line. Each maps to a
 * specific 45 CFR citation.
 *
 * Use these symbols instead of string literals to avoid typo risk.
 */
export const HIPAA_SCOPE_TAGS = {
  /** 45 CFR 160.103 — umbrella tag for any payload containing Protected Health Information. */
  PHI: "PHI",
  /** 45 CFR 164.501 + 164.506(c)(2) — provision/coordination/management of healthcare. */
  TREATMENT: "treatment",
  /** 45 CFR 164.501 + 164.506(c)(3) — activities to obtain reimbursement. */
  PAYMENT: "payment",
  /** 45 CFR 164.501 + 164.506(c)(1) — quality assessment, training, fraud detection, etc. */
  OPERATIONS: "operations",
  /** 45 CFR 164.514(a)–(c) — Safe Harbor or Expert Determination de-identification. */
  DE_IDENTIFIED: "de-identified",
  /** 45 CFR 164.501 + 164.508(a)(3) — communications encouraging purchase/use. Requires authorization. */
  MARKETING: "marketing",
  /** 45 CFR 164.501 + 164.512(i) — systematic investigation. Requires IRB documentation. */
  RESEARCH: "research",
  /** 45 CFR 164.514(e) — PHI with 16 direct identifiers removed. Requires DUA. */
  LIMITED_DATA_SET: "limited-data-set",
} as const;

export type HipaaScopeTag = (typeof HIPAA_SCOPE_TAGS)[keyof typeof HIPAA_SCOPE_TAGS];

/**
 * Frozen array form of the 8 tags. Useful for `Array.includes`-style
 * membership checks and for issuing a "full HIPAA scope" capability.
 */
export const HIPAA_SCOPE_TAGS_LIST: readonly HipaaScopeTag[] = Object.freeze([
  HIPAA_SCOPE_TAGS.PHI,
  HIPAA_SCOPE_TAGS.TREATMENT,
  HIPAA_SCOPE_TAGS.PAYMENT,
  HIPAA_SCOPE_TAGS.OPERATIONS,
  HIPAA_SCOPE_TAGS.DE_IDENTIFIED,
  HIPAA_SCOPE_TAGS.MARKETING,
  HIPAA_SCOPE_TAGS.RESEARCH,
  HIPAA_SCOPE_TAGS.LIMITED_DATA_SET,
]);

/**
 * Default redaction transform wired by `HIPAA_PRESET`. Runs Safe-Harbor
 * inferred-PHI redaction (45 CFR 164.514(b)(2)) on every payload before it's
 * sealed into an envelope and hashed for the on-chain commitment.
 *
 * Operators who run their own DLP pipeline can disable by overriding:
 *
 *     {
 *       ...HIPAA_PRESET,
 *       disclosure: { ...HIPAA_PRESET.disclosure, redaction: { enabled: false } },
 *     }
 */
function defaultHipaaRedactionTransform(payload: unknown, _hookKind: HookKind): unknown {
  return applyHipaaRedaction(payload).redacted;
}

/**
 * Composable HIPAA defaults. Spread into a `withProvenance` config; override
 * any field as needed.
 *
 * What this preset turns on:
 *   - `encryption.algorithm = "aes-256-gcm"` (only algorithm v0.1 ships).
 *   - `disclosure.defaultScopes = ["PHI", "treatment"]` — every envelope
 *     sealed under this preset is tagged with both scopes by default. The
 *     operator's tool wrappers can override per-event (e.g., to add `payment`
 *     for a billing-eligibility lookup, or to swap `treatment` → `operations`
 *     for a peer-review event).
 *   - `disclosure.rotationPolicy = "quarterly"` — recommended viewing-key
 *     rotation cadence for HIPAA workloads (per `HIPAA-AUDIT-PLAYBOOK.md` §4).
 *   - `disclosure.redaction = { enabled: true, transform: applyHipaaRedaction }`
 *     — automatic Safe-Harbor inferred-PHI redaction before envelope seal.
 *
 * What this preset deliberately does NOT set:
 *   - `identity`, `storage`, `anchor`, `walletInfra` — per-deployment; you
 *     supply them.
 *   - `disclosure.envelopeServerUrl` — your worker's public URL.
 *   - `disclosure.defaultRecipients` — beyond the implicit "self", every
 *     additional recipient (compliance officer, etc.) must come from your
 *     config because the preset can't know your operator-side keys.
 *   - `commit` — defaults to all hooks; if you want to commit only a subset,
 *     set `commit: ["beforeToolCall", "afterToolCall", "onChatResponse"]`.
 */
export const HIPAA_PRESET: Partial<ProvenanceConfig> = Object.freeze({
  encryption: { algorithm: "aes-256-gcm" as const },
  disclosure: {
    defaultScopes: [HIPAA_SCOPE_TAGS.PHI, HIPAA_SCOPE_TAGS.TREATMENT],
    rotationPolicy: "quarterly" as const,
    redaction: {
      enabled: true,
      transform: defaultHipaaRedactionTransform,
    },
  },
});

/**
 * Convenience: capability scope for a Compliance Officer.
 *
 * Per 45 CFR 164.501 a Compliance Officer is the load-bearing internal
 * auditor for the agent's HIPAA program. Their scope spans:
 *   - PHI access (incident review, breach investigation)
 *   - operations (QA, training audits, model + tool config verification —
 *     i.e., they can verify configureSession / getModel / getTools)
 *   - de-identified (deidentification correctness checks)
 *
 * Excludes only `payment` (billing data requires a separate authorization).
 *
 * Widened from `["PHI"]` → `["PHI", "operations", "de-identified"]` in v0.2
 * so the demo's "CO is the ultimate internal auditor — every commit
 * decryptable by them" pitch holds. Pure CO grants for older deployments
 * that explicitly want the narrower scope can pass `{ tags: ["PHI"] }`.
 */
export const HIPAA_COMPLIANCE_OFFICER_SCOPE = Object.freeze({
  tags: [
    HIPAA_SCOPE_TAGS.PHI,
    HIPAA_SCOPE_TAGS.OPERATIONS,
    HIPAA_SCOPE_TAGS.DE_IDENTIFIED,
  ],
});

/**
 * Convenience: capability scope for an External HIPAA Auditor (operations + de-identified).
 * Excludes treatment / payment plaintext (those require separate authorization).
 */
export const HIPAA_EXTERNAL_AUDITOR_SCOPE = Object.freeze({
  tags: [HIPAA_SCOPE_TAGS.OPERATIONS, HIPAA_SCOPE_TAGS.DE_IDENTIFIED],
});

/**
 * Build a Patient-persona scope tied to a specific session/agent id. The
 * patient sees PHI in their own session only.
 */
export function hipaaPatientScope(sessionAgentId: string): {
  tags: string[];
  agentIds: string[];
} {
  return {
    tags: [HIPAA_SCOPE_TAGS.PHI],
    agentIds: [sessionAgentId],
  };
}
