import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import type { Offer, OfferResult } from "./catalogue"
import type { ReadResult } from "./types"
import {
  quoteReply, lateReply, limitedReply, openOrderReply, notUnderstoodReply, helpReply, unavailableReply, priceListReply,
  priceAnswerReply, statusReply, wrongNumberReply,
} from "./replies"

const h = vi.hoisted(() => ({
  map: { MTN: ["20"], TELECEL: [] as string[], AT: [] as string[] },
  surface: vi.fn(),
  payer: vi.fn(),
  notify: vi.fn(),
}))

vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/payment-gateway/start", () => ({ resolveSurfaceGateway: h.surface }))
vi.mock("@/lib/ussd/gateway-charge", () => ({ isUssdHubtelPayer: h.payer }))
vi.mock("@/lib/ussd/handlers/bundles", () => ({ handleConfirm: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyAdmins: h.notify }))
vi.mock("./catalogue", () => {
  const parse = (s: string) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)?\s*$/i.exec(s)
    return m ? { n: Number(m[1]), unit: m[2]?.toLowerCase() === "mb" ? "MB" : "GB" } : null
  }
  return {
    resolveOffer: vi.fn(),
    listPrices: vi.fn(),
    parseSizeMb: (s: string) => {
      const p = parse(s)
      return p ? Math.round(p.unit === "GB" ? p.n * 1000 : p.n) : null
    },
    sizeLabel: (s: string) => {
      const p = parse(s)
      return p ? `${p.n}${p.unit}` : s
    },
    sessionForOffer: (sender: string, o: Offer) => ({
      dialingPhone: "+233" + sender.slice(1), network: o.network, bundleId: o.bundleId, bundleSize: o.size, bundlePrice: o.price, recipientPhone: o.recipientLocal,
    }),
  }
})

import { acceptInbound, processInbound, resetReplyCapAlert, type InboundDeps, type InboundInput } from "./handle-inbound"

const S = "0200000101"
const R = "0200000150"
const ORDER = "6f0c1a9e-0163-4163-8163-0000000000c1"
const now = new Date("2026-11-13T12:00:00Z")
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000)
const tier = { effectivePriceTier: "customer", subAgentParentShopId: null, userId: null, mtnWhitelistActive: false } as unknown as Offer["tier"]
const offer = (over: Partial<Offer> = {}): Offer => ({
  network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: S, gift: false, tier, paystackProvider: "mtn", ...over,
})
const ok = (over: Partial<Offer> = {}): OfferResult => ({ ok: true, offer: offer(over) })
const settings = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, mainEnabled: true, ...over })
const order5: ReadResult = { kind: "order", service: "data", sizeMb: 5000, networkHint: null, recipient: null, bare: false }

type Counts = { prompts_unpaid: number; replies: number; ai_reads: number; not_understood: number }

function setup(opts: { seed?: Record<string, Record<string, unknown>[]>; counts?: Partial<Counts>; global?: (since: string) => number } = {}) {
  const f = makeFakeTtb(opts.seed ?? {})
  const state = { counts: { prompts_unpaid: 0, replies: 0, ai_reads: 0, not_understood: 0, ...opts.counts } as Counts, global: opts.global ?? (() => 0) }
  f.db.rpcImpl = (name, args) =>
    name === "ttb_counts" ? { data: [state.counts], error: null } : { data: state.global(String(args.p_since)), error: null }
  const c = f.client as unknown as SupabaseClient
  const confirm = vi.fn(async () => ({ type: "end", message: "USSD wording", orderId: ORDER, amount: 23.69 }))
  const deps = {
    readAi: vi.fn(async (_text: string, _history: { role: string; text: string }[]) => ({ kind: "not_order" }) as ReadResult),
    resolve: vi.fn(async () => ok()),
    prices: vi.fn(async () => ({ networkLabel: "MTN", items: [{ size: "1GB", priceGhs: 5 }, { size: "5GB", priceGhs: 23 }, { size: "10GB", priceGhs: 45 }] })),
    confirm,
    reply: vi.fn(async () => ({ sent: true })),
    alert: vi.fn(async () => {}),
    feeOnTop: vi.fn(async () => false),
  }
  async function run(text: string, over: { input?: Partial<InboundInput>; settings?: Partial<TtbSettings>; deps?: Partial<InboundDeps> } = {}) {
    const input: InboundInput = { line: "main", from: S, text, receivedAt: null, now, ...over.input }
    const { id } = await acceptInbound(c, input)
    const result = await processInbound(c, id, input, settings(over.settings), { ...deps, ...over.deps } as InboundDeps)
    return { result, id }
  }
  const message = (id: string) => f.db.tables.ttb_messages.find((m) => m.id === id)!
  return { f, c, state, deps, confirm, run, message }
}

