import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })) }))

const enqueueRecipients = vi.fn(async (_s: unknown, _id: string, opts: { specificUsers?: unknown[] }) => opts.specificUsers?.length ?? 0)
vi.mock("@/lib/broadcast-drain", () => ({
  enqueueRecipients: (...a: [unknown, string, { specificUsers?: unknown[] }]) => enqueueRecipients(...a),
  drainBroadcasts: vi.fn(async () => ({ processed: 0, broadcasts: 0 })),
}))

const loadShopBuyerAudience = vi.fn()
vi.mock("@/lib/sms/shop-buyers", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sms/shop-buyers")>()),
  loadShopBuyerAudience: (...a: unknown[]) => loadShopBuyerAudience(...a),
}))

const logInsert = vi.fn()
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      insert: (row: unknown) => {
        logInsert(row)
        return { select: () => ({ single: async () => ({ data: { id: "b-1" }, error: null }) }) }
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    rpc: async () => ({ error: null }),
  }),
}))

import { POST } from "./route"

const SHOP_A = "00000000-0000-0000-0000-00000000000a"
const init = (over: Record<string, unknown> = {}) =>
  POST(new NextRequest("http://x/api/admin/broadcast", {
    method: "POST",
    body: JSON.stringify({
      action: "init",
      channels: ["sms"],
      message: "Hi from [ShopName]! Buy again: [ShopLink]",
      recipients: { type: "shop_buyers", shopIds: [SHOP_A], sinceDays: 90 },
      ...over,
    }),
  }))

describe("POST /api/admin/broadcast — shop_buyers", () => {
  beforeEach(() => vi.clearAllMocks())

  it("renders each buyer's own shop name and subdomain link and enqueues them pre-rendered", async () => {
    loadShopBuyerAudience.mockResolvedValueOnce([
      { phone: "0241111111", shop: { id: SHOP_A, name: "Kofi Data", subdomain: "kofidata", link: "https://kofidata.datagod.store" } },
      { phone: "0552222222", shop: { id: SHOP_A, name: "Kofi Data", subdomain: "kofidata", link: "https://kofidata.datagod.store" } },
    ])
    const res = await init()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body).toMatchObject({ success: true, total: 2 })
    expect(loadShopBuyerAudience.mock.calls[0][1]).toEqual({ shopIds: [SHOP_A], sinceDays: 90 })
    const opts = enqueueRecipients.mock.calls[0][2] as { targetType: string; specificUsers: Array<{ phone: string; renderedMessage: string }> }
    expect(opts.targetType).toBe("specific")
    expect(opts.specificUsers[0]).toEqual({ phone: "0241111111", renderedMessage: "Hi from Kofi Data! Buy again: https://kofidata.datagod.store" })
    expect(logInsert.mock.calls[0][0]).toMatchObject({ target_type: "shop_buyers", target_group: ["shop_buyers"] })
  })

  it("fills [ShopCode] and skips buyers whose shop has no active code", async () => {
    loadShopBuyerAudience.mockResolvedValueOnce([
      { phone: "0241111111", shop: { id: SHOP_A, name: "Kofi Data", subdomain: "kofidata", link: "https://kofidata.datagod.store", code: "1234" } },
      { phone: "0552222222", shop: { id: "b", name: "No Code", subdomain: "nocode", link: "https://nocode.datagod.store", code: null } },
    ])
    const res = await init({ message: "Dial *920*44# and enter [ShopCode] for [ShopName]" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ total: 1 })
    const opts = enqueueRecipients.mock.calls[0][2] as { specificUsers: Array<{ phone: string; renderedMessage: string }> }
    expect(opts.specificUsers).toEqual([{ phone: "0241111111", renderedMessage: "Dial *920*44# and enter 1234 for Kofi Data" }])
  })

  it("keeps code-less buyers when the message doesn't use [ShopCode]", async () => {
    loadShopBuyerAudience.mockResolvedValueOnce([
      { phone: "0552222222", shop: { id: "b", name: "No Code", subdomain: "nocode", link: "https://nocode.datagod.store", code: null } },
    ])
    expect((await init()).status).toBe(200)
  })

  it("rejects a [ShopCode] message when no selected shop has an active code", async () => {
    loadShopBuyerAudience.mockResolvedValueOnce([
      { phone: "0552222222", shop: { id: "b", name: "No Code", subdomain: "nocode", link: "https://nocode.datagod.store", code: null } },
    ])
    const res = await init({ message: "Enter [ShopCode]" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/shop code/i)
    expect(enqueueRecipients).not.toHaveBeenCalled()
  })

  it("is SMS only", async () => {
    const res = await init({ channels: ["sms", "email"], subject: "x" })
    expect(res.status).toBe(400)
    expect(loadShopBuyerAudience).not.toHaveBeenCalled()
  })

  it("validates shopIds and the window", async () => {
    expect((await init({ recipients: { type: "shop_buyers", shopIds: ["nope"] } })).status).toBe(400)
    expect((await init({ recipients: { type: "shop_buyers", shopIds: [] } })).status).toBe(400)
    expect((await init({ recipients: { type: "shop_buyers", shopIds: "all", sinceDays: 7 } })).status).toBe(400)
    expect(loadShopBuyerAudience).not.toHaveBeenCalled()
  })

  it('"all" shops and an empty audience', async () => {
    loadShopBuyerAudience.mockResolvedValueOnce([])
    const res = await init({ recipients: { type: "shop_buyers", shopIds: "all" } })
    expect(res.status).toBe(400)
    expect(loadShopBuyerAudience.mock.calls[0][1]).toEqual({ shopIds: "all", sinceDays: null })
  })

  it("explains when migration 0145 hasn't been run", async () => {
    loadShopBuyerAudience.mockRejectedValueOnce({ code: "PGRST202" })
    const res = await init()
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/0145/)
  })
})
