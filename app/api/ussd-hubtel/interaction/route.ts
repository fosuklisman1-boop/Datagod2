import { NextRequest, NextResponse, after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { parseHubtelRequest, release, secretsMatch } from "@/lib/ussd-hubtel/protocol"
import { hubtelRouter, defaultRouterDeps } from "@/lib/ussd-hubtel/router"
import { getHubtelMainLineConfig } from "@/lib/ussd-hubtel/config"
import { parseHubtelLine } from "@/lib/ussd-hubtel/line"
import { safeDbError } from "@/lib/ussd-hubtel/log-safe"
import { logInteraction, shapeInteractionRow, trackSessionStore } from "@/lib/ussd-hubtel/interaction-log"
import type { HubtelReply } from "@/lib/ussd-hubtel/types"

// Wallet payments run delivery in after() (fulfillUssdOrder with the MTN retry sequence, vouchers, SMS). 300s stays under
// the wallet sweep's 10-minute window and lease (lib/ussd-hubtel/wallet-pay.ts), which rely on this route finishing first.
export const maxDuration = 300

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Hubtel Service Interaction URL: https://<domain>/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>
// The main code's URL adds `&line=main`, which selects that code's own settings. No `line` is the existing code.
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

  const line = parseHubtelLine(request.nextUrl.searchParams.getAll("line"))
  if (line === null) {
    // A misconfigured URL: refuse rather than guess a menu.
    console.warn("[HUBTEL] Refused interaction with an unrecognised line", { sid: req.SessionId })
    return NextResponse.json(release(req.SessionId, "Service unavailable. Please try again later.", { platform: req.Platform }))
  }

  console.log("[HUBTEL] Incoming:", { sid: req.SessionId, type: req.Type, platform: req.Platform, seq: req.Sequence, inputLen: req.Message.length, line })
  const receivedAt = new Date()
  const deps = {
    ...defaultRouterDeps(supabase),
    ...(line === "main" ? { getConfig: () => getHubtelMainLineConfig(supabase) } : {}),
    defer: (task: () => Promise<unknown>) => runAfterResponse(async () => { await task() }),
  }
  const tracked = trackSessionStore(deps.sessions)
  let reply: HubtelReply
  try {
    reply = await hubtelRouter(req, { ...deps, sessions: tracked.store })
    // Never log reply text to the console: screens echo names, Ghana Card, index numbers and phone numbers.
    console.log("[HUBTEL] Reply:", { type: reply.Type, len: reply.Message.length })
  } catch (e) {
    console.error("[HUBTEL] Router error:", safeDbError(e))
    // Always answer with a well-formed reply so the user sees our message, not Hubtel's UUE error.
    reply = release(req.SessionId, "Service unavailable. Please try again.", { platform: req.Platform })
  }
  // Session transcript (admin + shop owner viewers): written after the reply is sent, never delays it.
  const row = shapeInteractionRow(req, reply, tracked.latest(), receivedAt, tracked.answered()?.step ?? null)
  runAfterResponse(() => logInteraction(supabase, row))
  return NextResponse.json(reply)
}

/** `after()` outside a request scope (unit tests) throws: fall back to a detached best-effort write. */
function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task)
  } catch {
    void task()
  }
}
