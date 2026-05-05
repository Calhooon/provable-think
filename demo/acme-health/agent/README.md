# Acme Health agent worker

Phase 2.6 demo agent for the Acme Health Three-Pane Theater. A Cloudflare Worker
that hosts a single `TriageAgent` Durable Object — a `Think<Env>` agent wrapped
with `provable-think` + `HIPAA_PRESET`, anchoring every lifecycle hook to BSV
mainnet.

See [`../DECISIONS.md`](../DECISIONS.md) for brand, narrative, model, and
deploy decisions. The frontend lives at `../web/` (separate package).

## Run locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in AGENT_PRIVATE_KEY_HEX + TAAL_API_KEY
npm run dev                      # wrangler dev on :8787 (or :8788 if 8787 is taken)
```

Smoke test:
```sh
curl http://localhost:8787/info
```

## Deploy

```sh
export CLOUDFLARE_API_TOKEN=$(grep -A1 'Cloudflare API token' ../../../your local credentials file | tail -1)
npm run deploy
```

The agent ships at `https://acme-health-agent.dev-a3e.workers.dev`.

## Endpoint surface

| Method | Path | Purpose |
|---|---|---|
| GET  | `/info`                 | identity, funding address, balance |
| POST | `/sync-mainnet`         | re-discover UTXOs at funding address |
| POST | `/topup`                | deposit a funding UTXO |
| GET  | `/commit-info?txid=...` | txid -> envelope key + sequence |
| GET  | `/envelope?key=...`     | encrypted-blob R2 proxy |
| GET  | `/chain-head`           | current head sequence + prevHash |
| POST | `/unseal-as-auditor`    | auditor-side decrypt + integrity verify |
| POST | `/grant/persona`        | issue a HIPAA persona capability |
| POST | `/admin/tamper`         | flip a byte in an envelope (DEMO_MODE only) |
| POST | `/scenario/seed`        | run the 3-turn warm-up scenario |
| GET  | `/ws`                   | WebSocket — live commit events |

## Layout

- `src/agent.ts`     — `TriageAgent` (Think + withProvenance + HIPAA_PRESET)
- `src/triage.ts`    — `runTriageTurn`, `runScenarioStep`
- `src/websocket.ts` — partyserver `onConnect`/`onMessage`/`onClose`
- `src/tamper.ts`    — `tamperWithEnvelope` (DEMO_MODE only)
- `src/types.ts`     — `Env`, `AgentEventEnvelope` (mirrored by web)
- `src/index.ts`     — Worker entry + DO RPC method bindings
