/**
 * Sender-ID name rules (spec §5.7). Hubtel passes any sender through, so these rules are
 * our only impersonation safeguard. Global uniqueness of ACTIVE names is enforced by the
 * DB (uq_sms_sender_ids_active_name) and checked in sender-rules-service.
 */
export const SENDER_NAME_MIN = 3
export const SENDER_NAME_MAX = 11

export type SenderNameCheck = { ok: true; name: string } | { ok: false; reason: string }

export function normalizeSenderName(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toUpperCase()
}

const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase()

/** Protected names of 3 chars or fewer match a whole word only (so "GRACE" ≠ "GRA");
 *  longer ones match anywhere, ignoring spaces ("MY MTN" ≠ ok, "TELE CEL" ≠ ok). */
function protectedHit(name: string, protectedNames: string[]): string | null {
  const flat = squash(name)
  const words = name.split(" ")
  for (const p of protectedNames) {
    const pf = squash(p)
    if (!pf) continue
    if (pf.length <= 3 ? words.includes(pf) || flat === pf : flat.includes(pf)) return p
  }
  return null
}

export function validateSenderName(raw: string, protectedNames: string[]): SenderNameCheck {
  const name = normalizeSenderName(raw)
  if (name.length < SENDER_NAME_MIN || name.length > SENDER_NAME_MAX) {
    return { ok: false, reason: `Sender ID must be ${SENDER_NAME_MIN}–${SENDER_NAME_MAX} characters.` }
  }
  if (!/^[A-Z0-9 ]+$/.test(name)) return { ok: false, reason: "Use letters, numbers and spaces only." }
  if (!/[A-Z]/.test(name)) return { ok: false, reason: "Sender ID must contain at least one letter." }
  const hit = protectedHit(name, protectedNames)
  if (hit) {
    return {
      ok: false,
      reason: `"${name}" contains a protected name (${hit}). Pick a name that doesn't imitate a bank, telco, government body or DATAGOD.`,
    }
  }
  return { ok: true, name }
}
