import { describe, it, expect } from "vitest"
import { executeBundleRetry, type BundleRetryDeps, type BundleRetryOrder } from "./admin-dispatch"
import type { LedgerFact } from "@/lib/bills/admin"

const NOW = Date.parse("2026-10-13T12:00:00Z")

describe("executeBundleRetry", () => {
  const failedOrder = (o: Partial<BundleRetryOrder> = {}): BundleRetryOrder => ({
    id: "o1", reference_code: "BND-1", status: "failed", payment_status: "paid", notes: null, failure_reason: "Invalid meter",
    updated_at: new Date(NOW - 10 * 60_000).toISOString(), ...o,
  })
  const failedRow = (o: Partial<LedgerFact> = {}): LedgerFact => ({ client_reference: "RX", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "", ...o })

  function makeRetry(o: { order?: BundleRetryOrder | null; ledger?: () => Promise<LedgerFact[]>; reopen?: number; revert?: number; sent?: string } = {}) {
    const calls: string[] = []
    let current = o.order === undefined ? failedOrder() : o.order
    const d: BundleRetryDeps = {
      getOrder: async () => current,
      getLedger: o.ledger ?? (async () => [failedRow()]),
      reopen: async (_i, note) => { calls.push("reopen:" + note); if (o.reopen === 0) return 0; if (current) current = { ...current, status: "pending" }; return 1 },
      revertToFailed: async (_i, note) => { calls.push("revert:" + note); return o.revert ?? 1 },
      dispatch: async () => { calls.push("dispatch"); if (current && o.sent === "pending") current = { ...current, status: "pending", notes: "Not sent: Hubtel paused" }; return o.sent ?? "processing" },
      alert: async (_m, urgent) => { calls.push(urgent ? "alert:urgent" : "alert") },
      now: () => NOW,
    }
    return { d, calls }
  }

  it("retries a paid failed order whose only ledger rows are failed", async () => {
    const { d, calls } = makeRetry()
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: true, orderStatus: "processing" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "dispatch"])
  })
  it("404 when the order is missing", async () => {
    expect((await executeBundleRetry(makeRetry({ order: null }).d, "o1")).status).toBe(404)
  })
  it("409 for every order that is not paid+failed", async () => {
    const cases: Array<[string, string]> = [["pending", "paid"], ["processing", "paid"], ["completed", "paid"], ["refunded", "refunded"], ["failed", "unpaid"]]
    for (const [status, payment_status] of cases) {
      const { d, calls } = makeRetry({ order: failedOrder({ status, payment_status }) })
      expect((await executeBundleRetry(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
  })
  it('409 "never reached Hubtel" when the ledger is empty', async () => {
    const { d, calls } = makeRetry({ ledger: async () => [] })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ status: 409, message: expect.stringMatching(/never reached Hubtel/) })
    expect(calls).toEqual([])
  })
  it("409 for ledger rows that are not failed, have refund_claimed_at, or have resolved_by", async () => {
    for (const ledger of [[failedRow(), failedRow({ state: "pending" })], [failedRow({ refund_claimed_at: "t" })], [failedRow({ resolved_by: "admin" })]]) {
      const { d, calls } = makeRetry({ ledger: async () => ledger })
      expect((await executeBundleRetry(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
  })
  it("503 when the ledger cannot be read", async () => {
    const { d, calls } = makeRetry({ ledger: async () => { throw new Error("db down") } })
    expect((await executeBundleRetry(d, "o1")).status).toBe(503)
    expect(calls).toEqual([])
  })
  it('409 "order changed" when reopen changes 0 rows', async () => {
    const { d, calls } = makeRetry({ reopen: 0 })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ status: 409, message: expect.stringMatching(/order changed/) })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter"])
  })
  it("aborts and restores to failed when the post-reopen ledger now has a refund claim", async () => {
    let n = 0
    const { d, calls } = makeRetry({ ledger: async () => (n++ === 0 ? [failedRow()] : [failedRow({ refund_claimed_at: "t" })]) })
    expect((await executeBundleRetry(d, "o1")).status).toBe(409)
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted"])
  })
  it('puts the order back to failed when dispatch returns "pending"', async () => {
    const { d, calls } = makeRetry({ sent: "pending" })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: false, orderStatus: "failed", message: "Retry not sent: Not sent: Hubtel paused" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "dispatch", "revert:Retry not sent: Not sent: Hubtel paused"])
  })
  it("500 + urgent alert when the abort cannot restore the order", async () => {
    let n = 0
    const { d, calls } = makeRetry({ revert: 0, ledger: async () => (n++ === 0 ? [failedRow()] : [failedRow({ refund_claimed_at: "t" })]) })
    expect((await executeBundleRetry(d, "o1")).status).toBe(500)
    expect(calls).toContain("alert:urgent")
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted", "alert:urgent"])
  })
})
