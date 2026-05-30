import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { validateAccountName } from "@/lib/moolre-transfer"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const maxDuration = 60

const CHUNK_SIZE = 20
const CONCURRENCY = 5
const CALL_TIMEOUT_MS = 8000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ])
}

async function pLimit<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let index = 0
  async function worker() {
    while (index < tasks.length) {
      const i = index++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  return results
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse!

  let sessionId: string | undefined
  try {
    const body = await request.json()
    sessionId = body.sessionId
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 })

    const { data: session } = await supabase
      .from("phone_verification_sessions")
      .select("id, status, total_count, verified_count, invalid_count")
      .eq("id", sessionId)
      .single()

    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 })

    if (session.status === "completed" || session.status === "failed") {
      return NextResponse.json({
        processed: 0, remaining: 0,
        verified: session.verified_count, invalid: session.invalid_count,
        status: session.status,
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
        status: "completed",
      })
    }

    const tasks = pending.map(row => async (): Promise<{
      rowId: number
      accountName: string | null
      rateLimited: boolean
    }> => {
      try {
        const network = row.network === "UNKNOWN" ? "MTN" : row.network
        const result = await withTimeout(validateAccountName(row.phone_number, network), CALL_TIMEOUT_MS)
        // Distinguish transient errors (rate limit / unreachable / timeout) from genuine invalid numbers.
        // Transient rows stay pending so the next chunk call retries them.
        const isTransient = result.accountName === null && !!result.error && (
          /rate.?limit|429|too many|limit exceeded/i.test(result.error) ||
          result.error === "Could not reach payment provider" ||
          result.error.startsWith("Unexpected response from payment provider")
        )
        return { rowId: row.id, accountName: result.accountName, rateLimited: isTransient }
      } catch {
        // Timeout or unexpected throw — leave as pending for retry
        return { rowId: row.id, accountName: null, rateLimited: true }
      }
    })

    const outcomes = await pLimit(tasks, CONCURRENCY)

    const now = new Date().toISOString()
    let verifiedThisChunk = 0
    let invalidThisChunk = 0
    let rateLimitedThisChunk = 0

    // Only upsert rows that were conclusively verified or invalid.
    // Rate-limited rows are excluded so they remain pending and get picked up next call.
    const upsertRows = outcomes
      .filter(o => !o.rateLimited)
      .map(o => {
        const isVerified = typeof o.accountName === "string" && o.accountName.trim() !== ""
        if (isVerified) verifiedThisChunk++
        else invalidThisChunk++
        return {
          id: o.rowId,
          status: isVerified ? "verified" : "invalid",
          account_name: isVerified ? o.accountName : null,
          verified_at: now,
        }
      })

    rateLimitedThisChunk = outcomes.filter(o => o.rateLimited).length

    if (upsertRows.length > 0) {
      const updateErrors = (await Promise.all(
        upsertRows.map(row =>
          supabase
            .from("phone_verification_results")
            .update({ status: row.status, account_name: row.account_name, verified_at: row.verified_at })
            .eq("id", row.id)
        )
      )).map(r => r.error).filter(Boolean)
      if (updateErrors.length > 0) throw new Error(`DB update failed: ${updateErrors[0]?.message}`)
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
    // Only mark as failed for non-transient errors (not network/timeout issues)
    const isTransientCrash = /timeout|network|ECONNRESET|fetch/i.test(msg)
    if (sessionId && !isTransientCrash) {
      await supabase
        .from("phone_verification_sessions")
        .update({ status: "failed" })
        .eq("id", sessionId)
    }
    return NextResponse.json({ error: msg || "Processing failed" }, { status: 500 })
  }
}
