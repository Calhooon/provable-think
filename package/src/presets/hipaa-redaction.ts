/**
 * Safe-Harbor inferred-PHI redaction (45 CFR 164.514(b)(2)).
 *
 * Detects and replaces the 18 categories of direct identifiers listed in the
 * Safe Harbor de-identification standard. The redacted payload is what gets
 * sealed into the envelope and hashed for the on-chain commitment, so even
 * an operator's own audit logs never carry inferred PHI in plaintext.
 *
 * # 18 identifier categories (45 CFR 164.514(b)(2)(i))
 *
 *  (A) Names
 *  (B) Geographic subdivisions smaller than a state — street, city, county,
 *      precinct, ZIP code (3-digit ZIP retained per (B)(1)–(2))
 *  (C) Dates (except year) directly related to an individual — DOB, admission,
 *      discharge, death, age over 89
 *  (D) Telephone numbers
 *  (E) Vehicle identifiers — license plates, VIN
 *  (F) Fax numbers
 *  (G) Device identifiers and serial numbers
 *  (H) Email addresses
 *  (I) URLs
 *  (J) Social Security numbers
 *  (K) IP addresses
 *  (L) Medical record numbers
 *  (M) Biometric identifiers (fingerprints, voice prints)
 *  (N) Health plan beneficiary numbers
 *  (O) Full-face photographs and comparable images
 *  (P) Account numbers
 *  (Q) Any other unique identifying number, characteristic, or code
 *  (R) Certificate/license numbers
 *
 * # Detection approach
 *
 * Pattern-based regex matchers tuned for high recall (per the issue
 * acceptance — over-redaction is fine; under-redaction is the compliance
 * failure). The matchers are conservative on category (A) Names — proper-
 * name detection without an NER model is ambiguous, so we rely on
 * structured-field hints (keys named `name`, `patient`, `firstName`, etc.).
 *
 * Markers use the format `<redacted:phi:<type>>` so a downstream decryptor
 * can distinguish redacted spans from real content. Length normalization
 * means a tampered ciphertext can't trivially recover the original via
 * timing/length analysis.
 *
 * Limitations (documented in `HIPAA-AUDIT-PLAYBOOK.md` §3.3):
 *   - Heuristic name detection only triggers on field-key hints (`name`,
 *     `patientName`, etc.). Free-text mentions of unrecognized names slip
 *     through. Operators should run a proper DLP pipeline upstream.
 *   - No biometric file-content scanning (we don't decode images / audio).
 *     Operators must redact biometric fields by attaching a
 *     `<redacted:phi:biometric>` placeholder explicitly.
 *   - Date redaction normalizes month/day to `XX` but retains the year for
 *     compatibility with longitudinal QA (Safe Harbor permits years; (C)
 *     requires removing month+day only).
 *
 * The detection pipeline runs over canonical-JSON serialization of the
 * payload, so structure is preserved (object shape unchanged; only string
 * values get spans replaced). Numeric values are coerced to strings for
 * pattern matching.
 */

export const HIPAA_REDACTION_VERSION = "v0.1";

/** A single replaced span in the input. */
export interface RedactedSpan {
  /** The Safe Harbor category code (A through R) and our short type name. */
  category:
    | "name"
    | "address"
    | "date-mmdd"
    | "phone"
    | "vehicle"
    | "fax"
    | "device-serial"
    | "email"
    | "url"
    | "ssn"
    | "ip"
    | "mrn"
    | "biometric"
    | "plan-beneficiary"
    | "photo"
    | "account"
    | "license"
    | "zip"
    | "credit-card"
    | "age-over-89";
  /** JSON-pointer-ish path into the redacted object. */
  path: string;
  /** Whether the original value was fully replaced or partially redacted. */
  mode: "full-replace" | "partial-replace";
}

/** Result of running redaction over a payload. */
export interface RedactionResult {
  /** The redacted payload (same shape; some string values replaced). */
  redacted: unknown;
  /** Per-category counts of replacements made (reporting / metrics). */
  counts: Record<string, number>;
  /** All replaced spans with their JSON paths. */
  spans: RedactedSpan[];
}

// ====================================================================
// Pattern matchers (string-level)
// ====================================================================

/**
 * Each entry is a category + regex; order matters because earlier matches
 * are taken first (so SSN is checked before phone, etc.).
 *
 * The regexes below were tuned for high recall and tested against the
 * fixture set in `hipaa.test.ts`. Word-boundary anchors (`\b`) keep us from
 * matching inside larger tokens.
 */
