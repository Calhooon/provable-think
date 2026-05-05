/**
 * WebSocket lifecycle handlers — installed on `TriageAgent` via the
 * partyserver `onConnect` / `onMessage` / `onClose` hooks.
 *
 * Multi-conversation contract: each connection holds a per-connection
 * `activeConversationId` in its hibernation-safe `state`. On connect we
 * auto-select the most recently active conversation (creating one if
 * none exist) and replay it. The client can switch via `select-conversation`,
 * spawn new ones via `new-conversation`, and only sees events tagged with
 * its currently-active conversation.
 */

import type { Connection, WSMessage } from "agents";
import type { TriageAgent } from "./agent.js";
import type { ClientMessage, ConversationSummary } from "./types.js";
import { runTriageTurn } from "./triage.js";

const FALLBACK_TITLE = "New conversation";
const TITLE_MAX_LEN = 60;

function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return FALLBACK_TITLE;
  if (cleaned.length <= TITLE_MAX_LEN) return cleaned;
  return `${cleaned.slice(0, TITLE_MAX_LEN - 1)}…`;
}

function shortConvId(): string {
  return `conv_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Send the `hello` envelope on connect. Auto-selects the most recently
 * active conversation for the connection (creating a fresh one if none
 * exist), then replays its history. Frontend can override the choice
 * via `select-conversation`.
 */
export async function handleConnect(
  agent: TriageAgent,
  connection: Connection,
): Promise<void> {
  agent.connectedClients.add(connection as unknown as WebSocket);
  const agentIdentityPubHex = await agent.getIdentityPublicKey();
  const agentId = agentIdentityPubHex.slice(0, 16);

  // Pick the connection's initial conversation:
  //   1. Whatever the connection had pre-hibernation (state.activeConversationId)
  //   2. Else the most recently active conversation on the agent
  //   3. Else null (frontend can prompt the user to start one)
  // We DO NOT auto-create a conversation here — leave that to an explicit
  // `new-conversation` so empty agents stay clean.
  const summaries = await agent.listConversationSummaries();
  let active = agent.getConnectionConversation(connection);
  if (active && !summaries.some((s) => s.id === active)) {
    // Stale (conv was archived/deleted) — drop it.
    active = null;
  }
  if (!active && summaries.length > 0) {
    active = summaries[0]!.id;
    agent.setConnectionConversation(connection, active);
  }

  agent.sendToConnection(connection, {
    kind: "hello",
    agentIdentityPubHex,
    agentId,
    conversations: summaries,
    activeConversationId: active,
  });

  if (active) {
    await agent.replayRecentCommits(connection, active, 50);
  }
}

/**
 * Parse incoming JSON. Supported `kind`s:
 *   - patient-message: run a triage turn in the connection's (or specified) conversation
 *   - list-conversations: respond with current summaries
 *   - select-conversation: switch this connection's active + replay
 *   - new-conversation: create + activate + (optionally) replay (will be empty)
 *
 * Everything else is ignored — admin operations go through HTTP routes.
 */
export async function handleMessage(
  agent: TriageAgent,
  connection: Connection,
  message: WSMessage,
): Promise<void> {
  if (typeof message !== "string") return;
  let parsed: ClientMessage | null = null;
  try {
    const raw = JSON.parse(message);
    if (!raw || typeof raw !== "object" || typeof raw.kind !== "string") return;
    parsed = raw as ClientMessage;
  } catch {
    return;
  }

  switch (parsed.kind) {
    case "patient-message":
      await onPatientMessage(agent, connection, parsed);
      return;
    case "list-conversations":
      await onListConversations(agent, connection);
      return;
    case "select-conversation":
      await onSelectConversation(agent, connection, parsed.conversationId);
      return;
    case "new-conversation":
      await onNewConversation(agent, connection, parsed.title, parsed.activate);
      return;
    default:
      return;
  }
}

async function onPatientMessage(
  agent: TriageAgent,
  connection: Connection,
  msg: { conversationId?: string; text: unknown },
): Promise<void> {
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  if (!text) return;

  // Resolve target conversation:
  //   1. Explicit msg.conversationId (frontend race-safe)
  //   2. Connection's active
  //   3. Auto-create one with the message as title (first-message UX)
  let convId = msg.conversationId ?? agent.getConnectionConversation(connection);
  if (!convId) {
    const created = await agent.createConversation({
      id: shortConvId(),
      title: deriveTitle(text),
      setActive: false, // we'll set active per-connection below
    });
    convId = created.id;
    agent.setConnectionConversation(connection, convId);
    const summaries = await agent.listConversationSummaries();
    const summary =
      summaries.find((s) => s.id === convId) ??
      ({
        id: created.id,
        title: created.title,
        commitCount: 0,
        latestSequence: 0,
        latestTxStatus: null,
        createdAt: created.createdAt,
        lastActiveAt: created.lastActiveAt,
        status: created.status,
      } as ConversationSummary);
    agent.broadcastEvent({
      kind: "conversation-created",
      conversation: summary,
      activated: true,
    });
  }

  // If the conversation is still titled "New conversation" because it was
  // pre-created without a message, retitle it now that we have one.
  try {
    const conv = await agent.listConversations({ status: "all" });
    const found = conv.find((c) => c.id === convId);
    if (found && (found.title === FALLBACK_TITLE || found.title === "Default")) {
      await agent.renameConversation({ id: convId, title: deriveTitle(text) });
      // Push an updated list so tabs refresh.
      const summaries = await agent.listConversationSummaries();
      agent.broadcastEvent({
        kind: "conversation-list",
        conversations: summaries,
      });
    }
  } catch {
    /* non-fatal — title is cosmetic */
  }

  await runTriageTurn(agent, text, convId);
}

async function onListConversations(
  agent: TriageAgent,
  connection: Connection,
): Promise<void> {
  const conversations = await agent.listConversationSummaries();
  agent.sendToConnection(connection, {
    kind: "conversation-list",
    conversations,
  });
}

async function onSelectConversation(
  agent: TriageAgent,
  connection: Connection,
  conversationId: string,
): Promise<void> {
  if (typeof conversationId !== "string" || !conversationId) return;
  const conv = await agent.listConversations({ status: "all" });
  if (!conv.some((c) => c.id === conversationId)) {
    // Unknown conversation — silently ignore (frontend may be stale).
    return;
  }
  agent.setConnectionConversation(connection, conversationId);
  agent.sendToConnection(connection, {
    kind: "conversation-selected",
    conversationId,
  });
  await agent.replayRecentCommits(connection, conversationId, 50);
}

async function onNewConversation(
  agent: TriageAgent,
  connection: Connection,
  title: string | undefined,
  activate: boolean | undefined,
): Promise<void> {
  const created = await agent.createConversation({
    id: shortConvId(),
    title: title?.trim() || FALLBACK_TITLE,
    setActive: false,
  });
  const shouldActivate = activate !== false;
  if (shouldActivate) {
    agent.setConnectionConversation(connection, created.id);
  }
  // Build a summary (no commits yet, so we can construct directly).
  const summary: ConversationSummary = {
    id: created.id,
    title: created.title,
    commitCount: 0,
    latestSequence: 0,
    latestTxStatus: null,
    createdAt: created.createdAt,
    lastActiveAt: created.lastActiveAt,
    status: created.status,
  };
  agent.broadcastEvent({
    kind: "conversation-created",
    conversation: summary,
    activated: shouldActivate,
  });
  if (shouldActivate) {
    agent.sendToConnection(connection, {
      kind: "conversation-selected",
      conversationId: created.id,
    });
  }
}

export function handleClose(
  agent: TriageAgent,
  connection: Connection,
): void {
  agent.connectedClients.delete(connection as unknown as WebSocket);
}
