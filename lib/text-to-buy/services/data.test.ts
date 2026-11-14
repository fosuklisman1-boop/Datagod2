import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "../fake-db.test-helper"
import type { Offer, OfferResult } from "../catalogue"
import { dedupeNearest, productQuestion } from "../inbound-steps"
import { deliveredGiftReply, fitOneSegment, paidNotDeliveredReply, quoteReply, unavailableReply, unpaidReply, wrongNumberReply } from "../replies"
import { TTB_DEFAULTS } from "../settings"
import type { OrderRead } from "../types"
import { dataAdapter } from "./data"

vi.mock("@/lib/ussd/handlers/bundles", () => ({ handleConfirm: vi.fn() }))
vi.mock("../catalogue", () => ({
  resolveOffer: vi.fn(),
  sizeLabel: (s: string) => `${s}GB`,
  parseSizeMb: (s: string) => Number(s) * 1000,
  sessionForOffer: (sender: string, o: Offer) => ({ dialingPhone: "+233" + sender.slice(1), bundleId: o.bundleId, recipientPhone: o.recipientLocal }),
}))

const S = "0200000101"
const R = "0200000150"
const db = {} as SupabaseClient
const tier = {} as Offer["tier"]
const offerOf = (over: Partial<Offer> = {}): Offer => ({
  network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: S, gift: false, tier, paystackProvider: "mtn", ...over,
})
const read: OrderRead = { kind: "order", service: "data", sizeMb: 5000, networkHint: null, recipient: null, bare: false }
const adapterFor = (res: OfferResult) => dataAdapter({ resolve: vi.fn(async () => res) as never })

describe("data adapter: resolve", () => {
  it("passes the sender, size, hint and recipient through and maps an ok offer", async () => {
    const resolve = vi.fn(async () => ({ ok: true, offer: offerOf({ recipientLocal: R, gift: true }) }) as OfferResult)
    const r = await dataAdapter({ resolve: resolve as never }).resolve(db, S, { ...read, networkHint: "AT", recipient: R })
    expect(resolve).toHaveBeenCalledWith(db, { senderLocal: S, sizeMb: 5000, networkHint: "AT", recipient: R })
    expect(r).toMatchObject({
      ok: true,
      offer: { service: "data", size: "5", recipientLocal: R, gift: true, previewGhs: 23.69, paystackProvider: "mtn", lastOrder: { sizeMb: 5000, network: "MTN", recipient: R } },
    })
  })

  it("choose_product asks the product question and remembers its choices", async () => {
    const options = [offerOf({ network: "AT-iShare", networkLabel: "AT" }), offerOf({ network: "AT-BigTime", networkLabel: "AT" })]
    const q = productQuestion(options, read)
    const r = await adapterFor({ ok: false, reason: "choose_product", options }).resolve(db, S, read)
    expect(r).toEqual({ ok: false, refusal: { outcome: "asked", reply: q.question, pending: q.pending, remember: true } })
  })

  it("need_recipient asks for the number and remembers", async () => {
    const r = await adapterFor({ ok: false, reason: "need_recipient", networkLabel: "Telecel" }).resolve(db, S, read)
    expect(r).toEqual({ ok: false, refusal: { outcome: "asked", reply: fitOneSegment(["Which Telecel number should receive it?"]), remember: true } })
  })

  it("bad_recipient gives the wrong-number reply and remembers", async () => {
    const r = await adapterFor({ ok: false, reason: "bad_recipient" }).resolve(db, S, read)
    expect(r).toEqual({ ok: false, refusal: { outcome: "asked", reply: wrongNumberReply(), remember: true } })
  })

  it("no_package lists the nearest sizes once each and is not remembered", async () => {
    const nearest = [{ size: "1GB", priceGhs: 5 }, { size: "1GB", priceGhs: 6 }, { size: "2GB", priceGhs: 10 }]
    const r = await adapterFor({ ok: false, reason: "no_package", networkLabel: "MTN", nearest }).resolve(db, S, read)
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: unavailableReply("MTN", dedupeNearest(nearest)), remember: false } })
  })

  it.each(["service_off", "prices_unavailable"] as const)("%s says this network is unavailable and is not remembered", async (reason) => {
    const r = await adapterFor({ ok: false, reason }).resolve(db, S, read)
    expect(r).toEqual({ ok: false, refusal: { outcome: "unavailable", reply: unavailableReply("this network", []), remember: false } })
  })
})

