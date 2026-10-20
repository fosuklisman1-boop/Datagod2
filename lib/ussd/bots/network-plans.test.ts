import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { BotCatalogResult } from "@/lib/bot-commission/catalog"
import type { BotChargeResult } from "@/lib/bot-commission/momo"
import type { BotOrderResult } from "@/lib/bot-commission/orders"
import { cont as mainCont, end as mainEnd } from "../menus"
import { cont as shopCont, end as shopEnd } from "@/lib/ussd-shop/menus"
import type { UzoResponse } from "../types"
import { handleNetworkPlansStep, startNetworkPlans, uzoNpIdempotencyKey, type NetworkPlansDeps } from "./network-plans"
import type { UzoBotCtx, UzoBotSession } from "./kit"
import { fitsUzo } from "./screen"

const SID = "uzo-session-0001"
const ME = "+233244123456" // MTN
const ME_LOCAL = "0244123456"
const SHOP = "11111111-2222-4333-8444-555555555555"
const ORDER = "99999999-8888-4777-8666-555555555555"
const SENT = `MoMo prompt sent to ${ME_LOCAL}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`

type Bundle = Extract<BotCatalogResult, { ok: true }>["categories"][number]["bundles"][number]
const bundle = (i: number, over: Partial<Bundle> = {}): Bundle => ({
  value: `MTN_Data_${i}`, display: `${i}GB Data Bundle 30 Days`, amount: 10 + i, category: "Data",
  token: `tok-${i}`, payAmount: 9.5 + i, customerCashback: 0.6, paymentFee: 0.1, ...over,
})
const CATALOG: BotCatalogResult = {
  ok: true,
  categories: [
    // Out of CATEGORY_ORDER on purpose (Video after Data); an empty category is hidden.
    { name: "Video", bundles: [bundle(100, { display: "Video Bundle 2GB", category: "Video" })] },
    { name: "Midnight", bundles: [] },
    { name: "Data", bundles: [1, 2, 3, 4, 5, 6, 7].map(i => bundle(i)) },
  ],
}

function setup(o: {
  surface?: "ussd" | "ussd_shop"; shopId?: string | null; shopName?: string
  catalog?: NetworkPlansDeps["catalog"]; createOrder?: NetworkPlansDeps["createOrder"]
  readOrder?: NetworkPlansDeps["readOrder"]; charge?: NetworkPlansDeps["charge"]
  findOrderId?: NetworkPlansDeps["findOrderId"]; prefixEnabled?: boolean
} = {}) {
  const surface = o.surface ?? "ussd"
  const shop = surface === "ussd_shop"
  const store = new Map<string, UzoBotSession>()
  const screens: UzoResponse[] = []
  const leave = vi.fn(async () => ({ message: "MENU", ussdServiceOp: 2 as const }))
  const deps = {
    io: {
      save: vi.fn(async (id: string, s: UzoBotSession) => { store.set(id, JSON.parse(JSON.stringify(s))) }),
      cont: shop ? shopCont : mainCont,
      end: shop ? shopEnd : mainEnd,
      leave,
    },
    catalog: vi.fn(o.catalog ?? (async () => CATALOG)),
    createOrder: vi.fn(o.createOrder ?? (async (): Promise<BotOrderResult> => ({
      ok: true, order: { id: ORDER, reference: "R1", payAmount: 10.5, faceAmount: 11, customerCashback: 0.6, paymentFee: 0.1 },
    }))),
    findOrderId: vi.fn(o.findOrderId ?? (async () => null)),
    readOrder: vi.fn(o.readOrder ?? (async () => ({ status: "pending", payment_status: "unpaid" }))),
    failOrder: vi.fn(async () => {}),
    charge: vi.fn(o.charge ?? (async (): Promise<BotChargeResult> => ({ ok: true, reference: "ref1", status: "pay_offline" }))),
    getPrefixConfig: vi.fn(async () => ({ enabled: o.prefixEnabled ?? true, map: DEFAULT_NETWORK_PREFIXES })),
  }
  const ctx: UzoBotCtx = {
    surface, sessionId: SID, dialingPhone: ME,
    shopId: o.shopId === undefined ? (shop ? SHOP : null) : o.shopId,
    shopName: o.shopName ?? (shop ? "Ama Shop" : undefined),
  }
  const base: UzoBotSession = shop
    ? { step: "SELECT_PRODUCT", dialingPhone: ME, shopId: ctx.shopId ?? undefined, shopName: ctx.shopName, shopCodeId: "c1" }
    : { step: "MAIN", dialingPhone: ME }
  async function start() {
    const r = await startNetworkPlans(ctx, base, deps)
    screens.push(r)
    return r
  }
  async function send(...inputs: string[]) {
    let r!: UzoResponse
    for (const m of inputs) {
      r = await handleNetworkPlansStep(ctx, m, store.get(SID) ?? base, deps)
      screens.push(r)
    }
    return r
  }
  return { deps, ctx, store, screens, start, send, leave }
}

