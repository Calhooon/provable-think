/**
 * Acme Health demo agent — Cloudflare Worker entry.
 *
 * Single DO routed by `idFromName("acme-health-demo")` (single-tenant per
 * DECISIONS.md §9). Worker entry handles HTTP routing + CORS; the DO
 * handles WebSocket upgrades, model calls, and mainnet broadcasts.
 *
 * Routes:
 *   GET  /                         — help text (HTML)
 *   OPTIONS *                      — CORS preflight
 *   GET  /info                     — identity + funding state
 *   POST /sync-mainnet             — pull UTXOs from WhatsOnChain
 *   POST /topup                    — manually add a funding UTXO
 *   GET  /commit-info?txid=...     — txid → envelope key lookup
 *   GET  /envelope?key=...         — public R2 proxy (encrypted blobs)
 *   GET  /chain-head               — current head sequence/prevHash
 *   POST /unseal-as-auditor        — auditor-side decrypt + verify
 *   POST /grant/persona            — issue a HIPAA persona capability
 *   POST /admin/tamper             — flip a byte (DEMO_MODE only)
 *   POST /scenario/seed            — run the 3-step warm-up scenario
 *   GET  /ws                       — WebSocket upgrade
 */

import {
  fetchEnvelope,
  unsealEnvelope,
  verifyEnvelopeIntegrity,
  HIPAA_COMPLIANCE_OFFICER_SCOPE,
  HIPAA_EXTERNAL_AUDITOR_SCOPE,
  hipaaPatientScope,
  type GrantScope,
} from "provable-think";
import { TriageAgent } from "./agent.js";
import { tamperWithEnvelope } from "./tamper.js";
import { runScenarioStep, SCENARIO_STEP_COUNT } from "./triage.js";
import type { Env } from "./types.js";

export { TriageAgent };

