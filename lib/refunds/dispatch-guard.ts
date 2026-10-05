import { createClient } from "@supabase/supabase-js"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function claim(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("claim_order_dispatch", { p_order_id: orderId })
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
    const { error } = await supabase.rpc("record_dispatch_outcome", { p_order_id: orderId, p_outcome: outcome })
    if (error) console.error("[DISPATCH-GUARD] could not record outcome:", error.message)
  } catch (err) {
    console.error("[DISPATCH-GUARD] could not record outcome:", err)
  }
}

/**
 * Serializes provider dispatch against an admin refund of the same order (see
 * claim_order_dispatch / reserve_order_refund: same per-order advisory lock).
 * `blocked` is returned, without dispatching, when a refund already owns the order.
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
