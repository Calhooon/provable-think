import { motion as fmotion } from "framer-motion";
import type { MouseEvent } from "react";
import { cn } from "../lib/cn";
import { motion as motionTokens } from "../lib/tokens";

export type TxStatus = "confirmed" | "propagating" | "tamper" | string;

interface TxidPillProps {
  txid: string;
  txStatus?: TxStatus;
  className?: string;
}

function dotColor(status: TxStatus): string {
  if (status === "confirmed" || status === "MINED") return "bg-confirmed";
  if (
    status === "propagating" ||
    status === "SEEN_ON_NETWORK" ||
    status === "QUEUED" ||
    status === "RECEIVED"
  )
    return "bg-propagating";
  if (
    status === "tamper" ||
    status === "REJECTED" ||
    status === "SEEN_IN_ORPHAN_MEMPOOL" ||
    status === "DOUBLE_SPEND_ATTEMPTED" ||
    status === "INVALID" ||
    status === "MALFORMED"
  )
    return "bg-tamper";
  return "bg-fg-muted";
}

export function TxidPill({ txid, txStatus = "propagating", className }: TxidPillProps) {
  const truncated = txid.length > 8 ? `${txid.slice(0, 8)}…` : txid;
  const href = `https://whatsonchain.com/tx/${txid}`;

  function onContextMenu(e: MouseEvent<HTMLAnchorElement>) {
    // Right-click → copy txid to clipboard. We still allow native menu via shift+right-click.
    if (e.shiftKey) return;
    e.preventDefault();
    void navigator.clipboard?.writeText(txid).catch(() => {
      // Clipboard may be denied; fail quietly.
    });
  }

  return (
    <fmotion.a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onContextMenu={onContextMenu}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: motionTokens.txidEnter,
        ease: motionTokens.ease,
      }}
      className={cn(
        "inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-border bg-muted",
        "font-mono text-xs text-fg-secondary hover:text-fg hover:border-border-strong transition-colors",
        className,
      )}
      title={txid}
    >
      <span
        className={cn("inline-block w-2 h-2 rounded-full", dotColor(txStatus))}
        aria-hidden="true"
      />
      <span>{truncated}</span>
    </fmotion.a>
  );
}
