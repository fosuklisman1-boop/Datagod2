import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const DAY_MS = 86_400_000

const json = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })

/** Daily sweep of phone-login bookkeeping. Returns counts only. */
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) {
    errorResponse!.headers.set("Cache-Control", "no-store")
    return errorResponse!
  }
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const now = Date.now()
    const dayAgo = new Date(now - DAY_MS).toISOString()
    const monthAgo = new Date(now - 30 * DAY_MS).toISOString()

    const ch = await supabase.from("phone_login_challenges").delete({ count: "exact" }).lt("created_at", dayAgo)
    if (ch.error) throw ch.error
    const td = await supabase
      .from("trusted_devices")
      .delete({ count: "exact" })
      .or(`revoked_at.lt.${monthAgo},expires_at.lt.${monthAgo}`)
    if (td.error) throw td.error
    const ev = await supabase.from("phone_login_events").delete({ count: "exact" }).lt("created_at", monthAgo)
    if (ev.error) throw ev.error

    const data = { challenges: ch.count ?? 0, trustedDevices: td.count ?? 0, events: ev.count ?? 0 }
    console.log("[PHONE-LOGIN-RETENTION] done", data)
    return json({ success: true, data })
  } catch {
    console.error("[PHONE-LOGIN-RETENTION] failed")
    return json({ success: false, error: "Internal server error" }, 500)
  }
}
