export interface FloatDeps {
  setPaused(reason: string): Promise<unknown>
  alert(kind: "paused" | "low_balance", subject: string, message: string, opts?: { force?: boolean }): Promise<void>
  /** Was the service already paused before this 4075? If it was not (or this is unknown), the alert bypasses the debounce. */
  wasPaused?(): Promise<boolean>
}

const SHARED = "The Hubtel Disbursement (prepaid) balance is shared with Hubtel SMS, so SMS credit sales can stall too. Top up the Disbursement account."

/** 4075 handler: stop taking new Hubtel orders and tell the admins. Pending rows keep reconciling. Never throws. */
export async function pauseForFloat(deps: FloatDeps, reason: string): Promise<void> {
  // Only the first 4075 after a resume is forced through the alert debounce.
  let force = true
  if (deps.wasPaused) {
    try { force = !(await deps.wasPaused()) } catch { force = true }
  }
  try { await deps.setPaused(reason) } catch (e: any) { console.error("[hubtel-cs] could not set pause:", e?.message ?? e) }
  try {
    await deps.alert("paused", "Hubtel Commission Services paused - prepaid balance exhausted", `${reason}. New Hubtel orders are blocked until an admin resumes the service. ${SHARED}`, { force })
  } catch (e: any) { console.error("[hubtel-cs] pause alert failed:", e?.message ?? e) }
}

export async function checkLowBalance(deps: {
  threshold: number | null
  fetchBalance(): Promise<{ ok: true; amountGhs: number } | { ok: false; error: string }>
  alert: FloatDeps["alert"]
}): Promise<{ checked: boolean; low?: boolean; balance?: number; error?: string }> {
  if (deps.threshold === null) return { checked: false }
  let bal: Awaited<ReturnType<typeof deps.fetchBalance>>
  try { bal = await deps.fetchBalance() } catch (e: any) { return { checked: false, error: e?.message ?? "balance fetch failed" } }
  if (!bal.ok) return { checked: false, error: bal.error }
  const low = bal.amountGhs < deps.threshold
  if (low) {
    try {
      await deps.alert("low_balance", "Hubtel prepaid balance is low",
        `Balance is GHS ${bal.amountGhs.toFixed(2)} (threshold GHS ${deps.threshold.toFixed(2)}). ${SHARED}`)
    } catch (e: any) { console.error("[hubtel-cs] low-balance alert failed:", e?.message ?? e) }
  }
  return { checked: true, low, balance: bal.amountGhs }
}
