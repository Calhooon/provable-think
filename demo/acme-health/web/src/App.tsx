import { useEffect, useRef, useState } from "react";
import * as Switch from "@radix-ui/react-switch";
import * as Tabs from "@radix-ui/react-tabs";
import {
  Activity,
  ClipboardList,
  Moon,
  ShieldCheck,
  Stethoscope,
  Sun,
  Wifi,
  WifiOff,
} from "lucide-react";
import { AutoTour, Badge, BalanceChip, CommitTicker, ConversationTabs, ExtensionAuthoredDemo, TamperFlash } from "./components";
import {
  useAppStore,
  selectActiveCommits,
  selectActiveEvents,
  selectTotalCommits,
} from "./store";
import { applyTheme, getInitialTheme, type Theme } from "./lib/theme";
import {
  connectAgent,
  disconnectAgent,
  selectConversation as selectConversationOnAgent,
} from "./lib/agent-client";
import { provisionCapabilities, verifyAllForPersona } from "./lib/verifier";
import type { Persona } from "./types/agent-events";
import { useLiveExchangeRate } from "./lib/exchange-rate";
import { cn } from "./lib/cn";
import { OperatorPane } from "./panes/OperatorPane";
import { PatientPane } from "./panes/PatientPane";
import { AuditPage } from "./panes/AuditPage";
import { AuditorPane } from "./panes/AuditorPane";
import { HeroBanner } from "./panes/HeroBanner";
import { PublicObserver } from "./panes/PublicObserver";
import { BelowFold } from "./panes/BelowFold";

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M2 14h5l2.5-6 5 12 2.5-6h9" />
    </svg>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const isDark = theme === "dark";
  function toggle(checked: boolean) {
    const next: Theme = checked ? "dark" : "light";
    setTheme(next);
    applyTheme(next);
  }
  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      <Sun
        className={cn(
          "w-4 h-4 transition-colors",
          isDark ? "text-fg-muted" : "text-fg-secondary",
        )}
        aria-hidden="true"
      />
      <Switch.Root
        checked={isDark}
        onCheckedChange={toggle}
        className={cn(
          "relative w-9 h-5 rounded-full bg-muted border border-border",
          "data-[state=checked]:bg-accent data-[state=checked]:border-accent",
          "transition-colors",
        )}
        aria-label="Toggle dark mode"
      >
        <Switch.Thumb
          className={cn(
            "block w-4 h-4 rounded-full bg-surface shadow-sm",
            "translate-x-0.5 data-[state=checked]:translate-x-[18px]",
            "transition-transform",
          )}
        />
      </Switch.Root>
      <Moon
        className={cn(
          "w-4 h-4 transition-colors",
          isDark ? "text-fg-secondary" : "text-fg-muted",
        )}
        aria-hidden="true"
      />
    </div>
  );
}

function ConnectionBadge() {
  const state = useAppStore((s) => s.connectionState);
  const config: Record<
    typeof state,
    {
      variant: "confirmed" | "propagating" | "tamper" | "default";
      label: string;
      Icon: typeof Wifi;
    }
  > = {
    open: { variant: "confirmed", label: "live", Icon: Wifi },
    connecting: { variant: "propagating", label: "connecting", Icon: Wifi },
    closed: { variant: "default", label: "offline", Icon: WifiOff },
    error: { variant: "tamper", label: "error", Icon: WifiOff },
  };
  const { variant, label, Icon } = config[state];
  return (
    <Badge variant={variant} className="font-mono">
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </Badge>
  );
}

type PaneId = "patient" | "operator" | "auditor";

