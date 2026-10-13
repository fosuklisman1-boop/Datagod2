/**
 * Batch reconstruction: proves an `orders` row was wallet-paid by order.user_id when it came from a bulk upload.
 * A bulk upload debits the batch total ONCE (transactions source 'bulk_order', no order ids) and inserts every
 * order of the batch in one statement, so the rows share user_id + created_at. The order is proven iff exactly one
 * bulk_order debit of that user, within +/- 2 minutes of the order, equals the SUM of price over the whole batch.
 */
export const BULK_PROOF_WINDOW_MS = 2 * 60 * 1000

export interface BatchOrderRow { user_id: string; created_at: string; price: number | string }
export interface BatchDebitRow { user_id: string; amount: number | string; created_at: string }

/** orders.created_at is timestamp WITHOUT time zone (UTC): mark it UTC for the window math only. */
const toMs = (v: string, naive: boolean): number => {
  const s = String(v ?? "")
  const withZone = !naive || /(Z|[+-]\d\d(:?\d\d)?)$/i.test(s) ? s : s.replace(" ", "T") + "Z"
  return Date.parse(withZone)
}
const pesewas = (v: number | string): number => Math.round(Number(v) * 100)

export function proveBulkBatchPayment(order: BatchOrderRow, siblings: BatchOrderRow[], debits: BatchDebitRow[]): boolean {
  // Group = same user and the exact same raw created_at string (single-statement insert). Never Date-parsed.
  const group = siblings.filter((s) => s.user_id === order.user_id && s.created_at === order.created_at)
  if (group.length < 1) return false
  const prices = group.map((g) => pesewas(g.price))
  if (prices.some((p) => !Number.isFinite(p))) return false
  const total = prices.reduce((a, b) => a + b, 0)
  const at = toMs(order.created_at, true)
  if (!Number.isFinite(at)) return false
  const matches = debits.filter((d) => {
    if (d.user_id !== order.user_id) return false
    const t = toMs(d.created_at, false)
    if (!Number.isFinite(t) || Math.abs(t - at) > BULK_PROOF_WINDOW_MS) return false
    const amt = pesewas(d.amount)
    return Number.isFinite(amt) && Math.abs(amt - total) < 1
  })
  return matches.length === 1 // 0 = no proof, 2+ = ambiguous
}
