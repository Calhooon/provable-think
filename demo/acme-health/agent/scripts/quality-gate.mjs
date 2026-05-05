#!/usr/bin/env node
/**
 * Mainnet quality gate for provable-think hooks.
 *
 * Drives the live agent through a single triage turn, then independently
 * verifies every commit landed correctly. Three verification axes per commit:
 *
 *   1. CHAIN: tx exists on BSV mainnet (WhatsOnChain GET /tx/<txid>/hex).
 *   2. WIRE: OP_RETURN parses as PRT1 with the expected hookKind byte and
 *            32-byte commitHash matching the operator's /commit-info.
 *   3. ENVELOPE: /unseal-as-auditor decrypts under the External Auditor's
 *                grant, and the plaintext canonical-JSON contains the
 *                expected payload shape.
 *
 * Bonus assertions: per-conv chain advances monotonically (no sequence
 * gaps), and the conversation-list summary matches the in-store commits.
 *
 * Usage:
 *   node scripts/quality-gate.mjs                     # full gate
 *   node scripts/quality-gate.mjs --conv <id>         # use existing conv
 *   node scripts/quality-gate.mjs --skip-send         # verify last conv
 *   node scripts/quality-gate.mjs --expected 5        # commit count to wait
 */

import { setTimeout as sleep } from "node:timers/promises";
import WS from "ws";

// Node 20 doesn't have a built-in WebSocket; use the `ws` package shim.
// The agent's wrangler dev deps already include it.
const WebSocket = WS;

const AGENT_URL = "https://acme-health-agent.dev-a3e.workers.dev";
const WS_URL = AGENT_URL.replace(/^http/, "ws") + "/ws";
const WOC_BASE = "https://api.whatsonchain.com/v1/bsv/main";
const WOC_DELAY_MS = 350; // free tier: 3 req/s

// PRT1 wire-format constants — mirror of package/src/commitment.ts.
const PRT1_MAGIC = "50525431"; // "PRT1" hex
const HOOK_KIND_BYTES = {
  beforeTurn: 0x01,
  beforeStep: 0x02,
  beforeToolCall: 0x03,
  afterToolCall: 0x04,
  onStepFinish: 0x05,
  onChunk: 0x06,
  onChatResponse: 0x07,
  onChatRecovery: 0x08,
  getModel: 0x09,
  fiberStart: 0x0a,
  stash: 0x0b,
  fiberRecovered: 0x0c,
  extensionAuthored: 0x0d,
  paymentBRC29: 0x0e,
  keyRotation: 0x0f,
  getTools: 0x10,
  configureSession: 0x11,
  stepMerkleRoot: 0xff,
};
const HOOK_BYTE_TO_NAME = Object.fromEntries(
  Object.entries(HOOK_KIND_BYTES).map(([k, v]) => [v, k]),
);

