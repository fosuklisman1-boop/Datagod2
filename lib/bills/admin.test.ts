import { describe, it, expect } from "vitest"
import { releaseStuckClaimRow, canDispatch, isStuckClaim, STUCK_CLAIM_MS, computeStats, statsFromRpc, statsRpcArgs, parseOrderFilters, purchaserLabel, refundDecision, UNSENT_GRACE_MS, type LedgerFact } from "./admin"
import { executeBillRefund, type BillRefundDeps, type RefundOrder } from "./admin-refund"

const NOW = Date.parse("2026-10-13T12:00:00Z")
const old = new Date(NOW - 10 * 60_000).toISOString()
const order = (o: Partial<RefundOrder> = {}): RefundOrder => ({
  id: "o1", reference_code: "BILL-1", status: "failed", payment_status: "paid", hubtel_client_reference: null, notes: null, updated_at: old, ...o,
})
const led = (o: Partial<LedgerFact> = {}): LedgerFact => ({
  client_reference: "ref1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: old, ...o,
})

describe("parseOrderFilters", () => {
  it("drops unknown values and strips or() syntax characters", () => {
    const f = parseOrderFilters(new URLSearchParams("q=a,b(c)%25&status=bogus&biller=nope&from=2026-13-45&to=2026-10-02&paidOnly=true&view=refund"))
    expect(f.q).toBe("a b c")
    expect(f.status).toBeUndefined()
    expect(f.biller).toBeUndefined()
    expect(f.from).toBeUndefined()
    expect(f.to).toBe("2026-10-02")
    expect(f.paidOnly).toBe(true)
    expect(f.view).toBe("refund")
  })
  it("accepts valid status and biller", () => {
    const f = parseOrderFilters(new URLSearchParams("status=processing&biller=ecg"))
    expect(f).toMatchObject({ status: "processing", biller: "ecg", view: "all", paidOnly: false })
  })
})

describe("computeStats", () => {
  it("counts every row and sums sales/commission exactly", () => {
    const s = computeStats([
      { amount: "20.10", status: "completed", payment_status: "paid", commission: "0.3415" },
      { amount: 5, status: "processing", payment_status: "paid", commission: null },
      { amount: 7, status: "pending", payment_status: "unpaid", commission: null },
      { amount: 9, status: "failed", payment_status: "paid", commission: null },
      { amount: 11, status: "refunded", payment_status: "refunded", commission: null },
      { amount: 1, status: "completed", payment_status: "paid", commission: 0.1 },
    ])
    expect(s).toEqual({ totalSales: 26.1, orders: 6, completed: 2, inFlight: 1, commission: 0.4415, failed: 1, refunded: 1 })
  })
  it("handles 2500 rows (beyond any single page)", () => {
    const rows = Array.from({ length: 2500 }, () => ({ amount: 1, status: "completed", payment_status: "paid", commission: 0.01 }))
    const s = computeStats(rows)
    expect(s.orders).toBe(2500); expect(s.totalSales).toBe(2500); expect(s.commission).toBe(25)
  })
})

describe("stats RPC helpers", () => {
  it("maps filters to RPC args (nulls = no filter)", () => {
    expect(statsRpcArgs(parseOrderFilters(new URLSearchParams("")))).toEqual({ p_from: null, p_to: null, p_biller: null, p_status: null, p_q: null, p_paid_only: false })
    const a = statsRpcArgs(parseOrderFilters(new URLSearchParams("q=ab&biller=dstv&status=failed&from=2026-10-01&to=2026-10-02&paidOnly=true")))
    expect(a).toEqual({ p_from: "2026-10-01T00:00:00.000Z", p_to: "2026-10-02T23:59:59.999Z", p_biller: "dstv", p_status: "failed", p_q: "ab", p_paid_only: true })
    expect(statsRpcArgs(parseOrderFilters(new URLSearchParams("q=0244000000")), "233244000000").p_q).toBe("233244000000")
  })
  it("parses string bigint/numeric rows and tolerates empties", () => {
    expect(statsFromRpc({ total_sales: "26.10", orders: "6", completed: "2", in_flight: "1", commission: "0.4415", failed: "1", refunded: "1" }))
      .toEqual({ totalSales: 26.1, orders: 6, completed: 2, inFlight: 1, commission: 0.4415, failed: 1, refunded: 1 })
    expect(statsFromRpc(undefined).orders).toBe(0)
  })
})