function MobilePanes() {
  const [active, setActive] = useState<PaneId>("patient");
  // Mobile tab badges show the active conversation's stats so the dot reads
  // "errors in the convo I'm viewing" not "errors anywhere on this agent".
  const commits = useAppStore(selectActiveCommits);
  const events = useAppStore(selectActiveEvents);
  const commitCount = commits.length;
  const errorCount = events.filter((e) => e.kind === "commit-error").length;

  const tabs: Array<{
    id: PaneId;
    label: string;
    Icon: typeof Activity;
    badge?: string;
    badgeVariant?: "confirmed" | "tamper";
  }> = [
    { id: "patient", label: "Patient", Icon: Stethoscope },
    {
      id: "operator",
      label: "Operator",
      Icon: ClipboardList,
      badge: commitCount > 0 ? String(commitCount) : undefined,
      badgeVariant: errorCount > 0 ? "tamper" : "confirmed",
    },
    { id: "auditor", label: "Auditor", Icon: ShieldCheck },
  ];

  return (
    <Tabs.Root
      value={active}
      onValueChange={(v) => setActive(v as PaneId)}
      className="lg:hidden flex flex-col flex-1 min-h-0"
    >
      <Tabs.List
        className={cn(
          "sticky top-[57px] z-[5] flex bg-canvas/95 backdrop-blur",
          "border-b border-border px-2 sm:px-4 gap-1",
        )}
        aria-label="Switch pane"
      >
        {tabs.map((t) => (
          <Tabs.Trigger
            key={t.id}
            value={t.id}
            className={cn(
              "flex-1 px-3 py-2.5 flex items-center justify-center gap-1.5",
              "text-xs sm:text-sm font-medium text-fg-secondary",
              "border-b-2 border-transparent -mb-px",
              "data-[state=active]:text-fg data-[state=active]:border-accent",
              "transition-colors hover:text-fg",
            )}
          >
            <t.Icon className="w-4 h-4" aria-hidden="true" />
            <span>{t.label}</span>
            {t.badge && (
              <span
                className={cn(
                  "ml-0.5 inline-flex items-center justify-center",
                  "min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono",
                  t.badgeVariant === "tamper"
                    ? "bg-tamper/15 text-tamper"
                    : "bg-confirmed/15 text-confirmed",
                )}
              >
                {t.badge}
              </span>
            )}
          </Tabs.Trigger>
        ))}
      </Tabs.List>

      <div className="flex-1 min-h-0 px-2 sm:px-4 py-3">
        <Tabs.Content value="patient" className="h-full focus:outline-none">
          <PatientPane />
        </Tabs.Content>
        <Tabs.Content value="operator" className="h-full focus:outline-none">
          <OperatorPane />
        </Tabs.Content>
        <Tabs.Content value="auditor" className="h-full focus:outline-none">
          <AuditorPane />
        </Tabs.Content>
      </div>
    </Tabs.Root>
  );
}

function DesktopPanes() {
  return (
    <div
      className={cn(
        "hidden lg:grid grid-cols-3 gap-4 p-4",
        "max-w-[1600px] mx-auto w-full",
        "min-h-[calc(100vh-9rem)]",
      )}
    >
      <OperatorPane />
      <PatientPane />
      <AuditorPane />
    </div>
  );
}

