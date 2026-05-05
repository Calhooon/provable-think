/**
 * Tamper helper — flips one nibble of the first AEAD ciphertext in an
 * envelope and writes the mutated JSON back to R2 under the same key.
 *
 * Gated by `env.DEMO_MODE === "true"`. Production deploys leave this off.
 */

import type { TriageAgent } from "./agent.js";

interface TamperArgs {
  agent: TriageAgent;
  conversationId: string;
  sequence: number;
}

interface TamperResult {
  ok: boolean;
  envelopeKey: string;
  before: string;
  after: string;
}

/**
 * Look up the envelope storage key for `sequence`, fetch from R2, mutate
 * one hex char of the first AEAD ciphertext, write back. Throws if
 * DEMO_MODE is off or the row/object is missing.
 */
export async function tamperWithEnvelope(
  args: TamperArgs,
): Promise<TamperResult> {
  const { agent, conversationId, sequence } = args;
  // `env` is protected on DurableObject; we go through a structural cast.
  const env = (agent as unknown as { env: import("./types.js").Env }).env;

  if (env.DEMO_MODE !== "true") {
    throw new Error("Tamper endpoint disabled (DEMO_MODE != 'true')");
  }

  // Reconstruct the storage key the way `runCommitPipeline` does internally.
  // Sequences are per-conversation so we need both keys to look up the row.
  const sql = (
    agent as unknown as { ctx: { storage: { sql: { exec(s: string, ...args: unknown[]): { toArray(): Array<Record<string, unknown>> } } } } }
  ).ctx.storage.sql;
  const row = sql
    .exec(
      "SELECT created_at FROM pt_commits WHERE conversation_id = ? AND sequence = ? LIMIT 1",
      conversationId,
      sequence,
    )
    .toArray()[0];
  if (!row) {
    throw new Error(
      `No commit recorded for conversation '${conversationId}' sequence ${sequence}`,
    );
  }
  const agentIdentityPubHex = await agent.getIdentityPublicKey();
  const agentShort = agentIdentityPubHex.slice(0, 16);
  const month = new Date(row.created_at as number).toISOString().slice(0, 7);
  const envelopeKey = `acme-health/default/${agentShort}/${conversationId}/${month}/${String(sequence).padStart(12, "0")}.env.json`;

  const obj = await env.ENVELOPES.get(envelopeKey);
  if (!obj) {
    throw new Error(`Envelope not found at ${envelopeKey}`);
  }
  const original = await obj.text();
  const parsed = JSON.parse(original) as {
    payloads?: Array<{ ciphertextHex?: string }>;
    ciphertextHex?: string;
  };

  // Find the first AEAD ciphertext field. Different envelope versions put
  // it at the top level or inside payloads[0]; tolerate both.
  const target =
    parsed.ciphertextHex !== undefined
      ? parsed
      : parsed.payloads?.[0];
  if (!target || typeof target.ciphertextHex !== "string" || target.ciphertextHex.length === 0) {
    throw new Error(`No ciphertextHex field found in envelope ${envelopeKey}`);
  }

  const flipped = flipFirstNibble(target.ciphertextHex);
  target.ciphertextHex = flipped;

  const mutated = JSON.stringify(parsed);
  await env.ENVELOPES.put(envelopeKey, mutated, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return {
    ok: true,
    envelopeKey,
    before: original.slice(0, 200),
    after: mutated.slice(0, 200),
  };
}

/** XOR 0x01 into the low bit of the first hex char so the byte changes. */
function flipFirstNibble(hex: string): string {
  if (hex.length === 0) return hex;
  const first = parseInt(hex[0]!, 16);
  if (Number.isNaN(first)) return hex;
  const flipped = (first ^ 0x1).toString(16);
  return flipped + hex.slice(1);
}
