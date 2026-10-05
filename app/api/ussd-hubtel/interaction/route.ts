import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { parseHubtelRequest, release, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { hubtelRouter, defaultRouterDeps } from "@/lib/ussd-hubtel/router"

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Hubtel Service Interaction URL: https://<domain>/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>
export async function POST(request: NextRequest) {
  const expected = process.env.HUBTEL_WEBHOOK_SECRET
  if (!expected) {
    console.error("[HUBTEL] HUBTEL_WEBHOOK_SECRET not set — failing closed")
    return NextResponse.json({ error: "Service not configured" }, { status: 503 })
  }
  const provided = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-hubtel-secret")
  if (!secretsMatch(provided, expected)) {
    console.warn("[HUBTEL] Rejected interaction request with invalid secret")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const req = parseHubtelRequest(body)
  if (!req) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  console.log("[HUBTEL] Incoming:", { sid: req.SessionId, type: req.Type, platform: req.Platform, seq: req.Sequence, input: req.Message })
  try {
    const reply = await hubtelRouter(req, defaultRouterDeps(supabase))
    console.log("[HUBTEL] Reply:", { type: reply.Type, msg: reply.Message.slice(0, 60) })
    return NextResponse.json(reply)
  } catch (e) {
    console.error("[HUBTEL] Router error:", e)
    // Always answer with a well-formed reply so the user sees our message, not Hubtel's UUE error.
    return NextResponse.json(release(req.SessionId, "Service unavailable. Please try again.", { platform: req.Platform }))
  }
}
