/**
 * UHRP (Universal Hash Resolution Protocol) storage backend for sealed
 * envelopes — enables distributed, content-addressed envelope hosting where
 * no single party can suppress evidence. Operator-hosted by default; the
 * package's reference target is `https://bsv-storage-cloudflare.dev-a3e.workers.dev`,
 * a Rust→WASM Cloudflare Worker that's protocol-compatible with Babbage's
 * `nanostore.babbage.systems`.
 *
 * Upload flow:
 *   1. POST /upload (BRC-103/104 authenticated via `AuthFetch`).
 *   2. Server returns 402 Payment Required with derivationPrefix +
 *      satoshis-required headers (BRC-105).
 *   3. `AuthFetch` automatically pays via the agent's rich wallet
 *      (`createAction` builds a BRC-29 payment tx).
 *   4. Server returns 200 with `{ uploadURL, requiredHeaders }` — a presigned
 *      R2 URL the operator PUTs the encrypted blob to.
 *   5. We PUT the envelope JSON to that URL.
 *   6. The public read URL is `uploadURL` without the query string.
 *
 * Fetch flow (verifier):
 *   - GET <publicUrl> — no auth needed; envelope is encrypted.
 *
 * Why distributed storage matters (the Path D selling point):
 *   - The encrypted blob is content-addressed; any host serving the same
 *     bytes satisfies the auditor.
 *   - Operator can mirror to multiple UHRP hosts; no single host suppresses.
 *   - With self-hosted bsv-storage-cloudflare, the operator controls the
 *     storage layer end-to-end.
 */

import type { AuthFetch } from "@bsv/sdk";
import type { SealedEnvelope } from "./envelope.js";

export interface UhrpStorageConfig {
  /** Base URL of the UHRP storage server (the auth + upload endpoint). */
  endpoint: string;
  /**
   * Public-read base URL for stored files (R2 public bucket / custom domain).
   * For the user's deployment: `https://pub-0c965344954142909622d4c2aed91f87.r2.dev`.
   * Files end up at `${publicUrlBase}/cdn/${fileId}`. Without this set, the
   * uploadResult.url field is unset and verifiers can't fetch directly.
   */
  publicUrlBase?: string;
  /** Retention period in minutes. Default 525600 = 1 year. */
  retentionMinutes?: number;
}

export interface UhrpUploadResult {
  /**
   * Public read URL — what verifiers GET to fetch the encrypted envelope.
   * Only set when `config.publicUrlBase` is configured.
   */
  url?: string;
  /** R2 path-within-bucket, e.g. `cdn/SRur47CzfnBu7HyU3R5jPr`. */
  fileName: string;
  /** Raw presigned PUT URL we just uploaded to (debug only — query expires). */
  uploadUrl: string;
  /** Bytes uploaded. */
  uploadedBytes: number;
  /** Sats spent on the BRC-105 payment (server's price for this upload). */
  paidSatoshis: number;
  /** Server-side identity / signature info (for record-keeping). */
  uploaderIdentityKey?: string;
  elapsedMs: number;
}

/**
 * Upload a sealed envelope JSON blob to a UHRP host.
 *
 * `authFetch` MUST be backed by a wallet with real `createAction` support
 * (use `agent.getAuthFetch()` from a `provable-think` agent). The 402 retry
 * is handled by AuthFetch internally — we just PUT the bytes after we get
 * the presigned URL.
 */
export async function uploadEnvelopeToUhrp(args: {
  envelope: SealedEnvelope;
  authFetch: AuthFetch;
  config: UhrpStorageConfig;
}): Promise<UhrpUploadResult> {
  const t0 = Date.now();
  const fileBytes = new TextEncoder().encode(JSON.stringify(args.envelope));
  const endpoint = args.config.endpoint.replace(/\/+$/, "");

  // Step 1: POST /upload (AuthFetch handles 402 → payment → retry automatically)
  const initRes = await args.authFetch.fetch(`${endpoint}/upload`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      fileSize: fileBytes.length,
      retentionPeriod: args.config.retentionMinutes ?? 525600,
    }),
  });
  if (!initRes.ok) {
    const text = await initRes.text();
    throw new Error(
      `UHRP /upload init failed: ${initRes.status} ${text.slice(0, 300)}`,
    );
  }
  const initBody = (await initRes.json()) as {
    status?: string;
    uploadURL?: string;
    requiredHeaders?: Record<string, string>;
    amount?: number;
    description?: string;
  };
  if (
    initBody.status !== "success" ||
    !initBody.uploadURL ||
    !initBody.requiredHeaders
  ) {
    throw new Error(
      `UHRP /upload returned unexpected body: ${JSON.stringify(initBody).slice(0, 300)}`,
    );
  }

  // Step 2: PUT the file to the presigned URL with the required headers.
  const putRes = await fetch(initBody.uploadURL, {
    method: "PUT",
    headers: {
      ...initBody.requiredHeaders,
      "content-type": "application/json",
    },
    body: fileBytes,
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(
      `UHRP PUT to presigned URL failed: ${putRes.status} ${text.slice(0, 300)}`,
    );
  }

  // Step 3: derive the file's name-within-bucket from the presigned URL.
  // uploadURL format: `https://<account>.r2.cloudflarestorage.com/<bucket>/<name>?<query>`
  // We strip the query, parse the URL, and take everything after the first
  // path segment (the bucket name).
  const pathOnly = initBody.uploadURL.split("?")[0];
  const parsed = new URL(pathOnly);
  const segments = parsed.pathname.replace(/^\/+/, "").split("/");
  // segments[0] is the bucket; rest is the file path within the bucket.
  const fileName = segments.slice(1).join("/");

  // Step 4: construct the public-read URL if a publicUrlBase is configured.
  // Verifiers fetch from this URL (no auth — encrypted blob).
  const publicUrl = args.config.publicUrlBase
    ? `${args.config.publicUrlBase.replace(/\/+$/, "")}/${fileName}`
    : undefined;

  return {
    url: publicUrl,
    fileName,
    uploadUrl: initBody.uploadURL,
    uploadedBytes: fileBytes.length,
    paidSatoshis: initBody.amount ?? 0,
    uploaderIdentityKey:
      initBody.requiredHeaders["x-amz-meta-uploaderidentitykey"],
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Fetch a previously-uploaded envelope from a UHRP public URL. No auth needed
 * (envelope is encrypted; the URL itself is the only thing required).
 */
export async function fetchEnvelopeFromUhrp(
  publicUrl: string,
): Promise<SealedEnvelope> {
  const r = await fetch(publicUrl);
  if (!r.ok) {
    throw new Error(
      `UHRP fetch ${publicUrl} returned ${r.status}: ${(await r.text()).slice(0, 300)}`,
    );
  }
  const body = (await r.json()) as SealedEnvelope;
  if (!body.header || !body.ciphertextHex || !body.recipients) {
    throw new Error(
      `UHRP fetch returned non-envelope JSON: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body;
}

/** Default UHRP endpoint — the user's self-hosted Cloudflare Worker. */
export const DEFAULT_UHRP_ENDPOINT =
  "https://bsv-storage-cloudflare.dev-a3e.workers.dev";

/** Default public-read base for the user's deployment (R2 public domain). */
export const DEFAULT_UHRP_PUBLIC_URL_BASE =
  "https://pub-0c965344954142909622d4c2aed91f87.r2.dev";
