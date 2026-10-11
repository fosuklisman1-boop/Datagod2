import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  settingsRow: null as any,
  writes: [] as { op: string; payload: any }[],
  check: { ok: true } as any,
}))

vi.mock("@/lib/sms/order-confirmation", () => ({
  canUseOwnSenderForConfirmations: vi.fn(async () => state.check),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from(table: string) {
      const c: any = {}
      for (const m of ["select", "eq", "or"]) c[m] = () => c
      c.single = async () => {
        if (table === "user_shops") return { data: { user_id: "u1" }, error: null }
        if (state.settingsRow) return { data: { ...state.settingsRow }, error: null }
        return { data: null, error: { code: "PGRST116", message: "none" } }
      }
      c.update = (p: any) => { state.writes.push({ op: "update", payload: p }); return c }
      c.insert = (p: any) => { state.writes.push({ op: "insert", payload: p[0] }); return c }
      return c
    },
  }),
}))

import { GET, PUT } from "./route"

const SHOP = "11111111-1111-4111-8111-111111111111"
const params = { params: Promise.resolve({ shopId: SHOP }) }
const get = () => GET(new Request("http://x") as any, params)
const put = (body: unknown) =>
  PUT(
    new Request("http://x", { method: "PUT", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) }) as any,
    params,
  )

beforeEach(() => {
  state.settingsRow = null
  state.writes = []
  state.check = { ok: true }
})

describe("shop settings: order_confirmation_use_own_sender", () => {
  it("GET defaults to false when there is no row", async () => {
    expect((await (await get()).json()).order_confirmation_use_own_sender).toBe(false)
  })

  it("GET maps NULL to false and passes true through", async () => {
    state.settingsRow = { id: "s", order_confirmation_sms_enabled: true, order_confirmation_use_own_sender: null }
    expect((await (await get()).json()).order_confirmation_use_own_sender).toBe(false)
    state.settingsRow = { id: "s", order_confirmation_sms_enabled: true, order_confirmation_use_own_sender: true }
    expect((await (await get()).json()).order_confirmation_use_own_sender).toBe(true)
  })

  it("PUT rejects a non-boolean", async () => {
    const res = await put({ order_confirmation_use_own_sender: "yes" })
    expect(res.status).toBe(400)
    expect(state.writes).toHaveLength(0)
  })

  it("PUT true is refused with 400 and the reason when the shop cannot use its own sender", async () => {
    state.check = { ok: false, reason: "You need an active sender ID to use it for order confirmations." }
    const res = await put({ order_confirmation_use_own_sender: true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/active sender ID/)
    expect(state.writes).toHaveLength(0)
  })

  it("PUT true is saved on update when allowed", async () => {
    state.settingsRow = { id: "s", order_confirmation_use_own_sender: false }
    const res = await put({ order_confirmation_use_own_sender: true })
    expect(res.status).toBe(200)
    expect(state.writes[0]).toMatchObject({ op: "update", payload: { order_confirmation_use_own_sender: true } })
  })

  it("PUT true is saved on insert when allowed", async () => {
    await put({ order_confirmation_use_own_sender: true })
    expect(state.writes[0]).toMatchObject({ op: "insert", payload: { order_confirmation_use_own_sender: true } })
  })

  it("PUT false skips the eligibility check and preserves/sets false", async () => {
    state.check = { ok: false, reason: "no" }
    state.settingsRow = { id: "s", order_confirmation_use_own_sender: true }
    const res = await put({ order_confirmation_use_own_sender: false })
    expect(res.status).toBe(200)
    expect(state.writes[0].payload.order_confirmation_use_own_sender).toBe(false)
  })

  it("PUT without the field leaves the existing value alone", async () => {
    state.settingsRow = { id: "s", order_confirmation_use_own_sender: true }
    await put({ announcement_enabled: true })
    expect(state.writes[0].payload.order_confirmation_use_own_sender).toBe(true)
  })
})
