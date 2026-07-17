// Re-checks MTN numbers that were blocked at order creation by Xpress/Codecraft.
// Runs every 24h; each number gets at most 3 retries (72h window total).
// If any provider now allows the number, releases the held orders immediately.
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { WHITELIST_REGISTRY } from "@/lib/mtn-providers/provider-whitelist"
import { releaseWhitelistHeldOrders } from "@/lib/mtn-hold"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const MAX_RETRIES = 3 // 72h total (3 × 24h)
const RETRY_INTERVAL_H = 24

export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!

  const cutoff = new Date(Date.now() - RETRY_INTERVAL_H * 60 * 60 * 1000).toISOString()

  // 1. Find blocked numbers due for a retry.
  const { data: due, error: fetchErr } = await supabase
    .from("mtn_number_registry")
    .select("phone, whitelist_retry_count")
    .eq("whitelist_status", "blocked")
    .lt("whitelist_retry_count", MAX_RETRIES)
    .or(`whitelist_last_checked.is.null,whitelist_last_checked.lt.${cutoff}`)
    .limit(500)

  if (fetchErr) {
    console.error("[CRON][WL-RETRY] fetch failed:", fetchErr)
    return NextResponse.json({ error: "fetch failed" }, { status: 500 })
  }

  const rows = due ?? []
  let verified = 0, nowAllowed = 0, stillBlocked = 0, errors = 0

  // Only use configured whitelist providers
  const configuredProviders = WHITELIST_REGISTRY.filter(p => p.configured())

  for (const row of rows) {
    const phone = row.phone as string
    verified++

    try {
      // Try all configured providers in parallel; allowed if any says yes.
      const checks = await Promise.all(configuredProviders.map(p => p.check(phone)))
      const allowedBy = checks.find(c => c.allowed)

      if (allowedBy) {
        await supabase.from("mtn_number_registry").update({
          whitelist_status: "allowed",
          whitelist_allowed_by: allowedBy.provider,
          whitelist_last_checked: new Date().toISOString(),
        }).eq("phone", phone)

        await releaseWhitelistHeldOrders([phone])
        nowAllowed++
      } else {
        const nextCount = (row.whitelist_retry_count as number) + 1
        await supabase.from("mtn_number_registry").update({
          whitelist_retry_count: nextCount,
          whitelist_last_checked: new Date().toISOString(),
          // Auto-exhaust after this final retry
          ...(nextCount >= MAX_RETRIES ? { whitelist_status: "exhausted" } : {}),
        }).eq("phone", phone)
        stillBlocked++
      }
    } catch (err) {
      console.error(`[CRON][WL-RETRY] error checking ${phone}:`, err)
      errors++
    }
  }

  // 2. Sweep: mark any remaining blocked+exhausted that slipped through.
  await supabase
    .from("mtn_number_registry")
    .update({ whitelist_status: "exhausted" })
    .eq("whitelist_status", "blocked")
    .gte("whitelist_retry_count", MAX_RETRIES)

  console.log(`[CRON][WL-RETRY] verified=${verified} nowAllowed=${nowAllowed} stillBlocked=${stillBlocked} errors=${errors}`)
  return NextResponse.json({ ok: true, verified, nowAllowed, stillBlocked, errors })
}
