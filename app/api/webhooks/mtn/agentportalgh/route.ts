import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { verifySig, processItems } from "@/lib/mtn-providers/agentportalgh-webhook-processor"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sigHeader = request.headers.get("x-webhook-signature")
  const secret = process.env.AGENTPORTALGH_WEBHOOK_SECRET

  if (!secret) {
    console.error("[WEBHOOK-AGENTPORTALGH] AGENTPORTALGH_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifySig(rawBody, sigHeader, secret)) {
    // Log every header name received — if AgentPortalGH signs with a different
    // header or format than we expect, this is the only way to see it, since
    // no webhook_received_at ever gets stamped for a rejected delivery.
    console.warn(
      "[WEBHOOK-AGENTPORTALGH] Signature rejected.",
      `x-webhook-signature present: ${sigHeader !== null}`,
      `headers received: ${JSON.stringify([...request.headers.keys()])}`,
      `body preview: ${rawBody.slice(0, 200)}`
    )
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 })
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Respond immediately, but keep the function alive until processing finishes —
  // a bare fire-and-forget call here is not guaranteed to complete: Vercel can
  // freeze/terminate the function right after the response is sent, silently
  // dropping the update. Confirmed live 2026-07-26: AgentPortalGH's delivery log
  // showed 100% "Delivered (200)" while webhook_received_at never got set on a
  // single tracking row — the response was sent, but processItems() never ran
  // to completion.
  after(() => processItems(payload))
  return NextResponse.json({ received: true })
}
