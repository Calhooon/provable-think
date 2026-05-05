/**
 * Phase 2.5 clinical-triage scenario.
 *
 * Simulates a chronic-care patient interaction:
 *   1. Patient submits symptoms (with PHI) — `beforeToolCall` for the
 *      clinical-decision-support lookup. Tagged `PHI` + `treatment`.
 *   2. Tool returns a guideline recommendation — `afterToolCall`. Tagged
 *      `PHI` + `treatment`.
 *   3. Agent emits a triage decision back to the patient + archives a
 *      QA-grade summary — `onChatResponse`. Tagged `PHI` + `treatment` +
 *      `operations` (the operations tag widens the audience to External
 *      HIPAA Auditors who can review for QA without seeing treatment
 *      plaintext).
 *
 * The agent's `withProvenance` config has `HIPAA_PRESET` spread in, so:
 *   - Every payload runs through `applyHipaaRedaction` before being sealed
 *     into the envelope and hashed for the on-chain commitment. Plaintext
 *     PHI never lands in the envelope.
 *   - Default encryption is AES-256-GCM with multi-recipient BRC-78
 *     wrapping. Active grants whose scope intersects an event's tags are
 *     auto-added as additional recipients.
 *
 * This is the load-bearing demonstration for Phase 2.5: every guarantee in
 * `HIPAA-AUDIT-PLAYBOOK.md` is executed against real BSV mainnet money. The
 * verifier CLI runs against the resulting txids; all 11 steps pass for any
 * authorized persona scope and fail (politely) for unauthorized ones.
 */

import {
  HIPAA_SCOPE_TAGS,
  type HookKind,
} from "provable-think";

/** A single committed step within the triage scenario. */
export interface TriageStep {
  hookKind: HookKind;
  scopeTags: string[];
  payload: Record<string, unknown>;
  /** Brief human label for the operator console. */
  label: string;
}

/**
 * Realistic clinical-triage payloads. Each carries multiple Safe-Harbor
 * categories (name, DOB, MRN, address, ZIP, phone, email) so the redaction
 * pass has work to do — and the gate proves PHI never leaks even though
 * the agent received it as input.
 */
export function buildTriageSteps(): TriageStep[] {
  const patient = {
    name: "Jane Marie Doe",
    dob: "1958-07-12",
    mrn: "MRN-44820189",
    address: "1234 Main St, Apt 5B, San Francisco",
    zip: "94110",
    phone: "(415) 555-1234",
    email: "jane.doe@example.com",
  };

  const visit = {
    date: "2026-04-28",
    chiefComplaint: "fatigue, intermittent chest pain x 3 days",
    vitals: { bp: "165/110", hr: 92, glucose: 142, weight_kg: 84 },
    history: "T2DM x 12 yr, HTN, hyperlipidemia. Last A1C 8.4 (2026-01).",
  };

  return [
    {
      hookKind: "beforeToolCall",
      scopeTags: [HIPAA_SCOPE_TAGS.PHI, HIPAA_SCOPE_TAGS.TREATMENT],
      label: "Clinical-decision-support lookup (input PHI)",
      payload: {
        tool: "clinical_guideline_lookup",
        // The `patient` block carries every direct identifier — the agent
        // received it from the EHR but we never want the plaintext to land
        // in the envelope. HIPAA_PRESET's redaction handles that.
        input: {
          patient,
          visit,
          query:
            "ACC/AHA chronic stable angina workup recommendations for T2DM patient with new-onset chest pain",
        },
      },
    },
    {
      hookKind: "afterToolCall",
      scopeTags: [HIPAA_SCOPE_TAGS.PHI, HIPAA_SCOPE_TAGS.TREATMENT],
      label: "Tool result — guideline recommendation",
      payload: {
        tool: "clinical_guideline_lookup",
        output: {
          guideline: "ACC/AHA 2023 Chronic Coronary Disease Guideline",
          recommendations: [
            "Resting ECG (Class I)",
            "High-sensitivity troponin (Class I)",
            "Lipid panel + HbA1c",
            "Stress imaging (CCTA or stress echo) if intermediate-to-high pretest probability",
          ],
          riskScore: { name: "ASCVD 10-yr", value: 18.4, classification: "high" },
        },
      },
    },
    {
      hookKind: "onChatResponse",
      // Adding `operations` widens the auditor surface — the External HIPAA
      // Auditor (scope: operations + de-identified) can decrypt this event
      // for QA review. The redacted plaintext means even the auditor never
      // sees direct PHI.
      scopeTags: [
        HIPAA_SCOPE_TAGS.PHI,
        HIPAA_SCOPE_TAGS.TREATMENT,
        HIPAA_SCOPE_TAGS.OPERATIONS,
      ],
      label: "Triage decision (response to patient + QA archival)",
      payload: {
        decision: {
          urgency: "urgent",
          disposition:
            "Refer to cardiology within 48–72h. ED if pain recurs, worsens, or is associated with diaphoresis/dyspnea.",
          rationale:
            "Sustained HTN (165/110), elevated A1C, ASCVD 10-yr 18.4% (high), chest pain — ACC/AHA Class I workup indicated.",
          followUp: { days: 7, action: "primary-care visit to titrate BP + glucose meds" },
        },
        modelMeta: {
          provider: "workers-ai",
          model: "@cf/meta/llama-3.1-70b-instruct-fp8-fast",
          temperature: 0.2,
        },
        // The reply body the patient sees — natural language with PHI
        // references. Redaction keeps the on-chain hash bound to a redacted
        // copy; the patient sees the full text via the chat UI, not via the
        // audit envelope.
        reply:
          "Hi Jane — based on your chest pain, blood pressure (165/110), and diabetes history, I recommend you see a cardiologist within 2–3 days. " +
          "If the pain comes back stronger, or you feel short of breath or sweaty, please go to the emergency department. " +
          "You can reach the cardiology line at (415) 555-2200. We'll send a referral to your account on file.",
      },
    },
  ];
}
