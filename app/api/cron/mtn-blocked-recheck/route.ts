// Daily re-check of refused MTN numbers against the checkout provider list. Flips numbers a provider now allows.
// Order: settings check -> recheck -> notify -> purge old attempts. Counts only in the response and logs, never phone numbers.
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { backgroundCron } from "@/lib/cron-background"
import { supabaseAdmin } from "@/lib/supabase"
import { getBlockedNumbersSettings } from "@/lib/blocked-numbers/settings"
import { recheckBlockedNumbers } from "@/lib/blocked-numbers/recheck"
import { runNotify } from "@/lib/blocked-numbers/notify"
import { sendDailyDigest } from "@/lib/blocked-numbers/alerts"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PURGE_DAYS = 90
const PURGE_BATCH = 5000
const DELETE_CHUNK = 500
const NOTIFY_DEADLINE_MS = 270_000

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

  const startedAt = Date.now()
  try {
    const settings = await getBlockedNumbersSettings()
    if (!settings.enabled) return NextResponse.json({ ok: true, skipped: "disabled" })

    const recheck = await recheckBlockedNumbers({})
    // A notify failure must not stop the purge (attempts carry purchaser phones); unsent rows retry next run.
    let notify = { texted: 0, shopNotices: 0, dealerNotices: 0, skipped: 0, failed: 0, error: false }
    try {
      notify = { ...(await runNotify({ deadlineAt: startedAt + NOTIFY_DEADLINE_MS })), error: false }
    } catch (err) {
      console.error("[CRON][BLOCKED-RECHECK] notify failed:", err instanceof Error ? err.name : "UnknownError")
      notify.error = true
    }
    const purged = await purgeOldAttempts()
    // The digest runs last and a failure here must never fail the cron (the work above is already done).
    let digestSent = false
    try {
      digestSent = await sendDailyDigest({ unchecked: recheck.unchecked, deferred: recheck.deferred })
    } catch (err) {
      console.error("[CRON][BLOCKED-RECHECK] digest failed:", err instanceof Error ? err.name : "UnknownError")
    }
    const { newlyAllowedIds, ...counts } = recheck
    console.log(`[CRON][BLOCKED-RECHECK] purged=${purged} notifyTexted=${notify.texted} notifyFailed=${notify.failed} digestSent=${digestSent}`)
    return NextResponse.json({ ok: true, ...counts, newlyAllowed: newlyAllowedIds.length, notify, purged, digestSent })
  } catch (err) {
    console.error("[CRON][BLOCKED-RECHECK] failed:", err instanceof Error ? err.name : "UnknownError")
    return NextResponse.json({ error: "recheck failed" }, { status: 500 })
  }
}
