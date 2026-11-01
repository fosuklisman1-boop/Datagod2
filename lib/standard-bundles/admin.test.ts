import { describe, it, expect, vi } from "vitest"
import {
  ADMIN_ORDER_COLUMNS, ADMIN_ORDER_COLUMNS_BASE, applyOrderFilters, fetchSpecialGroupSizes, selectOrdersPage, specialBadgeLabel,
  bundleCanDispatch, bundleCanRetry, bundleRefundDecision, executeBundleRefund, fetchBundleLedgerByOrders, isStuckClaim, parseOrderFilters, refundAmountOf, refundMessageOf, releaseStuckClaimRow, STUCK_CLAIM_MS, UNSENT_GRACE_MS,
  type BundleRefundDeps, type RefundOrder,
} from "./admin"
import type { LedgerFact } from "@/lib/bills/admin"

const NOW = Date.parse("2026-10-13T12:00:00Z")
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const facts = (o: Partial<RefundOrder> = {}): RefundOrder => ({
  id: "o1", reference_code: "BND-1", user_id: "u1", amount: 5, network: "MTN", bundle_display: "1GB", beneficiary_phone: "233240000000",
  status: "pending", payment_status: "paid", hubtel_client_reference: null, notes: null, updated_at: ago(10 * 60_000), ...o,
})

describe("parseOrderFilters", () => {
  it("drops unknown values and strips or() syntax", () => {
    const f = parseOrderFilters(new URLSearchParams("q=a,b(c)&status=bogus&network=VODA&from=2026-13-45&to=2026-10-02"))
    expect(f).toEqual({ q: "a b c", status: undefined, network: undefined, from: undefined, to: "2026-10-02" })
  })
  it("accepts valid status and network", () => {
    expect(parseOrderFilters(new URLSearchParams("status=failed&network=AT"))).toMatchObject({ status: "failed", network: "AT" })
  })
  it("accepts a Special group id only when it is a UUID (lower-cased)", () => {
    const g = "0F8FAD5B-D9CB-469F-A165-70867728950E"
    expect(parseOrderFilters(new URLSearchParams(`group=${g}`)).group).toBe(g.toLowerCase())
    for (const bad of ["x", "1,2", "0f8fad5b-d9cb-469f-a165-70867728950e)", "' or 1=1", ""]) {
      expect(parseOrderFilters(new URLSearchParams(`group=${encodeURIComponent(bad)}`)).group).toBeUndefined()
    }
  })
})

describe("applyOrderFilters — Special group", () => {
  const rec = () => {
    const calls: string[] = []
    const q: any = new Proxy({}, { get: (_t, p: string) => (...a: any[]) => { calls.push(`${p}:${a.join("=")}`); return q } })
    return { q, calls }
  }
  it("filters on special_group_id when a group is given, and not otherwise", () => {
    const a = rec()
    applyOrderFilters(a.q, { group: "0f8fad5b-d9cb-469f-a165-70867728950e" })
    expect(a.calls).toEqual(["eq:special_group_id=0f8fad5b-d9cb-469f-a165-70867728950e"])
    const b = rec()
    applyOrderFilters(b.q, { status: "failed" })
    expect(b.calls).toEqual(["eq:status=failed"])
  })
})

describe("specialBadgeLabel", () => {
  it("Special i/N, or Special i when the size is unknown; null for a normal order", () => {
    expect(specialBadgeLabel({ special_group_id: "g", special_index: 2 }, 3)).toBe("Special 2/3")
    expect(specialBadgeLabel({ special_group_id: "g", special_index: 2 }, undefined)).toBe("Special 2")
    expect(specialBadgeLabel({ special_group_id: null, special_index: null }, 3)).toBeNull()
    expect(specialBadgeLabel({}, undefined)).toBeNull()
  })
})

