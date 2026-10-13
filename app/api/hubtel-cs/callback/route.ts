import { NextRequest, NextResponse } from "next/server"
import { clientIpFromForwardedFor, processCallback } from "@/lib/hubtel-cs/callback"
import { getHubtelCsRuntime } from "@/lib/hubtel-cs/runtime"

export const maxDuration = 30

/** Hubtel Commission Services final callback. Authenticated by the per-transaction HMAC in the URL. */
export async function POST(request: NextRequest) {
  const rt = getHubtelCsRuntime()
  const url = new URL(request.url)
  const out = await processCallback(
    {
      store: rt.store,
      secret: process.env.HUBTEL_CS_CALLBACK_SECRET ?? "",
      enforceIp: process.env.HUBTEL_CS_ENFORCE_CALLBACK_IP === "true",
      onTransition: rt.onTransition,
      onFloat: rt.onFloat,
    },
    {
      ref: url.searchParams.get("ref"),
      sig: url.searchParams.get("sig"),
      ip: clientIpFromForwardedFor(request.headers.get("x-forwarded-for")),
      rawBody: await request.text(),
    }
  )
  return NextResponse.json(out.body, { status: out.status })
}
