import { NextRequest, NextResponse } from "next/server"
import { resolveHubtelReturn } from "@/lib/hubtel-pay/return"

// Hubtel hosted-checkout return and cancel URL (built by hubtelReturnUrl in lib/hubtel-pay/client.ts:
// ?ref=<32 hex>&sig=<HMAC of "return:"+ref>[&cancelled=1]). Confirms the payment best effort (5s at most), then
// redirects to the page stored on the payment row. Nothing in the query decides where the customer goes.
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams
  const out = await resolveHubtelReturn({ ref: q.get("ref"), sig: q.get("sig"), cancelled: q.get("cancelled") === "1" })
  if (out.kind === "bad_request") return NextResponse.json({ error: "bad request" }, { status: 400 })
  if (out.kind === "not_configured") {
    console.error("[HUBTEL-RETURN] HUBTEL_PAYMENTS_CALLBACK_SECRET is not configured (must be at least 32 chars)")
    return NextResponse.json({ error: "not configured" }, { status: 503 })
  }
  return NextResponse.redirect(out.url, 302)
}
