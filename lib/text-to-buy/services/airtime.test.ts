import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateSegments } from "@/lib/sms/segments"

const h = vi.hoisted(() => ({
  map: { MTN: ["24"], TELECEL: ["20"], AT: ["27"] } as Record<string, string[]>,
  enabled: vi.fn(async (_n: string) => true),
  limits: vi.fn(async () => ({ min: 1, max: 500 })),
  rate: vi.fn(async (_n: string, _dealer: boolean) => 5),
  dialer: vi.fn(async (_p: string) => ({}) as Record<string, unknown>),
  blocked: vi.fn(async (_n: string, _p: string) => false),
  visibility: vi.fn(async () => ({})),
}))

vi.mock("@/lib/airtime-pricing", () => ({
  // The real static prefix table and split, without the module's top-level Supabase client.
  detectAirtimeNetwork: (p: string) => ({ "024": "MTN", "020": "Telecel", "027": "AT", "026": "AT" } as Record<string, string>)[p.slice(0, 3)] ?? null,
  splitInclusive: (amount: number, rate: number) => {
    const fee = parseFloat(((amount * rate) / (100 + rate)).toFixed(2))
    return { fee, toDeliver: parseFloat((amount - fee).toFixed(2)) }
  },
  isAirtimeEnabled: h.enabled,
  getAirtimeLimits: h.limits,
  airtimeBaseFeeRate: h.rate,
}))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: h.dialer }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: h.blocked }))
vi.mock("@/lib/ussd-service-visibility", () => ({ getUssdServiceVisibility: h.visibility }))
vi.mock("@/lib/ussd/handlers/airtime", () => ({ confirmAirtimeByText: vi.fn() }))

import { airtimeAdapter, airtimeSession, type AirtimeOffer } from "./airtime"
import { TTB_DEFAULTS } from "../settings"
import type { OrderRead } from "../types"

const S = "0200000101"
const R = "0200000102"
const db = {} as SupabaseClient
type Air = Extract<OrderRead, { service: "airtime" }>
const read = (o: Partial<Air> = {}): OrderRead => ({ kind: "order", service: "airtime", amountGhs: 10, networkHint: null, recipient: null, ...o })
const resolve = (r: OrderRead, sender = S) => airtimeAdapter().resolve(db, sender, r)
const offerOf = async (r: OrderRead, sender = S): Promise<AirtimeOffer> => {
  const res = await resolve(r, sender)
  if (!res.ok) throw new Error("expected an offer, got " + res.refusal.reply)
  return res.offer
}

beforeEach(() => {
  h.map = { MTN: ["24"], TELECEL: ["20"], AT: ["27"] }
  h.enabled.mockReset().mockResolvedValue(true)
  h.limits.mockReset().mockResolvedValue({ min: 1, max: 500 })
  h.rate.mockReset().mockResolvedValue(5)
  h.dialer.mockReset().mockResolvedValue({})
  h.blocked.mockReset().mockResolvedValue(false)
  h.visibility.mockReset().mockResolvedValue({})
})