/** A screen the 160-char truncation did not touch: fits, no "...", footer intact. */
function whole(r: UzoResponse) {
  expect(fitsUzo(r.message)).toBe(true)
  expect(r.message.endsWith("...")).toBe(false)
  if (r.ussdServiceOp === 2 && r.message !== "MENU") expect(r.message).toMatch(/(0\. Back|2\. Cancel)$/)
}
const noProductWords = (r: UzoResponse) => expect(r.message).not.toMatch(/data|bundle/i)

describe("network plans: networks + categories", () => {
  it("network list uses the Uzo nicknames", async () => {
    const t = setup()
    const r = await t.start()
    expect(r).toEqual({ message: "Network Plans\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n0. Back", ussdServiceOp: 2 })
    expect(t.store.get(SID)?.step).toBe("NP_NETWORK")
  })

  it("shop: the network list starts with the shop name; no shop id => fail closed, nothing saved", async () => {
    const t = setup({ surface: "ussd_shop" })
    expect((await t.start()).message).toBe("Ama Shop\nNetwork Plans\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n0. Back")
    const n = setup({ surface: "ussd_shop", shopId: null })
    const r = await n.start()
    expect(r).toEqual({ message: "Service unavailable. Please try again later.", ussdServiceOp: 17 })
    expect(n.store.size).toBe(0)
    expect((await n.send("1")).ussdServiceOp).toBe(17)
    expect(n.deps.catalog).not.toHaveBeenCalled()
  })

  it("categories: non-empty, in CATEGORY_ORDER, names rewritten (Data => Internet)", async () => {
    const t = setup()
    await t.start()
    const r = await t.send("1")
    expect(r.message).toBe("Yellow Plans\nSelect type:\n1. Internet\n2. Video\n0. Back")
    expect(t.store.get(SID)).toMatchObject({ step: "NP_CATEGORY", npNetwork: "MTN", npCategories: ["Data", "Video"] })
  })

  it("engine context: main => surface ussd, no shop; shop => ussd_shop + the session's shop; rail paystack", async () => {
    const m = setup()
    await m.start(); await m.send("1")
    expect(m.deps.catalog).toHaveBeenCalledWith({ botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: ME }, "MTN")
    const s = setup({ surface: "ussd_shop" })
    await s.start(); await s.send("2")
    expect(s.deps.catalog).toHaveBeenCalledWith({ botSurface: "ussd_shop", shopId: SHOP, rail: "paystack", buyerPhone: ME }, "TELECEL")
  })

  it("catalog 403 / empty => network list again with 'Not available'; other errors end the session", async () => {
    const t = setup({ catalog: async () => ({ ok: false, status: 403, error: "Not available" }) })
    await t.start()
    const r = await t.send("3")
    expect(r.message).toBe("Not available right now.\nNetwork Plans\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n0. Back")
    expect(t.store.get(SID)?.step).toBe("NP_NETWORK")
    const e = setup({ catalog: async () => ({ ok: false, status: 503, error: "Hubtel down: provider text" }) })
    await e.start()
    expect(await e.send("1")).toEqual({ message: "Service unavailable. Please try again later.", ussdServiceOp: 17 })
    const x = setup({ catalog: async () => { throw new Error("boom") } })
    await x.start()
    expect((await x.send("1")).message).toBe("Service unavailable. Please try again later.")
  })
})

