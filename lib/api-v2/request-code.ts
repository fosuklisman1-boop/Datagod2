import { randomInt as cryptoRandomInt } from "node:crypto"

// No 0, O, 1, I or L, so a code read aloud or typed from a screenshot is unambiguous.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

/** "API-" + 6 characters from a cryptographic source. `randomInt(max)` returns an integer in [0, max). */
export function newRequestCode(randomInt: (max: number) => number = (max) => cryptoRandomInt(max)): string {
  let out = ""
  for (let i = 0; i < 6; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return "API-" + out
}
