// Classifies a provider status reply for a stale tracking row (open for more than 7 days), used by
// POST /api/admin/stale-tracking/recheck. Only an explicit, successful "completed" or "failed" reply counts
// as the provider's answer; anything else (in flight, pending, an error, no status) stays for the owner.

/** Masks phone-number-like runs (9-15 digits, optional +) to their last 4 digits, so reports carry no PII. */
export function redactPhoneNumbers(message: string | null): string | null {
  if (message == null) return message
  return message.replace(/\+?\b\d{9,15}\b/g, (m) => `***${m.slice(-4)}`)
}

export type RecheckVerdict = "confirm_completed" | "confirm_failed" | "unresolved"

export type StaleRow = {
  id: string
  mtn_order_id: string | number
  provider: string
  order_type: string | null
  created_at: string
}

export type RecheckReportRow = {
  id: string
  provider: string
  order_type: string | null
  created_at: string
  providerStatus: string | null
  providerMessage: string | null
  orderStatus: string | null
  verdict: RecheckVerdict
  skipped: "order_not_open" | null
  applied: boolean
}

export type RecheckCounts = Record<RecheckVerdict | "applied" | "skipped_order_not_open", number>

type ProviderResult = { success: boolean; status?: string; message?: string }

export type RecheckDeps = {
  /** Ask the provider about this row (checkMTNOrderStatus). */
  check: (row: StaleRow) => Promise<ProviderResult>
  /** Current status of the linked order (orders / api_orders / ussd_orders / ussd_shop_orders / shop_orders), or null. */
  orderStatus: (row: StaleRow) => Promise<string | null>
  /** Write the provider's status to the tracking row and the order (syncMTNOrderStatus). */
  sync: (trackingId: string) => Promise<{ success: boolean; newStatus?: string }>
  sleep: (ms: number) => Promise<void>
}

/** Only an order that is still waiting may be moved to completed; anything an admin or another flow already settled stays. */
const OPEN_ORDER_STATUSES = new Set(["pending", "processing"])
const DELAY_BETWEEN_REQUESTS_MS = 1000

/**
 * Re-checks each stale row with its provider and reports the outcome. With apply, writes ONLY rows where the
 * provider confirms completion AND the linked order is still pending/processing. Confirmed failures are never
 * written (syncMTNOrderStatus would put the order back to pending and could resend it).
 */
export async function runStaleRecheck(
  rows: StaleRow[],
  opts: { apply: boolean },
  deps: RecheckDeps
): Promise<{ counts: RecheckCounts; rows: RecheckReportRow[]; appliedIds: string[] }> {
  const counts: RecheckCounts = { confirm_completed: 0, confirm_failed: 0, unresolved: 0, applied: 0, skipped_order_not_open: 0 }
  const report: RecheckReportRow[] = []
  const appliedIds: string[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const result = await deps.check(row)
    const verdict = classifyRecheck(result)
    counts[verdict]++
    const orderStatus = await deps.orderStatus(row)

    let skipped: RecheckReportRow["skipped"] = null
    let applied = false
    if (verdict === "confirm_completed" && !OPEN_ORDER_STATUSES.has(orderStatus ?? "")) {
      skipped = "order_not_open"
      counts.skipped_order_not_open++
    } else if (opts.apply && verdict === "confirm_completed") {
      const synced = await deps.sync(row.id)
      applied = synced.success && synced.newStatus === "completed"
      if (applied) {
        counts.applied++
        appliedIds.push(row.id)
      }
    }

    report.push({
      id: row.id,
      provider: row.provider,
      order_type: row.order_type,
      created_at: row.created_at,
      providerStatus: result.status ?? null,
      providerMessage: redactPhoneNumbers(result.message ?? null),
      orderStatus,
      verdict,
      skipped,
      applied,
    })

    if (i < rows.length - 1) await deps.sleep(DELAY_BETWEEN_REQUESTS_MS)
  }

  return { counts, rows: report, appliedIds }
}

export function classifyRecheck(result: { success: boolean; status?: string; message?: string }): RecheckVerdict {
  if (result.success !== true) return "unresolved"
  if (result.status === "completed") return "confirm_completed"
  if (result.status === "failed") return "confirm_failed"
  return "unresolved"
}
