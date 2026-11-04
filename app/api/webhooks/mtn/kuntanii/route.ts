import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import {
  extractExternalOrderId,
  signatureHeaderSnapshot,
  processKuntaniiWebhook,
} from "@/lib/mtn-providers/kuntanii-webhook-processor"

const MAX_BODY_CHARS = 65536

// Signal-only webhook: the body is never trusted. We only extract the order id
// and re-fetch status through our own authenticated API call.
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const event = request.headers.get("x-kuntanii-event")

  console.log(
    "[WEBHOOK-KUNTANII] received",
    JSON.stringify({
      event,
      delivery: request.headers.get("x-kuntanii-delivery"),
      headers: signatureHeaderSnapshot(request.headers),
      bodyLength: rawBody.length,
    })
  )

  if (rawBody.length > MAX_BODY_CHARS) {
    console.warn(`[WEBHOOK-KUNTANII] Body too large (${rawBody.length}), not processing`)
    return NextResponse.json({ received: true })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    console.warn("[WEBHOOK-KUNTANII] Invalid JSON body, not processing")
    return NextResponse.json({ received: true })
  }

  const externalOrderId = extractExternalOrderId(payload)
  if (!externalOrderId) {
    console.warn("[WEBHOOK-KUNTANII] Missing/invalid externalOrderId, not processing")
    return NextResponse.json({ received: true })
  }

  // after() keeps the function alive until processing finishes (see the
  // agentportalgh route for why fire-and-forget is unsafe on Vercel).
  after(() => processKuntaniiWebhook({ externalOrderId, event }))
  return NextResponse.json({ received: true })
}
