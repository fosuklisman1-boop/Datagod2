import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const logInserts = vi.hoisted(() => [] as any[])
const orderUpdates = vi.hoisted(() => [] as any[])
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      insert: async (row: any) => {
        logInserts.push({ table, row })
        return { error: null }
      },
      update: (patch: any) => {
        const c: any = {
          eq: () => c,
          in: () => c,
          then: (res: any) => {
            orderUpdates.push({ table, patch })
            res({ error: null })
          },
        }
        return c
      },
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  }),
}))
vi.mock("./notification-service", () => ({ notificationService: {} }))
vi.mock("./push-service", () => ({ sendPushToUser: vi.fn() }))
const notifyFulfillmentFailure = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const notifyAdmins = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock("./sms-service", () => ({ notifyFulfillmentFailure, notifyAdmins }))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins }))
const saveMTNTracking = vi.hoisted(() => vi.fn().mockResolvedValue("t"))
vi.mock("@/lib/mtn-fulfillment", () => ({ saveMTNTracking }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      update: (patch: any) => {
        const c: any = {
          eq: () => c,
          in: () => c,
          then: (res: any) => {
            orderUpdates.push({ table, patch })
            res({ error: null })
          },
        }
        return c
      },
    }),
  },
}))

import { atishareService } from "./at-ishare-service"

const args = { phoneNumber: "0551234567", sizeGb: 1, orderId: "order-uuid-1", network: "AT", orderType: "wallet" as const }

beforeEach(() => {
  logInserts.length = 0
  orderUpdates.length = 0
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe("atishareService.fulfillOrder — outcome unknown", () => {
  it("non-JSON 200 is NOT success: holds (UNKNOWN_ tracking, order processing, one alert, no failed log)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>ok</html>", { status: 200 })))
    const r = (await atishareService.fulfillOrder(args)) as any
    expect(r.success).toBe(false)
    expect(r.outcomeUnknown).toBe(true)
    expect(r.message).toContain("Check the CodeCraft dashboard before retrying")
    expect(saveMTNTracking).toHaveBeenCalledTimes(1)
    expect(String(saveMTNTracking.mock.calls[0][1])).toMatch(/^UNKNOWN_\d+$/)
    expect(orderUpdates.some((u) => u.table === "orders" && u.patch.status === "processing")).toBe(true)
    expect(logInserts.some((l) => l.row?.status === "failed")).toBe(false)
    expect(notifyAdmins).toHaveBeenCalledTimes(1)
    expect(notifyFulfillmentFailure).not.toHaveBeenCalled()
  })

  it("500 HTML and a post-send reset are unknown; fetch called once", async () => {
    const f = vi.fn(async () => new Response("<html>boom</html>", { status: 500 }))
    vi.stubGlobal("fetch", f)
    expect(((await atishareService.fulfillOrder(args)) as any).outcomeUnknown).toBe(true)
    expect(f).toHaveBeenCalledTimes(1)
    const e: any = new Error("fetch failed")
    e.cause = { code: "ECONNRESET" }
    vi.stubGlobal("fetch", vi.fn(async () => { throw e }))
    expect(((await atishareService.fulfillOrder(args)) as any).outcomeUnknown).toBe(true)
  })

  it("an explicit documented JSON failure (status 100 wallet low) is an ordinary failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: 100, message: "low" }), { status: 200 })))
    const r = (await atishareService.fulfillOrder(args)) as any
    expect(r.success).toBe(false)
    expect(r.outcomeUnknown).toBeUndefined()
    expect(saveMTNTracking).not.toHaveBeenCalled()
  })

  it("ENOTFOUND (never connected) is an ordinary failure", async () => {
    const e: any = new Error("getaddrinfo ENOTFOUND")
    e.cause = { code: "ENOTFOUND" }
    vi.stubGlobal("fetch", vi.fn(async () => { throw e }))
    const r = (await atishareService.fulfillOrder(args)) as any
    expect(r.success).toBe(false)
    expect(r.outcomeUnknown).toBeUndefined()
  })
})