describe("selectOrdersPage (pre-0141 fallback)", () => {
  const ok = { data: [{ id: "o1" }], error: null, count: 1 }
  const missing = { data: null, error: { code: "42703", message: "column special_group_id does not exist" }, count: null }
  it("selects the Special columns first", async () => {
    const cols: string[] = []
    expect(await selectOrdersPage(async c => { cols.push(c); return ok }, {})).toBe(ok)
    expect(cols).toEqual([ADMIN_ORDER_COLUMNS])
    expect(ADMIN_ORDER_COLUMNS).toContain("special_group_id, special_index")
    expect(ADMIN_ORDER_COLUMNS).not.toContain("idempotency_key")
  })
  it("42703 without a group filter retries once with the base columns", async () => {
    const cols: string[] = []
    const res = await selectOrdersPage(async c => { cols.push(c); return cols.length === 1 ? missing : ok }, {})
    expect(res).toBe(ok)
    expect(cols).toEqual([ADMIN_ORDER_COLUMNS, ADMIN_ORDER_COLUMNS_BASE])
    expect(ADMIN_ORDER_COLUMNS_BASE).not.toContain("special_")
  })
  it("42703 with a group filter means no group can exist yet: null (empty page), no retry", async () => {
    const cols: string[] = []
    expect(await selectOrdersPage(async c => { cols.push(c); return missing }, { group: "0f8fad5b-d9cb-469f-a165-70867728950e" })).toBeNull()
    expect(cols).toHaveLength(1)
  })
  it("any other error is returned as is (the route throws it)", async () => {
    const other = { data: null, error: { code: "57014", message: "timeout" }, count: null }
    const cols: string[] = []
    expect(await selectOrdersPage(async c => { cols.push(c); return other }, {})).toBe(other)
    expect(cols).toHaveLength(1)
  })
})

describe("fetchSpecialGroupSizes", () => {
  function countDb(counts: Record<string, number | Error>) {
    const seen: string[] = []
    const db: any = {
      from: (t: string) => {
        let g = ""
        const chain: any = {
          select: (_c: string, o: any) => { expect(t).toBe("hubtel_data_orders"); expect(o).toEqual({ count: "exact", head: true }); return chain },
          eq: (c: string, v: string) => { expect(c).toBe("special_group_id"); g = v; seen.push(v); return chain },
          then: (res: any) => {
            const c = counts[g]
            return res(c instanceof Error ? { count: null, error: c } : { count: c, error: null })
          },
        }
        return chain
      },
    }
    return { db, seen }
  }
  it("one head count per distinct group; failures are left out (badge shows i only)", async () => {
    const { db, seen } = countDb({ A: 3, B: new Error("boom"), C: 15 })
    const m = await fetchSpecialGroupSizes(db, ["A", "A", "B", "C", null, undefined])
    expect([...seen].sort()).toEqual(["A", "B", "C"])
    expect(m.get("A")).toBe(3)
    expect(m.has("B")).toBe(false)
    expect(m.get("C")).toBe(15)
  })
  it("no groups -> no queries", async () => {
    const { db, seen } = countDb({})
    expect((await fetchSpecialGroupSizes(db, [])).size).toBe(0)
    expect(seen).toEqual([])
  })
})

