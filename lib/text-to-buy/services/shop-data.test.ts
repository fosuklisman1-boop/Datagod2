import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateSegments } from "@/lib/sms/segments"
import { makeFakeTtb } from "../fake-db.test-helper"
import { deliveredGiftReply, paidNotDeliveredReply, shopOffReply, shopQuoteReply, shopSizeUnavailableReply, unpaidReply, wrongNumberReply } from "../replies"
import { TTB_DEFAULTS } from "../settings"
import type { ShopRef } from "../shop/resolve"
import type { OrderRead } from "../types"
import { isKnownLinkTriple } from "../types"
import { adapterForLink, makeAdapters } from "./index"
import { shopDataAdapter } from "./shop-data"

const S = "0200000101"
const R = "0240000150"
const db = {} as SupabaseClient
const shop: ShopRef = { shopCodeId: "sc1", shopId: "shop1", parentShopId: null, name: "Ama Data Hub", helpline: null }
const read: OrderRead = { kind: "order", service: "data", sizeMb: 5000, networkHint: null, recipient: null, bare: false }

const MTN_BUNDLES = [{ id: "b2", size: "2", price: 10 }, { id: "b5", size: "5", price: 23.5 }, { id: "b5x", size: "5", price: 30 }]
const deps = (over: Record<string, unknown> = {}) => ({
  shopPrices: vi.fn(async (_s: ShopRef, product: string) => (product === "MTN" ? MTN_BUNDLES : [])),
  verifyPrice: vi.fn(async (_s: ShopRef, id: string) => ({ verifiedPrice: id === "b5" ? 23.5 : 30 })),
  carrierOf: vi.fn(async (p: string) => (p.startsWith("024") ? ("MTN" as const) : p.startsWith("020") ? ("TELECEL" as const) : ("AT" as const))),
  confirmShop: vi.fn(async () => ({ orderId: "ord-1", amountGhs: 24.2 })),
  dataVisible: vi.fn(async () => true),
  ...over,
})
const oneSegment = (s: string) => expect([calculateSegments(s).encoding, calculateSegments(s).segments]).toEqual(["gsm7", 1])
const sendTo = (r: string) => ({ ...read, recipient: r })