describe("resolve: recipient and network", () => {
  it("own number: recipient is the sender, not a gift, network from the sender", async () => {
    const o = await offerOf(read())
    expect(o).toMatchObject({ service: "airtime", network: "Telecel", recipientLocal: S, gift: false, size: "airtime 10", previewGhs: 10 })
  })

  it("gift: network from the recipient, not the sender", async () => {
    const o = await offerOf(read({ recipient: "0241234567" }))
    expect(o).toMatchObject({ network: "MTN", recipientLocal: "0241234567", gift: true })
  })

  it("the recipient is normalised to the local form", async () => {
    const o = await offerOf(read({ recipient: "+233241234567" }))
    expect(o.recipientLocal).toBe("0241234567")
  })

  it("an invalid typed number is asked about, never priced", async () => {
    const res = await resolve(read({ recipient: "12345" }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "asked", reply: "That phone number is not valid. Text e.g. airtime 10 0241234567." } })
  })

  it("the admin prefix map wins over the static table", async () => {
    // 026 is AT in the static table; the admin map says MTN.
    h.map = { MTN: ["26"], TELECEL: [], AT: [] }
    const o = await offerOf(read({ recipient: "0261234567" }))
    expect(o.network).toBe("MTN")
  })

  it("a prefix only the static table knows still resolves", async () => {
    h.map = { MTN: [], TELECEL: [], AT: [] }
    const o = await offerOf(read({ recipient: "0261234567" }))
    expect(o.network).toBe("AT")
  })

  it("both unknown with no hint: the network question with three choices, and picking 2 resolves Telecel", async () => {
    h.map = { MTN: [], TELECEL: [], AT: [] }
    const res = await resolve(read({ recipient: "0301234567", amountGhs: 12 }))
    expect(res.ok).toBe(false)
    if (res.ok) return
    const r = res.refusal
    expect(r).toMatchObject({ outcome: "asked", reply: "Which network is that number on? 1) MTN 2) Telecel 3) AT", remember: true })
    expect(r.pending?.type).toBe("choices")
    if (r.pending?.type !== "choices") return
    expect(r.pending.options).toHaveLength(3)
    const picked = r.pending.options[1].read
    expect(picked).toMatchObject({ service: "airtime", amountGhs: 12, recipient: "0301234567", networkHint: "Telecel" })
    const again = await offerOf(picked as OrderRead)
    expect(again).toMatchObject({ network: "Telecel", recipientLocal: "0301234567", previewGhs: 12 })
  })

  it("a hint is used when the number is undetectable", async () => {
    h.map = { MTN: [], TELECEL: [], AT: [] }
    const o = await offerOf(read({ recipient: "0301234567", networkHint: "AT" }))
    expect(o.network).toBe("AT")
    expect(o.paystackProvider).toBe("vod") // the SENDER's network (020 Telecel) pays, not the recipient's
  })

  it("a hint that disagrees with the detected network, no typed number: asks which number of that network", async () => {
    const res = await resolve(read({ networkHint: "MTN" })) // the sender is Telecel
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "asked", reply: "Which MTN number should receive it?", remember: true } })
  })

  it("a hint that disagrees with a typed number: wrong number", async () => {
    const res = await resolve(read({ networkHint: "AT", recipient: "0241234567" }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "asked", reply: "That phone number is not valid. Text e.g. airtime 10 0241234567." } })
  })

  it("an MTN number the verification gate blocks is refused like a wrong number", async () => {
    h.blocked.mockResolvedValue(true)
    const res = await resolve(read({ recipient: "0241234567" }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "asked", reply: "That phone number is not valid. Text e.g. airtime 10 0241234567." } })
    expect(h.blocked).toHaveBeenCalledWith("MTN", "0241234567")
  })

  it("the verification gate is not consulted for other networks", async () => {
    await offerOf(read())
    expect(h.blocked).not.toHaveBeenCalled()
  })

  it("a gift keeps its number in the re-text token so a retry buys for the same person", async () => {
    const o = await offerOf(read({ recipient: R, amountGhs: 10.5 }))
    expect(o.size).toBe("airtime 10.50 " + R)
  })
})

