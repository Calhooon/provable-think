import { useMemo } from "react";
import { motion } from "framer-motion";
import { Activity, ExternalLink, Wallet, Wifi } from "lucide-react";
import { Counter } from "../components";
import { useAppStore, selectTotalCommits, selectTotalSats } from "../store";
import { cn } from "../lib/cn";
import { motion as motionTokens } from "../lib/tokens";
import { satsToUsd, formatUsd as formatUsdLib } from "../lib/exchange-rate";

function formatUsd(sats: number, rateUsd: number | null): string {
  if (rateUsd === null) return "—";
  const usd = satsToUsd(sats, rateUsd);
  return `≈ ${formatUsdLib(usd)}`;
}

/**
 * Above-the-fold live banner per the demo brief: at any moment a viewer
 * sees X events anchored · $Y cost · agents online — real money flowing
 * to mainnet.
 */
export function HeroBanner() {
  // Hero counters reflect ALL conversations on the agent — the demo's
  // headline metric is "events anchored across the whole agent", not "the
  // current tab". The per-conversation breakdown is in the tab bar.
  const totalCommits = useAppStore(selectTotalCommits);
  const totalSats = useAppStore(selectTotalSats);
  const convCount = useAppStore((s) => s.conversationIds.length);
  const connectionState = useAppStore((s) => s.connectionState);
  const exchangeRate = useAppStore((s) => s.exchangeRate);
  const isLive = connectionState === "open";
  const rateUsd = exchangeRate?.rateUsd ?? null;
  // Disambiguate scope vs. the per-pane "events anchored" stat: hero sums
  // across all conversations, operator pane is just the active one.
  const scopeNote =
    convCount === 0
      ? null
      : convCount === 1
        ? "in this conversation"
        : `across ${convCount} conversations`;
  // Suppress the unused import warning from the prior single-conversation impl.
  void useMemo;

  return (
    <section
      className={cn(
        "border-b border-border",
        "bg-gradient-to-b from-canvas via-canvas to-canvas/80",
      )}
      aria-label="Live demo metrics"
    >
      <div
        className={cn(
          "max-w-[1600px] mx-auto",
          "px-3 sm:px-4 py-4 sm:py-5",
          "grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-6",
        )}
      >
        <Stat
          icon={<Activity className="w-4 h-4" />}
          label="Events anchored to the public ledger"
          value={
            <Counter
              value={totalCommits}
              label="Events anchored"
              className="text-2xl sm:text-3xl font-semibold text-fg font-mono"
            />
          }
          sublabel={scopeNote}
          accent="confirmed"
        />
        <Stat
          icon={<Wallet className="w-4 h-4" />}
          label={
            rateUsd !== null
              ? "Total anchoring spend · live ledger rate"
              : "Total anchoring spend"
          }
          value={
            <span className="text-2xl sm:text-3xl font-semibold text-fg font-mono tabular-nums">
              {formatUsd(totalSats, rateUsd).replace(/^≈\s*/, "")}
            </span>
          }
          sublabel={scopeNote}
          accent="propagating"
        />
        <Stat
          icon={<Wifi className="w-4 h-4" />}
          label="Demo agent · session status"
          value={
            <motion.span
              key={isLive ? "live" : "off"}
              initial={{ opacity: 0.6 }}
              animate={{ opacity: 1 }}
              transition={{
                duration: motionTokens.micro,
                ease: motionTokens.ease,
              }}
              className={cn(
                "text-2xl sm:text-3xl font-semibold font-mono",
                isLive ? "text-confirmed" : "text-fg-muted",
              )}
            >
              {isLive ? "1 online" : "offline"}
            </motion.span>
          }
          accent={isLive ? "confirmed" : "default"}
          right={
            <a
              href="https://github.com/Calhooon/provable-think"
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "text-xs text-fg-secondary hover:text-accent-dark",
                "inline-flex items-center gap-1 whitespace-nowrap",
              )}
            >
              See the source
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
          }
        />
      </div>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  accent,
  right,
  sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  accent: "confirmed" | "propagating" | "default";
  right?: React.ReactNode;
  sublabel?: string | null;
}) {
  const accentBar = {
    confirmed: "bg-confirmed",
    propagating: "bg-propagating",
    default: "bg-fg-muted",
  }[accent];
  return (
    <div className="flex items-stretch gap-3">
      <div className={cn("w-1 rounded-full flex-none", accentBar)} aria-hidden="true" />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-fg-muted font-medium">
            <span className="text-fg-muted">{icon}</span>
            {label}
          </span>
          {right}
        </div>
        {value}
        {sublabel && (
          <span className="text-[10px] text-fg-muted font-mono leading-none">
            {sublabel}
          </span>
        )}
      </div>
    </div>
  );
}
