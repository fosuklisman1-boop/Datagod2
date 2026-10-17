// lib/ussd-hubtel/flows/network-plans.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter } from "../router"
import { BOT_ORDER_ID, fakeNetworkPlans, fakePlans, fakeShop, fakeSupabase, makeDeps, req, SHOP_CONFIG } from "../testing/fakes"
import { networkPlanConfirmText, npIdempotencyKey, NP_TEXT, startNetworkPlans } from "./network-plans"
import { USSD_SCREEN_LIMIT } from "../protocol"
import type { HubtelReply, HubtelSession } from "../types"
import type { FlowCtx } from "../flow-kit"

const SID = "3c796dac28174f739de4262d08409c51"
const ME = "+233244123456" // MTN
const SHOP_UUID = "11111111-2222-4333-8444-555555555555"
const OPEN_ROW = { id: BOT_ORDER_ID, status: "pending", payment_status: "unpaid" }

/** `screens`: every reply this setup's `send` produced (this flow's screens only). */
type Setup = ReturnType<typeof makeDeps> & { np: ReturnType<typeof fakeNetworkPlans>; screens: HubtelReply[] }

function setup(opts: { np?: Parameters<typeof fakeNetworkPlans>[0]; sup?: ReturnType<typeof fakeSupabase>; session?: Partial<HubtelSession>; shop?: boolean } = {}): Setup {
  const np = fakeNetworkPlans(opts.np)
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
/** A screen fitMessage did not have to cut: no "..." and its own footer intact. */
const whole = (r: HubtelReply, footer: string) => {
  expect(r.Message.endsWith("...")).toBe(false)
  expect(r.Message.endsWith(footer)).toBe(true)
}
const toConfirm = (s: Setup) => send(s, "1", "1", "1", "1") // MTN, Internet, first plan, my number

describe("network plans: start + network", () => {
  it("start screen lists the three networks", async () => {
    const s = setup()
    const ctx: FlowCtx = { input: "", req: req({ SessionId: SID }), deps: s.deps, config: await s.deps.getConfig(), session: s.store.get(SID)! }
    const r = await startNetworkPlans(ctx)
    expect(r.Message).toBe("Standard Bundles\nSelect network:\n1. MTN\n2. Telecel\n3. AirtelTigo\n0. Back")
    expect(s.store.get(SID)?.step).toBe("NP_NETWORK")
  })
  it("categories in CATEGORY_ORDER, product words rewritten, tokens not stored yet", async () => {
    const s = setup()
    const r = await send(s, "1")
    expect(r.Message).toBe("MTN plans:\n1. Internet\n2. Video\n0. Back")
    expect(s.store.get(SID)).toMatchObject({ step: "NP_CATEGORY", npNetwork: "MTN", npCategories: ["Data", "Video"] })
    expect(s.np.calls).toHaveLength(0)
  })
  it("main-mode catalog context: hubtel_ussd, rail hubtel, no shop", async () => {
    const catalog = vi.fn(fakeNetworkPlans().catalog)
    const s = setup({ np: { catalog } })
    await send(s, "1")
    expect(catalog).toHaveBeenCalledWith({ botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME }, "MTN")
  })
  it("a switched-off catalog (403) stays on the network menu; 503 ends the session", async () => {
    const off = setup({ np: { catalog: async () => ({ ok: false, status: 403, error: "Not available" }) } })
    const r = await send(off, "2")
    expect(r.Message).toContain("Telecel: Not available right now.")
    expect(off.store.get(SID)?.step).toBe("NP_NETWORK")
    const down = setup({ np: { catalog: async () => ({ ok: false, status: 503, error: "x" }) } })
    const d = await send(down, "1")
    expect(d.Type).toBe("release")
    expect(d.Message).toBe(NP_TEXT.unavailable)
  })
  it("'0' on networks: main menu in main mode, product menu in shop mode", async () => {
    // Not recorded in `all`: the main / product menus are not this flow's screens.
    const zero = (x: Setup) => hubtelRouter(req({ SessionId: SID, Message: "0" }), x.deps)
    const s = setup()
    expect((await zero(s)).Message).toContain("Welcome to Clingshub")
    const shop = setup({ shop: true, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } })
    const r = await zero(shop)
    expect(r.Message).toContain("What would you like to buy?")
    expect(shop.store.get(SID)?.step).toBe("SHOP_PRODUCT")
  })
})

