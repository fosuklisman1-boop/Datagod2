// Masks phone-like digit runs before text is sent to Nuance: a 7+ digit run
// can end a call. Pure helper, no I/O.

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?!\d)/
// A digit run with phone separators (space . - parentheses), optional leading +.
// , : / _ only count as separators when sandwiched between digits, so list
// commas ("12, 13") and sentence punctuation do not join items.
const DIGIT_RUN = /\+?[\d(](?:[\d\s.()-]|(?<=\d)[,:/_](?=\d))*/g
// Thousands-style amounts ("1,250,000.50") are not phone numbers.
const AMOUNT = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/

// Digit tokens and spoken digit words are counted together as one stream.
const WORD = "(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine|double|triple)"
const TOKEN = `(?:\\d+|${WORD})`
const MIXED_STREAM = new RegExp(`(?<!\\w)${TOKEN}(?:[\\s,.-]+${TOKEN})*(?!\\w)`, "gi")

function maskMixedStream(match: string): string {
  const tokens = match.split(/[\s,.-]+/)
  let hasWord = false
  let count = 0
  for (const t of tokens) {
    if (/^\d+$/.test(t)) count += t.length
    else {
      hasWord = true
      count += 1
    }
  }
  // Pure-digit runs were already handled (and dates must be left alone).
  return hasWord && count >= 7 ? "[number]" : match
}

function maskDigits(run: string): string {
  if (AMOUNT.test(run)) return run
  const digits = run.replace(/\D/g, "")
  if (digits.length < 7) return run
  const phoneShaped =
    (digits.length === 10 && digits.startsWith("0")) ||
    (digits.length === 12 && digits.startsWith("233"))
  return phoneShaped ? `number ending ${digits.slice(-3)}` : "[number]"
}

// Digit groups joined by a SPACED separator ("024 / 123 / 4567", "024, 123, 4567"): the digit-run pass above
// only joins , / : _ when they touch digits, so a phone written this way slips through it.
const SPACED_GROUPS = /(?<!\d)\d+(?:[ \t]*[,/|:][ \t]*\d+)+(?!\d)/g
const GROUP_SEP = /[ \t]*[,/|:][ \t]*/

function maskSpacedGroups(match: string): string {
  if (AMOUNT.test(match)) return match // "1,250,000"
  const groups = match.split(GROUP_SEP)
  const digits = groups.join("")
  const phoneShaped =
    (digits.length === 10 && digits.startsWith("0")) ||
    (digits.length === 12 && digits.startsWith("233"))
  if (phoneShaped) return `number ending ${digits.slice(-3)}`
  // Short lists ("1, 2, 5, 10", "items 12, 13, 14, 15") stay; only streams of 3+ digit groups that add up to 7+ digits go.
  if (digits.length >= 7 && groups.every((g) => g.length >= 3)) return "[number]"
  return match
}

function maskRun(run: string): string {
  // Keep trailing separators (e.g. a sentence period) outside the masked part.
  const trimmed = run.replace(/[\s.()-]+$/, "")
  const tail = run.slice(trimmed.length)
  const date = DATE_PREFIX.exec(trimmed)
  if (date) {
    const rest = trimmed.slice(date[0].length)
    const lead = /^[\s.()-]*/.exec(rest)![0]
    return date[0] + lead + maskRun(rest.slice(lead.length)) + tail
  }
  return maskDigits(trimmed) + tail
}

export function maskForVoice(text: string): string {
  const normalised = text.normalize("NFKC").replace(/[‐-―−]/g, "-")
  return normalised.replace(DIGIT_RUN, maskRun).replace(SPACED_GROUPS, maskSpacedGroups).replace(MIXED_STREAM, maskMixedStream)
}

// Forces free-form text to plain printable ASCII English for Nuance.
export function toVoiceText(text: string): string {
  let s = text.normalize("NFKC")
  s = s
    .replace(/GH?[¢₵]/g, "GHS ")
    .replace(/[₵]/g, "GHS ")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/…/g, "...")
  s = s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\*\*|__/g, "")
  s = s.replace(/[^\x20-\x7E\r\n\t]/g, "")
  return s.replace(/\s+/g, " ").trim()
}

export function clampForAppend(text: string, max = 2000): string {
  const masked = maskForVoice(text)
  if (masked.length <= max) return masked
  const slice = masked.slice(0, max)
  const lastSpace = slice.search(/\s\S*$/)
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
  return maskForVoice(cut).trimEnd()
}
