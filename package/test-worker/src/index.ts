/**
 * provable-think — Phase 2.1 E2E test worker.
 *
 * Real Cloudflare DO worker that imports the `provable-think` package as a
 * file: dep and wraps a stub Think class with `withProvenance`. Endpoints
 * exercise the full agent surface: identity, funding, commit triggers,
 * mainnet verification.
 *
 * Quality gate: every published `provable-think` version must be able to
 * round-trip a real PRT1 commitment to BSV mainnet through this worker.
 */

import { DurableObject } from "cloudflare:workers";
import {
  withProvenance,
  fetchEnvelope,
  unsealEnvelope,
  verifyEnvelopeIntegrity,
  uploadEnvelopeToUhrp,
  fetchEnvelopeFromUhrp,
  DEFAULT_UHRP_ENDPOINT,
  DEFAULT_UHRP_PUBLIC_URL_BASE,
  HIPAA_PRESET,
  HIPAA_COMPLIANCE_OFFICER_SCOPE,
  HIPAA_EXTERNAL_AUDITOR_SCOPE,
  hipaaPatientScope,
  type HookKind,
} from "provable-think";
import { buildTriageSteps } from "./scenarios/hipaa-triage.js";

interface Env {
  TEST_AGENT: DurableObjectNamespace;
  AGENT_PRIVATE_KEY_HEX?: string;
  ARC_URLS?: string;
  TAAL_API_KEY?: string;
  ENVELOPES: R2Bucket;
}

/**
 * Minimal stub of the `@cloudflare/think` `Think<Env>` surface.
 * `withProvenance` overrides every hook with provenance-emitting versions;
 * the user's app-side overrides (the ones that *do* the model-call work)
 * still get called via super.
 */
class StubThink<E = unknown> extends DurableObject<E> {
  // Project Think hook surface (no-ops by default; user overrides for behavior).
  async beforeTurn(_ctx: unknown): Promise<void> {}
  async beforeStep(_ctx: unknown): Promise<void> {}
  async beforeToolCall(_ctx: unknown): Promise<void> {}
  async afterToolCall(_ctx: unknown): Promise<void> {}
  async onStepFinish(_ctx: unknown): Promise<void> {}
  async onChunk(_ctx: unknown): Promise<void> {}
  async onChatResponse(_result: unknown): Promise<void> {}
  async onChatRecovery(_ctx: unknown): Promise<void> {}
  async onFiberRecovered(_ctx: unknown): Promise<void> {}
}

/**
 * The test DO class — wraps StubThink with `withProvenance` and exposes a
 * fetch handler that routes test endpoints.
 */
const ARC_URLS_FALLBACK = [
  "https://arc.gorillapool.io",
  "https://api.taal.com/arc",
];

