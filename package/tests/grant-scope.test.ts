/**
 * Exhaustive coverage for `grantScopeMatches` — the pure filter function in
 * `package/src/broadcast-pipeline.ts` that decides whether a viewing-key
 * grant applies to a given event at envelope-seal time. Every grant whose
 * scope intersects an event's metadata is added as a recipient on that
 * envelope; everything else is excluded.
 *
 * The Phase 2.5 mainnet gate proved the POSITIVE-match path on chain
 * (Compliance Officer's `tags=["PHI"]` matches every gate event;
 * External Auditor's `tags=["operations","de-identified"]` matches only
 * sequence 13). The NEGATIVE-match paths — agentIds bind, hookKinds
 * narrow, time bounds reject — are enforced by single-line filters in
 * `grantScopeMatches`. We cover them deterministically here.
 *
 * Why unit tests for these specific cases (vs. another mainnet broadcast):
 * the function is pure (no I/O, no chain state); each filter is one line;
 * the on-chain commitment doesn't change behavior based on these filters
 * (they only affect who's added to the recipient list at sealing time, and
 * the sealing code calls grantScopeMatches once per active grant). Real
 * money was already spent on the matches that prove the broader pipeline.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { grantScopeMatches } from "../src/broadcast-pipeline.js";
import type { GrantRecord } from "../src/state.js";
import type { HookKind } from "../src/types.js";

function grant(scope: GrantRecord["scope"]): GrantRecord {
  return {
    id: "g-test",
    recipientPubHex: "02".padEnd(66, "a"),
    scope,
    grantedAt: 0,
  };
}

const baseEvent = {
  hookKind: "onChatResponse" as HookKind,
  ts: "2026-04-28T20:00:00.000Z",
  tags: ["PHI", "treatment"],
  agentId: "02b22aed1ca8fdf4",
};

// ====================================================================
// tags filter — overlap is the test
// ====================================================================

describe("grantScopeMatches — tags filter", () => {
  it("matches when grant tags overlap event tags (PHI in both)", () => {
    assert.equal(grantScopeMatches(grant({ tags: ["PHI"] }), baseEvent), true);
  });

  it("matches on partial overlap (treatment only)", () => {
    assert.equal(
      grantScopeMatches(grant({ tags: ["treatment", "operations"] }), baseEvent),
      true,
    );
  });

  it("REJECTS when grant tags do NOT overlap event tags", () => {
    // External Auditor scope (operations + de-identified) against a
    // PHI+treatment event — the Phase 2.5 gate's seq 11 / 12 negative case.
    assert.equal(
      grantScopeMatches(
        grant({ tags: ["operations", "de-identified"] }),
        baseEvent,
      ),
      false,
    );
  });

  it("MATCHES the same scope when an `operations` tag is added to event", () => {
    // The Phase 2.5 gate's seq 13 positive case for the External Auditor.
    const eventOps = { ...baseEvent, tags: ["PHI", "treatment", "operations"] };
    assert.equal(
      grantScopeMatches(
        grant({ tags: ["operations", "de-identified"] }),
        eventOps,
      ),
      true,
    );
  });

  it("treats empty / missing tags filter as no-tag-restriction", () => {
    assert.equal(grantScopeMatches(grant({}), baseEvent), true);
    assert.equal(grantScopeMatches(grant({ tags: [] }), baseEvent), true);
  });
});

// ====================================================================
// agentIds filter — Patient persona's session-binding semantic
// ====================================================================

describe("grantScopeMatches — agentIds filter (Patient persona)", () => {
  it("MATCHES when event.agentId is in the grant's agentIds list", () => {
    // Patient grant scoped to their own session.
    const patientGrant = grant({
      tags: ["PHI"],
      agentIds: ["02b22aed1ca8fdf4"],
    });
    assert.equal(grantScopeMatches(patientGrant, baseEvent), true);
  });

  it("REJECTS when event.agentId is NOT in the grant's agentIds list", () => {
    // Patient A's grant tries to apply to Patient B's session — must not.
    const patientAGrant = grant({
      tags: ["PHI"],
      agentIds: ["aaaa1111bbbb2222"], // Patient A's session
    });
    const patientBEvent = { ...baseEvent, agentId: "cccc3333dddd4444" };
    assert.equal(grantScopeMatches(patientAGrant, patientBEvent), false);
  });

  it("REJECTS even when tags match if agentIds disagree", () => {
    // The compound filter: tags AND agentIds. Tags pass (PHI in both),
    // agentIds fail. Result must be reject.
    const patientGrant = grant({
      tags: ["PHI"],
      agentIds: ["aaaa1111bbbb2222"],
    });
    const otherSessionEvent = { ...baseEvent, agentId: "ffff9999eeee0000" };
    assert.equal(grantScopeMatches(patientGrant, otherSessionEvent), false);
  });

  it("MATCHES across multiple sessions if all are listed", () => {
    // A "household" grant for a parent who manages multiple patients.
    const householdGrant = grant({
      tags: ["PHI"],
      agentIds: ["aaaa1111bbbb2222", "cccc3333dddd4444", baseEvent.agentId],
    });
    assert.equal(grantScopeMatches(householdGrant, baseEvent), true);
  });

  it("treats missing/empty agentIds as no-agent-restriction", () => {
    // External Auditor / Compliance Officer scopes don't restrict by agentId.
    assert.equal(grantScopeMatches(grant({ tags: ["PHI"] }), baseEvent), true);
    assert.equal(
      grantScopeMatches(grant({ tags: ["PHI"], agentIds: [] }), baseEvent),
      true,
    );
  });
});

// ====================================================================
// hookKinds filter — narrow to specific lifecycle hooks
// ====================================================================

describe("grantScopeMatches — hookKinds filter", () => {
  it("MATCHES when event.hookKind is in grant's hookKinds list", () => {
    const g = grant({
      tags: ["PHI"],
      hookKinds: ["onChatResponse", "afterToolCall"],
    });
    assert.equal(grantScopeMatches(g, baseEvent), true);
  });

  it("REJECTS when event.hookKind is NOT in grant's hookKinds list", () => {
    // Auditor only authorized to see chat responses, not internal tool calls.
    const g = grant({
      tags: ["PHI"],
      hookKinds: ["onChatResponse"],
    });
    const beforeToolCallEvent = {
      ...baseEvent,
      hookKind: "beforeToolCall" as HookKind,
    };
    assert.equal(grantScopeMatches(g, beforeToolCallEvent), false);
  });

  it("treats missing/empty hookKinds as no-hook-restriction", () => {
    assert.equal(grantScopeMatches(grant({ tags: ["PHI"] }), baseEvent), true);
    assert.equal(
      grantScopeMatches(
        grant({ tags: ["PHI"], hookKinds: [] }),
        baseEvent,
      ),
      true,
    );
  });
});

// ====================================================================
// time-bound filters — audit windows
// ====================================================================

describe("grantScopeMatches — time-bound filters", () => {
  it("MATCHES when event.ts is within [fromIso, toIso]", () => {
    const g = grant({
      tags: ["PHI"],
      fromIso: "2026-04-01T00:00:00.000Z",
      toIso: "2026-04-30T23:59:59.000Z",
    });
    assert.equal(grantScopeMatches(g, baseEvent), true);
  });

  it("REJECTS when event.ts is before fromIso", () => {
    const g = grant({
      tags: ["PHI"],
      fromIso: "2026-05-01T00:00:00.000Z",
    });
    assert.equal(grantScopeMatches(g, baseEvent), false);
  });

  it("REJECTS when event.ts is after toIso", () => {
    const g = grant({
      tags: ["PHI"],
      toIso: "2026-04-01T00:00:00.000Z",
    });
    assert.equal(grantScopeMatches(g, baseEvent), false);
  });

  it("MATCHES exactly at fromIso boundary", () => {
    const g = grant({
      tags: ["PHI"],
      fromIso: baseEvent.ts,
    });
    assert.equal(grantScopeMatches(g, baseEvent), true);
  });
});

// ====================================================================
// compound — all filters must pass
// ====================================================================

describe("grantScopeMatches — compound filters (AND semantics)", () => {
  it("MATCHES only when tags AND agentIds AND hookKinds AND time-window all pass", () => {
    const g = grant({
      tags: ["PHI"],
      agentIds: [baseEvent.agentId],
      hookKinds: ["onChatResponse"],
      fromIso: "2026-04-01T00:00:00.000Z",
      toIso: "2026-04-30T23:59:59.000Z",
    });
    assert.equal(grantScopeMatches(g, baseEvent), true);
  });

  it("REJECTS if ANY one filter fails (agentIds disagrees)", () => {
    const g = grant({
      tags: ["PHI"], // would match
      agentIds: ["wrong-agent-id"], // breaks the AND
      hookKinds: ["onChatResponse"], // would match
    });
    assert.equal(grantScopeMatches(g, baseEvent), false);
  });

  it("REJECTS if ANY one filter fails (time window disagrees)", () => {
    const g = grant({
      tags: ["PHI"],
      agentIds: [baseEvent.agentId],
      hookKinds: ["onChatResponse"],
      toIso: "2026-04-01T00:00:00.000Z", // event is after this
    });
    assert.equal(grantScopeMatches(g, baseEvent), false);
  });

  it("MATCHES the empty scope (no filters → applies to everything)", () => {
    // The `grantScopeMatches` function must accept an empty scope. The
    // wrap-everything case is what `defaultRecipients: [{id:'self'}]` uses.
    assert.equal(grantScopeMatches(grant({}), baseEvent), true);
  });
});