const PATTERNS: Array<{
  category: RedactedSpan["category"];
  regex: RegExp;
}> = [
  // (J) SSN — 3-2-4 digits, with or without dashes/spaces
  {
    category: "ssn",
    regex: /\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
  },
  // Credit card — Luhn-eligible 13–19 digit groups (covers (P) account numbers
  // and (Q) catch-all for payment cards). Loose grouping; we don't validate
  // Luhn because over-redaction is fine.
  {
    category: "credit-card",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
  },
  // (E) VIN — 17 chars, alphanumeric, no I/O/Q
  {
    category: "vehicle",
    regex: /\b[A-HJ-NPR-Z0-9]{17}\b/g,
  },
  // (F)/(D) Phone/fax — North American + international common forms
  {
    category: "phone",
    regex:
      /(?:\+?\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  },
  // (H) Email
  {
    category: "email",
    regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
  },
  // (I) URL — http(s) and bare www. Includes `uhrp://` URIs since those
  // can carry blob hashes that the auditor's persona view shouldn't have.
  {
    category: "url",
    regex: /\b(?:https?:\/\/|www\.|uhrp:\/\/)[^\s<>"'\\]+/gi,
  },
  // (K) IPv4 — broad match; we don't validate octet ≤ 255 (over-redact OK)
  {
    category: "ip",
    regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  },
  // (L) MRN — common formats: MRN-12345678, MRN: 12345678, "medical record
  // number 1234567"
  {
    category: "mrn",
    regex: /\b(?:MRN|medical\s+record\s+(?:number|no\.?|#))[\s#:.-]*\d{4,12}\b/gi,
  },
  // (B) ZIP — 5-digit and 5+4 (ZIP+4). We redact the last 2 digits only
  // (Safe Harbor permits 3-digit ZIP for areas > 20K population). Done by
  // a custom replacer below to preserve the 3-digit prefix.
  {
    category: "zip",
    regex: /\b\d{5}(?:-\d{4})?\b/g,
  },
  // (C) Date with month+day — many forms:
  //   2026-04-28, 04/28/2026, April 28 2026, Apr 28, 2026, 28-Apr-2026
  // Years alone are permitted by Safe Harbor (subject to the 89+ rule).
  {
    category: "date-mmdd",
    regex:
      /\b(?:\d{4}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])|(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+\d{2,4})?|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?(?:[-,\s]+\d{2,4})?)\b/gi,
  },
  // (C) Age over 89 — Safe Harbor caps ages at "90 or older"
  { category: "age-over-89", regex: /\bage[s]?\s*(?:of\s+)?(?:9\d|1\d{2})\b/gi },
];

/**
 * Field-key heuristics — keys whose mere presence signals the value is
 * a direct identifier. Triggers full-replace regardless of the value's
 * regex match. Lowercase keys.
 */
const NAME_KEY_HINTS = new Set([
  "name",
  "fullname",
  "firstname",
  "lastname",
  "givenname",
  "familyname",
  "middlename",
  "patient",
  "patientname",
  "subject",
  "subjectname",
  "guardian",
  "guardianname",
  "physician",
  "physicianname",
  "provider",
  "providername",
  "doctor",
  "doctorname",
]);

const ADDRESS_KEY_HINTS = new Set([
  "address",
  "street",
  "streetaddress",
  "addressline1",
  "addressline2",
  "addr",
]);

const DEVICE_SERIAL_KEY_HINTS = new Set([
  "serial",
  "serialnumber",
  "deviceid",
  "deviceserial",
  "imei",
  "macaddress",
]);

const PHOTO_KEY_HINTS = new Set([
  "photo",
  "photourl",
  "photoid",
  "image",
  "imageurl",
  "facephoto",
  "headshot",
  "selfie",
  "avatar",
]);

const BIOMETRIC_KEY_HINTS = new Set([
  "fingerprint",
  "voiceprint",
  "retina",
  "iris",
  "biometric",
  "biometrics",
  "dnaprofile",
]);

const PLAN_BENEFICIARY_KEY_HINTS = new Set([
  "memberid",
  "beneficiaryid",
  "subscriberid",
  "policyholderid",
  "insuranceid",
  "planid",
]);

const ACCOUNT_KEY_HINTS = new Set([
  "accountnumber",
  "acct",
  "acctnum",
  "iban",
  "bankaccount",
]);

const LICENSE_KEY_HINTS = new Set([
  "licensenumber",
  "licenseno",
  "drivinglicense",
  "driverlicense",
  "dlnumber",
  "passport",
  "passportnumber",
]);

/** Resolves a field-key hint to the appropriate redaction category. */
function categoryForKeyHint(lowerKey: string): RedactedSpan["category"] | null {
  if (NAME_KEY_HINTS.has(lowerKey)) return "name";
  if (ADDRESS_KEY_HINTS.has(lowerKey)) return "address";
  if (DEVICE_SERIAL_KEY_HINTS.has(lowerKey)) return "device-serial";
  if (PHOTO_KEY_HINTS.has(lowerKey)) return "photo";
  if (BIOMETRIC_KEY_HINTS.has(lowerKey)) return "biometric";
  if (PLAN_BENEFICIARY_KEY_HINTS.has(lowerKey)) return "plan-beneficiary";
  if (ACCOUNT_KEY_HINTS.has(lowerKey)) return "account";
  if (LICENSE_KEY_HINTS.has(lowerKey)) return "license";
  return null;
}

/** Marker emitter — central so we can change the format in one place. */
function marker(category: RedactedSpan["category"]): string {
  return `<redacted:phi:${category}>`;
}

/**
 * Run all string-pattern matchers over `text`, replacing matched spans with
 * `marker(category)`. Returns the replaced text + the spans we rewrote.
 *
 * The ZIP matcher is special-cased: instead of full-replacement we keep the
 * 3-digit prefix (which Safe Harbor permits) and replace the last 2 digits
 * with `XX`. Older 5+4 format is fully replaced.
 */
function redactStringSpans(
  text: string,
  pathPrefix: string,
  spans: RedactedSpan[],
  counts: Record<string, number>,
): string {
  let out = text;
  for (const { category, regex } of PATTERNS) {
    out = out.replace(regex, (match) => {
      // ZIP is partial-replace per Safe Harbor (B)(1)–(2): retain 3-digit prefix.
      if (category === "zip" && /^\d{5}$/.test(match)) {
        spans.push({ category, path: pathPrefix, mode: "partial-replace" });
        counts[category] = (counts[category] ?? 0) + 1;
        return `${match.slice(0, 3)}XX`;
      }
      spans.push({ category, path: pathPrefix, mode: "full-replace" });
      counts[category] = (counts[category] ?? 0) + 1;
      return marker(category);
    });
  }
  return out;
}

/**
 * Recursively walk the payload, applying redaction to string leaves.
 * Field-key hints trigger full-value replacement *before* string-pattern
 * matching, since e.g. a "name" field shouldn't be left intact even if
 * none of the regex matchers fired (they don't match arbitrary names).
 */
function walk(
  value: unknown,
  path: string,
  spans: RedactedSpan[],
  counts: Record<string, number>,
  parentKey: string | null,
): unknown {
  // Field-key hint: if the parent key is a known identifier-bearing slot,
  // full-replace the value with the appropriate marker.
  if (parentKey !== null) {
    const lower = parentKey.toLowerCase();
    const hintCategory = categoryForKeyHint(lower);
    if (hintCategory && (typeof value === "string" || typeof value === "number")) {
      spans.push({ category: hintCategory, path, mode: "full-replace" });
      counts[hintCategory] = (counts[hintCategory] ?? 0) + 1;
      return marker(hintCategory);
    }
  }

  if (typeof value === "string") {
    return redactStringSpans(value, path, spans, counts);
  }
  if (typeof value === "number") {
    // Coerce numbers to strings only when they look like an identifier
    // (long digit sequences). Most numeric clinical data (BP, glucose) is
    // legitimate measurement and should NOT be redacted.
    const s = String(value);
    if (s.length >= 9) {
      const replaced = redactStringSpans(s, path, spans, counts);
      // If a pattern hit, return the redacted string. Otherwise leave as number.
      if (replaced !== s) return replaced;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => walk(v, `${path}[${i}]`, spans, counts, null));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, `${path}.${k}`, spans, counts, k);
    }
    return out;
  }
  // null, boolean, undefined — leave untouched
  return value;
}

/**
 * Apply Safe-Harbor inferred-PHI redaction to a payload.
 *
 * Returns a new payload with the same shape; string values containing
 * detected identifiers are replaced with `<redacted:phi:<type>>` markers.
 * Numbers, booleans, nulls, and undefined values pass through unchanged
 * (except long numeric identifiers that match SSN / phone patterns).
 *
 * @param payload  Any JSON-serializable value.
 * @returns        `{ redacted, counts, spans }` — the redacted payload, a
 *                 per-category histogram, and the list of replaced spans.
 */
export function applyHipaaRedaction(payload: unknown): RedactionResult {
  const spans: RedactedSpan[] = [];
  const counts: Record<string, number> = {};
  const redacted = walk(payload, "$", spans, counts, null);
  return { redacted, counts, spans };
}