describe("purchaserLabel", () => {
  it("prefers name, then email", () => {
    expect(purchaserLabel({ first_name: "Dev", last_name: "Prod", email: "a@b.c" })).toBe("Dev Prod")
    expect(purchaserLabel({ email: "a@b.c" })).toBe("a@b.c")
    expect(purchaserLabel(undefined)).toBe("Unknown")
  })
})

describe("canDispatch", () => {
  it("only paid pending orders never sent", () => {
    expect(canDispatch({ status: "pending", payment_status: "paid", hubtel_client_reference: null })).toBe(true)
    expect(canDispatch({ status: "pending", payment_status: "unpaid", hubtel_client_reference: null })).toBe(false)
    expect(canDispatch({ status: "processing", payment_status: "paid", hubtel_client_reference: null })).toBe(false)
    expect(canDispatch({ status: "pending", payment_status: "paid", hubtel_client_reference: "x" })).toBe(false)
  })
})

describe("refundDecision", () => {
  it("never refunds completed or refunded", () => {
    expect(refundDecision(order({ status: "completed" }), [], NOW).action).toBe("blocked")
    expect(refundDecision(order({ status: "refunded", payment_status: "refunded" }), [], NOW).action).toBe("blocked")
    expect(refundDecision(order({ payment_status: "unpaid" }), [], NOW).action).toBe("blocked")
  })
  it("blocks while Hubtel may still deliver", () => {
    for (const state of ["pending", "needs_review", "created"] as const) {
      const d = refundDecision(order({ hubtel_client_reference: "ref1" }), [led({ state })], NOW)
      expect(d.action).toBe("blocked")
      expect((d as any).reason).toContain("ref1")
    }
    expect(refundDecision(order(), [led({ state: "fulfilled" })], NOW).action).toBe("blocked")
  })
  it("uses the ledger path for failed Hubtel rows, flagging admin overrides", () => {
    expect(refundDecision(order({ hubtel_client_reference: "ref1" }), [led()], NOW)).toEqual({ action: "ledger", ref: "ref1", needsForce: false })
    expect(refundDecision(order(), [led({ resolved_by: "admin" })], NOW)).toMatchObject({ action: "ledger", needsForce: true })
  })
  it("blocks when a refund was already claimed, or the order has not caught up with a failed ledger row", () => {
    expect(refundDecision(order(), [led({ refund_claimed_at: old })], NOW).action).toBe("blocked")
    expect(refundDecision(order({ status: "pending" }), [led()], NOW).action).toBe("blocked")
  })
  it("blocks when the order's ledger ref is missing from the ledger, and while processing", () => {
    expect(refundDecision(order({ hubtel_client_reference: "gone" }), [], NOW).action).toBe("blocked")
    expect(refundDecision(order({ status: "processing" }), [], NOW).action).toBe("blocked")
  })
  it("handles orders that never reached Hubtel", () => {
    expect(refundDecision(order({ status: "failed" }), [], NOW)).toEqual({ action: "direct", markFailedFirst: false })
    expect(refundDecision(order({ status: "pending" }), [], NOW)).toEqual({ action: "direct", markFailedFirst: true })
    // "Not sent" notes do not bypass the grace period.
    expect(refundDecision(order({ status: "pending", notes: "Not sent: x", updated_at: new Date(NOW - 1000).toISOString() }), [], NOW).action).toBe("blocked")
    expect(refundDecision(order({ status: "pending", updated_at: new Date(NOW - UNSENT_GRACE_MS + 5000).toISOString() }), [], NOW).action).toBe("blocked")
  })
})

function fakeDeps(o: Partial<BillRefundDeps> & { order?: RefundOrder | null; ledger?: LedgerFact[] } = {}) {
  const calls: string[] = []
  const deps: BillRefundDeps = {
    getOrder: async () => (o.order === undefined ? order() : o.order),
    getLedger: async () => o.ledger ?? [],
    markFailed: async () => { calls.push("markFailed"); return 1 },
    refundViaLedger: async ref => { calls.push(`ledger:${ref}`); return { ok: true, message: "done" } },
    refundDirect: async () => { calls.push("direct"); return { refunded: true, message: "credited" } },
    revertToProcessing: async (_id, ref, from) => { calls.push("revert:" + ref + ":" + from); return 1 },
    releaseStuckClaim: async () => { calls.push("release"); return 1 },
    alert: async () => { calls.push("alert") },
    now: () => NOW,
    ...o,
  }
  return { deps, calls }
}

