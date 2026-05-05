import { ArrowRight, BookOpen, Github, Package, ShieldCheck } from "lucide-react";
import { cn } from "../lib/cn";

/**
 * Below-the-fold marketing surface — 30-second architecture diagram +
 * "read the docs" + "get the SDK" CTAs. Sits below the public observer
 * so a viewer who scrolls all the way down lands on next-action affordances.
 */
export function BelowFold() {
  return (
    <section
      className={cn(
        "border-t border-border",
        "px-3 sm:px-4 py-8 sm:py-12",
      )}
      aria-label="How it works and what to do next"
    >
      <div className="max-w-[1600px] mx-auto grid grid-cols-1 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-8 lg:gap-12 items-start">
        <ArchitectureDiagram />
        <CtaPanel />
      </div>
    </section>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-base font-semibold text-fg leading-tight">
          How a single hook becomes an audit-grade anchor — in 30 seconds
        </h3>
        <p className="text-xs sm:text-sm text-fg-secondary mt-1.5 leading-relaxed">
          One agent class. One config spread. Every Project Think
          lifecycle hook above becomes a hash-chained, signed, encrypted
          commitment on the public ledger — sub-cent per event, verifiable by
          anyone who holds a viewing key.
        </p>
      </div>

      <div
        className={cn(
          "rounded-xl border border-border bg-canvas/40 px-4 sm:px-6 py-5",
          "font-mono text-[11px] sm:text-xs leading-relaxed text-fg-secondary",
        )}
      >
        <Diagram />
      </div>
    </div>
  );
}

function Diagram() {
  return (
    <div className="space-y-3">
      <DiagramRow
        from="Patient"
        to="Agent (Workers AI)"
        kind="WebSocket"
        body="Free-form clinical question."
      />
      <DiagramRow
        from="Agent"
        to="HIPAA_PRESET"
        kind="pre-seal redaction"
        body="Safe-Harbor inferred-PHI redaction (45 CFR 164.514(b)(2), 18 categories)."
      />
      <DiagramRow
        from="Agent"
        to="ProtoWallet"
        kind="BRC-78 envelope seal"
        body="AES-256-GCM, multi-recipient (self + auditors via BRC-42 ECDH)."
      />
      <DiagramRow
        from="Agent"
        to="Multi-ARC race"
        kind="receipt broadcast"
        body="GorillaPool + TaaL with X-WaitFor: SEEN_ON_NETWORK. ~36 sats."
      />
      <DiagramRow
        from="Auditor"
        to="provable-think-verify"
        kind="11-step pipeline"
        body="ledger fetch → /commit-info match → R2 fetch → AEAD decrypt → SHA-256 binds."
      />
    </div>
  );
}

function DiagramRow({
  from,
  to,
  kind,
  body,
}: {
  from: string;
  to: string;
  kind: string;
  body: string;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-[200px_minmax(0,1fr)] gap-2 md:gap-4 items-start">
      <div className="flex items-center gap-1.5 text-fg whitespace-nowrap">
        <span className="text-fg-secondary">{from}</span>
        <ArrowRight className="w-3 h-3 text-fg-muted flex-none" aria-hidden="true" />
        <span className="text-accent-dark">{to}</span>
      </div>
      <div className="text-fg-secondary">
        <span className="text-accent-dark font-medium">{kind}</span>
        <span className="text-fg-muted"> · </span>
        {body}
      </div>
    </div>
  );
}

function CtaPanel() {
  return (
    <div className="flex flex-col gap-3">
      <CtaCard
        href="https://github.com/Calhooon/provable-think/blob/main/docs/TECHNICAL.md"
        Icon={BookOpen}
        title="Read the technical spec"
        body="Full wire format, BRC alignment, threat model, 11-step verifier pipeline."
      />
      <CtaCard
        href="https://github.com/Calhooon/provable-think"
        Icon={Github}
        title="Browse the repo"
        body="MIT-licensed. v0.1.0-alpha.0 ships the package + verifier CLI + this demo."
      />
      <CtaCard
        href="https://github.com/Calhooon/provable-think/blob/main/docs/HIPAA-AUDIT-PLAYBOOK.md"
        Icon={ShieldCheck}
        title="HIPAA audit playbook"
        body="45 CFR 164.312(b) mapping, BAA addendum template, six-year retention plan."
      />
      <CtaCard
        href="https://www.npmjs.com/package/provable-think"
        Icon={Package}
        title="Get the SDK"
        body={"npm install provable-think · withProvenance(Think<Env>, config)"}
      />
    </div>
  );
}

function CtaCard({
  href,
  Icon,
  title,
  body,
}: {
  href: string;
  Icon: typeof BookOpen;
  title: string;
  body: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group rounded-lg border border-border bg-surface px-3 py-3",
        "hover:border-accent/40 hover:bg-canvas/40 transition-colors",
        "flex items-start gap-3",
      )}
    >
      <span
        className={cn(
          "flex-none w-8 h-8 rounded-md bg-accent/10 text-accent-dark",
          "flex items-center justify-center group-hover:bg-accent/15",
        )}
        aria-hidden="true"
      >
        <Icon className="w-4 h-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-semibold text-fg leading-tight">
          {title}
        </span>
        <span className="block text-xs text-fg-secondary leading-snug mt-0.5">
          {body}
        </span>
      </span>
      <ArrowRight
        className={cn(
          "flex-none w-4 h-4 text-fg-muted self-center",
          "group-hover:text-accent-dark transition-colors",
        )}
        aria-hidden="true"
      />
    </a>
  );
}
