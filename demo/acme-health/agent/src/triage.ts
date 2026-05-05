/**
 * Clinical-triage turn implementation.
 *
 * Per turn (matches BRIEF.md "patient asks, agent investigates, agent
 * decides, agent explains"):
 *
 *   1. Patient asks — `patient-message` broadcast.
 *   2. Agent INVESTIGATES — fires a real `clinical_guideline_lookup` tool
 *      call. Two real hook commits land:
 *        - `beforeToolCall` (PHI + treatment scope; External Auditor
 *          excluded — auditor-side persona filter demonstrates this)
 *        - `afterToolCall`  (same scope)
 *      The tool returns deterministic guideline text from `guidelines.ts`.
 *   3. Agent DECIDES + EXPLAINS — Workers AI streams a response with the
 *      guideline as context. `agent-token` events stream live tokens; the
 *      final reply lands as a single `agent-message`.
 *   4. `onChatResponse` commit (PHI + treatment + operations; the wider
 *      scope means External Auditor IS now a recipient — the response is
 *      Safe-Harbor-redacted via HIPAA_PRESET so even the auditor sees no
 *      PHI in plaintext, only the operations-flagged decision).
 */

import { streamText, type ModelMessage } from "ai";
import { applyHipaaRedaction, HIPAA_SCOPE_TAGS } from "provable-think";
import type { TriageAgent } from "./agent.js";
import {
  inferGuidelineKeyword,
  lookupGuideline,
  type GuidelineRecord,
} from "./guidelines.js";

export interface TriageTurnResult {
  replyText: string;
  commits: string[];
}

const NARROW_SCOPE = [HIPAA_SCOPE_TAGS.PHI, HIPAA_SCOPE_TAGS.TREATMENT];
const WIDE_SCOPE = [
  HIPAA_SCOPE_TAGS.PHI,
  HIPAA_SCOPE_TAGS.TREATMENT,
  HIPAA_SCOPE_TAGS.OPERATIONS,
];

