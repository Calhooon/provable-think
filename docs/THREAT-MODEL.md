# Threat Model

**Status:** v0.4 (covers `provable-think@0.1.0-alpha.0`).
**Companion docs:** [`TECHNICAL.md`](./TECHNICAL.md) §10 (narrative threat model), [`SECURITY.md`](./SECURITY.md).

This doc is the **structured** threat model — STRIDE matrices per component plus an adversary capability table. See `TECHNICAL.md` §10 for prose narratives.

STRIDE: **S**poofing identity · **T**ampering with data · **R**epudiation · **I**nformation disclosure · **D**enial of service · **E**levation of privilege.

---

## 1. Component inventory

| # | Component | Holds | Trusted by |
|---|---|---|---|
| C1 | **Agent Worker** (provable-think HOC) | Agent identity priv key (signs commits) + funding priv key (pays). v0.1: same key. | Operator, downstream agent code. |
| C2 | **DO SQLite (pt_state, pt_utxos, pt_commits, pt_grants)** | Chain head, UTXO pool, commit log, active grants. | Agent Worker. |
| C3 | **R2 envelope bucket** | Encrypted envelope JSON blobs. | Agent Worker (write); auditors (read via `/envelope` proxy). |
| C4 | **`bsv-storage-cloudflare` UHRP host** *(optional)* | Encrypted envelope JSON blobs (mirror or primary). | Agent Worker (paid upload); auditors (anonymous public read). |
| C5 | **Multi-ARC race (GorillaPool, TaaL)** | In-flight transactions (transient). | Agent Worker (broadcast). |
| C6 | **BSV mainnet** | PRT1 OP_RETURN commitments (permanent). | Everyone (public). |
| C7 | **Operator's public Worker endpoints** (`/commit-info`, `/envelope`) | Read-only proxies to C2 + C3. | Auditors. |
| C8 | **Verifier CLI** (`provable-think-verify`) | Auditor's priv key + capability JSON (locally). | Auditor. |
| C9 | **WhatsOnChain** | Tx hex (read-only indexer). | Verifier CLI. |
| C10 | **Wallet Worker** *(v3.0 only)* | Funding priv key (separated from agent identity). | v3.0 Agent Worker. **Not present in v0.1.** |

---

## 2. STRIDE matrix per component

Severity legend:
- **🔴 Critical** — direct compromise of audit-trail integrity or selective-disclosure guarantees.
- **🟠 High** — significant operational risk; mitigated by design choices below.
- **🟡 Medium** — limited blast radius; documented residual.
- **🟢 Low** — acknowledged, residual after defense, or out-of-scope per §10.2 of TECHNICAL.md.

### C1: Agent Worker

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **S** | Adversary spawns a fake "agent" and signs commits under a legit identity | 🔴 | `AGENT_PRIVATE_KEY_HEX` is a CF wrangler secret (env binding); not exposed to the agent code path. Forging requires extracting the secret from the CF account. |
| **T** | Agent code is altered post-deploy by a CF account admin | 🟠 | Future commits would faithfully reflect the altered code; **past** commits remain valid (chain immutability). Mitigation: `extensionAuthored` commits (v0.2) anchor self-authored TypeScript hashes; CI/CD attestation + commit-signed deploys for the operator's own code. |
| **R** | Operator denies the agent made a particular decision | 🔴 → 🟢 | Every `onChatResponse` is signed by the agent identity key and anchored on chain. Non-repudiation is a *core* property. |
| **I** | Agent runtime leaks plaintext via logs / metrics / panic traces | 🟠 | Plaintext only exists in-memory during sealing; never logged. Sensitive payloads use canonical-JSON serialization which doesn't include type comments or stack info. |
| **D** | Adversary floods the agent to exhaust the funding UTXO and stall commits | 🟠 | `runCommitPipeline` reserves a UTXO per commit; OOM on funds returns a typed error (`"Insufficient funds"`) and the hook still completes (provenance is async via `ctx.waitUntil`). Operator is alerted via `onCommitError` callback or pending-queue threshold. Mitigation: auto-top-up policy (operator-side); rate-limit at the CF firewall layer. |
| **E** | Compromised tool (called via `beforeToolCall`) escalates to read DO state | 🟠 | Tools run inside the agent code's privilege; CF DurableObject sandboxing applies. The package itself doesn't expose a privileged execution surface to tools — `__pt_*` methods are private. |