export class TestAgent extends withProvenance(StubThink<Env>, {
  // Phase 2.5: spread HIPAA_PRESET to wire Safe-Harbor inferred-PHI redaction
  // and the canonical scope vocabulary. Per-event scope tags can still be
  // overridden via `commitSync(hookKind, payload, { scopeTags: [...] })`.
  ...HIPAA_PRESET,
  identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
  anchor: {
    network: "mainnet",
    arcUrls: ARC_URLS_FALLBACK, // can be overridden at construction in v0.2
  },
  storage: {
    primary: "r2",
    r2: { binding: "ENVELOPES", pathPrefix: "provable-think-e2e" },
  },
  disclosure: {
    ...HIPAA_PRESET.disclosure,
    defaultRecipients: [
      { id: "self", counterparty: "self" },
      // Additional recipients can be added here (e.g. compliance officer pubkey)
    ],
    // For local dev, the verifier CLI will hit this URL to fetch /commit-info
    // and /envelope. Replace with the deployed worker URL in production.
    envelopeServerUrl: "http://localhost:8787",
  },
}) {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/":
        case "/help":
          return text(HELP);

        case "/info": {
          const [address, pubKey, balance] = await Promise.all([
            this.getFundingAddress(),
            this.getIdentityPublicKey(),
            this.getFundingBalance(),
          ]);
          return json({ address, pubKey, balance });
        }

        case "/sync-mainnet": {
          if (request.method !== "POST")
            return text("POST required", 405);
          const result = await this.syncFromMainnet();
          return json(result);
        }

        case "/topup": {
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json()) as {
            rawTxHex?: string;
            outputIndex?: number;
            valueSatoshis?: number;
          };
          if (
            !body.rawTxHex ||
            typeof body.outputIndex !== "number" ||
            typeof body.valueSatoshis !== "number"
          ) {
            return text(
              "POST body must have { rawTxHex, outputIndex, valueSatoshis }",
              400,
            );
          }
          const result = await this.topUp({
            rawTxHex: body.rawTxHex,
            outputIndex: body.outputIndex,
            valueSatoshis: body.valueSatoshis,
          });
          return json(result);
        }

        case "/commit": {
          // Synchronously commit a hook event so the test can inspect the
          // mainnet broadcast result. Optional body: { hookKind, payload }.
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            hookKind?: HookKind;
            payload?: unknown;
          };
          const hookKind = body.hookKind ?? "onChatResponse";
          const payload = body.payload ?? {
            test: "Hello, mainnet!",
            via: "provable-think E2E test worker",
            ts: new Date().toISOString(),
          };
          const outcome = await this.commitSync(hookKind, payload);
          return json(outcome);
        }

        case "/generate-auditor-keypair": {
          // Generate an auditor identity keypair for E2E testing of the
          // selective-disclosure flow. NOT a production endpoint.
          const { PrivateKey, Utils } = await import("@bsv/sdk");
          const k = PrivateKey.fromRandom();
          const pub = k.toPublicKey();
          return json({
            privateKeyHex: k.toHex(),
            publicKeyHex: Utils.toHex(pub.encode(true) as number[]),
            address: pub.toAddress(),
            note:
              "This keypair belongs to a hypothetical auditor. Pass " +
              "publicKeyHex to /grant; pass privateKeyHex to /unseal-as-auditor.",
          });
        }

        case "/grant": {
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            recipientPubHex?: string;
            scope?: import("provable-think").GrantScope;
            label?: string;
            validUntil?: string;
          };
          if (!body.recipientPubHex) {
            return text("body.recipientPubHex required", 400);
          }
          const cap = await this.grantViewingKey({
            recipientPubHex: body.recipientPubHex,
            scope: body.scope,
            label: body.label,
            validUntil: body.validUntil,
          });
          return json(cap);
        }

        case "/revoke": {
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            id?: string;
          };
          if (!body.id) return text("body.id required", 400);
          const result = await this.revokeViewingKey({ id: body.id });
          return json(result);
        }

        case "/grants": {
          const result = await this.listViewingKeys();
          return json(result);
        }

        case "/audit-manifest": {
          const result = await this.exportAuditManifest();
          return json(result);
        }

        case "/unseal-as-auditor": {
          // Auditor-side decrypt: the auditor brings their own identity
          // priv key + the envelope storage key + the grant id (which
          // matches the recipient_id stored in the envelope).
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            envelopeKey?: string;
            auditorPrivKeyHex?: string;
            recipientId?: string; // grant id
          };
          if (!body.envelopeKey || !body.auditorPrivKeyHex || !body.recipientId)
            return text(
              "body { envelopeKey, auditorPrivKeyHex, recipientId } all required",
              400,
            );

          const env = (this as unknown as { env: Env }).env;
          const envelope = await fetchEnvelope(env.ENVELOPES, body.envelopeKey);
          if (!envelope) return text("envelope not found at that key", 404);

          const { ProtoWallet, PrivateKey } = await import("@bsv/sdk");
          const auditorWallet = new ProtoWallet(
            PrivateKey.fromHex(body.auditorPrivKeyHex),
          );
          // The auditor needs the agent's identity pubkey to compute ECDH.
          const agentIdentityPubHex = await this.getIdentityPublicKey();

          let plaintextBytes: number[];
          let unsealError: string | undefined;
          try {
            plaintextBytes = await unsealEnvelope({
              wallet: auditorWallet,
              envelope,
              recipientId: body.recipientId,
              agentIdentityPubHex,
            });
          } catch (e) {
            return json({
              ok: false,
              integrityOk: false,
              error: (e as Error).message,
              recipients: envelope.recipients.map((r) => ({
                id: r.id,
                counterparty: r.counterparty,
              })),
            });
          }
          const integrityOk = verifyEnvelopeIntegrity(envelope, plaintextBytes);
          const plaintext = new TextDecoder().decode(
            new Uint8Array(plaintextBytes),
          );
          return json({
            ok: integrityOk,
            envelopeKey: body.envelopeKey,
            integrityOk,
            agentIdentityPubHex,
            recipientId: body.recipientId,
            header: envelope.header,
            plaintext,
            note: "Decrypted by an external auditor using their own identity priv key + the agent's identity pub key (BRC-42 ECDH) + the grant scope-keyed wrapping. Integrity check confirms the on-chain commitment hash matches the canonical plaintext.",
          });
        }

        case "/commit-and-upload-uhrp": {
          // Phase 2.4b quality gate: seal envelope (manually here so we can
          // pass it to UHRP), commit to chain, upload encrypted blob to
          // bsv-storage-cloudflare via the rich-wallet AuthFetch (BRC-103/104
          // + BRC-29 payment via 402 retry), return the UHRP public URL.
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            payload?: unknown;
          };

          // First do a regular commit (chain anchor + R2 envelope).
          const outcome = await this.commitSync("onChatResponse", body.payload ?? {
            test: "Hello UHRP!",
            ts: new Date().toISOString(),
          });
          if (!outcome.ok || !outcome.envelope?.storageKey) {
            return json({ ok: false, stage: "commit", outcome });
          }
          // Fetch the envelope we just stored to R2 so we can re-upload to UHRP.
          const env = (this as unknown as { env: Env }).env;
          const r2Obj = await env.ENVELOPES.get(outcome.envelope.storageKey);
          if (!r2Obj)
            return json({ ok: false, stage: "fetch-r2", outcome });
          const envelopeJson = await r2Obj.text();
          const envelope = JSON.parse(envelopeJson) as Parameters<
            typeof uploadEnvelopeToUhrp
          >[0]["envelope"];

          // Now upload to UHRP via the rich wallet AuthFetch (handles BRC-29 402).
          const authFetch = await this.getAuthFetch();
          let uhrpResult: Awaited<ReturnType<typeof uploadEnvelopeToUhrp>>;
          try {
            uhrpResult = await uploadEnvelopeToUhrp({
              envelope,
              authFetch,
              config: {
                endpoint: DEFAULT_UHRP_ENDPOINT,
                publicUrlBase: DEFAULT_UHRP_PUBLIC_URL_BASE,
              },
            });
          } catch (e) {
            return json({
              ok: false,
              stage: "uhrp-upload",
              outcome,
              error: (e as Error).message,
            });
          }

          return json({
            ok: true,
            chainTxid: outcome.txid,
            chainExplorer: `https://whatsonchain.com/tx/${outcome.txid}`,
            r2EnvelopeKey: outcome.envelope.storageKey,
            uhrpUrl: uhrpResult.url,
            uhrpUploadedBytes: uhrpResult.uploadedBytes,
            uhrpPaidSatoshis: uhrpResult.paidSatoshis,
            uhrpElapsedMs: uhrpResult.elapsedMs,
          });
        }

        case "/uhrp-fetch-and-verify": {
          // Phase 2.4b verification step: fetch the envelope from a UHRP URL
          // (no auth, public read), unseal as self, verify integrity matches
          // the on-chain commitment.
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            uhrpUrl?: string;
          };
          if (!body.uhrpUrl)
            return text("body.uhrpUrl required", 400);
          const envelope = await fetchEnvelopeFromUhrp(body.uhrpUrl);
          const env = (this as unknown as { env: Env }).env;
          const { ProtoWallet, PrivateKey } = await import("@bsv/sdk");
          const wallet = new ProtoWallet(
            PrivateKey.fromHex(env.AGENT_PRIVATE_KEY_HEX as string),
          );
          const plaintextBytes = await unsealEnvelope({
            wallet,
            envelope,
            recipientId: "self",
          });
          const integrityOk = verifyEnvelopeIntegrity(envelope, plaintextBytes);
          return json({
            ok: integrityOk,
            integrityOk,
            uhrpUrl: body.uhrpUrl,
            header: envelope.header,
            recipients: envelope.recipients.map((r) => ({
              id: r.id,
              counterparty: r.counterparty,
            })),
            plaintext: new TextDecoder().decode(new Uint8Array(plaintextBytes)),
          });
        }

        case "/uhrp-probe": {
          // Probe bsv-storage-cloudflare via AuthFetch with the agent's RICH
          // wallet (real createAction support). AuthFetch handles 402 BRC-105
          // micropayments automatically by building BRC-29 payment txs from
          // the agent's funding wallet.
          const authFetch = await this.getAuthFetch();
          const baseUrl = "https://bsv-storage-cloudflare.dev-a3e.workers.dev";
          const results: Record<string, unknown> = {};
          // Probe likely nanostore-protocol endpoints
          // Real UHRP URL from /list of our most recent upload.
          const REAL_UHRP_URL = "uhrp://XUUb6AiKeq27Z7osatzVhpi8z4qm1tWwTjxeyAuBoY4femnVNaf8";
          const probes: Array<{ method: string; path: string; body?: unknown }> = [
            { method: "GET", path: `/find?uhrpUrl=${encodeURIComponent(REAL_UHRP_URL)}` },
          ];
          for (const p of probes) {
            const u = baseUrl + p.path;
            try {
              const init: { method: string; headers?: Record<string, string>; body?: string } = {
                method: p.method,
              };
              if (p.body !== undefined) {
                init.headers = { "content-type": "application/json" };
                init.body = JSON.stringify(p.body);
              }
              const r = await authFetch.fetch(u, init);
              const text = await r.text();
              let body: unknown;
              try {
                body = JSON.parse(text);
              } catch {
                body = { _raw: text.slice(0, 300) };
              }
              results[`${p.method} ${p.path}`] = { http_status: r.status, body };
            } catch (e) {
              results[`${p.method} ${p.path}`] = { error: (e as Error).message };
            }
          }
          return json(results);
        }

        case "/commit-info": {
          // Public lookup: GET /commit-info?txid=... → { sequence, hookKind,
          // commitHash, ts, envelopeKey }. Verifiers use this to map a
          // mainnet txid to the corresponding R2 envelope path.
          const txidParam = url.searchParams.get("txid");
          if (!txidParam || !/^[0-9a-fA-F]{64}$/.test(txidParam)) {
            return text("query param 'txid' must be 64-char hex", 400);
          }
          const sql = (
            this as unknown as { ctx: { storage: { sql: any } } }
          ).ctx.storage.sql;
          const row = sql
            .exec(
              "SELECT sequence, hook_kind, commit_hash, created_at FROM pt_commits WHERE txid = ? LIMIT 1",
              txidParam,
            )
            .toArray()[0];
          if (!row) return text("no commitment recorded for that txid", 404);
          // Reconstruct the envelope storage key.
          const agentIdentityPubHex = await this.getIdentityPublicKey();
          const agentShort = agentIdentityPubHex.slice(0, 16);
          const month = new Date(row.created_at)
            .toISOString()
            .slice(0, 7);
          const envelopeKey = `provable-think-e2e/default/${agentShort}/${month}/${String(row.sequence).padStart(12, "0")}.env.json`;
          return json({
            txid: txidParam,
            sequence: row.sequence,
            hookKind: row.hook_kind,
            commitHash: row.commit_hash,
            ts: new Date(row.created_at).toISOString(),
            envelopeKey,
            agentIdentityPubHex,
          });
        }

        case "/envelope": {
          // GET /envelope?key=...  — public-readable R2 proxy. Encrypted blobs
          // are safe to expose without auth (decryption needs a viewing key).
          // Used by the standalone `provable-think verify` CLI for fetch.
          const k = url.searchParams.get("key");
          if (!k) return text("query param 'key' required", 400);
          const env = (this as unknown as { env: Env }).env;
          const obj = await env.ENVELOPES.get(k);
          if (!obj) return text("envelope not found", 404);
          const body = await obj.text();
          return new Response(body, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }

        case "/chain-head": {
          // Public summary so the verifier CLI can detect gaps.
          // Returns: { sequence, prevHash, agentIdentityPubHex }
          const env = (this as unknown as { env: Env }).env;
          // Use the ProvenanceState directly via casts.
          const sql = (this as unknown as {
            ctx: { storage: { sql: any } };
          }).ctx.storage.sql;
          const headRow = sql
            .exec("SELECT value FROM pt_state WHERE key = 'chain_head'")
            .toArray()[0];
          const head = headRow ? JSON.parse(headRow.value) : null;
          const agentIdentityPubHex = await this.getIdentityPublicKey();
          return json({ head, agentIdentityPubHex, env: env ? "present" : "absent" });
        }

        case "/unseal": {
          // Decrypt a stored envelope as the agent itself ("self" recipient)
          // and verify it round-trips against the on-chain commitment hash.
          // Body: { envelopeKey: string }
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            envelopeKey?: string;
          };
          if (!body.envelopeKey)
            return text("body.envelopeKey required", 400);

          const env = (this as unknown as { env: Env }).env;
          const envelope = await fetchEnvelope(
            env.ENVELOPES,
            body.envelopeKey,
          );
          if (!envelope) return text("envelope not found at that key", 404);

          // Use the same wallet the agent uses (per-DO ProtoWallet) to
          // decrypt the "self" recipient.
          const { ProtoWallet, PrivateKey } = await import("@bsv/sdk");
          const wallet = new ProtoWallet(
            PrivateKey.fromHex(env.AGENT_PRIVATE_KEY_HEX as string),
          );
          const plaintextBytes = await unsealEnvelope({
            wallet,
            envelope,
            recipientId: "self",
          });
          const integrityOk = verifyEnvelopeIntegrity(envelope, plaintextBytes);
          // Decode plaintext as UTF-8 (it's canonical-JSON).
          const plaintext = new TextDecoder().decode(
            new Uint8Array(plaintextBytes),
          );
          return json({
            ok: integrityOk,
            envelopeKey: body.envelopeKey,
            integrityOk,
            header: envelope.header,
            recipients: envelope.recipients.map((r) => ({
              id: r.id,
              counterparty: r.counterparty,
              keyID: r.keyID,
            })),
            plaintext,
          });
        }

        case "/scenario/hipaa-triage": {
          // Phase 2.5 quality-gate scenario. Runs the full clinical-triage
          // arc as 3 sequential synchronous mainnet broadcasts, each with
          // its own scope tags. Returns the txids + envelope storage keys
          // so the verifier CLI can be pointed at them per persona.
          if (request.method !== "POST")
            return text("POST required", 405);
          const steps = buildTriageSteps();
          const results: Array<{
            label: string;
            hookKind: HookKind;
            scopeTags: string[];
            ok: boolean;
            txid?: string;
            txStatus?: string;
            sequence?: number;
            envelopeKey?: string;
            commitHash?: string;
            feeSats?: number;
            error?: string;
            elapsedMs?: number;
          }> = [];
          for (const step of steps) {
            const outcome = await this.commitSync(
              step.hookKind,
              step.payload,
              { scopeTags: step.scopeTags },
            );
            // Reconstruct the envelope storage key so the auditor CLI can
            // be pointed straight at it (no /commit-info hop required).
            let envelopeKey: string | undefined;
            let sequence: number | undefined;
            if (outcome.ok && outcome.txid) {
              const sql = (
                this as unknown as { ctx: { storage: { sql: any } } }
              ).ctx.storage.sql;
              const row = sql
                .exec(
                  "SELECT sequence, created_at FROM pt_commits WHERE txid = ? LIMIT 1",
                  outcome.txid,
                )
                .toArray()[0];
              if (row) {
                sequence = row.sequence;
                const agentIdentityPubHex = await this.getIdentityPublicKey();
                const agentShort = agentIdentityPubHex.slice(0, 16);
                const month = new Date(row.created_at)
                  .toISOString()
                  .slice(0, 7);
                envelopeKey = `provable-think-e2e/default/${agentShort}/${month}/${String(row.sequence).padStart(12, "0")}.env.json`;
              }
            }
            results.push({
              label: step.label,
              hookKind: step.hookKind,
              scopeTags: step.scopeTags,
              ok: outcome.ok,
              txid: outcome.txid,
              txStatus: outcome.txStatus,
              sequence,
              envelopeKey,
              commitHash: outcome.commitHash,
              feeSats: outcome.feeSats,
              error: outcome.error,
              elapsedMs: outcome.elapsedMs,
            });
            if (!outcome.ok) break; // halt on first failure
          }
          const ok = results.every((r) => r.ok);
          const totalSats = results.reduce((s, r) => s + (r.feeSats ?? 0), 0);
          return json({
            ok,
            scenario: "hipaa-triage",
            preset: "HIPAA_PRESET",
            redactionEnabled: true,
            steps: results,
            totalFeeSats: totalSats,
            note:
              "All payloads passed through Safe-Harbor inferred-PHI redaction " +
              "before envelope sealing. Compliance Officer (scope: PHI) " +
              "decrypts all 3 events; Patient (scope: PHI + own agentId) " +
              "decrypts all 3; External HIPAA Auditor (scope: operations + " +
              "de-identified) decrypts only the onChatResponse event.",
          });
        }

        case "/grant/persona": {
          // Phase 2.5 helper: issue a viewing capability for one of the
          // three canonical HIPAA personas. The auditor's pubkey comes from
          // the body so the operator can hand it out-of-band.
          if (request.method !== "POST")
            return text("POST required", 405);
          const body = (await request.json().catch(() => ({}))) as {
            persona?: "compliance-officer" | "patient" | "external-auditor";
            recipientPubHex?: string;
            sessionAgentId?: string; // required for patient persona
            label?: string;
            validUntil?: string;
          };
          if (!body.persona || !body.recipientPubHex) {
            return text(
              "body requires { persona, recipientPubHex } and (for patient) sessionAgentId",
              400,
            );
          }
          let scope: import("provable-think").GrantScope;
          let label = body.label;
          switch (body.persona) {
            case "compliance-officer":
              scope = HIPAA_COMPLIANCE_OFFICER_SCOPE as import("provable-think").GrantScope;
              label = label ?? "HIPAA Compliance Officer (full PHI scope)";
              break;
            case "external-auditor":
              scope = HIPAA_EXTERNAL_AUDITOR_SCOPE as import("provable-think").GrantScope;
              label = label ?? "External HIPAA Auditor (operations + de-identified)";
              break;
            case "patient": {
              if (!body.sessionAgentId)
                return text(
                  "patient persona requires body.sessionAgentId",
                  400,
                );
              scope = hipaaPatientScope(body.sessionAgentId);
              label = label ?? "Patient (own session only)";
              break;
            }
            default:
              return text(`unknown persona: ${body.persona}`, 400);
          }
          const cap = await this.grantViewingKey({
            recipientPubHex: body.recipientPubHex,
            scope,
            label,
            validUntil: body.validUntil,
          });
          return json({ persona: body.persona, scope, capability: cap });
        }

        default:
          return text("not found", 404);
      }
    } catch (e) {
      const err = e as Error;
      return json(
        { ok: false, error: err.message, stack: err.stack },
        500,
      );
    }
  }
}