describe("resolve: switches, limits and the preview", () => {
  it("the per-network switch off: the not-available reply", async () => {
    h.enabled.mockResolvedValue(false)
    const res = await resolve(read({ recipient: "0241234567" }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: "MTN airtime is not available now.", remember: false } })
    expect(h.enabled).toHaveBeenCalledWith("MTN")
  })

  it("below the minimum and above the maximum: the limits reply", async () => {
    for (const amountGhs of [0.5, 501]) {
      const res = await resolve(read({ amountGhs }))
      expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: "Airtime is GHS 1 to 500. Text e.g. airtime 10." } })
    }
    expect((await resolve(read({ amountGhs: 1 }))).ok).toBe(true)
    expect((await resolve(read({ amountGhs: 500 }))).ok).toBe(true)
  })

  it("an amount that is not a usable number never gets a price", async () => {
    for (const amountGhs of [Number.NaN, Infinity, -5, 0, 10.123]) {
      const res = await resolve(read({ amountGhs }))
      expect(res.ok).toBe(false)
    }
  })

  it("customer rate 5: pay 10, they get 9.52", async () => {
    const o = await offerOf(read())
    expect(o).toMatchObject({ previewGhs: 10, previewDeliversGhs: 9.52 })
    expect(h.rate).toHaveBeenCalledWith("Telecel", false)
  })

  it("a dealer sender gets the dealer rate", async () => {
    h.dialer.mockResolvedValue({ role: "dealer", rateTier: "dealer" })
    h.rate.mockImplementation(async (_n, dealer) => (dealer ? 2 : 5))
    const o = await offerOf(read())
    expect(h.rate).toHaveBeenCalledWith("Telecel", true)
    expect(o.previewDeliversGhs).toBe(9.8)
    // the dialer is the sender in international form
    expect(h.dialer).toHaveBeenCalledWith("+233200000101")
  })

  it("the live service-visibility switch is never read here (the confirm handler owns it)", async () => {
    await offerOf(read())
    expect(h.visibility).not.toHaveBeenCalled()
  })

  it("the Paystack provider is the sender's network, else the order network's", async () => {
    expect((await offerOf(read({ recipient: "0271234567" }))).paystackProvider).toBe("vod")
    const o = await offerOf(read({ recipient: "0241234567" }), "0301234567")
    expect(o.paystackProvider).toBe("mtn") // sender undetectable: falls back to the order network
  })

  it("any thrown read becomes the fixed unavailable reply", async () => {
    h.limits.mockRejectedValue(new Error("db down 0200000101"))
    const res = await resolve(read())
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: "Airtime is not available now.", remember: false } })
  })

  it("a non-airtime read fails closed", async () => {
    const res = await resolve({ kind: "order", service: "data", sizeMb: 1000, networkHint: null, recipient: null, bare: false })
    expect(res.ok).toBe(false)
  })

  it("lastOrder carries the typed amount, the resolved network and the recipient", async () => {
    const o = await offerOf(read({ recipient: R }))
    expect(o.lastOrder).toEqual({ service: "airtime", amountGhs: 10, network: "Telecel", recipient: R })
  })
})

describe("airtimeSession and place", () => {
  it("the staged session carries only what the confirm step needs", async () => {
    const o = await offerOf(read({ recipient: "0241234567" }))
    expect(airtimeSession(S, o)).toEqual({
      step: "AIRTIME_CONFIRM",
      dialingPhone: "+233200000101",
      airtimeNetwork: "MTN",
      airtimeRecipient: "0241234567",
      airtimeAmount: 10,
    })
    const s = airtimeSession(S, o) as unknown as Record<string, unknown>
    for (const k of ["airtimeCashbackPay", "userId", "walletBalance", "airtimeToDeliver", "airtimeFee"]) expect(s).not.toHaveProperty(k)
  })

  it("place passes the opaque session id sms:<id> and returns the placed amounts", async () => {
    const confirm = vi.fn(async (_sid: string, _session: unknown) => ({ type: "end" as const, message: "USSD wording", orderId: "O1", amount: 10.4, delivers: 9.52 }))
    const a = airtimeAdapter({ confirm: confirm as never })
    const o = await offerOf(read())
    const placed = await a.place(o, "m1", S)
    expect(confirm).toHaveBeenCalledTimes(1)
    const [sid, session] = confirm.mock.calls[0] as unknown as [string, { dialingPhone: string }]
    expect(sid).toBe("sms:m1")
    expect(sid).not.toContain(S)
    expect(session.dialingPhone).toBe("+233200000101")
    expect(placed).toEqual({ orderId: "O1", amountGhs: 10.4, deliversGhs: 9.52 })
  })

  it("a confirm with no order id places nothing", async () => {
    const confirm = vi.fn(async (_sid: string, _session: unknown) => ({ type: "end" as const, message: "no" }))
    const placed = await airtimeAdapter({ confirm: confirm as never }).place(await offerOf(read()), "m1", S)
    expect(placed.orderId).toBeUndefined()
  })
})