describe("shop data adapter: resolve", () => {
  it("prices the size from the shop's own packages (the cheapest of two of one size) and verifies it", async () => {
    const d = deps()
    const r = await shopDataAdapter(d as never, shop).resolve(db, S, sendTo(R))
    expect(d.shopPrices).toHaveBeenCalledWith(shop, "MTN")
    expect(d.verifyPrice).toHaveBeenCalledWith(shop, "b5")
    expect(r).toMatchObject({
      ok: true,
      offer: { service: "data", size: "5", recipientLocal: R, gift: true, previewGhs: 23.5, paystackProvider: "vod", bundleId: "b5", shop, lastOrder: { sizeMb: 5000, network: "MTN", recipient: R } },
    })
  })

  it("an order to the sender's own number is not a gift", async () => {
    const r = await shopDataAdapter(deps({ carrierOf: vi.fn(async () => "MTN") }) as never, shop).resolve(db, "0240000101", read)
    expect(r).toMatchObject({ ok: true, offer: { gift: false, recipientLocal: "0240000101", paystackProvider: "mtn" } })
  })

  it("a size the shop does not sell is an unavailable refusal that names the shop", async () => {
    const r = await shopDataAdapter(deps() as never, shop).resolve(db, S, { ...sendTo(R), sizeMb: 7000 })
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopSizeUnavailableReply("Ama Data Hub", "MTN"), remember: false } })
    expect((r as { refusal: { reply: string } }).refusal.reply).toContain("Ama Data Hub")
  })

  it("a network the shop sells nothing on is unavailable and names the shop", async () => {
    const r = await shopDataAdapter(deps() as never, shop).resolve(db, S, { ...sendTo("0270000150") })
    expect(r).toMatchObject({ ok: false, refusal: { outcome: "unavailable", remember: false } })
    expect((r as { refusal: { reply: string } }).refusal.reply).toContain("Ama Data Hub")
  })

  it("a package the shop re-verification refuses is unavailable (never priced from the list alone)", async () => {
    const r = await shopDataAdapter(deps({ verifyPrice: vi.fn(async () => null) }) as never, shop).resolve(db, S, sendTo(R))
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopSizeUnavailableReply("Ama Data Hub", "MTN"), remember: false } })
  })

  it("an unreadable price list says the shop is not available now", async () => {
    const r = await shopDataAdapter(deps({ shopPrices: vi.fn(async () => { throw new Error("down") }) }) as never, shop).resolve(db, S, sendTo(R))
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopOffReply("Ama Data Hub"), remember: false } })
  })

  it("a bad recipient asks for a valid number; a network hint on another carrier asks which number", async () => {
    const bad = await shopDataAdapter(deps({ carrierOf: vi.fn(async () => null) }) as never, shop).resolve(db, S, sendTo(R))
    expect(bad).toEqual({ ok: false, refusal: { outcome: "asked", reply: wrongNumberReply(), remember: true } })
    const need = await shopDataAdapter(deps() as never, shop).resolve(db, S, { ...read, networkHint: "MTN" })
    expect(need).toMatchObject({ ok: false, refusal: { outcome: "asked", remember: true } })
    expect((need as { refusal: { reply: string } }).refusal.reply).toContain("MTN")
  })

  it("AT: when the shop sells the size on both products it asks which, and remembers the choices", async () => {
    const d = deps({
      carrierOf: vi.fn(async () => "AT"),
      shopPrices: vi.fn(async () => [{ id: "a5", size: "5", price: 20 }]),
    })
    const r = await shopDataAdapter(d as never, shop).resolve(db, S, { ...sendTo("0270000150") })
    expect(r).toMatchObject({ ok: false, refusal: { outcome: "asked", remember: true, pending: { type: "choices" } } })
    const reply = (r as { refusal: { reply: string } }).refusal.reply
    expect(reply).toContain("AT iShare")
    expect(reply).toContain("AT BigTime")
    oneSegment(reply)
  })

  it("no shop (a read-only registry) fails closed", async () => {
    const r = await shopDataAdapter(deps() as never, null).resolve(db, S, sendTo(R))
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopOffReply("This shop"), remember: false } })
  })

  it("the global data switch off: unavailable naming the shop, and nothing is priced", async () => {
    const d = deps({ dataVisible: vi.fn(async () => false) })
    const r = await shopDataAdapter(d as never, shop).resolve(db, S, sendTo(R))
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopOffReply("Ama Data Hub"), remember: false } })
    expect(d.shopPrices).not.toHaveBeenCalled()
    expect(d.verifyPrice).not.toHaveBeenCalled()
  })

  it("the global data switch on: normal pricing; the switch is read with the lane's db", async () => {
    const dataVisible = vi.fn(async () => true)
    const r = await shopDataAdapter(deps({ dataVisible }) as never, shop).resolve(db, S, sendTo(R))
    expect(r.ok).toBe(true)
    expect(dataVisible).toHaveBeenCalledWith(db)
  })

  it("an unreadable data switch fails closed", async () => {
    const d = deps({ dataVisible: vi.fn(async () => { throw new Error("down") }) })
    const r = await shopDataAdapter(d as never, shop).resolve(db, S, sendTo(R))
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: shopOffReply("Ama Data Hub"), remember: false } })
    expect(d.shopPrices).not.toHaveBeenCalled()
  })
})