describe("data adapter: place, quote, notices", () => {
  it("place confirms with the sms channel, momoOnly and an opaque session id, and maps the response", async () => {
    const confirm = vi.fn(async () => ({ type: "end", message: "x", orderId: "ord-1", amount: 23.69 }))
    const adapter = dataAdapter({ confirm: confirm as never })
    const offer = (await adapterFor({ ok: true, offer: offerOf() }).resolve(db, S, read)) as { ok: true; offer: Parameters<typeof adapter.place>[0] }
    const placed = await adapter.place(offer.offer, "msg-1", S)
    expect(confirm).toHaveBeenCalledWith("1", "sms:msg-1", expect.objectContaining({ dialingPhone: "+233" + S.slice(1) }), "sms", { momoOnly: true })
    expect(placed).toEqual({ orderId: "ord-1", amountGhs: 23.69 })
  })

  it("place returns no order id when confirm wrote none", async () => {
    const confirm = vi.fn(async () => ({ type: "end", message: "x" }))
    const adapter = dataAdapter({ confirm: confirm as never })
    const offer = (await adapterFor({ ok: true, offer: offerOf() }).resolve(db, S, read)) as { ok: true; offer: Parameters<typeof adapter.place>[0] }
    expect(await adapter.place(offer.offer, "msg-2", S)).toEqual({ orderId: undefined, amountGhs: undefined })
  })

  const quoteFor = async (amountGhs: number, feeOnTop: boolean) => {
    const adapter = dataAdapter()
    const r = (await adapterFor({ ok: true, offer: offerOf() }).resolve(db, S, read)) as { ok: true; offer: Parameters<typeof adapter.quote>[0] }
    return adapter.quote(r.offer, { amountGhs }, { feeOnTop, payerNetwork: "MTN" })
  }
  it("quote adds '+ MoMo charge' when the fee is on top and the amount is the offer price", async () => {
    expect(await quoteFor(23.69, true)).toBe(quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 23.69, feeOnTop: true, payerNetwork: "MTN" }))
    expect(await quoteFor(23.69, true)).toContain("+ MoMo charge")
  })
  it("quote drops '+ MoMo charge' when the written amount is above the offer price", async () => {
    const text = await quoteFor(24.5, true)
    expect(text).not.toContain("+ MoMo charge")
    expect(text).toBe(quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 24.5, feeOnTop: false, payerNetwork: "MTN" }))
  })

  it("a not-placed order is reported as unavailable for the network", async () => {
    const adapter = dataAdapter()
    const r = (await adapterFor({ ok: true, offer: offerOf({ networkLabel: "Telecel", network: "Telecel" }) }).resolve(db, S, read)) as { ok: true; offer: Parameters<typeof adapter.notPlacedReply>[0] }
    expect(adapter.notPlacedReply(r.offer)).toBe(unavailableReply("Telecel", []))
  })

  it("the text switch is always on and the notices are the Stage 1 templates", () => {
    const a = dataAdapter()
    expect(a.textEnabled(TTB_DEFAULTS)).toBe(true)
    expect(a.notices.unpaid("1GB")).toBe(unpaidReply("1GB"))
    expect(a.notices.paidNotDelivered()).toBe(paidNotDeliveredReply())
    expect(a.notices.delivered({ size: "1GB", recipient: R, gift: true })).toBe(deliveredGiftReply("1GB", R))
    expect(a.notices.delivered({ size: "1GB", recipient: S, gift: false })).toBeNull()
  })

  it("reads the order from ussd_orders and classifies and reports status like Stage 1", async () => {
    const f = makeFakeTtb({ ussd_orders: [{ id: "O1", order_status: "completed", payment_status: "completed", amount: 5 }] })
    const a = dataAdapter()
    const row = await a.readOrder(f.client as unknown as SupabaseClient, "O1")
    expect(row).toEqual({ orderStatus: "completed", paymentStatus: "completed", amount: 5 })
    expect(a.classify(row!)).toBe("delivered")
    expect(a.statusOf({ state: "paid" }, row)).toBe("delivered")
    expect(await a.readOrder(f.client as unknown as SupabaseClient, "missing")).toBeNull()
    expect(a.statusOf({ state: "paid" }, null)).toBe("processing")
  })
})
