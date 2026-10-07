import { createClient } from "@supabase/supabase-js"
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  // A rate-limited admin comes back with isAdmin true AND a 429 errorResponse: honour it.
  if (!isAdmin || errorResponse) return errorResponse ?? NextResponse.json({ error: "Admin access required" }, { status: 403 })
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const [recent, attention, review, cbPending, cbFailed, awaiting] = await Promise.all([
      supabase.from("hubtel_transactions").select("*").order("created_at", { ascending: false }).limit(50),
      // Rows a human must work are always listed, however old (capped).
      supabase.from("hubtel_transactions").select("*")
        .or("state.eq.needs_review,callback_status.eq.failed")
        .order("created_at", { ascending: false }).limit(200),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "needs_review"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "pending"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("callback_status", "failed"),
      supabase.from("hubtel_transactions").select("session_id", { count: "exact", head: true }).eq("state", "awaiting_payment"),
    ])
    for (const [name, r] of [["needs_review", review], ["callback_pending", cbPending], ["callback_failed", cbFailed], ["awaiting_payment", awaiting]] as const) {
      if (r.error) console.error(`[HUBTEL-ADMIN] count query failed (${name}):`, r.error)
    }
    if (recent.error || attention.error) {
      console.error("[HUBTEL-ADMIN] transactions query failed:", recent.error ?? attention.error)
      return NextResponse.json({ error: "Failed to load transactions" }, { status: 500 })
    }
    // Union, deduped by session_id, newest first.
    const bySession = new Map<string, { session_id: string; created_at: string }>()
    for (const row of [...(attention.data ?? []), ...(recent.data ?? [])]) bySession.set(row.session_id, row)
    const transactions = [...bySession.values()].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    return NextResponse.json({
      transactions,
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
