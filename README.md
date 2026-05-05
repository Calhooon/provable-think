# provable-think

**Drop-in cryptographic audit trail for [Cloudflare Project Think](https://github.com/cloudflare/agents) agents.**

Every lifecycle hook becomes a tamper-evident, hash-chained receipt anchored to a public cryptographic timestamp ledger no operator controls. The plaintext stays encrypted off-ledger under per-event keys. Auditors with the right viewing key get the cleartext. Wrong key gets AEAD silence.

[![npm](https://img.shields.io/npm/v/provable-think?label=provable-think)](https://www.npmjs.com/package/provable-think)
[![npm](https://img.shields.io/npm/v/provable-think-verify?label=provable-think-verify)](https://www.npmjs.com/package/provable-think-verify)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why

Logs you control are not audit trails. They are testimony.

An audit trail is a record an outside party can verify *without trusting the operator*. The moment the operator can rewrite the log — or rotate the IAM that gates it, or quietly change the retention setting — the log stops being evidence.

`provable-think` puts the integrity anchor outside the operator's reach, so the answer to *"did the operator change the log?"* stops requiring trust.

The EU AI Act's Article 12 starts requiring traceable logs for every high-risk AI event in August 2026. NIST AI RMF v2 lands later this year. Federal procurement already requires AI audit trails. The window between "agents are everywhere" and "audit standards are settled" is the next 12–24 months.

---

## Live demo

**[acme-health.pages.dev](https://acme-health.pages.dev/)** — a three-pane theater showing receipts landing in real time, persona-toggled selective disclosure, an 11-step verifier, and a tamper button that flips the verifier red on AEAD failure.

Type a clinical question. Watch the operator pane fill with receipt pills as Cloudflare hooks fire and anchor to the public ledger. Click the red TAMPER button — verifier flips red on step 11. Toggle persona — same ledger, different decryption surface. Real Cloudflare Workers. Real Workers AI. Real public-ledger anchoring. Real receipts.

---

## Install

```sh
npm install provable-think
```

---

## Use

```ts
import { Think } from "@cloudflare/think";
import { withProvenance, HIPAA_PRESET } from "provable-think";

export class TriageAgent extends withProvenance(Think<Env>, {
  ...HIPAA_PRESET,
  identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
  storage:  { primary: "r2", r2: { binding: "PHI_ENVELOPES" } },
  anchor:   { network: "mainnet" },
}) {}
```

Every turn. Every tool call. Every model invocation. Every chat response. Every recovered fiber. Each one fires a cryptographically signed receipt to the public ledger in 10–30 seconds. ~145 bytes per receipt. Less than a thousandth of a cent each.

---

## Verify any receipt

The CLI ships separately so any auditor can verify any receipt without installing the full agent stack.

```sh
# 1. Inspect the CLI
npx provable-think-verify --help

# 2. Get a persona viewing key from the live demo (the demo agent issues
#    persistent persona keypairs and returns the auditor priv key inline):
curl -sX POST https://acme-health-agent.dev-a3e.workers.dev/grant/persona \
  -H 'content-type: application/json' \
  -d '{"persona":"external-auditor"}' \
  | jq '.capability + {auditorPrivKeyHex: .generatedAuditorPrivHex}' \
  > capability.json

# 3. Pick any txid from the operator pane and verify it independently:
npx provable-think-verify \
  --txid <paste-from-operator-pane> \
  --capability ./capability.json
```

Eleven steps. Signed report. Seconds. The operator cannot lie to the CLI.

Three failure modes, all distinguishable:

- **Wrong key** → AEAD silence (*"out of scope"*)
- **Tampered envelope** → SHA-256 mismatch (verifier flips red)
- **Out-of-scope event** → no decryption attempted

---

## Cost

| Line item | Cost |
|---|---|
| Public-ledger anchoring | **Less than a thousandth of a cent per receipt** |
| Encrypted envelope storage (Cloudflare R2) | **Pennies per gigabyte at standard rates** |
| Engineering integration (one line of code) | **~1 day** |
| Subpoena response (`npx provable-think-verify`) | **Seconds, not weeks** |
| Auditor onboarding (grant a scoped viewing key) | **Minutes, not weeks** |
| License | **$0 — MIT, free forever** |

At any meaningful scale, public-ledger anchoring runs roughly 50× cheaper than Splunk Enterprise and 100× cheaper than Datadog Cloud SIEM. Neither produces a log a regulator can verify.

---

## Layout

| Path | What |
|---|---|
| [`package/`](package/) | The npm package source ([`provable-think`](https://www.npmjs.com/package/provable-think)) |
| [`package/cli/`](package/cli/) | The standalone CLI verifier ([`provable-think-verify`](https://www.npmjs.com/package/provable-think-verify)) |
| [`package/test-worker/`](package/test-worker/) | A Cloudflare Worker that exercises the package end-to-end against the real public ledger |
| [`package/examples/`](package/examples/) | Minimal integration examples |
| [`demo/acme-health/`](demo/acme-health/) | The reference Three-Pane Theater deployed at `acme-health.pages.dev` |
| [`docs/`](docs/) | Engineering specification ([TECHNICAL](docs/TECHNICAL.md)), threat model ([THREAT-MODEL](docs/THREAT-MODEL.md)), and vulnerability disclosure policy ([SECURITY](docs/SECURITY.md)) |

---

## Architecture

`provable-think` extends `Think<Env>` via a higher-order class mixin. Every documented Project Think hook fires a 145-byte signed receipt to the public ledger in 10–30 seconds. The receipt's `OP_RETURN`-equivalent header carries a PRT1 magic + hookKind byte + sequence number + 32-byte SHA-256 of the canonical-JSON event payload + agent identity public key + DER signature.

The plaintext payload is encrypted under a per-event AES-256-GCM key, sealed in an AEAD envelope, and stored off-ledger in Cloudflare R2 (or in a self-hosted UHRP Worker for content-addressed redundancy). Authorized auditors receive a `ViewingCapability` containing the ECDH-derived recipient key — the agent itself enforces scope by including only authorized recipients in each envelope's recipient list.

Three trust-boundary properties:

1. **Ledger anchor lives outside any single party.** Not Cloudflare. Not the operator. Not the package author.
2. **Plaintext stays sealed off-ledger** — the public receipt commits to a hash, not the data.
3. **Disclosure is gated by keys, not by trust.** Right key → cleartext. Wrong key → AEAD silence. Mathematically enforced.

For the full specification see [`docs/TECHNICAL.md`](docs/TECHNICAL.md). For the threat model see [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md). The HIPAA preset (`HIPAA_PRESET`) covers all 18 Safe-Harbor identifier categories — see [`package/src/presets/hipaa.ts`](package/src/presets/hipaa.ts).

---

## Status

| Phase | Goal | Status |
|---|---|---|
| 0 — Spec | Architecture, threat model, HIPAA crosswalk | ✅ |
| 1 — Spike | Prove `@bsv/sdk` runs in Workers | ✅ |
| 2.1 — Full HOC + real broadcast | Every documented hook → mainnet | ✅ |
| 2.2 — BRC-78 envelope encryption + R2 | PHI never on the public ledger; auditors decrypt scope-limited | ✅ |
| 2.3 — Selective-disclosure API | grantViewingKey / revoke / audit-manifest | ✅ |
| 2.4 — Standalone verifier CLI | `npx provable-think-verify` (11-step pipeline) | ✅ |
| 2.4b — UHRP distributed storage | Encrypted envelopes on a self-hosted UHRP Worker | ✅ |
| 2.5 — HIPAA preset | Scope tags + Safe-Harbor redaction across 18 identifier categories | ✅ |
| 2.6 — Acme Health Three-Pane Theater | Live agent + persona toggle + tamper button | ✅ ([acme-health.pages.dev](https://acme-health.pages.dev/)) |
| 3.0 — Two-Worker key separation | Funding key in a separate Cloudflare account | ⏳ |
| 4.0 — `1.0.0` GA | SLSA L3 + reproducible builds + npm provenance | ⏳ |

---

## License

MIT. Copyright (c) 2026 John Calhoun.

---

## Author

Built by John Calhoun. The architecture matters more than I do — fork it, run it against your stack, and tell me what your audit trail's answer is.
