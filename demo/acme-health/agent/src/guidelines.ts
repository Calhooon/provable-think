/**
 * `clinical_guideline_lookup` — a deterministic tool the agent calls
 * before answering. Real Project Think `beforeToolCall` + `afterToolCall`
 * hooks fire around it, so the demo reads as: patient asks → agent
 * INVESTIGATES (looks up canonical guideline for the chief complaint)
 * → agent decides → agent explains.
 *
 * Returns a small, deterministic snippet keyed off the patient's chief
 * complaint via simple keyword matching. Not real medical inference —
 * the LLM does the real synthesis using this as context. The point is
 * to expose a tool surface so the audit trail demonstrates real
 * tool-call provenance, not synthetic events.
 */

export interface GuidelineKeyword {
  /** Stable internal key — what the audit trail records as the tool query. */
  key: string;
  /** Human label for the operator pane / debug. */
  label: string;
}

export interface GuidelineRecord {
  /** Stable name appearing in the on-chain audit (no PHI). */
  guidelineName: string;
  /** Two-line summary the agent feeds back into its system prompt as context. */
  summary: string;
  /** Red-flag escalation criteria from the guideline. Surfaced in the reply. */
  redFlags: string[];
  /** Authority citation. */
  source: string;
}

const GUIDELINES: Record<string, GuidelineRecord> = {
  cardiac_symptoms: {
    guidelineName: "ACC/AHA 2023 Chronic Coronary Disease Guideline",
    summary:
      "For new-onset exertional chest pain in adults with CV risk factors: " +
      "ED evaluation if pain is severe, persistent, or accompanied by " +
      "diaphoresis/dyspnea/syncope. Outpatient workup acceptable for " +
      "stable, mild, brief episodes — start with ECG + high-sensitivity " +
      "troponin within 24h, lipid panel, A1c.",
    redFlags: [
      "Pain at rest or progressively worsening",
      "Pain + diaphoresis, dyspnea, syncope, or radiation to jaw/arm",
      "Sudden severe pain ('worst ever')",
    ],
    source: "ACC/AHA 2023",
  },
  headache_evaluation: {
    guidelineName: "AAN / AHS 2024 Migraine and Secondary Headache Guideline",
    summary:
      "Recurrent migraine in adults: primary care manages with rescue " +
      "(triptans / NSAIDs) + preventive (CGRP, beta-blockers) when " +
      "frequency exceeds 2-3 attacks/week. Neurology referral indicated " +
      "for refractory cases, focal aura without recovery, or red flags.",
    redFlags: [
      "Thunderclap or sudden 'worst headache of life'",
      "Fever + neck stiffness, focal neuro deficit, papilledema",
      "Headache after head injury or with new-onset confusion",
    ],
    source: "AAN/AHS 2024",
  },
  back_pain: {
    guidelineName: "ACP 2017 Low Back Pain Clinical Practice Guideline",
    summary:
      "Acute mechanical low-back pain (< 4 weeks, no red flags): " +
      "non-pharmacologic first-line (heat, stretching, manual therapy); " +
      "NSAID rescue. Imaging not indicated. Re-evaluate at 4 weeks.",
    redFlags: [
      "Saddle anesthesia, bowel/bladder dysfunction (cauda equina)",
      "Severe progressive neurologic deficit",
      "Recent significant trauma, fever, IV drug use, malignancy history",
    ],
    source: "ACP 2017",
  },
  respiratory_uri: {
    guidelineName: "IDSA 2024 Acute Respiratory Infection Guideline",
    summary:
      "Uncomplicated viral URI (sore throat, mild cough, low-grade " +
      "fever, no comorbidities): supportive care, hydration, OTC " +
      "analgesics. Reassess in 7-10 days; antibiotic only if strep, " +
      "sinusitis ≥10d, or pneumonia features develop.",
    redFlags: [
      "Trouble breathing, drooling, inability to swallow",
      "Stiff neck + fever + rash",
      "Severe dehydration, immunocompromised host",
    ],
    source: "IDSA 2024",
  },
  diabetes_management: {
    guidelineName: "ADA 2025 Standards of Care in Diabetes",
    summary:
      "T2DM management: metformin first-line; add GLP-1 RA / SGLT2i " +
      "for cardiorenal protection. A1C goal individualized (typically " +
      "< 7.0%). BP < 130/80, statin per ASCVD risk. Annual eye, foot, " +
      "kidney screening.",
    redFlags: [
      "DKA: glucose > 250, ketones, pH < 7.3 — ED",
      "HHS: glucose > 600, dehydration, altered mental status — ED",
      "Hypoglycemia unawareness: refer endocrine",
    ],
    source: "ADA 2025",
  },
  colorectal_screening: {
    guidelineName: "USPSTF 2021 Colorectal Cancer Screening Recommendation",
    summary:
      "Average-risk adults: screen ages 45-75 (Grade A 50-75, B 45-49). " +
      "First-degree relative with CRC: start 10y before relative's age " +
      "at diagnosis or 40y, whichever earlier. Colonoscopy q10y; FIT " +
      "annual; Cologuard q3y.",
    redFlags: [
      "Hematochezia, melena, unexplained weight loss",
      "Iron-deficiency anemia in adult",
      "Family history of polyposis or Lynch syndrome",
    ],
    source: "USPSTF 2021",
  },
  general_triage: {
    guidelineName: "Acme Health Internal Triage Protocol — General",
    summary:
      "Symptom evaluation: severity, duration, red-flag screen, " +
      "comorbidity weight. Same-day primary care for moderate symptoms; " +
      "urgent care for inability to reach PCP within 24h; ED for any " +
      "red flag.",
    redFlags: [
      "Severe pain, fever > 39.5°C in adult",
      "Altered mental status, focal neuro deficit",
      "Suspected sepsis (hypotension, AMS, fever + tachycardia)",
    ],
    source: "Acme Health internal",
  },
};

/**
 * Cheap keyword classifier — picks the right guideline for the patient's
 * chief complaint. Order matters: more specific patterns first.
 */
export function inferGuidelineKeyword(text: string): GuidelineKeyword {
  const t = text.toLowerCase();
  if (
    /\b(chest pain|chest pressure|cardiac|heart attack|exertion(al)? pain)\b/.test(t)
  ) {
    return { key: "cardiac_symptoms", label: "Cardiac symptoms" };
  }
  if (
    /\b(migraine|headache|head pain|throbbing|aura)\b/.test(t)
  ) {
    return { key: "headache_evaluation", label: "Headache evaluation" };
  }
  if (
    /\b(back pain|back hurt|lifting|spine|sciatic|lumbar)\b/.test(t)
  ) {
    return { key: "back_pain", label: "Low back pain" };
  }
  if (
    /\b(cough|sore throat|cold|flu|runny nose|sinus|congest|fever)\b/.test(t)
  ) {
    return { key: "respiratory_uri", label: "Respiratory URI" };
  }
  if (
    /\b(diabetes|t1dm|t2dm|sugar|glucose|a1c|insulin|metformin|lisinopril)\b/.test(t)
  ) {
    return { key: "diabetes_management", label: "Diabetes management" };
  }
  if (
    /\b(colon|colonoscop|colorectal|crc|polyp|family history of (cancer|colon))\b/.test(t)
  ) {
    return { key: "colorectal_screening", label: "Colorectal screening" };
  }
  return { key: "general_triage", label: "General triage" };
}

export function lookupGuideline(keyword: GuidelineKeyword): GuidelineRecord {
  return GUIDELINES[keyword.key] ?? GUIDELINES.general_triage!;
}
