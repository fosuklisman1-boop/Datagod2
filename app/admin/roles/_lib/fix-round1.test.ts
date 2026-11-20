import { describe, it, expect } from "vitest"
import { runMoveChunks, UNKNOWN_REASON, extraCounts } from "./members-move"
import { airtimeFeeWarning } from "./rates-edit"
import { nextLossOk, buildPricesPut, canSavePrices, type PriceRow } from "./prices-grid"
import { shouldBlockTabSwitch } from "./guards"

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`)
const ok = (c: string[]) => c.map((user_id) => ({ user_id, status: "moved" as const }))
const apiErr = (status: number) => Object.assign(new Error("boom"), { status })

describe("runMoveChunks", () => {
  it("continues normally, including per-user skipped/error rows", async () => {
    const r = await runMoveChunks(ids(450), async (c) => c.map((user_id) => ({ user_id, status: "error" as const, reason: "x" })), undefined, 200)
    expect(r.results.length).toBe(450)
    expect(r.stop).toBeNull()
  })
  it("stops on 429: failed chunk unknown, the rest not attempted, no further sends", async () => {
    let calls = 0
    const r = await runMoveChunks(ids(450), async (c) => { calls++; if (calls === 2) throw apiErr(429); return ok(c) }, undefined, 200)
    expect(calls).toBe(2)
    expect(r.stop).toEqual({ status: 429, message: "boom" })
    expect(r.results.filter((x) => x.status === "moved").length).toBe(200)
    const unknown = r.results.filter((x) => x.status === "unknown")
    expect(unknown.length).toBe(200)
    expect(unknown[0].reason).toBe(UNKNOWN_REASON)
    expect(r.results.filter((x) => x.status === "not_attempted").length).toBe(50)
    expect(extraCounts(r.results)).toEqual({ unknown: 200, notAttempted: 50 })
  })
  it("stops on a thrown fetch error (no status)", async () => {
    let calls = 0
    const r = await runMoveChunks(ids(300), async () => { calls++; throw new TypeError("Failed to fetch") }, undefined, 200)
    expect(calls).toBe(1)
    expect(r.stop?.status).toBeNull()
    expect(r.results.filter((x) => x.status === "unknown").length).toBe(200)
    expect(r.results.filter((x) => x.status === "not_attempted").length).toBe(100)
  })
  it("stops on 401, 403 and 5xx but not on 400/409", async () => {
    for (const s of [401, 403, 500, 503]) {
      const r = await runMoveChunks(ids(300), async () => { throw apiErr(s) }, undefined, 200)
      expect(r.stop?.status).toBe(s)
    }
    for (const s of [400, 409]) {
      let calls = 0
      const r = await runMoveChunks(ids(300), async (c) => { calls++; if (calls === 1) throw apiErr(s); return ok(c) }, undefined, 200)
      expect(r.stop).toBeNull()
      expect(calls).toBe(2)
      expect(r.results.filter((x) => x.status === "error").length).toBe(200)
    }
  })
})

describe("airtime fee guard", () => {
  it("warns above 10 for airtime_fee keys only", () => {
    const msg = "Airtime fee above 10% is unusual — save anyway?"
    expect(airtimeFeeWarning([{ service_key: "airtime_fee:mtn", value: 10.01 }])).toBe(msg)
    expect(airtimeFeeWarning([{ service_key: "airtime_fee:at", value: 100 }])).toBe(msg)
    expect(airtimeFeeWarning([{ service_key: "airtime_fee:mtn", value: 10 }])).toBeNull()
    expect(airtimeFeeWarning([{ service_key: "airtime_fee:mtn", value: null }])).toBeNull()
    expect(airtimeFeeWarning([{ service_key: "cashback_share:bills", value: 90 }])).toBeNull()
  })
})

describe("loss box rule", () => {
  it("stays only while the below-cost set is unchanged", () => {
    expect(nextLossOk(["a"], ["a"], true)).toBe(true)
    expect(nextLossOk(["a"], ["a", "b"], true)).toBe(false)
    expect(nextLossOk(["a", "b"], ["a"], true)).toBe(false)
    expect(nextLossOk(["a"], ["b"], true)).toBe(false)
    expect(nextLossOk([], [], false)).toBe(false)
  })
})

describe("component-level rules", () => {
  const row = (id: string): PriceRow => ({ id, network: "MTN", name: id, price: 10, cost_price: 6, role_price: null, effective_price: 10, is_available: true })
  it("PUT body is dirty cells only and loss_override follows the box", () => {
    const rows = [row("a"), row("b")]
    expect(buildPricesPut(rows, { a: "5" }, true, "ok then")).toEqual({ changes: [{ package_id: "a", price: 5 }], loss_override: true, reason: "ok then" })
    expect(buildPricesPut(rows, { a: "5" }, false, "ok then").loss_override).toBe(false)
    expect(canSavePrices({ rows, edits: { a: "5" }, lossOk: false, reason: "ok then" }).ok).toBe(false)
  })
  it("tab switch is blocked only when dirty and not confirmed", () => {
    expect(shouldBlockTabSwitch(false, "prices", "basics", () => false)).toBe(false)
    expect(shouldBlockTabSwitch(true, "prices", "prices", () => false)).toBe(false)
    expect(shouldBlockTabSwitch(true, "prices", "basics", () => false)).toBe(true)
    expect(shouldBlockTabSwitch(true, "prices", "basics", () => true)).toBe(false)
  })
})
