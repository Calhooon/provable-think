# provable-think

[![npm](https://img.shields.io/npm/v/provable-think?label=provable-think)](https://www.npmjs.com/package/provable-think)
[![npm](https://img.shields.io/npm/v/provable-think-verify?label=provable-think-verify)](https://www.npmjs.com/package/provable-think-verify)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**The cheapest AI audit trail a regulator can actually verify just went open source.**

Less than a thousandth of a cent per audited decision. About 50× cheaper than Splunk Enterprise. About 100× cheaper than Datadog Cloud SIEM. The only one a regulator can verify without trusting your CIO, your SIEM vendor, or anyone who runs the platform.

The math is below.

---

## The bill you don't see

Run a Fortune 500 with 10,000 AI agents firing 1,000 audited decisions a day each. Today's options:

- **Splunk Enterprise** — $1.5M–$3M a year for SIEM ingestion and storage at that volume. Logs live in Splunk's cloud, gated by your IAM. A regulator will not accept *"we have Splunk"* as evidence the log was not changed.
- **Datadog Cloud SIEM** — $20–$40 per host per month. At 10K agents, that is $2.4M–$4.8M annually. Same trust-boundary problem.
- **WORM-policy S3 + custom integrity** — $30K–$100K a year in storage. Plus a 12-to-18-month engineering project to bolt on the integrity controls. Plus another year proving in court the integrity controls actually work. Estimated total program cost: $2M–$5M before anything ships.
- **External counsel responding to one regulatory subpoena** — six weeks of partner-and-associate time at $500–$1,500/hour. Roughly $400K per subpoena. Multiple subpoenas a year for any meaningful AI deployment.
- **Big 4 audit-readiness engagement** — $300K–$1M for a single AI compliance review.

That's seven figures of annual spend that, structurally, does not produce an audit trail a regulator can verify.

## The bill with `provable-think`

| Line item | Cost |
|---|---|
| Public-ledger anchoring | **Less than a thousandth of a cent per receipt** |
| Encrypted envelope storage (Cloudflare R2) | **Pennies per gigabyte at standard rates** |
| Engineering integration (one line of code on `Think<Env>`) | **~1 day** |
| Subpoena response (`npx provable-think-verify`) | **Seconds, not weeks** |
| Auditor onboarding (grant a scoped viewing key) | **Minutes, not weeks** |
| License | **$0 — MIT, free forever** |

That is the entire bill.

The anchor lives outside Cloudflare. Outside the operator. Outside any single party. The plaintext stays encrypted off-ledger under per-event keys. Right viewing key gets the cleartext. Wrong key gets AEAD silence. The agent's identity key signs every receipt.

There is no middleman in the integrity path. Not Cloudflare. Not your GRC vendor. Not your regulator's preferred SaaS. The notary is public infrastructure.

---

## Why nobody else matches this

It is not effort. It is architecture.

Splunk, Datadog, every SIEM, every WORM S3 setup, every operator-controlled log ever shipped — all of them store the audit trail inside the same trust boundary as the system whose conduct the audit is supposed to constrain. The CIO who runs the AI also rotates the IAM that gates the log. The vendor that runs the SIEM is contractually accountable to that CIO. A defendant cannot be their own judge.

The only fix is to put the integrity anchor somewhere the operator does not control. There is exactly one production-credible place to do that today at less than a thousandth of a cent per event: a public, cryptographic timestamp ledger that no single operator can lie about.

[Cloudflare Project Think](https://github.com/cloudflare/agents) is the runtime. Durable Objects survive restarts. Fibers replay deterministically. Hooks fire on a clean lifecycle. Hibernation is transparent. The runtime is extraordinary. But the runtime cannot tell a regulator *"we did not rewrite this log"* because the runtime *is* the thing writing the log. That is true of every platform, by definition. `provable-think` is the layer that closes the gap.

---

## One line of integration

```sh
npm install provable-think
```

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

Every turn. Every tool call. Every model invocation. Every chat response. Every recovered fiber. Each one fires a cryptographically signed receipt to the public ledger in 10 to 30 seconds.

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

Eleven steps. Signed report. Seconds. Three failure modes, all distinguishable:

- **Wrong key** → AEAD silence (*"out of scope"*)
- **Tampered envelope** → SHA-256 mismatch (verifier flips red)
- **Out-of-scope event** → no decryption attempted

The operator cannot lie to the CLI.

---

## Open the demo. Try to break it.

**[acme-health.pages.dev](https://acme-health.pages.dev/).** Three panes. One screen. No setup.

Type a clinical question into the triage agent. Watch the operator pane fill with receipt pills as Cloudflare hooks fire and anchor to the public ledger. Click any pill — that opens the public-ledger explorer. Permanent. Independently verifiable.

Toggle the persona selector. Compliance Officer sees full PHI under Safe Harbor. External HIPAA Auditor sees operations-tagged events only. Patient sees their own session. Same ledger. Different decryption surface.

Click the red TAMPER button. Watch an 11-step verifier flip red. AEAD failed. The public-ledger anchor is unchanged. The operator just got caught.

Not a mockup. Real Cloudflare Workers. Real Workers AI. Real public-ledger anchoring. Real R2. Real receipts.

---

## The time savings dwarf the money savings

A regulatory subpoena hits a normal AI shop today. Response: pull logs from three systems, reconcile timestamps, get the IT director to sign an integrity affidavit under oath, hope nobody changed retention six months ago. Six weeks of internal scramble while outside counsel's meter runs.

Same subpoena. `provable-think` shop:

```sh
npx provable-think-verify --txid <id> --capability <key.json>
```

Eleven steps. Signed report. Seconds.

Onboarding a new external auditor — grant a viewing key. Not provision IAM. Not sign a cascade of MNDAs. A key.

Incident forensics — walk the ledger. Not interrogate the people who own the database.

The labor savings dwarf the anchoring costs by orders of magnitude. The anchoring costs are the headline because they are the line item nobody believed.

---

## The window is closing

The EU AI Act starts enforcing Article 12 in August. Every high-risk AI system needs traceable logs of every event for the system's lifetime. NIST AI RMF v2 lands later this year. Federal procurement already requires AI audit trails. California, Colorado, and Texas have AI accountability bills moving.

Twelve to twenty-four months separates *"agents are everywhere"* from *"audit standards are settled."* The companies that build credible posture *now* define what credible looks like.

Everyone else retrofits in court.

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

## The standing offer

If a cheaper, faster, or more credible AI audit trail exists anywhere on the market, this README will be updated with the link. None has surfaced.

Pick the AI system you depend on most. Maybe your company ships it. Maybe your insurer relies on it. Maybe the agency you regulate operates it. A regulator walks in and asks: *prove the operator did not change the log.*

If the answer is *"we trust them,"* the answer is no.

The architecture that makes the answer *yes* is open source as of this morning. It runs on the platform you are already using. It costs less than a thousandth of a cent per audited decision.

`Calhooon/provable-think`. `acme-health.pages.dev`.

What's your stack's answer?

---

## License

MIT. Copyright (c) 2026 John Calhoun.
