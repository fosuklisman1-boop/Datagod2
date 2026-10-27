import { describe, it, expect } from "vitest"
import { executeBundleDispatch, executeBundleRetry, type BundleDispatchDeps, type BundleDispatchOrder, type BundleRetryDeps, type BundleRetryOrder } from "./admin-dispatch"
import type { LedgerFact } from "@/lib/bills/admin"

const NOW = Date.parse("2026-10-13T12:00:00Z")

describe("executeBundleRetry", () => {
  const failedOrder = (o: Partial<BundleRetryOrder> = {}): BundleRetryOrder => ({
    id: "o1", reference_code: "BND-1", status: "failed", payment_status: "paid", notes: null, failure_reason: "Invalid meter",
    updated_at: new Date(NOW - 10 * 60_000).toISOString(), ...o,
  })
  const failedRow = (o: Partial<LedgerFact> = {}): LedgerFact => ({ client_reference: "RX", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "", ...o })

  function makeRetry(o: {
    order?: BundleRetryOrder | null; ledger?: () => Promise<LedgerFact[]>; reopen?: number; revert?: number; sent?: string
    /** Replaces the 2nd getOrder call (the re-read after reopen, before dispatch). */
    reread?: () => Promise<BundleRetryOrder | null>
  } = {}) {
    const calls: string[] = []
    const revertReasons: Array<string | null | undefined> = []
    let current = o.order === undefined ? failedOrder() : o.order
    let reads = 0
    const d: BundleRetryDeps = {
      getOrder: async () => { reads++; if (reads === 2 && o.reread) return o.reread(); return current },
      getLedger: o.ledger ?? (async () => [failedRow()]),
      reopen: async (_i, note) => { calls.push("reopen:" + note); if (o.reopen === 0) return 0; if (current) current = { ...current, status: "pending", failure_reason: null }; return 1 },
      revertToFailed: async (_i, note, failureReason) => { calls.push("revert:" + note); revertReasons.push(failureReason); return o.revert ?? 1 },
      dispatch: async () => { calls.push("dispatch"); if (current && o.sent === "pending") current = { ...current, status: "pending", notes: "Not sent: Hubtel paused" }; return o.sent ?? "processing" },
      alert: async (_m, urgent) => { calls.push(urgent ? "alert:urgent" : "alert") },
      now: () => NOW,
    }
    return { d, calls, revertReasons }
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

  // Item 1: only processing/completed count as a successful retry.
  it('ok true when dispatch returns "completed"', async () => {
    const { d } = makeRetry({ sent: "completed" })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: true, status: 200, orderStatus: "completed", message: "Retried; order is completed" })
  })
  it('ok false when dispatch returns "failed"', async () => {
    const { d } = makeRetry({ sent: "failed" })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: false, status: 200, orderStatus: "failed", message: "Retry did not go through; order is failed" })
  })
  it('ok false when dispatch returns "refunding"', async () => {
    const { d } = makeRetry({ sent: "refunding" })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: false, status: 200, orderStatus: "refunding", message: "Retry did not go through; order is refunding" })
  })

  // Item 2: the re-read after reopen must never leave the order silently pending.
  it("503 and reverts when the re-read after reopen throws", async () => {
    const { d, calls } = makeRetry({ reread: async () => { throw new Error("db down") } })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: false, status: 503, message: "Could not re-read the order; retry cancelled" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted"])
  })
  it("500 + urgent alert when the re-read throws and the revert changes 0 rows", async () => {
    const { d, calls } = makeRetry({ revert: 0, reread: async () => { throw new Error("db down") } })
    const out = await executeBundleRetry(d, "o1")
    expect(out).toMatchObject({ ok: false, status: 500 })
    expect(calls).toContain("alert:urgent")
    expect(calls).not.toContain("dispatch")
  })
  it("500 + urgent alert when the re-read throws and the revert itself throws", async () => {
    const { d, calls } = makeRetry({ reread: async () => { throw new Error("db down") } })
    d.revertToFailed = async () => { calls.push("revert:threw"); throw new Error("db down") }
    expect((await executeBundleRetry(d, "o1")).status).toBe(500)
    expect(calls).toContain("alert:urgent")
  })
  it("503 and reverts when the re-read after reopen returns null", async () => {
    const { d, calls } = makeRetry({ reread: async () => null })
    expect(await executeBundleRetry(d, "o1")).toMatchObject({ ok: false, status: 503, message: "Could not re-read the order; retry cancelled" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted"])
  })
  it("500 + urgent alert when the re-read returns null and the revert changes 0 rows", async () => {
    const { d, calls } = makeRetry({ revert: 0, reread: async () => null })
    expect((await executeBundleRetry(d, "o1")).status).toBe(500)
    expect(calls).toContain("alert:urgent")
  })

  // Item 3: a revert restores the original failure reason (reopen cleared it).
  it("passes the original failure reason on an abort revert", async () => {
    let n = 0
    const { d, revertReasons } = makeRetry({ ledger: async () => (n++ === 0 ? [failedRow()] : [failedRow({ refund_claimed_at: "t" })]) })
    await executeBundleRetry(d, "o1")
    expect(revertReasons).toEqual(["Invalid meter"])
  })
  it("passes the original failure reason on the re-read revert and the not-sent revert", async () => {
    const a = makeRetry({ reread: async () => null })
    await executeBundleRetry(a.d, "o1")
    expect(a.revertReasons).toEqual(["Invalid meter"])
    const b = makeRetry({ sent: "pending" })
    await executeBundleRetry(b.d, "o1")
    expect(b.revertReasons).toEqual(["Invalid meter"])
  })
  it("passes null as the failure reason when the order had none", async () => {
    const { d, revertReasons } = makeRetry({ order: failedOrder({ failure_reason: null }), reread: async () => null })
    await executeBundleRetry(d, "o1")
    expect(revertReasons).toEqual([null])
  })
})

