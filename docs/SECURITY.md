# Security Policy

**Repo status:** Public — v0.1.0-alpha.0 launched 2026-05-05.

If you discover a vulnerability in `provable-think`, the sibling repos (`bsv-storage-cloudflare`, `bsv-wallet-infra-cloudflare`), or in the verifier CLI, please report it via the channels below. **Do not open a public GitHub issue for vulnerability reports.**

---

## 1. Reporting

**Preferred channel:** *(security contact email TBD pre-launch — will be added in v4.0)*

For now (during private build-out), report via GitHub's private security advisory feature on `Calhooon/provable-think`, or via direct message to the repo owner.

**What to include:**

- A clear description of the vulnerability + the component(s) affected.
- A reproduction recipe (commands, payloads, environment).
- The estimated severity in your judgment (use the rubric below).
- Whether you have a proposed fix.
- Whether you intend to disclose publicly, on what timeline.

**What you'll get:**

- Acknowledgement within **3 business days**.
- Initial severity assessment within **7 business days**.
- A fix or mitigation plan within the timeline below, depending on severity.
- Coordinated disclosure: a fix shipped + an advisory published once a patched version is available.

We do not run a paid bug bounty during build-out. Post-v4.0 the security policy will include a researcher acknowledgement track and (if funding allows) a structured bounty.

---

## 2. Scope

### In scope

| Component | Includes |
|---|---|
| `provable-think` library | Everything under `package/src/` |
| Verifier CLI | Everything under `package/cli/` |
| Test worker | `package/test-worker/` (treats as production-shape) |
| Wire formats | PRT1 OP_RETURN payload, JSON envelope, capability JSON |
| Crypto constructions | The hash chain, signature scheme, envelope wrap, BRC-2 / BRC-42 application |
| External-service clients | `arc.ts` multi-ARC race, `storage-r2.ts`, `storage-uhrp.ts` |
| Documentation crypto/security claims | TECHNICAL.md, THREAT-MODEL.md |
| Build/release pipeline | Once SLSA L3 lands in v0.5 |

### Out of scope (file an issue, not a security report)

| Item | Why |
|---|---|
| Bugs in `@bsv/sdk` | Report upstream at `bsv-blockchain/ts-sdk`. |
| Bugs in `@cloudflare/think` | Report to Cloudflare via their channels. |
| Bugs in `bsv-storage-cloudflare` itself | That repo has its own SECURITY.md. |
| Bugs in `bsv-wallet-infra-cloudflare` | Same. |
| Issues with operator-side deployment (mis-issued capabilities, leaked wrangler secrets, etc.) | Operational, not product. |
| Compliance-attestation claims | We don't make formal compliance claims; we map to controls. |

### Explicitly out of scope, by design

These are documented in [`THREAT-MODEL.md`](./THREAT-MODEL.md) §5 and TECHNICAL.md §10.2:

- 51% attacks on BSV consensus.
- Compromised CF account where the attacker holds the agent identity priv key.
- Compromised auditors who leak content within their authorization.
- Operator-auditor collusion.
- Quantum attacks against secp256k1 / AES-256.
- Pre-image attacks "on the future" (operator pre-commits a hash for a decision they haven't yet made).
- Plaintext side-channel leakage (timing, log volume, external-API patterns).

Reports about these will be acknowledged but not patched — they're foundational assumptions or organizational concerns.

---

## 3. Severity rubric

| Severity | Definition | Response timeline |
|---|---|---|
| 🔴 **Critical** | Allows forging or undetectably tampering with audit-trail integrity, or breaking selective-disclosure guarantees, against a realistic adversary. | Patch in 7 days; coordinated disclosure 30 days post-patch. |
| 🟠 **High** | Significant operational risk or partial-disclosure failure under realistic conditions. | Patch in 14 days; coordinated disclosure 30 days post-patch. |
| 🟡 **Medium** | Limited-scope issue requiring unusual access or specific operator misconfiguration. | Next minor release; advisory in release notes. |
| 🟢 **Low** | Minor information disclosure with no integrity impact, or theoretical issue under unrealistic conditions. | Next minor release; mentioned in release notes. |

Examples (what would land where):

- **Critical:** A flaw in `commitment.ts` letting two distinct payloads produce the same commit hash. A flaw in `envelope.ts` letting a third party read content without the recipient's priv key. A bug in the verifier CLI that returns `OK` on a tampered envelope.
- **High:** Multi-ARC race silently consuming an unintended UTXO. A typed-error path that leaks a substring of `AGENT_PRIVATE_KEY_HEX` into logs. A `/commit-info` endpoint that returns wrong txid → envelope mappings under concurrent load.
- **Medium:** UHRP upload retry logic that double-pays under specific timing. R2 PUT silently discarding bytes above a configurable size with no error path.
- **Low:** Verifier CLI showing the auditor's priv key file path in a debug error message.

---

## 4. Response process

When we receive a report:

1. **Triage (≤ 3 business days).** A maintainer acknowledges receipt + assigns initial severity.
2. **Reproduction (≤ 7 business days).** A maintainer reproduces the issue locally + on `package/test-worker/` against mainnet if applicable.
3. **Fix design.** Maintainer drafts a fix; for critical/high issues, multiple maintainers review.
4. **Patch ship.** Critical/high get a hotfix release; medium/low go in the next planned release.
5. **Advisory publication.** GitHub Security Advisory + npm advisory (post-public-launch).
6. **Verification ledger entry.** If the fix touches mainnet broadcast/wire-format, the verifying mainnet round-trip txid is added to `progress.md`'s ledger as part of the patch commit.
7. **Reporter acknowledgement.** Reporters who report responsibly get credited in the advisory unless they prefer anonymity.

For wire-format-affecting fixes:
- v0.x: we may break wire format with magic-prefix bump (`PRT1` → `PRT2`) plus migration tooling. Existing chains continue to verify under the old verifier.
- Post-v1.0: wire-format changes are major-version events. Backward compatibility is non-negotiable for already-anchored audits.

---

## 5. Disclosure timeline

We follow **coordinated disclosure**:

1. Reporter and maintainers agree on a disclosure date — typically 30–90 days after a fix is available.
2. Patched release ships before disclosure.
3. Advisory + reporter credit publish on the agreed date.
4. If a fix is not feasible within 90 days of the report, we discuss with the reporter whether to extend or proceed with disclosure. We don't sit on reports indefinitely.

If a vulnerability is being actively exploited in the wild, we may shorten the timeline to ship a fix as quickly as possible, with same-day disclosure once the patch is out.

---

## 6. What's signed, what isn't

For verifiers and operators evaluating the supply chain:

- **Mainnet OP_RETURNs are signed by the agent's per-event derived signing key** (BRC-42 derived from `AGENT_PRIVATE_KEY_HEX`). Anyone verifies these from the chain alone.
- **Encrypted envelopes' content keys are wrapped via `ProtoWallet.encrypt`** — BRC-2 + BRC-42 ECDH, scoped per recipient. Decryption requires the recipient's priv key.
- **The npm package itself.** Pre-v0.5 the package is published from a maintainer machine without provenance attestation. v0.5 will switch to GitHub Actions OIDC publishing with SLSA L3. Until then, operators should pin the package version + audit the source tree before deploying. The git tag is the canonical source of truth.
- **The verifier CLI binary.** Same status as the package — pre-v0.5 no signed provenance. Auditors with high-assurance requirements should build from source and pin a known-good commit.
- **Documentation.** Not signed. Cross-reference TECHNICAL.md against the source code; both must agree.

---

## 7. Hardened deployment guidance

For operators deploying `provable-think` in regulated environments:

### 7.1 Wrangler secrets
- Store `AGENT_PRIVATE_KEY_HEX` only via `wrangler secret put`. Never commit to git, never paste into chat, never let CI logs include it.
- Rotate annually as a baseline; immediately on any suspicion of compromise.
- For high-assurance: source the secret from a hardware-backed key store (HSM, AWS Nitro, Azure Key Vault) and inject at deploy time.

### 7.2 CF account hygiene
- v0.1 consolidates identity + funding key in one CF account. Treat that account as a critical asset:
  - MFA on all accounts.
  - Scoped API tokens (no global-permission tokens).
  - IP-restricted dashboard access.
  - Separate CF account for production agent vs dev/staging.
- v3.0 splits these across two accounts; deploy to *different* CF accounts when the wallet Worker comes online.

### 7.3 R2 + UHRP storage
- R2 buckets serving envelope storage should have lifecycle policies aligned with retention requirements (HIPAA: 6 years; SEC 17a-4: 6 years; HHS Safe Harbor: longer).
- UHRP via `bsv-storage-cloudflare`: self-host if you control the storage layer end-to-end. The reference deployment is for evaluation only.
- Always set a fallback backend (`storage.fallback`) so a single backend outage doesn't stall the agent.

### 7.4 Verifier distribution
- Distribute capability JSON to auditors over an authenticated, encrypted channel (PGP'd email, secure portal, signed Slack DM with auth-link). Capability files contain the auditor's priv key; treat them as bearer tokens.
- Audit-time: provide the auditor a pinned, signed copy of the verifier CLI when v0.5 attestation lands. Until then, instruct auditors to verify the npm tarball hash against the published version.

### 7.5 Monitoring
- Wire `onCommitError` to your alerting (PagerDuty, Splunk, etc.). Repeated commit failures = operational issue *or* security signal.
- Monitor R2/UHRP 4xx rates; an attacker probing storage is one of the few visible signals from outside the agent runtime.
- Track funding wallet balance + auto-top-up; UTXO drain is a slow-motion DoS.

---

## 8. Security-relevant changes since v0.1

| Date | Change | Severity | Status |
|---|---|---|---|
| 2026-04-28 | v0.1 released — first audited shipping version | n/a | Live |

(This table will grow as advisories are published.)

---

## 9. Acknowledgements

Security researchers who report responsibly will be credited here (with consent).

---

*Last updated: 2026-04-28 (v0.4).*
