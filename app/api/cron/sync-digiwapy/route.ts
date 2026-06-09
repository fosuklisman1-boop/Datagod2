// app/api/cron/sync-digiwapy/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { fetchDigiWapyTransactionStatus, isDigiWapyConfigured } from "@/lib/digiwapy-provider"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

function extractDgwRef(notes: string | null): string | null {
  if (!notes) return null
  const match = notes.match(/\[dgwRef:([^\]]+)\]/)
  return match ? match[1] : null
}

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  if (!isDigiWapyConfigured()) {
    return NextResponse.json({ skipped: true, reason: "Digiwapy not configured" })
  }

  try {
    const { data: orders, error } = await supabase
      .from("airtime_orders")
      .select("id, reference_code, notes, status")
      .eq("status", "processing")
      .ilike("notes", "%Digiwapy%")

    if (error) {
      console.error("[CRON-DIGIWAPY] DB error:", error)
      return NextResponse.json({ error: "Database error" }, { status: 500 })
    }

    if (!orders || orders.length === 0) {
      return NextResponse.json({ total: 0, updated: 0 })
    }

    let updated = 0

    await Promise.allSettled(
      orders.map(async (order) => {
        const dgwRef = extractDgwRef(order.notes)
        const pollRef = dgwRef ?? order.reference_code
        console.log(`[CRON-DIGIWAPY] Polling ${order.reference_code} with ref: ${pollRef}`)

        let txn = await fetchDigiWapyTransactionStatus(pollRef)

        // If Digiwapy ref didn't work, fall back to our own reference
        if (!txn && dgwRef) {
          txn = await fetchDigiWapyTransactionStatus(order.reference_code)
        }

        if (!txn) return

        const newStatus =
          txn.status === "completed" ? "completed" :
          txn.status === "failed"    ? "pending"   :
          null

        if (!newStatus) return

        const isFailed = txn.status === "failed"
        const newNotes = isFailed
          ? "Digiwapy reported failed — retryable"
          : "Completed via Digiwapy"

        const { data: updatedOrder } = await supabase
          .from("airtime_orders")
          .update({ status: newStatus, notes: newNotes, updated_at: new Date().toISOString() })
          .eq("id", order.id)
          .select("user_id, network, beneficiary_phone, airtime_amount")
          .single()

        // Send in-app + push notification on completion
        if (updatedOrder?.user_id && !isFailed) {
          const pushTitle = "Airtime Delivered Successfully"
          const pushBody = `Your ₵${updatedOrder.airtime_amount} ${updatedOrder.network} airtime to ${updatedOrder.beneficiary_phone} has been delivered.`

          await supabase.from("notifications").insert({
            user_id: updatedOrder.user_id,
            title: pushTitle,
            message: pushBody,
            type: "order_completed",
            reference_id: order.id,
            action_url: "/dashboard/airtime",
            read: false,
          }).then(({ error }) => {
            if (error) console.error(`[CRON-DIGIWAPY] ⚠️ Failed to send notification for ${order.reference_code}:`, error)
            else console.log(`[CRON-DIGIWAPY] 🔔 Notification sent to user ${updatedOrder.user_id} for ${order.reference_code}`)
          })

          sendPushToUser(updatedOrder.user_id, {
            title: pushTitle,
            body: pushBody,
            data: { url: "/dashboard/airtime" },
          }).catch(() => {})
        }

        updated++
        console.log(`[CRON-DIGIWAPY] Order ${order.reference_code}: processing → ${newStatus}`)
      })
    )

    console.log(`[CRON-DIGIWAPY] Synced ${updated}/${orders.length} orders`)
    return NextResponse.json({ total: orders.length, updated })
  } catch (err) {
    console.error("[CRON-DIGIWAPY] Unexpected error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