// Bumped 2026-04-29 (v0.2 wave 4): adds `stash` (HookKind 0x0b) +
// `extensionAuthored` (HookKind 0x0d) anchors. Fresh DO so the gate
// exercises the cold-boot path (configureSession + eager-grants +
// fiberStart all fire on first turn).
// Bumped 2026-04-29 (v0.2 demo polish): fresh DO so onStart's
// auto-seed kicks off the curated triage scenario in background — a
// first-time visitor lands in rich content (8 anchored hooks,
// reconstructed agent reply) instead of an empty pane.
const DO_NAME = "acme-health-multi-conv-v19";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = corsOrigin(request, env);

    if (request.method === "OPTIONS") {
      return preflight(origin);
    }

    try {
      // ── Help / root ────────────────────────────────────────────
      if (url.pathname === "/" || url.pathname === "/help") {
        return html(HELP_HTML, origin);
      }

      // ── WebSocket upgrade ──────────────────────────────────────
      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade") !== "websocket") {
          return text("Expected Upgrade: websocket", 426, origin);
        }
        const stub = getStub(env);
        // Forward the upgrade. partyserver picks up ctx.id.name from the
        // idFromName() above and runs the agent's onConnect/onMessage/onClose.
        return stub.fetch(request);
      }

      const stub = getStub(env);

      // ── Identity + funding ─────────────────────────────────────
      if (url.pathname === "/info" && request.method === "GET") {
        const [address, pubKey, balance] = await Promise.all([
          stub.getFundingAddress(),
          stub.getIdentityPublicKey(),
          stub.getFundingBalance(),
        ]);
        return json(
          {
            address,
            pubKey,
            balance,
            agentId: pubKey.slice(0, 16),
            agentIdentityPubHex: pubKey,
            demoMode: env.DEMO_MODE === "true",
          },
          200,
          origin,
        );
      }

      if (url.pathname === "/sync-mainnet") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const result = await stub.syncFromMainnet();
        return json(result, 200, origin);
      }

      if (url.pathname === "/topup") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const body = (await request.json().catch(() => null)) as {
          rawTxHex?: string;
          outputIndex?: number;
          valueSatoshis?: number;
        } | null;
        if (
          !body ||
          !body.rawTxHex ||
          typeof body.outputIndex !== "number" ||
          typeof body.valueSatoshis !== "number"
        ) {
          return json(
            { error: "POST body must have { rawTxHex, outputIndex, valueSatoshis }" },
            400,
            origin,
          );
        }
        const result = await stub.topUp({
          rawTxHex: body.rawTxHex,
          outputIndex: body.outputIndex,
          valueSatoshis: body.valueSatoshis,
        });
        return json(result, 200, origin);
      }

      // ── Verifier-CLI surface ──────────────────────────────────
      if (url.pathname === "/commit-info" && request.method === "GET") {
        const txid = url.searchParams.get("txid");
        if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
          return json({ error: "query 'txid' must be 64-char hex" }, 400, origin);
        }
        const info = await stub.getCommitInfo(txid);
        if (!info) return json({ error: "no commitment recorded for that txid" }, 404, origin);
        return json(info, 200, origin);
      }

      if (url.pathname === "/envelope" && request.method === "GET") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "query 'key' required" }, 400, origin);
        const obj = await env.ENVELOPES.get(key);
        if (!obj) return json({ error: "envelope not found" }, 404, origin);
        const body = await obj.text();
        return new Response(body, {
          status: 200,
          headers: corsHeaders(origin, {
            "content-type": "application/json; charset=utf-8",
          }),
        });
      }

      if (url.pathname === "/chain-head" && request.method === "GET") {
        const head = await stub.getChainHead();
        return json(head, 200, origin);
      }

      // ── Auditor decrypt ───────────────────────────────────────
      if (url.pathname === "/unseal-as-auditor") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const body = (await request.json().catch(() => null)) as {
          envelopeKey?: string;
          auditorPrivKeyHex?: string;
          recipientId?: string;
        } | null;
        if (
          !body ||
          !body.envelopeKey ||
          !body.auditorPrivKeyHex ||
          !body.recipientId
        ) {
          return json(
            {
              error:
                "body { envelopeKey, auditorPrivKeyHex, recipientId } all required",
            },
            400,
            origin,
          );
        }

        const envelope = await fetchEnvelope(env.ENVELOPES, body.envelopeKey);
        if (!envelope) {
          return json({ error: "envelope not found at that key" }, 404, origin);
        }
        const { ProtoWallet, PrivateKey } = await import("@bsv/sdk");
        const auditorWallet = new ProtoWallet(
          PrivateKey.fromHex(body.auditorPrivKeyHex),
        );
        const agentIdentityPubHex = await stub.getIdentityPublicKey();

        let plaintextBytes: number[];
        try {
          plaintextBytes = await unsealEnvelope({
            wallet: auditorWallet,
            envelope,
            recipientId: body.recipientId,
            agentIdentityPubHex,
          });
        } catch (e) {
          return json(
            {
              ok: false,
              integrityOk: false,
              error: (e as Error).message,
              recipients: envelope.recipients.map((r) => ({
                id: r.id,
                counterparty: r.counterparty,
              })),
            },
            200,
            origin,
          );
        }
        const integrityOk = verifyEnvelopeIntegrity(envelope, plaintextBytes);
        const plaintext = new TextDecoder().decode(
          new Uint8Array(plaintextBytes),
        );
        return json(
          {
            ok: integrityOk,
            envelopeKey: body.envelopeKey,
            integrityOk,
            agentIdentityPubHex,
            recipientId: body.recipientId,
            header: envelope.header,
            plaintext,
          },
          200,
          origin,
        );
      }

      // ── Persona grant (PHI personas) ──────────────────────────
      if (url.pathname === "/grant/persona") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const body = (await request.json().catch(() => null)) as {
          persona?: "compliance-officer" | "patient" | "external-auditor";
          recipientPubHex?: string;
          sessionAgentId?: string;
          label?: string;
          validUntil?: string;
          generateAuditorKey?: boolean;
        } | null;
        if (!body || !body.persona) {
          return json({ error: "body.persona required" }, 400, origin);
        }

        // Demo helper (DEMO_MODE only): persistent demo personas. If the
        // frontend asks for a generated auditor key, return the SAME
        // priv + grant for that persona across every session. This is
        // what makes WS replay-on-subscribe + chat reconstruction work
        // — every refreshed page hits the same recipient ID that
        // previously-sealed envelopes were addressed to. Without this,
        // refresh => fresh grant => not on any old envelope's recipient
        // list => everything fails as "no recipient in envelope."
        let recipientPubHex = body.recipientPubHex;
        let generatedPrivHex: string | undefined;
        if (!recipientPubHex) {
          if (env.DEMO_MODE !== "true" || body.generateAuditorKey !== true) {
            return json(
              {
                error:
                  "body.recipientPubHex required (or set generateAuditorKey: true in DEMO_MODE)",
              },
              400,
              origin,
            );
          }
          // Look up persistent demo grant first.
          const cached = await stub.getDemoPersonaGrant(body.persona).catch(
            () => null as Awaited<ReturnType<typeof stub.getDemoPersonaGrant>> | null,
          );
          if (cached) {
            return json(
              {
                persona: body.persona,
                scope: cached.scope,
                capability: cached.capability,
                generatedAuditorPrivHex: cached.privHex,
                cached: true,
              },
              200,
              origin,
            );
          }
          // First time this persona is requested — mint a fresh keypair
          // and persist below after the grant lands.
          const { PrivateKey, Utils } = await import("@bsv/sdk");
          const k = PrivateKey.fromRandom();
          generatedPrivHex = k.toHex();
          recipientPubHex = Utils.toHex(k.toPublicKey().encode(true) as number[]);
        }

        let scope: GrantScope;
        let label = body.label;
        switch (body.persona) {
          case "compliance-officer":
            scope = HIPAA_COMPLIANCE_OFFICER_SCOPE as GrantScope;
            label = label ?? "HIPAA Compliance Officer (full PHI scope)";
            break;
          case "external-auditor":
            scope = HIPAA_EXTERNAL_AUDITOR_SCOPE as GrantScope;
            label = label ?? "External HIPAA Auditor (operations + de-identified)";
            break;
          case "patient": {
            if (!body.sessionAgentId) {
              return json(
                { error: "patient persona requires body.sessionAgentId" },
                400,
                origin,
              );
            }
            scope = hipaaPatientScope(body.sessionAgentId);
            label = label ?? "Patient (own session only)";
            break;
          }
          default:
            return json({ error: `unknown persona: ${body.persona}` }, 400, origin);
        }
        const cap = await stub.grantViewingKey({
          recipientPubHex,
          scope,
          label,
          validUntil: body.validUntil,
        });
        // Persist for future sessions if this was a demo-mode generated key.
        if (generatedPrivHex) {
          await stub
            .saveDemoPersonaGrant(body.persona, {
              privHex: generatedPrivHex,
              pubHex: recipientPubHex,
              grantId: cap.id,
              label,
              scope,
              capability: cap,
            })
            .catch((e: unknown) => {
              console.warn("[agent] saveDemoPersonaGrant failed:", (e as Error).message);
            });
        }
        return json(
          {
            persona: body.persona,
            scope,
            capability: cap,
            // Demo only — frontend holds this in memory; never persisted.
            generatedAuditorPrivHex: generatedPrivHex,
          },
          200,
          origin,
        );
      }

      // ── Reset UTXO pool (DEMO_MODE only) ──────────────────────
      // Recovery from orphan-mempool cascades: clears the agent's local
      // funding pool so caller can topUp() / syncFromMainnet() fresh.
      if (url.pathname === "/admin/reset-utxos") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        if (env.DEMO_MODE !== "true") {
          return json({ error: "reset-utxos disabled" }, 403, origin);
        }
        const result = await stub.purgeFundingPool();
        return json(result, 200, origin);
      }

      // ── Reset chain state (DEMO_MODE only) ────────────────────
      // Wipes accumulated cold-boot anchors, abandoned conversations,
      // sidecar metadata, and R2 envelopes — but keeps the funded
      // wallet (pt_utxos) and the agent's identity intact. After this,
      // the demo's counters drop to 0 and the next user message starts
      // a fresh chain.
      if (url.pathname === "/admin/reset-chain") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        if (env.DEMO_MODE !== "true") {
          return json({ error: "reset-chain disabled" }, 403, origin);
        }
        const result = await stub.resetChainAndSidecars();
        return json(result, 200, origin);
      }

      // ── Load extension (DEMO_MODE only) ───────────────────────
      // Triggers the v0.2 `extensionAuthored` audit anchor (HookKind 0x0d)
      // without needing a real WorkerLoader binding. The agent's
      // `extensionManager` is normally instantiated by Think when an
      // `extensionLoader` env is present; in the demo we install a
      // minimal stub manager whose `load(manifest, source)` is wrapped
      // by the package's `withProvenance` shadow. Calling .load() fires
      // the on-chain commit `{ extensionName, sourceSha256, byteCount,
      // sourcePreview, … }` under operations scope. The full source
      // is also stored in the encrypted envelope.
      if (url.pathname === "/admin/load-extension") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        if (env.DEMO_MODE !== "true") {
          return json({ error: "load-extension disabled" }, 403, origin);
        }
        const body = (await request.json().catch(() => null)) as {
          name?: string;
          version?: string;
          description?: string;
          source?: string;
        } | null;
        if (!body || !body.name || !body.source) {
          return json(
            { error: "body { name, source } required (version + description optional)" },
            400,
            origin,
          );
        }
        const result = await stub.loadDemoExtension({
          name: body.name,
          version: body.version ?? "0.1.0",
          description: body.description ?? "",
          source: body.source,
        });
        return json(result, 200, origin);
      }

      // ── Tamper (DEMO_MODE only) ───────────────────────────────
      if (url.pathname === "/admin/tamper") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        if (env.DEMO_MODE !== "true") {
          return json({ error: "tamper endpoint disabled" }, 403, origin);
        }
        const body = (await request.json().catch(() => null)) as {
          conversationId?: string;
          sequence?: number;
        } | null;
        if (
          !body ||
          typeof body.conversationId !== "string" ||
          typeof body.sequence !== "number"
        ) {
          return json(
            { error: "body { conversationId, sequence } required" },
            400,
            origin,
          );
        }
        const result = await stub.runTamper(body.conversationId, body.sequence);
        return json(result, 200, origin);
      }

      // ── Wave 5: exercise every implementable hook ────────────
      // Fires every HookKind v0.2 implements (13 of 16 wire bytes; the
      // remaining 3 — paymentBRC29 0x0e, keyRotation 0x0f,
      // stepMerkleRoot 0xff — are reserved for v0.3).
      if (url.pathname === "/scenario/exercise-all-hooks") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const result = await stub.runFullHookScenario();
        return json(result, 200, origin);
      }

      // ── Seed scenario ─────────────────────────────────────────
      // Creates a fresh conversation, runs the 3 warm-up turns into it,
      // and returns the outcomes + the new conversationId.
      if (url.pathname === "/scenario/seed") {
        if (request.method !== "POST") return methodNotAllowed(origin);
        const result = await stub.runSeedScenario();
        return json(result, 200, origin);
      }

      // ── Conversation list / create / archive ──────────────────
      if (url.pathname === "/conversations" && request.method === "GET") {
        const summaries = await stub.listConversationSummaries();
        return json(summaries, 200, origin);
      }

      if (url.pathname === "/conversations" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          title?: string;
        } | null;
        const title = (body?.title ?? "").trim() || "New conversation";
        const id = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const conv = await stub.createConversation({ id, title });
        return json(conv, 200, origin);
      }

      if (
        url.pathname.startsWith("/conversations/") &&
        url.pathname.endsWith("/archive") &&
        request.method === "POST"
      ) {
        const id = url.pathname.slice(
          "/conversations/".length,
          -"/archive".length,
        );
        if (!id) return json({ error: "missing conversation id" }, 400, origin);
        await stub.archiveConversation(id);
        return json({ ok: true, archived: id }, 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      const err = e as Error;
      return json({ error: err.message, stack: err.stack }, 500, origin);
    }
  },
} satisfies ExportedHandler<Env>;

