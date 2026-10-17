import { describe, it, expect } from "vitest"
import { executeBillDispatch, executeBillRetry, type BillDispatchDeps, type BillRetryDeps, type DispatchOrder } from "./admin-dispatch"
import { STUCK_CLAIM_MS, type LedgerFact } from "./admin"

const NOW = Date.parse("2026-10-13T12:00:00Z")
const ord = (o: Partial<DispatchOrder> = {}): DispatchOrder => ({
  id: "o1", reference_code: "BILL-1", status: "pending", payment_status: "paid", hubtel_client_reference: null, notes: null,
  updated_at: new Date(NOW - 10 * 60_000).toISOString(), ...o,
})
const stuck = () => ord({ status: "processing", notes: "Dispatching…", updated_at: new Date(NOW - STUCK_CLAIM_MS).toISOString() })
const row = (state: LedgerFact["state"] = "pending"): LedgerFact => ({ client_reference: "RX", state, refund_claimed_at: null, resolved_by: null, created_at: "" })

function make(o: { order?: DispatchOrder | null; ledger?: () => Promise<LedgerFact[]> } = {}) {
  const calls: string[] = []
  let current = o.order === undefined ? ord() : o.order
  const d: BillDispatchDeps = {
    getOrder: async () => current,
    getLedger: o.ledger ?? (async () => []),
    releaseStuckClaim: async () => { calls.push("release"); if (current) current = { ...current, status: "pending" }; return 1 },
    restoreProcessing: async (_i, ref) => { calls.push("restore:" + ref); return 1 },
    dispatch: async () => { calls.push("dispatch"); return "processing" },
    alert: async () => { calls.push("alert") },
    now: () => NOW,
  }
  return { d, calls }
}

