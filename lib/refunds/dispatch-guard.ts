import { createClient, type SupabaseClient } from "@supabase/supabase-js"

// Greater than PostgREST's 8s statement_timeout so the server's own answer (57014) normally arrives first.
const GUARD_TIMEOUT_MS = 10000

class GuardTimeoutError extends Error {}

let cachedClient: SupabaseClient | null = null

// Built lazily (and only inside the callers' try/catch) so a missing/invalid env can
// never make importing this module — or dispatching — throw.
function getClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return cachedClient
}

function withTimeout<T>(p: PromiseLike<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new GuardTimeoutError(`${label} timed out after ${GUARD_TIMEOUT_MS}ms`)), GUARD_TIMEOUT_MS)
  })
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer))
}

type Verdict = "open" | "closed"

/**
 * Fail OPEN only when the guard itself is unavailable (missing RPC, no env/client, plain network error)
 * or the error is unrecognised. Fail CLOSED when the claim timed out or hit a statement/lock timeout:
 * that is exactly when a refund may hold the advisory lock, so dispatching could pay out twice.
 */
function classifyClaimFailure(err: unknown): Verdict {
  if (err instanceof GuardTimeoutError) return "closed"
  if (err instanceof TypeError) return "open" // fetch network failure
  const e = (err ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === "string" ? e.code : ""
  const msg = (typeof e.message === "string" ? e.message : err instanceof Error ? err.message : String(err)).toLowerCase()
  if (code === "PGRST202" || code === "42883" || msg.includes("does not exist") || msg.includes("could not find the function")) return "open"
  if (code === "57014" || code === "55P03" || msg.includes("canceling statement due to") || msg.includes("lock timeout")) return "closed"
  return "open"
}

async function claim(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await withTimeout(
      getClient().rpc("claim_order_dispatch", { p_order_id: orderId }),
      "claim"
    )
    if (error) {
      if (classifyClaimFailure(error) === "closed") {
        console.error("[DISPATCH-GUARD] claim timed out / lock contention — failing CLOSED (order stays pending):", error.message)
        return false
      }
      console.error("[DISPATCH-GUARD] claim failed — failing OPEN:", error.message)
      return true
    }
    return data !== false
  } catch (err) {
    if (classifyClaimFailure(err) === "closed") {
      console.error("[DISPATCH-GUARD] claim timed out — failing CLOSED (order stays pending):", err)
      return false
    }
    console.error("[DISPATCH-GUARD] claim threw — failing OPEN:", err)
    return true
  }
}

async function record(orderId: string, outcome: "submitted" | "failed" | "unknown"): Promise<void> {
  try {
    const { error } = await withTimeout(
      getClient().rpc("record_dispatch_outcome", { p_order_id: orderId, p_outcome: outcome }),
      "record"
    )
    if (error) console.error("[DISPATCH-GUARD] could not record outcome:", error.message)
  } catch (err) {
    console.error("[DISPATCH-GUARD] could not record outcome:", err)
  }
}

/**
 * Serializes provider dispatch against an admin refund of the same order (see
 * claim_order_dispatch / reserve_order_refund: same per-order advisory lock).
 * `blocked` is returned, without dispatching, when a refund already owns the order.
 * Guard failures fail OPEN (dispatch runs) when the guard is unavailable: missing RPC, env/client or a network
 * error. A claim timeout or a statement/lock timeout fails CLOSED: `blocked` is returned and the order stays
 * pending for the existing retry paths.
 */
export async function withDispatchGuard<T extends { success: boolean }>(
  orderId: string | undefined,
  run: () => Promise<T>,
  blocked: T
): Promise<T> {
  if (!orderId) return run()
  if (!(await claim(orderId))) {
    console.warn(`[DISPATCH-GUARD] order ${orderId} is being refunded — dispatch refused`)
    return blocked
  }
  try {
    const result = await run()
    await record(orderId, result.success ? "submitted" : "failed")
    return result
  } catch (err) {
    await record(orderId, "unknown")
    throw err
  }
}
