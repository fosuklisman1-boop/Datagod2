import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { logSecurityEvent } from "@/lib/security-log"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Phone-verification reset (admin).
 *
 * "OTP-verified" now lives solely in phone_otp_verifications (used=true) — the
 * order/charge gates check that and nothing else. Clearing those rows un-verifies
 * every number (including any the attacker verified); returning customers simply
 * re-verify their payment number once on their next order. The per-phone check is
 * uncached, so the reset is effective immediately.
 *
 *   GET  → { verified } current count of used=true rows
 *   POST { all?: boolean }
 *        → default: delete used=true (keeps in-flight, not-yet-used codes)
 *        → all=true: delete everything (also clears pending codes)
 */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { count, error } = await supabase
      .from("phone_otp_verifications")
      .select("id", { count: "exact", head: true })
      .eq("used", true)
    if (error) throw error
    return NextResponse.json({ success: true, verified: count ?? 0 })
  } catch (e) {
    console.error("[PHONE-VERIF-RESET] GET error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, userId, userEmail, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const body = await request.json().catch(() => ({}))
    const all = body?.all === true

    // Supabase requires a filter on delete; for "all" use an always-true one.
    const { count, error } = all
      ? await supabase.from("phone_otp_verifications").delete({ count: "exact" }).not("id", "is", null)
      : await supabase.from("phone_otp_verifications").delete({ count: "exact" }).eq("used", true)
    if (error) throw error

    logSecurityEvent("phone_verifications_reset", {
      mode: all ? "all" : "verified",
      deleted: count ?? 0,
      by: userEmail ?? userId,
    })
    console.warn(`[PHONE-VERIF-RESET] ⚠️ ${count ?? 0} phone verification(s) cleared (mode=${all ? "all" : "verified"}) by ${userEmail ?? userId}`)
    return NextResponse.json({ success: true, deleted: count ?? 0, mode: all ? "all" : "verified" })
  } catch (e) {
    console.error("[PHONE-VERIF-RESET] POST error:", e)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