/** Run a single patient → agent turn within a conversation. */
export async function runTriageTurn(
  agent: TriageAgent,
  text: string,
  conversationId: string,
): Promise<TriageTurnResult> {
  const ts = new Date().toISOString();

  // Re-point both the package's commit bucket AND Think's session storage
  // at this conversation BEFORE wrapping the turn in runFiber. The runFiber
  // shadow queues `fiberStart` synchronously when invoked, so the active
  // conv must already be set or the anchor lands on the prior turn's conv.
  await agent.setActiveConversation(conversationId);
  try {
    (agent as unknown as { session: { forSession(id: string): unknown } })
      .session.forSession(conversationId);
  } catch {
    /* Session may not be ready yet on a fresh DO; Think will lazy-init. */
  }

  // Wrap the turn in `runFiber` for two reasons:
  //   1. Anchors `fiberStart` (HookKind 0x0a) on chain — auditors can pair
  //      it with a later `fiberRecovered` to detect interrupted turns.
  //   2. Makes the turn durably-recoverable: `cf_agents_runs` row carries
  //      this turn so a Worker eviction mid-turn surfaces in
  //      `onFiberRecovered` after restart.
  const fiberName = `acme-triage-turn:${conversationId}:${ts}`;
  const turnFn = async (): Promise<TriageTurnResult> => {

  agent.broadcastEvent({ kind: "patient-message", conversationId, ts, text });

  // Anchor configureSession on the first chat turn per DO boot. This
  // belongs in onStart conceptually but partyserver's onStart context
  // doesn't reliably keep the ctx.waitUntil-deferred commit alive. The
  // chat-turn handler awaits the full pipeline, so anchoring here is
  // deterministic. Latched on the agent so subsequent turns skip it.
  if (!agent.configureSessionAnchored) {
    agent.configureSessionAnchored = true;
    try {
      await (
        agent as unknown as { configureSession: (s: unknown) => Promise<unknown> }
      ).configureSession(null);
    } catch (e) {
      console.warn("[triage] configureSession anchor failed:", (e as Error).message);
      agent.configureSessionAnchored = false; // allow retry on next turn
    }
  }

  // Fire the v0.2 audit anchors for `getModel` + `getTools` once per turn.
  // The triage flow doesn't go through Think's `chat()` (we drive
  // `streamText` directly), so these hooks would never fire on their own.
  // Capture the model NOW and reuse for streamText below — calling getModel
  // twice would land two `getModel` commits per turn.
  let turnModel: ReturnType<typeof agent.getModel>;
  try {
    turnModel = agent.getModel();
  } catch (e) {
    console.warn("[triage] getModel anchor failed:", (e as Error).message);
    throw e;
  }
  try {
    agent.getTools();
  } catch (e) {
    console.warn("[triage] getTools anchor failed:", (e as Error).message);
  }

  // ── 1. Investigate: real tool call (clinical_guideline_lookup) ────
  const keyword = inferGuidelineKeyword(text);
  const redactedInput = applyHipaaRedaction(text).redacted;

  agent.pendingCommitMeta.set(conversationId, {
    scopeTags: NARROW_SCOPE,
    r2PathPrefix: "acme-health",
  });
  await agent.commitSync(
    "beforeToolCall",
    {
      tool: "clinical_guideline_lookup",
      input: { query: keyword.key, queryLabel: keyword.label, patientInputRedacted: redactedInput },
    },
    { scopeTags: NARROW_SCOPE },
  );
  agent.pendingCommitMeta.delete(conversationId);

  // Tool runs — deterministic local lookup; no network.
  const guideline: GuidelineRecord = lookupGuideline(keyword);
  agent.broadcastEvent({
    kind: "info",
    conversationId,
    ts: new Date().toISOString(),
    text: `Looked up: ${guideline.guidelineName}`,
  });

  // afterToolCall
  agent.pendingCommitMeta.set(conversationId, {
    scopeTags: NARROW_SCOPE,
    r2PathPrefix: "acme-health",
  });
  await agent.commitSync(
    "afterToolCall",
    {
      tool: "clinical_guideline_lookup",
      output: {
        guidelineName: guideline.guidelineName,
        summary: guideline.summary,
        redFlags: guideline.redFlags,
        source: guideline.source,
      },
    },
    { scopeTags: NARROW_SCOPE },
  );
  agent.pendingCommitMeta.delete(conversationId);

  // Snapshot mid-turn state into the active fiber. `stash` is only
  // valid inside a `runFiber` callback — turnFn is wrapped, so we are.
  // The package's stash shadow anchors `{ snapshotByteCount,
  // snapshotSha256 }` (HookKind 0x0b) under operations scope so an
  // auditor can replay the post-tool snapshot and verify integrity
  // against the chain hash without seeing the patient text itself.
  try {
    (agent as unknown as { stash: (data: unknown) => void }).stash({
      at: "post-tool-call",
      conversationId,
      ts: new Date().toISOString(),
      guideline: {
        name: guideline.guidelineName,
        source: guideline.source,
      },
    });
  } catch (e) {
    console.warn("[triage] stash anchor failed:", (e as Error).message);
  }

  // ── 2. Decide + explain: Workers AI with the guideline in context ──
  // The system prompt gets a one-shot RAG-style augmentation: the LLM
  // sees the canonical guideline and synthesizes a tailored reply.
  const augmentedSystem =
    agent.getSystemPrompt() +
    "\n\nRelevant clinical guideline (use this as authoritative context):\n" +
    `- Source: ${guideline.guidelineName} (${guideline.source})\n` +
    `- Summary: ${guideline.summary}\n` +
    `- Red flags requiring ED: ${guideline.redFlags.map((r) => `(${r})`).join("; ")}`;

  const messages: ModelMessage[] = [{ role: "user", content: text }];

  let replyText = "";
  try {
    const result = streamText({
      model: turnModel,
      system: augmentedSystem,
      messages,
      temperature: 0.3,
    });

    for await (const delta of result.textStream) {
      replyText += delta;
      agent.broadcastEvent({
        kind: "agent-token",
        conversationId,
        ts: new Date().toISOString(),
        delta,
      });
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("[triage] streamText failed:", msg, e);
    agent.broadcastEvent({
      kind: "commit-error",
      conversationId,
      ts: new Date().toISOString(),
      hookKind: "onChatResponse",
      error: `Workers AI failed: ${msg}`,
    });
    // Fallback so the rest of the pipeline still exercises mainnet anchoring.
    replyText =
      "[Workers AI unavailable in this dev session — falling back to a stub " +
      "so the chain anchoring + persona-scope decryption flow still exercises " +
      "end-to-end. Guideline retrieved: " +
      guideline.guidelineName +
      ".]";
  }

  agent.broadcastEvent({
    kind: "agent-message",
    conversationId,
    ts: new Date().toISOString(),
    text: replyText,
  });

  // ── 3. onChatResponse commit (wide scope; External Auditor is in) ──
  const modelMeta = {
    provider: "workers-ai",
    model: "@cf/moonshotai/kimi-k2.6",
    temperature: 0.3,
  };

  agent.pendingCommitMeta.set(conversationId, {
    scopeTags: WIDE_SCOPE,
    r2PathPrefix: "acme-health",
  });
  const outcome = await agent.commitSync(
    "onChatResponse",
    {
      reply: replyText,
      modelMeta,
      patientInputRedacted: redactedInput,
      guideline: {
        name: guideline.guidelineName,
        source: guideline.source,
      },
    },
    { scopeTags: WIDE_SCOPE },
  );
  agent.pendingCommitMeta.delete(conversationId);

  const commits: string[] = [];
  if (outcome.ok && outcome.txid) commits.push(outcome.txid);
  return { replyText, commits };
  };
  return agent.runFiber(fiberName, turnFn);
}

/**
 * Pre-baked triage turns for the seed-scenario warm-up. Three turns
 * mirror the test-worker's hipaa-triage scenario tone but stay short
 * so the demo page loads with visible txids quickly.
 */
const SCENARIO_TURNS: ReadonlyArray<string> = Object.freeze([
  "I'm 67, T2DM x12yr, hypertensive. I've had intermittent chest pressure for 3 days when climbing stairs. Should I be worried?",
  "BP at home this morning was 165/110. Resting heart rate 92. The pressure came back about an hour ago — still mild.",
  "I'd rather not go to the ED unless I really have to. What does my disposition look like over the next 48 hours?",
]);

/** Run one step of the seeded sample triage in a given conversation. */
export async function runScenarioStep(
  agent: TriageAgent,
  stepIndex: number,
  conversationId: string,
): Promise<TriageTurnResult> {
  if (stepIndex < 0 || stepIndex >= SCENARIO_TURNS.length) {
    throw new Error(
      `runScenarioStep: stepIndex ${stepIndex} out of range (0..${SCENARIO_TURNS.length - 1})`,
    );
  }
  return runTriageTurn(agent, SCENARIO_TURNS[stepIndex]!, conversationId);
}

export const SCENARIO_STEP_COUNT = SCENARIO_TURNS.length;
