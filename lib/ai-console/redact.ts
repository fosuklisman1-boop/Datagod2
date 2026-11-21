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
// Any digit run with single [ .-] separators and optional ( ) groups, e.g. "(024) 123 4567", "+233 (0)24 123 4567".
// Not started after a word character or hyphen, so "ORD-1732456789" is left for the long-digit rule (prefix kept).
const DIGIT_RUN = /(?<![\w-])\+?\(?\d+\)?\d*(?:[ .-]\(?\d+\)?\d*)*(?![\d])/g
// A PIN / OTP / code / password word followed (within a few non-digit chars) by 4-6 digits.
const OTP_AFTER_KEYWORD = /\b(pin|otp|code|password)\b([^\d\n]{0,15})\d{4,6}(?!\d)/gi

/** Ghana numbers have 9 digits after the country/trunk prefix: 9-12 digits in total once "00" and "(0)" are dropped. */
function digitRunToken(m: string): string {
  let digits = m.replace(/\(0\)/, "").replace(/\D/g, "")
  if (digits.startsWith("00233")) digits = digits.slice(2)
  return digits.length >= 9 && digits.length <= 12 ? "[phone]" : m
}
// 16-digit style card numbers written in groups
const GROUPED_NUMBER = /(?<![\d])\d{4}(?:[ -]\d{4}){3,}(?![\d])/g
const LONG_DIGITS = /\d{6,}/g

export function redactTranscriptText(input: string): string {
  let s = String(input ?? "")
  s = s.replace(CARD_RESULTS, "").replace(DATA_FENCE, "").replace(CARD_NOTE, "")
  s = s.replace(EMAIL, "[email]")
  s = s.replace(OTP_AFTER_KEYWORD, "$1$2[number]")
  s = s.replace(DIGIT_RUN, digitRunToken)
  s = s.replace(GROUPED_NUMBER, "[number]").replace(LONG_DIGITS, "[number]")
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return s.slice(0, MAX_TRANSCRIPT_CHARS)
}
