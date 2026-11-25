import { describe, it, expect } from "vitest"
import { lookupOrder, dashboardContext, type LookupTable } from "./dashboard-order-lookup"
import type { V2Context } from "./handler"

function table(seen: { product: string; ref: string; ctx: V2Context }[], fail = false): LookupTable {
  const mk = (product: string) => () => async (ref: string, ctx: V2Context) => {
    if (fail) throw new Error("boom")
    seen.push({ product, ref, ctx })
    return { status: 200, data: { order: { reference: ref } } }
  }
  return { data: mk("data"), airtime: mk("airtime"), bill: mk("bill"), bundle: mk("bundle"), results: mk("results"), afa: mk("afa") }
}

describe("lookupOrder", () => {
  it("runs the product's own lookup as the session user, live, with no key id", async () => {
    const seen: { product: string; ref: string; ctx: V2Context }[] = []
    expect(await lookupOrder("airtime", "A-1", "u1", table(seen))).toEqual({ status: 200, data: { order: { reference: "A-1" } } })
    expect(seen).toEqual([{ product: "airtime", ref: "A-1", ctx: dashboardContext("u1", "airtime") }])
    expect(seen[0].ctx).toMatchObject({ userId: "u1", environment: "live", keyId: "", keyType: "commission" })
    expect(dashboardContext("u1", "data").keyType).toBe("standard")
  })
  it("an unknown product or an over-long reference is a 404 and runs nothing", async () => {
    const seen: { product: string; ref: string; ctx: V2Context }[] = []
    expect((await lookupOrder("sms", "S-1", "u1", table(seen))).status).toBe(404)
    expect((await lookupOrder("__proto__", "S-1", "u1", table(seen))).status).toBe(404)
    expect((await lookupOrder("data", "x".repeat(101), "u1", table(seen))).status).toBe(404)
    expect(seen).toEqual([])
  })
  it("a lookup that throws reads as 503, never a crash", async () => {
    expect((await lookupOrder("data", "D-1", "u1", table([], true))).status).toBe(503)
  })
})