describe("network plans: paging (5 per screen, 0 Next / 00 Back)", () => {
  it("pages forward and back, then back to the categories", async () => {
    const s = setup()
    const p1 = await send(s, "1", "1")
    expect(p1.Message).toBe("MTN Internet\n1. 1GB GHS 9.50\n2. 2GB GHS 10.50\n3. 3GB GHS 11.50\n4. 4GB GHS 12.50\n5. 5GB GHS 13.50\n0 Next\n00 Back")
    expect(s.store.get(SID)?.npPlans).toHaveLength(5)
    const p2 = await send(s, "0")
    expect(p2.Message).toBe("MTN Internet\n1. 6GB GHS 14.50\n2. 7GB GHS 15.50\n00 Back")
    expect(s.store.get(SID)).toMatchObject({ npPage: 1, npPlans: [{ t: "tok-Data-5", d: "6GB", f: 15, p: 14.5 }, { t: "tok-Data-6", d: "7GB", f: 16, p: 15.5 }] })
    expect((await send(s, "0")).Message).toBe(p2.Message) // no page after the last
    expect((await send(s, "00")).Message).toBe(p1.Message)
    const cats = await send(s, "00")
    expect(cats.Message).toBe("MTN plans:\n1. Internet\n2. Video\n0. Back")
    expect(s.store.get(SID)?.step).toBe("NP_CATEGORY")
  })
  it("selecting on page 2 picks that page's plan", async () => {
    const s = setup()
    await send(s, "1", "1", "0", "2")
    expect(s.store.get(SID)).toMatchObject({ step: "NP_RECIPIENT", npPlan: { t: "tok-Data-6", d: "7GB", f: 16, p: 15.5 } })
  })
  it("long plan names are shortened by the flow (never cut by fitMessage): footers survive", async () => {
    const long = (i: number) => `MTN Data Bundle super saver plan with a very long description number ${i} valid 30 days`
    const s = setup({ np: { catalog: async () => ({ ok: true, categories: [{ name: "Data", bundles: fakePlans("Data", 7, long) }] }) } })
    const screens = [await send(s, "1"), await send(s, "1"), await send(s, "0"), await send(s, "1"), await send(s, "1")]
    for (const [r, footer] of [[screens[0], "0. Back"], [screens[1], "0 Next\n00 Back"], [screens[2], "00 Back"], [screens[3], "0. Back"], [screens[4], "1 Confirm 2 Cancel"]] as const) {
      whole(r, footer)
      expect(r.Message).not.toMatch(/data|bundle/i)
    }
    expect(screens[1].Message).toContain("GHS 13.50\n0 Next\n00 Back")
    expect(screens[4].Message.startsWith("Pay GHS 14.50 (was GHS 15.00)\nYou receive ")).toBe(true)
    expect(screens[4].Message.endsWith(" on 0244123456\n1 Confirm 2 Cancel")).toBe(true)
  })
})

describe("network plans: recipient", () => {
  it("1 = my number -> confirm", async () => {
    const s = setup()
    const rec = await send(s, "1", "1", "1")
    expect(rec.Message).toBe("Send to:\n1. My number (0244123456)\n2. Other number\n0. Back")
    const c = await send(s, "1")
    expect(c.Message).toBe("Pay GHS 9.50 (was GHS 10.00)\nYou receive 1GB on 0244123456\n1 Confirm 2 Cancel")
    expect(s.store.get(SID)).toMatchObject({ step: "NP_CONFIRM", npRecipient: "0244123456" })
  })
  it("2 = other number: typed, prefix-checked against the network", async () => {
    const s = setup()
    await send(s, "1", "1", "1")
    expect((await send(s, "2")).Message).toBe("Enter recipient number:\n0. Back")
    const bad = await send(s, "0201234567") // Telecel number for an MTN plan
    expect(bad.Message).toContain("Enter recipient number")
    expect(s.store.get(SID)?.step).toBe("NP_RECIPIENT")
    expect((await send(s, "12")).Message).toContain("Invalid number")
    const ok = await send(s, "0541234567")
    expect(ok.Message).toContain("You receive 1GB on 0541234567")
  })
  it("my number on the wrong network is refused with the reason", async () => {
    const s = setup({ session: { dialingPhone: "+233201234567" } })
    const r = await send(s, "1", "1", "1", "1")
    expect(r.Message).toContain("Send to:")
    expect(s.store.get(SID)?.step).toBe("NP_RECIPIENT")
  })
  it("'0' on the choice goes back to the plan page; '0' on typing goes back to the choice", async () => {
    const s = setup()
    await send(s, "1", "1", "1", "2")
    expect((await send(s, "0")).Message).toContain("Send to:")
    expect((await send(s, "0")).Message).toContain("MTN Internet\n1. 1GB")
  })
})

