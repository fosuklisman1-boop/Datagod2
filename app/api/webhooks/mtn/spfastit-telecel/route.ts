import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { verifyToken, processWebhook } from "@/lib/mtn-providers/spfastit-telecel-webhook-processor"

export async function POST(request: NextRequest) {
  const secret = process.env.SPFASTIT_TELECEL_WEBHOOK_SECRET
  const provided = request.nextUrl.searchParams.get("token")

  if (!secret) {
    console.error("[WEBHOOK-SPFASTIT-TELECEL] SPFASTIT_TELECEL_WEBHOOK_SECRET not set — rejecting all requests")
    return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 })
  }
  if (!verifyToken(provided, secret)) {
    console.warn("[WEBHOOK-SPFASTIT-TELECEL] Invalid or missing token")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let payload: any
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // after() keeps the function alive until processing finishes — a bare
  // fire-and-forget call is not guaranteed to complete on Vercel (confirmed
  // live 2026-07-26 on AgentPortalGH's webhook).
  after(() => processWebhook(payload))
  return NextResponse.json({ received: true })
}
