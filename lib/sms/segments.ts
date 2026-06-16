// GSM-7 basic character set (single-code-unit characters)
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./" +
  "0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZ ÄÖÑÜ`" +
  "¿abcdefghijklmnopqrstuvwxyz äöñüà"
)

// GSM-7 extension table characters (each costs 2 code units: ESC + char)
const GSM7_EXTENSION = new Set("|^€{}\\[~]")

export interface SegmentResult {
  encoding: "gsm7" | "unicode"
  /** Effective billing length (extension chars count as 2 for GSM-7; code points for unicode) */
  length: number
  segments: number
  remaining: number
  /** Max chars in a SINGLE (non-concatenated) message for this encoding */
  singleLimit: number
}

function isGsm7(message: string): boolean {
  for (const ch of message) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENSION.has(ch)) return false
  }
  return true
}

function gsm7Length(message: string): number {
  let len = 0
  for (const ch of message) {
    len += GSM7_EXTENSION.has(ch) ? 2 : 1
  }
  return len
}

export function calculateSegments(message: string): SegmentResult {
  if (isGsm7(message)) {
    const length = gsm7Length(message)
    const singleLimit = 160
    const multiLimit = 153
    const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit)
    const capacity = length <= singleLimit ? singleLimit : segments * multiLimit
    return { encoding: "gsm7", length, segments, remaining: capacity - length, singleLimit }
  }

  // UCS-2: count code points (so emoji = 1, not 2 UTF-16 code units)
  const length = [...message].length
  const singleLimit = 70
  const multiLimit = 67
  const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit)
  const capacity = length <= singleLimit ? singleLimit : segments * multiLimit
  return { encoding: "unicode", length, segments, remaining: capacity - length, singleLimit }
}

export function calculateCredits(message: string, recipients: number): number {
  return calculateSegments(message).segments * recipients
}
