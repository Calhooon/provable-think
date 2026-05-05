/**
 * Live BSV / USD exchange rate fetched from WhatsOnChain. WoC exposes
 * the rate as a free, browser-CORS-enabled endpoint:
 *
 *   GET https://api.whatsonchain.com/v1/bsv/main/exchangerate
 *   → { rate: 15.50, time: 1777420064, currency: "USD" }
 *
 * `rate` is USD per BSV (one whole BSV = `rate` dollars). To convert
 * sats to USD: `(sats / 100_000_000) * rate`.
 *
 * Use `useLiveExchangeRate()` to wire the polling loop once at
 * `App.tsx` mount; consumers read from the Zustand store.
 */

import { useEffect } from "react";
import { useAppStore } from "../store";

const WOC_RATE_URL = "https://api.whatsonchain.com/v1/bsv/main/exchangerate";
const REFRESH_MS = 60_000;

interface WocRate {
  rate: number;
  time: number;
  currency: string;
}

/**
 * Convert sats → USD using a known exchange rate (USD per BSV).
 * Returns `null` when no rate is loaded yet so callers can render a
 * placeholder rather than $0.
 */
export function satsToUsd(sats: number, rateUsd: number | null): number | null {
  if (rateUsd === null || rateUsd <= 0) return null;
  return (sats / 100_000_000) * rateUsd;
}

/** Format a USD amount with appropriate precision for sub-cent values. */
export function formatUsd(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.000001) return `$${(usd * 1e9).toFixed(2)}n`;
  if (usd < 0.001) return `$${(usd * 1e6).toFixed(2)}μ`;
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Convenience: sats → USD → formatted string. */
export function satsToUsdString(
  sats: number,
  rateUsd: number | null,
): string {
  if (rateUsd === null) return "—";
  return formatUsd(satsToUsd(sats, rateUsd));
}

/**
 * Mount-once polling loop. Drops the latest rate into the Zustand store
 * so `BalanceChip` / `HeroBanner` / `OperatorPane` all read consistently.
 */
export function useLiveExchangeRate(): void {
  const setExchangeRate = useAppStore((s) => s.setExchangeRate);
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    async function tick() {
      try {
        const r = await fetch(WOC_RATE_URL, { mode: "cors" });
        if (!r.ok) throw new Error(`WoC rate ${r.status}`);
        const body = (await r.json()) as WocRate;
        if (!cancelled && body && typeof body.rate === "number" && body.rate > 0) {
          setExchangeRate({ rateUsd: body.rate, fetchedAt: Date.now() });
        }
      } catch (e) {
        // Silent retry — keep last-known.
        console.debug("[exchange-rate] fetch failed:", (e as Error).message);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, REFRESH_MS);
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [setExchangeRate]);
}
