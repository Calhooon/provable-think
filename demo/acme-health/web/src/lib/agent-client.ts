/**
 * Agent network client — REST + WebSocket producer for the Zustand store.
 *
 * The dev agent runs at http://localhost:8787; in prod the URL is read
 * from `VITE_AGENT_URL` (set in `.env.production`). WebSocket is the
 * companion at the same origin under `/ws`.
 *
 * Phase C scope: connect → emit events into the store → expose
 * `sendPatientMessage(text)` for the patient pane to call. Persona
 * grants + tamper buttons land in Phase D/E.
 */

import { useAppStore, type CommitDescriptor } from "../store.js";
import type {
  AgentEventEnvelope,
  ClientMessage,
  ConversationSummary,
  Persona,
  ViewingCapability,
} from "../types/agent-events.js";

const AGENT_URL =
  (import.meta.env.VITE_AGENT_URL as string | undefined) ??
  "http://localhost:8787";

export const agentBaseUrl = AGENT_URL;
export const agentWsUrl = AGENT_URL.replace(/^http/, "ws") + "/ws";
export const agentExplorerBase = "https://whatsonchain.com/tx/";

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;

export function connectAgent(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  useAppStore.getState().setConnectionState("connecting");

  ws = new WebSocket(agentWsUrl);

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    useAppStore.getState().setConnectionState("open");
  });

  ws.addEventListener("message", (event) => {
    try {
      const envelope = JSON.parse(event.data as string) as AgentEventEnvelope;
      useAppStore.getState().pushEvent(envelope);
    } catch (err) {
      console.warn("agent-client: bad WS frame", err, event.data);
    }
  });

  ws.addEventListener("close", () => {
    useAppStore.getState().setConnectionState("closed");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    useAppStore.getState().setConnectionState("error");
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  // Backoff: 0.5s → 1s → 2s → 4s, capped at 8s.
  const delay = Math.min(8000, 500 * 2 ** Math.min(reconnectAttempts, 4));
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectAgent();
  }, delay);
}

export function disconnectAgent(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

function sendClient(msg: ClientMessage): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn("agent-client: not connected; dropping", msg.kind);
    return;
  }
  ws.send(JSON.stringify(msg));
}

/**
 * Send a patient message. If `conversationId` is omitted the agent routes
 * to the connection's currently-active conversation (auto-creating one if
 * none exists).
 */
export function sendPatientMessage(
  text: string,
  conversationId?: string,
): void {
  sendClient({ kind: "patient-message", text, conversationId });
}

/** Ask the agent to re-send the conversation list. */
export function listConversations(): void {
  sendClient({ kind: "list-conversations" });
}

/** Switch this connection's active conversation. */
export function selectConversation(conversationId: string): void {
  sendClient({ kind: "select-conversation", conversationId });
}

/**
 * Create a new conversation. `activate: true` (default) makes this
 * connection's active so subsequent commits land in it.
 */
export function newConversation(opts?: {
  title?: string;
  activate?: boolean;
}): void {
  sendClient({
    kind: "new-conversation",
    title: opts?.title,
    activate: opts?.activate,
  });
}

// ====================================================================
// REST helpers
// ====================================================================

async function jsonFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`agent ${path} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export async function getInfo(): Promise<{
  address: string;
  pubKey: string;
  agentIdentityPubHex: string;
  agentId: string;
  balance: number | { confirmed?: number; unconfirmed?: number; utxos?: number };
  demoMode: boolean;
}> {
  return jsonFetch("/info");
}

export async function syncMainnet(): Promise<{ discovered: number; totalAvailable?: number }> {
  return jsonFetch("/sync-mainnet", { method: "POST" });
}

export async function grantPersona(
  persona: Persona,
  opts: { sessionAgentId?: string; label?: string; validUntil?: string } = {},
): Promise<{
  persona: Persona;
  scope: ViewingCapability["scope"];
  capability: ViewingCapability;
  /** Demo-mode helper: priv key the agent generated for this persona. */
  generatedAuditorPrivHex?: string;
}> {
  return jsonFetch("/grant/persona", {
    method: "POST",
    body: JSON.stringify({ persona, generateAuditorKey: true, ...opts }),
  });
}

export async function tamperEnvelope(
  conversationId: string,
  sequence: number,
): Promise<{
  ok: boolean;
  envelopeKey: string;
  conversationId: string;
  sequence: number;
}> {
  return jsonFetch("/admin/tamper", {
    method: "POST",
    body: JSON.stringify({ conversationId, sequence }),
  });
}

export async function listConversationSummaries(): Promise<
  ConversationSummary[]
> {
  return jsonFetch("/conversations");
}

export async function createConversationHttp(
  title?: string,
): Promise<{ id: string; title: string }> {
  return jsonFetch("/conversations", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export async function archiveConversationHttp(
  id: string,
): Promise<{ ok: boolean }> {
  return jsonFetch(`/conversations/${encodeURIComponent(id)}/archive`, {
    method: "POST",
  });
}

export async function resetUtxos(): Promise<{
  purged: number;
  fundingAddress: string;
}> {
  return jsonFetch("/admin/reset-utxos", { method: "POST" });
}

export async function unsealAsAuditor(args: {
  envelopeKey: string;
  auditorPrivKeyHex: string;
  recipientId: string;
}): Promise<{
  ok: boolean;
  integrityOk?: boolean;
  plaintext?: string;
  error?: string;
  header?: { sequence: number; hookKind: string; scopeTags: string[]; ts: string };
}> {
  return jsonFetch("/unseal-as-auditor", {
    method: "POST",
    body: JSON.stringify(args),
  });
}

export async function seedScenario(): Promise<{
  conversationId: string;
  steps: Array<{
    stepIndex: number;
    ok: boolean;
    txid?: string;
    replyText: string;
  }>;
}> {
  return jsonFetch("/scenario/seed", { method: "POST" });
}

// Re-export for downstream pane code so the frontend has one import
// surface for "agent client" + "commit descriptor".
export type { CommitDescriptor };
