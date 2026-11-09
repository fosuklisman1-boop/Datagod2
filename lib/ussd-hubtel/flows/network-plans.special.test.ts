// lib/ussd-hubtel/flows/network-plans.special.test.ts
// Special Bundles as the first choice in the MTN Standard Bundles flow.
import { describe, it, expect, vi, afterEach } from "vitest"
import { hubtelRouter } from "../router"
import { BOT_GROUP_ID, BOT_ORDER_ID, fakeNetworkPlans, fakeShop, fakeSupabase, makeDeps, req, SHOP_CONFIG } from "../testing/fakes"
import { NP_TEXT, SPECIAL_CATEGORY } from "./network-plans"
import { USSD_SCREEN_LIMIT } from "../protocol"
import type { HubtelReply, HubtelSession } from "../types"
import type { BotSpecialPlan } from "@/lib/bot-commission/special-orders"

const SID = "3c796dac28174f739de4262d08409c51"
const ME = "+233244123456" // MTN
const SHOP_UUID = "11111111-2222-4333-8444-555555555555"
const OPEN_ROW = { id: BOT_ORDER_ID, status: "pending", payment_status: "unpaid" }

const plan = (i: number): BotSpecialPlan => ({
  token: `sp-${i}`, display: `${(1.22 * (i + 1)).toFixed(2)}GB`, n: i + 2, faceAmount: 3 * (i + 2), payAmount: 2.5 * (i + 2),
})
const plans = (n: number) => Array.from({ length: n }, (_, i) => plan(i))

type Setup = ReturnType<typeof makeDeps> & { np: ReturnType<typeof fakeNetworkPlans>; screens: HubtelReply[] }

function setup(opts: { np?: Parameters<typeof fakeNetworkPlans>[0]; sup?: ReturnType<typeof fakeSupabase>; session?: Partial<HubtelSession>; shop?: boolean; special?: number } = {}): Setup {
  const special = opts.special ?? 6
  const np = fakeNetworkPlans({ specialPlans: async () => ({ ok: true, plans: plans(special) }), ...opts.np })
  const sup = opts.sup ?? fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
  const made = makeDeps({ networkPlans: np, ...(opts.shop ? { getConfig: SHOP_CONFIG, shop: fakeShop() } : {}) }, sup)
  made.store.set(SID, { mode: "main", step: "NP_NETWORK", dialingPhone: ME, platform: "USSD", ...opts.session })
  return { ...made, np, screens: [] }
}

async function send(s: Setup, ...inputs: string[]): Promise<HubtelReply> {
  let r!: HubtelReply
  for (const m of inputs) {
    r = await hubtelRouter(req({ SessionId: SID, Message: m }), s.deps)
    s.screens.push(r)
  }
  return r
}
const toConfirm = (s: Setup) => send(s, "1", "1", "1", "1") // MTN, Special, first plan, my number

afterEach(() => vi.restoreAllMocks())

describe("special bundles: category line", () => {
  it("MTN with plans: Special first, existing categories follow", async () => {
    const s = setup()
    const r = await send(s, "1")
    expect(r.Message).toBe("MTN plans:\n1. Special Bundles\n2. Data\n3. Video\n0. Back")
    expect(s.store.get(SID)?.npCategories).toEqual([SPECIAL_CATEGORY, "Data", "Video"])
  })
  it("Telecel and AT never show it, and never ask for plans", async () => {
    const specialPlans = vi.fn(async () => ({ ok: true as const, plans: plans(3) }))
    const s = setup({ np: { specialPlans } })
    expect((await send(s, "2")).Message).toBe("Telecel plans:\n1. Video\n2. Data\n0. Back")
    expect((await send(s, "0", "3")).Message).toBe("AirtelTigo plans:\n1. Video\n2. Data\n0. Back")
    expect(specialPlans).not.toHaveBeenCalled()
  })
  it("no plans, a Fail, or a throw: the normal list, no error screen", async () => {
    const normal = "MTN plans:\n1. Data\n2. Video\n0. Back"
    vi.spyOn(console, "error").mockImplementation(() => {})
    for (const specialPlans of [
      async () => ({ ok: true as const, plans: [] }),
      async () => ({ ok: false as const, status: 503, error: "x" }),
      async () => { throw new Error("db down") },
    ]) {
      const s = setup({ np: { specialPlans } })
      const r = await send(s, "1")
      expect(r.Message).toBe(normal)
      expect(r.Type).not.toBe("release")
    }
  })
  it("a Hubtel category named Special Bundles is dropped, with ours showing or not", async () => {
    const base = await fakeNetworkPlans().catalog({} as never, "MTN")
    if (!base.ok) throw new Error("fake")
    const withReal = async () => ({ ok: true as const, categories: [{ name: "Special Bundles", bundles: base.categories[1].bundles }, ...base.categories] })
    const on = setup({ np: { catalog: withReal } })
    expect((await send(on, "1")).Message).toBe("MTN plans:\n1. Special Bundles\n2. Data\n3. Video\n0. Back")
    expect(on.store.get(SID)?.npCategories).toEqual([SPECIAL_CATEGORY, "Data", "Video"])
    const off = setup({ special: 0, np: { catalog: withReal } })
    expect((await send(off, "1")).Message).toBe("MTN plans:\n1. Data\n2. Video\n0. Back")
    expect(off.store.get(SID)?.npCategories).toEqual(["Data", "Video"])
  })
})