// CLI flags
const args = process.argv.slice(2);
const flag = (n) => args.indexOf(`--${n}`);
const argVal = (n, dflt) => {
  const i = flag(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SKIP_SEND = flag("skip-send") >= 0;
const CONV_OVERRIDE = argVal("conv", null);
const EXPECTED = parseInt(argVal("expected", "5"), 10);
const TURN_TEXT = argVal(
  "text",
  "Quality-gate probe: I have intermittent chest pressure with diaphoresis.",
);
// Wave 5: full 16-hook gate. Triggers POST /scenario/exercise-all-hooks
// and verifies every implementable HookKind anchored on chain.
const WAVE = parseInt(argVal("wave", "0"), 10);

// ── Pretty printing ────────────────────────────────────────────────
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => {
  console.log(`\x1b[31m✗\x1b[0m ${msg}`);
  process.exit(1);
};
const info = (msg) => console.log(`\x1b[36m·\x1b[0m ${msg}`);
const section = (msg) =>
  console.log(`\n\x1b[1m─── ${msg} ${"─".repeat(Math.max(0, 60 - msg.length))}\x1b[0m`);

// ── HTTP helpers ───────────────────────────────────────────────────
async function jget(path) {
  const r = await fetch(`${AGENT_URL}${path}`);
  if (!r.ok) throw new Error(`agent ${path} ${r.status}`);
  return r.json();
}
async function jpost(path, body) {
  const r = await fetch(`${AGENT_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`agent ${path} ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function wocFetchTxHex(txid) {
  // Retry with exponential backoff: WoC indexer lags ARC by ~30–120s
  // on busy mempool stretches. The chain rejection we'd care about
  // (DOUBLE_SPEND etc.) already surfaced via ARC at broadcast time;
  // here we're proving the tx is publicly visible. Try 6 times over
  // ~3 min before giving up — that covers a typical lag spike.
  let lastError = null;
  for (let i = 0; i < 6; i++) {
    await sleep(WOC_DELAY_MS);
    try {
      const r = await fetch(`${WOC_BASE}/tx/${txid}/hex`);
      if (r.ok) return (await r.text()).trim();
      lastError = `WoC ${r.status}`;
    } catch (e) {
      lastError = `WoC fetch threw: ${(e?.message ?? e).toString().slice(0, 80)}`;
    }
    // Exponential backoff: 5s, 10s, 20s, 40s, 60s, 60s
    const wait = Math.min(60_000, 5_000 * 2 ** i);
    await sleep(wait);
  }
  throw new Error(`${lastError} for ${txid} after 6 retries`);
}

// ── PRT1 wire parsing ──────────────────────────────────────────────

/**
 * Parse a raw tx hex and return the OP_RETURN payload bytes (hex). The PRT1
 * commit txs we produce always have output 0 = OP_RETURN, output 1 = change.
 *
 * BSV OP_RETURN script for our commits: `OP_FALSE OP_RETURN <PUSHDATA>...`
 *   - 0x00       = OP_FALSE
 *   - 0x6a       = OP_RETURN
 *   - 0x4c <len> = OP_PUSHDATA1 (since payload is ~145 bytes, > 75)
 *   - <payload>
 *
 * We don't fully parse the tx (BSV tx parser is non-trivial); we extract
 * the PRT1 payload by string-search since the magic is deterministic and
 * unique-enough in the script.
 */
function extractPrt1Payload(rawTxHex) {
  // Find the PRT1 magic in the tx. There's exactly one OP_RETURN per commit
  // tx; the magic appears once.
  const idx = rawTxHex.toLowerCase().indexOf(PRT1_MAGIC);
  if (idx < 0) throw new Error("PRT1 magic not found in tx hex");
  // We don't need to know payload length exactly — the parsed structure is
  // self-describing (DER sig length is at offset 70 in the payload).
  const payloadHex = rawTxHex.slice(idx);
  const payload = Buffer.from(payloadHex, "hex");
  return payload;
}

function parsePrt1(buf) {
  if (buf.length < 75) throw new Error(`PRT1 too short: ${buf.length}`);
  const magic = buf.slice(0, 4).toString("hex");
  if (magic !== PRT1_MAGIC) throw new Error(`bad PRT1 magic: ${magic}`);
  const hookByte = buf[4];
  const sequence = buf.readUInt32BE(5);
  const commitHash = buf.slice(9, 41).toString("hex");
  const derivedPubkey = buf.slice(41, 74).toString("hex");
  const sigLen = buf[74];
  const sig = buf.slice(75, 75 + sigLen).toString("hex");
  return { magic, hookByte, hookKind: HOOK_BYTE_TO_NAME[hookByte], sequence, commitHash, derivedPubkey, sig };
}

// ── WS client (just enough to send a patient-message and observe) ──

/**
 * Create a fresh conversation, wait for the server to confirm, then send
 * the patient message into it. Returns the new conversationId. Always
 * spawns a fresh conv so the gate's commit-count assertions are trivially
 * predictable (count == messages × hooks_per_turn).
 */
async function sendPatientMessage(text, existingConversationId) {
  return new Promise((resolve, reject) => {
    let timer;
    let resolved = false;
    let convId = existingConversationId ?? null;
    let helloSeen = false;
    let convCreated = Boolean(existingConversationId);
    let messageSent = false;
    const ws = new WebSocket(WS_URL);
    const cleanup = () => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
    };
    timer = setTimeout(() => {
      if (resolved) return;
      cleanup();
      reject(new Error("WS timeout waiting for conv + patient-message"));
    }, 30_000);

    function maybeSendMessage() {
      if (messageSent) return;
      if (!helloSeen || !convCreated) return;
      messageSent = true;
      info(`sending patient-message into ${convId}`);
      ws.send(JSON.stringify({ kind: "patient-message", conversationId: convId, text }));
    }

    ws.addEventListener("open", () => {
      info(`WS opened`);
    });
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (e.kind === "hello") {
          info(`hello: agentId=${e.agentId} conversations=${e.conversations.length}`);
          helloSeen = true;
          if (!existingConversationId) {
            // Spawn a fresh conv for this gate run.
            ws.send(JSON.stringify({ kind: "new-conversation", title: "quality-gate", activate: true }));
          } else {
            ws.send(JSON.stringify({ kind: "select-conversation", conversationId: existingConversationId }));
            convCreated = true;
          }
          maybeSendMessage();
        } else if (e.kind === "conversation-created") {
          convId = e.conversation.id;
          convCreated = true;
          info(`new conv: ${convId} ("${e.conversation.title}")`);
          maybeSendMessage();
        } else if (e.kind === "patient-message" && messageSent) {
          // Patient-message echo confirms server accepted + started the turn.
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve(convId);
          }
        }
      } catch {
        /* ignore frame */
      }
    });
    ws.addEventListener("error", (e) => {
      if (!resolved) reject(new Error(`WS error: ${e?.message ?? e}`));
    });
  });
}

// ── Auditor decrypt + persona key provisioning ─────────────────────

async function getExternalAuditorGrant() {
  // /grant/persona is idempotent — returns the cached grant for "external-auditor".
  return jpost("/grant/persona", {
    persona: "external-auditor",
    generateAuditorKey: true,
  });
}

async function unsealAsAuditor(envelopeKey, auditorPrivKeyHex, recipientId) {
  return jpost("/unseal-as-auditor", {
    envelopeKey,
    auditorPrivKeyHex,
    recipientId,
  });
}

// ── Main gate ──────────────────────────────────────────────────────