describe("bundleRefundDecision", () => {
  it("allows an old pending+paid order with no ledger row", () => {
    expect(bundleRefundDecision(facts(), 0, NOW)).toEqual({ action: "direct", releaseStuck: false })
  })
  it("blocks a pending order inside the 60 s grace", () => {
    expect(bundleRefundDecision(facts({ updated_at: ago(UNSENT_GRACE_MS - 1000) }), 0, NOW).action).toBe("blocked")
  })
  it("blocks any order with a ledger row and points at the review queue", () => {
    const d = bundleRefundDecision(facts({ status: "failed" }), 1, NOW)
    expect(d).toMatchObject({ action: "blocked", reviewQueue: true })
  })
  it("blocks unpaid, completed, refunded", () => {
    expect(bundleRefundDecision(facts({ payment_status: "unpaid" }), 0, NOW).action).toBe("blocked")
    expect(bundleRefundDecision(facts({ status: "completed" }), 0, NOW).action).toBe("blocked")
    expect(bundleRefundDecision(facts({ status: "refunded", payment_status: "refunded" }), 0, NOW).action).toBe("blocked")
  })
  it("blocks a hubtel reference without a ledger row", () => {
    expect(bundleRefundDecision(facts({ hubtel_client_reference: "x" }), 0, NOW).action).toBe("blocked")
  })
  it("releases a stuck claim only after 5 minutes", () => {
    const stuck = facts({ status: "processing", notes: "Dispatching…", updated_at: ago(STUCK_CLAIM_MS + 1000) })
    expect(bundleRefundDecision(stuck, 0, NOW)).toEqual({ action: "direct", releaseStuck: true })
    const fresh = facts({ status: "processing", notes: "Dispatching…", updated_at: ago(60_000) })
    expect(bundleRefundDecision(fresh, 0, NOW).action).toBe("blocked")
    expect(isStuckClaim(fresh, NOW)).toBe(false)
    expect(bundleRefundDecision(facts({ status: "processing", notes: "Outcome unknown" }), 0, NOW).action).toBe("blocked")
  })
})

describe("releaseStuckClaimRow", () => {
  it("applies every SQL guard", async () => {
    const calls: string[] = []
    const chain: any = {
      update: (p: any) => { calls.push(`update:${p.status}`); return chain },
      eq: (c: string, v: any) => { calls.push(`eq:${c}=${v}`); return chain },
      is: (c: string, v: any) => { calls.push(`is:${c}=${v}`); return chain },
      like: (c: string, v: any) => { calls.push(`like:${c}=${v}`); return chain },
      lt: (c: string) => { calls.push(`lt:${c}`); return chain },
      select: () => Promise.resolve({ data: [{ id: "o1" }], error: null }),
    }
    const n = await releaseStuckClaimRow({ from: () => chain } as any, "o1", "admin", NOW)
    expect(n).toBe(1)
    expect(calls).toEqual(expect.arrayContaining([
      "update:pending", "eq:id=o1", "eq:status=processing", "eq:payment_status=paid", "is:hubtel_client_reference=null", "like:notes=Dispatching%", "lt:updated_at",
    ]))
  })
})