### C2: DO SQLite

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **T** | Direct SQL alteration of `pt_commits` to misreport txid → envelope key mappings | 🟠 | A tampered `/commit-info` response is caught at step 7 of the verifier pipeline (chain `commitHash` ≠ operator-reported `commitHash`). The auditor never trusts `/commit-info` blindly. |
| **T** | Alteration of `pt_state.chain_head` to fork the chain | 🔴 → 🟡 | Sequence rollback would be detected: any verifier walking back across the gap sees mismatched `prevHash`. Within a session, the in-Worker `reserveNextSequence()` is atomic — concurrent hooks can't double-allocate. |
| **I** | DO state inspection by CF account admin reveals UTXO topology | 🟢 | Out-of-scope — same actor that holds the priv key. UTXO topology by itself isn't privileged. |

### C3: R2 envelope bucket

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **T** | Operator (or compromised CF admin) edits or replaces a stored envelope | 🔴 → 🟡 | Step 11 of verifier (`SHA-256(plaintext) == envelope.header.plaintextHash`) catches any byte change. The plaintext hash is bound into the on-chain `commitHash` via `prevHash || canonical(payload)`. |
| **D** | Operator deletes envelopes for inconvenient sequences | 🟠 | Verifier sees: chain has commitment, R2 returns 404. `step 9: fetch envelope failed` is the alarm. Auditors should walk the full chain at audit time. UHRP mirror eliminates this attack — multi-host content-addressed storage. |
| **I** | Anonymous reads of R2 reveal *which* sequences exist | 🟢 | The encrypted blob is unreadable without the wrap. Sequence enumeration is also visible from chain (PRT1 OP_RETURNs). |

### C4: `bsv-storage-cloudflare` UHRP host (optional)

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **T** | UHRP host alters an uploaded blob | 🔴 → 🟡 | Same step-11 plaintext-hash check as C3. UHRP is content-addressed: any byte change changes the hash, and the operator can mirror to other hosts. |
| **D** | UHRP host refuses to serve | 🟠 | Operator configures a fallback (`storage.fallback: "r2"`) or runs multiple UHRP hosts. Self-hosted `bsv-storage-cloudflare` puts this control with the operator. |
| **I** | UHRP host learns *who is auditing what* via download patterns | 🟡 | Public reads are anonymous (no auth required); downloads are over plain HTTPS. UHRP hosts can correlate IP+timing. Mitigation: use Tor or a CDN, or operate multiple geographic hosts. |
| **E** | UHRP host bills the operator extra by lying about file size | 🟢 | The 402 challenge is signed (BRC-105); the satoshi amount is part of the AuthFetch request. Disputes traceable on chain. |

