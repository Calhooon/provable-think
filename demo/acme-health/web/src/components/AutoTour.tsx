import { useEffect, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, X, RotateCcw, ChevronRight } from "lucide-react";
import { useAppStore } from "../store";
import type { Persona } from "../types/agent-events";
import { cn } from "../lib/cn";

const SEEN_KEY = "acme-health.tour-seen-v1";
const DURATION_MS = 7000; // 7s per step → 7 × 7 = 49s tour

interface TourStep {
  title: string;
  body: string;
  action?: { kind: "persona"; persona: Persona };
}

const STEPS: TourStep[] = [
  {
    title: "Audit-grade clinical triage",
    body:
      "Acme Health is a Cloudflare Worker AI agent that helps clinicians triage. " +
      "Every hook in its lifecycle anchors to the public ledger — auditors get cryptographic proof, not console logs.",
  },
  {
    title: "The patient asks a question",
    body:
      "Watch the middle pane. The patient describes symptoms; the agent looks up an ACC/AHA " +
      "guideline and synthesizes a recommendation. Each step fires a hook.",
  },
  {
    title: "Hooks anchor on the public ledger",
    body:
      "Operator console (left). Each green dot is a real public-ledger receipt. " +
      "Receipt payload = PRT1 magic + hookKind byte + sequence + 32-byte commit hash. " +
      "Less than a thousandth of a cent per event.",
  },
  {
    title: "Compliance Officer sees everything",
    body:
      "Switching personas now. CO holds the umbrella PHI scope — full audit visibility " +
      "into every event. Right pane lights up with all checkmarks.",
    action: { kind: "persona", persona: "compliance-officer" },
  },
  {
    title: "Patient sees only their session",
    body:
      "Patient grant scopes to PHI events from their own clinical session. " +
      "Operations metadata (model id, system prompt) stays hidden — they don't need it.",
    action: { kind: "persona", persona: "patient" },
  },
  {
    title: "External Auditor sees ops only",
    body:
      "External HIPAA Auditor decrypts operations + de-identified events. " +
      "PHI hooks (tool calls, agent reasoning) appear as locked icons — out of scope, by design.",
    action: { kind: "persona", persona: "external-auditor" },
  },
  {
    title: "Tamper a byte → chain detects",
    body:
      "Bottom-right: TAMPER ENVELOPE flips one byte in the off-ledger envelope. " +
      "The ledger commit hash stays unchanged — integrity check fails on the next verify. " +
      "Try it yourself.",
  },
];

/**
 * 60-second auto-tour overlay. Pops on first visit (gated by
 * localStorage), walks through the demo's claim in 7 timed steps,
 * triggers persona switches at the right moments. Skip + replay
 * controls. Auto-dismisses after the last step.
 *
 * Visitors who replay the tour get the full sequence again — useful
 * for showing colleagues without having to re-teach.
 */
export function AutoTour() {
  const [open, setOpen] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const setPersona = useAppStore((s) => s.setPersona);

  // Auto-show on first load. Defer slightly so the page settles first.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seen = window.localStorage.getItem(SEEN_KEY);
    if (seen) return;
    const t = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(t);
  }, []);

  // Trigger the action for the current step (e.g. persona switch).
  useEffect(() => {
    if (!open) return;
    const step = STEPS[stepIdx];
    if (!step) return;
    if (step.action?.kind === "persona") {
      setPersona(step.action.persona);
    }
  }, [open, stepIdx, setPersona]);

  // Auto-advance through steps unless paused.
  useEffect(() => {
    if (!open || paused) return;
    const t = setTimeout(() => {
      if (stepIdx < STEPS.length - 1) {
        setStepIdx((i) => i + 1);
      } else {
        // Final step — close + mark seen.
        setOpen(false);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(SEEN_KEY, "1");
        }
      }
    }, DURATION_MS);
    return () => clearTimeout(t);
  }, [open, paused, stepIdx]);

  const dismiss = useCallback(() => {
    setOpen(false);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SEEN_KEY, "1");
    }
  }, []);

  const replay = useCallback(() => {
    setStepIdx(0);
    setOpen(true);
    setPaused(false);
  }, []);

  const next = useCallback(() => {
    if (stepIdx < STEPS.length - 1) {
      setStepIdx((i) => i + 1);
    } else {
      dismiss();
    }
  }, [stepIdx, dismiss]);

  return (
    <>
      {/* Replay button: always visible bottom-left as a small chip */}
      {!open && (
        <button
          type="button"
          onClick={replay}
          className={cn(
            "fixed bottom-4 left-4 z-50",
            "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full",
            "bg-surface/95 backdrop-blur border border-border shadow-sm",
            "text-[11px] font-medium text-fg-secondary hover:text-fg",
            "hover:border-accent transition-colors",
          )}
          title="Replay the 60-second guided tour"
        >
          <Sparkles className="w-3.5 h-3.5 text-accent" aria-hidden="true" />
          Replay tour
        </button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
            className={cn(
              "fixed bottom-4 right-4 z-50 w-[calc(100vw-2rem)] max-w-md",
              "max-h-[60vh] sm:max-h-none overflow-y-auto",
              "rounded-xl border border-border bg-surface shadow-xl",
            )}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
          >
            {/* Progress bar */}
            <div className="h-0.5 bg-muted/40">
              <motion.div
                key={stepIdx + (paused ? "p" : "r")}
                className="h-full bg-accent"
                initial={{ width: 0 }}
                animate={{ width: paused ? "100%" : "100%" }}
                transition={{
                  duration: paused ? 0 : DURATION_MS / 1000,
                  ease: "linear",
                }}
              />
            </div>

            <div className="p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-accent/15 flex items-center justify-center">
                    <Sparkles
                      className="w-3.5 h-3.5 text-accent"
                      aria-hidden="true"
                    />
                  </div>
                  <div className="text-[10px] uppercase tracking-wider font-medium text-fg-muted">
                    Guided tour · {stepIdx + 1} / {STEPS.length}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={dismiss}
                  className="p-1 -m-1 rounded text-fg-muted hover:text-fg hover:bg-muted transition-colors"
                  title="Skip the tour"
                  aria-label="Skip the tour"
                >
                  <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={stepIdx}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  className="flex flex-col gap-2"
                >
                  <h3 className="text-sm font-semibold text-fg leading-tight">
                    {STEPS[stepIdx]?.title}
                  </h3>
                  <p className="text-xs text-fg-secondary leading-relaxed">
                    {STEPS[stepIdx]?.body}
                  </p>
                </motion.div>
              </AnimatePresence>

              <div className="mt-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={replay}
                  className="text-[10px] uppercase tracking-wider font-medium text-fg-muted hover:text-fg-secondary transition-colors flex items-center gap-1"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  Restart
                </button>
                <button
                  type="button"
                  onClick={next}
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 py-1 rounded-md",
                    "text-[11px] font-medium",
                    "text-accent hover:text-accent-hover transition-colors",
                  )}
                >
                  {stepIdx === STEPS.length - 1 ? "Done" : "Next"}
                  <ChevronRight className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
