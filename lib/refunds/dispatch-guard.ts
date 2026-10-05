import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const GUARD_TIMEOUT_MS = 3000

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
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${GUARD_TIMEOUT_MS}ms`)), GUARD_TIMEOUT_MS)
  })
  return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer))
}

async function claim(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await withTimeout(
      getClient().rpc("claim_order_dispatch", { p_order_id: orderId }),
      "claim"
    )
    if (error) {
      console.error("[DISPATCH-GUARD] claim failed — failing OPEN:", error.message)
      return true
    }
    return data !== false
  } catch (err) {
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
 * Every guard failure (missing env, RPC error, timeout) fails OPEN: the dispatch runs.
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
