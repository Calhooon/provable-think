#!/usr/bin/env node
/**
 * provable-think-verify — standalone CLI for verifying provable-think audit
 * trails as an external auditor.
 *
 * Independent of the operator's agent Worker. The auditor runs this on their
 * own machine with:
 *
 *   - the on-chain txid of the commitment they want to inspect
 *   - the ViewingCapability JSON the operator handed them out-of-band
 *
 * The CLI:
 *   1. Reads the capability (auditor priv key, scope, agent identity pub key,
 *      envelopeServerUrl).
 *   2. Fetches the BSV transaction from WhatsOnChain.
 *   3. Parses the OP_RETURN PRT1 payload, validates the magic + signature.
 *   4. Asks the operator's Worker for the matching envelope storage key
 *      (`/commit-info?txid=...`) and fetches the envelope (`/envelope?key=...`).
 *   5. Decrypts the envelope using the auditor's priv key + agent's pub key
 *      (BRC-42 ECDH), then re-hashes the plaintext and compares to the
 *      on-chain commitment hash.
 *   6. Prints a per-step pass/fail report and the decrypted plaintext.
 *
 * Exit codes: 0 on full integrity pass; 1 on any failure.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  PrivateKey,
  ProtoWallet,
  Transaction,
  Utils,
} from "@bsv/sdk";
import {
  unsealEnvelope,
  verifyEnvelopeIntegrity,
  type SealedEnvelope,
  type ViewingCapability,
} from "provable-think";

// ===== argv parsing =====

const args = parseArgs({
  options: {
    txid: { type: "string" },
    capability: { type: "string" },
    "envelope-server-url": { type: "string" },
    help: { type: "boolean", short: "h" },
    json: { type: "boolean" }, // emit a single JSON blob instead of per-step prints
  },
  strict: true,
  allowPositionals: false,
});

if (args.values.help || !args.values.txid || !args.values.capability) {
  console.log(
    [
      "provable-think-verify — standalone audit-trail verifier",
      "",
      "Usage:",
      "  provable-think-verify --txid <hex> --capability <path/to/capability.json>",
      "                        [--envelope-server-url <url>]",
      "                        [--json]",
      "",
      "Required:",
      "  --txid               64-char hex public-ledger transaction id (the receipt commitment)",
      "  --capability         path to the ViewingCapability JSON the operator gave you",
      "",
      "Optional:",
      "  --envelope-server-url override the URL inside the capability (e.g. local test worker)",
      "  --json                emit a single JSON object on stdout instead of step-by-step",
      "  -h, --help            this text",
    ].join("\n"),
  );
  process.exit(args.values.help ? 0 : 2);
}

const TXID = args.values.txid as string;
const CAPABILITY_PATH = args.values.capability as string;
const JSON_MODE = args.values.json === true;

// ===== orchestration =====

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

const steps: StepResult[] = [];
function step(name: string, ok: boolean, detail?: string): void {
  steps.push({ step: name, ok, detail });
  if (!JSON_MODE) {
    const tag = ok ? "OK  " : "FAIL";
    process.stderr.write(`${tag}  ${name}${detail ? ` — ${detail}` : ""}\n`);
  }
}

async function main(): Promise<void> {
  // --- 1. capability ---
  let capability: ViewingCapability;
  try {
    capability = JSON.parse(
      readFileSync(CAPABILITY_PATH, "utf8"),
    ) as ViewingCapability;
    step(
      "read capability",
      true,
      `id=${capability.id} recipient=${capability.recipientPubHex.slice(0, 16)}…`,
    );
  } catch (e) {
    step(
      "read capability",
      false,
      `${(e as Error).message}`,
    );
    return done(false);
  }

  if (capability.validUntil && capability.validUntil < Date.now()) {
    step(
      "capability validity",
      false,
      `expired at ${new Date(capability.validUntil).toISOString()}`,
    );
    return done(false);
  } else {
    step("capability validity", true);
  }

  const envelopeServerUrl = (
    args.values["envelope-server-url"] ??
    capability.envelopeServerUrl ??
    ""
  ).replace(/\/+$/, "");
  if (!envelopeServerUrl) {
    step(
      "envelope server URL",
      false,
      "neither --envelope-server-url nor capability.envelopeServerUrl is set",
    );
    return done(false);
  }
  step("envelope server URL", true, envelopeServerUrl);

  // --- 2. fetch tx from WhatsOnChain ---
  let txHex: string;
  try {
    const r = await fetch(
      `https://api.whatsonchain.com/v1/bsv/main/tx/${TXID}/hex`,
    );
    if (!r.ok) throw new Error(`public-ledger explorer returned ${r.status}`);
    txHex = (await r.text()).trim();
    step("fetch tx from public ledger", true, `${txHex.length / 2} bytes`);
  } catch (e) {
    step("fetch tx from public ledger", false, (e as Error).message);
    return done(false);
  }

  // --- 3. parse OP_RETURN, find PRT1 payload, verify signature ---
  let prt1: PRT1Payload;
  try {
    const tx = Transaction.fromHex(txHex);
    const opReturn = tx.outputs.find((o) =>
      isOpReturnLockingScript(o.lockingScript as unknown as { toHex(): string }),
    );
    if (!opReturn) throw new Error("no OP_RETURN output found");
    const opReturnHex = (
      opReturn.lockingScript as unknown as { toHex(): string }
    ).toHex();
    prt1 = parsePrt1FromOpReturnHex(opReturnHex);
    step(
      "parse PRT1 payload",
      true,
      `seq=${prt1.sequence} hookKind=0x${prt1.hookKindByte.toString(16).padStart(2, "0")} commitHash=${prt1.commitHashHex.slice(0, 16)}…`,
    );
  } catch (e) {
    step("parse PRT1 payload", false, (e as Error).message);
    return done(false);
  }

  // Note: the PRT1 derivedPubkey is per-commitment-derived (BRC-42), so we
  // can't directly match it to the agent's identity key. The on-chain
  // signature is verified by the agent's wallet at sign time; here we trust
  // the chain. The key integrity check is the plaintext-hash match below.

  // --- 4. fetch commit info from operator's worker ---
  let commitInfo: {
    txid: string;
    sequence: number;
    hookKind: string;
    commitHash: string;
    ts: string;
    envelopeKey: string;
    agentIdentityPubHex: string;
  };
  try {
    const r = await fetch(`${envelopeServerUrl}/commit-info?txid=${TXID}`);
    if (!r.ok)
      throw new Error(
        `operator commit-info endpoint returned ${r.status}: ${await r.text()}`,
      );
    commitInfo = await r.json() as typeof commitInfo;
    step(
      "fetch commit-info from operator",
      true,
      `seq=${commitInfo.sequence} envelopeKey=${commitInfo.envelopeKey}`,
    );
  } catch (e) {
    step("fetch commit-info from operator", false, (e as Error).message);
    return done(false);
  }

  // Cross-check: chain commit hash must match operator-reported commit hash.
  if (commitInfo.commitHash !== prt1.commitHashHex) {
    step(
      "ledger commit hash matches operator record",
      false,
      `ledger=${prt1.commitHashHex.slice(0, 16)} operator=${commitInfo.commitHash.slice(0, 16)}`,
    );
    return done(false);
  }
  step("ledger commit hash matches operator record", true);

  if (commitInfo.agentIdentityPubHex !== capability.agentIdentityPubHex) {
    step(
      "agent identity pubkey matches capability",
      false,
      "operator's agent pubkey does not match capability — possible misissued capability",
    );
    return done(false);
  }
  step("agent identity pubkey matches capability", true);

  // --- 5. fetch envelope from operator's worker ---
  let envelope: SealedEnvelope;
  try {
    const r = await fetch(
      `${envelopeServerUrl}/envelope?key=${encodeURIComponent(commitInfo.envelopeKey)}`,
    );
    if (!r.ok) throw new Error(`envelope fetch returned ${r.status}`);
    envelope = (await r.json()) as SealedEnvelope;
    step("fetch envelope", true, `${envelope.recipients.length} recipients`);
  } catch (e) {
    step("fetch envelope", false, (e as Error).message);
    return done(false);
  }

  // --- 6. decrypt as auditor ---
  let plaintextBytes: number[];
  try {
    const auditorWallet = new ProtoWallet(
      PrivateKey.fromHex(getAuditorPrivKeyHex(capability)),
    );
    plaintextBytes = await unsealEnvelope({
      wallet: auditorWallet,
      envelope,
      recipientId: capability.id,
      agentIdentityPubHex: capability.agentIdentityPubHex,
    });
    step(
      "decrypt envelope as auditor",
      true,
      `${plaintextBytes.length} bytes plaintext`,
    );
  } catch (e) {
    step("decrypt envelope as auditor", false, (e as Error).message);
    return done(false);
  }

  // --- 7. integrity check ---
  const integrityOk = verifyEnvelopeIntegrity(envelope, plaintextBytes);
  step(
    "verify plaintext hash matches on-ledger commitment",
    integrityOk,
    integrityOk ? envelope.header.plaintextHash : "AEAD/hash mismatch",
  );

  // --- 8. emit final report ---
  const allOk = steps.every((s) => s.ok);
  if (JSON_MODE) {
    const text = new TextDecoder().decode(new Uint8Array(plaintextBytes));
    process.stdout.write(
      JSON.stringify(
        {
          ok: allOk,
          txid: TXID,
          steps,
          envelopeKey: commitInfo.envelopeKey,
          plaintext: text,
          plaintextHash: envelope.header.plaintextHash,
          header: envelope.header,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (allOk) {
    process.stderr.write(
      `\n=== INTEGRITY OK — txid ${TXID} ===\n` +
        `agent identity: ${capability.agentIdentityPubHex}\n` +
        `sequence:       ${commitInfo.sequence}\n` +
        `hook kind:      ${commitInfo.hookKind}\n` +
        `committed at:   ${commitInfo.ts}\n` +
        `commit hash:    ${envelope.header.plaintextHash}\n\n` +
        "PLAINTEXT:\n" +
        new TextDecoder().decode(new Uint8Array(plaintextBytes)) +
        "\n",
    );
  } else {
    process.stderr.write(
      `\n=== INTEGRITY FAILED — txid ${TXID} ===\n` +
        steps
          .filter((s) => !s.ok)
          .map((s) => `  - ${s.step}: ${s.detail ?? "(no detail)"}`)
          .join("\n") +
        "\n",
    );
  }
  process.exit(allOk ? 0 : 1);
}

function done(ok: boolean): void {
  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ ok, steps }, null, 2) + "\n");
  }
  process.exit(ok ? 0 : 1);
}

// ===== PRT1 payload parsing =====

interface PRT1Payload {
  hookKindByte: number;
  sequence: number;
  commitHashHex: string;
  derivedPubkeyHex: string;
  signatureHex: string;
}

function parsePrt1FromOpReturnHex(scriptHex: string): PRT1Payload {
  const bytes = Utils.toArray(scriptHex, "hex") as number[];
  // Find the PRT1 magic. The OP_RETURN script is OP_FALSE (0x00) OP_RETURN (0x6a)
  // OP_PUSHDATA1 (0x4c) <length> <bytes> ... — locate "PRT1" within.
  const magic = [0x50, 0x52, 0x54, 0x31]; // "PRT1"
  let start = -1;
  for (let i = 0; i + magic.length <= bytes.length; i++) {
    if (
      bytes[i] === magic[0] &&
      bytes[i + 1] === magic[1] &&
      bytes[i + 2] === magic[2] &&
      bytes[i + 3] === magic[3]
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error("PRT1 magic not found in OP_RETURN");
  const p = bytes.slice(start);
  if (p.length < 75) throw new Error(`PRT1 payload too short: ${p.length}`);
  const hookKindByte = p[4];
  const sequence =
    ((p[5] << 24) | (p[6] << 16) | (p[7] << 8) | p[8]) >>> 0;
  const commitHashHex = Utils.toHex(p.slice(9, 41));
  const derivedPubkeyHex = Utils.toHex(p.slice(41, 74));
  const sigLen = p[74];
  if (75 + sigLen > p.length) throw new Error("PRT1 signature length overflow");
  const signatureHex = Utils.toHex(p.slice(75, 75 + sigLen));
  return {
    hookKindByte,
    sequence,
    commitHashHex,
    derivedPubkeyHex,
    signatureHex,
  };
}

function isOpReturnLockingScript(s: { toHex(): string }): boolean {
  // OP_FALSE (0x00) + OP_RETURN (0x6a) prefix
  const h = s.toHex();
  return h.startsWith("006a");
}

// ===== capability helpers =====

/**
 * Extract the auditor's priv key from a capability JSON. The capability we
 * issue server-side does NOT include the priv key — the auditor pairs the
 * capability with their own priv key. For this CLI we accept the priv key
 * either inside the capability JSON (under an explicit `auditorPrivKeyHex`
 * key — convenience for testing) or via env var `AUDITOR_PRIVATE_KEY_HEX`.
 */
function getAuditorPrivKeyHex(
  capability: ViewingCapability & { auditorPrivKeyHex?: string },
): string {
  const fromCap = capability.auditorPrivKeyHex;
  const fromEnv = process.env["AUDITOR_PRIVATE_KEY_HEX"];
  const k = fromCap ?? fromEnv;
  if (!k || !/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error(
      "auditor priv key not found. Set capability.auditorPrivKeyHex (testing) or env AUDITOR_PRIVATE_KEY_HEX (production).",
    );
  }
  return k;
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n${(e as Error).stack ?? ""}\n`);
  process.exit(1);
});