describe("executeBillRefund", () => {
  it("404s a missing order", async () => {
    const { deps } = fakeDeps({ order: null })
    expect((await executeBillRefund(deps, "o1", "n", false)).status).toBe(404)
  })
  it("fails closed when the ledger cannot be read", async () => {
    const { deps, calls } = fakeDeps({ getLedger: async () => { throw new Error("db") } })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r.status).toBe(503); expect(calls).toEqual([])
  })
  it("refuses while Hubtel is pending and never touches money", async () => {
    const { deps, calls } = fakeDeps({ order: order({ hubtel_client_reference: "ref1", status: "processing" }), ledger: [led({ state: "pending" })] })
    const r = await executeBillRefund(deps, "o1", "n", true)
    expect(r.ok).toBe(false); expect(calls).toEqual([])
  })
  it("routes failed ledger rows through adminRefund, requiring force for overrides", async () => {
    const a = fakeDeps({ ledger: [led()] })
    expect(await executeBillRefund(a.deps, "o1", "n", false)).toMatchObject({ ok: true, mode: "ledger" })
    expect(a.calls).toEqual(["ledger:ref1"])
    const b = fakeDeps({ ledger: [led({ resolved_by: "x" })] })
    expect((await executeBillRefund(b.deps, "o1", "n", false)).ok).toBe(false)
    expect(b.calls).toEqual([])
    const c = fakeDeps({ ledger: [led({ resolved_by: "x" })] })
    expect((await executeBillRefund(c.deps, "o1", "n", true)).ok).toBe(true)
  })
  it("marks unsent pending orders failed first, then refunds directly", async () => {
    const { deps, calls } = fakeDeps({ order: order({ status: "pending", notes: "Not sent: boom" }) })
    expect(await executeBillRefund(deps, "o1", "n", false)).toMatchObject({ ok: true, mode: "direct" })
    expect(calls).toEqual(["markFailed", "direct"])
  })
  it("does not refund if the guarded failed-flip lost a race", async () => {
    const { deps, calls } = fakeDeps({ order: order({ status: "pending", notes: "Not sent: x" }), markFailed: async () => 0 })
    expect((await executeBillRefund(deps, "o1", "n", false)).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("aborts and reverts the flip if a ledger row appears after it", async () => {
    let n = 0
    const { deps, calls } = fakeDeps({ order: order({ status: "pending", updated_at: old }), getLedger: async () => (n++ === 0 ? [] : [led({ state: "pending", client_reference: "RX" })]) })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r.ok).toBe(false); expect(calls).toEqual(["markFailed", "revert:RX:failed", "alert"])
  })
  it("reverts (no ref) and aborts when the post-flip ledger read fails; alerts loudly if the revert fails", async () => {
    let n = 0
    const a = fakeDeps({ order: order({ status: "pending" }), getLedger: async () => { if (n++ === 0) return []; throw new Error("db") } })
    expect((await executeBillRefund(a.deps, "o1", "n", false)).ok).toBe(false)
    expect(a.calls).toEqual(["markFailed", "revert:null:failed", "alert"])
    let k = 0
    const b = fakeDeps({ order: order({ status: "pending" }), getLedger: async () => (k++ === 0 ? [] : [led({ state: "pending" })]), revertToProcessing: async () => 0 })
    const r = await executeBillRefund(b.deps, "o1", "n", false)
    expect(r.ok).toBe(false); expect(r.message).toMatch(/could not be restored/i)
    expect(b.calls).toEqual(["markFailed", "alert"])
  })
  it("reports an unknown outcome when the direct refund throws", async () => {
    const { deps } = fakeDeps({ refundDirect: async () => { throw new Error("net") } })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r.status).toBe(502); expect(r.message).toContain("UNKNOWN")
  })
})

describe("isStuckClaim", () => {
  const stuck = (o: Partial<RefundOrder> = {}) => order({ status: "processing", notes: "Dispatching…", updated_at: new Date(NOW - STUCK_CLAIM_MS).toISOString(), ...o })
  it("boundaries: 4m59s false, 5m true", () => {
    expect(isStuckClaim(stuck({ updated_at: new Date(NOW - (STUCK_CLAIM_MS - 1000)).toISOString() }), [], NOW)).toBe(false)
    expect(isStuckClaim(stuck(), [], NOW)).toBe(true)
  })
  it("false with a ledger row, a ref, another note, unpaid or non-processing", () => {
    expect(isStuckClaim(stuck(), [led()], NOW)).toBe(false)
    expect(isStuckClaim(stuck({ hubtel_client_reference: "r" }), [], NOW)).toBe(false)
    expect(isStuckClaim(stuck({ notes: "Outcome unknown" }), [], NOW)).toBe(false)
    expect(isStuckClaim(stuck({ payment_status: "unpaid" }), [], NOW)).toBe(false)
    expect(isStuckClaim(stuck({ status: "pending" }), [], NOW)).toBe(false)
  })
  it("refundDecision and canDispatch treat it as eligible; a young claim stays blocked", () => {
    expect(refundDecision(stuck(), [], NOW)).toEqual({ action: "direct", markFailedFirst: true, releaseStuck: true })
    expect(refundDecision(stuck({ updated_at: new Date(NOW - 1000).toISOString() }), [], NOW).action).toBe("blocked")
    expect(canDispatch(stuck(), true)).toBe(true)
    expect(canDispatch(stuck())).toBe(false)
  })
})

