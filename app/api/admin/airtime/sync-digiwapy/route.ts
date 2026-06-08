// app/api/admin/airtime/sync-digiwapy/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { fetchDigiWapyTransactionStatus, isDigiWapyConfigured } from "@/lib/digiwapy-provider"

/** Extract [dgwRef:XXX] stored in notes when the airtime was sent */
function extractDgwRef(notes: string | null): string | null {
  if (!notes) return null
  const match = notes.match(/\[dgwRef:([^\]]+)\]/)
  return match ? match[1] : null
}

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
    .select("id, reference_code, notes, status")
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
      // Prefer the Digiwapy-assigned reference stored in notes; fall back to ours
      const dgwRef = extractDgwRef(order.notes)
      const pollRef = dgwRef ?? order.reference_code
      console.log(`[SYNC-DIGIWAPY] Polling order ${order.reference_code} with ref: ${pollRef}`)

      const txn = await fetchDigiWapyTransactionStatus(pollRef)
      if (!txn) {
        // If Digiwapy ref failed and we haven't tried our own ref yet, try it as fallback
        if (dgwRef) {
          const fallback = await fetchDigiWapyTransactionStatus(order.reference_code)
          if (!fallback) {
            return { id: order.id, reference: order.reference_code, skipped: true, reason: "no response from either ref" }
          }
          return processStatus(supabase, order, fallback, updated, (n) => { updated = n })
        }
        return { id: order.id, reference: order.reference_code, skipped: true, reason: "no response" }
      }

      return processStatus(supabase, order, txn, updated, (n) => { updated = n })
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

async function processStatus(
  supabase: any,
  order: { id: string; reference_code: string },
  txn: { status: string },
  currentCount: number,
  setCount: (n: number) => void
) {
  const newStatus =
    txn.status === "completed" ? "completed" :
    txn.status === "failed"    ? "pending"   :
    null

  if (!newStatus) {
    return { id: order.id, reference: order.reference_code, skipped: true, reason: `still in progress (${txn.status})` }
  }

  const newNotes =
    txn.status === "completed"
      ? "Completed via Digiwapy"
      : "Digiwapy reported failed — retryable"

  await supabase
    .from("airtime_orders")
    .update({ status: newStatus, notes: newNotes, updated_at: new Date().toISOString() })
    .eq("id", order.id)

  setCount(currentCount + 1)
  return { id: order.id, reference: order.reference_code, newStatus }
}
