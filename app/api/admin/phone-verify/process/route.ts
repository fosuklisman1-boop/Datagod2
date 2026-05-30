import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { validateAccountName } from "@/lib/moolre-transfer"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const maxDuration = 60

const CHUNK_SIZE = 10
const CALL_TIMEOUT_MS = 12000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), ms)
    ),
  ])
}

function isRateLimitError(msg: string): boolean {
  return /rate.?limit|429|too many|limit exceeded|maximum.*request|request.*limit|quota|throttl/i.test(msg)
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  const body = await request.json().catch(() => ({}))
  const sessionId: string | undefined = body.sessionId
  if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

  try {
    const { data: session, error: sessionErr } = await supabase
      .from("phone_verification_sessions")
      .select("id, status, total_count, verified_count, invalid_count")
      .eq("id", sessionId)
      .single()

    if (sessionErr || !session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 })
    }

    if (session.status === "completed") {
      return NextResponse.json({
        processed: 0, remaining: 0,
        verified: session.verified_count, invalid: session.invalid_count,
        rateLimited: 0, status: "completed",
      })
    }

    const { data: pending, error: fetchError } = await supabase
      .from("phone_verification_results")
      .select("id, phone_number, network")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .limit(CHUNK_SIZE)

    if (fetchError) throw fetchError

    if (!pending || pending.length === 0) {
      await supabase
        .from("phone_verification_sessions")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", sessionId)
      return NextResponse.json({
        processed: 0, remaining: 0,
        verified: session.verified_count, invalid: session.invalid_count,
        rateLimited: 0, status: "completed",
      })
    }

    const now = new Date().toISOString()
    let verifiedThisChunk = 0
    let invalidThisChunk = 0
    let rateLimitedThisChunk = 0

    // Process sequentially and write each result to DB immediately.
    // This way a serverless timeout can't lose results for calls that already completed.
    for (const row of pending) {
      const network = row.network === "UNKNOWN" ? "MTN" : row.network
      let accountName: string | null = null
      let isTransient = false

      try {
        const result = await withTimeout(
          validateAccountName(row.phone_number, network),
          CALL_TIMEOUT_MS
        )
        accountName = result.accountName

        if (accountName === null && result.error) {
          isTransient =
            isRateLimitError(result.error) ||
            result.error === "Could not reach payment provider" ||
            result.error.startsWith("Unexpected response from payment provider")

          console.log(
            `[PHONE-VERIFY] phone=${row.phone_number} network=${network} ` +
            `transient=${isTransient} error="${result.error}"`
          )
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // Only our own timeout is retriable; other throws mark as invalid
        isTransient = msg === "timeout"
        console.log(`[PHONE-VERIFY] phone=${row.phone_number} caught="${msg}" transient=${isTransient}`)
      }

      if (isTransient) {
        rateLimitedThisChunk++
        // Leave row as pending — it will be retried on next call
      } else {
        const isVerified = typeof accountName === "string" && accountName.trim() !== ""
        if (isVerified) verifiedThisChunk++
        else invalidThisChunk++

        // Write immediately so a later timeout doesn't discard this result
        await supabase
          .from("phone_verification_results")
          .update({
            status: isVerified ? "verified" : "invalid",
            account_name: isVerified ? accountName : null,
            verified_at: now,
          })
          .eq("id", row.id)
      }
    }

    const newVerified = session.verified_count + verifiedThisChunk
    const newInvalid = session.invalid_count + invalidThisChunk

    const { count: remaining } = await supabase
      .from("phone_verification_results")
      .select("id", { count: "exact", head: true })
      .eq("session_id", sessionId)
      .eq("status", "pending")

    const isDone = (remaining ?? 0) === 0

    await supabase
      .from("phone_verification_sessions")
      .update({
        verified_count: newVerified,
        invalid_count: newInvalid,
        ...(isDone ? { status: "completed", completed_at: now } : {}),
      })
      .eq("id", sessionId)

    return NextResponse.json({
      processed: pending.length,
      remaining: remaining ?? 0,
      verified: newVerified,
      invalid: newInvalid,
      rateLimited: rateLimitedThisChunk,
      status: isDone ? "completed" : "in_progress",
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error("[PHONE-VERIFY-PROCESS]", msg)
    return NextResponse.json({ error: msg || "Processing failed" }, { status: 500 })
  }
}
