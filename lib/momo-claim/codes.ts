import { randomInt as cryptoRandomInt } from "crypto"

// No I, L, O (look like 1/0) in letters; no 0 or 1 in digits.
export const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ"
export const CODE_DIGITS = "23456789"

export function generateClaimCode(
  randomInt: (max: number) => number = (max) => cryptoRandomInt(max),
): string {
  let out = ""
  for (let i = 0; i < 3; i++) out += CODE_LETTERS[randomInt(CODE_LETTERS.length)]
  for (let i = 0; i < 4; i++) out += CODE_DIGITS[randomInt(CODE_DIGITS.length)]
  return out
}

const CANDIDATE_RE = new RegExp(
  `(?<![A-Z0-9])([${CODE_LETTERS}]{3})[ -]?([${CODE_DIGITS}]{4})(?![A-Z0-9])`,
  "g",
)

/** Finds claim-code candidates in free text, normalised to ABC1234, unique, in order. */
export function scanCodeCandidates(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.toUpperCase().matchAll(CANDIDATE_RE)) {
    seen.add(`${m[1]}${m[2]}`)
  }
  return [...seen]
}
