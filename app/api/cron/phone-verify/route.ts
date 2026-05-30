import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { processVerificationChunk } from "@/lib/phone-verify-processor"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Pro plan: up to 300 s — allows ~20 chunks × 20 numbers ≈ 400 numbers/minute
export const maxDuration = 300

// Leave 30 s buffer before Vercel's wall so final writes always complete
const BUDGET_MS = 270_000

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    console.error("[CRON-PHONE-VERIFY] CRON_SECRET env var is not set — denying all requests")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { data: sessions, error } = await supabase
      .from("phone_verification_sessions")
      .select("id, file_name")
      .eq("status", "processing")
      .order("created_at")

    if (error) throw error

    if (!sessions || sessions.length === 0) {
      return NextResponse.json({ message: "No active sessions" })
    }

    const startTime = Date.now()
    const summary: object[] = []

    for (const session of sessions) {
      let chunksThisSession = 0
      let totalProcessed = 0

      // Drain this session until it completes or the time budget runs out
      while (Date.now() - startTime < BUDGET_MS) {
        let result
        try {
          result = await processVerificationChunk(supabase, session.id)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          console.error(`[CRON-PHONE-VERIFY] sessionId=${session.id} error="${msg}"`)
          summary.push({ sessionId: session.id, fileName: session.file_name, error: msg })
          break
        }

        chunksThisSession++
        totalProcessed += result.processed

        console.log(
          `[CRON-PHONE-VERIFY] sessionId=${session.id} chunk=${chunksThisSession} ` +
          `processed=${result.processed} remaining=${result.remaining} status=${result.status}`
        )

        if (result.status === "completed") {
          summary.push({ sessionId: session.id, fileName: session.file_name, status: "completed", totalProcessed })
          break
        }

        // All numbers in this chunk were rate-limited — back off before hammering again
        if (result.rateLimited > 0 && result.rateLimited === result.processed) {
          console.log(`[CRON-PHONE-VERIFY] sessionId=${session.id} full chunk rate-limited, yielding to next tick`)
          summary.push({ sessionId: session.id, fileName: session.file_name, status: "rate_limited", totalProcessed })
          break
        }
      }

      // Time budget exhausted mid-session — next cron tick picks up where we left off
      if (Date.now() - startTime >= BUDGET_MS && chunksThisSession > 0) {
        summary.push({ sessionId: session.id, fileName: session.file_name, status: "in_progress", totalProcessed })
      }
    }

    return NextResponse.json({
      activeSessions: sessions.length,
      elapsedMs: Date.now() - startTime,
      results: summary,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("[CRON-PHONE-VERIFY]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