describe("network plans: confirm", () => {
  it("one engine order, tx row + AddToCart at payAmount, opaque cart name, no order insert here", async () => {
    const s = setup()
    await toConfirm(s)
    const r = await send(s, "1")
    expect(s.np.calls).toEqual([{
      ctx: { botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME },
      input: { token: "tok-Data-0", recipient: "0244123456", idempotencyKey: SID, expectedPay: 9.5 },
    }])
    expect(s.sup.inserts.hubtel_data_orders).toBeUndefined()
    expect(s.sup.inserts.hubtel_transactions).toEqual([{
      session_id: SID, platform: "USSD", order_table: "hubtel_data_orders", order_id: BOT_ORDER_ID, mobile: ME, expected_amount: 9.5,
    }])
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "CH order 22222222", Qty: 1, Price: 9.5 })
    expect(s.store.has(SID)).toBe(false)
  })
  it("carts at the engine's payAmount", async () => {
    const s = setup({ np: { createResult: { ok: true, order: { id: BOT_ORDER_ID, reference: "SB-1", payAmount: 9.49, faceAmount: 10, customerCashback: 0.51, paymentFee: 0 } } } })
    await toConfirm(s)
    expect((await send(s, "1")).Item?.Price).toBe(9.49)
  })
  it("idempotent: a repeated confirm (stale session or lost reply) never makes a second order", async () => {
    const s = setup()
    await toConfirm(s)
    const stale = s.store.get(SID)!
    const first = await send(s, "1")
    s.store.set(SID, stale) // a retried CONFIRM on the same session
    const again = await send(s, "1")
    const lost = await send(s, "1") // no session at all: router replay
    expect(s.np.calls).toHaveLength(1)
    expect(s.sup.inserts.hubtel_transactions).toHaveLength(1)
    expect(again).toEqual(first)
    expect(lost).toEqual(first)
  })
  it("concurrent confirm lost the tx insert (23505): the shared order is not failed, the winner's cart replays", async () => {
    const sup = fakeSupabase({
      rows: { hubtel_data_orders: OPEN_ROW },
      txConflictRow: { order_table: "hubtel_data_orders", order_id: BOT_ORDER_ID, expected_amount: 9.5, state: "awaiting_payment" },
    })
    const s = setup({ sup })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(sup.updates.filter(u => u.table === "hubtel_data_orders")).toEqual([])
    expect(r.Item).toEqual({ ItemName: "CH order 22222222", Qty: 1, Price: 9.5 })
  })
  it("tx insert failure: the engine order gets the bot fail patch", async () => {
    const sup = fakeSupabase({ txError: true, rows: { hubtel_data_orders: OPEN_ROW } })
    const s = setup({ sup })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Type).toBe("release")
    expect(sup.updates).toEqual([{ table: "hubtel_data_orders", patch: expect.objectContaining({ status: "failed", failure_reason: "payment not completed" }) }])
  })
  it.each([
    [409, "Price updated — please review", NP_TEXT.priceChanged, "Price changed. Please try again."],
    [429, "Too many requests. Please try again later.", NP_TEXT.tooMany, "Too many attempts. Please try later."],
    [403, "Not available", NP_TEXT.notAvailable, "Not available right now."],
    [503, "Temporarily unavailable", NP_TEXT.unavailable, "Service unavailable. Please try again later."],
    [400, "Invalid request, please try again", NP_TEXT.unavailable, "Service unavailable. Please try again later."],
  ])("engine %i => friendly text, session ended, no tx row", async (status, error, text, literal) => {
    expect(text).toBe(literal)
    const s = setup({ np: { createResult: { ok: false, status, error } } })
    await toConfirm(s)
    const r = await send(s, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(literal)
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
    expect(s.store.has(SID)).toBe(false)
  })
  it.each([
    ["failed", "unpaid"],
    ["pending", "paid"],
    ["completed", "paid"],
  ])("an engine-returned order that is %s/%s is never carted", async (status, payment_status) => {
    const sup = fakeSupabase({ rows: { hubtel_data_orders: { id: BOT_ORDER_ID, status, payment_status } } })
    const s = setup({ sup })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Type).toBe("release")
    expect(r.Message).toBe("Service unavailable. Please try again later.")
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    expect(sup.updates).toEqual([])
  })
  it("an engine order that cannot be read back is never carted", async () => {
    const s = setup({ sup: fakeSupabase() })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
  })
})