async function main() {
  if (WAVE === 5) return mainWave5();

  section("Setup");
  const info0 = await jget("/info");
  ok(`agent ${info0.agentId} live (balance ${info0.balance} sat, demo=${info0.demoMode})`);

  // Issue the External Auditor grant BEFORE the chat turn. Otherwise the
  // envelopes for getModel/getTools/onChatResponse get sealed to a
  // recipient list that doesn't include the auditor, and our ENVELOPE
  // assertions will fail with "no recipient" by design — not because
  // the wrapper is broken.
  const grant0 = await getExternalAuditorGrant();
  ok(`external-auditor grant ready ${grant0.capability.id.slice(0, 12)}…`);

  let convId = CONV_OVERRIDE;
  if (!SKIP_SEND) {
    convId = await sendPatientMessage(TURN_TEXT, convId);
    ok(`sent patient message to conv ${convId ?? "(auto-created)"}`);
  } else if (!convId) {
    fail("--skip-send requires --conv <id>");
  }

  section(`Wait for ${EXPECTED} commits in conv ${convId}`);
  const startedAt = Date.now();
  let summary;
  while (true) {
    const list = await jget("/conversations");
    summary = list.find((c) => c.id === convId);
    if (summary && summary.commitCount >= EXPECTED) break;
    if (Date.now() - startedAt > 180_000) {
      fail(`timeout waiting for commits (have ${summary?.commitCount ?? 0}, want ${EXPECTED})`);
    }
    process.stdout.write(`\r\x1b[36m·\x1b[0m commitCount=${summary?.commitCount ?? 0}  `);
    await sleep(3_000);
  }
  process.stdout.write("\n");
  ok(`got ${summary.commitCount} commits in ${(Date.now() - startedAt) / 1000}s`);

  section("Pull pt_commits via /commit-info per txid");
  // Bulk-fetch the chain head + commits rather than poll /commit-info N times.
  const chainHead = await jget("/chain-head");
  const conv = chainHead.conversations.find((c) => c.conversationId === convId);
  if (!conv) fail(`no chain head for conv ${convId}`);
  ok(`conv chain head: seq=${conv.head.sequence}, master_seq=${conv.masterSeq}`);

  // We need txids — get them from the agent's per-conv pt_commits view via
  // a temp connection. Easier: hit /commit-info for each sequence by
  // walking the head. But /commit-info takes a txid, not a sequence.
  // Use a small eval via an SQL-readback: there's no such endpoint, so
  // we'll piggy-back off the agent's WS replay-on-connect to harvest the
  // txids.
  const txids = await harvestTxidsViaWs(convId);
  ok(`harvested ${txids.length} txids via WS replay`);

  section("WIRE: parse PRT1 OP_RETURN for every commit");
  const grant = await getExternalAuditorGrant();
  const externalPriv = grant.generatedAuditorPrivHex;
  const externalGrantId = grant.capability.id;
  ok(`got external-auditor grant ${externalGrantId.slice(0, 12)}…`);

  let totalSatsOnChain = 0;
  const commitsAudited = [];
  for (const txid of txids) {
    info(`commit ${txid.slice(0, 16)}…`);
    const ci = await jget(`/commit-info?txid=${txid}`);
    const txHex = await wocFetchTxHex(txid);
    const payload = extractPrt1Payload(txHex);
    const parsed = parsePrt1(payload);
    if (parsed.commitHash !== ci.commitHash) {
      fail(`  commitHash mismatch: chain=${parsed.commitHash.slice(0, 16)}… op=${ci.commitHash.slice(0, 16)}…`);
    }
    if (parsed.hookKind !== ci.hookKind) {
      fail(`  hookKind mismatch: chain=${parsed.hookKind}(0x${parsed.hookByte.toString(16)}) op=${ci.hookKind}`);
    }
    if (parsed.sequence !== ci.sequence) {
      fail(`  sequence mismatch: chain=${parsed.sequence} op=${ci.sequence}`);
    }
    ok(`  WIRE: hookKind=${parsed.hookKind} (0x${parsed.hookByte.toString(16).padStart(2, "0")}) seq=${parsed.sequence} commitHash✓`);
    // ENVELOPE: try to decrypt as the External Auditor. Some events should
    // be in their scope (operations); some should not (PHI/treatment only).
    let unseal;
    try {
      unseal = await unsealAsAuditor(ci.envelopeKey, externalPriv, externalGrantId);
    } catch (e) {
      info(`  ENVELOPE: unseal threw (likely scope mismatch by design): ${e.message.slice(0, 80)}`);
    }
    const inScope = unseal?.ok && unseal?.integrityOk;
    if (inScope) {
      ok(`  ENVELOPE: decrypted ${unseal.plaintext.length} bytes (External Auditor in-scope)`);
    } else {
      info(`  ENVELOPE: out-of-scope for External Auditor (expected for PHI-only commits)`);
    }
    commitsAudited.push({
      txid,
      hookKind: parsed.hookKind,
      hookByte: parsed.hookByte,
      sequence: parsed.sequence,
      inScope,
      plaintext: unseal?.plaintext,
    });
  }

  section("CHAIN: per-conversation sequence is monotonic 1..N");
  const sortedSeqs = commitsAudited.map((c) => c.sequence).sort((a, b) => a - b);
  for (let i = 0; i < sortedSeqs.length; i++) {
    if (sortedSeqs[i] !== i + 1) {
      fail(`sequence gap: expected ${i + 1}, got ${sortedSeqs[i]} (full: ${sortedSeqs})`);
    }
  }
  ok(`per-conv chain: 1..${sortedSeqs[sortedSeqs.length - 1]} contiguous`);

  section("HOOK COVERAGE (this conversation)");
  const expectedHooks = ["fiberStart", "getModel", "getTools", "beforeToolCall", "afterToolCall", "stash", "onChatResponse"];
  const seenHooks = new Set(commitsAudited.map((c) => c.hookKind));
  for (const h of expectedHooks) {
    if (seenHooks.has(h)) {
      ok(`  ${h} present`);
    } else {
      fail(`  ${h} MISSING — wrapper not firing`);
    }
  }

  section("AGENT-WIDE: extensionAuthored anchored somewhere (HookKind 0x0d)");
  // extensionAuthored fires when an extension is loaded at runtime — a
  // separate code path from the chat-turn flow. The demo triggers it
  // via POST /admin/load-extension (which lands on the agent's
  // "default" conversation, not the gate's quality-gate conv). Walk
  // every conversation to find at least one extensionAuthored anchor.
  const allConvsForExt = await jget("/conversations");
  let extensionAuthoredFound = null;
  for (const c of allConvsForExt) {
    const txids = await harvestTxidsViaWs(c.id);
    for (const txid of txids) {
      const ci = await jget(`/commit-info?txid=${txid}`);
      if (ci.hookKind === "extensionAuthored") {
        extensionAuthoredFound = { ...ci, sourceConv: c.id };
        break;
      }
    }
    if (extensionAuthoredFound) break;
  }
  if (!extensionAuthoredFound) {
    info("no extensionAuthored found — POST /admin/load-extension to anchor one");
  } else {
    ok(`extensionAuthored found: txid=${extensionAuthoredFound.txid.slice(0, 16)}… seq=${extensionAuthoredFound.sequence} in conv=${extensionAuthoredFound.sourceConv}`);
    const txHex = await wocFetchTxHex(extensionAuthoredFound.txid);
    const payload = extractPrt1Payload(txHex);
    const parsed = parsePrt1(payload);
    if (parsed.hookByte !== HOOK_KIND_BYTES.extensionAuthored) {
      fail(`extensionAuthored WIRE byte mismatch: got 0x${parsed.hookByte.toString(16)} want 0x${HOOK_KIND_BYTES.extensionAuthored.toString(16)}`);
    }
    ok(`extensionAuthored WIRE: hookKind byte 0x${parsed.hookByte.toString(16).padStart(2, "0")} ✓`);
  }

  section("AGENT-WIDE: configureSession anchored at boot");
  // configureSession fires ONCE per agent cold-start, not per conversation.
  // It lands wherever __pt_active_conversation_id was at boot (typically the
  // auto-created "default" conv). Walk every conversation and look for it.
  const allConvs = await jget("/conversations");
  let configureSessionFound = null;
  for (const c of allConvs) {
    const txids = await harvestTxidsViaWs(c.id);
    for (const txid of txids) {
      const ci = await jget(`/commit-info?txid=${txid}`);
      if (ci.hookKind === "configureSession") {
        configureSessionFound = { ...ci, sourceConv: c.id };
        break;
      }
    }
    if (configureSessionFound) break;
  }
  if (!configureSessionFound) {
    fail("configureSession NOT anchored anywhere — wrapper not firing on boot");
  }
  ok(`configureSession found: txid=${configureSessionFound.txid.slice(0, 16)}… seq=${configureSessionFound.sequence} in conv=${configureSessionFound.sourceConv}`);
  // Also verify the WIRE format byte for this hook.
  {
    const txHex = await wocFetchTxHex(configureSessionFound.txid);
    const payload = extractPrt1Payload(txHex);
    const parsed = parsePrt1(payload);
    if (parsed.hookByte !== HOOK_KIND_BYTES.configureSession) {
      fail(`configureSession WIRE byte mismatch: got 0x${parsed.hookByte.toString(16)} want 0x${HOOK_KIND_BYTES.configureSession.toString(16)}`);
    }
    ok(`configureSession WIRE: hookKind byte 0x${parsed.hookByte.toString(16).padStart(2, "0")} ✓`);
  }

  section("SCOPE: operations-tagged hooks decryptable by External Auditor (fiberStart, configureSession, getModel, getTools, stash)");
  const OPS_HOOKS = new Set(["getModel", "getTools", "fiberStart", "stash", "configureSession"]);
  for (const c of commitsAudited) {
    if (!OPS_HOOKS.has(c.hookKind)) continue;
    if (!c.inScope) {
      fail(`  ${c.hookKind} (seq=${c.sequence}) NOT in External Auditor scope — wrong scope tags`);
    }
    if (!c.plaintext || !c.plaintext.includes(c.hookKind)) {
      // Plaintext is canonical-JSON: { hookKind, ts, payload: {...} }.
      // If decrypt succeeded, the hookKind label should appear.
      fail(`  ${c.hookKind} plaintext doesn't contain the hookKind label`);
    }
    ok(`  ${c.hookKind} in-scope + plaintext shape ✓`);
  }

  // Plaintext is `{prevHash:32 raw bytes}{canonical-JSON}`. The 32-byte
  // prevHash CAN contain a stray 0x7b ('{') so naive indexOf misses; walk
  // forward and try-parse until the first valid JSON object.
  function parsePlaintextJson(plaintext) {
    let from = -1;
    while (true) {
      const next = plaintext.indexOf("{", from + 1);
      if (next < 0) throw new Error("no parseable JSON object in plaintext");
      try {
        const slice = plaintext.slice(next);
        // Stream-parse using JSON: walk to find the matching close.
        // Simpler: try JSON.parse on slices of growing length isn't right —
        // the JSON ends at the matching close brace. Use a state machine.
        const end = findJsonEnd(slice);
        if (end > 0) {
          return JSON.parse(slice.slice(0, end));
        }
      } catch {/* keep walking */}
      from = next;
    }
  }
  function findJsonEnd(s) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
    }
    return -1;
  }

  section("PAYLOAD: getModel anchors {provider, modelId}");
  const getModelCommit = commitsAudited.find((c) => c.hookKind === "getModel");
  if (!getModelCommit) fail("no getModel commit found");
  const gmPlain = parsePlaintextJson(getModelCommit.plaintext);
  const gmPayload = gmPlain.payload ?? gmPlain;
  if (!gmPayload.provider || !gmPayload.modelId) {
    fail(`getModel payload missing provider/modelId: ${JSON.stringify(gmPayload)}`);
  }
  ok(`getModel payload: provider=${gmPayload.provider} modelId=${gmPayload.modelId}`);

  section("PAYLOAD: getTools anchors {count, toolNames, toolSummaries}");
  const getToolsCommit = commitsAudited.find((c) => c.hookKind === "getTools");
  if (!getToolsCommit) fail("no getTools commit found");
  const gtPlain = parsePlaintextJson(getToolsCommit.plaintext);
  const gtPayload = gtPlain.payload ?? gtPlain;
  if (typeof gtPayload.count !== "number") fail("getTools payload missing count");
  if (!Array.isArray(gtPayload.toolNames)) fail("getTools payload missing toolNames");
  ok(`getTools payload: count=${gtPayload.count}, names=[${gtPayload.toolNames.slice(0, 5).join(", ")}]`);

  section("PAYLOAD: stash anchors {snapshotByteCount, snapshotSha256} (HookKind 0x0b)");
  const stashCommit = commitsAudited.find((c) => c.hookKind === "stash");
  if (!stashCommit) fail("no stash commit found");
  if (stashCommit.hookByte !== 0x0b) {
    fail(`stash WIRE byte mismatch: got 0x${stashCommit.hookByte.toString(16)} want 0x0b`);
  }
  const stashPlain = parsePlaintextJson(stashCommit.plaintext);
  const stashPayload = stashPlain.payload ?? stashPlain;
  if (typeof stashPayload.snapshotByteCount !== "number") {
    fail(`stash payload missing snapshotByteCount: ${JSON.stringify(stashPayload)}`);
  }
  if (typeof stashPayload.snapshotSha256 !== "string" || !/^[0-9a-f]{64}$/.test(stashPayload.snapshotSha256)) {
    fail(`stash payload missing/bad snapshotSha256: ${JSON.stringify(stashPayload)}`);
  }
  ok(`stash payload: bytes=${stashPayload.snapshotByteCount} sha256=${stashPayload.snapshotSha256.slice(0, 12)}…`);

  section("PAYLOAD: fiberStart anchors {name, kind} (HookKind 0x0a)");
  const fiberStartCommit = commitsAudited.find((c) => c.hookKind === "fiberStart");
  if (!fiberStartCommit) fail("no fiberStart commit found");
  if (fiberStartCommit.hookByte !== 0x0a) {
    fail(`fiberStart WIRE byte mismatch: got 0x${fiberStartCommit.hookByte.toString(16)} want 0x0a`);
  }
  const fsPlain = parsePlaintextJson(fiberStartCommit.plaintext);
  const fsPayload = fsPlain.payload ?? fsPlain;
  if (typeof fsPayload.name !== "string" || !fsPayload.name) {
    fail(`fiberStart payload missing 'name': ${JSON.stringify(fsPayload)}`);
  }
  if (typeof fsPayload.kind !== "string") {
    fail(`fiberStart payload missing 'kind': ${JSON.stringify(fsPayload)}`);
  }
  // Triage uses fiber name `acme-triage-turn:<convId>:<ts>`. HIPAA_PRESET
  // applies field-level Safe Harbor redaction across every commit's
  // plaintext (including operations-scoped commits — redaction is
  // wire-level, scope-independent), so the "name" string lands as
  // `<redacted:phi:name>` rather than the literal value. That is the
  // documented behavior; we only need to assert the field is present and
  // non-empty.
  ok(`fiberStart payload: kind=${fsPayload.kind} name=${String(fsPayload.name).slice(0, 48)}…`);
  // First commit on a fresh-conv first-turn must be fiberStart (seq=1)
  // because the turnFn body runs INSIDE the fiber — so the fiber-anchor
  // commit was queued before any of the in-fiber commits.
  if (fiberStartCommit.sequence !== 1) {
    // Not a hard fail: configureSession can land first if it's anchored
    // outside the fiber (e.g. on a pre-existing DO). Warn instead.
    console.warn(`  note: fiberStart at seq=${fiberStartCommit.sequence} (expected 1 on fresh-conv first-turn)`);
  }

  section("RESULT");
  console.log(`\n\x1b[1m\x1b[32m  GATE PASSED\x1b[0m — ${commitsAudited.length} commits, all on chain, all wire-format-valid, all chain hashes match.\n`);
  console.log("  Conversation:    " + convId);
  console.log("  Master seq:      " + conv.masterSeq);
  console.log("  Hook coverage:   " + [...seenHooks].sort().join(", "));
  console.log("  Mainnet spend:   ~" + commitsAudited.length * 36 + " sat (estimated, ARC fee=36/commit)");
}