beforeEach(() => {
  h.map = { MTN: ["20"], TELECEL: [], AT: [] }
  h.surface.mockReset()
  h.payer.mockReset()
  h.notify.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("placing an order from rules", () => {
  it("5gb: one confirm on the sms channel, quote from the response amount, link row, outcome prompted, AI untouched", async () => {
    const t = setup()
    const { result, id } = await t.run("5gb")
    expect(t.confirm).toHaveBeenCalledTimes(1)
    const [input, sessionId, session, channel, opts] = t.confirm.mock.calls[0] as unknown as [string, string, { recipientPhone: string }, string, object]
    expect([input, sessionId, channel, opts]).toEqual(["1", `sms:${id}`, "sms", { momoOnly: true }])
    expect(sessionId).not.toContain(S) // opaque: session.ts logs this id when Redis fails
    expect(sessionId).not.toContain("5gb")
    expect(session.recipientPhone).toBe(S)
    const expected = quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 23.69, feeOnTop: false, payerNetwork: "MTN" })
    expect(result).toMatchObject({ outcome: "prompted", readBy: "rules", reply: expected, orderId: ORDER })
    expect(t.deps.readAi).not.toHaveBeenCalled()
    const link = t.f.db.tables.ttb_orders[0]
    expect(link).toMatchObject({ line: "main", sender: S, order_id: ORDER, size: "5", recipient: S, gift: false, amount: 23.69, state: "awaiting_payment" })
    expect(t.deps.reply).toHaveBeenCalledWith(t.c, expect.objectContaining({ line: "main", sender: S, body: expected, orderLinkId: link.id }))
    expect(t.message(id)).toMatchObject({ outcome: "prompted", read_by: "rules", order_link_id: link.id })
    const conv = t.f.db.tables.ttb_conversations[0]
    expect(conv).toMatchObject({ line: "main", sender: S, pending: null, last_order: { sizeMb: 5000, network: "MTN", recipient: S } })
  })

  it("never relays the confirm handler's message to the customer", async () => {
    const t = setup()
    const { result } = await t.run("5gb")
    expect(result.reply).not.toContain("USSD wording")
  })

  it("quotes the amount the order row was written with, not the offer price, when they differ", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue(ok({ price: 23.0 }))
    t.confirm.mockResolvedValue({ type: "end", message: "", orderId: ORDER, amount: 23.69 })
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("GHS 23.69")
    expect(result.reply).not.toContain("GHS 23.00")
    expect(t.f.db.tables.ttb_orders[0].amount).toBe(23.69)
  })

  it("feeOnTop true puts '+ MoMo charge' in the quote", async () => {
    const t = setup()
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("+ MoMo charge")
  })

  it("default feeOnTop: Hubtel gateway with the customer paying the fee is true, Paystack is false", async () => {
    const t = setup()
    h.payer.mockReturnValue(true)
    h.surface.mockResolvedValue({ gateway: "hubtel", feeBearer: "customer" })
    const r1 = await t.run("5gb", { deps: { feeOnTop: undefined } })
    expect(r1.result.reply).toContain("+ MoMo charge")
    expect(h.surface).toHaveBeenCalledWith("sms_order", { verifiedPayer: true, amount: 23.69 })
    expect(h.payer).toHaveBeenCalledWith(expect.objectContaining({ chargePhone: "+233" + S.slice(1), ownerPhone: "+233" + S.slice(1), provider: "mtn" }))

    const t2 = setup()
    h.surface.mockResolvedValue({ gateway: "paystack", feeBearer: "customer" })
    const r2 = await t2.run("5gb", { deps: { feeOnTop: undefined } })
    expect(r2.result.reply).not.toContain("+ MoMo charge")
    h.surface.mockResolvedValue({ gateway: "hubtel", feeBearer: "merchant" })
    const t3 = setup()
    const r3 = await t3.run("5gb", { deps: { feeOnTop: undefined } })
    expect(r3.result.reply).not.toContain("+ MoMo charge")
  })

  it("default feeOnTop says '+ MoMo charge' when the gateway lookup throws (the honest direction)", async () => {
    const t = setup()
    h.surface.mockRejectedValue(new Error("down"))
    const { result } = await t.run("5gb", { deps: { feeOnTop: undefined } })
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toContain("+ MoMo charge")
  })

  it("payer tip follows the sender's carrier from the admin prefix map", async () => {
    h.map = { MTN: [], TELECEL: ["20"], AT: [] }
    const t = setup()
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("*110#, 4, 2")
  })
})

describe("reading with the AI", () => {
  it("'pls send me 5gig' goes to the AI once with the user's history, then places the order", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue(order5)
    const { result } = await t.run("pls send me 5gig")
    expect(t.deps.readAi).toHaveBeenCalledTimes(1)
    expect(t.deps.readAi).toHaveBeenCalledWith("pls send me 5gig", [])
    expect(t.confirm).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ outcome: "prompted", readBy: "ai" })
  })

  it("AI off: junk is not_order with the how-to reply; a second junk in the hour gets no reply", async () => {
    const t = setup()
    const first = await t.run("hello there", { settings: { aiEnabled: false } })
    expect(t.deps.readAi).not.toHaveBeenCalled()
    expect(first.result).toMatchObject({ outcome: "not_order", reply: notUnderstoodReply() })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)

    t.state.counts.not_understood = 1
    const second = await t.run("hello again", { settings: { aiEnabled: false } })
    expect(second.result).toMatchObject({ outcome: "not_order", reply: null })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })

  it("the AI read budget is spent: not_order without calling the AI", async () => {
    const t = setup({ counts: { ai_reads: 10 } })
    const { result } = await t.run("pls send me 5gig")
    expect(t.deps.readAi).not.toHaveBeenCalled()
    expect(result.outcome).toBe("not_order")
  })

  it("an AI that returns not_order (as after its own timeout) gets the how-to reply and no order", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "not_order" })
    const { result } = await t.run("pls send me 5gig")
    expect(result).toMatchObject({ outcome: "not_order", readBy: "ai", reply: notUnderstoodReply() })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("an AI call that never answers is cut off after 10 seconds and read as not_order", async () => {
    vi.useFakeTimers()
    const t = setup()
    t.deps.readAi.mockReturnValue(new Promise<ReadResult>(() => {}))
    const p = t.run("pls send me 5gig")
    await vi.advanceTimersByTimeAsync(10_000)
    const { result } = await p
    expect(result).toMatchObject({ outcome: "not_order", readBy: "ai", reply: notUnderstoodReply() })
    expect(t.confirm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("the history passed starts with a user turn and holds at most 6 turns", async () => {
    const turns = [
      { role: "assistant" as const, text: "a0" }, { role: "user" as const, text: "u1" }, { role: "assistant" as const, text: "a1" },
      { role: "user" as const, text: "u2" }, { role: "assistant" as const, text: "a2" }, { role: "user" as const, text: "u3" },
      { role: "assistant" as const, text: "a3" }, { role: "user" as const, text: "u4" }, { role: "assistant" as const, text: "a4" },
    ]
    const t = setup({ seed: { ttb_conversations: [{ line: "main", sender: S, turns, pending: null, last_order: null, expires_at: minutesAgo(-10).toISOString() }] } })
    await t.run("pls send me 5gig")
    const history = t.deps.readAi.mock.calls[0][1] as { role: string; text: string }[]
    expect(history).toHaveLength(6)
    expect(history[0].role).toBe("user")
    expect(history.map((x) => x.text)).toEqual(["u2", "a2", "u3", "a3", "u4", "a4"])
  })

  it("a bare YES never goes to the AI", async () => {
    const t = setup()
    await t.run("yes")
    expect(t.deps.readAi).not.toHaveBeenCalled()
  })

  it("ask: replies the question, saves both turns, outcome asked", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "ask", question: "Which size do you want? e.g. 5GB" })
    const { result } = await t.run("pls send data")
    expect(result).toMatchObject({ outcome: "asked", reply: "Which size do you want? e.g. 5GB" })
    expect(t.f.db.tables.ttb_conversations[0].turns).toEqual([
      { role: "user", text: "pls send data" }, { role: "assistant", text: "Which size do you want? e.g. 5GB" },
    ])
  })
})

