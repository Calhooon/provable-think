import { useMemo } from "react";
import { Plus, MessageSquare } from "lucide-react";
import { useAppStore } from "../store";
import { newConversation, selectConversation } from "../lib/agent-client";
import { cn } from "../lib/cn";
import type { ConversationSummary } from "../types/agent-events";

/**
 * Horizontal tab bar above the three panes. One tab per active conversation,
 * trailing "+ New" button. Clicking a tab routes both the local UI (zustand
 * activeConversationId) and the WebSocket connection (server-side
 * `select-conversation`) so future broadcasts only carry that conv's events.
 */
export function ConversationTabs() {
  const conversationIds = useAppStore((s) => s.conversationIds);
  const conversations = useAppStore((s) => s.conversations);
  const activeId = useAppStore((s) => s.activeConversationId);
  const selectLocal = useAppStore((s) => s.selectConversation);

  const summaries = useMemo(
    () =>
      conversationIds
        .map((id) => conversations[id]?.summary)
        .filter((s): s is ConversationSummary => Boolean(s))
        // Hide internal/technical convs from the visitor view. Quality-gate
        // and Wave-* convs are gate artifacts (test scenarios that produce
        // 24+ commits with synthetic phases); they're useful to engineers
        // probing the WS but a CISO should never see them in the tab bar.
        // The "default" conv is the boot-time artifact for configureSession
        // anchoring + extension-load lands — never user content.
        .filter((s) => {
          const t = s.title?.toLowerCase() ?? "";
          if (s.id === "default") return false;
          if (t.startsWith("wave ") || t.startsWith("wave5")) return false;
          if (t === "quality-gate") return false;
          if (t.includes("16-hook gate")) return false;
          return true;
        }),
    [conversationIds, conversations],
  );

  function handleSelect(id: string) {
    if (id === activeId) return;
    selectLocal(id);
    selectConversation(id);
  }

  function handleNew() {
    newConversation({ activate: true });
  }

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto pb-1 -mx-1 px-1">
      {summaries.length === 0 ? (
        <span className="text-xs text-fg-muted px-2 py-1.5 italic">
          No conversations yet — start one with the patient pane.
        </span>
      ) : (
        summaries.map((s) => (
          <ConversationTab
            key={s.id}
            summary={s}
            active={s.id === activeId}
            onClick={() => handleSelect(s.id)}
          />
        ))
      )}
      <button
        type="button"
        onClick={handleNew}
        className={cn(
          "shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md",
          "border border-dashed border-border text-xs font-medium text-fg-muted",
          "hover:border-accent hover:text-accent transition-colors",
          "focus:outline-none focus:ring-1 focus:ring-accent/40",
        )}
        title="Start a new conversation (cleans the panes for a fresh chain)"
      >
        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
        New
      </button>
    </div>
  );
}

function ConversationTab({
  summary,
  active,
  onClick,
}: {
  summary: ConversationSummary;
  active: boolean;
  onClick: () => void;
}) {
  // Status dot mirrors TxidPill semantics so users get one consistent legend.
  const status = summary.latestTxStatus;
  let dotClass = "bg-fg-muted";
  let dotTitle = "no anchors yet";
  if (status === "MINED") {
    dotClass = "bg-confirmed";
    dotTitle = "all anchors confirmed";
  } else if (
    status === "SEEN_ON_NETWORK" ||
    status === "ANNOUNCED_TO_NETWORK" ||
    status === "QUEUED" ||
    status === "RECEIVED"
  ) {
    dotClass = "bg-propagating";
    dotTitle = "propagating";
  } else if (
    status === "SEEN_IN_ORPHAN_MEMPOOL" ||
    status === "REJECTED" ||
    status === "DOUBLE_SPEND_ATTEMPTED" ||
    status === "INVALID" ||
    status === "MALFORMED"
  ) {
    dotClass = "bg-tamper";
    dotTitle = `broadcast failed: ${status}`;
  } else if (status) {
    dotClass = "bg-propagating";
    dotTitle = status;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "shrink-0 inline-flex items-center gap-2 px-3 py-1.5 rounded-md",
        "text-xs font-medium transition-colors max-w-[14rem]",
        "focus:outline-none focus:ring-1 focus:ring-accent/40",
        active
          ? "bg-accent/15 border border-accent/40 text-fg"
          : "border border-border text-fg-secondary hover:border-border-strong hover:text-fg",
      )}
      title={`${summary.title} · ${summary.commitCount} anchored`}
    >
      <MessageSquare
        className={cn("w-3.5 h-3.5 flex-none", active ? "text-accent" : "text-fg-muted")}
        aria-hidden="true"
      />
      <span className="truncate">{summary.title}</span>
      <span
        className={cn("w-1.5 h-1.5 rounded-full flex-none", dotClass)}
        aria-label={dotTitle}
        title={dotTitle}
      />
      {summary.commitCount > 0 && (
        <span className="text-[10px] text-fg-muted tabular-nums">
          {summary.commitCount}
        </span>
      )}
    </button>
  );
}
