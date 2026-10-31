import { describe, it, expect, vi } from "vitest"

// Capture what each route hands to withV2.
const h = vi.hoisted(() => ({ captured: [] as { opts: any }[] }))

vi.mock("@/lib/api-v2/handler", () => ({
  withV2: (opts: any, handler: any) => {
    h.captured.push({ opts })
    return handler
  },
}))
vi.mock("@/lib/api-v2/endpoints/bills-deps", () => ({ realBillsDeps: () => ({}) }))

async function load(path: string) {
  h.captured.length = 0
  vi.resetModules()
  await import(path)
  return h.captured[0]
}

describe("POST /api/v2/utilities/lookup", () => {
  it("does not depend on Upstash Redis: no fail-closed on a degraded limiter", async () => {
    const route = await load("./lookup/route")
    expect(route.opts).toEqual({ requiredType: "commission", group: "purchase", endpoint: "/api/v2/utilities/lookup" })
    expect(route.opts.failClosedWhenLimiterDegraded).toBeUndefined()
  })
})

describe("POST /api/v2/utilities/pay", () => {
  it("still fails closed on a degraded limiter (money path)", async () => {
    const route = await load("./pay/route")
    expect(route.opts.failClosedWhenLimiterDegraded).toBe(true)
  })
})