describe("stale, blocked and limits", () => {
  it("late by 11 minutes with staleMinutes 10: late reply, no order; 9 minutes proceeds; null proceeds", async () => {
    const t = setup()
    const late = await t.run("5gb", { input: { receivedAt: minutesAgo(11) } })
    expect(late.result).toMatchObject({ outcome: "late", reply: lateReply() })
    expect(t.confirm).not.toHaveBeenCalled()
    const t2 = setup()
    expect((await t2.run("5gb", { input: { receivedAt: minutesAgo(9) } })).result.outcome).toBe("prompted")
    const t3 = setup()
    expect((await t3.run("5gb", { input: { receivedAt: null } })).result.outcome).toBe("prompted")
  })

  it("uses the injected now: a receive time 11 minutes before now is late whatever the wall clock says", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"))
    const t = setup()
    const { result } = await t.run("5gb", { input: { receivedAt: minutesAgo(9) } })
    expect(result.outcome).toBe("prompted")
  })

  it("a receive time more than 2 minutes in the future is ignored (treated as absent)", async () => {
    const t = setup()
    const future = new Date(now.getTime() + 3 * 60_000)
    expect((await t.run("5gb", { input: { receivedAt: future } })).result.outcome).toBe("prompted")
  })

  it("blocked sender: no reply, nothing else called", async () => {
    const t = setup({ seed: { ttb_blocked: [{ sender: S }] } })
    const { result, id } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "blocked", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.deps.resolve).not.toHaveBeenCalled()
    expect(t.message(id).outcome).toBe("blocked")
  })

  it("replies >= repliesPerHour: limited, and no reply at all", async () => {
    const t = setup({ counts: { replies: 6 } })
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "limited", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
  })

  it("promptsUnpaid at the cap: limited reply, no confirm", async () => {
    const t = setup({ counts: { prompts_unpaid: 3 } })
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "limited", reply: limitedReply() })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("an open order inside the window: open-order reply, no confirm", async () => {
    const t = setup({ seed: { ttb_orders: [{ id: "L", line: "main", sender: S, order_id: "x", state: "awaiting_payment", created_at: minutesAgo(1).toISOString() }] } })
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "open_order", reply: openOrderReply() })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("an old awaiting_payment link is closed first, so it does not block a new order", async () => {
    const t = setup({ seed: { ttb_orders: [{ id: "L", line: "main", sender: S, order_id: "x", state: "awaiting_payment", created_at: minutesAgo(30).toISOString() }] } })
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    const old = t.f.db.tables.ttb_orders.find((r) => r.id === "L")!
    expect(old).toMatchObject({ state: "closed", closed_at: now.toISOString() })
  })

  it("global cap reached: limited reply and one alert; the alert is throttled while the previous minute was also at the cap", async () => {
    const cap = TTB_DEFAULTS.globalPromptsPerMinute
    const t = setup({ global: (since) => (since === minutesAgo(1).toISOString() ? cap : since === minutesAgo(2).toISOString() ? cap : 0) })
    const quiet = await t.run("5gb")
    expect(quiet.result).toMatchObject({ outcome: "limited", reply: limitedReply() })
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(t.deps.alert).toHaveBeenCalledWith("Text-to-Buy: global prompt cap reached")

    // previous minute had cap prompts too (count since 2 min ago = 2 * cap): already alerted, so no second alert
    const t2 = setup({ global: (since) => (since === minutesAgo(1).toISOString() ? cap : since === minutesAgo(2).toISOString() ? 2 * cap : 0) })
    await t2.run("5gb")
    expect(t2.deps.alert).not.toHaveBeenCalled()
  })
})

describe("race and link results", () => {
  const pendingSeed = () => ({ ussd_orders: [{ id: ORDER, order_status: "pending", payment_status: "pending" }] })

  const raceConfirm = (t: ReturnType<typeof setup>) =>
    t.confirm.mockImplementation(async () => {
      t.f.db.tables.ttb_orders.push({ id: "winner", line: "main", sender: S, order_id: "other-order", state: "awaiting_payment", created_at: now.toISOString() })
      return { type: "end", message: "", orderId: ORDER, amount: 23.69 }
    })

  it("a true race for the open-order slot: the loser's order row is left PENDING (its charge already started), reply is the open-order reply", async () => {
    const t = setup({ seed: pendingSeed() })
    raceConfirm(t)
    const { result, id } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "open_order", reply: openOrderReply() })
    expect(t.f.db.tables.ussd_orders[0]).toEqual({ id: ORDER, order_status: "pending", payment_status: "pending" })
    expect(t.f.db.tables.ttb_orders).toHaveLength(1)
    expect(t.message(id).outcome).toBe("open_order")
  })

  it("the race alerts admins with the order id only: no phone, no text, no amount", async () => {
    const t = setup({ seed: pendingSeed() })
    raceConfirm(t)
    await t.run("5gb")
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    const msg = String((t.deps.alert.mock.calls[0] as unknown[])[0])
    expect(msg).toContain(ORDER)
    expect(msg).not.toContain(S)
    expect(msg).not.toContain("5gb")
    expect(msg).not.toContain("23.69")
  })

  it("an alert that throws never throws out of processInbound: the open-order reply still goes out", async () => {
    const t = setup({ seed: pendingSeed() })
    raceConfirm(t)
    t.deps.alert.mockRejectedValue(new Error("notifier down"))
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "open_order", reply: openOrderReply() })
  })

  it("an order id that is already linked carries on as prompted and does not fail the order", async () => {
    const t = setup({ seed: { ...pendingSeed(), ttb_orders: [{ id: "L", line: "main", sender: "0200000199", order_id: ORDER, state: "awaiting_payment", created_at: now.toISOString() }] } })
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    expect(t.f.db.tables.ussd_orders[0]).toMatchObject({ order_status: "pending", payment_status: "pending" })
  })

  it("a conflict for an order that already has a link is treated as already linked, not failed", async () => {
    const t = setup({ seed: { ...pendingSeed(), ttb_orders: [{ id: "L", line: "main", sender: "0200000199", order_id: ORDER, state: "closed", created_at: now.toISOString() }] } })
    t.f.db.failInsert.ttb_orders = { code: "23505", message: 'duplicate key value violates unique constraint "ttb_orders_one_open"' }
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    expect(t.f.db.tables.ussd_orders[0]).toMatchObject({ order_status: "pending", payment_status: "pending" })
  })

  it("confirm returns no orderId: unavailable reply, no link", async () => {
    const t = setup()
    t.confirm.mockResolvedValue({ type: "end", message: "Error creating order." } as never)
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "unavailable", reply: unavailableReply("MTN", []) })
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })
})

