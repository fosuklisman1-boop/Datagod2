import { after, NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getClientIp, isHubtelFulfillmentIp, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { parseFulfillmentPayload, processFulfillment } from "@/lib/ussd-hubtel/payment"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Hubtel Service Fulfilment URL: https://<domain>/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>
export async function POST(request: NextRequest) {
  const expected = process.env.HUBTEL_WEBHOOK_SECRET
  if (!expected) return NextResponse.json({ error: "Service not configured" }, { status: 503 })
  const provided = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-hubtel-secret")
  if (!secretsMatch(provided, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (process.env.HUBTEL_ENFORCE_FULFILLMENT_IP === "true" && !isHubtelFulfillmentIp(getClientIp(request.headers))) {
    console.warn("[HUBTEL-FULFILL] Rejected: source IP not in Hubtel allowlist:", getClientIp(request.headers))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const info = parseFulfillmentPayload(body)
  if (!info) return NextResponse.json({ error: "Invalid payload" }, { status: 400 })

  const store = createSupabaseTxStore(supabase)
  const outcome = await processFulfillment(store, createOrderHandlers(supabase), info)
  console.log("[HUBTEL-FULFILL]", info.sessionId, "→", outcome)

  if (outcome === "fulfilled" || outcome === "needs_review") {
    // Immediate attempt; the callbacks cron retries if this fails.
    after(async () => {
      try { await dispatchCallback(store, sendFulfillmentCallback, info.sessionId) }
      catch (e) { console.error("[HUBTEL-FULFILL] immediate callback error:", e) }
    })
  }
  // Always 200 for handled/duplicate/unknown so Hubtel does not hammer retries.
  return NextResponse.json({ received: true, outcome })
}
