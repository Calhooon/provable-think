# provable-think-verify

Standalone CLI for verifying [`provable-think`](https://www.npmjs.com/package/provable-think) audit-trail receipts.

## Run

```sh
npx provable-think-verify --txid <id> --capability <key.json>
```

11 steps. Signed report. Seconds.

## What it does

Runs an 11-step verification pipeline:

1. Fetch the receipt transaction from the public ledger.
2. Parse the PRT1 receipt header for the commitment hash, sequence number, hook kind, and agent identity public key.
3. Hit the operator's `/commit-info` endpoint for the matching envelope manifest.
4. Fetch the encrypted envelope from the operator's storage.
5. Derive the per-event symmetric key via ECDH key exchange between the auditor's private key and the agent's public key.
6. Decrypt the AEAD payload.
7. Re-hash the recovered plaintext.
8. Compare against the on-ledger commitment.
9. Walk the previous-hash sequence to detect sequence gaps.
10. Validate the public-ledger timestamp against the envelope's claimed timestamp.
11. Sign the resulting report with the auditor's verifier key.

## Three failure modes, all distinguishable

- **Wrong key** — AEAD silence; the verifier reports "out of scope or wrong capability."
- **Tampered envelope** — SHA-256 mismatch; ciphertext decrypts but the plaintext hash does not bind to the ledger commitment.
- **Out-of-scope event** — missing recipient row; no decryption is attempted.

The auditor cannot confuse "I am not authorized" with "the operator tampered."

## Live demo

[`acme-health.pages.dev`](https://acme-health.pages.dev/) shows the verifier running in-browser against a real Cloudflare Workers AI agent emitting real receipts to a real public ledger. Click the red TAMPER button — watch step 10 flip red on AEAD failure.

## License

MIT. Copyright (c) 2026 John Calhoun.
