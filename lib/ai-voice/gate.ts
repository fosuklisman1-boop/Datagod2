import { createHash } from "node:crypto"
import type { VoiceAudience, VoiceSettings } from "./settings"

export interface CallCounts {
  mineToday: number
  visitorsToday: number
}

export function checkCallCaps(
  a: VoiceAudience,
  s: VoiceSettings,
  c: CallCounts,
): { ok: true } | { ok: false; reason: "daily_cap" | "visitor_cap" } {
  if (a === "admin") return { ok: true }
  if (c.mineToday >= s.dailyCalls[a]) return { ok: false, reason: "daily_cap" }
  if ((a === "public" || a === "storefront") && c.visitorsToday >= s.visitorDailyTotal) {
    return { ok: false, reason: "visitor_cap" }
  }
  return { ok: true }
}

/** Nuance end_user_id: letters, digits, _ . : - (max 128). Signed-in -> u_<id>; visitor -> d_<hash>. */
export function endUserIdFor(userId: string | null, deviceId: string | null, salt: string): string {
  if (userId) {
    const clean = userId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 126)
    if (clean) return `u_${clean}`
  }
  const hash = createHash("sha256").update(`${deviceId ?? ""}${salt}`).digest("hex").slice(0, 32)
  return `d_${hash}`
}
