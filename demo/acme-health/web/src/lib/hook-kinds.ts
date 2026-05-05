/**
 * Visual classification of Project Think hook kinds for the operator
 * console. Every hook fires a real on-chain commit — they all matter
 * for the audit trail — but for the *demo*'s storytelling we want the
 * narrative-rich hooks (a tool call, an agent reply, a self-authored
 * extension) to read louder than the audit plumbing (model/session
 * setup, fiber bookkeeping). Same data, better hierarchy.
 *
 * `dramatic` hooks render at full visual weight in the operator pane.
 * `lifecycle` hooks render dimmer + slightly smaller so they fade into
 * the background of the history list while still being visible/clickable.
 */

const DRAMATIC_HOOKS = new Set<string>([
  "beforeTurn",
  "beforeToolCall",
  "afterToolCall",
  "onChatResponse",
  "extensionAuthored",
]);

export function isDramaticHook(hookKind: string): boolean {
  return DRAMATIC_HOOKS.has(hookKind);
}