describe("special bundles: plan list", () => {
  it("shows MTN Special Bundles with paged sizes, every one reachable, every screen within the limit", async () => {
    const s = setup()
    const p1 = await send(s, "1", "1")
    expect(p1.Message.startsWith("MTN Special Bundles\n1. 1.22GB GHS 5.00\n2. 2.44GB GHS 7.50")).toBe(true)
    expect(p1.Message.endsWith("0 Next\n00 Back")).toBe(true)
    expect(s.store.get(SID)).toMatchObject({ npSpecial: true, npPage: 0, npCategory: SPECIAL_CATEGORY })
    expect(s.store.get(SID)?.npPlans).toHaveLength(5)
    const p2 = await send(s, "0")
    expect(p2.Message).toBe("MTN Special Bundles\n1. 7.32GB GHS 17.50\n00 Back")
    for (const r of s.screens) expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect((await send(s, "00")).Message).toBe(p1.Message)
  })
  it("reloads the plans (fresh tokens) each time the list is shown", async () => {
    const specialPlans = vi.fn(async () => ({ ok: true as const, plans: plans(6) }))
    const s = setup({ np: { specialPlans } })
    await send(s, "1", "1", "0", "00")
    expect(specialPlans).toHaveBeenCalledTimes(4) // categories, list, next, back
  })
  it("00 on page one returns to the categories and clears npSpecial", async () => {
    const s = setup()
    await send(s, "1", "1")
    const r = await send(s, "00")
    expect(r.Message).toBe("MTN plans:\n1. Special Bundles\n2. Data\n3. Video\n0. Back")
    expect(s.store.get(SID)).toMatchObject({ step: "NP_CATEGORY", npSpecial: undefined })
  })
  it("a normal category after Special is a plain Standard Bundles path", async () => {
    const s = setup()
    await send(s, "1", "1", "00")
    const r = await send(s, "2")
    expect(r.Message).toMatch(/^MTN Data\n1\. 1GB GHS 9\.50/)
    expect(s.store.get(SID)?.npSpecial).toBeFalsy()
  })
  it("the plans vanishing between screens: back to the categories with the notice", async () => {
    let n = 6
    const s = setup({ np: { specialPlans: async () => ({ ok: true, plans: plans(n) }) } })
    await send(s, "1", "1")
    n = 0
    const r = await send(s, "0")
    expect(r.Message).toBe("Not available right now.\nMTN plans:\n1. Data\n2. Video\n0. Back")
    expect(s.store.get(SID)?.npSpecial).toBeFalsy()
  })
})