describe("network plans: orphan engine orders are failed (guarded)", () => {
  /** The guarded bot fail patch on this order: pending + unpaid + channel bots only. */
  const expectGuardedFail = (sup: ReturnType<typeof fakeSupabase>) => {
    expect(sup.updates).toEqual([{ table: "hubtel_data_orders", patch: expect.objectContaining({ status: "failed", failure_reason: "payment not completed" }) }])
    expect((sup.updates[0] as any).filters).toEqual([
      ["eq", "id", BOT_ORDER_ID], ["in", "payment_status", ["unpaid"]], ["in", "channel", ["bots"]], ["in", "status", ["pending"]],
    ])
    expect(sup.updates[0].patch).not.toHaveProperty("payment_status")
  }
  it.each([
    ["the read-back returns no row", { rows: {} }],
    ["the read-back errors", { rows: { hubtel_data_orders: OPEN_ROW }, readError: ["hubtel_data_orders"] }],
  ])("%s: not carted, the order is failed and its id logged", async (_why, opts) => {
    const sup = fakeSupabase(opts)
    const s = setup({ sup })
    await toConfirm(s)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    const logged = err.mock.calls.map(c => c.join(" "))
    vi.restoreAllMocks()
    expect(r).toMatchObject({ Type: "release", Message: NP_TEXT.unavailable })
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    expectGuardedFail(sup)
    expect(logged.some(l => l.includes("Failing uncarted engine order") && l.includes(BOT_ORDER_ID))).toBe(true)
  })
  it("createOrder threw after committing: the order found under this session's key is failed", async () => {
    const findOrderId = vi.fn(async () => BOT_ORDER_ID)
    const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
    const s = setup({ sup, np: { createOrder: async () => { throw new Error("socket hang up") }, findOrderId } })
    await toConfirm(s)
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(findOrderId).toHaveBeenCalledWith({ botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME }, SID)
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    expectGuardedFail(sup)
  })
  it("createOrder threw before committing (nothing found) or the lookup failed: nothing to fail", async () => {
    for (const findOrderId of [async () => null, async () => { throw new Error("db down") }]) {
      const sup = fakeSupabase({ rows: { hubtel_data_orders: OPEN_ROW } })
      const s = setup({ sup, np: { createOrder: async () => { throw new Error("boom") }, findOrderId } })
      await toConfirm(s)
      vi.spyOn(console, "error").mockImplementation(() => {})
      const r = await send(s, "1")
      vi.restoreAllMocks()
      expect(r.Message).toBe(NP_TEXT.unavailable)
      expect(sup.updates).toEqual([])
    }
  })
  it("2 cancels without an order", async () => {
    const s = setup()
    await toConfirm(s)
    const r = await send(s, "2")
    expect(r.Message).toBe("Order cancelled.")
    expect(s.np.calls).toHaveLength(0)
  })
})

