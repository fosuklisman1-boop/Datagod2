// app/api/cron/wa-delivery-notify/route.ts
//
// Drains wa_delivery_outbox and sends warm purchasers a "your data has been
// delivered" WhatsApp confirmation. The outbox is filled by AFTER UPDATE
// triggers on the order tables (20260615_wa_delivery_outbox.sql), so this runs
// fully out-of-band from fulfillment.
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { drainDeliveryNotifications } from "@/lib/wa-delivery-notify"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const result = await drainDeliveryNotifications(supabase)
    if (result.claimed > 0) {
      console.log(
        `[CRON-WA-DELIVERY] claimed=${result.claimed} sent=${result.sent} cold=${result.skippedCold} skipped=${result.skipped} failed=${result.failed}`
      )
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error("[CRON-WA-DELIVERY] Unexpected error:", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