describe("special bundles: recipient and confirm", () => {
  it("recipient and confirm screens match Standard Bundles", async () => {
    const s = setup()
    const rec = await send(s, "1", "1", "1")
    expect(rec.Message).toBe("Who is this for?\n1. My Self (0244123456)\n2. Someone Else\n0. Back")
    const c = await send(s, "1")
    expect(c.Message).toBe("MTN 1.22GB\nTo: 0244123456\nAmount: GHS 5.00 (was GHS 6.00)\n\nConfirm your order?\n1. Confirm\n0. Cancel")
    expect(s.store.get(SID)).toMatchObject({ step: "NP_CONFIRM", npSpecial: true, npRecipient: "0244123456" })
  })
  it("the delivery note is used as in Standard Bundles", async () => {
    const s = setup()
    s.deps.deliveryEstimate = async () => "Delivery: ~2 min"
    expect((await toConfirm(s)).Message).toContain("Amount: GHS 5.00 (was GHS 6.00)\nDelivery: ~2 min\n")
  })
  it("0 on the recipient choice returns to the same Special page", async () => {
    const s = setup()
    await send(s, "1", "1", "0", "2")
    expect((await send(s, "0")).Message).toContain("MTN Special Bundles\n1. 7.32GB")
  })
  it("MTN number prefix rules are unchanged", async () => {
    const s = setup()
    await send(s, "1", "1", "1", "2")
    expect((await send(s, "0201234567")).Message).toContain("Enter recipient number")
    expect((await send(s, "0541234567")).Message).toContain("MTN 1.22GB\nTo: 0541234567\n")
  })
  it("Confirm 1 creates the group at the shown total and carts child 1 at that total", async () => {
    const s = setup()
    await toConfirm(s)
    const r = await send(s, "1")
    expect(s.np.specialCalls).toEqual([{
      ctx: { botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME },
      input: { token: "sp-0", recipient: "0244123456", idempotencyKey: SID, expectedPay: 5 },
    }])
    expect(s.np.calls).toHaveLength(0)
    expect(s.sup.inserts.hubtel_data_orders).toBeUndefined()
    expect(s.sup.inserts.hubtel_transactions).toEqual([{
      session_id: SID, platform: "USSD", order_table: "hubtel_data_orders", order_id: BOT_ORDER_ID, mobile: ME, expected_amount: 5,
    }])
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "CH order 22222222", Qty: 1, Price: 5 })
    expect(s.sup.updates).toEqual([])
  })
  it("a repeat confirm or lost reply replays the identical cart, no second group", async () => {
    const s = setup()
    await toConfirm(s)
    const stale = s.store.get(SID)!
    const first = await send(s, "1")
    s.store.set(SID, stale)
    const again = await send(s, "1")
    const lost = await send(s, "1")
    expect(s.np.specialCalls).toHaveLength(1)
    expect(s.sup.inserts.hubtel_transactions).toHaveLength(1)
    expect(again).toEqual(first)
    expect(lost).toEqual(first)
  })
  it("a replayed group at a different total than the screen showed is never carted", async () => {
    const s = setup({ np: { specialResult: { ok: true, order: { id: BOT_ORDER_ID, groupId: BOT_GROUP_ID, n: 2, payAmount: 4.5 } } } })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    expect(r).toMatchObject({ Type: "release", Message: NP_TEXT.priceChanged })
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
    // The group is open (pending + unpaid) and never carted: it is failed, guarded, so it cannot stay open forever.
    expect(s.sup.updates).toEqual([{ table: "hubtel_data_orders", patch: expect.objectContaining({ status: "failed" }) }])
    expect((s.sup.updates[0] as any).filters).toContainEqual(["eq", "id", BOT_ORDER_ID])
  })
  it("an open-state check guards the cart: a paid or closed child 1 is never carted", async () => {
    const sup = fakeSupabase({ rows: { hubtel_data_orders: { id: BOT_ORDER_ID, status: "pending", payment_status: "paid" } } })
    const s = setup({ sup })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    expect(sup.updates).toEqual([])
  })
  it.each([
    [409, NP_TEXT.priceChanged, "Price changed. Please try again."],
    [429, NP_TEXT.tooMany, "Too many attempts. Please try later."],
    [403, NP_TEXT.notAvailable, "Not available right now."],
    [503, NP_TEXT.unavailable, "Service unavailable. Please try again later."],
  ])("engine %i maps to its text, session ended, no tx row", async (status, text, literal) => {
    expect(text).toBe(literal)
    const s = setup({ np: { specialResult: { ok: false, status, error: "x" } } })
    await toConfirm(s)
    const r = await send(s, "1")
    expect(r).toMatchObject({ Type: "release", Message: literal })
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
    expect(s.store.has(SID)).toBe(false)
  })
  it("0 cancels without creating anything", async () => {
    const s = setup()
    await toConfirm(s)
    expect((await send(s, "0")).Message).toBe("Order cancelled.")
    expect(s.np.specialCalls).toHaveLength(0)
  })
})