describe("executeBundleDispatch", () => {
  const ago = (ms: number) => new Date(NOW - ms).toISOString()
  const unsent = (o: Partial<BundleDispatchOrder> = {}): BundleDispatchOrder => ({
    id: "o1", reference_code: "BND-1", status: "pending", payment_status: "paid", hubtel_client_reference: null, notes: null, updated_at: ago(10 * 60_000), ...o,
  })
  const row = (o: Partial<LedgerFact> = {}): LedgerFact => ({ client_reference: "RX", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "", ...o })

  function make(o: {
    order?: BundleDispatchOrder | null; ledgers?: Array<LedgerFact[] | "throw">; release?: number; restore?: number; sent?: string
  } = {}) {
    const calls: string[] = []
    const ledgers = [...(o.ledgers ?? [[]])]
    let order = o.order === undefined ? unsent() : o.order
    const d: BundleDispatchDeps = {
      getOrder: async () => order,
      getLedger: async () => { const l = ledgers.length > 1 ? ledgers.shift()! : ledgers[0]; if (l === "throw") throw new Error("db down"); return l },
      // Like the real guarded update: the row becomes pending with a FRESH updated_at.
      releaseStuckClaim: async () => { calls.push("release"); if ((o.release ?? 1) > 0 && order) order = { ...order, status: "pending", updated_at: new Date(NOW).toISOString() }; return o.release ?? 1 },
      restoreProcessing: async (_i, ref) => { calls.push("restore:" + ref); return o.restore ?? 1 },
      dispatch: async () => { calls.push("dispatch"); return o.sent ?? "processing" },
      alert: async (_m, urgent) => { calls.push(urgent ? "alert:urgent" : "alert") },
      now: () => NOW,
    }
    return { d, calls }
  }
  const stuck = (o: Partial<BundleDispatchOrder> = {}) => unsent({ status: "processing", notes: "Dispatching", updated_at: ago(6 * 60_000), ...o })

  it("dispatches a paid pending order that never reached Hubtel", async () => {
    const { d, calls } = make()
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ ok: true, status: 200, orderStatus: "processing" })
    expect(calls).toEqual(["dispatch"])
  })
  it("404 when missing; 503 when the ledger cannot be read", async () => {
    expect((await executeBundleDispatch(make({ order: null }).d, "o1")).status).toBe(404)
    const { d, calls } = make({ ledgers: ["throw"] })
    expect((await executeBundleDispatch(d, "o1")).status).toBe(503)
    expect(calls).toEqual([])
  })
  it("409 when ANY ledger row exists, even a failed one (that is Retry's job)", async () => {
    for (const ledger of [[row()], [row({ state: "pending" })], [row({ state: "fulfilled" })]]) {
      const { d, calls } = make({ ledgers: [ledger] })
      expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
  })
  it("409 unless paid + pending + no Hubtel reference", async () => {
    for (const o of [unsent({ status: "failed" }), unsent({ status: "processing" }), unsent({ status: "completed" }), unsent({ payment_status: "unpaid" }), unsent({ hubtel_client_reference: "HX" }), unsent({ status: "refunding" })]) {
      const { d, calls } = make({ order: o })
      expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
  })
  it("409 for an order updated inside the grace window (it may be mid-dispatch)", async () => {
    const { d, calls } = make({ order: unsent({ updated_at: ago(30_000) }) })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ status: 409, message: expect.stringMatching(/moments ago/) })
    expect(calls).toEqual([])
  })
  it("409 when the updated_at is unparseable", async () => {
    const { d, calls } = make({ order: unsent({ updated_at: "garbage" }) })
    expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("a stuck claim is released, the ledger re-read empty, then dispatched", async () => {
    const { d, calls } = make({ order: stuck(), ledgers: [[], []] })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ ok: true, released: true, orderStatus: "processing" })
    expect(calls).toEqual(["release", "dispatch"])
  })
  it("a young dispatch claim is not releasable", async () => {
    const { d, calls } = make({ order: stuck({ updated_at: ago(60_000) }) })
    expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("409 when the release changes 0 rows", async () => {
    const { d, calls } = make({ order: stuck(), release: 0 })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ status: 409, message: "Claim is no longer stuck" })
    expect(calls).toEqual(["release"])
  })
  it("a Hubtel row appearing after the release puts the order back to processing and does not dispatch", async () => {
    const { d, calls } = make({ order: stuck(), ledgers: [[], [row({ state: "pending", client_reference: "RZ" })]] })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ ok: false, status: 409 })
    expect(calls).toEqual(["release", "restore:RZ", "alert"])
  })
  it("an unreadable ledger after the release restores processing too", async () => {
    const { d, calls } = make({ order: stuck(), ledgers: [[], "throw"] })
    expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual(["release", "restore:null", "alert"])
  })
  it("500 + urgent alert when the restore also fails", async () => {
    const { d, calls } = make({ order: stuck(), ledgers: [[], [row({ state: "pending" })]], restore: 0 })
    expect((await executeBundleDispatch(d, "o1")).status).toBe(500)
    expect(calls).toEqual(["release", "restore:RX", "alert:urgent"])
  })
  it("reports an order Hubtel failed straight away as not ok", async () => {
    const { d } = make({ sent: "failed" })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ ok: false, status: 200, orderStatus: "failed", message: expect.stringMatching(/did not go through/) })
  })
  it("409 when, after a release, the order was claimed by someone else", async () => {
    const { d, calls } = make({ order: stuck(), ledgers: [[], []] })
    const orig = d.getOrder
    let reads = 0
    d.getOrder = async id => { reads++; const o = await orig(id); return reads >= 2 && o ? { ...o, status: "processing" } : o }
    expect((await executeBundleDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual(["release"])
  })
  it("reports a still-pending result as not ok", async () => {
    const { d } = make({ sent: "pending" })
    expect(await executeBundleDispatch(d, "o1")).toMatchObject({ ok: false, status: 200, orderStatus: "pending" })
  })
})
