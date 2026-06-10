/**
 * KOZA PII DETECTOR (spec §2.2 - Data Masking Rules)
 *
 * On-device detection and masking of personally identifiable information
 * before any text leaves the client. Mirrors the server-side SQL function
 * `mask_pii_in_text` (defense in depth - client masks first, the database
 * trigger is the safety net).
 *
 * Dependencies: zero. Pure functions, fully synchronous.
 *
 * Field names match the `session_messages.pii_detected_fields` vocabulary:
 *   phone_number | email | social_media_handle | social_media_url |
 *   street_address | payment_info
 */

// ─── public types ─────────────────────────────────────────────────────────────

export type PiiField =
  | 'phone_number'
  | 'email'
  | 'social_media_handle'
  | 'social_media_url'
  | 'street_address'
  | 'payment_info';

export interface PiiMatch {
  field: PiiField;
  /** Replacement token, e.g. "[PHONE_REDACTED]". The raw value is never kept. */
  replacement: string;
  /** Number of occurrences masked for this field. */
  count: number;
}

export interface MaskResult {
  /** Input with every detected PII span replaced by its redaction token. */
  maskedText: string;
  /** True when at least one pattern matched. */
  hasPii: boolean;
  /** Which fields were detected (unique, in detection order). */
  detectedFields: PiiField[];
  /** Per-field match details (counts only - no raw values, by design). */
  matches: PiiMatch[];
  /** Spec §2.2: payment info must be flagged for safety review. */
  flagForReview: boolean;
}

// ─── patterns ─────────────────────────────────────────────────────────────────
//
// Order matters:
//   1. payment   - card/IBAN digits would otherwise match the phone rule
//   2. email     - contains '@', would otherwise match the handle rule
//   3. social URL- contains domains, would otherwise partially match handles
//   4. handle    - @username
//   5. phone     - 10+ digits, with or without separators
//   6. address   - house number + street keyword (EN + TR)

interface PiiRule {
  field: PiiField;
  pattern: RegExp;
  replacement: string;
}

const RULES: readonly PiiRule[] = [
  {
    field: 'payment_info',
    // IBAN (TR + generic, 15-34 alphanumeric) or 13-19 digit card numbers
    // with optional space/dash grouping
    pattern:
      /\b(?:[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9][ ]?){11,30}|\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,7})\b/g,
    replacement: '[PAYMENT_REDACTED]',
  },
  {
    field: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: '[EMAIL_REDACTED]',
  },
  {
    field: 'social_media_url',
    pattern:
      /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com|t\.me|linkedin\.com\/in)\/[A-Za-z0-9_.-]+/gi,
    replacement: '[HANDLE_REDACTED]',
  },
  {
    field: 'social_media_handle',
    pattern: /(^|[\s.,;:!?(])@[a-zA-Z0-9_]{2,}\b/g,
    replacement: '$1[HANDLE_REDACTED]',
  },
  {
    field: 'phone_number',
    // 10+ digits, allowing +, spaces, dots, dashes, parentheses between them
    pattern: /[+(]?\d(?:[\s().-]{0,2}\d){9,14}\b/g,
    replacement: '[PHONE_REDACTED]',
  },
  {
    field: 'street_address',
    // House number + street keyword - English and Turkish vocabularies
    pattern:
      /\b\d+\s+(?:[A-Za-zÇĞİÖŞÜçğıöşü]+\s+){0,3}(?:street|st\.|ave(?:nue)?|boulevard|blvd|drive|dr\.|lane|road|rd\.)\b|\b(?:[A-Za-zÇĞİÖŞÜçğıöşü]+\s+){1,3}(?:sokak|sok\.|sokağı|cadde|cad\.|caddesi|mahalle(?:si)?|mah\.|bulvarı?|apartmanı?|apt\.)(?:\s*no\s*[:.]?\s*\d+(?:\/\d+)?)?/gi,
    replacement: '[ADDRESS_REDACTED]',
  },
];

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Detects and masks all PII in `text`. Never throws; non-string input is
 * coerced to an empty result.
 */
export function maskPii(text: string): MaskResult {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      maskedText: typeof text === 'string' ? text : '',
      hasPii: false,
      detectedFields: [],
      matches: [],
      flagForReview: false,
    };
  }

  let masked = text;
  const matches: PiiMatch[] = [];

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    const found = masked.match(rule.pattern);
    if (!found || found.length === 0) continue;

    rule.pattern.lastIndex = 0;
    masked = masked.replace(rule.pattern, rule.replacement);
    matches.push({
      field: rule.field,
      replacement: rule.replacement.replace('$1', ''),
      count: found.length,
    });
  }

  return {
    maskedText: masked,
    hasPii: matches.length > 0,
    detectedFields: matches.map((m) => m.field),
    matches,
    flagForReview: matches.some((m) => m.field === 'payment_info'),
  };
}

/** Convenience: true when `text` contains any detectable PII. */
export function containsPii(text: string): boolean {
  return maskPii(text).hasPii;
}

/**
 * Spec §2.2 "Real name (against user profile)": masks occurrences of the
 * user's own stored display name (case-insensitive, whole word). Used to
 * stop users from de-anonymizing themselves. Name comparisons happen only
 * on-device; the name itself is never transmitted.
 */
export function maskOwnName(text: string, displayName: string): MaskResult {
  if (
    typeof text !== 'string' ||
    typeof displayName !== 'string' ||
    displayName.trim().length < 2
  ) {
    return {
      maskedText: typeof text === 'string' ? text : '',
      hasPii: false,
      detectedFields: [],
      matches: [],
      flagForReview: false,
    };
  }

  const escaped = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
  const found = text.match(re);

  if (!found) {
    return {
      maskedText: text,
      hasPii: false,
      detectedFields: [],
      matches: [],
      flagForReview: false,
    };
  }

  return {
    maskedText: text.replace(re, '[NAME_REDACTED]'),
    hasPii: true,
    detectedFields: [],
    matches: [],
    flagForReview: false,
  };
}

export default maskPii;
