import { motion, AnimatePresence } from "framer-motion";
import { Eye, Hash, KeyRound, Lock, RadioTower } from "lucide-react";
import { useAppStore } from "../store";
import { motion as motionTokens } from "../lib/tokens";
import { agentExplorerBase } from "../lib/agent-client";
import { cn } from "../lib/cn";

/**
 * "What an unauthorized observer sees" — the public-chain-only view.
 *
 * The point of this pane is the load-bearing risk-trace for an enterprise
 * audience: yes, every commit is public on a permissionless ledger, and
 * yes, *this is everything* that's public. The viewer reads a row and
 * sees: a txid, an agent pubkey, a sequence number, a commit hash, a
 * fee — and nothing else. No PHI. No scope tags (those live in the
 * encrypted envelope, not the chain). No plaintext. No reasoning. No
 * model name. No referral. The public ledger anchors immutability; the keys
 * gate disclosure. The asymmetry is the product.
 */
export function PublicObserver() {
  // Public observer shows the active conversation's chain — that's the
  // unit a real auditor would verify against. The hero banner counts
  // across all conversations.
  const commits = useAppStore((s) => {
    if (!s.activeConversationId) return [];
    return s.conversations[s.activeConversationId]?.commits ?? [];
  });
  const agentIdentityPubHex = useAppStore((s) => s.agentIdentityPubHex);

  if (commits.length === 0) return null;

  return (
    <section
      className={cn(
        "border-t border-border bg-canvas/40",
        "px-3 sm:px-4 py-5 sm:py-6",
      )}
      aria-labelledby="observer-title"
    >
      <div className="max-w-[1600px] mx-auto flex flex-col gap-4">
        <header className="flex items-start gap-3 flex-wrap">
          <div
            className={cn(
              "flex-none w-10 h-10 rounded-lg",
              "bg-fg/5 border border-border",
              "flex items-center justify-center",
            )}
            aria-hidden="true"
          >
            <Eye className="w-5 h-5 text-fg-muted" />
          </div>
          <div className="flex-1 min-w-0">
            <h2
              id="observer-title"
              className="text-base font-semibold text-fg leading-tight"
            >
              What an unauthorized observer sees
            </h2>
            <p className="text-xs sm:text-sm text-fg-secondary mt-1 leading-relaxed">
              Anyone with internet access can read the public ledger. <strong className="text-fg">This is the entirety of what's public</strong> for the events above. No PHI. No scope tags. No model output. No referral. The public ledger anchors immutability; the encrypted envelope (off-ledger, R2 / UHRP) holds everything else, and only viewing-key holders can read it.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] uppercase tracking-wider text-fg-muted font-medium">
          <Legend icon={<Hash className="w-3 h-3" />} label="Txid + sequence" />
          <Legend icon={<RadioTower className="w-3 h-3" />} label="HookKind + commit hash" />
          <Legend icon={<KeyRound className="w-3 h-3" />} label="Agent identity pubkey" />
          <Legend icon={<Lock className="w-3 h-3" />} label="Everything else: encrypted off-ledger" />
        </div>

        <ol
          className={cn(
            "rounded-lg border border-border bg-surface overflow-hidden divide-y divide-border",
            "font-mono text-[11px] sm:text-xs",
          )}
        >
          <li
            className={cn(
              "px-3 py-2 grid",
              "grid-cols-[60px_minmax(0,1fr)_120px]",
              "sm:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_140px]",
              "gap-3 bg-canvas/40 text-fg-muted text-[10px] uppercase tracking-wider",
            )}
          >
            <span>Seq · Hook</span>
            <span>Mainnet txid</span>
            <span className="hidden sm:block">Commit hash (SHA-256)</span>
            <span className="text-right">Agent · Fee</span>
          </li>
          <AnimatePresence initial={false}>
            {[...commits].reverse().map((c) => (
              <motion.li
                key={c.txid}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  duration: motionTokens.micro,
                  ease: motionTokens.ease,
                }}
                className={cn(
                  "px-3 py-2 grid items-center",
                  "grid-cols-[60px_minmax(0,1fr)_120px]",
                  "sm:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_140px]",
                  "gap-3 hover:bg-canvas/40 transition-colors",
                )}
              >
                <span className="text-fg-secondary">
                  <span className="text-fg">{c.sequence}</span>
                  <span className="text-fg-muted ml-1.5">{abbrev(c.hookKind)}</span>
                </span>
                <a
                  href={`${agentExplorerBase}${c.txid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent-dark hover:underline truncate"
                  title={c.txid}
                >
                  {c.txid}
                </a>
                <span className="hidden sm:block text-fg-secondary truncate" title={c.commitHash}>
                  {c.commitHash || "—"}
                </span>
                <span className="text-right text-fg-muted">
                  <span className="text-fg-secondary" title={agentIdentityPubHex ?? ""}>
                    {agentIdentityPubHex ? agentIdentityPubHex.slice(0, 8) + "…" : "—"}
                  </span>
                  <span className="ml-2">{c.feeSats ? "<1¢" : "—"}</span>
                </span>
              </motion.li>
            ))}
          </AnimatePresence>
        </ol>

        <p className="text-xs text-fg-muted leading-relaxed">
          Click any txid to verify on{" "}
          <a
            href="https://whatsonchain.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-dark hover:underline"
          >
            the ledger explorer
          </a>
          . The receipt payload is ~145 bytes: PRT1 magic + hookKind byte +
          sequence + 32-byte SHA-256 of the canonical-JSON event payload + agent
          identity pubkey + DER signature. That's it. The encrypted envelope
          containing the full event lives off-ledger, sealed under per-event
          AES-256-GCM keys; only authorized auditors hold the BRC-42-derived
          keys to unwrap them.
        </p>
      </div>
    </section>
  );
}

function Legend({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-fg-muted">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function abbrev(hookKind: string): string {
  switch (hookKind) {
    case "beforeToolCall":
      return "tool→";
    case "afterToolCall":
      return "tool✓";
    case "onChatResponse":
      return "reply";
    case "beforeStep":
      return "step→";
    case "onStepFinish":
      return "step✓";
    case "onChunk":
      return "chunk";
    case "beforeTurn":
      return "turn→";
    default:
      return hookKind;
  }
}