describe("network plans: plan list paging", () => {
  it("5 per page, More / Back, price first (a long name is shortened, never the price), names rewritten", async () => {
    const t = setup()
    await t.start()
    const p0 = await t.send("1", "1")
    expect(p0.message).toBe(
      "Yellow Plans Internet\n" +
      "1. GHS 10.50 1GB Intern\n2. GHS 11.50 2GB Intern\n3. GHS 12.50 3GB Intern\n" +
      "4. GHS 13.50 4GB Intern\n5. GHS 14.50 5GB Intern\n6. More...\n0. Back",
    )
    expect(t.store.get(SID)).toMatchObject({ step: "NP_PLAN", npCategory: "Data", npPage: 0 })
    expect(t.store.get(SID)?.npPlans?.map(p => p.t)).toEqual(["tok-1", "tok-2", "tok-3", "tok-4", "tok-5"])

    const p1 = await t.send("6")
    expect(p1.message).toBe("Yellow Plans Internet\n6. GHS 15.50 6GB Internet 30 Days\n7. GHS 16.50 7GB Internet 30 Days\n0. Back")
    expect(t.store.get(SID)).toMatchObject({ npPage: 1 })
    expect(t.store.get(SID)?.npPlans?.map(p => p.t)).toEqual(["tok-6", "tok-7"])

    expect((await t.send("0")).message).toBe(p0.message) // back a page
    expect((await t.send("0")).message).toBe("Yellow Plans\nSelect type:\n1. Internet\n2. Video\n0. Back") // back to types
  })

  it("picks by the number shown on a later page; the stored plan carries the token and shown price", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1", "6")
    const r = await t.send("7")
    expect(r.message).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    expect(t.store.get(SID)?.npPlan).toEqual({ t: "tok-7", d: "7GB Data Bundle 30 Days", f: 17, p: 16.5 })
  })

  it("a page past the end is clamped to the last page; a stale page number never shows an empty list", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1")
    t.store.set(SID, { ...t.store.get(SID)!, npPage: 9, npPlans: [] })
    const r = await t.send("x")
    expect(r.message).toContain("6. GHS 15.50")
    expect(t.store.get(SID)?.npPage).toBe(1)
    // "More" on the last page just repaints it.
    const again = await t.send("8")
    expect(again.message).toBe(r.message)
  })
})

describe("network plans: recipient", () => {
  it("other number: invalid, wrong network (prefix map), then valid", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1", "1")
    expect((await t.send("2")).message).toBe("Enter recipient number:\n\n0. Back")
    expect((await t.send("123")).message).toBe("Invalid number.\nEnter recipient number:\n\n0. Back")
    expect((await t.send("0201234567")).message).toBe("Number does not match network.\nEnter recipient number:\n\n0. Back")
    const r = await t.send("055 123 4567")
    expect(t.store.get(SID)).toMatchObject({ step: "NP_CONFIRM", npRecipient: "0551234567" })
    expect(r.message).toContain("To: 0551234567")
  })

  it("my number on another network is refused at the recipient step (prefix check on)", async () => {
    const t = setup()
    await t.start()
    await t.send("2", "1", "1") // Telecel plan, MTN dialler
    expect((await t.send("1")).message).toBe("Number does not match network.\nRecipient:\n1. My number\n2. Other number\n0. Back")
    const off = setup({ prefixEnabled: false })
    await off.start()
    await off.send("2", "1", "1")
    await off.send("1")
    expect(off.store.get(SID)?.step).toBe("NP_CONFIRM")
  })
})

