// Masks phone-like digit runs before text is sent to Nuance: a 7+ digit run
// can end a call. Pure helper, no I/O.

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?!\d)/
// A digit run with phone separators (space . - parentheses), optional leading +.
const DIGIT_RUN = /\+?[\d(][\d\s.()-]*/g
const SPELLED_RUN =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.-]+(?:zero|one|two|three|four|five|six|seven|eight|nine)\b){6,}/gi

function maskDigits(run: string): string {
  const digits = run.replace(/\D/g, "")
  if (digits.length < 7) return run
  const phoneShaped =
    (digits.length === 10 && digits.startsWith("0")) ||
    (digits.length === 12 && digits.startsWith("233"))
  return phoneShaped ? `number ending ${digits.slice(-3)}` : "[number]"
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
  return normalised.replace(DIGIT_RUN, maskRun).replace(SPELLED_RUN, "[number]")
}

export function clampForAppend(text: string, max = 2000): string {
  const masked = maskForVoice(text)
  if (masked.length <= max) return masked
  const slice = masked.slice(0, max)
  const lastSpace = slice.search(/\s\S*$/)
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice
  return maskForVoice(cut).trimEnd()
}
