import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { createHubnetClient } from "@/lib/hubnet/client"
import { applyHubnetStatusChange } from "@/lib/hubnet/sync"
import { applyHubnetAirtimeStatus } from "@/lib/airtime-hubnet"
import {
  HUBNET_WEBHOOK_MAX_BYTES,
  extractHubnetRef,
  processHubnetWebhook,
  redactHubnetBody,
  tokenOk,
} from "@/lib/hubnet/webhook"

// Signal-only webhook: Hubnet callbacks are unsigned, so the body is never trusted.
// We only extract the reference and re-fetch status through our own authenticated call.
export async function POST(request: NextRequest) {
  const done = () => NextResponse.json({ received: true })

  if (!tokenOk(request.nextUrl.searchParams.get("t"))) {
    console.warn("[HUBNET-WEBHOOK] bad or missing token, ignoring")
    return done()
  }

  const rawBody = await request.text()
  const headerNames = Array.from(request.headers.keys()).join(",")
  const bytes = Buffer.byteLength(rawBody, "utf8")
  console.log(`[HUBNET-RAW] headers=${headerNames} bytes=${bytes} body=${redactHubnetBody(rawBody)}`)

  if (bytes > HUBNET_WEBHOOK_MAX_BYTES) {
    console.warn("[HUBNET-WEBHOOK] body too large, not processing")
    return done()
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    console.warn("[HUBNET-WEBHOOK] invalid JSON body, not processing")
    return done()
  }

  const ref = extractHubnetRef(payload)
  if (!ref) {
    console.warn("[HUBNET-WEBHOOK] missing/invalid reference, not processing")
    return done()
  }

  after(async () => {
    try {
      const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const result = await processHubnetWebhook(ref, {
        db,
        client: createHubnetClient(),
        applyData: applyHubnetStatusChange,
        applyAirtime: applyHubnetAirtimeStatus,
      })
      console.log(`[HUBNET-WEBHOOK] ${ref} => ${result}`)
    } catch (e: any) {
      console.error(`[WEBHOOK-HUBNET] processing failed: ${e?.message ?? e} ref=${ref}`)
    }
  })
  return done()
}
