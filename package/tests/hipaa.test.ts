/**
 * Unit tests for the HIPAA preset.
 *
 * Run with: `npm run test` (compiles src/ → dist/ then runs `node --test`).
 *
 * Covers:
 *   - Scope tag taxonomy (Issue #1 acceptance: "scope-match on all 8 names").
 *   - Safe-Harbor redaction patterns (Issue #3 acceptance: "20+ realistic PHI
 *     snippets, 95% recall").
 *   - HIPAA_PRESET composability (Issue #2 acceptance: "spread Just Works").
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  HIPAA_PRESET,
  HIPAA_SCOPE_TAGS,
  HIPAA_SCOPE_TAGS_LIST,
  HIPAA_COMPLIANCE_OFFICER_SCOPE,
  HIPAA_EXTERNAL_AUDITOR_SCOPE,
  hipaaPatientScope,
  applyHipaaRedaction,
  HIPAA_REDACTION_VERSION,
} from "../src/presets/hipaa.js";

// ====================================================================
// Issue #1 — scope tag taxonomy
// ====================================================================

describe("HIPAA scope tag taxonomy", () => {
  it("exports all 8 canonical tags", () => {
    assert.equal(HIPAA_SCOPE_TAGS.PHI, "PHI");
    assert.equal(HIPAA_SCOPE_TAGS.TREATMENT, "treatment");
    assert.equal(HIPAA_SCOPE_TAGS.PAYMENT, "payment");
    assert.equal(HIPAA_SCOPE_TAGS.OPERATIONS, "operations");
    assert.equal(HIPAA_SCOPE_TAGS.DE_IDENTIFIED, "de-identified");
    assert.equal(HIPAA_SCOPE_TAGS.MARKETING, "marketing");
    assert.equal(HIPAA_SCOPE_TAGS.RESEARCH, "research");
    assert.equal(HIPAA_SCOPE_TAGS.LIMITED_DATA_SET, "limited-data-set");
  });

  it("HIPAA_SCOPE_TAGS_LIST contains exactly 8 tags", () => {
    assert.equal(HIPAA_SCOPE_TAGS_LIST.length, 8);
    const set = new Set(HIPAA_SCOPE_TAGS_LIST);
    assert.equal(set.size, 8, "no duplicates");
    for (const tag of [
      "PHI",
      "treatment",
      "payment",
      "operations",
      "de-identified",
      "marketing",
      "research",
      "limited-data-set",
    ]) {
      assert.ok(set.has(tag as never), `missing tag: ${tag}`);
    }
  });

  it("Compliance Officer scope = full-PHI umbrella", () => {
    assert.deepEqual(HIPAA_COMPLIANCE_OFFICER_SCOPE, { tags: ["PHI"] });
  });

  it("External Auditor scope = operations + de-identified only", () => {
    assert.deepEqual(HIPAA_EXTERNAL_AUDITOR_SCOPE, {
      tags: ["operations", "de-identified"],
    });
  });

  it("Patient scope binds to a specific session agent id", () => {
    const scope = hipaaPatientScope("agent-abc-1234");
    assert.deepEqual(scope, {
      tags: ["PHI"],
      agentIds: ["agent-abc-1234"],
    });
  });

  it("HIPAA_SCOPE_TAGS is frozen (won't mutate at runtime)", () => {
    assert.ok(Object.isFrozen(HIPAA_SCOPE_TAGS_LIST));
  });
});

// ====================================================================
// Issue #2 — HIPAA_PRESET composability
// ====================================================================

describe("HIPAA_PRESET", () => {
  it("encryption defaults to aes-256-gcm", () => {
    assert.equal(HIPAA_PRESET.encryption?.algorithm, "aes-256-gcm");
  });

  it("disclosure defaults include PHI + treatment scopes", () => {
    assert.deepEqual(HIPAA_PRESET.disclosure?.defaultScopes, [
      "PHI",
      "treatment",
    ]);
  });

  it("rotationPolicy defaults to quarterly", () => {
    assert.equal(HIPAA_PRESET.disclosure?.rotationPolicy, "quarterly");
  });

  it("redaction is enabled by default with a transform wired", () => {
    assert.equal(HIPAA_PRESET.disclosure?.redaction?.enabled, true);
    assert.equal(typeof HIPAA_PRESET.disclosure?.redaction?.transform, "function");
  });

  it("preset spread + override Just Works", () => {
    // Mimics the README pattern: spread preset, override identity binding.
    const composed = {
      ...HIPAA_PRESET,
      identity: { envBinding: "AGENT_PRIVATE_KEY_HEX" },
      storage: {
        primary: "r2" as const,
        r2: { binding: "PHI_ENVELOPES" },
      },
      anchor: { network: "mainnet" as const },
    };
    assert.equal(composed.identity.envBinding, "AGENT_PRIVATE_KEY_HEX");
    assert.equal(composed.storage.primary, "r2");
    assert.equal(composed.anchor.network, "mainnet");
    // Preset fields survive the spread.
    assert.equal(composed.encryption?.algorithm, "aes-256-gcm");
    assert.deepEqual(composed.disclosure?.defaultScopes, ["PHI", "treatment"]);
  });

  it("operator can disable redaction by overriding disclosure.redaction", () => {
    const composed = {
      ...HIPAA_PRESET,
      disclosure: {
        ...HIPAA_PRESET.disclosure,
        redaction: { enabled: false },
      },
    };
    assert.equal(composed.disclosure?.redaction?.enabled, false);
    // Other preset disclosure fields preserved.
    assert.deepEqual(composed.disclosure?.defaultScopes, ["PHI", "treatment"]);
  });
});

// ====================================================================
// Issue #3 — Safe-Harbor inferred-PHI redaction (20+ fixtures)
// ====================================================================

describe("applyHipaaRedaction — Safe-Harbor 18 identifiers", () => {
  it("exports a stable version string", () => {
    assert.equal(HIPAA_REDACTION_VERSION, "v0.1");
  });

  // Helper: assert that a redacted result's serialized form contains the
  // expected redaction marker(s) for the given category.
  function expectMarker(result: ReturnType<typeof applyHipaaRedaction>, category: string) {
    const json = JSON.stringify(result.redacted);
    assert.ok(
      json.includes(`<redacted:phi:${category}>`),
      `expected <redacted:phi:${category}> in ${json}`,
    );
    assert.ok(
      (result.counts[category] ?? 0) > 0,
      `expected counts.${category} > 0; got ${JSON.stringify(result.counts)}`,
    );
  }

  // Helper: assert redaction count meets a recall threshold.
  function expectAtLeast(
    result: ReturnType<typeof applyHipaaRedaction>,
    n: number,
  ) {
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
    assert.ok(
      total >= n,
      `expected ≥${n} redactions, got ${total}: ${JSON.stringify(result.counts)}`,
    );
  }

  // ---- (A) Names — field-key heuristic ----

  it("(A) redacts patient name from a `name` field", () => {
    const r = applyHipaaRedaction({
      name: "Jane Doe",
      complaint: "headache",
    });
    expectMarker(r, "name");
    assert.equal((r.redacted as { complaint: string }).complaint, "headache");
  });

  it("(A) redacts firstName / lastName / patientName fields", () => {
    const r = applyHipaaRedaction({
      firstName: "Robert",
      lastName: "Smith",
      patientName: "R. Smith",
    });
    expectAtLeast(r, 3);
    assert.equal((r.counts.name ?? 0), 3);
  });

  // ---- (B) Geographic subdivisions ----

  it("(B) redacts ZIP code last 2 digits (Safe Harbor permits 3-digit prefix)", () => {
    const r = applyHipaaRedaction({ zip: "94110" });
    const json = JSON.stringify(r.redacted);
    assert.ok(json.includes("941XX"), `expected 941XX in ${json}`);
    assert.equal(r.counts.zip, 1);
  });

  it("(B) redacts ZIP+4 fully", () => {
    const r = applyHipaaRedaction({ zipPlus4: "94110-3892" });
    expectMarker(r, "zip");
  });

  it("(B) redacts street address from `address` field", () => {
    const r = applyHipaaRedaction({
      address: "1234 Main St, Apt 5B, San Francisco",
    });
    expectMarker(r, "address");
  });

  // ---- (C) Dates with month+day ----

  it("(C) redacts ISO dates (YYYY-MM-DD)", () => {
    const r = applyHipaaRedaction({
      dob: "patient born 1985-03-14",
    });
    expectMarker(r, "date-mmdd");
  });

  it("(C) redacts US-format dates (MM/DD/YYYY)", () => {
    const r = applyHipaaRedaction({
      admission: "admitted 04/28/2026",
    });
    expectMarker(r, "date-mmdd");
  });

  it("(C) redacts written dates (April 28, 2026)", () => {
    const r = applyHipaaRedaction({
      note: "discharged on April 28, 2026",
    });
    expectMarker(r, "date-mmdd");
  });

  it("(C) redacts age 90+ but not age 89-", () => {
    const over = applyHipaaRedaction({ note: "patient age 92, ambulatory" });
    expectMarker(over, "age-over-89");
    const under = applyHipaaRedaction({ note: "patient age 67, hypertensive" });
    assert.equal(under.counts["age-over-89"] ?? 0, 0);
  });

  // ---- (D) Telephone & (F) Fax ----

  it("(D) redacts US phone numbers in common formats", () => {
    const fixtures = [
      "Call (415) 555-1234 for triage",
      "Phone: 415-555-1234",
      "415.555.1234",
      "+1 415 555 1234",
      "fax 415 555 6789",
    ];
    for (const text of fixtures) {
      const r = applyHipaaRedaction({ note: text });
      expectMarker(r, "phone");
    }
  });

  // ---- (E) Vehicle identifiers ----

  it("(E) redacts a 17-char VIN", () => {
    const r = applyHipaaRedaction({ note: "VIN 1HGBH41JXMN109186 on incident report" });
    expectMarker(r, "vehicle");
  });

  // ---- (G) Device identifiers ----

  it("(G) redacts device serial numbers via field hint", () => {
    const r = applyHipaaRedaction({
      deviceSerial: "ECG-9X-77824-22A",
    });
    expectMarker(r, "device-serial");
  });

  // ---- (H) Email ----

  it("(H) redacts email addresses", () => {
    const r = applyHipaaRedaction({
      contact: "patient at jane.doe@example.com replied",
    });
    expectMarker(r, "email");
  });

  // ---- (I) URLs ----

  it("(I) redacts http and https URLs", () => {
    const r = applyHipaaRedaction({
      note: "see https://patient-portal.acme.example/jane",
    });
    expectMarker(r, "url");
  });

  it("(I) redacts uhrp:// URIs (so cross-blob links don't leak)", () => {
    const r = applyHipaaRedaction({
      note: "envelope at uhrp://XUUb6AiKeq27Z7osatzVhpi8z4qm1tWwTjxeyAuBoY4f",
    });
    expectMarker(r, "url");
  });

  // ---- (J) SSN ----

  it("(J) redacts SSNs (with and without dashes)", () => {
    const fixtures = ["123-45-6789", "123 45 6789", "ssn 123456789"];
    for (const text of fixtures) {
      const r = applyHipaaRedaction({ note: text });
      expectMarker(r, "ssn");
    }
  });

  // ---- (K) IPs ----

  it("(K) redacts IPv4 addresses", () => {
    const r = applyHipaaRedaction({
      note: "session from 192.168.1.42 (clinic LAN)",
    });
    expectMarker(r, "ip");
  });

  // ---- (L) MRN ----

  it("(L) redacts medical record numbers", () => {
    const fixtures = [
      "MRN-12345678",
      "MRN: 1234567",
      "medical record number 87654321",
    ];
    for (const text of fixtures) {
      const r = applyHipaaRedaction({ note: text });
      expectMarker(r, "mrn");
    }
  });

  // ---- (M) Biometric ----

  it("(M) redacts biometric fields via key hint", () => {
    const r = applyHipaaRedaction({
      biometric: "ridge pattern hash 0xdeadbeef",
    });
    expectMarker(r, "biometric");
  });

  // ---- (N) Plan beneficiary ----

  it("(N) redacts plan/member IDs", () => {
    const r = applyHipaaRedaction({
      memberId: "BCBS-9988221",
    });
    expectMarker(r, "plan-beneficiary");
  });

  // ---- (O) Photos ----

  it("(O) redacts photo URLs / image fields", () => {
    const r = applyHipaaRedaction({
      photoUrl: "https://example.com/face/jane.jpg",
    });
    expectMarker(r, "photo");
  });

  // ---- (P) Account ----

  it("(P) redacts account numbers via key hint", () => {
    const r = applyHipaaRedaction({
      accountNumber: "ACME-7788-2211",
    });
    expectMarker(r, "account");
  });

  it("(P) redacts long credit-card-shaped digit groups", () => {
    const r = applyHipaaRedaction({
      note: "card on file 4111 1111 1111 1111",
    });
    // Either credit-card OR ssn pattern may match; over-redaction is fine.
    expectAtLeast(r, 1);
  });

  // ---- (Q) Catch-all unique IDs (covered via account/license heuristics) ----

  // ---- (R) License/certificate numbers ----

  it("(R) redacts driver-license + passport via key hint", () => {
    const r = applyHipaaRedaction({
      licenseNumber: "D9876543",
      passportNumber: "AA1234567",
    });
    assert.equal(r.counts.license, 2);
  });

  // ---- Combined / realistic clinical-triage payload ----

  it("redacts a realistic clinical-triage payload (combined identifiers)", () => {
    const payload = {
      patient: {
        name: "Jane Doe",
        dob: "1985-03-14",
        mrn: "MRN-44820189",
        zip: "94110",
        contact: { email: "jane@example.com", phone: "(415) 555-1234" },
      },
      visit: {
        date: "2026-04-28",
        complaint: "fatigue, intermittent chest pain x 3 days",
        vitals: { bp: "165/110", hr: 92, glucose: 142 },
      },
      assessment: "rule-out cardiac etiology; refer to cardiology",
    };
    const r = applyHipaaRedaction(payload);
    expectAtLeast(r, 7); // name + dob + mrn substring + zip + email + phone + visit-date
    // Clinical measurements should NOT be redacted (numbers below 9 digits).
    const json = JSON.stringify(r.redacted);
    assert.ok(json.includes("165/110"), "BP should not be redacted");
    assert.ok(json.includes("92"), "HR should not be redacted");
    assert.ok(json.includes("142"), "glucose should not be redacted");
    assert.ok(
      json.includes("intermittent chest pain"),
      "clinical narrative should not be redacted",
    );
  });

  it("preserves payload structure (object shape unchanged)", () => {
    const payload = {
      patient: { name: "Jane", age: 67 },
      tags: ["clinical", "urgent"],
    };
    const r = applyHipaaRedaction(payload) as {
      redacted: { patient: { name: string; age: number }; tags: string[] };
    };
    assert.equal(typeof r.redacted.patient, "object");
    assert.equal(Array.isArray(r.redacted.tags), true);
    assert.equal(r.redacted.patient.age, 67); // age 67 < 90 — left alone
    assert.equal(r.redacted.tags[0], "clinical");
  });

  it("leaves null / boolean / undefined alone", () => {
    const r = applyHipaaRedaction({ a: null, b: true, c: undefined, d: 42 });
    assert.equal((r.redacted as { a: unknown }).a, null);
    assert.equal((r.redacted as { b: unknown }).b, true);
    assert.equal((r.redacted as { d: number }).d, 42);
  });

  it("returns spans with JSON paths so over-redaction is auditable", () => {
    const r = applyHipaaRedaction({
      patient: { name: "Jane", contact: { email: "j@x.com" } },
    });
    assert.ok(r.spans.length >= 2);
    const paths = r.spans.map((s) => s.path);
    assert.ok(paths.some((p) => p.includes("name")));
    assert.ok(paths.some((p) => p.includes("contact")));
  });
});
