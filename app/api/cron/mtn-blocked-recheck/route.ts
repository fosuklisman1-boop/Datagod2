// Daily re-check of refused MTN numbers against the checkout provider list. Flips numbers a provider now allows.
// Order: settings check -> recheck -> purge old attempts. Counts only in the response and logs, never phone numbers.
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { backgroundCron } from "@/lib/cron-background"
import { supabaseAdmin } from "@/lib/supabase"
import { getBlockedNumbersSettings } from "@/lib/blocked-numbers/settings"
import { recheckBlockedNumbers } from "@/lib/blocked-numbers/recheck"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PURGE_DAYS = 90
const PURGE_BATCH = 5000
const DELETE_CHUNK = 500

export const GET = backgroundCron("mtn-blocked-recheck", (request) => run(request))

async function purgeOldAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - PURGE_DAYS * 86_400_000).toISOString()
  const { data, error } = await supabaseAdmin
    .from("mtn_blocked_attempts")
    .select("id")
    .lt("created_at", cutoff)
    .limit(PURGE_BATCH)
  if (error) {
    console.error("[CRON][BLOCKED-RECHECK] purge select failed:", error.code ?? "db")
    return 0
  }
  const ids = (data ?? []).map((r: { id: string }) => r.id)
  let purged = 0
  for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
    const chunk = ids.slice(i, i + DELETE_CHUNK)
    const { error: delErr } = await supabaseAdmin.from("mtn_blocked_attempts").delete().in("id", chunk)
    if (delErr) {
      console.error("[CRON][BLOCKED-RECHECK] purge delete failed:", delErr.code ?? "db")
      break
    }
    purged += chunk.length
  }
  return purged
}

async function run(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  try {
    const settings = await getBlockedNumbersSettings()
    if (!settings.enabled) return NextResponse.json({ ok: true, skipped: "disabled" })

    const recheck = await recheckBlockedNumbers({})
    // Task 6 adds runNotify() here (customer SMS + owner notice for newly allowed rows).
    const purged = await purgeOldAttempts()
    // Task 9 adds sendDailyDigest() here, after the purge.
    const { newlyAllowedIds, ...counts } = recheck
    console.log(`[CRON][BLOCKED-RECHECK] purged=${purged}`)
    return NextResponse.json({ ok: true, ...counts, newlyAllowed: newlyAllowedIds.length, purged })
  } catch (err) {
    console.error("[CRON][BLOCKED-RECHECK] failed:", err instanceof Error ? err.name : "UnknownError")
    return NextResponse.json({ error: "recheck failed" }, { status: 500 })
  }
}
