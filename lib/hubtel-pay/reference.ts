import { randomBytes } from "crypto"

// Surface/product words a Hubtel reference must never contain (owner rule). Only "afa" can actually occur in hex
// (a, f, a are hex digits), ~1 in 4,096 per position, so random draws that contain it are redrawn.
const FORBIDDEN = /wallet|data|bundle|airtime|sms|upgrade|shop|afa|bill|result|topup|dealer/i

/**
 * A new opaque Hubtel payment reference: 32 lowercase hex chars from crypto.randomBytes(16).
 * Owner rule: Hubtel references carry no surface or product word (never "WALLET-..." etc.).
 * The hubtel_payments.reference CHECK (migration 0151) enforces the same shape.
 */
export function newHubtelReference(): string {
  for (;;) {
    const ref = randomBytes(16).toString("hex")
    if (!FORBIDDEN.test(ref)) return ref
  }
}
