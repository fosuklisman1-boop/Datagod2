import { describe, it, expect } from "vitest"
import { executeBillDispatch, type BillDispatchDeps, type DispatchOrder } from "./admin-dispatch"
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
