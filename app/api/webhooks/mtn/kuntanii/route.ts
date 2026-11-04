import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import {
  extractExternalOrderId,
  signatureHeaderSnapshot,
  processKuntaniiWebhook,
  isBodyTooLarge,
  resolveWebhookEvent,
  verifyKuntaniiSignature,
} from "@/lib/mtn-providers/kuntanii-webhook-processor"

// Signal-only webhook: the body is never trusted. We only extract the order id
// and re-fetch status through our own authenticated API call.
export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const headerEvent = request.headers.get("x-kuntanii-event")

  console.log(
    "[WEBHOOK-KUNTANII] received",
    JSON.stringify({
      event: headerEvent ? headerEvent.slice(0, 64) : null,
      delivery: request.headers.get("x-kuntanii-delivery"),
      headers: signatureHeaderSnapshot(request.headers),
      bodyLength: Buffer.byteLength(rawBody, "utf8"),
    })
  )

  // LOG ONLY: observe whether real deliveries verify. Behavior is unchanged either way.
  const sigResult = verifyKuntaniiSignature(
    rawBody,
    request.headers.get("x-kuntanii-signature"),
    process.env.KUNTANII_WEBHOOK_SECRET,
  )
  console.log(`[WEBHOOK-KUNTANII] signature ${sigResult} delivery=${request.headers.get("x-kuntanii-delivery")}`)

  if (isBodyTooLarge(rawBody)) {
    console.warn("[WEBHOOK-KUNTANII] Body too large, not processing")
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

  const event = resolveWebhookEvent(headerEvent, payload)

  // after() keeps the function alive until processing finishes (see the
  // agentportalgh route for why fire-and-forget is unsafe on Vercel).
  after(() => processKuntaniiWebhook({ externalOrderId, event }))
  return NextResponse.json({ received: true })
}
