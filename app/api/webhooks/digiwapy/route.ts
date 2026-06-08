// app/api/webhooks/digiwapy/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyDigiWapyWebhookSignature } from "@/lib/digiwapy-provider"

// Digiwapy event → our airtime_orders.status
// transaction.failed → "pending" so admin can retry via the Auto Fulfill button
const EVENT_STATUS_MAP: Record<string, string> = {
  "transaction.completed": "completed",
  "transaction.failed":    "pending",
  "transaction.pending":   "processing",
}

export async function POST(request: NextRequest) {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Signature is over JSON.stringify(parsedPayload) — matches Digiwapy's signing logic
  const signature = request.headers.get("x-webhook-signature") ?? ""
  if (!verifyDigiWapyWebhookSignature(payload, signature)) {
    console.warn("[DIGIWAPY-WEBHOOK] Invalid or missing signature")
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  const { event, data } = payload

  // Only act on transaction events that have a reference
  const newStatus = EVENT_STATUS_MAP[event]
  if (!newStatus || !data?.reference) {
    // wallet.credited / wallet.debited or unknown — ack and ignore
    return NextResponse.json({ received: true })
  }

  const { error } = await supabase
    .from("airtime_orders")
    .update({
      status: newStatus,
      notes: `Digiwapy: ${event}`,
      updated_at: new Date().toISOString(),
    })
    .eq("reference_code", data.reference)

  if (error) {
    console.error("[DIGIWAPY-WEBHOOK] DB update error:", error)
    // Return 200 so Digiwapy doesn't retry — log the error for investigation
  }

  return NextResponse.json({ received: true })
}
