/** Order statuses owned by the refund flow: the DB guard trigger silently reverts any other writer. */
export const REFUND_LOCKED_STATUSES = ["refunding", "refunded"] as const

export const isRefundLocked = (orderStatus: string | null | undefined): boolean =>
  orderStatus != null && (REFUND_LOCKED_STATUSES as readonly string[]).includes(orderStatus)

/**
 * Splits rows (with an `order_status`) into those a bulk status update may touch and those a refund owns.
 * Rows without an order_status (tables that have no refund flow) always pass through.
 */
export function splitRefundLocked<T extends { id: string; order_status?: string | null }>(
  rows: T[] | null | undefined,
): { allowed: T[]; locked: { id: string; reason: string }[] } {
  const allowed: T[] = []
  const locked: { id: string; reason: string }[] = []
  for (const r of rows ?? []) {
    if (isRefundLocked(r.order_status)) locked.push({ id: r.id, reason: `order is ${r.order_status} (refund in progress or done)` })
    else allowed.push(r)
  }
  return { allowed, locked }
}
