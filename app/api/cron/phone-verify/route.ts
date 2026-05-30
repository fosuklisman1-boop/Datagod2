import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { processVerificationChunk } from "@/lib/phone-verify-processor"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const maxDuration = 60

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

    // Process as many sessions as we can fit inside the time budget.
    // Each chunk takes ~13 s for TELECEL; 50 s leaves a 10 s safety buffer.
    const BUDGET_MS = 50_000
    const startTime = Date.now()
    const results: object[] = []

    for (const session of sessions) {
      if (Date.now() - startTime > BUDGET_MS) {
        console.log("[CRON-PHONE-VERIFY] Time budget reached, deferring remaining sessions to next tick")
        break
      }

      try {
        const result = await processVerificationChunk(supabase, session.id)
        results.push({ sessionId: session.id, fileName: session.file_name, ...result })
        console.log(
          `[CRON-PHONE-VERIFY] sessionId=${session.id} processed=${result.processed} ` +
          `remaining=${result.remaining} status=${result.status}`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[CRON-PHONE-VERIFY] sessionId=${session.id} error="${msg}"`)
        results.push({ sessionId: session.id, fileName: session.file_name, error: msg })
      }
    }

    return NextResponse.json({
      activeSessions: sessions.length,
      processedThisTick: results.length,
      results,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("[CRON-PHONE-VERIFY]", msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