export default function App() {
  // Lightweight pathname-based routing: /audit renders the auditor's
  // probe-survival page; everything else renders the demo. Avoids
  // pulling in a router for one extra route.
  const [path, setPath] = useState(
    typeof window !== "undefined" ? window.location.pathname : "/",
  );
  useEffect(() => {
    function onPop() {
      setPath(window.location.pathname);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const route = path.replace(/\/+$/, "") || "/";

  // Ensure dark mode token loads once on mount.
  useEffect(() => {
    applyTheme(getInitialTheme());
  }, []);

  // Connect on mount; clean up on unmount.
  useEffect(() => {
    connectAgent();
    return () => disconnectAgent();
  }, []);

  // Live BSV/USD rate from the ledger explorer — drives all USD displays.
  useLiveExchangeRate();

  // Provision capabilities + run verification when agent + persona known.
  // commitCount aggregated across all conversations so we re-verify when
  // any conversation gets a new commit.
  const agentId = useAppStore((s) => s.agentId);
  const persona = useAppStore((s) => s.persona);
  const commitCount = useAppStore(selectTotalCommits);
  const activeConversationId = useAppStore((s) => s.activeConversationId);

  // If the frontend's chosen active (from localStorage) differs from the
  // server's auto-selected conversation on hello, push our choice over the
  // wire so the server replays the right history. Without this the server
  // replays its idea of "active" while the UI displays a different (empty)
  // tab.
  const lastSentSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeConversationId) return;
    if (lastSentSelectionRef.current === activeConversationId) return;
    lastSentSelectionRef.current = activeConversationId;
    selectConversationOnAgent(activeConversationId);
  }, [activeConversationId]);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    void (async () => {
      await provisionCapabilities(agentId);
      if (cancelled) return;
      // Verify the active persona FIRST (so the visible UI updates
      // immediately), then walk the other two in the background. The
      // coverage HUD on the auditor pane needs ALL three personas'
      // verification results to render the live "X/N visible" matrix
      // — not just the active one.
      await verifyAllForPersona(persona);
      if (cancelled) return;
      const others: Persona[] = (
        ["compliance-officer", "patient", "external-auditor"] as Persona[]
      ).filter((p) => p !== persona);
      for (const p of others) {
        if (cancelled) return;
        await verifyAllForPersona(p);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, persona, commitCount]);

  if (route === "/audit") return <AuditPage />;

  return (
    <div className="min-h-screen flex flex-col bg-canvas">
      <header className="border-b border-border bg-surface/60 backdrop-blur sticky top-0 z-10">
        <div
          className={cn(
            "max-w-[1600px] mx-auto",
            "px-3 sm:px-4 py-3 flex items-center justify-between gap-3",
          )}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
            <BrandMark className="text-accent-dark flex-none" />
            <div className="flex flex-col leading-tight min-w-0">
              <span className="text-sm sm:text-base font-semibold tracking-tight text-fg truncate">
                Acme Health
              </span>
              <span className="hidden sm:block text-[11px] sm:text-xs text-fg-muted truncate">
                Audit-grade clinical triage. Anchored to mainnet.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-none">
            <BalanceChip />
            <ConnectionBadge />
            <Badge variant="accent" className="hidden md:inline-flex">
              <Activity className="w-3 h-3" aria-hidden="true" />
              demo
            </Badge>
            <ThemeSwitch />
          </div>
        </div>
        <div className="border-t border-border/40 bg-canvas/30">
          <div className="max-w-[1600px] mx-auto">
            <CommitTicker />
          </div>
        </div>
      </header>

      <AutoTour />
      <TamperFlash />

      <main className="flex-1 flex flex-col">
        <HeroBanner />
        <div
          className={cn(
            "border-b border-border bg-canvas/40",
            "px-3 sm:px-4 py-2",
          )}
          aria-label="Conversation tabs"
        >
          <div className="max-w-[1600px] mx-auto">
            <ConversationTabs />
          </div>
        </div>
        <MobilePanes />
        <DesktopPanes />
        <div className="px-3 sm:px-4 py-4 max-w-[1600px] mx-auto w-full">
          <ExtensionAuthoredDemo />
        </div>
        <PublicObserver />
        <BelowFold />
      </main>

      <footer className="border-t border-border">
        <div
          className={cn(
            "max-w-[1600px] mx-auto px-3 sm:px-4 py-3",
            "text-[11px] sm:text-xs text-fg-muted flex items-center justify-between flex-wrap gap-2",
          )}
        >
          <span>
            Powered by Cloudflare Workers + provable-think · Anchored to the public ledger
          </span>
          <a
            href="https://github.com/Calhooon/provable-think"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-secondary hover:text-accent-dark"
          >
            github.com/Calhooon/provable-think
          </a>
        </div>
      </footer>
    </div>
  );
}
