/** Order statuses owned by the refund flow: the DB guard trigger silently reverts any other writer. */
export const REFUND_LOCKED_STATUSES = ["refunding", "refunded"] as const

export const isRefundLocked = (orderStatus: string | null | undefined): boolean =>
  orderStatus != null && (REFUND_LOCKED_STATUSES as readonly string[]).includes(orderStatus)

/**
 * Splits rows (with an `order_status` or `status`) into those a bulk status update may touch and those a refund owns.
 * Rows without an order_status (tables that have no refund flow) always pass through.
 */
export function splitRefundLocked<T extends { id: string; order_status?: string | null; status?: string | null }>(
  rows: T[] | null | undefined,
): { allowed: T[]; locked: { id: string; reason: string }[] } {
  const allowed: T[] = []
  const locked: { id: string; reason: string }[] = []
  for (const r of rows ?? []) {
    // orders / api_orders name the column `status`; the other tables `order_status`.
    const st = r.order_status ?? r.status
    if (isRefundLocked(st)) locked.push({ id: r.id, reason: `order is ${st} (refund in progress or done)` })
    else allowed.push(r)
  }
  return { allowed, locked }
}
