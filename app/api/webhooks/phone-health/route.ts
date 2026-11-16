import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveForwardLine } from "@/lib/text-to-buy/forward-secrets"
import { touchHeartbeat } from "@/lib/text-to-buy/store"

// A scheduled "I am alive" ping from the forwarder phone (SmsForwarder Task: Cron -> Notify to this URL).
// It only refreshes the line's heartbeat, so a quiet day (no texts, no calls) no longer looks like a dead phone to the
// quiet-phone alert and the "phone last heard" tile. Same x-sms-forward-secret header as the other webhooks decides the line.
// The body is ignored. After a valid secret the answer is always 200; 401 only for bad auth. Nothing user-supplied is logged.
export const dynamic = "force-dynamic"
export const maxDuration = 30

const TAG = "[PHONE-HEALTH]"
const safe = (v: unknown) => (typeof v === "string" ? v.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "-")

export async function POST(request: NextRequest) {
  const line = resolveForwardLine(process.env, request.headers.get("x-sms-forward-secret"))
  if (!line) return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  try {
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseAdmin) {
      console.error(`${TAG} service role key missing; ping not recorded`)
    } else {
      await touchHeartbeat(supabaseAdmin, line, new Date())
    }
  } catch (err) {
    const e = (err && typeof err === "object" ? err : {}) as { name?: unknown; code?: unknown }
    console.error(`${TAG} heartbeat not recorded name=${safe(e.name)} code=${safe(e.code)}`)
  }
  return NextResponse.json({ ok: true })
}