describe("fetchBundleLedgerByOrders", () => {
  it("filters on order_table = hubtel_data_orders and groups rows per order", async () => {
    const calls: string[] = []
    const rows = [
      { order_id: "o1", client_reference: "R2", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2026-10-13T11:00:00Z" },
      { order_id: "o1", client_reference: "R1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2026-10-13T10:00:00Z" },
    ]
    const chain: any = {
      select: () => chain,
      eq: (c: string, v: any) => { calls.push(`eq:${c}=${v}`); return chain },
      in: (c: string, v: any[]) => { calls.push(`in:${c}=${v.join(",")}`); return chain },
      order: (c: string, o: any) => { calls.push(`order:${c}:${o.ascending}`); return Promise.resolve({ data: rows, error: null }) },
    }
    const map = await fetchBundleLedgerByOrders({ from: (t: string) => { calls.push(`from:${t}`); return chain } } as any, ["o1"])
    expect(calls).toEqual(["from:hubtel_cs_transactions", "eq:order_table=hubtel_data_orders", "in:order_id=o1", "order:created_at:false"])
    expect(map.get("o1")?.map(r => r.client_reference)).toEqual(["R2", "R1"])
  })
  it("throws on a DB error", async () => {
    const chain: any = { select: () => chain, eq: () => chain, in: () => chain, order: () => Promise.resolve({ data: null, error: new Error("db down") }) }
    await expect(fetchBundleLedgerByOrders({ from: () => chain } as any, ["o1"])).rejects.toThrow("db down")
  })
})

describe("bundleCanDispatch", () => {
  it("is true for a paid pending order with no reference, no ledger and an age past the grace window", () => {
    expect(bundleCanDispatch(facts(), 0, NOW)).toBe(true)
  })
  it("is true for a stuck claim, false for a young one", () => {
    expect(bundleCanDispatch(facts({ status: "processing", notes: "Dispatching", updated_at: ago(STUCK_CLAIM_MS + 1000) }), 0, NOW)).toBe(true)
    expect(bundleCanDispatch(facts({ status: "processing", notes: "Dispatching", updated_at: ago(60_000) }), 0, NOW)).toBe(false)
  })
  it("is false with any ledger row, a reference, inside the grace window, unpaid, or in another status", () => {
    expect(bundleCanDispatch(facts(), 1, NOW)).toBe(false)
    expect(bundleCanDispatch(facts({ hubtel_client_reference: "HX" }), 0, NOW)).toBe(false)
    expect(bundleCanDispatch(facts({ updated_at: ago(UNSENT_GRACE_MS - 1000) }), 0, NOW)).toBe(false)
    expect(bundleCanDispatch(facts({ payment_status: "unpaid" }), 0, NOW)).toBe(false)
    for (const status of ["failed", "completed", "refunded", "refunding", "processing"]) expect(bundleCanDispatch(facts({ status }), 0, NOW)).toBe(false)
  })
})

describe("bundleCanRetry", () => {
  const failedRow = (o: Partial<LedgerFact> = {}): LedgerFact => ({ client_reference: "RX", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "", ...o })
  it("is true for a failed+paid order whose ledger rows are all failed", () => {
    expect(bundleCanRetry({ status: "failed", payment_status: "paid" }, [failedRow(), failedRow()])).toBe(true)
  })
  it("is false with no ledger, when unpaid, or when any row has resolved_by", () => {
    expect(bundleCanRetry({ status: "failed", payment_status: "paid" }, [])).toBe(false)
    expect(bundleCanRetry({ status: "failed", payment_status: "unpaid" }, [failedRow()])).toBe(false)
    expect(bundleCanRetry({ status: "failed", payment_status: "paid" }, [failedRow(), failedRow({ resolved_by: "admin" })])).toBe(false)
  })
})

function deps(over: Partial<BundleRefundDeps> & { order?: RefundOrder; ledger?: number[] } = {}): BundleRefundDeps & { log: string[] } {
  const log: string[] = []
  const ledger = [...(over.ledger ?? [0, 0])]
  const order = over.order ?? facts()
  const d: BundleRefundDeps = {
    getOrder: async () => order,
    ledgerCount: async () => ledger.length > 1 ? ledger.shift()! : ledger[0],
    releaseStuckClaim: async () => { log.push("release"); return 1 },
    claimForRefund: async () => { log.push("claim"); return 1 },
    revertToProcessing: async (_id, ref) => { log.push(`revert:${ref}`); return 1 },
    ledgerRef: async () => "HCS-REF",
    notifyRefunded: async () => { log.push("notify") },
    creditWallet: async () => { log.push("credit") },
    markRefunded: async () => { log.push("refunded"); return 1 },
    alert: async () => { log.push("alert") },
    now: () => NOW,
    ...over,
  }
  return Object.assign(d, { log })
}

describe("executeBundleRefund", () => {
  it("refuses a storefront order before touching anything (no wallet; refunded on /admin/refunds)", async () => {
    const d = deps({ order: facts({ channel: "storefront", user_id: null as unknown as string }) })
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r).toMatchObject({ ok: false, status: 409 })
    expect(r.message).toContain("/admin/refunds")
    expect(d.log).toEqual([])
  })
  it("an api row (wallet-paid by the API key owner) refunds to that wallet like a dashboard row", async () => {
    const d = deps({ order: facts({ channel: "api" }) })
    expect(await executeBundleRefund(d, "o1", "n")).toMatchObject({ ok: true, status: 200 })
    expect(d.log).toEqual(["claim", "credit", "refunded", "notify"])
  })
  it("claims, rechecks the ledger, credits, then marks refunded", async () => {
    const d = deps()
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r).toMatchObject({ ok: true, status: 200 })
    expect(d.log).toEqual(["claim", "credit", "refunded", "notify"])
  })
  it("never credits when a ledger row appears after the claim; reverts with the Hubtel ref", async () => {
    const d = deps({ ledger: [0, 1] })
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r.ok).toBe(false)
    expect(d.log).toEqual(["claim", "revert:HCS-REF", "alert"])
  })
  it("leaves the order failed (no revert, no credit), 503 + urgent alert, when the post-fence ledger read fails", async () => {
    let calls = 0
    const alerts: boolean[] = []
    const d = deps({
      ledgerCount: async () => { if (++calls === 1) return 0; throw new Error("blip") },
      alert: async (_m, urgent) => { alerts.push(!!urgent) },
    })
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r.status).toBe(503)
    expect(alerts).toEqual([true])
    expect(d.log).toEqual(["claim"])
  })
  it("raises an urgent alert when the revert fails", async () => {
    const d = deps({ ledger: [0, 1], revertToProcessing: async () => 0 })
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r.status).toBe(500)
    expect(d.log).toContain("alert")
    expect(d.log).not.toContain("credit")
  })
  it("a lost double-submit claim does not credit", async () => {
    const d = deps({ claimForRefund: async () => 0 })
    const r = await executeBundleRefund(d, "o1", "n")
    expect(r.status).toBe(409)
    expect(d.log).toEqual([])
  })
  it("fails closed when the ledger cannot be read", async () => {
    const credit = vi.fn()
    const r = await executeBundleRefund(deps({ ledgerCount: async () => { throw new Error("db") }, creditWallet: credit }), "o1", "n")
    expect(r.status).toBe(503)
    expect(credit).not.toHaveBeenCalled()
  })
  it("refuses orders that reached Hubtel", async () => {
    const d = deps({ ledger: [1] })
    expect((await executeBundleRefund(d, "o1", "n")).status).toBe(409)
    expect(d.log).toEqual([])
  })
  it("releases a stuck claim before fencing", async () => {
    const d = deps({ order: facts({ status: "processing", notes: "Dispatching…", updated_at: ago(STUCK_CLAIM_MS + 5000) }) })
    expect((await executeBundleRefund(d, "o1", "n")).released).toBe(true)
    expect(d.log).toEqual(["release", "claim", "credit", "refunded", "notify"])
  })
  it("a failed order retry skips the claim and credits idempotently", async () => {
    const d = deps({ order: facts({ status: "failed" }) })
    expect((await executeBundleRefund(d, "o1", "n")).ok).toBe(true)
    expect(d.log).toEqual(["credit", "refunded", "notify"])
  })
  it("reports an unknown outcome when the credit throws", async () => {
    const r = await executeBundleRefund(deps({ creditWallet: async () => { throw new Error("boom") } }), "o1", "n")
    expect(r.status).toBe(502)
    expect(r.message).toContain("UNKNOWN")
  })
  it("never-sent refund hands creditWallet/notify the order whose refund amount is paid_amount", async () => {
    const credited: number[] = [], texts: string[] = []
    const o = facts({ status: "failed", amount: 10, paid_amount: 9.81 })
    const r = await executeBundleRefund(deps({
      getOrder: async () => o,
      creditWallet: async x => { credited.push(refundAmountOf(x)) },
      notifyRefunded: async x => { texts.push(refundMessageOf(x)) },
    }), "o1", "n")
    expect(r.ok).toBe(true)
    expect(credited).toEqual([9.81])
    expect(texts[0]).toContain("GHS 9.81 for")
  })
  it("refundAmountOf falls back to amount when paid_amount is null (legacy)", () => {
    expect(refundAmountOf(facts({ amount: 10, paid_amount: null }))).toBe(10)
    expect(refundMessageOf(facts({ amount: 10, paid_amount: null }))).toContain("GHS 10.00 for")
  })
})
