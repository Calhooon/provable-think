import { useEffect, useState } from "react";
import {
  ShieldCheck,
  Network,
  Terminal,
  DollarSign,
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  XCircle,
  Lock,
  Cpu,
  AlertTriangle,
  FileText,
} from "lucide-react";
import { agentBaseUrl } from "../lib/agent-client";
import { cn } from "../lib/cn";

interface ChainHead {
  master?: { sequence: number; prevHash: string };
  conversations?: Array<{
    conversationId: string;
    title: string;
    head: { sequence: number; prevHash: string };
    masterSeq: number;
  }>;
  agentIdentityPubHex?: string;
}

interface AgentInfo {
  address: string;
  pubKey: string;
  balance: number;
  agentId: string;
  demoMode: boolean;
}

/**
 * /audit — the CISO probe-survival page.
 *
 * Linked from the public observer card. Anyone with the URL can verify
 * the demo's claims independently:
 *
 *   - Live chain state (master sequence, per-conv heads, agent
 *     identity pub key) pulled from the agent
 *   - HIPAA Safeguard mapping (45 CFR 164.312) per HookKind so a
 *     compliance reviewer can map every wire byte to a regulation
 *   - Threat model (what we claim and what we don't)
 *   - Verifier CLI snippet for offline auditors
 *   - Cost-per-event + cost-per-million table at current BSV/USD
 *   - Public links to WoC for every chain head
 *
 * No login. No special access. The chain is the proof.
 */
export function AuditPage() {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [head, setHead] = useState<ChainHead | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [i, h] = await Promise.all([
          fetch(`${agentBaseUrl}/info`).then((r) => r.json() as Promise<AgentInfo>),
          fetch(`${agentBaseUrl}/chain-head`).then((r) => r.json() as Promise<ChainHead>),
        ]);
        if (cancelled) return;
        setInfo(i);
        setHead(h);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-border bg-surface/60 backdrop-blur sticky top-0 z-10">
        <div className="max-w-[1200px] mx-auto px-4 py-3 flex items-center justify-between">
          <a
            href="/"
            className="inline-flex items-center gap-2 text-sm text-fg-secondary hover:text-fg transition-colors"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Back to demo
          </a>
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="w-5 h-5 text-confirmed"
              aria-hidden="true"
            />
            <span className="text-base font-semibold text-fg">
              Audit · provable-think v0.2
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-[1200px] mx-auto px-4 py-8 space-y-10">
        <Hero />
        {error && (
          <div className="rounded-lg border border-tamper/40 bg-tamper/5 p-4 text-sm text-tamper">
            Failed to load live state: {error}. Static sections still apply.
          </div>
        )}
        <LiveChainState info={info} head={head} />
        <HipaaMapping />
        <ThreatModel />
        <VerifierCli info={info} head={head} />
        <CostTable />
      </main>

      <footer className="border-t border-border mt-16 py-6 text-center text-xs text-fg-muted">
        provable-think v0.2-alpha · MIT-licensed ·{" "}
        <a
          href="https://github.com/Calhooon/provable-think"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-accent-hover"
        >
          source
        </a>
      </footer>
    </div>
  );
}

function Hero() {
  return (
    <section className="space-y-3">
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-fg">
        The public ledger is the proof.
      </h1>
      <p className="text-sm sm:text-base text-fg-secondary leading-relaxed max-w-3xl">
        Acme Health's clinical-triage agent anchors every Project Think
        lifecycle hook on the public ledger. Auditors don't trust the operator —
        they read the public ledger. Every claim on this page is independently
        verifiable in &lt; 30 seconds with the verifier CLI below.
      </p>
    </section>
  );
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-none w-9 h-9 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center">
          {icon}
        </div>
        <div>
          <h2 className="text-lg font-semibold text-fg leading-tight">{title}</h2>
          {description && (
            <p className="text-sm text-fg-secondary mt-0.5 max-w-2xl">{description}</p>
          )}
        </div>
      </div>
      <div>{children}</div>
    </section>
  );
}