describe("keywords and follow-ups", () => {
  it("PRICES lists the sender's prices and sets numbered choices; the next text '2' places the second listed size", async () => {
    const t = setup()
    const first = await t.run("prices")
    expect(first.result).toMatchObject({ outcome: "keyword", reply: priceListReply("MTN", [{ size: "1GB", priceGhs: 5 }, { size: "5GB", priceGhs: 23 }, { size: "10GB", priceGhs: 45 }]) })
    const pending = t.f.db.tables.ttb_conversations[0].pending as { type: string; options: { read: ReadResult }[] }
    expect(pending.type).toBe("choices")
    expect(pending.options).toHaveLength(3)

    t.deps.readAi.mockClear()
    const second = await t.run("2", { input: { now: new Date(now.getTime() + 60_000) } })
    expect(second.result.outcome).toBe("prompted")
    expect(t.deps.resolve).toHaveBeenCalledWith(t.c, { senderLocal: S, sizeMb: 5000, networkHint: null, recipient: null })
    expect(t.deps.readAi).not.toHaveBeenCalled()
  })

  it("a digit outside the listed options is an ordinary size, not a pick", async () => {
    const t = setup()
    await t.run("prices")
    await t.run("7", { input: { now: new Date(now.getTime() + 60_000) } })
    expect(t.deps.resolve).toHaveBeenCalledWith(t.c, expect.objectContaining({ sizeMb: 7000 }))
  })

  it("PRICES with no price list for this number: help text, outcome keyword", async () => {
    const t = setup()
    t.deps.prices.mockResolvedValue(null as never)
    const { result } = await t.run("prices")
    expect(result).toMatchObject({ outcome: "keyword", reply: helpReply() })
  })

  it("'how much is 10gb' then 'yes': price answer, then an order priced by a fresh resolve", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "price_query", service: "data", sizeMb: 10000, networkHint: null })
    t.deps.resolve.mockResolvedValueOnce(ok({ size: "10", price: 45 }))
    const first = await t.run("how much is 10gb")
    expect(first.result).toMatchObject({ outcome: "price_answer", reply: priceAnswerReply("10GB", "MTN", 45) })
    expect(t.confirm).not.toHaveBeenCalled()

    t.deps.resolve.mockResolvedValueOnce(ok({ size: "10", price: 46 }))
    const second = await t.run("yes", { input: { now: new Date(now.getTime() + 60_000) } })
    expect(t.deps.resolve).toHaveBeenCalledTimes(2)
    expect(second.result.outcome).toBe("prompted")
    expect((t.confirm.mock.calls[0] as unknown as [string, string, { bundlePrice: number }])[2].bundlePrice).toBe(46)
  })

  it("a price query with no size answers with the price list and numbered choices", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "price_query", service: "data", sizeMb: null, networkHint: null })
    const { result } = await t.run("what are your prices please")
    expect(result.outcome).toBe("price_answer")
    expect(t.deps.resolve).not.toHaveBeenCalled()
    expect((t.f.db.tables.ttb_conversations[0].pending as { type: string }).type).toBe("choices")
  })

  it("YES with nothing pending and no unpaid order: how-to reply, no order, no AI", async () => {
    const t = setup()
    const { result } = await t.run("yes")
    expect(result).toMatchObject({ outcome: "not_order", reply: notUnderstoodReply() })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("YES after an unpaid notice rebuilds the last order through resolve again", async () => {
    const t = setup({
      seed: {
        ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "MTN", recipient: R }, expires_at: minutesAgo(-10).toISOString() }],
        ttb_orders: [{ id: "L", line: "main", sender: S, order_id: "x", state: "closed", notices: ["unpaid"], size: "5", recipient: R, created_at: minutesAgo(8).toISOString() }],
      },
    })
    const { result } = await t.run("yes")
    expect(t.deps.resolve).toHaveBeenCalledWith(t.c, { senderLocal: S, sizeMb: 5000, networkHint: "MTN", recipient: R })
    expect(result.outcome).toBe("prompted")
  })

  it("YES does not rebuild an order whose unpaid notice is older than the conversation window", async () => {
    const t = setup({
      seed: {
        ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "MTN", recipient: R }, expires_at: minutesAgo(30).toISOString() }],
        ttb_orders: [{ id: "L", line: "main", sender: S, order_id: "x", state: "closed", notices: ["unpaid"], size: "5", recipient: R, created_at: minutesAgo(40).toISOString() }],
      },
    })
    const { result } = await t.run("yes")
    expect(result.outcome).toBe("not_order")
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("again: same size, network and recipient go through resolve again", async () => {
    const t = setup({
      seed: { ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "AT-iShare", recipient: R }, expires_at: minutesAgo(30).toISOString() }] },
    })
    const { result } = await t.run("again")
    expect(t.deps.resolve).toHaveBeenCalledWith(t.c, { senderLocal: S, sizeMb: 5000, networkHint: "AT-iShare", recipient: R })
    expect(result.outcome).toBe("prompted")
  })

  it("again with no previous order: how-to reply", async () => {
    const t = setup()
    const { result } = await t.run("again")
    expect(result).toMatchObject({ outcome: "not_order", reply: notUnderstoodReply() })
  })

  it("help", async () => {
    const t = setup()
    const { result } = await t.run("help")
    expect(result).toMatchObject({ outcome: "keyword", reply: helpReply() })
  })

  it.each([
    ["pending / pending", { order_status: "pending", payment_status: "pending" }, "awaiting_payment"],
    ["processing / paid", { order_status: "processing", payment_status: "paid" }, "processing"],
    ["completed", { order_status: "completed", payment_status: "paid" }, "delivered"],
    ["failed", { order_status: "failed", payment_status: "failed" }, "failed"],
  ] as const)("status: %s", async (_name, row, expected) => {
    const t = setup({
      seed: {
        ttb_orders: [{ id: "L", line: "main", sender: S, order_id: ORDER, state: "awaiting_payment", size: "5", recipient: S, notices: [], created_at: minutesAgo(1).toISOString() }],
        ussd_orders: [{ id: ORDER, ...row }],
      },
    })
    const { result } = await t.run("status")
    expect(result).toMatchObject({ outcome: "keyword", reply: statusReply(expected, "5GB") })
  })

  it("status with no order: none", async () => {
    const t = setup()
    const { result } = await t.run("status")
    expect(result.reply).toBe(statusReply("none"))
  })
})

