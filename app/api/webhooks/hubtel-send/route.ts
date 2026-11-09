import { NextRequest, NextResponse } from "next/server"
import { refundDb } from "@/lib/refunds/http"
import { defaultDeps, type StoredRefund } from "@/lib/refunds/service"
import { handleHubtelSendCallback } from "@/lib/refunds/hubtel-send-callback"

// Hubtel Send Money callback (URL built by hubtelSendCallbackUrl in lib/refunds/hubtel-send-client.ts:
// ?ref=<32 hex>&sig=<HMAC>). Lives under /api/webhooks/, which the Vercel firewall lets through. The body is never
// read: a valid callback only triggers Hubtel's status check, and that check decides the refund.
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const db = refundDb()
  const result = await handleHubtelSendCallback(defaultDeps(db), {
    ref: request.nextUrl.searchParams.get("ref"),
    sig: request.nextUrl.searchParams.get("sig"),
    secret: process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET,
    async loadRefund(id) {
      const { data, error } = await db.from("order_refunds").select("*").eq("id", id).maybeSingle()
      if (error) throw new Error("refund load failed")
      return (data as StoredRefund | null) ?? null
    },
  })
  return NextResponse.json(result.body, { status: result.status })
}