describe("executeBillDispatch", () => {
  it("dispatches a paid pending order", async () => {
    const { d, calls } = make()
    expect(await executeBillDispatch(d, "o1")).toMatchObject({ ok: true, orderStatus: "processing" })
    expect(calls).toEqual(["dispatch"])
  })
  it("404 and non-dispatchable orders", async () => {
    expect((await executeBillDispatch(make({ order: null }).d, "o1")).status).toBe(404)
    expect((await executeBillDispatch(make({ order: ord({ payment_status: "unpaid" }) }).d, "o1")).status).toBe(409)
  })
  it("refuses when a ledger row exists for a non-stuck order", async () => {
    const { d, calls } = make({ ledger: async () => [row()] })
    expect((await executeBillDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("releases a stuck claim then dispatches", async () => {
    const { d, calls } = make({ order: stuck() })
    expect(await executeBillDispatch(d, "o1")).toMatchObject({ ok: true, released: true })
    expect(calls).toEqual(["release", "dispatch"])
  })
  it("does not release a claim younger than 5 minutes", async () => {
    const { d, calls } = make({ order: { ...stuck(), updated_at: new Date(NOW - 1000).toISOString() } })
    expect((await executeBillDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("aborts and restores processing if a ledger row appears after the release", async () => {
    let n = 0
    const { d, calls } = make({ order: stuck(), ledger: async () => (n++ === 0 ? [] : [row()]) })
    const r = await executeBillDispatch(d, "o1")
    expect(r.ok).toBe(false)
    expect(calls).toEqual(["release", "restore:RX", "alert"])
  })
  it("fails closed when the ledger cannot be read", async () => {
    const { d, calls } = make({ ledger: async () => { throw new Error("db") } })
    expect((await executeBillDispatch(d, "o1")).status).toBe(503)
    expect(calls).toEqual([])
  })
})

describe("Ghana Water expiry", () => {
  const water = (ageMin: number, o: Partial<DispatchOrder> = {}) => ord({ biller: "ghana_water", created_at: new Date(NOW - ageMin * 60_000).toISOString(), ...o })
  it("refuses a ghana_water order older than 10 minutes", async () => {
    const { d, calls } = make({ order: water(11) })
    expect(await executeBillDispatch(d, "o1")).toMatchObject({ ok: false, status: 409, message: "Ghana Water verification expired — refund instead" })
    expect(calls).toEqual([])
  })
  it("refuses an old stuck ghana_water claim before releasing it", async () => {
    const { d, calls } = make({ order: water(30, stuck()) })
    expect((await executeBillDispatch(d, "o1")).status).toBe(409)
    expect(calls).toEqual([])
  })
  it("allows a fresh ghana_water order and old orders of other billers", async () => {
    expect((await executeBillDispatch(make({ order: water(5) }).d, "o1")).ok).toBe(true)
    expect((await executeBillDispatch(make({ order: ord({ biller: "dstv", created_at: new Date(NOW - 99 * 60_000).toISOString() }) }).d, "o1")).ok).toBe(true)
  })
  it("measures from verified_at when set (storefront: verified long before the order was created)", async () => {
    const verifiedAt = (min: number) => new Date(NOW - min * 60_000).toISOString()
    const { d, calls } = make({ order: water(2, { verified_at: verifiedAt(11) }) })
    expect(await executeBillDispatch(d, "o1")).toMatchObject({ ok: false, status: 409, message: "Ghana Water verification expired — refund instead" })
    expect(calls).toEqual([])
    expect((await executeBillDispatch(make({ order: water(2, { verified_at: verifiedAt(9) }) }).d, "o1")).ok).toBe(true)
    // null verified_at falls back to created_at
    expect((await executeBillDispatch(make({ order: water(11, { verified_at: null }) }).d, "o1")).status).toBe(409)
  })
})

describe("urgent alerts", () => {
  it("flags the could-not-restore alert as urgent", async () => {
    const flags: (boolean | undefined)[] = []
    let n = 0
    const { d } = make({ order: stuck(), ledger: async () => (n++ === 0 ? [] : [row()]) })
    await executeBillDispatch({ ...d, restoreProcessing: async () => 0, alert: async (_m, u) => { flags.push(u) } }, "o1")
    expect(flags).toEqual([true])
  })
})

describe("executeBillDispatch release guards", () => {
  it("0-row release aborts without dispatching", async () => {
    const { d, calls } = make({ order: stuck() })
    const r = await executeBillDispatch({ ...d, releaseStuckClaim: async () => 0 }, "o1")
    expect(r).toMatchObject({ ok: false, status: 409, message: "Claim is no longer stuck" })
    expect(calls).toEqual([])
  })
  it("ledger read failing after the release restores processing, alerts and aborts", async () => {
    let n = 0
    const { d, calls } = make({ order: stuck(), ledger: async () => { if (n++ === 0) return []; throw new Error("db") } })
    const r = await executeBillDispatch(d, "o1")
    expect(r.ok).toBe(false)
    expect(calls).toEqual(["release", "restore:null", "alert"])
  })
})

describe("executeBillRetry", () => {
  const failedOrder = (o: Partial<DispatchOrder> = {}) => ord({ status: "failed", failure_reason: "Invalid meter", ...o })
  const failedRow = (o: Partial<LedgerFact> = {}): LedgerFact => ({ ...row("failed"), ...o })

  function makeRetry(o: { order?: DispatchOrder | null; ledger?: () => Promise<LedgerFact[]>; reopen?: number; revert?: number; sent?: string } = {}) {
    const calls: string[] = []
    let current = o.order === undefined ? failedOrder() : o.order
    const d: BillRetryDeps = {
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

  it("reopens a Hubtel-failed order and dispatches it again", async () => {
    const { d, calls } = makeRetry()
    expect(await executeBillRetry(d, "o1")).toMatchObject({ ok: true, orderStatus: "processing" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "dispatch"])
  })
  it("refuses orders that are not paid and failed, or never reached Hubtel", async () => {
    expect((await executeBillRetry(makeRetry({ order: null }).d, "o1")).status).toBe(404)
    for (const order of [failedOrder({ status: "pending" }), failedOrder({ payment_status: "refunded" })]) {
      const { d, calls } = makeRetry({ order })
      expect((await executeBillRetry(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
    const never = makeRetry({ ledger: async () => [] })
    expect(await executeBillRetry(never.d, "o1")).toMatchObject({ status: 409, message: expect.stringMatching(/never reached Hubtel/) })
  })
  it("refuses when a refund was claimed, an attempt is live, or an admin override failed it", async () => {
    for (const ledger of [[failedRow({ refund_claimed_at: "t" })], [failedRow(), row("pending")], [failedRow({ resolved_by: "admin" })]]) {
      const { d, calls } = makeRetry({ ledger: async () => ledger })
      expect((await executeBillRetry(d, "o1")).status).toBe(409)
      expect(calls).toEqual([])
    }
  })
  it("refuses an expired Ghana Water order", async () => {
    const { d, calls } = makeRetry({ order: failedOrder({ biller: "ghana_water", created_at: new Date(NOW - 11 * 60_000).toISOString() }) })
    expect((await executeBillRetry(d, "o1")).message).toMatch(/Ghana Water/)
    expect(calls).toEqual([])
  })
  it("stops when the order changed before it could be reopened", async () => {
    const { d, calls } = makeRetry({ reopen: 0 })
    expect((await executeBillRetry(d, "o1")).status).toBe(409)
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter"])
  })
  it("puts the order back to failed if a refund claim appears after reopening", async () => {
    let n = 0
    const { d, calls } = makeRetry({ ledger: async () => (n++ === 0 ? [failedRow()] : [failedRow({ refund_claimed_at: "t" })]) })
    expect((await executeBillRetry(d, "o1")).status).toBe(409)
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted"])
  })
  it("puts the order back to failed when the retry was not sent, so it can be retried or refunded", async () => {
    const { d, calls } = makeRetry({ sent: "pending" })
    expect(await executeBillRetry(d, "o1")).toMatchObject({ ok: false, orderStatus: "failed", message: "Retry not sent: Not sent: Hubtel paused" })
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "dispatch", "revert:Retry not sent: Not sent: Hubtel paused"])
  })
  it("fails closed and alerts urgently when the ledger can't be re-read and the order can't be restored", async () => {
    let n = 0
    const { d, calls } = makeRetry({ revert: 0, ledger: async () => { if (n++ === 0) return [failedRow()]; throw new Error("db down") } })
    expect((await executeBillRetry(d, "o1")).status).toBe(500)
    expect(calls).toEqual(["reopen:Retrying after Hubtel failure: Invalid meter", "revert:Retry aborted", "alert:urgent"])
  })
})