describe("offer failures", () => {
  it("AT sender with both products: a numbered question, then '1' places iShare", async () => {
    h.map = { MTN: [], TELECEL: [], AT: ["20"] }
    const t = setup()
    const two = [offer({ network: "AT-iShare", networkLabel: "AT", bundleId: "i5" }), offer({ network: "AT-BigTime", networkLabel: "AT", bundleId: "b5" })]
    t.deps.resolve.mockResolvedValueOnce({ ok: false, reason: "choose_product", options: two })
    const first = await t.run("5gb")
    expect(first.result).toMatchObject({ outcome: "asked", reply: "Which one? 1) AT iShare 5GB 2) AT BigTime 5GB" })
    expect(t.confirm).not.toHaveBeenCalled()

    t.deps.resolve.mockResolvedValueOnce(ok({ network: "AT-iShare", networkLabel: "AT", bundleId: "i5" }))
    const second = await t.run("1", { input: { now: new Date(now.getTime() + 60_000) } })
    expect(t.deps.resolve).toHaveBeenLastCalledWith(t.c, { senderLocal: S, sizeMb: 5000, networkHint: "AT-iShare", recipient: null })
    expect(second.result.outcome).toBe("prompted")
    expect((t.confirm.mock.calls[0] as unknown as [string, string, { bundleId: string }])[2].bundleId).toBe("i5")
  })

  it("need_recipient: asks for the number, saves the turns, no pending", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "need_recipient", networkLabel: "Telecel" })
    const { result } = await t.run("5gb telecel")
    expect(result).toMatchObject({ outcome: "asked", reply: "Which Telecel number should receive it?" })
    const conv = t.f.db.tables.ttb_conversations[0]
    expect(conv.pending).toBeNull()
    expect((conv.turns as unknown[]).length).toBe(2)
  })

  it("bad_recipient: wrong-number reply", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "bad_recipient" })
    const { result } = await t.run("5gb 0200000199")
    expect(result).toMatchObject({ outcome: "asked", reply: wrongNumberReply() })
  })

  it("no_package: unavailable with the nearest sizes", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "no_package", networkLabel: "MTN", nearest: [{ size: "5GB", priceGhs: 23 }, { size: "10GB", priceGhs: 45 }] })
    const { result } = await t.run("6gb")
    expect(result).toMatchObject({ outcome: "unavailable", reply: unavailableReply("MTN", [{ size: "5GB", priceGhs: 23 }, { size: "10GB", priceGhs: 45 }]) })
  })

  it("no_package for AT never lists one size twice at different prices", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({
      ok: false, reason: "no_package", networkLabel: "AT",
      nearest: [{ size: "5GB", priceGhs: 20 }, { size: "5GB", priceGhs: 22 }, { size: "4GB", priceGhs: 18 }],
    })
    const { result } = await t.run("6gb")
    expect(result.reply).toBe(unavailableReply("AT", [{ size: "5GB", priceGhs: 20 }, { size: "4GB", priceGhs: 18 }]))
    expect((result.reply ?? "").match(/5GB/g)).toHaveLength(1)
  })

  it.each(["service_off", "prices_unavailable"] as const)("%s: unavailable reply without a nearest list", async (reason) => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason })
    const { result } = await t.run("5gb")
    expect(result).toMatchObject({ outcome: "unavailable", reply: unavailableReply("this network", []) })
    expect(t.confirm).not.toHaveBeenCalled()
  })
})

