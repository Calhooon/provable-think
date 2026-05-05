/**
 * Workers-native multi-ARC race broadcaster.
 *
 * Replaces `@bsv/sdk`'s `ARC` class which is broken in Cloudflare Workers
 * (it calls Node's `https.request`, not implemented by `unenv`).
 *
 * Single-ARC broadcast is *unreliable*. We verified this on 2026-04-28: TaaL's
 * ARC stalls at `ANNOUNCED_TO_NETWORK` for child txs whose parents were also
 * TaaL-broadcast. GorillaPool's open ARC reaches `SEEN_ON_NETWORK` for the
 * same tx within 30s. **Always race multiple ARCs in parallel** — same pattern
 * `bsv-wallet-infra-cloudflare` ships with internally.
 *
 * Wire format: `POST /v1/tx` with `{rawTx: <hex string>}` body. ARC's `rawTx`
 * field accepts plain hex or EF (BRC-30); does NOT auto-detect BEEF.
 *
 * Lifted from the Phase 1 spike with light reorganisation.
 */

// Statuses we treat as broadcast FAILURE: do NOT advance the chain head, do
// NOT mark the input UTXO as spent, and do NOT add a change UTXO to the pool.
// Critical: `SEEN_IN_ORPHAN_MEMPOOL` means ARC saw the tx but its parent isn't
// in the mempool — the tx will never propagate or mine, and any child built on
// its change output would inherit orphan status, cascading the failure across
// the entire commit chain. Treating it as success would silently corrupt the
// agent's UTXO pool. See: https://docs.gorillapool.io/arc/reference#tx-status.
const ARC_ERROR_STATUSES = new Set([
  "DOUBLE_SPEND_ATTEMPTED",
  "REJECTED",
  "INVALID",
  "MALFORMED",
  "SEEN_IN_ORPHAN_MEMPOOL",
]);

const ARC_PROPAGATED_STATUSES = new Set([
  "SEEN_ON_NETWORK",
  "MINED",
  "CONFIRMED",
]);

export interface ArcAttempt {
  url: string;
  status: "success" | "error";
  /** Strict propagation: txStatus in {SEEN_ON_NETWORK, MINED, CONFIRMED}. */
  propagated: boolean;
  txStatus?: string;
  txid?: string;
  httpStatus?: number;
  body?: unknown;
  error?: string;
}

export interface ArcRaceResult {
  status: "success" | "error";
  /** True if at least one ARC reported propagation. */
  propagated: boolean;
  /** The best of the attempts (preferred: propagated > submitted > error). */
  best: ArcAttempt;
  attempts: ArcAttempt[];
  txid?: string;
  txStatus?: string;
  error?: string;
}

export interface ArcOptions {
  /** TaaL API key. Sent as `Authorization: Bearer ...` only to TaaL endpoints. */
  taalApiKey?: string;
  /** Override `XDeployment-ID` header. Default: `provable-think-v0.1`. */
  deploymentId?: string;
  /** Max wait for SEEN_ON_NETWORK. ARC enforces a hard 30s cap. */
  maxTimeoutSeconds?: number;
}

/**
 * Default ARC fan-out for BSV mainnet.
 *
 * - GorillaPool's open ARC: no API key required, reliably reaches SEEN_ON_NETWORK.
 * - TaaL's ARC: needs an API key for sustained use, sometimes stalls at ANNOUNCED.
 *
 * Including both gives best peer reach.
 */
export const DEFAULT_MAINNET_ARC_URLS = [
  "https://arc.gorillapool.io",
  "https://api.taal.com/arc",
];

async function broadcastToOneArc(
  arcUrl: string,
  txWire: string,
  options: ArcOptions,
): Promise<ArcAttempt> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "XDeployment-ID": options.deploymentId ?? "provable-think-v0.1",
    "X-WaitFor": "SEEN_ON_NETWORK",
    // ARC enforces a hard 30s cap — anything higher returns 400 with
    // `extraInfo: "max timeout can not be higher than 30 "`.
    "X-MaxTimeout": String(Math.min(options.maxTimeoutSeconds ?? 30, 30)),
  };
  if (options.taalApiKey && arcUrl.includes("taal.com")) {
    headers["Authorization"] = `Bearer ${options.taalApiKey}`;
  }
  const url = arcUrl.replace(/\/+$/, "") + "/v1/tx";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ rawTx: txWire }),
    });
  } catch (e) {
    return {
      url: arcUrl,
      status: "error",
      propagated: false,
      error: `fetch threw: ${(e as Error).message}`,
    };
  }

  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text };
  }

  const txStatus = (body as { txStatus?: string }).txStatus;
  const submitted = res.ok && !!txStatus && !ARC_ERROR_STATUSES.has(txStatus);
  const propagated = submitted && ARC_PROPAGATED_STATUSES.has(txStatus);

  return {
    url: arcUrl,
    status: submitted ? "success" : "error",
    propagated,
    txStatus,
    txid: (body as { txid?: string }).txid,
    httpStatus: res.status,
    body,
  };
}

/**
 * Race a tx broadcast across multiple ARC providers.
 *
 * Returns the *best* attempt by preference: propagated > submitted > error.
 * All attempts are kept in `attempts` for diagnostics.
 *
 * @param txWire - hex-encoded transaction in plain or EF (BRC-30) format
 *                 (NOT BEEF — ARC's `rawTx` does not accept BEEF prefix).
 * @param arcUrls - list of ARC base URLs. Defaults to `DEFAULT_MAINNET_ARC_URLS`.
 */
export async function broadcastArcRace(
  txWire: string,
  arcUrls: string[] = DEFAULT_MAINNET_ARC_URLS,
  options: ArcOptions = {},
): Promise<ArcRaceResult> {
  const results: ArcAttempt[] = await Promise.all(
    arcUrls.map((u) => broadcastToOneArc(u, txWire, options)),
  );

  const propagatedHit = results.find((r) => r.propagated);
  const submittedHit = results.find((r) => r.status === "success");
  const best = propagatedHit ?? submittedHit ?? results[0];

  return {
    status: best.status,
    propagated: best.propagated,
    best,
    attempts: results,
    txid: best.txid,
    txStatus: best.txStatus,
    error: best.error,
  };
}
