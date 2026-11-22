import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAutoFulfil } from "@/lib/auto-fulfil/run"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/** Per-minute cron: queues age-gated pending orders for the normal drain when auto-fulfil is on. Logs counts only. */
export async function GET(request: NextRequest) {
  const { authorized, errorResponse } = verifyCronAuth(request)
  if (!authorized) return errorResponse!
  try {
    const summary = await runAutoFulfil(supabase)
    console.log("[CRON-AUTO-FULFIL] done", {
      ran: summary.ran,
      reason: summary.reason,
      queued: summary.queued,
      waiting: summary.waiting,
      needsYou: summary.needsYou,
      cancelled: summary.cancelled,
    })
    return NextResponse.json(summary)
  } catch {
    // The run row carries the (scrubbed) error; nothing order-specific here.
    console.error("[CRON-AUTO-FULFIL] failed")
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