describe("dry run", () => {
  it("places nothing, sends nothing, writes nothing, and returns the text that would be sent", async () => {
    const t = setup()
    const input: InboundInput = { line: "main", from: S, text: "5gb", receivedAt: null, now }
    const { id } = await acceptInbound(t.c, input)
    const before = JSON.stringify(t.f.db.tables)
    const result = await processInbound(t.c, id, input, settings(), { ...t.deps, dryRun: true } as unknown as InboundDeps)
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.deps.alert).not.toHaveBeenCalled()
    expect(JSON.stringify(t.f.db.tables)).toBe(before)
    expect(t.deps.resolve).toHaveBeenCalledTimes(1)
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toBe(quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 23.69, feeOnTop: false, payerNetwork: "MTN" }))
    expect(result.orderId).toBeUndefined()
  })

  it("a dry run that hits the global cap does not alert", async () => {
    const t = setup({ global: () => 999 })
    const input: InboundInput = { line: "main", from: S, text: "5gb", receivedAt: null, now }
    const { id } = await acceptInbound(t.c, input)
    const r = await processInbound(t.c, id, input, settings(), { ...t.deps, dryRun: true } as unknown as InboundDeps)
    expect(r.outcome).toBe("limited")
    expect(t.deps.alert).not.toHaveBeenCalled()
  })

  it("a dry run of a question leaves the conversation alone", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "need_recipient", networkLabel: "MTN" })
    const input: InboundInput = { line: "main", from: S, text: "5gb mtn", receivedAt: null, now }
    const { id } = await acceptInbound(t.c, input)
    const r = await processInbound(t.c, id, input, settings(), { ...t.deps, dryRun: true } as unknown as InboundDeps)
    expect(r.outcome).toBe("asked")
    expect(t.f.db.tables.ttb_conversations).toHaveLength(0)
    expect(t.f.db.tables.ttb_messages.find((m) => m.id === id)!.outcome).toBeUndefined()
  })
})

describe("silent on unclear texts (unclearRepliesEnabled)", () => {
  it("off: a text that is not an order gets no reply and the outcome stays not_order", async () => {
    const t = setup()
    const { result, id } = await t.run("hello there", { settings: { aiEnabled: false, unclearRepliesEnabled: false } })
    expect(result).toMatchObject({ outcome: "not_order", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.message(id)).toMatchObject({ outcome: "not_order" })
  })
  it("on: the how-to reply still goes out", async () => {
    const t = setup()
    const { result } = await t.run("hello there", { settings: { aiEnabled: false, unclearRepliesEnabled: true } })
    expect(result).toMatchObject({ outcome: "not_order", reply: notUnderstoodReply() })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })
  it("off: clarifying questions, keywords and price answers are untouched", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "need_recipient", networkLabel: "MTN" })
    const asked = await t.run("5gb mtn", { settings: { unclearRepliesEnabled: false } })
    expect(asked.result.outcome).toBe("asked")
    expect(asked.result.reply).not.toBeNull()
    const help = await t.run("help", { settings: { unclearRepliesEnabled: false } })
    expect(help.result).toMatchObject({ outcome: "keyword", reply: helpReply() })
  })
})

