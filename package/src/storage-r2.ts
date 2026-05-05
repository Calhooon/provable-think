/**
 * R2 storage for sealed envelopes.
 *
 * Each envelope is written to a deterministic, content-addressable path so
 * the verifier can fetch by `(tenant, agent, conversation, sequence)` without
 * an external manifest. v0.1: no manifest; verifier discovers via R2
 * list-by-prefix. v0.2 will add a signed manifest for fast scanning.
 *
 * Path layout (post per-conversation chains):
 *   {prefix}/{tenant}/{agent}/{conversation}/{YYYY-MM}/{sequence:zero-padded-12}.env.json
 *
 * Sequences are per-conversation and start at 1; including the
 * conversationId in the path is what keeps two conversations on the same
 * agent from colliding on `.../000000000001.env.json`.
 *
 * Padding `sequence` keeps `r2.list({prefix, sortAlphabetical:true})` returning
 * envelopes in chronological order within a conversation.
 */

import type { SealedEnvelope } from "./envelope.js";

/**
 * Minimal R2 bucket shape. Matches Cloudflare Workers' `R2Bucket` interface
 * but defined locally so this package doesn't hard-require `@cloudflare/workers-types`.
 */
export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface R2StorageOptions {
  pathPrefix?: string;
}

/** Build the R2 object key for an envelope. */
export function envelopeKey(
  envelope: SealedEnvelope,
  options: R2StorageOptions = {},
): string {
  const prefix = (options.pathPrefix ?? "provable-think").replace(/\/+$/, "");
  const month = envelope.header.ts.slice(0, 7); // YYYY-MM
  const seq = String(envelope.header.sequence).padStart(12, "0");
  const safeTenant = sanitizeKeyPart(envelope.header.tenant);
  const safeAgent = sanitizeKeyPart(envelope.header.agent);
  const safeConv = sanitizeKeyPart(envelope.header.conversationId);
  return `${prefix}/${safeTenant}/${safeAgent}/${safeConv}/${month}/${seq}.env.json`;
}

/** Write a sealed envelope to R2. */
export async function storeEnvelope(
  bucket: R2BucketLike,
  envelope: SealedEnvelope,
  options: R2StorageOptions = {},
): Promise<{ key: string }> {
  const key = envelopeKey(envelope, options);
  const body = JSON.stringify(envelope);
  await bucket.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      hookKind: envelope.header.hookKind,
      sequence: String(envelope.header.sequence),
      plaintextHash: envelope.header.plaintextHash,
    },
  });
  return { key };
}

/** Fetch a sealed envelope from R2 by key. */
export async function fetchEnvelope(
  bucket: R2BucketLike,
  key: string,
): Promise<SealedEnvelope | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const text = await obj.text();
  return JSON.parse(text) as SealedEnvelope;
}

/**
 * List all envelope keys under a tenant/agent prefix in chronological order.
 * Use this from the verifier to discover envelopes without an explicit manifest.
 */
export async function listEnvelopeKeys(
  bucket: R2BucketLike,
  args: {
    tenant: string;
    agent: string;
    pathPrefix?: string;
    /** Optional month filter (YYYY-MM). */
    month?: string;
    limit?: number;
  },
): Promise<string[]> {
  const prefix = (args.pathPrefix ?? "provable-think").replace(/\/+$/, "");
  const safeTenant = sanitizeKeyPart(args.tenant);
  const safeAgent = sanitizeKeyPart(args.agent);
  const fullPrefix = args.month
    ? `${prefix}/${safeTenant}/${safeAgent}/${args.month}/`
    : `${prefix}/${safeTenant}/${safeAgent}/`;
  const all: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: fullPrefix,
      limit: args.limit ?? 1000,
      cursor,
    });
    all.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all.sort();
}

function sanitizeKeyPart(s: string): string {
  // R2 allows broad char sets but we want predictable, URL-safe paths.
  return s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
}