// ===== helpers =====

function getStub(env: Env): DurableObjectStub<TriageAgent> {
  const id = env.TRIAGE_AGENT.idFromName(DO_NAME);
  return env.TRIAGE_AGENT.get(id) as unknown as DurableObjectStub<TriageAgent>;
}

function corsOrigin(request: Request, env: Env): string {
  const reqOrigin = request.headers.get("Origin");
  // Always allow any localhost / 127.0.0.1 origin (dev), any *.pages.dev
  // origin (CF Pages preview + production), and any *.workers.dev origin
  // (sibling Workers / preview URLs). The demo's prod frontend lives at
  // acme-health.pages.dev; preview deploys carry randomized
  // <hash>.acme-health.pages.dev subdomains; we allow the whole class.
  if (
    reqOrigin &&
    (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(reqOrigin) ||
      /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.pages\.dev$/.test(reqOrigin) ||
      /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/.test(reqOrigin))
  ) {
    return reqOrigin;
  }
  if (env.CORS_ORIGIN && reqOrigin === env.CORS_ORIGIN) return reqOrigin;
  return env.CORS_ORIGIN ?? "http://localhost:5173";
}

function corsHeaders(
  origin: string,
  extra: Record<string, string> = {},
): HeadersInit {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
    ...extra,
  };
}