describe("overall reply cap (globalRepliesPerHour)", () => {
  const CAP = 10
  const outRows = (n: number, at = minutesAgo(5)) =>
    Array.from({ length: n }, (_, k) => ({ id: `o${k}`, line: "main", direction: "out", created_at: at.toISOString() }))
  const capped = (n: number) => setup({ seed: { ttb_messages: outRows(n) } })

  beforeEach(() => resetReplyCapAlert())

  it("under the cap: a help reply is sent", async () => {
    const t = capped(CAP - 1)
    const { result } = await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(result).toMatchObject({ outcome: "keyword", reply: helpReply() })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.deps.alert).not.toHaveBeenCalled()
  })

  it("at the cap: a non-order reply is suppressed, nothing is sent and the row is recorded as limited", async () => {
    const t = capped(CAP)
    const { result, id } = await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(result).toMatchObject({ outcome: "limited", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.message(id)).toMatchObject({ outcome: "limited" })
  })

  it("replies older than an hour or on the other line do not count", async () => {
    const t = setup({
      seed: {
        ttb_messages: [
          ...outRows(CAP, minutesAgo(61)),
          ...outRows(CAP).map((r, k) => ({ ...r, id: `s${k}`, line: "shop" })),
        ],
      },
    })
    const { result } = await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(result.reply).toBe(helpReply())
  })

  it("suppresses every non-quote reply: not understood, question, price list, limited and open order", async () => {
    const t = capped(CAP)
    const s = { globalRepliesPerHour: CAP, aiEnabled: false }
    expect((await t.run("hello there", { settings: s })).result).toMatchObject({ outcome: "limited", reply: null })
    t.deps.resolve.mockResolvedValue({ ok: false, reason: "need_recipient", networkLabel: "MTN" })
    expect((await t.run("5gb mtn", { settings: s })).result).toMatchObject({ outcome: "limited", reply: null })
    expect((await t.run("prices", { settings: s })).result).toMatchObject({ outcome: "limited", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
  })

  it("the order quote is never suppressed, even over the cap", async () => {
    const t = capped(CAP + 5)
    const { result } = await t.run("5gb", { settings: { globalRepliesPerHour: CAP } })
    expect(result).toMatchObject({ outcome: "prompted", orderId: ORDER })
    expect(result.reply).not.toBeNull()
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })

  it("alerts once when a reply is suppressed at the cap, with a message that carries no numbers or text", async () => {
    const t = capped(CAP)
    await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(t.deps.alert).toHaveBeenCalledWith("Text-to-Buy: hourly reply cap reached")
    await t.run("prices", { settings: { globalRepliesPerHour: CAP } })
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
  })

  it("alerts even when the first suppression already sees a count well above the cap", async () => {
    const t = capped(CAP + 3)
    await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
  })

  it("no alert storm: a dip below the cap and back does not alert again within the hour, but it does after an hour", async () => {
    const t = capped(CAP)
    const s = { globalRepliesPerHour: CAP }
    await t.run("help", { settings: s })
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    // one row ages out: a reply goes through, then the count is back at the cap
    t.f.db.tables.ttb_messages.splice(t.f.db.tables.ttb_messages.findIndex((m) => m.direction === "out"), 1)
    expect((await t.run("prices", { settings: s })).result.reply).not.toBeNull()
    t.f.db.tables.ttb_messages.push(...outRows(1).map((r) => ({ ...r, id: "again" })))
    await t.run("how do i buy", { settings: s })
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    // an hour later, in the injected clock
    const later = new Date(now.getTime() + 61 * 60_000)
    t.f.db.tables.ttb_messages.forEach((m) => { m.created_at = later.toISOString() })
    await t.run("hello", { settings: s, input: { now: later } })
    expect(t.deps.alert).toHaveBeenCalledTimes(2)
  })

  it("post-confirm replies are transactional: over the cap the race-loser open_order and the unusable-amount reply still go out", async () => {
    const t = capped(CAP + 5)
    const s = { globalRepliesPerHour: CAP }
    t.confirm.mockResolvedValueOnce({ type: "end", message: "", orderId: ORDER, amount: Number.NaN as number })
    const bad = await t.run("5gb", { settings: s })
    expect(bad.result).toMatchObject({ outcome: "unavailable" })
    expect(bad.result.reply).not.toBeNull()

  })

  it("a pre-confirm open_order reply (hasOpenOrder) is still capped", async () => {
    const t = capped(CAP + 5)
    t.f.db.tables.ttb_orders.push({ id: "x", line: "main", sender: S, state: "awaiting_payment", order_id: "other", created_at: now.toISOString() })
    const pre = await t.run("5gb", { settings: { globalRepliesPerHour: CAP } })
    expect(pre.result).toMatchObject({ outcome: "limited", reply: null })
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("the race-loser open_order reply (after confirm) is sent over the cap", async () => {
    const t = setup({
      seed: { ttb_messages: outRows(CAP + 5), ussd_orders: [{ id: ORDER, order_status: "pending", payment_status: "pending" }] },
    })
    t.confirm.mockImplementation(async () => {
      t.f.db.tables.ttb_orders.push({ id: "winner", line: "main", sender: S, order_id: "other-order", state: "awaiting_payment", created_at: now.toISOString() })
      return { type: "end", message: "", orderId: ORDER, amount: 23.69 }
    })
    const { result } = await t.run("5gb", { settings: { globalRepliesPerHour: CAP } })
    expect(result).toMatchObject({ outcome: "open_order", reply: openOrderReply() })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })

  it("an alert that throws never throws out of processInbound and the reply is still suppressed", async () => {
    const t = capped(CAP)
    t.deps.alert.mockRejectedValue(new Error("notifier down"))
    const { result } = await t.run("help", { settings: { globalRepliesPerHour: CAP } })
    expect(result).toMatchObject({ outcome: "limited", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
  })

  it("count read fails: the quote still goes, a non-order reply is suppressed, nothing throws, the log has no text", async () => {
    const t = setup()
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const real = t.c.from.bind(t.c)
    const broken = {
      ...t.c,
      from: (table: string) => {
        const b = real(table) as unknown as { select: (c?: string, o?: { head?: boolean }) => unknown }
        const sel = b.select
        b.select = (c, o) => {
          if (o?.head) throw new Error("count down")
          return sel(c, o)
        }
        return b
      },
    } as unknown as SupabaseClient
    const run = async (text: string) => {
      const input: InboundInput = { line: "main", from: S, text, receivedAt: null, now }
      const { id } = await acceptInbound(broken, input)
      return processInbound(broken, id, input, settings(), t.deps as unknown as InboundDeps)
    }
    const help = await run("help")
    expect(help).toMatchObject({ outcome: "limited", reply: null })
    const quote = await run("5gb")
    expect(quote).toMatchObject({ outcome: "prompted", orderId: ORDER })
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(err.mock.calls)).not.toContain("help")
    expect(JSON.stringify(err.mock.calls)).not.toContain(S)
  })

  it("dry run: same decision, no writes, no send, no alert", async () => {
    const t = capped(CAP)
    const input: InboundInput = { line: "main", from: S, text: "help", receivedAt: null, now }
    const { id } = await acceptInbound(t.c, input)
    const before = JSON.stringify(t.f.db.tables)
    const r = await processInbound(t.c, id, input, settings({ globalRepliesPerHour: CAP }), { ...t.deps, dryRun: true } as unknown as InboundDeps)
    expect(r).toMatchObject({ outcome: "limited", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.deps.alert).not.toHaveBeenCalled()
    expect(JSON.stringify(t.f.db.tables)).toBe(before)

    const under = capped(CAP - 1)
    const i2: InboundInput = { line: "main", from: S, text: "help", receivedAt: null, now }
    const { id: id2 } = await acceptInbound(under.c, i2)
    const r2 = await processInbound(under.c, id2, i2, settings({ globalRepliesPerHour: CAP }), { ...under.deps, dryRun: true } as unknown as InboundDeps)
    expect(r2).toMatchObject({ outcome: "keyword", reply: helpReply() })
  })
})

describe("acceptInbound", () => {
  it("stores the row; the same input twice is a duplicate, processed only once an outcome is recorded", async () => {
    const t = setup()
    const input: InboundInput = { line: "main", from: S, text: "5gb", receivedAt: new Date("2026-11-13T11:59:00Z"), now }
    const first = await acceptInbound(t.c, input)
    expect(first).toMatchObject({ duplicate: false, processed: false })
    expect(t.f.db.tables.ttb_messages[0]).toMatchObject({ direction: "in", line: "main", sender: S, body: "5gb" })

    const again = await acceptInbound(t.c, input)
    expect(again).toEqual({ id: first.id, duplicate: true, processed: false }) // crashed before processing: the webhook reschedules

    await processInbound(t.c, first.id, input, settings(), t.deps as unknown as InboundDeps)
    const third = await acceptInbound(t.c, input)
    expect(third).toEqual({ id: first.id, duplicate: true, processed: true })
    expect(t.confirm).toHaveBeenCalledTimes(1)
  })

  it("throws when the row cannot be stored", async () => {
    const t = setup()
    t.f.db.failOn.ttb_messages = { message: "down" }
    await expect(acceptInbound(t.c, { line: "main", from: S, text: "5gb", receivedAt: null, now })).rejects.toThrow()
  })
})

describe("failure handling", () => {
  it("resolve throwing: outcome error, no reply, no throw, and only the row id and error name are logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const t = setup()
    class Boom extends Error { constructor() { super("secret 0200000101 five gig"); this.name = "BoomError" } }
    t.deps.resolve.mockRejectedValue(new Boom())
    const { result, id } = await t.run("5gb")
    expect(result).toEqual({ outcome: "error", readBy: "rules", reply: null })
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.message(id).outcome).toBe("error")
    expect(spy).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain(id)
    expect(logged).toContain("BoomError")
    expect(logged).not.toContain("secret")
    expect(logged).not.toContain(S)
    expect(logged).not.toContain("5gb")
  })

  it("never logs customer text or numbers on the happy path either", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    const t = setup()
    await t.run("5gb")
    for (const s of spies) expect(s).not.toHaveBeenCalled()
  })

  it("a throwing reply sender is an error outcome, not a throw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const t = setup()
    t.deps.reply.mockRejectedValue(new Error("x"))
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("error")
  })
})

describe("claiming the inbound row", () => {
  const inputFor = (text = "5gb", at = now): InboundInput => ({ line: "main", from: S, text, receivedAt: null, now: at })
  const accept = async (t: ReturnType<typeof setup>) => (await acceptInbound(t.c, inputFor())).id
  const go = (t: ReturnType<typeof setup>, id: string, at = now, over: Partial<InboundDeps> = {}) =>
    processInbound(t.c, id, inputFor("5gb", at), settings(), { ...t.deps, ...over } as unknown as InboundDeps)

  it("two concurrent runs on one message place exactly one order; the other is a duplicate no-op", async () => {
    const t = setup()
    const id = await accept(t)
    const [a, b] = await Promise.all([go(t, id), go(t, id)])
    expect([a.outcome, b.outcome].sort()).toEqual(["duplicate", "prompted"])
    expect(t.confirm).toHaveBeenCalledTimes(1)
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.message(id).outcome).toBe("prompted")
    const loser = a.outcome === "duplicate" ? a : b
    expect(loser).toEqual({ outcome: "duplicate", readBy: null, reply: null })
  })

  it("a second call inside the lease is a no-op: nothing sent, nothing recorded", async () => {
    const t = setup()
    const id = await accept(t)
    t.message(id).claimed_at = new Date(now.getTime() - 10_000).toISOString()
    const r = await go(t, id)
    expect(r).toEqual({ outcome: "duplicate", readBy: null, reply: null })
    expect(t.confirm).not.toHaveBeenCalled()
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.message(id).outcome).toBeUndefined()
  })

  it("after the lease expires (i.now past 60 s) a still-unprocessed message is claimed and processed", async () => {
    const t = setup()
    const id = await accept(t)
    t.message(id).claimed_at = new Date(now.getTime() - 61_000).toISOString()
    expect((await go(t, id)).outcome).toBe("prompted")
    expect(t.message(id).claimed_at).toBe(now.toISOString())
  })

  it("a message that already has an outcome is never claimed", async () => {
    const t = setup()
    const id = await accept(t)
    t.message(id).outcome = "prompted"
    const r = await go(t, id, new Date(now.getTime() + 600_000))
    expect(r.outcome).toBe("duplicate")
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it("a failed claim reads nothing else (no counts, no AI, no resolve)", async () => {
    const t = setup()
    const id = await accept(t)
    t.message(id).claimed_at = now.toISOString()
    await go(t, id)
    expect(t.f.db.rpcCalls).toHaveLength(0)
    expect(t.deps.resolve).not.toHaveBeenCalled()
  })

  it("dryRun never claims", async () => {
    const t = setup()
    const id = await accept(t)
    await go(t, id, now, { dryRun: true })
    expect(t.message(id).claimed_at).toBeUndefined()
  })
})

describe("failures after confirm has placed the order", () => {
  const pending = () => ({ ussd_orders: [{ id: ORDER, order_status: "pending", payment_status: "pending" }] })
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("linkOrder throwing: the order is NOT failed (the prompt is real), the accurate quote goes out, outcome prompted, admins alerted with the order id only", async () => {
    const t = setup({ seed: pending() })
    t.f.db.failInsert.ttb_orders = { message: "db down" }
    const { result, id } = await t.run("5gb")
    const expected = quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 23.69, feeOnTop: false, payerNetwork: "MTN" })
    expect(result).toMatchObject({ outcome: "prompted", reply: expected })
    expect(t.f.db.tables.ussd_orders[0]).toEqual({ id: ORDER, order_status: "pending", payment_status: "pending" })
    expect(t.message(id).outcome).toBe("prompted")
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    const msg = String((t.deps.alert.mock.calls[0] as unknown[])[0])
    expect(msg).toContain(ORDER)
    expect(msg).not.toContain(S)
    expect(msg).not.toContain("23.69")
  })

  it("an alert that throws in the link-error branch still sends the quote and does not throw", async () => {
    const t = setup({ seed: pending() })
    t.f.db.failInsert.ttb_orders = { message: "db down" }
    t.deps.alert.mockRejectedValue(new Error("notifier down"))
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })

  it("saving the conversation failing never suppresses the quote: outcome stays prompted", async () => {
    const t = setup()
    t.confirm.mockImplementation(async () => {
      t.f.db.failOn.ttb_conversations = { message: "db down" }
      return { type: "end", message: "", orderId: ORDER, amount: 23.69 }
    })
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toContain("GHS 23.69")
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
  })
})

describe("the price guarantee in the quote", () => {
  it("feeOnTop is forced off when the written amount is above the offer price (a Paystack-priced row already holds the fee)", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue(ok({ price: 23.0 }))
    t.deps.feeOnTop.mockResolvedValue(true)
    t.confirm.mockResolvedValue({ type: "end", message: "", orderId: ORDER, amount: 23.69 } as never)
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("GHS 23.69")
    expect(result.reply).not.toContain("+ MoMo charge")
  })

  it("feeOnTop still applies when the written amount equals the offer price", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue(ok({ price: 23.69 }))
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result } = await t.run("5gb")
    expect(result.reply).toContain("+ MoMo charge")
  })

  it("a throwing injected feeOnTop is caught like the default: treated as false, the order still goes ahead", async () => {
    const t = setup()
    t.deps.feeOnTop.mockRejectedValue(new Error("down"))
    const { result } = await t.run("5gb")
    expect(result.outcome).toBe("prompted")
    expect(result.reply).not.toContain("+ MoMo charge")
  })
})
