import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { defaultReviewDeps, fulfilPayment, listReview, markPaymentFailed, recheckPayment } from "@/lib/hubtel-pay/review"

// Fulfil awaits a relay status check and the shared charge handler.
export const maxDuration = 60

/** GET /api/admin/gateway/hubtel-payments -> needs_review and stale confirming Hubtel payments. */
export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  try {
    const items = await listReview(await defaultReviewDeps(supabaseAdmin))
    return NextResponse.json({ success: true, items })
  } catch (e) {
    console.error("[ADMIN-HUBTEL-REVIEW] list failed:", e instanceof Error ? e.message : "unknown error")
    return NextResponse.json({ error: "Could not load Hubtel payments" }, { status: 500 })
  }
}

const ACTIONS = { recheck: recheckPayment, fulfil: fulfilPayment, mark_failed: markPaymentFailed } as const

/** POST { action: "recheck" | "fulfil" | "mark_failed", reference } */
export async function POST(request: NextRequest) {
  const { isAdmin, userId, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse
  // Every action is logged with the admin's id, so a request without one (the cron secret) can't act on money.
  if (!userId) return NextResponse.json({ error: "An admin account is required" }, { status: 403 })

  let body: { action?: unknown; reference?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const action = typeof body?.action === "string" && Object.hasOwn(ACTIONS, body.action) ? (body.action as keyof typeof ACTIONS) : null
  if (!action || typeof body.reference !== "string") return NextResponse.json({ error: "Unknown action" }, { status: 400 })

  try {
    const result = await ACTIONS[action](await defaultReviewDeps(supabaseAdmin), body.reference, userId)
    // Best effort audit row; never blocks the answer.
    supabaseAdmin.from("admin_audit_log").insert([{
      admin_id: userId, action: `hubtel_payment_${action}`, target_user_id: null,
      old_value: { reference: body.reference }, new_value: { ok: result.ok, message: result.message.slice(0, 200) },
      created_at: new Date().toISOString(),
    }]).then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn("[ADMIN-HUBTEL-REVIEW] audit insert failed:", error.message)
    }, () => {})
    if (!result.ok) return NextResponse.json({ error: result.message, check: result.check ?? null }, { status: result.status })
    return NextResponse.json({ success: true, message: result.message, check: result.check ?? null })
  } catch (e) {
    console.error(`[ADMIN-HUBTEL-REVIEW] ${action} failed:`, e instanceof Error ? e.message : "unknown error")
    return NextResponse.json({ error: "Something went wrong. Refresh and check the payment before trying again." }, { status: 500 })
  }
}
