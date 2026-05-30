import type { SupabaseClient } from "@supabase/supabase-js"
import { validateAccountName } from "@/lib/moolre-transfer"

const CHUNK_SIZE = 20
const CONCURRENCY = 10
// TELECEL calls via Moolre take ~12-13 s; 25 s gives a comfortable buffer
const CALL_TIMEOUT_MS = 25000

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

export interface ChunkResult {
  processed: number
  remaining: number
  verified: number
  invalid: number
  rateLimited: number
  status: "completed" | "in_progress"
}

export async function processVerificationChunk(
  supabase: SupabaseClient,
  sessionId: string
): Promise<ChunkResult> {
  const { data: session, error: sessionErr } = await supabase
    .from("phone_verification_sessions")
    .select("id, status, verified_count, invalid_count")
    .eq("id", sessionId)
    .single()

  if (sessionErr || !session) throw new Error("Session not found")

  if (session.status === "completed") {
    return {
      processed: 0, remaining: 0,
      verified: session.verified_count, invalid: session.invalid_count,
      rateLimited: 0, status: "completed",
    }
  }

  const { data: pending, error: fetchError } = await supabase
    .from("phone_verification_results")
    .select("id, phone_number, network")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .limit(CHUNK_SIZE)

  if (fetchError) throw fetchError

  if (!pending || pending.length === 0) {
    const now = new Date().toISOString()
    await supabase
      .from("phone_verification_sessions")
      .update({ status: "completed", completed_at: now })
      .eq("id", sessionId)
    return {
      processed: 0, remaining: 0,
      verified: session.verified_count, invalid: session.invalid_count,
      rateLimited: 0, status: "completed",
    }
  }

  const now = new Date().toISOString()
  let rateLimitedThisChunk = 0

  async function processRow(row: { id: number; phone_number: string; network: string }) {
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
      } else if (accountName) {
        console.log(`[PHONE-VERIFY] phone=${row.phone_number} network=${network} verified="${accountName}"`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Only our own timeout is retriable; other throws mark as invalid
      isTransient = msg === "timeout"
      console.log(`[PHONE-VERIFY] phone=${row.phone_number} caught="${msg}" transient=${isTransient}`)
    }

    if (isTransient) {
      rateLimitedThisChunk++
      return
    }

    const isVerified = typeof accountName === "string" && accountName.trim() !== ""

    // Write immediately so a later timeout can't discard this result
    await supabase
      .from("phone_verification_results")
      .update({
        status: isVerified ? "verified" : "invalid",
        account_name: isVerified ? accountName : null,
        verified_at: now,
      })
      .eq("id", row.id)
  }

  // pLimit-style concurrency: CONCURRENCY workers drain the task queue
  async function pLimit(tasks: (() => Promise<void>)[], concurrency: number) {
    let index = 0
    async function worker() {
      while (true) {
        const i = index++
        if (i >= tasks.length) break
        await tasks[i]()
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
  }

  await pLimit(pending.map(row => () => processRow(row)), CONCURRENCY)

  // Derive counts from actual rows — safe when client loop and cron run concurrently
  // for the same session (incrementing session.verified_count would double-count)
  const [{ count: verifiedCount }, { count: invalidCount }, { count: remaining }] =
    await Promise.all([
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "verified"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "invalid"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "pending"),
    ])

  const newVerified = verifiedCount ?? 0
  const newInvalid = invalidCount ?? 0
  const isDone = (remaining ?? 0) === 0

  await supabase
    .from("phone_verification_sessions")
    .update({
      verified_count: newVerified,
      invalid_count: newInvalid,
      ...(isDone ? { status: "completed", completed_at: now } : {}),
    })
    .eq("id", sessionId)

  return {
    processed: pending.length,
    remaining: remaining ?? 0,
    verified: newVerified,
    invalid: newInvalid,
    rateLimited: rateLimitedThisChunk,
    status: isDone ? "completed" : "in_progress",
  }
}