describe("shop data adapter: place, quote, notices, reads", () => {
  const offerFor = async (d = deps(), over: Partial<OrderRead> = {}) => {
    const a = shopDataAdapter(d as never, shop)
    const r = (await a.resolve(db, S, { ...sendTo(R), ...over } as OrderRead)) as { ok: true; offer: Parameters<typeof a.place>[0] }
    return { a, offer: r.offer }
  }

  it("place calls the shop confirm with the shop, bundle, recipient, sender and the message id, and returns its order id and amount", async () => {
    const d = deps()
    const { a, offer } = await offerFor(d)
    const placed = await a.place(offer, "msg-1", S)
    expect(d.confirmShop).toHaveBeenCalledWith({
      shopCodeId: "sc1", shopId: "shop1", parentShopId: null, paystackProvider: "vod", bundleId: "b5", recipientLocal: R, senderLocal: S, messageId: "msg-1",
    })
    expect(placed).toEqual({ orderId: "ord-1", amountGhs: 24.2 })
  })

  it("place returns no order id when the shop confirm wrote none", async () => {
    const { a, offer } = await offerFor(deps({ confirmShop: vi.fn(async () => ({})) }))
    expect((await a.place(offer, "msg-2", S)).orderId).toBeUndefined()
  })

  it("a sub-agent shop passes its parent shop id through", async () => {
    const sub: ShopRef = { ...shop, parentShopId: "parent1" }
    const d = deps()
    const a = shopDataAdapter(d as never, sub)
    const r = (await a.resolve(db, S, sendTo(R))) as { ok: true; offer: Parameters<typeof a.place>[0] }
    await a.place(r.offer, "m", S)
    expect(d.confirmShop).toHaveBeenCalledWith(expect.objectContaining({ shopId: "shop1", parentShopId: "parent1" }))
  })

  it("the quote carries the shop name and the amount that was placed (price guarantee), not the preview", async () => {
    const { a, offer } = await offerFor()
    const placed = await a.place(offer, "msg-3", S)
    const text = a.quote(offer, { amountGhs: placed.amountGhs! }, { feeOnTop: false, payerNetwork: "TELECEL" })
    expect(text).toBe(shopQuoteReply({ shopName: "Ama Data Hub", size: "5GB", networkLabel: "MTN", recipientLocal: R, amountGhs: 24.2, feeOnTop: false, payerNetwork: "TELECEL" }))
    expect(text).toContain("GHS 24.20")
    expect(text).not.toContain("23.50")
    expect(text).toContain("Ama Data Hub")
  })

  it("'+ MoMo charge' only when the fee is on top and the written amount is not above the offer price", async () => {
    const { a, offer } = await offerFor()
    expect(a.quote(offer, { amountGhs: 23.5 }, { feeOnTop: true, payerNetwork: "MTN" })).toContain("+ MoMo charge")
    expect(a.quote(offer, { amountGhs: 24.2 }, { feeOnTop: true, payerNetwork: "MTN" })).not.toContain("+ MoMo charge")
  })

  it("a shop name with accents and emoji still quotes in one GSM-7 segment", async () => {
    const long = "Ama’s Café Élève \u{1F4F1}\u{1F525} Data Hub of Accra and Kumasi Region Gh"
    const a = shopDataAdapter(deps() as never, { ...shop, name: long })
    const r = (await a.resolve(db, S, sendTo(R))) as { ok: true; offer: Parameters<typeof a.quote>[0] }
    oneSegment(a.quote(r.offer, { amountGhs: 24.2 }, { feeOnTop: true, payerNetwork: "TELECEL" }))
  })

  it("a not-placed order is reported as unavailable naming the shop", async () => {
    const { a, offer } = await offerFor()
    expect(a.notPlacedReply(offer)).toBe(shopOffReply("Ama Data Hub"))
  })

  it("the text switch is on (the lane gates the line) and the notices follow the main data rules", () => {
    const a = shopDataAdapter(deps() as never, shop)
    expect(a.service).toBe("data")
    expect(a.orderTable).toBe("ussd_shop_orders")
    expect(a.textEnabled(TTB_DEFAULTS)).toBe(true)
    expect(a.notices.unpaid("1GB")).toBe(unpaidReply("1GB"))
    expect(a.notices.paidNotDelivered()).toBe(paidNotDeliveredReply())
    expect(a.notices.delivered({ size: "1GB", recipient: R, gift: true })).toBe(deliveredGiftReply("1GB", R))
    expect(a.notices.delivered({ size: "1GB", recipient: S, gift: false })).toBeNull()
  })

  it("reads the order from ussd_shop_orders (never ussd_orders) and classifies and reports status", async () => {
    const f = makeFakeTtb({
      ussd_shop_orders: [{ id: "O1", order_status: "completed", payment_status: "completed", amount: 5 }],
      ussd_orders: [{ id: "O2", order_status: "completed", payment_status: "completed", amount: 9 }],
    })
    const a = shopDataAdapter(deps() as never, shop)
    const row = await a.readOrder(f.client as unknown as SupabaseClient, "O1")
    expect(row).toEqual({ orderStatus: "completed", paymentStatus: "completed", amount: 5 })
    expect(a.classify(row!)).toBe("delivered")
    expect(a.statusOf({ state: "paid" }, row)).toBe("delivered")
    expect(await a.readOrder(f.client as unknown as SupabaseClient, "O2")).toBeNull()
  })
})

