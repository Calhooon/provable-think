import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldOff, Link2, ArrowUpRight } from "lucide-react";
import { cn } from "../lib/cn";

const EVENT_NAME = "acme-health:tamper-detected";

export interface TamperEventDetail {
  conversationId: string;
  sequence: number;
  envelopeKey: string;
  txid?: string;
  commitHash?: string;
}

/**
 * Dispatch this from anywhere to trigger the global flash overlay.
 * The AuditorPane fires it on a successful tamper round-trip.
 */
export function fireTamperDetected(detail: TamperEventDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TamperEventDetail>(EVENT_NAME, { detail }));
}

/**
 * Full-screen red flash overlay that fires for ~5s when an envelope is
 * mutated and the verifier reports integrity FAIL. The visceral
 * "watch immutability happen" moment — the ledger commit hash stays
 * unchanged on screen, the off-ledger ciphertext is broken, the
 * verifier flips to red instantly.
 *
 * Dismisses on click, on Escape, or after the timeout.
 */
export function TamperFlash() {
  const [detail, setDetail] = useState<TamperEventDetail | null>(null);

  useEffect(() => {
    function handler(e: Event) {
      const ce = e as CustomEvent<TamperEventDetail>;
      setDetail(ce.detail);
      const timer = setTimeout(() => setDetail(null), 6000);
      return () => clearTimeout(timer);
    }
    function escape(e: KeyboardEvent) {
      if (e.key === "Escape") setDetail(null);
    }
    window.addEventListener(EVENT_NAME, handler);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener(EVENT_NAME, handler);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  return (
    <AnimatePresence>
      {detail && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className={cn(
            "fixed inset-0 z-[60] flex items-center justify-center pointer-events-auto",
            "bg-tamper/15 backdrop-blur-[2px]",
          )}
          onClick={() => setDetail(null)}
        >
          {/* Strobe pulse layer */}
          <motion.div
            className="absolute inset-0 bg-tamper/15"
            initial={{ opacity: 0 }}
            animate={{
              opacity: [0, 0.85, 0, 0.6, 0, 0.4, 0],
            }}
            transition={{
              duration: 1.4,
              times: [0, 0.05, 0.2, 0.3, 0.5, 0.65, 1],
              ease: "linear",
            }}
          />
          {/* Center card */}
          <motion.div
            initial={{ scale: 0.85, y: 12, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              "relative max-w-xl w-[90vw]",
              "rounded-2xl border-2 border-tamper",
              "bg-surface shadow-2xl shadow-tamper/30 overflow-hidden",
            )}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-gradient-to-r from-tamper to-tamper/80 px-6 py-4 text-white">
              <div className="flex items-center gap-3">
                <motion.div
                  animate={{ rotate: [0, -10, 10, -8, 0] }}
                  transition={{ duration: 0.6, ease: "easeInOut" }}
                >
                  <ShieldOff className="w-7 h-7" aria-hidden="true" />
                </motion.div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-80">
                    BRC-78 envelope · AEAD integrity check
                  </div>
                  <div className="text-2xl font-bold tracking-tight">
                    TAMPER DETECTED
                  </div>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <p className="text-sm text-fg-secondary leading-relaxed">
                One byte was flipped in the off-ledger ciphertext on R2. The
                verifier ran the same 11-step pipeline an external auditor
                would run — and the AEAD authentication tag doesn't match
                anymore. The ledger commit hash stayed exactly where it was.
                That's the asymmetry: cheap to anchor, expensive to forge.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-tamper/40 bg-tamper/5 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-tamper font-semibold mb-1">
                    Off-chain envelope
                  </div>
                  <div className="text-xs font-mono text-fg-secondary">
                    AEAD: <span className="text-tamper font-semibold">FAIL</span>
                  </div>
                  <div className="text-[10px] font-mono text-fg-muted mt-1 break-all">
                    {detail.envelopeKey.split("/").slice(-2).join("/")}
                  </div>
                </div>
                <div className="rounded-lg border border-confirmed/40 bg-confirmed/5 p-3">
                  <div className="text-[10px] uppercase tracking-wider text-confirmed font-semibold mb-1">
                    Public-ledger anchor
                  </div>
                  <div className="text-xs font-mono text-fg-secondary">
                    Hash: <span className="text-confirmed font-semibold">UNCHANGED</span>
                  </div>
                  <div className="text-[10px] font-mono text-fg-muted mt-1 break-all">
                    seq {detail.sequence}
                    {detail.commitHash ? ` · ${detail.commitHash.slice(0, 16)}…` : ""}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-[11px] text-fg-muted leading-snug max-w-[28ch]">
                  The chain wins. The auditor's verifier reads the ledger commit
                  hash, not the envelope.
                </p>
                {detail.txid && (
                  <a
                    href={`https://whatsonchain.com/tx/${detail.txid}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "inline-flex items-center gap-1 px-2.5 py-1 rounded-md",
                      "border border-confirmed/40 bg-confirmed/5 hover:bg-confirmed/10",
                      "text-xs font-medium text-confirmed transition-colors",
                    )}
                  >
                    <Link2 className="w-3 h-3" aria-hidden="true" />
                    Verify on WoC
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
