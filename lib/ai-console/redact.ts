// Redaction for stored AI chat transcripts. Pure. Applied to every message before it is written.
//
// Order matters: fences and card notes are removed first (they can carry nonces / tool output), then emails, then
// phones (international before local), then any remaining run of 6+ digits (card / MoMo / account / order numbers).
// Order codes keep their prefix and lose the digits: "ORD-1732456789" -> "ORD-[number]". The digits are what make an
// order code identifying, and the support team can still search orders from the user and time of the conversation.

export const MAX_TRANSCRIPT_CHARS = 4000

const CARD_RESULTS = /<card_results\b[\s\S]*?(?:<\/card_results>|$)/gi
const DATA_FENCE = /<data\b[^>]*>[\s\S]*?(?:<\/data>|$)/gi
const CARD_NOTE = /\[card\b[^\]\n]*\]?/gi
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g
// +233 / 233 / 00233, then 9 digits (optional spaces or dashes between groups)
const PHONE_INTL = /(?<![\d])(?:\+|00)?233[ -]?\d{2}[ -]?\d{3}[ -]?\d{4}(?![\d])/g
// 0 + 9 digits
const PHONE_LOCAL = /(?<![\d])0\d{2}[ -]?\d{3}[ -]?\d{4}(?![\d])/g
// 16-digit style card numbers written in groups
const GROUPED_NUMBER = /(?<![\d])\d{4}(?:[ -]\d{4}){3,}(?![\d])/g
const LONG_DIGITS = /\d{6,}/g

export function redactTranscriptText(input: string): string {
  let s = String(input ?? "")
  s = s.replace(CARD_RESULTS, "").replace(DATA_FENCE, "").replace(CARD_NOTE, "")
  s = s.replace(EMAIL, "[email]")
  s = s.replace(PHONE_INTL, "[phone]").replace(PHONE_LOCAL, "[phone]")
  s = s.replace(GROUPED_NUMBER, "[number]").replace(LONG_DIGITS, "[number]")
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return s.slice(0, MAX_TRANSCRIPT_CHARS)
}