describe("replies and statuses", () => {
  const one = (s: string) => {
    const r = calculateSegments(s)
    expect([r.encoding, r.segments]).toEqual(["gsm7", 1])
  }

  it("the quote uses the placed amounts, never the preview", async () => {
    const a = airtimeAdapter()
    const o = await offerOf(read())
    const t = a.quote(o, { amountGhs: 10.4, deliversGhs: 9.7 }, { feeOnTop: false, payerNetwork: "TELECEL" })
    expect(t).toBe("Telecel airtime for 0200000101: you pay GHS 10.40, they get GHS 9.70. Approve the MoMo prompt now. No prompt? Dial *110#, 4, 2.")
    one(t)
    expect(t).not.toContain("9.52")
  })

  it("the quote of a preview-priced order is the preview", async () => {
    const a = airtimeAdapter()
    const o = await offerOf(read())
    expect(a.quote(o, { amountGhs: o.previewGhs, deliversGhs: o.previewDeliversGhs }, { feeOnTop: true, payerNetwork: "UNKNOWN" })).toContain("you pay GHS 10.00 + MoMo charge, they get GHS 9.52.")
  })

  it("a written amount above the preview already holds the gateway charge: no '+ MoMo charge' on top", async () => {
    const a = airtimeAdapter()
    const o = await offerOf(read())
    expect(a.quote(o, { amountGhs: 10.4, deliversGhs: 9.52 }, { feeOnTop: true, payerNetwork: "UNKNOWN" })).not.toContain("MoMo charge")
  })

  it("a quote without a usable delivered amount states no money", async () => {
    const a = airtimeAdapter()
    const o = await offerOf(read())
    expect(a.quote(o, { amountGhs: 10 }, { feeOnTop: false, payerNetwork: "MTN" })).toBe("Your order was placed. Approve the MoMo prompt if you get one.")
  })

  it("notPlacedReply is the network's not-available reply", async () => {
    expect(airtimeAdapter().notPlacedReply(await offerOf(read({ recipient: "0241234567" })))).toBe("MTN airtime is not available now.")
  })

  it("the text switch is the airtime setting only", () => {
    const a = airtimeAdapter()
    expect(a.textEnabled({ ...TTB_DEFAULTS, airtimeEnabled: true })).toBe(true)
    expect(a.textEnabled({ ...TTB_DEFAULTS, airtimeEnabled: false, resultsCheckerEnabled: true })).toBe(false)
  })

  it("notices: unpaid, delayed, and a delivered notice only for a gift", () => {
    const n = airtimeAdapter().notices
    expect(n.unpaid("airtime 10")).toBe("Payment didn't go through. Reply YES to try again, or text airtime 10. If you already approved, ignore this.")
    expect(n.paidNotDelivered()).toBe("We received your payment. Delivery is delayed; we are on it and will update you.")
    expect(n.paidNotDelivered()).not.toContain("No need to pay again")
    expect(n.delivered({ size: "airtime 10", recipient: R, gift: true })).toBe(`Airtime sent to ${R}. Text airtime 10 to buy again.`)
    expect(n.delivered({ size: "airtime 10", recipient: S, gift: false })).toBeNull()
  })

  it("statusOf maps the airtime order columns, and a refunded order is never 'awaiting payment'", () => {
    const a = airtimeAdapter()
    const row = (paymentStatus: string, orderStatus: string) => ({ paymentStatus, orderStatus, amount: 10 })
    const open = { state: "awaiting_payment" }
    expect(a.statusOf(open, row("pending_payment", "pending_payment"))).toBe("awaiting_payment")
    expect(a.statusOf({ state: "closed" }, row("pending_payment", "pending_payment"))).toBe("failed")
    expect(a.statusOf(open, row("failed", "failed"))).toBe("failed")
    expect(a.statusOf(open, row("completed", "processing"))).toBe("processing")
    expect(a.statusOf(open, row("completed", "failed"))).toBe("processing")
    expect(a.statusOf(open, row("completed", "completed"))).toBe("delivered")
    expect(a.statusOf(open, row("refunded", "failed"))).toBe("failed")
    expect(a.statusOf(open, row("completed", "refunding"))).toBe("failed")
    expect(a.statusOf(open, row("abandoned", "pending_payment"))).toBe("failed")
  })

  it("statusOf with no order row reports from the link alone", () => {
    const a = airtimeAdapter()
    expect(a.statusOf({ state: "awaiting_payment" }, null)).toBe("awaiting_payment")
    expect(a.statusOf({ state: "paid" }, null)).toBe("processing")
    expect(a.statusOf({ state: "closed" }, null)).toBe("failed")
  })

  it("the adapter reads airtime_orders and classifies with the status-column vocabulary", () => {
    const a = airtimeAdapter()
    expect(a.orderTable).toBe("airtime_orders")
    expect(a.service).toBe("airtime")
    expect(a.classify({ paymentStatus: "refunded", orderStatus: "failed" })).toBe("refunded")
    expect(a.classify({ paymentStatus: "pending_payment", orderStatus: "pending_payment" })).toBe("waiting")
  })
})
