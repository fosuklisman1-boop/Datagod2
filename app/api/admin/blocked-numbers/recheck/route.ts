// Admin "Re-check now": explicit ids (max 500) or all due rows. Explicit re-checks re-open expired rows.
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { recheckBlockedNumbers } from "@/lib/blocked-numbers/recheck"
import { scheduleNotifyNow } from "@/lib/blocked-numbers/notify-now"
import { validateRecheckBody } from "@/lib/blocked-numbers/admin-view"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => null)
  const v = validateRecheckBody(body)
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 })

  try {
    const opts = "all" in v.value ? { all: true as const, reopenExpired: true } : { ids: v.value.ids, reopenExpired: true }
    const { newlyAllowedIds, ...counts } = await recheckBlockedNumbers(opts)
    console.log(`[BLOCKED-ADMIN] recheck checked=${counts.checked} allowed=${counts.allowed} stillBlocked=${counts.stillBlocked}`)
    let notifyQueued = false
    if (newlyAllowedIds.length > 0) {
      try {
        notifyQueued = await scheduleNotifyNow({ startedAt })
      } catch {
        notifyQueued = false
      }
    }
    return NextResponse.json({ success: true, ...counts, newlyAllowed: newlyAllowedIds.length, ...(notifyQueued ? { notifyQueued: true } : {}) })
  } catch (err) {
    console.error("[BLOCKED-ADMIN] recheck failed:", err instanceof Error ? err.name : "UnknownError")
    return NextResponse.json({ error: "Re-check failed" }, { status: 500 })
  }
}