describe("executeBillRefund with a stuck claim", () => {
  const stuckOrder = () => order({ status: "processing", notes: "Dispatching…", updated_at: new Date(NOW - STUCK_CLAIM_MS - 1000).toISOString() })
  it("releases, flips to failed, then refunds directly (no 60s grace)", async () => {
    const { deps, calls } = fakeDeps({ order: stuckOrder() })
    expect(await executeBillRefund(deps, "o1", "n", false)).toMatchObject({ ok: true, mode: "direct" })
    expect(calls).toEqual(["release", "markFailed", "direct"])
  })
  it("aborts back to processing if a ledger row appears right after the release", async () => {
    let n = 0
    const { deps, calls } = fakeDeps({ order: stuckOrder(), getLedger: async () => (n++ === 0 ? [] : [led({ state: "pending", client_reference: "RZ" })]) })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r.ok).toBe(false); expect(calls).toEqual(["release", "revert:RZ:pending", "alert"])
  })
})

describe("releaseStuckClaimRow", () => {
  it("guards the release fully in SQL and returns the row count", async () => {
    const chain: [string, ...unknown[]][] = []
    const q: any = new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => {
      chain.push([name, ...args])
      return name === "select" ? Promise.resolve({ data: [{ id: "o1" }], error: null }) : q
    } })
    const db: any = { from: (t: string) => { chain.push(["from", t]); return q } }
    expect(await releaseStuckClaimRow(db, "o1", "admin1", NOW)).toBe(1)
    const has = (...e: unknown[]) => expect(chain).toContainEqual(e)
    has("from", "hubtel_bill_orders")
    has("eq", "id", "o1"); has("eq", "status", "processing"); has("eq", "payment_status", "paid")
    has("is", "hubtel_client_reference", null); has("like", "notes", "Dispatching%")
    has("lt", "updated_at", new Date(NOW - STUCK_CLAIM_MS).toISOString())
    const upd = chain.find(c => c[0] === "update")![1] as any
    expect(upd).toMatchObject({ status: "pending", notes: "Released stuck dispatch claim by admin admin1" })
  })
})

describe("stuck release aborts", () => {
  const stuckOrder = () => order({ status: "processing", notes: "Dispatching…", updated_at: new Date(NOW - STUCK_CLAIM_MS - 1000).toISOString() })
  it("0-row release aborts the refund with no further action", async () => {
    const { deps, calls } = fakeDeps({ order: stuckOrder(), releaseStuckClaim: async () => { calls0.push("release"); return 0 } })
    const calls0: string[] = []
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r).toMatchObject({ ok: false, status: 409, message: "Claim is no longer stuck" })
    expect(calls).toEqual([]); expect(calls0).toEqual(["release"])
  })
  it("ledger read failing after the release restores, alerts and aborts (released flagged)", async () => {
    let n = 0
    const { deps, calls } = fakeDeps({ order: stuckOrder(), getLedger: async () => { if (n++ === 0) return []; throw new Error("db") } })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r).toMatchObject({ ok: false, released: true })
    expect(calls).toEqual(["release", "revert:null:pending", "alert"])
  })
  it("a successful stuck refund reports released", async () => {
    const { deps } = fakeDeps({ order: stuckOrder() })
    expect(await executeBillRefund(deps, "o1", "n", false)).toMatchObject({ ok: true, released: true })
  })
  it("refuses a storefront order before touching anything (no wallet; refunded on /admin/refunds)", async () => {
    const { deps, calls } = fakeDeps({ order: order({ status: "pending", channel: "storefront" }) })
    const r = await executeBillRefund(deps, "o1", "n", false)
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(r.message).toContain("/admin/refunds")
    expect(calls).toEqual([])
  })
})
