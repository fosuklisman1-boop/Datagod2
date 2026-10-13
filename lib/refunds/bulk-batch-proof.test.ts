import { proveBulkBatchPayment } from "./bulk-batch-proof"

const T = "2026-10-05T10:00:00"
const o = (price: number | string, extra: Record<string, unknown> = {}) => ({ user_id: "u1", created_at: T, price, ...extra })
const d = (amount: number | string, created_at = "2026-10-05T10:00:01+00:00", user_id = "u1") => ({ user_id, amount, created_at })

describe("proveBulkBatchPayment", () => {
  it("proves a batch whose debit equals the sum of all sibling prices", () => {
    const sib = [o(5), o(6.5), o(8)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(19.5)])).toBe(true)
  })
  it("a single-order batch is provable", () => {
    expect(proveBulkBatchPayment(o(7), [o(7)], [d(7)])).toBe(true)
  })
  it("empty group is false", () => {
    expect(proveBulkBatchPayment(o(7), [], [d(7)])).toBe(false)
  })
  it("no debits / wrong amount => false", () => {
    const sib = [o(5), o(6)]
    expect(proveBulkBatchPayment(sib[0], sib, [])).toBe(false)
    expect(proveBulkBatchPayment(sib[0], sib, [d(5)])).toBe(false)
  })
  it("handles float rounding via integer pesewas (0.1 + 0.2)", () => {
    const sib = [o(0.1), o(0.2)]
    expect(proveBulkBatchPayment(sib[0], sib, [d("0.30")])).toBe(true)
    expect(proveBulkBatchPayment(sib[0], sib, [d(0.31)])).toBe(false)
  })
  it("two matching debits in the window are ambiguous => false", () => {
    const sib = [o(5), o(6)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(11), d(11, "2026-10-05T10:00:30Z")])).toBe(false)
  })
  it("a second NON-matching debit does not make it ambiguous", () => {
    const sib = [o(5), o(6)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(11), d(3)])).toBe(true)
  })
  it("a matching debit outside the window does not count toward ambiguity", () => {
    const sib = [o(5), o(6)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(11), d(11, "2026-10-05T11:00:00Z")])).toBe(true)
  })
  it("window edges: exactly 2 min inside (both directions), 2 min + 1 s outside", () => {
    const sib = [o(5)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T10:02:00Z")])).toBe(true)
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T09:58:00Z")])).toBe(true)
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T10:02:01Z")])).toBe(false)
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T09:57:59Z")])).toBe(false)
  })
  it("orders timestamp is treated as UTC (offset debit timestamps compare correctly)", () => {
    const sib = [o(5)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T11:00:00+01:00")])).toBe(true)
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, "2026-10-05T10:00:00+01:00")])).toBe(false)
  })
  it("a different user's debit never matches", () => {
    const sib = [o(5)]
    expect(proveBulkBatchPayment(sib[0], sib, [d(5, undefined, "u2")])).toBe(false)
  })
  it("siblings of another user or another created_at are never counted", () => {
    const mine = o(5)
    const sib = [mine, o(6, { created_at: "2026-10-05T10:00:01" }), o(9, { user_id: "u2" })]
    expect(proveBulkBatchPayment(mine, sib, [d(5)])).toBe(true)
    expect(proveBulkBatchPayment(mine, sib, [d(20)])).toBe(false)
  })
  it("unparseable inputs => false", () => {
    expect(proveBulkBatchPayment(o("x"), [o("x")], [d(5)])).toBe(false)
    expect(proveBulkBatchPayment(o(5, { created_at: "garbage" }), [o(5, { created_at: "garbage" })], [d(5)])).toBe(false)
  })
})