describe("network plans: confirm + pay", () => {
  it("main happy path: confirm screen, engine + charge contexts (no shop), prompt-sent end", async () => {
    const t = setup()
    await t.start()
    const c = await t.send("1", "1", "1", "1")
    expect(c.message).toBe(
      "Pay GHS 10.50 (was GHS 11.00)\nYou get Yellow Plans 1GB Internet 30 Days\nTo: 0244123456\nMoMo: 0244123456\n1. Confirm\n2. Cancel",
    )
    const r = await t.send("1")
    expect(r).toEqual({ message: SENT, ussdServiceOp: 17 })
    expect(t.deps.createOrder).toHaveBeenCalledWith(
      { botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: ME },
      { token: "tok-1", recipient: ME_LOCAL, idempotencyKey: SID, expectedPay: 10.5 },
    )
    expect(t.deps.readOrder).toHaveBeenCalledWith(ORDER)
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bundle", orderId: ORDER, botSurface: "ussd", shopId: null, dialingPhone: ME })
    expect(t.deps.failOrder).not.toHaveBeenCalled()
  })

  it("shop happy path: engine + charge carry the session's shop", async () => {
    const t = setup({ surface: "ussd_shop" })
    await t.start()
    const c = await t.send("1", "1", "1", "1")
    expect(c.message.startsWith("Ama Shop\nPay GHS 10.50")).toBe(true)
    expect(await t.send("1")).toEqual({ message: SENT, ussdServiceOp: 17 })
    expect(t.deps.createOrder).toHaveBeenCalledWith(
      { botSurface: "ussd_shop", shopId: SHOP, rail: "paystack", buyerPhone: ME },
      { token: "tok-1", recipient: ME_LOCAL, idempotencyKey: SID, expectedPay: 10.5 },
    )
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bundle", orderId: ORDER, botSurface: "ussd_shop", shopId: SHOP, dialingPhone: ME })
  })

  it("an idempotent replay (status pending) shows the same prompt-sent text", async () => {
    const t = setup({ charge: async () => ({ ok: true, reference: "ref0", status: "pending" }) })
    await t.start()
    expect((await t.send("1", "1", "1", "1", "1")).message).toBe(SENT)
  })

  it("no '(was ...)' when the price is not below face", async () => {
    const t = setup({ catalog: async () => ({ ok: true, categories: [{ name: "Data", bundles: [bundle(1, { payAmount: 11 })] }] }) })
    await t.start()
    const c = await t.send("1", "1", "1", "1")
    expect(c.message.startsWith("Pay GHS 11.00\n")).toBe(true)
  })

  it.each([
    [409, "Price changed. Please try again."],
    [429, "Too many attempts. Please try later."],
    [403, "Not available right now."],
    [400, "Service unavailable. Please try again later."],
    [503, "Service unavailable. Please try again later."],
  ])("engine %i => '%s', nothing charged, never the engine text", async (status, text) => {
    const t = setup({ createOrder: async () => ({ ok: false, status, error: "Hubtel said: secret provider text" }) })
    await t.start()
    expect(await t.send("1", "1", "1", "1", "1")).toEqual({ message: text, ussdServiceOp: 17 })
    expect(t.deps.charge).not.toHaveBeenCalled()
    expect(t.deps.readOrder).not.toHaveBeenCalled()
  })

  it("engine throws: an order committed under the key is failed (guarded); nothing charged", async () => {
    const t = setup({ createOrder: async () => { throw new Error("db") }, findOrderId: async () => ORDER })
    await t.start()
    expect((await t.send("1", "1", "1", "1", "1")).message).toBe("Service unavailable. Please try again later.")
    expect(t.deps.findOrderId).toHaveBeenCalledWith({ botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: ME }, SID)
    expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
    expect(t.deps.charge).not.toHaveBeenCalled()
  })

  it("read-back not pending+unpaid => refusal, no charge, the order left alone", async () => {
    for (const row of [{ status: "pending", payment_status: "paid" }, { status: "failed", payment_status: "unpaid" }]) {
      const t = setup({ readOrder: async () => row })
      await t.start()
      expect((await t.send("1", "1", "1", "1", "1")).message).toBe("Service unavailable. Please try again later.")
      expect(t.deps.charge).not.toHaveBeenCalled()
      expect(t.deps.failOrder).not.toHaveBeenCalled()
    }
  })

  it("read-back error / no row => the order is failed (guarded), no charge", async () => {
    for (const readOrder of [async () => null, async () => { throw new Error("read") }]) {
      const t = setup({ readOrder })
      await t.start()
      expect((await t.send("1", "1", "1", "1", "1")).message).toBe("Service unavailable. Please try again later.")
      expect(t.deps.charge).not.toHaveBeenCalled()
      expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
    }
  })

  it("charge throws => the order is failed (guarded) and a friendly text shown", async () => {
    const t = setup({ charge: async () => { throw new Error("paystack 500: raw") } })
    await t.start()
    expect(await t.send("1", "1", "1", "1", "1")).toEqual({ message: "Service unavailable. Please try again later.", ussdServiceOp: 17 })
    expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
  })

  it("charge refusals show their own buyer text; CHARGE_FAILED leaves the order untouched here", async () => {
    const cases: [BotChargeResult, string][] = [
      [{ ok: false, code: "CHARGE_FAILED", message: "Service unavailable. Please try again later." }, "Service unavailable. Please try again later."],
      [{ ok: false, code: "NO_PROVIDER", message: "Payment not available for your number." }, "Payment not available for your number."],
      [{ ok: false, code: "RATE_LIMITED", message: "Too many attempts. Please try later." }, "Too many attempts. Please try later."],
    ]
    for (const [result, text] of cases) {
      const t = setup({ charge: async () => result })
      await t.start()
      expect(await t.send("1", "1", "1", "1", "1")).toEqual({ message: text, ussdServiceOp: 17 })
      expect(t.deps.failOrder).not.toHaveBeenCalled()
    }
  })

  it("2 cancels; anything else repaints the confirm screen", async () => {
    const t = setup()
    await t.start()
    const c = await t.send("1", "1", "1", "1")
    expect((await t.send("9")).message).toBe(c.message)
    expect(await t.send("2")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })

  it("idempotency key: the session id when key-shaped, else a stable hash", () => {
    expect(uzoNpIdempotencyKey(SID)).toBe(SID)
    const k = uzoNpIdempotencyKey("abc")
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(uzoNpIdempotencyKey("abc")).toBe(k)
  })
})

describe("network plans: 0 goes back at every step", () => {
  it("network => leaves to the menu; category => networks; plans => types; recipient => plans; other => recipient; confirm => recipient", async () => {
    const t = setup()
    await t.start()
    await t.send("1")
    expect((await t.send("0")).message).toBe("Network Plans\n1. Yellow Plans\n2. Tele\n3. Instant Blue\n0. Back")
    const plans = await t.send("1", "1")
    await t.send("1")
    expect((await t.send("0")).message).toBe(plans.message)
    await t.send("1", "2")
    expect((await t.send("0")).message).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    await t.send("1")
    expect(t.store.get(SID)?.step).toBe("NP_CONFIRM")
    expect((await t.send("0")).message).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    await t.send("1")
    // Back out completely.
    await t.send("0", "0", "0", "0")
    expect(t.store.get(SID)?.step).toBe("NP_NETWORK")
    expect(await t.send("0")).toEqual({ message: "MENU", ussdServiceOp: 2 })
    expect(t.leave).toHaveBeenCalledTimes(1)
    const left = t.leave.mock.calls[0] as unknown as [UzoBotCtx, UzoBotSession]
    expect(left[1].npNetwork).toBeUndefined()
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })
})

describe("network plans: every screen fits 160 with its footer, and never says data/bundle", () => {
  const longName = "Super Mega Data Bundle Ultra Value Pack For Students With Bonus Social Media Minutes Night"
  const longCatalog: BotCatalogResult = {
    ok: true,
    categories: [
      { name: "Fuse (Mins + Data)", bundles: [1, 2, 3, 4, 5, 6].map(i => bundle(i, { display: `${i} ${longName}`, payAmount: 1000 + i, amount: 2000 })) },
      { name: "BigTime", bundles: [bundle(9, { display: "BigTime Data 10GB" })] },
    ],
  }
  for (const surface of ["ussd", "ussd_shop"] as const) {
    it(`${surface}: full walk with long names`, async () => {
      const t = setup({ surface, shopName: "The Very Long Shop Name Enterprises Limited Ghana", catalog: async () => longCatalog, prefixEnabled: false })
      await t.start()
      // AT: BigTime is listed first (CATEGORY_ORDER), so "2" = Fuse, the long one; "6" = More.
      await t.send("9", "3", "x", "2", "x", "6", "x", "0", "1", "x", "2", "1", "0", "1", "x")
      expect(t.screens.some(s => s.message.includes("6. More..."))).toBe(true)
      expect(t.store.get(SID)?.step).toBe("NP_CONFIRM")
      await t.send("1")
      expect(t.screens.length).toBeGreaterThan(12)
      for (const r of t.screens) {
        whole(r)
        noProductWords(r)
      }
    })
  }
})
