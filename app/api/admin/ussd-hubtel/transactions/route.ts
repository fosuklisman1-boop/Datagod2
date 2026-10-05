import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const [recent, review, cbPending, cbFailed, awaiting] = await Promise.all([
      supabase.from("hubtel_transactions").select("*").order("created_at", { ascending: false }).limit(50),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "needs_review"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "pending"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "failed"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "awaiting_payment"),
    ])
    for (const [name, r] of [["needs_review", review], ["callback_pending", cbPending], ["callback_failed", cbFailed], ["awaiting_payment", awaiting]] as const) {
      if (r.error) console.error(`[HUBTEL-ADMIN] count query failed (${name}):`, r.error)
    }
    if (recent.error) {
      console.error("[HUBTEL-ADMIN] transactions query failed:", recent.error)
      return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
    }
    return NextResponse.json({
      transactions: recent.data ?? [],
      counts: {
        needs_review: review.count ?? 0, callback_pending: cbPending.count ?? 0,
        callback_failed: cbFailed.count ?? 0, awaiting_payment: awaiting.count ?? 0,
      },
    })
  } catch (e) {
    console.error("[HUBTEL-ADMIN] transactions GET error:", e)
    return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
  }
}
