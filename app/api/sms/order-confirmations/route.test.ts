import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const h = vi.hoisted(() => ({
  auth: { account: { id: "acct1", user_id: "u1" }, user: { id: "u1" } } as any,
  shop: { data: { id: "shop1" }, error: null } as any,
  settings: { data: { order_confirmation_use_own_sender: false }, error: null } as any,
  upsertError: null as any,
  upserts: [] as any[],
  check: vi.fn(),
}))
vi.mock("@/lib/sms/tenant-auth", () => ({ resolveAccount: () => Promise.resolve(h.auth) }))
vi.mock("@/lib/sms/order-confirmation", () => ({ canUseOwnSenderForConfirmations: h.check }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const c: any = {}
      c.select = () => c
      c.eq = () => c
      c.maybeSingle = () => Promise.resolve(table === "user_shops" ? h.shop : h.settings)
      c.upsert = (row: any, opts: any) => { h.upserts.push({ table, row, opts }); return Promise.resolve({ error: h.upsertError }) }
      return c
    },
  }),
}))

import { GET, PATCH } from "./route"

const get = () => GET(new NextRequest("http://localhost/api/sms/order-confirmations"))
const patch = (body: unknown) =>
  PATCH(new NextRequest("http://localhost/api/sms/order-confirmations", { method: "PATCH", body: JSON.stringify(body) }))

beforeEach(() => {
  h.auth = { account: { id: "acct1", user_id: "u1" }, user: { id: "u1" } }
  h.shop = { data: { id: "shop1" }, error: null }
  h.settings = { data: { order_confirmation_use_own_sender: false }, error: null }
  h.upsertError = null
  h.upserts = []
  h.check.mockReset()
  h.check.mockResolvedValue({ ok: true, accountId: "acct1", userId: "u1", senderId: "MYSHOP" })
})

describe("GET /api/sms/order-confirmations", () => {
  it("requires auth", async () => {
    h.auth = { error: NextResponse.json({ success: false }, { status: 401 }) }
    expect((await get()).status).toBe(401)
  })
  it("returns the stored toggle and canEnable", async () => {
    h.settings = { data: { order_confirmation_use_own_sender: true }, error: null }
    expect(await (await get()).json()).toEqual({ success: true, data: { useOwnSender: true, canEnable: true } })
  })
  it("includes the reason when it cannot be enabled", async () => {
    h.check.mockResolvedValue({ ok: false, reason: "You need an active sender ID." })
    expect((await (await get()).json()).data).toEqual({ useOwnSender: false, canEnable: false, reason: "You need an active sender ID." })
  })
  it("treats a missing column / read error as off", async () => {
    h.settings = { data: null, error: { code: "42703", message: "column does not exist" } }
    expect((await (await get()).json()).data.useOwnSender).toBe(false)
  })
  it("accounts without a shop get a disabled state", async () => {
    h.shop = { data: null, error: null }
    const j = await (await get()).json()
    expect(j.data).toMatchObject({ useOwnSender: false, canEnable: false })
    expect(typeof j.data.reason).toBe("string")
    expect(h.check).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/sms/order-confirmations", () => {
  it("rejects a non-boolean body", async () => {
    expect((await patch({ useOwnSender: "yes" })).status).toBe(400)
    expect(h.upserts).toHaveLength(0)
  })
  it("turns ON when eligible: upserts by shop_id and returns the new state", async () => {
    h.settings = { data: { order_confirmation_use_own_sender: true }, error: null }
    const res = await patch({ useOwnSender: true })
    expect(res.status).toBe(200)
    expect(h.upserts).toEqual([{ table: "shop_settings", row: { shop_id: "shop1", order_confirmation_use_own_sender: true }, opts: { onConflict: "shop_id" } }])
    expect((await res.json()).data).toEqual({ useOwnSender: true, canEnable: true })
  })
  it("refuses ON with the helper's reason when not eligible", async () => {
    h.check.mockResolvedValue({ ok: false, reason: "Your SMS account is not active." })
    const res = await patch({ useOwnSender: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Your SMS account is not active.")
    expect(h.upserts).toHaveLength(0)
  })
  it("allows turning OFF even when not eligible", async () => {
    h.check.mockResolvedValue({ ok: false, reason: "no sender" })
    const res = await patch({ useOwnSender: false })
    expect(res.status).toBe(200)
    expect(h.upserts[0].row.order_confirmation_use_own_sender).toBe(false)
  })
  it("accounts without a shop → 400", async () => {
    h.shop = { data: null, error: null }
    expect((await patch({ useOwnSender: true })).status).toBe(400)
    expect(h.upserts).toHaveLength(0)
  })
  it("a failed write → 500", async () => {
    h.upsertError = { message: "boom" }
    expect((await patch({ useOwnSender: false })).status).toBe(500)
  })
})