const HELP = `provable-think E2E test worker

  GET  /help                  — this text
  GET  /info                  — identity, funding address, balance
  POST /sync-mainnet          — discover unspent UTXOs at funding address (WhatsOnChain)
  POST /topup                 — { rawTxHex, outputIndex, valueSatoshis } — manually add a UTXO
  POST /commit                — synchronously commit a hook (default: onChatResponse)
                                 body: { hookKind?, payload? }
                                 returns: { ok, txid, txStatus, fee_sats, ... }

  POST /scenario/hipaa-triage → run the Phase 2.5 clinical-triage scenario (3 mainnet broadcasts).
                                Returns { steps: [{ txid, scopeTags, envelopeKey, ... }] }.
  POST /grant/persona         → issue a HIPAA persona capability.
                                body: { persona: "compliance-officer"|"patient"|"external-auditor",
                                         recipientPubHex, [sessionAgentId for patient], [label], [validUntil] }

E2E flow:
  1. /info                          → check identity + balance
  2. /sync-mainnet                  → pull UTXOs from chain (one-time setup)
  3. /commit                        → broadcast a real PRT1 OP_RETURN
  4. inspect outcome.txid on https://whatsonchain.com/tx/<txid>

HIPAA E2E flow (Phase 2.5):
  1. /generate-auditor-keypair × 3   → keys for CO / Patient / External auditor
  2. /scenario/hipaa-triage          → run triage (3 broadcasts), capture sequence + agentId
  3. /grant/persona × 3              → grants for CO / Patient / External, scoped per taxonomy
  4. /unseal-as-auditor              → verify each persona decrypts the right subset
`;

// ===== Worker entry =====

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single-DO test worker: route every request to a stable DO id "test".
    const id = env.TEST_AGENT.idFromName("test");
    const stub = env.TEST_AGENT.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ===== helpers =====

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
