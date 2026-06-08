// app/api/admin/airtime/sync-digiwapy/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { fetchDigiWapyTransactionStatus, isDigiWapyConfigured } from "@/lib/digiwapy-provider"

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  if (!isDigiWapyConfigured()) {
    return NextResponse.json(
      { error: "Digiwapy not configured. Set DIGIWAPY_API_KEY and DIGIWAPY_PARTNER_CODE." },
      { status: 503 }
    )
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: orders, error } = await supabase
    .from("airtime_orders")
    .select("id, reference_code, status")
    .eq("status", "processing")
    .ilike("notes", "%Digiwapy%")

  if (error) {
    console.error("[SYNC-DIGIWAPY] DB error:", error)
    return NextResponse.json({ error: "Database error" }, { status: 500 })
  }

  if (!orders || orders.length === 0) {
    return NextResponse.json({ total: 0, updated: 0, message: "No processing Digiwapy orders found" })
  }

  let updated = 0

  const results = await Promise.allSettled(
    orders.map(async (order) => {
      const txn = await fetchDigiWapyTransactionStatus(order.reference_code)
      if (!txn) return { id: order.id, reference: order.reference_code, skipped: true, reason: "no response" }

      // Map Digiwapy status — failed stays "pending" so admin can retry
      const newStatus =
        txn.status === "completed" ? "completed" :
        txn.status === "failed"    ? "pending"   :
        null // still pending on Digiwapy side — no change

      if (!newStatus) {
        return { id: order.id, reference: order.reference_code, skipped: true, reason: "still in progress" }
      }

      const newNotes =
        txn.status === "completed"
          ? "Completed via Digiwapy"
          : "Digiwapy reported failed — retryable"

      await supabase
        .from("airtime_orders")
        .update({ status: newStatus, notes: newNotes, updated_at: new Date().toISOString() })
        .eq("id", order.id)

      updated++
      return { id: order.id, reference: order.reference_code, newStatus }
    })
  )

  console.log(`[SYNC-DIGIWAPY] Synced ${updated}/${orders.length} orders`)

  return NextResponse.json({
    total: orders.length,
    updated,
    results: results.map((r) =>
      r.status === "fulfilled"
        ? r.value
        : { error: String((r as PromiseRejectedResult).reason) }
    ),
  })
}