describe("line-aware registry", () => {
  it("returns different data adapters per line, and the shop line registers only data", () => {
    const main = makeAdapters({}, "main")
    const shopSet = makeAdapters({}, "shop", shop)
    expect(main.data!.orderTable).toBe("ussd_orders")
    expect(shopSet.data!.orderTable).toBe("ussd_shop_orders")
    expect(Object.keys(shopSet)).toEqual(["data"])
  })

  it("shop airtime and results-checker reads have no adapter, so the lane treats them as switched off", () => {
    const shopSet = makeAdapters({}, "shop", shop)
    expect(shopSet.airtime).toBeUndefined()
    expect(shopSet.results_checker).toBeUndefined()
  })

  it("main with no line argument is the Stage 1 set, unchanged", () => {
    const m = makeAdapters()
    expect(Object.keys(m).sort()).toEqual(["airtime", "data", "results_checker"])
    expect(m.data!.orderTable).toBe("ussd_orders")
    expect(m.airtime!.orderTable).toBe("airtime_orders")
    expect(m.results_checker!.orderTable).toBe("results_checker_orders")
    expect(Object.keys(makeAdapters({}, "main")).sort()).toEqual(Object.keys(m).sort())
  })

  it("adapterForLink picks the adapter by line and table and rejects unknown triples", () => {
    const main = makeAdapters({}, "main")
    const shopSet = makeAdapters({}, "shop", shop)
    expect(adapterForLink(main, { line: "main", service: "data", orderTable: "ussd_orders" })).toBe(main.data)
    expect(adapterForLink(main, { line: "main", service: "airtime", orderTable: "airtime_orders" })).toBe(main.airtime)
    expect(adapterForLink(shopSet, { line: "shop", service: "data", orderTable: "ussd_shop_orders" })).toBe(shopSet.data)
    // wrong line for the table, wrong set for the line, unknown pair or service: all null
    expect(adapterForLink(main, { line: "main", service: "data", orderTable: "ussd_shop_orders" })).toBeNull()
    expect(adapterForLink(shopSet, { line: "shop", service: "data", orderTable: "ussd_orders" })).toBeNull()
    expect(adapterForLink(main, { line: "shop", service: "data", orderTable: "ussd_shop_orders" })).toBeNull()
    expect(adapterForLink(shopSet, { line: "main", service: "data", orderTable: "ussd_shop_orders" })).toBeNull()
    expect(adapterForLink(shopSet, { line: "shop", service: "airtime", orderTable: "airtime_orders" })).toBeNull()
    expect(adapterForLink(main, { line: "other", service: "data", orderTable: "ussd_orders" })).toBeNull()
    expect(adapterForLink(main, { line: "main", service: "toString", orderTable: "ussd_orders" })).toBeNull()
  })

  it("isKnownLinkTriple", () => {
    expect(isKnownLinkTriple("main", "data", "ussd_orders")).toBe(true)
    expect(isKnownLinkTriple("shop", "data", "ussd_shop_orders")).toBe(true)
    expect(isKnownLinkTriple("shop", "airtime", "airtime_orders")).toBe(false)
    expect(isKnownLinkTriple("main", "data", "ussd_shop_orders")).toBe(false)
    expect(isKnownLinkTriple("shop", "data", "ussd_orders")).toBe(false)
    expect(isKnownLinkTriple("x", "data", "ussd_orders")).toBe(false)
  })
})