describe("network plans: shop mode", () => {
  it("an accepted shop prices and orders with the shop context", async () => {
    const catalog = vi.fn(fakeNetworkPlans().catalog)
    const s = setup({ shop: true, np: { catalog }, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } })
    await toConfirm(s)
    await send(s, "1")
    const ctx = { botSurface: "hubtel_ussd", shopId: SHOP_UUID, rail: "hubtel", buyerPhone: ME }
    expect(catalog).toHaveBeenCalledWith(ctx, "MTN")
    expect(s.np.calls[0].ctx).toEqual(ctx)
  })
  it("shop mode without an accepted shop: fails closed, nothing created", async () => {
    const s = setup({ shop: true, session: { mode: "shop" } })
    const r = await send(s, "1")
    expect(r.Message).toBe(NP_TEXT.unavailable)
    expect(s.np.calls).toHaveLength(0)
  })
})

describe("network plans: helpers", () => {
  it("confirm text shows (was …) only below face and stays <= 182", () => {
    expect(networkPlanConfirmText({ t: "x", d: "1GB", f: 10, p: 10 }, "0244123456")).toBe("Pay GHS 10.00\nYou receive 1GB on 0244123456\n1 Confirm 2 Cancel")
    const worst = networkPlanConfirmText({ t: "x", d: "Z".repeat(400), f: 99999.99, p: 99999.98 }, "0244123456")
    expect(worst.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
  })
  it("idempotency key = the session id, hashed when not key-shaped", () => {
    expect(npIdempotencyKey(SID)).toBe(SID)
    expect(npIdempotencyKey("S1")).toMatch(/^[0-9a-f]{64}$/)
    expect(npIdempotencyKey("S1")).toBe(npIdempotencyKey("S1"))
  })
})

describe("network plans: wording", () => {
  it("no screen of a full run of every path says data or bundle, apart from the menu's own name (self-contained)", async () => {
    const screens: HubtelReply[] = []
    const run = async (s: Setup, ...inputs: string[]) => { await send(s, ...inputs); screens.push(...s.screens) }
    // Every network's categories, paging both ways, both recipient choices (bad + good numbers), cancel, cart.
    await run(setup(), "9", "1", "9", "1", "0", "0", "00", "00", "0", "2", "0", "3")
    await run(setup(), "1", "1", "1", "2", "0201234567", "12", "0541234567", "9", "2")
    await run(setup(), "1", "1", "1", "1", "1")
    await run(setup({ np: { catalog: async () => ({ ok: false, status: 403, error: "Not available" }) } }), "2")
    await run(setup({ np: { createResult: { ok: false, status: 409, error: "Price updated" } } }), "1", "1", "1", "1", "1")
    await run(setup({ shop: true, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } }), "1", "2", "1", "1", "1")
    expect(screens.length).toBeGreaterThan(25)
    for (const r of screens) {
      // "Standard Bundles" is the menu's name (owner's choice); provider plan text is still rewritten.
      expect(r.Message.replace(/Standard Bundles/g, "")).not.toMatch(/data|bundle/i)
      if (r.Item) expect(r.Item.ItemName).not.toMatch(/data|bundle|mtn|gb/i)
    }
  })
})

describe("standard bundles: delivery time, no number check", () => {
  it("shows the Standard Bundles delivery time and never runs the MTN number check", async () => {
    const s = setup()
    const asked: string[] = []
    let verified = 0
    s.deps.deliveryEstimate = async channel => { asked.push(channel); return "Delivery: ~2 min" }
    s.deps.verifyRecipient = async () => { verified++; return false }
    const c = await toConfirm(s)
    expect(c.Message).toBe("Pay GHS 9.50 (was GHS 10.00)\nYou receive 1GB on 0244123456\nDelivery: ~2 min\n1 Confirm 2 Cancel")
    expect(asked).toEqual(["standard"])
    expect(verified).toBe(0)
    // Re-shown on bad input from the session, no new lookup.
    expect((await send(s, "9")).Message).toContain("Delivery: ~2 min")
    expect(asked).toHaveLength(1)
  })
  it("no estimate: the screen is unchanged", async () => {
    const s = setup()
    s.deps.deliveryEstimate = async () => null
    expect((await toConfirm(s)).Message).toBe("Pay GHS 9.50 (was GHS 10.00)\nYou receive 1GB on 0244123456\n1 Confirm 2 Cancel")
  })
  it("never overflows the screen with a long plan description", () => {
    const plan = { t: "x", d: "Y".repeat(170), f: 10, p: 9.5 }
    expect(networkPlanConfirmText(plan, "0244123456", "Delivery: ~2 min").length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
  })
})
