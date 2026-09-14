import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { verifySig, processWebhook } from "@/lib/mtn-providers/bundleportal-webhook-processor"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()
  const sigHeader = request.headers.get("x-bundleportal-signature")
  const secret = process.env.BUNDLEPORTAL_WEBHOOK_SECRET

  if (!secret) {
    console.error("[WEBHOOK-BUNDLEPORTAL] BUNDLEPORTAL_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifySig(rawBody, sigHeader, secret)) {
    console.warn(
      "[WEBHOOK-BUNDLEPORTAL] Signature rejected.",
      `x-bundleportal-signature present: ${sigHeader !== null}`,
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

  // Respond immediately, but keep the function alive until processing
  // finishes via after() — a bare fire-and-forget call is not guaranteed to
  // complete (confirmed live 2026-07-26 on AgentPortalGH's webhook: Vercel
  // can freeze/terminate the function right after the response is sent,
  // silently dropping the update).
  after(() => processWebhook(payload))
  return NextResponse.json({ received: true })
}
