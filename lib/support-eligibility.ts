/**
 * Owner rule (2026-11-13): an order can be complained about only when it has been marked
 * completed for 15 minutes, or has been processing for 3 hours. Used by the buttons and,
 * authoritatively, by POST /api/support/threads.
 */
export const COMPLETED_WAIT_MS = 15 * 60 * 1000
export const PROCESSING_WAIT_MS = 3 * 60 * 60 * 1000

export interface OrderTiming {
  status: string | null | undefined
  /** When the order was placed. */
  createdAt: string | null | undefined
  /** Last status change; for a completed order, when it was completed. */
  updatedAt?: string | null
}

export type Eligibility = { eligible: true } | { eligible: false; reason: string }

const age = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : now.getTime() - t
}

export function complaintEligibility(order: OrderTiming, now: Date = new Date()): Eligibility {
  const status = (order.status ?? "").trim().toLowerCase()
  if (status === "completed") {
    // Completion time is the last update; older rows without one fall back to the order time.
    const since = age(order.updatedAt, now) ?? age(order.createdAt, now)
    return since !== null && since >= COMPLETED_WAIT_MS
      ? { eligible: true }
      : { eligible: false, reason: "You can report this order 15 minutes after it is marked completed." }
  }
  if (status === "processing") {
    // Counted from placement: status syncs keep bumping updated_at on a processing order.
    const since = age(order.createdAt, now)
    return since !== null && since >= PROCESSING_WAIT_MS
      ? { eligible: true }
      : { eligible: false, reason: "You can report this order once it has been processing for 3 hours." }
  }
  return { eligible: false, reason: "Only completed orders, or orders processing for 3 hours, can be reported." }
}