describe("special bundles: orphans", () => {
  const guardedFailOn = (sup: ReturnType<typeof fakeSupabase>) => {
    expect(sup.updates).toEqual([{ table: "hubtel_data_orders", patch: expect.objectContaining({ status: "failed" }) }])
    expect((sup.updates[0] as any).filters).toContainEqual(["eq", "id", BOT_ORDER_ID])
  }
  it("createSpecialOrder threw after committing: child 1 is found and failed, caller sees unavailable", async () => {
    const findSpecialOrderId = vi.fn(async () => BOT_ORDER_ID)
    const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
    const s = setup({ sup, np: { createSpecialOrder: async () => { throw new Error("socket hang up") }, findSpecialOrderId } })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(findSpecialOrderId).toHaveBeenCalledWith({ botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME }, SID)
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    guardedFailOn(sup)
  })
  it("a 503 Fail after a committed group: child 1 is found and failed", async () => {
    const findSpecialOrderId = vi.fn(async () => BOT_ORDER_ID)
    const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
    const s = setup({ sup, np: { specialResult: { ok: false, status: 503, error: "x" }, findSpecialOrderId } })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    expect(r).toMatchObject({ Type: "release", Message: NP_TEXT.unavailable })
    expect(findSpecialOrderId).toHaveBeenCalledWith({ botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME }, SID)
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    guardedFailOn(sup)
  })
  it("a 503 Fail with nothing found, or a failing lookup: nothing to fail, no throw", async () => {
    for (const findSpecialOrderId of [async () => null, async () => { throw new Error("db down") }]) {
      const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
      const s = setup({ sup, np: { specialResult: { ok: false, status: 503, error: "x" }, findSpecialOrderId } })
      await toConfirm(s)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const r = await send(s, "1")
      expect(r.Message).toBe(NP_TEXT.unavailable)
      expect(sup.updates).toEqual([])
    }
  })
  it("threw with nothing found, or the lookup failed: nothing to fail", async () => {
    for (const findSpecialOrderId of [async () => null, async () => { throw new Error("db down") }]) {
      const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
      const s = setup({ sup, np: { createSpecialOrder: async () => { throw new Error("boom") }, findSpecialOrderId } })
      await toConfirm(s)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const r = await send(s, "1")
      expect(r.Message).toBe(NP_TEXT.unavailable)
      expect(sup.updates).toEqual([])
    }
  })
  it.each([
    ["no row", { rows: {} }],
    ["a read error", { rows: { hubtel_data_orders: OPEN_ROW }, readError: ["hubtel_data_orders"] }],
  ])("read-back with %s: not carted, child 1 failed", async (_why, opts) => {
    const sup = fakeSupabase(opts)
    const s = setup({ sup })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    expect(r).toMatchObject({ Type: "release", Message: NP_TEXT.unavailable })
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    guardedFailOn(sup)
  })
})

describe("special bundles: shop mode", () => {
  it("passes the session's shopId to plans and order", async () => {
    const specialPlans = vi.fn(async () => ({ ok: true as const, plans: plans(2) }))
    const s = setup({ shop: true, np: { specialPlans }, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } })
    await toConfirm(s)
    await send(s, "1")
    const ctx = { botSurface: "hubtel_ussd", shopId: SHOP_UUID, rail: "hubtel", buyerPhone: ME }
    expect(specialPlans).toHaveBeenCalledWith(ctx)
    expect(s.np.specialCalls[0].ctx).toEqual(ctx)
  })
  it("a shop session with no shopId fails closed, no order", async () => {
    const s = setup({ shop: true, session: { mode: "shop" } })
    const r = await send(s, "1")
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(s.np.specialCalls).toHaveLength(0)
  })
  it("a main session with no mode (after Back) still gets Special", async () => {
    const s = setup({ session: { mode: undefined } })
    expect((await send(s, "1")).Message).toContain("1. Special Bundles")
  })
})