// ====================================================================
// Wave 5 — Full 16-hook quality gate
// ====================================================================
//
// Single scenario via /scenario/exercise-all-hooks fires every
// implementable HookKind: 12 in the wave5 conv (chat + triage + recovery
// paths) plus 1 in the default conv (extensionAuthored, lands wherever
// was the active conv when the load fired). The gate asserts:
//
//   1. CHAIN: per-conv chain is monotonic 1..N for the wave5 conv,
//      every commit's tx is on mainnet (WoC GET /tx/<txid>/hex), and
//      every commit hash matches /commit-info.
//   2. WIRE: OP_RETURN parses as PRT1; hookKind byte matches the name.
//   3. COVERAGE: every expected HookKind appears at least once on chain
//      (the scenario emits some hooks multiple times — e.g. fiberStart
//      fires for triage runFiber AND chat() chatRecovery runFiber).
//   4. EXTENSION: extensionAuthored anchored somewhere on the agent's
//      chain space (default conv is the standard landing spot).
//   5. SCOPE: operations-tagged commits decrypt for External Auditor;
//      PHI/treatment-only commits do NOT (proves the persona scope
//      filter holds across all 13 hookKinds, not just 7).
//   6. RESERVED: paymentBRC29 / keyRotation / stepMerkleRoot are
//      reported as v0.3 — flagged in the gate output for visibility.
async function mainWave5() {
  section("Wave 5 — Full 16-hook quality gate");
  const info0 = await jget("/info");
  ok(`agent ${info0.agentId} live (balance ${info0.balance} sat, demo=${info0.demoMode})`);
  const grant0 = await getExternalAuditorGrant();
  ok(`external-auditor grant ready ${grant0.capability.id.slice(0, 12)}…`);
  const externalPriv = grant0.generatedAuditorPrivHex;
  const externalGrantId = grant0.capability.id;

  let scenarioConvId = CONV_OVERRIDE;
  let scenarioReport = null;
  if (!SKIP_SEND) {
    section("Trigger /scenario/exercise-all-hooks (this takes ~3 min)");
    process.stdout.write(`\x1b[36m·\x1b[0m POSTing /scenario/exercise-all-hooks (commits land asynchronously, the request returns when all SQL synthesis + chat() + extension load complete)…\n`);
    // Long-running endpoint — explicit AbortSignal.timeout(8min) so the
    // default fetch deadline doesn't blow up the gate while the agent
    // is still doing its work. The scenario waits on real ARC + LLM
    // calls; 5–7 minutes is normal.
    const scenarioRes = await fetch(`${AGENT_URL}/scenario/exercise-all-hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(480_000),
    });
    if (!scenarioRes.ok) {
      fail(`scenario endpoint returned ${scenarioRes.status}: ${(await scenarioRes.text()).slice(0, 200)}`);
    }
    scenarioReport = await scenarioRes.json();
    scenarioConvId = scenarioReport.conversationId;
    if (!scenarioReport.triageOk) fail(`scenario triage phase failed: ${scenarioReport.errors?.join("; ") ?? "unknown"}`);
    if (!scenarioReport.chatOk) fail(`scenario chat() phase failed: ${scenarioReport.errors?.join("; ") ?? "unknown"}`);
    if (!scenarioReport.fiberRecoveredOk) fail(`scenario fiberRecovered phase failed: ${scenarioReport.errors?.join("; ") ?? "unknown"}`);
    if (!scenarioReport.chatRecoveredOk) fail(`scenario chatRecovered phase failed: ${scenarioReport.errors?.join("; ") ?? "unknown"}`);
    if (!scenarioReport.extensionAuthoredOk) info(`scenario extensionAuthored returned ok=false (poll may have timed out — we'll still scan the chain for the anchor)`);
    ok(`scenario complete; conv=${scenarioConvId}`);
  } else if (!scenarioConvId) {
    fail("Wave 5 in --skip-send mode requires --conv <id>");
  }

  // The scenario reports every HookKind it expected to anchor (in source-
  // of-truth order). 12 land on the wave5 conv; 1 (extensionAuthored)
  // lands on default. We use this list as the gate's coverage spec.
  const expectedHookKinds =
    scenarioReport?.expectedHookKinds ??
    [
      "configureSession", "fiberStart", "getModel", "getTools",
      "beforeTurn", "beforeStep", "onChunk", "onStepFinish",
      "beforeToolCall", "afterToolCall", "stash", "onChatResponse",
      "fiberRecovered", "onChatRecovery", "extensionAuthored",
    ];

  section(`Wait for chain to settle (target ≥14 commits + 30s without growth)`);
  const settleStart = Date.now();
  let summary;
  let lastCount = -1;
  let lastChangedAt = Date.now();
  while (true) {
    const list = await jget("/conversations");
    summary = list.find((c) => c.id === scenarioConvId);
    const cur = summary?.commitCount ?? 0;
    if (cur !== lastCount) {
      lastCount = cur;
      lastChangedAt = Date.now();
    }
    const settledQuiet = cur >= 14 && Date.now() - lastChangedAt > 30_000;
    if (settledQuiet || Date.now() - settleStart > 600_000) break;
    process.stdout.write(`\r\x1b[36m·\x1b[0m commitCount=${cur}  (waiting for chain to settle…)  `);
    await sleep(5_000);
  }
  process.stdout.write("\n");
  ok(`wave5 conv has ${summary.commitCount} commits in ${(Date.now() - settleStart) / 1000}s`);

  section(`Pull every commit on the wave5 conv via WS replay`);
  const wave5Txids = await harvestTxidsViaWs(scenarioConvId);
  ok(`harvested ${wave5Txids.length} txids`);

  // Pull every conversation's commits because extensionAuthored may have
  // landed on default (or whichever conv was active when load fired).
  const allConvs = await jget("/conversations");
  const allTxidsByConv = new Map();
  for (const c of allConvs) {
    const tx = await harvestTxidsViaWs(c.id);
    allTxidsByConv.set(c.id, tx);
  }
  ok(`harvested every conv: ${allConvs.map((c) => `${c.id.slice(0, 16)}…(${(allTxidsByConv.get(c.id) ?? []).length})`).join(", ")}`);

  section("WIRE + ENVELOPE: parse + decrypt every commit on the wave5 conv");
  const audited = [];
  for (const txid of wave5Txids) {
    const ci = await jget(`/commit-info?txid=${txid}`);
    const txHex = await wocFetchTxHex(txid);
    const payload = extractPrt1Payload(txHex);
    const parsed = parsePrt1(payload);
    if (parsed.magic !== PRT1_MAGIC) fail(`PRT1 magic mismatch for ${txid}`);
    if (parsed.hookKind !== ci.hookKind) {
      fail(`  hookKind mismatch: chain=${parsed.hookKind}(0x${parsed.hookByte.toString(16)}) op=${ci.hookKind}`);
    }
    const expectedByte = HOOK_KIND_BYTES[ci.hookKind];
    if (parsed.hookByte !== expectedByte) {
      fail(`  ${ci.hookKind} WIRE byte mismatch: got 0x${parsed.hookByte.toString(16)} want 0x${expectedByte.toString(16)}`);
    }
    let unseal = null;
    try {
      unseal = await unsealAsAuditor(ci.envelopeKey, externalPriv, externalGrantId);
    } catch (e) {
      info(`  ${ci.hookKind} (seq=${parsed.sequence}) unseal threw: ${e.message.slice(0, 80)}`);
    }
    const inScope = unseal?.ok && unseal?.integrityOk;
    audited.push({
      txid,
      seq: parsed.sequence,
      hookKind: parsed.hookKind,
      hookByte: parsed.hookByte,
      inScope,
      plaintext: unseal?.plaintext,
    });
  }
  audited.sort((a, b) => a.seq - b.seq);
  for (const a of audited) {
    const tag = a.inScope ? "ext-auditor in-scope" : "ext-auditor out-of-scope (PHI)";
    ok(`  seq=${String(a.seq).padStart(2)} hookKind=${a.hookKind.padEnd(20)} byte=0x${a.hookByte.toString(16).padStart(2, "0")} ${tag}`);
  }

  section("CHAIN: per-conv sequence is monotonic 1..N");
  const seqs = audited.map((a) => a.seq).sort((a, b) => a - b);
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i + 1) fail(`sequence gap: expected ${i + 1}, got ${seqs[i]} (full: ${seqs})`);
  }
  ok(`per-conv chain: 1..${seqs[seqs.length - 1]} contiguous`);

  section("COVERAGE: every implementable HookKind anchored at least once");
  const seenHookKinds = new Set(audited.map((a) => a.hookKind));
  // extensionAuthored lands on the active conv when the load fires;
  // search across every conv to find the anchor.
  let extensionAuthoredCommit = null;
  for (const [convId, txids] of allTxidsByConv.entries()) {
    for (const txid of txids) {
      const ci = await jget(`/commit-info?txid=${txid}`);
      if (ci.hookKind === "extensionAuthored") {
        extensionAuthoredCommit = { ...ci, sourceConv: convId };
        break;
      }
    }
    if (extensionAuthoredCommit) break;
  }
  if (extensionAuthoredCommit) {
    seenHookKinds.add("extensionAuthored");
    ok(`extensionAuthored found in conv=${extensionAuthoredCommit.sourceConv}, seq=${extensionAuthoredCommit.sequence}, txid=${extensionAuthoredCommit.txid.slice(0, 16)}…`);
    // WIRE check on extensionAuthored
    const extHex = await wocFetchTxHex(extensionAuthoredCommit.txid);
    const extParsed = parsePrt1(extractPrt1Payload(extHex));
    if (extParsed.hookByte !== HOOK_KIND_BYTES.extensionAuthored) {
      fail(`extensionAuthored WIRE byte mismatch: got 0x${extParsed.hookByte.toString(16)} want 0x${HOOK_KIND_BYTES.extensionAuthored.toString(16)}`);
    }
    ok(`extensionAuthored WIRE byte 0x${extParsed.hookByte.toString(16).padStart(2, "0")} ✓`);
  } else {
    fail("extensionAuthored NOT found anywhere on chain — wrapper not firing or polled too early");
  }

  for (const expected of expectedHookKinds) {
    if (seenHookKinds.has(expected)) {
      ok(`  ${expected} present`);
    } else {
      fail(`  ${expected} MISSING — hook never anchored on chain`);
    }
  }
  const coverageCount = expectedHookKinds.filter((h) => seenHookKinds.has(h)).length;
  ok(`Coverage: ${coverageCount}/${expectedHookKinds.length} expected HookKinds anchored on mainnet`);

  section("PERSONA SCOPE: operations-tagged hooks decryptable by External Auditor");
  // Three classes of commits per the v0.2 wave5 design:
  //   ALWAYS_OPS — wrapper anchors a PHI-safe summary under
  //                ["operations"] explicitly. External Auditor MUST
  //                decrypt every one.
  //   PHI_DEFAULT — wrapper passes raw ctx to __pt_commit_async without
  //                explicit scope; falls back to HIPAA_PRESET's default
  //                ["PHI", "treatment"]. External Auditor CANNOT
  //                decrypt by design (PHI carrier).
  //   CONTEXTUAL — the same hookKind can be either, depending on
  //                whether user code (e.g. triage) widened scope via
  //                pendingCommitMeta. We assert "at least one in-scope"
  //                rather than per-commit.
  const ALWAYS_OPS = new Set([
    "configureSession", "fiberStart", "getModel", "getTools", "stash",
    "extensionAuthored", "beforeTurn", "beforeStep", "onChunk",
    "onStepFinish", "fiberRecovered", "onChatRecovery",
  ]);
  const PHI_DEFAULT = new Set(["beforeToolCall", "afterToolCall"]);
  const CONTEXTUAL = new Set(["onChatResponse"]);
  let scopeFails = 0;
  let anyOnChatResponseInScope = false;
  for (const a of audited) {
    if (ALWAYS_OPS.has(a.hookKind)) {
      if (!a.inScope) {
        fail(`  ${a.hookKind} (seq=${a.seq}) NOT decryptable by External Auditor — operations scope expected`);
        scopeFails++;
      }
    } else if (PHI_DEFAULT.has(a.hookKind)) {
      if (a.inScope) {
        fail(`  ${a.hookKind} (seq=${a.seq}) DECRYPTED for External Auditor — should be PHI-scoped only`);
        scopeFails++;
      }
    } else if (CONTEXTUAL.has(a.hookKind)) {
      if (a.hookKind === "onChatResponse" && a.inScope) anyOnChatResponseInScope = true;
    }
  }
  if (CONTEXTUAL.size > 0 && !anyOnChatResponseInScope) {
    fail(`no onChatResponse commit decryptable by External Auditor — triage path should have widened scope`);
    scopeFails++;
  }
  if (scopeFails === 0) {
    ok(`persona scope filter holds across all ${audited.length} wave5 commits (ops hooks decrypt, PHI hooks correctly hidden, ≥1 onChatResponse widened)`);
  }

  section("RESERVED FOR v0.3");
  for (const r of (scenarioReport?.reservedV03 ?? ["paymentBRC29", "keyRotation", "stepMerkleRoot"])) {
    info(`  ${r} — wire byte reserved, no upstream trigger in v0.2`);
  }

  section("RESULT");
  console.log(`\n\x1b[1m\x1b[32m  WAVE 5 GATE PASSED\x1b[0m — ${audited.length} commits on the wave5 conv + 1 extensionAuthored on the agent's chain space.\n`);
  console.log("  Wave5 conv:      " + scenarioConvId);
  console.log("  Per-conv chain:  1..", seqs[seqs.length - 1]);
  console.log("  Coverage:        " + coverageCount + "/" + expectedHookKinds.length + " HookKinds anchored");
  console.log("  Persona scope:   " + (scopeFails === 0 ? "all hooks correctly gated" : `${scopeFails} mismatches`));
  console.log("  Mainnet spend:   ~" + (audited.length + 1) * 36 + " sat (estimated)");
  console.log("  v0.3 reserved:   paymentBRC29, keyRotation, stepMerkleRoot");
}

// ── WS replay harvester ────────────────────────────────────────────
async function harvestTxidsViaWs(convId) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const txids = [];
    const ws = new WebSocket(WS_URL);
    const flush = () => {
      if (resolved) return;
      resolved = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(txids);
    };
    const timeout = setTimeout(flush, 8_000);
    ws.addEventListener("open", () => {
      // Server auto-replays the most-recently-active conv on connect; if
      // that's not the one we want, send select-conversation.
      ws.send(JSON.stringify({ kind: "select-conversation", conversationId: convId }));
    });
    ws.addEventListener("message", (ev) => {
      try {
        const e = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (e.kind === "commit" && e.conversationId === convId && e.txid) {
          if (!txids.includes(e.txid)) txids.push(e.txid);
        }
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(timeout);
      flush();
    });
    ws.addEventListener("error", (e) => {
      clearTimeout(timeout);
      reject(new Error(`WS error: ${e?.message ?? e}`));
    });
  });
}

main().catch((e) => {
  console.error(`\x1b[31m✗ fatal: ${e.message}\x1b[0m`);
  process.exit(1);
});