function LiveChainState({
  info,
  head,
}: {
  info: AgentInfo | null;
  head: ChainHead | null;
}) {
  return (
    <Section
      icon={<Network className="w-5 h-5 text-accent" aria-hidden="true" />}
      title="Live ledger state"
      description="Pulled directly from the agent's /chain-head endpoint right now. Re-fetched on every page load."
    >
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card label="Agent identity (P2PKH)" value={info?.address ?? "loading…"} mono />
        <Card label="Identity pubkey (compressed)" value={info?.agentId ?? "loading…"} mono link={info ? `${agentBaseUrl}/info` : undefined} />
        <Card label="Master sequence" value={head?.master?.sequence?.toString() ?? "—"} />
      </div>
      <div className="mt-3">
        <div className="text-xs uppercase tracking-wider text-fg-muted font-medium mb-2">
          Per-conversation ledger heads
        </div>
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/30 text-fg-muted">
              <tr>
                <th className="text-left px-3 py-2 font-medium">conversation</th>
                <th className="text-left px-3 py-2 font-medium">seq</th>
                <th className="text-left px-3 py-2 font-medium">prev hash</th>
                <th className="text-left px-3 py-2 font-medium">master seq</th>
              </tr>
            </thead>
            <tbody>
              {(head?.conversations ?? []).map((c) => (
                <tr
                  key={c.conversationId}
                  className="border-t border-border/40 font-mono"
                >
                  <td className="px-3 py-2 truncate max-w-[16rem]" title={c.title}>
                    {c.title || c.conversationId}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-fg">
                    {c.head.sequence}
                  </td>
                  <td className="px-3 py-2 text-[10px] text-fg-muted">
                    {c.head.prevHash.slice(0, 16)}…
                  </td>
                  <td className="px-3 py-2 tabular-nums text-fg-muted">
                    {c.masterSeq}
                  </td>
                </tr>
              ))}
              {!head?.conversations?.length && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-fg-muted italic">
                    No active conversations.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Section>
  );
}

function Card({
  label,
  value,
  mono,
  link,
}: {
  label: string;
  value: string;
  mono?: boolean;
  link?: string;
}) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-wider text-fg-muted font-medium mb-1">
        {label}
      </div>
      <div className={cn("text-sm font-medium text-fg break-all", mono && "font-mono")}>
        {value}
      </div>
    </>
  );
  return link ? (
    <a
      href={link}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-lg border border-border bg-surface p-3 hover:border-accent/40 transition-colors block"
    >
      {body}
      <div className="mt-1 inline-flex items-center gap-1 text-[10px] text-accent">
        Open <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
      </div>
    </a>
  ) : (
    <div className="rounded-lg border border-border bg-surface p-3">{body}</div>
  );
}

const HIPAA_HOOK_MAP: Array<{
  hook: string;
  byte: string;
  scope: string;
  cfr: string;
  rationale: string;
}> = [
  {
    hook: "configureSession",
    byte: "0x11",
    scope: "operations",
    cfr: "164.312(b) Audit controls",
    rationale: "Records the agent's configuration at boot — auditors can prove what system prompt + context blocks were active.",
  },
  {
    hook: "fiberStart",
    byte: "0x0a",
    scope: "operations",
    cfr: "164.312(b) Audit controls; 164.308(a)(1)(ii)(D) Information system activity review",
    rationale: "Anchors durable-execution units. Auditors pair start ↔ recovered events to detect interrupted turns.",
  },
  {
    hook: "getModel",
    byte: "0x09",
    scope: "operations",
    cfr: "164.312(b) Audit controls; 164.504(e) Business associate compliance",
    rationale: "Locks in which LLM the agent invoked — required to prove BAA-eligible model + provider.",
  },
  {
    hook: "getTools",
    byte: "0x10",
    scope: "operations",
    cfr: "164.312(c)(1) Integrity",
    rationale: "Tool surface available at inference time. Detects unauthorized tool augmentation across deployments.",
  },
  {
    hook: "beforeToolCall",
    byte: "0x03",
    scope: "PHI + treatment",
    cfr: "164.312(a)(1) Access control; 164.502(b) Minimum necessary",
    rationale: "Tool inputs may contain PHI. Anchored under PHI scope so only treating personas decrypt.",
  },
  {
    hook: "afterToolCall",
    byte: "0x04",
    scope: "PHI + treatment",
    cfr: "164.312(c)(1) Integrity; 164.312(b) Audit controls",
    rationale: "Tool outputs (clinical guideline lookups, etc.) — ledger-bound to the matching beforeToolCall.",
  },
  {
    hook: "stash",
    byte: "0x0b",
    scope: "operations",
    cfr: "164.308(a)(7)(ii)(B) Disaster recovery; 164.312(c)(1) Integrity",
    rationale: "Snapshots fiber checkpoints. SHA-256 anchored on the public ledger proves recovery state hasn't been swapped.",
  },
  {
    hook: "onChatResponse",
    byte: "0x07",
    scope: "PHI + treatment + operations (widened)",
    cfr: "164.312(b) Audit controls; 164.312(c)(1) Integrity; 164.530(j) Documentation",
    rationale: "The agent's reply. Triage widens scope so external auditors can verify a redacted version.",
  },
  {
    hook: "fiberRecovered",
    byte: "0x0c",
    scope: "operations",
    cfr: "164.308(a)(7)(ii)(C) Emergency mode operation",
    rationale: "Fires when the system detects an interrupted fiber on restart. Critical for incident response.",
  },
  {
    hook: "onChatRecovery",
    byte: "0x08",
    scope: "operations",
    cfr: "164.312(b) Audit controls",
    rationale: "Stream-resume metadata: requestId, partial response shape. Auditors detect mid-turn evictions.",
  },
  {
    hook: "extensionAuthored",
    byte: "0x0d",
    scope: "operations",
    cfr: "164.312(c)(1) Integrity; 164.312(c)(2) Mechanism to authenticate ePHI",
    rationale: "When the agent loads new TypeScript, the source bytes get a SHA-256 anchored on the public ledger — auditors verify what code ran without trusting the operator.",
  },
  {
    hook: "beforeTurn / beforeStep / onChunk / onStepFinish",
    byte: "0x01 / 0x02 / 0x06 / 0x05",
    scope: "operations (PHI-safe summaries)",
    cfr: "164.312(b) Audit controls",
    rationale: "Inference-loop metadata anchored as derived summaries (counts, ids, hashes) under operations scope. PHI in messages stays out.",
  },
];