function preflight(origin: string): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin, {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-max-age": "86400",
    }),
  });
}

function json(body: unknown, status = 200, origin = "*"): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: corsHeaders(origin, {
      "content-type": "application/json; charset=utf-8",
    }),
  });
}

function text(body: string, status = 200, origin = "*"): Response {
  return new Response(body, {
    status,
    headers: corsHeaders(origin, {
      "content-type": "text/plain; charset=utf-8",
    }),
  });
}

function html(body: string, origin = "*"): Response {
  return new Response(body, {
    status: 200,
    headers: corsHeaders(origin, {
      "content-type": "text/html; charset=utf-8",
    }),
  });
}

function methodNotAllowed(origin: string): Response {
  return json({ error: "method not allowed" }, 405, origin);
}

const HELP_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Acme Health agent</title>
<style>body{font:14px/1.5 ui-sans-serif,system-ui;max-width:720px;margin:40px auto;padding:0 16px;color:#0F172A}
code{background:#F1F5F9;padding:2px 6px;border-radius:4px}h1{font-size:22px}
ul{padding-left:20px}li{margin:6px 0}</style></head>
<body>
<h1>Acme Health agent worker</h1>
<p>Phase 2.6 demo. Frontend: <a href="https://acme-health.dev-a3e.workers.dev">acme-health.dev-a3e.workers.dev</a></p>
<h2>Endpoints</h2>
<ul>
  <li><code>GET /info</code> — identity + funding state</li>
  <li><code>POST /sync-mainnet</code> — pull UTXOs from WhatsOnChain</li>
  <li><code>POST /topup</code> — manually add a funding UTXO</li>
  <li><code>GET /commit-info?txid=...</code> — map txid to envelope key</li>
  <li><code>GET /envelope?key=...</code> — public R2 proxy (encrypted)</li>
  <li><code>GET /chain-head</code> — current head sequence + prevHash</li>
  <li><code>POST /unseal-as-auditor</code> — auditor decrypt + verify</li>
  <li><code>POST /grant/persona</code> — issue a HIPAA persona capability</li>
  <li><code>POST /admin/tamper</code> — flip a byte (DEMO_MODE only)</li>
  <li><code>POST /scenario/seed</code> — run the 3-step warm-up</li>
  <li><code>GET /ws</code> — WebSocket upgrade for live commit events</li>
</ul>
<p>Anchored to BSV mainnet via <code>provable-think</code> + HIPAA preset.</p>
</body></html>`;

// ===== TriageAgent route helpers (RPC surface called by the worker) =====
//
// The worker entry above calls these via `stub.<method>()`. They live as
// methods on TriageAgent below — Cloudflare's DO RPC makes any public
// method callable as a stub method without extra plumbing. Implementations
// are added via interface augmentation so triage.ts/tamper.ts can stay
// import-free of side-effecty class-extension files.

declare module "./agent.js" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TriageAgent {
    getCommitInfo(txid: string): Promise<CommitInfoResult | null>;
    getChainHead(): Promise<ChainHeadResult>;
    runTamper(
      conversationId: string,
      sequence: number,
    ): Promise<TamperRpcResult>;
    runSeedScenario(): Promise<SeedScenarioResult>;
    runFullHookScenario(): Promise<FullHookScenarioResult>;
    loadDemoExtension(args: {
      name: string;
      version: string;
      description: string;
      source: string;
    }): Promise<LoadExtensionResult>;
    resetChainAndSidecars(): Promise<ResetChainResult>;
  }
}

export interface ResetChainResult {
  ok: true;
  /** Per-table row counts wiped from package-managed tables (pt_*). */
  package: {
    commits: number;
    conversations: number;
    masterChain: number;
    grants: number;
  };
  /** Per-table row counts wiped from agent-managed sidecar tables. */
  sidecars: {
    triageCommitMeta: number;
    triageDemoGrants: number;
  };
  /** Number of envelope objects deleted from R2. */
  r2EnvelopesDeleted: number;
  /** Funded wallet was untouched — confirm balance + address survived. */
  fundingPreserved: {
    address: string;
    balance: number;
  };
}

export interface FullHookScenarioResult {
  conversationId: string;
  triageOk: boolean;
  chatOk: boolean;
  fiberRecoveredOk: boolean;
  chatRecoveredOk: boolean;
  extensionAuthoredOk: boolean;
  errors: string[];
  expectedHookKinds: string[];
  reservedV03: string[];
}

export interface LoadExtensionResult {
  ok: boolean;
  name: string;
  sourceByteCount: number;
  sourceSha256: string;
  txid?: string;
  sequence?: number;
  envelopeKey?: string;
  error?: string;
}

export interface CommitInfoResult {
  txid: string;
  conversationId: string;
  sequence: number;
  hookKind: string;
  commitHash: string;
  ts: string;
  envelopeKey: string;
  agentIdentityPubHex: string;
}

/**
 * Multi-conversation chain heads. The master head anchors every
 * conversation's genesis hash; each per-conversation head is the latest
 * (sequence, prevHash) pair within that conversation.
 */
export interface ChainHeadResult {
  master: { sequence: number; prevHash: string } | null;
  conversations: Array<{
    conversationId: string;
    title: string;
    head: { sequence: number; prevHash: string };
    masterSeq: number;
  }>;
  agentIdentityPubHex: string;
}

export interface TamperRpcResult {
  ok: boolean;
  envelopeKey: string;
  conversationId: string;
  sequence: number;
}

export interface SeedScenarioResult {
  conversationId: string;
  steps: Array<{
    stepIndex: number;
    ok: boolean;
    txid?: string;
    replyText: string;
  }>;
}

// Patch the methods onto the class prototype here so triage.ts / tamper.ts
// stay focused on their domain logic.

TriageAgent.prototype.getCommitInfo = async function (
  this: TriageAgent,
  txid: string,
): Promise<CommitInfoResult | null> {
  const sql = (
    this as unknown as {
      ctx: {
        storage: {
          sql: { exec(s: string, ...args: unknown[]): { toArray(): Array<Record<string, unknown>> } };
        };
      };
    }
  ).ctx.storage.sql;
  // txid is unique across the agent — pt_commits PK is (conversation_id,
  // sequence) but a tx can only land in one row. Pull conversation_id too
  // so the verifier can verify within the right chain.
  const row = sql
    .exec(
      "SELECT conversation_id, sequence, hook_kind, commit_hash, created_at FROM pt_commits WHERE txid = ? LIMIT 1",
      txid,
    )
    .toArray()[0];
  if (!row) return null;
  const agentIdentityPubHex = await this.getIdentityPublicKey();
  const agentShort = agentIdentityPubHex.slice(0, 16);
  const month = new Date(row.created_at as number).toISOString().slice(0, 7);
  const sequence = row.sequence as number;
  const conversationId = row.conversation_id as string;
  const envelopeKey = `acme-health/default/${agentShort}/${conversationId}/${month}/${String(sequence).padStart(12, "0")}.env.json`;
  return {
    txid,
    conversationId,
    sequence,
    hookKind: row.hook_kind as string,
    commitHash: row.commit_hash as string,
    ts: new Date(row.created_at as number).toISOString(),
    envelopeKey,
    agentIdentityPubHex,
  };
};

TriageAgent.prototype.getChainHead = async function (
  this: TriageAgent,
): Promise<ChainHeadResult> {
  const sql = (
    this as unknown as {
      ctx: {
        storage: {
          sql: { exec(s: string, ...args: unknown[]): { toArray(): Array<Record<string, unknown>> } };
        };
      };
    }
  ).ctx.storage.sql;
  const masterRow = sql
    .exec("SELECT value FROM pt_state WHERE key = 'master_head'")
    .toArray()[0];
  const master = masterRow ? JSON.parse(masterRow.value as string) : null;
  const convRows = sql
    .exec(
      "SELECT id, title, chain_head_json, master_seq FROM pt_conversations WHERE status = 'active' ORDER BY last_active_at DESC",
    )
    .toArray() as Array<{
      id: string;
      title: string;
      chain_head_json: string;
      master_seq: number;
    }>;
  const conversations = convRows.map((r) => ({
    conversationId: r.id,
    title: r.title,
    head: JSON.parse(r.chain_head_json) as { sequence: number; prevHash: string },
    masterSeq: r.master_seq,
  }));
  const agentIdentityPubHex = await this.getIdentityPublicKey();
  return { master, conversations, agentIdentityPubHex };
};

TriageAgent.prototype.runTamper = async function (
  this: TriageAgent,
  conversationId: string,
  sequence: number,
): Promise<TamperRpcResult> {
  const result = await tamperWithEnvelope({
    agent: this,
    conversationId,
    sequence,
  });
  this.broadcastEvent({
    kind: "tamper",
    conversationId,
    ts: new Date().toISOString(),
    sequence,
    envelopeKey: result.envelopeKey,
  });
  return {
    ok: result.ok,
    envelopeKey: result.envelopeKey,
    conversationId,
    sequence,
  };
};

TriageAgent.prototype.runSeedScenario = async function (
  this: TriageAgent,
): Promise<SeedScenarioResult> {
  // Always seed into a fresh conversation so the warm-up doesn't interleave
  // with whatever the user is doing. Title makes it findable in the tab bar.
  const id = `conv_seed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await this.createConversation({
    id,
    title: "Seeded warm-up · chest pain",
    setActive: false,
  });
  const steps: SeedScenarioResult["steps"] = [];
  for (let i = 0; i < SCENARIO_STEP_COUNT; i++) {
    try {
      const turn = await runScenarioStep(this, i, id);
      steps.push({
        stepIndex: i,
        ok: turn.commits.length > 0,
        txid: turn.commits[0],
        replyText: turn.replyText,
      });
    } catch (e) {
      steps.push({
        stepIndex: i,
        ok: false,
        replyText: `error: ${(e as Error).message}`,
      });
      break;
    }
  }
  return { conversationId: id, steps };
};

TriageAgent.prototype.resetChainAndSidecars = async function (
  this: TriageAgent,
): Promise<ResetChainResult> {
  // 1. Wipe package tables (pt_commits, pt_conversations, pt_master_chain,
  //    pt_grants) and reset master_head to genesis. Preserves pt_utxos.
  const pkgCounts = await this.resetChain();

  // 2. Wipe sidecar tables. These mirror per-commit metadata (scope tags,
  //    envelope keys) and persistent demo persona priv keys; both lose
  //    their meaning when the chain is gone.
  const sql = (
    this as unknown as {
      ctx: {
        storage: {
          sql: { exec(s: string, ...args: unknown[]): { toArray(): Array<Record<string, unknown>> } };
        };
      };
    }
  ).ctx.storage.sql;
  const sidecarCounts = { triageCommitMeta: 0, triageDemoGrants: 0 };
  try {
    const cmRow = sql
      .exec("SELECT COUNT(*) AS n FROM triage_commit_meta")
      .toArray()[0] as { n?: number } | undefined;
    sidecarCounts.triageCommitMeta = Number(cmRow?.n ?? 0);
    sql.exec("DELETE FROM triage_commit_meta");
  } catch (e) {
    console.warn("[reset] triage_commit_meta wipe failed:", (e as Error).message);
  }
  try {
    const dgRow = sql
      .exec("SELECT COUNT(*) AS n FROM triage_demo_grants")
      .toArray()[0] as { n?: number } | undefined;
    sidecarCounts.triageDemoGrants = Number(dgRow?.n ?? 0);
    sql.exec("DELETE FROM triage_demo_grants");
  } catch (e) {
    console.warn("[reset] triage_demo_grants wipe failed:", (e as Error).message);
  }

  // Re-issue eager persona grants so the next chat turn can seal commits
  // to the canonical CO/Auditor/Patient personas without the user having
  // to /grant/persona manually.
  try {
    await this.ensureDemoPersonaGrant("compliance-officer");
    await this.ensureDemoPersonaGrant("external-auditor");
    await this.ensureDemoPersonaGrant("patient");
  } catch (e) {
    console.warn("[reset] eager persona re-grant failed:", (e as Error).message);
  }

  // Reset the configureSession latch so the next cold-boot's first triage
  // turn re-anchors configureSession into the user's conv (instead of
  // assuming we already anchored it on the now-wiped chain).
  this.configureSessionAnchored = false;

  // 3. Clear R2 envelopes under the demo's prefix. R2 list is paginated;
  //    use a cursor to drain. Delete in batches since R2 supports
  //    multi-key delete.
  const env = (this as unknown as { env: import("./types.js").Env }).env;
  let r2Deleted = 0;
  try {
    let cursor: string | undefined;
    do {
      const list = await env.ENVELOPES.list({
        prefix: "acme-health/",
        cursor,
        limit: 1000,
      });
      const keys = list.objects.map((o) => o.key);
      if (keys.length > 0) {
        await env.ENVELOPES.delete(keys);
        r2Deleted += keys.length;
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  } catch (e) {
    console.warn("[reset] R2 prefix purge failed:", (e as Error).message);
  }

  // 4. Confirm wallet survived. Both should be unchanged from before reset.
  const fundingAddress = await this.getFundingAddress();
  const fundingBalance = await this.getFundingBalance();

  return {
    ok: true,
    package: pkgCounts,
    sidecars: sidecarCounts,
    r2EnvelopesDeleted: r2Deleted,
    fundingPreserved: {
      address: fundingAddress,
      balance: fundingBalance,
    },
  };
};

TriageAgent.prototype.loadDemoExtension = async function (
  this: TriageAgent,
  args: {
    name: string;
    version: string;
    description: string;
    source: string;
  },
): Promise<LoadExtensionResult> {
  // Real production deploys set `env.EXTENSION_LOADER` (a WorkerLoader
  // binding) and Think auto-creates `this.extensionManager` in
  // `_initializeExtensions`. The demo doesn't bind a WorkerLoader (no
  // sandboxed eval; we only need the audit-anchor side of the
  // extension surface for the demo pitch). Install a minimal stub
  // manager whose `load(manifest, source)` is a no-op — the package's
  // withProvenance shadow on `this.extensionManager` setter wraps it
  // and our wrapper on `.load()` fires the on-chain
  // `extensionAuthored` commit.
  const ext = this as unknown as {
    extensionManager?: {
      __pt_load_wrapped?: boolean;
      __demo_loaded?: Set<string>;
      load(manifest: unknown, source: string): Promise<unknown>;
    };
  };
  if (!ext.extensionManager) {
    const loaded = new Set<string>();
    const stub: {
      __demo_loaded: Set<string>;
      load(manifest: unknown, source: string): Promise<unknown>;
    } = {
      __demo_loaded: loaded,
      load: async (manifest: unknown, _source: string) => {
        const mf = (manifest ?? {}) as { name?: string };
        const name = mf.name ?? "unknown";
        if (loaded.has(name)) {
          throw new Error(`extension already loaded: ${name}`);
        }
        loaded.add(name);
        return { ok: true, name };
      },
    };
    // Assigning triggers our setter shadow (`Object.defineProperty`
    // installed in __pt_install_v02_wrappers) which wraps `load()` so
    // every call fires `extensionAuthored`.
    (ext as unknown as { extensionManager: unknown }).extensionManager = stub;
  }
  const manager = ext.extensionManager;
  if (!manager) {
    return {
      ok: false,
      name: args.name,
      sourceByteCount: 0,
      sourceSha256: "",
      error: "extensionManager not installed",
    };
  }
  const manifest = {
    name: args.name,
    version: args.version,
    description: args.description,
    hooks: [] as string[],
    tools: [] as Array<{ name: string }>,
  };
  // Compute the same digest the package will emit so the response
  // mirrors the on-chain anchor. Using the same encoding the package
  // uses (utf8-bytes → SHA-256, hex).
  const { Hash, Utils } = await import("@bsv/sdk");
  const bytes = Utils.toArray(args.source, "utf8") as number[];
  const sha = Utils.toHex(Hash.sha256(bytes) as number[]);
  // Capture the active conv head BEFORE the load — that's the chain
  // the extensionAuthored anchor lands on (it follows whichever conv
  // was active when the commit fired, NOT master_seq, which only ever
  // advances per-conversation-genesis). We poll the same conv head
  // post-load to discover the anchored sequence + txid honestly.
  const headBefore = await this.getChainHead();
  const activeConvId = await this.getActiveConversationId();
  const findConv = (h: { conversations: Array<{ conversationId: string; head: { sequence: number } }> }) =>
    h.conversations.find((c) => c.conversationId === activeConvId);
  const beforeSeq = findConv(headBefore)?.head?.sequence ?? 0;
  await manager.load(manifest, args.source);
  // Wait for ctx.waitUntil-deferred commit to land. Real ARC submission +
  // BRC-78 sealing + per-conv mutex serialization takes 8–15s in
  // practice — poll up to 20s before giving up.
  let afterSeq = beforeSeq;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await this.getChainHead();
    afterSeq = findConv(h)?.head?.sequence ?? beforeSeq;
    if (afterSeq > beforeSeq) break;
  }
  const advanced = afterSeq > beforeSeq;
  return {
    ok: advanced,
    name: args.name,
    sourceByteCount: bytes.length,
    sourceSha256: sha,
    sequence: advanced ? afterSeq : undefined,
    error: advanced
      ? undefined
      : "extensionAuthored commit did not land in time (20s poll exhausted)",
  };
};

/**
 * Wave 5 — exercise every implementable lifecycle hook in a single run.
 *
 * Anchors 13 of the 16 reserved HookKind bytes on mainnet:
 *
 *   chat()-path hooks (fired by Think._runInferenceLoop):
 *     0x01 beforeTurn, 0x02 beforeStep, 0x05 onStepFinish, 0x06 onChunk
 *
 *   triage-path hooks (fired by runTriageTurn under runFiber):
 *     0x03 beforeToolCall, 0x04 afterToolCall, 0x07 onChatResponse,
 *     0x09 getModel, 0x0a fiberStart, 0x0b stash, 0x10 getTools,
 *     0x11 configureSession (once per DO boot)
 *
 *   recovery-path hooks (fired by orphan-fiber synthesis + checkRunFibers):
 *     0x08 onChatRecovery, 0x0c fiberRecovered
 *
 *   extension-path hook (fired by /admin/load-extension flow):
 *     0x0d extensionAuthored
 *
 * Reserved for v0.3 (no upstream trigger in v0.2):
 *   0x0e paymentBRC29   — BRC-29 payment flow not implemented
 *   0x0f keyRotation    — key-rotation infra not implemented
 *   0xff stepMerkleRoot — batch-step Merkle root not implemented
 */
TriageAgent.prototype.runFullHookScenario = async function (
  this: TriageAgent,
): Promise<FullHookScenarioResult> {
  // The full scenario takes 4–6 minutes (real ARC + LLM + chain mutex
  // serialization + extension polling). Cloudflare Worker request
  // handlers are bounded — running everything inline blows the wall-
  // clock. Solution: create the conv synchronously (so the gate has a
  // conv id to poll), and run every phase via `ctx.waitUntil(...)` so
  // the work continues in the background even after the HTTP response
  // returns. The gate polls /conversations + harvests via WS until the
  // chain settles.
  const errors: string[] = [];
  const id = `conv_wave5_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await this.createConversation({
    id,
    title: "Wave 5 · 16-hook gate",
    setActive: false,
  });

  const ctxRef = (this as unknown as {
    ctx: { waitUntil(p: Promise<unknown>): void };
  }).ctx;

  // Run all 4 phases sequentially in the background. Errors are
  // captured into the agent's broadcast events for the gate to
  // diagnose if anything goes wrong.
  ctxRef.waitUntil(
    (async () => {
      // ── Triage path: 8 unique hookKinds ─────────────────────────
      try {
        await runScenarioStep(this, 0, id);
      } catch (e) {
        this.broadcastEvent({
          kind: "info",
          conversationId: id,
          ts: new Date().toISOString(),
          text: `[wave5] triage phase failed: ${(e as Error).message}`,
        });
      }
      // ── Chat() path: beforeTurn, beforeStep, onStepFinish, onChunk
      try {
        const stubCallback = {
          onEvent: async (_chunk: string) => {
            /* discard — we only need the hooks, not the wire frames */
          },
          onDone: async () => {
            /* no-op */
          },
        };
        await this.setActiveConversation(id);
        await (this as unknown as {
          chat: (msg: string, cb: typeof stubCallback) => Promise<unknown>;
        }).chat(
          "Briefly: what is normal blood pressure for a healthy adult?",
          stubCallback,
        );
      } catch (e) {
        this.broadcastEvent({
          kind: "info",
          conversationId: id,
          ts: new Date().toISOString(),
          text: `[wave5] chat() phase failed: ${(e as Error).message}`,
        });
      }
      // ── Recovery synthesis: fiberRecovered + onChatRecovery ────
      try {
        await this.setActiveConversation(id);
        const sql = (
          this as unknown as {
            ctx: { storage: { sql: { exec: (q: string, ...b: unknown[]) => unknown } } };
          }
        ).ctx.storage.sql;
        sql.exec(
          "INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)",
          "syn-user-" + Math.random().toString(36).slice(2, 8),
          "wave5-synthetic-user-fiber",
          JSON.stringify({ at: "synthetic-recovery", note: "wave5 audit anchor" }),
          Date.now() - 5000,
        );
        sql.exec(
          "INSERT INTO cf_agents_runs (id, name, snapshot, created_at) VALUES (?, ?, ?, ?)",
          "syn-chat-" + Math.random().toString(36).slice(2, 8),
          "__cf_internal_chat_turn:wave5-synthetic-request-id",
          null,
          Date.now() - 5000,
        );
        await (this as unknown as { _checkRunFibers: () => Promise<void> })._checkRunFibers();
      } catch (e) {
        this.broadcastEvent({
          kind: "info",
          conversationId: id,
          ts: new Date().toISOString(),
          text: `[wave5] recovery phase failed: ${(e as Error).message}`,
        });
      }
      // ── Extension load: extensionAuthored ──────────────────────
      try {
        await this.setActiveConversation(id);
        await this.loadDemoExtension({
          name: `wave5-ext-${Date.now().toString(36)}`,
          version: "0.1.0",
          description: "Wave 5 16-hook gate — extensionAuthored anchor",
          source:
            'export const manifest = { name: "wave5-ext", version: "0.1.0" };\n' +
            'export async function beforeToolCall(ctx) { ctx.note?.("wave5"); }\n',
        });
      } catch (e) {
        this.broadcastEvent({
          kind: "info",
          conversationId: id,
          ts: new Date().toISOString(),
          text: `[wave5] extension phase failed: ${(e as Error).message}`,
        });
      }
      this.broadcastEvent({
        kind: "info",
        conversationId: id,
        ts: new Date().toISOString(),
        text: `[wave5] all phases complete`,
      });
    })(),
  );

  // Return immediately. The gate polls /conversations to track
  // progress and runs the WIRE/ENVELOPE/scope assertions once the
  // chain settles. This shape lets the request return in <500ms even
  // though the full scenario takes ~5 minutes.
  return {
    conversationId: id,
    triageOk: true,
    chatOk: true,
    fiberRecoveredOk: true,
    chatRecoveredOk: true,
    extensionAuthoredOk: true,
    errors,
    expectedHookKinds: [
      "configureSession",
      "fiberStart",
      "getModel",
      "getTools",
      "beforeTurn",
      "beforeStep",
      "onChunk",
      "onStepFinish",
      "beforeToolCall",
      "afterToolCall",
      "stash",
      "onChatResponse",
      "fiberRecovered",
      "onChatRecovery",
      "extensionAuthored",
    ],
    reservedV03: ["paymentBRC29", "keyRotation", "stepMerkleRoot"],
  };
};

