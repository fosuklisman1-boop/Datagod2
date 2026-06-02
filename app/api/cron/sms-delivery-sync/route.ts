import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { queryMoolreDeliveryStatus } from "@/lib/sms-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

/**
 * Resolve Moolre SMS delivery status.
 *
 * Moolre's send API returns no message ID (data:null) — only "accepted". We
 * attach a unique tracking ref to every send (stored on sms_logs.moolre_message_id),
 * and this cron asks Moolre /open/sms/query for the real outcome and writes it back:
 *   status 2 (Delivered) -> sms_logs.status = 'delivered' (+ delivered_at)
 *   status 3 (Failed)    -> 'failed'
 *   status 0/1 (Unknown / in-route) -> leave 'sent', retry next run
 *
 * Runs every few minutes (vercel.json). Auth via CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!

  try {
    // Recently-accepted Moolre messages not yet resolved. Look back 2h; skip the
    // last 30s so the message has had a moment to move through the telco.
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const until = new Date(Date.now() - 30 * 1000).toISOString()
    const { data: rows, error } = await supabase
      .from("sms_logs")
      .select("id, moolre_message_id")
      .eq("status", "sent")
      .not("moolre_message_id", "is", null)
      .gte("created_at", since)
      .lte("created_at", until)
      .limit(500)

    if (error) {
      console.error("[CRON-SMS-DLR] Fetch error:", error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Only our generated refs (dg-…) are queryable.
    const refToId = new Map<string, string>()
    for (const r of rows ?? []) {
      const ref = (r as any).moolre_message_id
      if (typeof ref === "string" && ref.startsWith("dg-")) refToId.set(ref, (r as any).id)
    }
    const refs = Array.from(refToId.keys())
    if (refs.length === 0) return NextResponse.json({ checked: 0, delivered: 0, failed: 0 })

    const deliveredIds: string[] = []
    const failedIds: string[] = []

    const BATCH = 100
    for (let i = 0; i < refs.length; i += BATCH) {
      const statuses = await queryMoolreDeliveryStatus(refs.slice(i, i + BATCH))
      for (const [ref, status] of Object.entries(statuses)) {
        const id = refToId.get(ref)
        if (!id) continue
        if (status === 2) deliveredIds.push(id)
        else if (status === 3) failedIds.push(id)
      }
    }

    if (deliveredIds.length) {
      await supabase
        .from("sms_logs")
        .update({ status: "delivered", delivered_at: new Date().toISOString() })
        .in("id", deliveredIds)
    }
    if (failedIds.length) {
      await supabase
        .from("sms_logs")
        .update({ status: "failed", error_message: "Moolre: delivery failed (DLR)" })
        .in("id", failedIds)
    }

    console.log(`[CRON-SMS-DLR] checked=${refs.length} delivered=${deliveredIds.length} failed=${failedIds.length}`)
    return NextResponse.json({ checked: refs.length, delivered: deliveredIds.length, failed: failedIds.length })
  } catch (e) {
    console.error("[CRON-SMS-DLR] Error:", e)
    return NextResponse.json({ error: "Internal error" }, { status: 500 })
  }
}
