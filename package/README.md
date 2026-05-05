# provable-think

Drop-in cryptographic audit trail for [Cloudflare Project Think](https://github.com/cloudflare/agents) agents.

Every lifecycle hook becomes a tamper-evident, hash-chained receipt anchored to a public cryptographic timestamp ledger no operator controls. The plaintext stays encrypted off-ledger under per-event keys. Auditors with the right viewing key get the cleartext. Wrong key gets AEAD silence.

## Why

Logs you control are not audit trails. They are testimony. An audit trail is a record an outside party can verify *without trusting the operator*. `provable-think` puts the integrity anchor outside the operator's reach, so the answer to "did the operator change the log?" stops requiring trust.

## Install

```sh
npm install provable-think
```

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

Every turn, every tool call, every model invocation, every chat response, every recovered fiber fires a cryptographically signed receipt to the public ledger in 10 to 30 seconds.

## Live demo

[`acme-health.pages.dev`](https://acme-health.pages.dev/) — a three-pane theater showing receipts landing in real time, a persona-toggled selective-disclosure surface, an 11-step verifier, and a tamper button that flips the verifier red on AEAD failure.

## Verifier CLI

```sh
npx provable-think-verify --txid <id> --capability <key.json>
```

11 steps. Signed report. Seconds. See [`provable-think-verify`](https://www.npmjs.com/package/provable-think-verify) for the full pipeline.

## Cost

Less than a thousandth of a cent per audited decision. Encrypted envelope storage on Cloudflare R2 at standard rates. License: $0 — MIT, free forever.

## Status

`0.1.0-alpha.0` — the surface documented above ships today. Ongoing roadmap items (additional lifecycle hook coverage, two-Worker key separation, build provenance) are tracked in the GitHub repo.

## License

MIT. Copyright (c) 2026 John Calhoun.
