import { after, NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { getClientIp, isHubtelFulfillmentIp, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { parseFulfillmentPayload, processFulfillment } from "@/lib/ussd-hubtel/payment"
import { createSupabaseTxStore } from "@/lib/ussd-hubtel/tx-store"
import { createOrderHandlers } from "@/lib/ussd-hubtel/order-handlers"
import { dispatchCallback } from "@/lib/ussd-hubtel/callbacks"
import { sendFulfillmentCallback } from "@/lib/ussd-hubtel/relay"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import {
  inboundOk, logHubtelCallback, withOutboundLogging, type CallbackLogEntry, type InboundLogOutcome,
} from "@/lib/ussd-hubtel/callback-log"

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

  // Callback log (best-effort, after the response): only authenticated requests reach this point.
  // Stores the body as received; never the URL/query string (secret) or headers.
  const sourceIp = getClientIp(request.headers)
  const logInbound = (entry: Omit<CallbackLogEntry, "direction" | "sourceIp" | "ok"> & { outcome: InboundLogOutcome }) => {
    try {
      after(() => logHubtelCallback(supabase, { direction: "inbound_fulfillment", sourceIp, ok: inboundOk(entry.outcome), ...entry }))
    } catch (e) { console.error("[HUBTEL-FULFILL] could not schedule callback log:", safeDbError(e)) }
  }

  let raw = ""
  let body: unknown
  try {
    raw = await request.text()
    body = JSON.parse(raw)
  } catch {
    logInbound({ outcome: "parse_error", rawBody: raw })
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }
  const ids = body && typeof body === "object" ? (body as { SessionId?: unknown; OrderId?: unknown }) : {}
  const sessionId = typeof ids.SessionId === "string" ? ids.SessionId : null
  const hubtelOrderId = typeof ids.OrderId === "string" ? ids.OrderId : null
  const info = parseFulfillmentPayload(body)
  if (!info) {
    logInbound({ outcome: "invalid_payload", sessionId, hubtelOrderId, payload: body })
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const store = createSupabaseTxStore(supabase)
  let outcome: Awaited<ReturnType<typeof processFulfillment>>
  try {
    outcome = await processFulfillment(store, createOrderHandlers(supabase), info)
  } catch (e) {
    // Behaviour unchanged (the error propagates); only the log entry is added.
    logInbound({ outcome: "error", sessionId, hubtelOrderId, payload: body, error: e instanceof Error ? e.message : String(e) })
    throw e
  }
  logInbound({ outcome, sessionId, hubtelOrderId, payload: body })
  if (outcome === "unknown_session" && info.isSuccessful) {
    // Money was taken for a session we have no record of: needs a human (refund or fulfil).
    console.error("[HUBTEL-FULFILL] successful payment for UNKNOWN session (no hubtel_transactions row):", JSON.stringify({
      session_id: info.sessionId, hubtel_order_id: info.hubtelOrderId,
      amount_paid: info.amountPaid, amount_after_charges: info.amountAfterCharges,
    }))
  } else {
    console.log("[HUBTEL-FULFILL]", info.sessionId, "→", outcome)
  }

  if (outcome === "fulfilled" || outcome === "needs_review") {
    // Immediate attempt; the callbacks cron retries if this fails.
    after(async () => {
      try { await dispatchCallback(store, withOutboundLogging(sendFulfillmentCallback, supabase), info.sessionId) }
      catch (e) { console.error("[HUBTEL-FULFILL] immediate callback error:", safeDbError(e)) }
    })
  }
  // Always 200 for handled/duplicate/unknown so Hubtel does not hammer retries.
  return NextResponse.json({ received: true, outcome })
}