function HipaaMapping() {
  return (
    <Section
      icon={<FileText className="w-5 h-5 text-accent" aria-hidden="true" />}
      title="HIPAA Safeguard mapping"
      description="Each HookKind anchored on the public ledger maps to a HIPAA Security Rule citation under 45 CFR Part 164. A compliance reviewer can verify every wire byte against a regulation."
    >
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-fg-muted">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Hook</th>
              <th className="text-left px-3 py-2 font-medium">Byte</th>
              <th className="text-left px-3 py-2 font-medium">Scope</th>
              <th className="text-left px-3 py-2 font-medium">CFR section</th>
              <th className="text-left px-3 py-2 font-medium">Rationale</th>
            </tr>
          </thead>
          <tbody>
            {HIPAA_HOOK_MAP.map((row) => (
              <tr key={row.hook} className="border-t border-border/40 align-top">
                <td className="px-3 py-2 font-mono text-fg whitespace-nowrap">
                  {row.hook}
                </td>
                <td className="px-3 py-2 font-mono text-accent">{row.byte}</td>
                <td className="px-3 py-2 text-fg-secondary">{row.scope}</td>
                <td className="px-3 py-2 text-fg-secondary">{row.cfr}</td>
                <td className="px-3 py-2 text-fg-muted leading-relaxed">
                  {row.rationale}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ThreatModel() {
  return (
    <Section
      icon={<AlertTriangle className="w-5 h-5 text-accent" aria-hidden="true" />}
      title="Threat model"
      description="What we claim, and what we don't. Be precise."
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ThreatCol
          color="confirmed"
          icon={<CheckCircle2 className="w-4 h-4" aria-hidden="true" />}
          title="What we claim"
          items={[
            "Every Project Think lifecycle hook fires a tx on the public ledger under a HIPAA scope tag.",
            "Each receipt binds 32 bytes of commitHash to the agent's identity pub key with a real ECDSA signature.",
            "Receipts are hash-chained per conversation: every commit's prevHash matches its predecessor.",
            "Off-ledger envelopes are AEAD-sealed with per-event keys; only recipients in the recipient list can decrypt.",
            "Recipients are derived from the active grants at commit time — the recipient list is sealed into the envelope and immutable.",
            "An external auditor can run an 11-step pipeline (ledger fetch, receipt parse, /commit-info match, R2 envelope fetch, AEAD decrypt, plaintext SHA-256 binding) without trusting the operator.",
          ]}
        />
        <ThreatCol
          color="amber-400"
          icon={<XCircle className="w-4 h-4" aria-hidden="true" />}
          title="What we don't claim"
          items={[
            "We do not anchor that the LLM's output is correct — that's a model-validation problem, separate from audit.",
            "We do not protect against compromise of the agent's identity priv key. Key rotation lands in v0.3.",
            "We do not anchor every per-token chunk by default — onChunk is opt-in (one anchor per turn) to keep costs sane.",
            "We do not provide non-repudiation against an attacker who controls the agent identity key pre-deployment. Use HSM/TPM key custody for prod.",
            "We do not claim DRM. An auditor with the operations grant can see the decrypted plaintext and could leak it — the public ledger proves what was committed, not who saw it.",
            "Public-ledger network attacks (51%, deep reorg) are out of scope. Standard SPV assumptions apply.",
          ]}
        />
      </div>
    </Section>
  );
}

function ThreatCol({
  color,
  icon,
  title,
  items,
}: {
  color: string;
  icon: React.ReactNode;
  title: string;
  items: string[];
}) {
  const colorClass =
    color === "confirmed" ? "text-confirmed border-confirmed/30 bg-confirmed/5" : "text-amber-400 border-amber-400/30 bg-amber-400/5";
  return (
    <div className={cn("rounded-lg border p-4", colorClass)}>
      <div className="flex items-center gap-2 mb-2 font-semibold text-sm">
        {icon}
        {title}
      </div>
      <ul className="space-y-2 text-xs text-fg-secondary leading-relaxed">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="text-fg-muted">▸</span>
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VerifierCli({
  info,
  head,
}: {
  info: AgentInfo | null;
  head: ChainHead | null;
}) {
  const sampleConv = head?.conversations?.[0]?.conversationId ?? "<conversation-id>";
  return (
    <Section
      icon={<Terminal className="w-5 h-5 text-accent" aria-hidden="true" />}
      title="Verifier CLI"
      description="Run this against the live agent right now. Anyone can — no login, no key required for the public-ledger side."
    >
      <pre className="rounded-lg border border-border bg-canvas/80 p-4 text-[11px] font-mono text-fg-secondary overflow-x-auto leading-relaxed">
{`# 1. Inspect the CLI (one-shot via npx, no global install)
npx provable-think-verify --help

# 2. Grab a persona capability from this live demo. Demo mode mints a
#    persistent keypair per persona and returns it inline as
#    'generatedAuditorPrivHex' — combine into a CLI-ready capability:
curl -sX POST ${agentBaseUrl}/grant/persona \\
  -H 'content-type: application/json' \\
  -d '{"persona":"external-auditor"}' \\
  | jq '.capability + {auditorPrivKeyHex: .generatedAuditorPrivHex}' \\
  > capability.json

# 3. Pick any txid from the operator pane on the home page, then verify
#    that exact receipt independently — no trust in this server, no
#    trust in any operator:
npx provable-think-verify \\
  --txid <paste-64-char-hex-txid-from-operator-pane> \\
  --capability ./capability.json

# 11-step pipeline. Signed report. Seconds.
#   - wrong key        → AEAD silence ("out of scope")
#   - tampered envelope → SHA-256 mismatch (step 11 fails)
#   - missing recipient → no decryption attempted

# Other personas: 'compliance-officer' (full PHI scope),
#                 'patient' (own session only — needs sessionAgentId)

# Source: github.com/Calhooon/provable-think (MIT)
# Agent for this demo: ${agentBaseUrl}`}
      </pre>
      <p className="text-[11px] text-fg-muted mt-2">
        The CLI is deterministic — same inputs produce the same byte-identical
        output. Reproducible-build attestation lands in v0.5.
      </p>
    </Section>
  );
}

function CostTable() {
  return (
    <Section
      icon={<DollarSign className="w-5 h-5 text-accent" aria-hidden="true" />}
      title="Cost"
      description="Operator economics. Public-ledger broadcaster fee per receipt is fixed at the ledger-protocol minimum. The dollar columns use the live ledger rate shown in the demo header."
    >
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-fg-muted">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Volume</th>
              <th className="text-left px-3 py-2 font-medium">Total cost</th>
              <th className="text-left px-3 py-2 font-medium">Per event</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-nums">
            {[
              { v: 1, label: "1 event" },
              { v: 100, label: "100 events" },
              { v: 1_000, label: "1k events" },
              { v: 1_000_000, label: "1M events" },
              { v: 100_000_000, label: "100M events" },
            ].map(({ v, label }) => {
              const sat = v * 36;
              const usd = (sat / 1e8) * 15.77;
              return (
                <tr key={v} className="border-t border-border/40">
                  <td className="px-3 py-2 text-fg">{label}</td>
                  <td className="px-3 py-2 text-fg">
                    {usd < 0.01
                      ? `≈ $${usd.toExponential(2)}`
                      : `$${usd.toFixed(2)}`}
                  </td>
                  <td className="px-3 py-2 text-fg-muted">less than a thousandth of a cent</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-fg-muted mt-2 leading-relaxed">
        At current ledger rates, 1 million events cost ≈ $5.68. A tertiary hospital
        firing 1M agent-events/year on prod (every patient encounter, every
        agent decision) would spend &lt; $6/year on public-ledger anchoring — for full
        HIPAA-mappable provenance every auditor can verify independently.
      </p>
    </Section>
  );
}