### C5: Multi-ARC race (GorillaPool, TaaL)

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **D** | Both ARCs refuse to broadcast | 🟡 | Multi-ARC race makes simultaneous failure rare; operators can configure additional ARC URLs. Pending commits queue in DO storage; retried on next hook. |
| **R** | An ARC accepts the tx but never propagates | 🟡 | `X-WaitFor: SEEN_ON_NETWORK` requires confirmation from the ARC's peers. TaaL alone often stalls at `ANNOUNCED_TO_NETWORK`; the race wins via GorillaPool when this happens. |
| **I** | An ARC operator inspects the tx and learns the agent's funding pattern | 🟢 | OP_RETURN commits are public anyway. Funding addresses are pseudonymous; operators can rotate. |
| **E** | An ARC operator front-runs the tx for fees | 🟢 | OP_RETURN txs have no economic value to front-run (they're zero-output to the broadcaster). |

### C6: BSV mainnet

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **T** | 51% attacker rewrites recent blocks | 🔴 → 🟢 | Out-of-scope per TECHNICAL §10.2. Foundational assumption (same as TLS treats SHA-256 break as out-of-scope). |
| **D** | Miners refuse to include the tx | 🟡 | Mempool eventually rebroadcasts. Multi-ARC race already routes via well-connected miners. |
| **I** | Public observer reads commitments | 🟢 | Designed property: only hash + sig + sequence are public. PHI / PII are in encrypted envelopes off chain. |

### C7: Operator's public endpoints (`/commit-info`, `/envelope`)

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **S** | Adversary spoofs the operator's domain to feed forged commit-info | 🟠 | Verifier cross-checks operator's `commitHash` against on-chain `commitHash` at step 7. Forged response detected. Operator should still serve over HTTPS with valid certs. |
| **T** | Operator returns an attacker-supplied envelope key | 🟠 | Same step-7 + step-11 cross-checks. The envelope's plaintextHash must reproduce the chain's commitHash construction. |
| **D** | Operator takes endpoints offline at audit time | 🟠 | Auditor still has the chain. UHRP-stored envelopes can be fetched directly at `${publicUrlBase}/${fileName}` without `/envelope` proxy. v0.5 may add envelope publication via WhatsOnChain Block Tag-style indexing. |
| **I** | Endpoints leak which envelopes exist | 🟢 | Same as C3. |
| **E** | Endpoint accepts unauthenticated POSTs to mutate state | 🔴 → ✓ | Both endpoints are GET-only and read-only. POST returns 405. |

### C8: Verifier CLI (`provable-think-verify`)

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **S** | Malicious binary impersonates the verifier | 🟠 | CLI is a 360-line Node script, source-available. Auditors can read + run from npm with `npx provable-think-verify` (lockfile + integrity hash). High-assurance auditors should pin to a specific package version + verify the package's npm provenance. |
| **T** | Verifier tampered to skip integrity checks | 🟠 | Same — read + audit the source. CI builds publish provenance attestations (v0.5 SLSA target). |
| **I** | Verifier writes the auditor's priv key to disk on error | 🟢 | Source review confirms it doesn't. The CLI accepts the key via the capability JSON file path; the key never leaves the auditor's machine. |
| **R** | Auditor claims the verifier returned a different result than it did | 🟢 | `--json` mode emits a single self-describing JSON object the auditor can sign + retain. v0.5 will sign verifier output with the auditor's identity. |

### C9: WhatsOnChain

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **T** | WoC returns a different tx hex than was actually mined | 🔴 → 🟡 | Auditor can fetch the same txid from any other indexer (TAAL, GorillaPool's WhatsOnChain mirror, a self-run BSV node). The tx hex is canonical — a fake hex would fail signature verification immediately. |
| **D** | WoC is offline | 🟢 | Multiple indexers exist; the verifier CLI is configurable to point at any. |

### C10: Wallet Worker (v3.0 only)

| | Threat | Severity | Mitigation |
|---|---|---|---|
| **(v3.0)** | Wallet Worker compromise | 🟠 | Funding priv key exposed; cannot forge commitments (agent identity stays in agent Worker); cannot decrypt envelopes (no viewing keys). Past chain remains valid. |

In v0.1 this component does not exist; the agent Worker holds both key classes.

---

## 3. Adversary capability matrix

Cross-cuts all components. Each adversary in a distinct row; columns are *what they can do* and *what they cannot*. This is the single most-cited table by auditors.

| Adversary | Can | Cannot |
|---|---|---|
| **Public observer** | Read on-chain commitments (hash + sig + sequence). Enumerate sequences over time. | Decrypt anything. Identify content. Identify model used. Identify decisions made. |
| **Network MITM** | Observe encrypted envelope traffic in flight (R2 PUT, UHRP upload, public GETs). Drop or delay packets. | Decrypt. Modify undetectably. Substitute envelopes (TLS + step-11 hash check). |
| **R2 / UHRP storage operator** | Delete or refuse to serve ciphertext. Mirror to other hosts. Charge for storage (UHRP). | Forge new commitments. Decrypt without viewing key. Tamper undetectably. |
| **ARC operator (GorillaPool / TaaL)** | Refuse to broadcast (multi-ARC race mitigates). Inspect tx contents (public anyway). | Tamper with already-mined txs. Forge txs (no priv key). |
| **Cloudflare account admin (v0.1: holds both key classes)** | Inspect agent runtime; stop the agent; modify Durable Object code. Drain the funding UTXO. Issue forged commitments going forward. | Forge past commitments (chain immutability). Decrypt past envelopes if recipient priv key is held externally (auditor's local machine). |
| **Cloudflare account admin (v3.0: split)** | Compromise of agent-Worker account: forge new identity sigs, can't pay. Compromise of wallet-Worker account: can't forge sigs, can drain UTXOs. | Both at once requires compromising both accounts. |
| **Operator (master key holder, all CF accounts)** | Issue/revoke viewing keys. Rotate identity (with redeploy). Selectively destroy plaintext envelopes (chain commitment hash remains). | Rewrite past chain. Forge auditor signatures. Bypass chain ordering. |
| **Authorized auditor** | Decrypt envelopes within their scope. Verify chain integrity. Walk back across `prevHash`. | Decrypt out-of-scope. Forge new commitments. Read other auditors' scopes. |
| **Compromised auditor** | Same as authorized auditor (they have a real key). | Re-encrypt content under a new scope (no operator key). |
| **BSV miner (single block)** | Refuse to include a transaction (delaying anchoring). | Tamper with already-mined commitments. |
| **51% attacker on BSV** | Rewrite recent blocks. | Out-of-scope per TECHNICAL §10.2. |

---

## 4. Trust assumptions

These are the foundational assumptions everything above rests on. Violation of any of them invalidates parts of the model.

1. **secp256k1 + AES-256-GCM are not broken.** Standard cryptographic hardness assumption. Quantum break is a known long-tail risk; post-quantum upgrade is a roadmap item.
2. **BSV consensus holds.** A 51% attack would rewrite history. Out-of-scope.
3. **`@bsv/sdk@2.0.13` correctly implements BRC-2/BRC-42/BRC-77.** We pin to a specific version; upstream regressions would invalidate `ProtoWallet.encrypt` semantics. Mitigation: lockfile + npm provenance attestation when published.
4. **Cloudflare's DO storage is durable.** The agent Worker assumes its DO survives migrations, restarts, and cold starts. A silent corruption of `pt_state` or `pt_utxos` would be detected at next sequence allocation (if `chain_head` is wrong, the chain shows `prevHash` mismatch on the next commit) but could in principle cause double-spending of UTXOs. Mitigation: CF DO consistency model is sound; recovery via `syncFromMainnet()` rebuilds UTXO state from chain.
5. **The auditor's local machine isn't compromised.** If the auditor's machine is owned by a different attacker, the priv key in their capability JSON leaks. The verifier CLI doesn't currently encrypt the local priv key; for high-assurance audits, run inside a hardware-secured enclave (TPM-bound key storage, AWS Nitro, etc.).
6. **The `AGENT_PRIVATE_KEY_HEX` env binding is delivered securely.** Wrangler's secret-put flow uses TLS to CF API; root cause for the secret depends on operator process. Compromise of the deploy pipeline = compromise of the agent identity (see C1: T).

---

## 5. Out-of-scope explicitly

Listed here so an auditor doesn't expect us to address them.

- **Compromised agent runtime.** If the CF DurableObject is itself executing malicious code, our commitments faithfully record what it did — they don't prevent it. Defense-in-depth via Cloudflare's sandbox + operator-side CI/CD attestation, not us.
- **Compromised auditor.** An authorized auditor who leaks decrypted content has done so within their authorization. Forward rotation prevents future leakage; past disclosure is not recallable. This is a property of all envelope-encryption systems.
- **Social engineering.** An operator tricked into granting a viewing key to the wrong recipient is a process failure, not a crypto failure.
- **Operator-auditor collusion.** If the parties whose adversarial relationship the system depends on are colluding, the chain still records facts but disclosure semantics break down.
- **Plaintext side channels.** If the agent's tool calls leak state through timing, log volume, or external-API patterns, we can't detect that.
- **Quantum attacks.** ECDSA + AES-256 are quantum-vulnerable. Post-quantum migration is a v3.0+ roadmap item; not addressed today.
- **Pre-image attacks "on the future".** The operator could pre-compute a future commitment hash for a decision they have not yet made and broadcast it early. This locks in *intent* before action; it does not let them retroactively alter completed history.

---

## 6. Threats addressed by design (cross-reference)

| Threat | Where it's defeated |
|---|---|
| Post-hoc log tampering by operator | Chain immutability (C6) + step-11 plaintext-hash check |
| Selective deletion of inconvenient events | Sequence-gap detection in chain walk |
| Backdating by operator | Block height vs envelope timestamp comparison (default tolerance: 1 hour) |
| Compelled disclosure via subpoena | Scoped viewing keys — operator discloses only what's ordered |
| Insider tampering | Per-agent identity keypair + chain immutability |
| Agent impersonation | ECDSA over commit hash; verifiers reject signatures not matching agent pubkey |
| Silent model swap | `getModel()` commitment (v0.2 — not yet in v0.1) |
| Prompt injection forensics | `beforeTurn` commitment of input context hash |
| Tool-result spoofing | `afterToolCall` commitment of result hash |
| Self-modifying agent code tampering | `extensionAuthored` commitment (v0.2 — wire format reserved) |
| Hibernation tampering | `onFiberRecovered` commitment of recovery checkpoint hash |
| Disputed audit | Deterministic, reproducible verification any party can run |

See `TECHNICAL.md` §10 for full prose narratives.

---

## 7. Defense evolution (tied to roadmap)

| Defense | v0.1 | v0.2 | v0.5 | v3.0 |
|---|---|---|---|---|
| Per-event chain commit | ✓ | ✓ | ✓ | ✓ |
| Selective disclosure | ✓ | ✓ | ✓ | ✓ |
| Multi-ARC race | ✓ | ✓ | ✓ | ✓ |
| Per-event derived signing key | ✓ | ✓ | ✓ | ✓ |
| `getModel`/`getTools`/`configureSession` commits | — | ✓ | ✓ | ✓ |
| `extensionAuthored` commit (self-authored TS anchoring) | — | ✓ | ✓ | ✓ |
| In-band `KeyRotation` commitment | — | — | ✓ | ✓ |
| Chain-walk verifier (sequence-gap detection) | — | — | ✓ | ✓ |
| Signed-manifest fallback for offline auditors | — | — | ✓ | ✓ |
| Funding-key separation (wallet Worker) | — | — | — | ✓ |
| Post-quantum dual-sign | — | — | — | (v4.0) |

See the README Status table for the per-version delivery plan.

---

*Last updated: 2026-04-28 (v0.4).*
