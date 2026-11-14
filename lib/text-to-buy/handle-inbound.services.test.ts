import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateSegments } from "@/lib/sms/segments"
import { makeFakeTtb } from "./fake-db.test-helper"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import type { Offer, OfferResult } from "./catalogue"
import type { ReadResult } from "./types"
import {
  airtimeQuoteReply, notUnderstoodReply, openOrderReply, limitedReply, placedNeutralReply, statusReply, helpReply, quoteReply,
  voucherQuoteReply, voucherBoardQuestion, voucherOffReply,
} from "./replies"

const h = vi.hoisted(() => ({
  map: { MTN: ["24"], TELECEL: ["20"], AT: ["27"] } as Record<string, string[]>,
  surface: vi.fn(),
  payer: vi.fn(),
  notify: vi.fn(),
  rate: vi.fn(async (_n: string, _dealer: boolean) => 5),
  rcEnabled: vi.fn(async (_b: string) => true),
  rcAvailable: vi.fn(async (_b: string) => 40),
  rcMax: vi.fn(async () => 50),
  rcPrice: vi.fn(async (_p: { examBoard: string; quantity: number; applyBulk?: boolean }) => ({ totalPaid: 30, unitPrice: 15 })),
  rcBoards: vi.fn(async (): Promise<string[]> => ["WASSCE"]),
}))

vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: h.rcEnabled,
  getAvailableCount: h.rcAvailable,
  getMaxQuantity: h.rcMax,
  calculateRCPrice: h.rcPrice,
  isValidExamBoard: (b: string) => ["WASSCE", "BECE", "NOVDEC"].includes(b),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ confirmRcByText: vi.fn(), buildRcBoardOptions: h.rcBoards }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: true, map: h.map })) }))
vi.mock("@/lib/payment-gateway/start", () => ({ resolveSurfaceGateway: h.surface }))
vi.mock("@/lib/ussd/gateway-charge", () => ({ isUssdHubtelPayer: h.payer }))
vi.mock("@/lib/ussd/handlers/bundles", () => ({ handleConfirm: vi.fn() }))
vi.mock("@/lib/ussd/handlers/airtime", () => ({ confirmAirtimeByText: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), notifyAdmins: h.notify }))
vi.mock("@/lib/airtime-pricing", () => ({
  detectAirtimeNetwork: (p: string) => ({ "024": "MTN", "020": "Telecel", "027": "AT" } as Record<string, string>)[p.slice(0, 3)] ?? null,
  splitInclusive: (amount: number, rate: number) => {
    const fee = parseFloat(((amount * rate) / (100 + rate)).toFixed(2))
    return { fee, toDeliver: parseFloat((amount - fee).toFixed(2)) }
  },
  isAirtimeEnabled: vi.fn(async () => true),
  getAirtimeLimits: vi.fn(async () => ({ min: 1, max: 500 })),
  airtimeBaseFeeRate: h.rate,
}))
vi.mock("@/lib/ussd/resolve-dialer", () => ({ resolveDialer: vi.fn(async () => ({})) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false) }))
vi.mock("./catalogue", () => ({
  resolveOffer: vi.fn(),
  listPrices: vi.fn(),
  parseSizeMb: (s: string) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb)?\s*$/i.exec(s)
    return m ? Math.round(m[2]?.toLowerCase() === "mb" ? Number(m[1]) : Number(m[1]) * 1000) : null
  },
  sizeLabel: (s: string) => (/^\d+(\.\d+)?$/.test(s) ? `${s}GB` : s),
  sessionForOffer: (sender: string, o: Offer) => ({ dialingPhone: "+233" + sender.slice(1), network: o.network, bundleId: o.bundleId, bundleSize: o.size, bundlePrice: o.price, recipientPhone: o.recipientLocal }),
}))

import { acceptInbound, processInbound, resetReplyCapAlert, type InboundDeps, type InboundInput } from "./handle-inbound"
import { airtimeAdapter } from "./services/airtime"
import { dataAdapter } from "./services/data"
import { resultsCheckerAdapter } from "./services/results-checker"

const S = "0200000101" // Telecel under the test map
const R = "0200000102"
const ORDER = "6f0c1a9e-0163-4163-8163-0000000000a1"
const now = new Date("2026-11-14T12:00:00Z")
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString()
const settings = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, mainEnabled: true, airtimeEnabled: true, ...over })
const tier = { effectivePriceTier: "customer", subAgentParentShopId: null, userId: null, mtnWhitelistActive: false } as unknown as Offer["tier"]
const dataOffer = (): OfferResult => ({ ok: true, offer: { network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: S, gift: false, tier, paystackProvider: "mtn" } })
const oneSegment = (s: string | null) => {
  const r = calculateSegments(s ?? "")
  expect([r.encoding, r.segments]).toEqual(["gsm7", 1])
}

type Placed = { type: string; message: string; orderId?: string; amount?: number; delivers?: number }

function setup(opts: { seed?: Record<string, Record<string, unknown>[]>; counts?: Partial<Record<"prompts_unpaid" | "replies" | "ai_reads" | "not_understood", number>>; placed?: Placed } = {}) {
  const f = makeFakeTtb(opts.seed ?? {})
  const counts = { prompts_unpaid: 0, replies: 0, ai_reads: 0, not_understood: 0, ...opts.counts }
  f.db.rpcImpl = (name) => (name === "ttb_counts" ? { data: [counts], error: null } : { data: 0, error: null })
  const c = f.client as unknown as SupabaseClient
  const airtimeConfirm = vi.fn(async (_sessionId: string, _session: Record<string, unknown>): Promise<Placed> => opts.placed ?? { type: "end", message: "USSD wording", orderId: ORDER, amount: 10, delivers: 9.52 })
  const rcConfirm = vi.fn(async (_sessionId: string, _session: Record<string, unknown>): Promise<Placed> => ({ type: "end", message: "USSD wording", orderId: ORDER, amount: 30 }))
  const dataResolve = vi.fn(async () => dataOffer())
  const dataConfirm = vi.fn(async () => ({ type: "end", message: "USSD wording", orderId: ORDER, amount: 23.69 }))
  const deps = {
    readAi: vi.fn(async () => ({ kind: "not_order" }) as ReadResult),
    resolve: dataResolve,
    prices: vi.fn(async () => ({ networkLabel: "MTN", items: [{ size: "1GB", priceGhs: 5 }] })),
    confirm: dataConfirm,
    reply: vi.fn(async () => ({ sent: true })),
    alert: vi.fn(async () => {}),
    feeOnTop: vi.fn(async () => false),
    adapters: {
      data: dataAdapter({ resolve: dataResolve, confirm: dataConfirm as never }) as never,
      airtime: airtimeAdapter({ confirm: airtimeConfirm as never }) as never,
      results_checker: resultsCheckerAdapter({ confirm: rcConfirm as never, boards: h.rcBoards as never }) as never,
    },
  }
  async function run(text: string, over: { input?: Partial<InboundInput>; settings?: Partial<TtbSettings>; deps?: Partial<InboundDeps> } = {}) {
    const input: InboundInput = { line: "main", from: S, text, receivedAt: null, now, ...over.input }
    const { id } = await acceptInbound(c, input)
    const result = await processInbound(c, id, input, settings(over.settings), { ...deps, ...over.deps } as InboundDeps)
    return { result, id }
  }
  return { f, c, counts, deps, airtimeConfirm, rcConfirm, dataResolve, dataConfirm, run }
}

beforeEach(() => {
  h.rcEnabled.mockReset().mockResolvedValue(true)
  h.rcAvailable.mockReset().mockResolvedValue(40)
  h.rcMax.mockReset().mockResolvedValue(50)
  h.rcPrice.mockReset().mockResolvedValue({ totalPaid: 30, unitPrice: 15 })
  h.rcBoards.mockReset().mockResolvedValue(["WASSCE"])
  h.map = { MTN: ["24"], TELECEL: ["20"], AT: ["27"] }
  h.surface.mockReset()
  h.payer.mockReset()
  h.notify.mockReset()
  resetReplyCapAlert()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("airtime text switch", () => {
  it("off: airtime 10 is not an order, nothing is resolved or confirmed, and the reply names no airtime", async () => {
    const t = setup()
    const { result } = await t.run("airtime 10", { settings: { airtimeEnabled: false } })
    expect(result.outcome).toBe("not_order")
    expect(result.reply).toBe(notUnderstoodReply({ airtime: false, resultsChecker: false }))
    expect(result.reply).toBe(notUnderstoodReply())
    expect(t.dataResolve).not.toHaveBeenCalled()
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
    expect(t.dataConfirm).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("on: the not-understood reply and HELP name airtime", async () => {
    const t = setup()
    const { result } = await t.run("what is this", { settings: { airtimeEnabled: true, resultsCheckerEnabled: false } })
    expect(result.reply).toBe(notUnderstoodReply({ airtime: true, resultsChecker: false }))
    const help = await t.run("help", { settings: { airtimeEnabled: true, resultsCheckerEnabled: true }, input: { from: R } })
    expect(help.result.reply).toBe(helpReply({ airtime: true, resultsChecker: true }))
    oneSegment(help.result.reply)
  })
})

describe("placing airtime", () => {
  it("on: one place; the quote states the PLACED amounts, not the preview; the link row names airtime", async () => {
    // Preview is pay 10 / they get 9.52. The order row written by confirm says pay 10.40 / they get 9.70.
    const t = setup({ placed: { type: "end", message: "x", orderId: ORDER, amount: 10.4, delivers: 9.7 } })
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result, id } = await t.run("airtime 10")
    expect(t.airtimeConfirm).toHaveBeenCalledTimes(1)
    const [sid, session] = t.airtimeConfirm.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(sid).toBe(`sms:${id}`)
    expect(session).toEqual({ step: "AIRTIME_CONFIRM", dialingPhone: "+233200000101", airtimeNetwork: "Telecel", airtimeRecipient: S, airtimeAmount: 10 })
    expect(result.outcome).toBe("prompted")
    // The order row already holds the gateway charge (10.40 > the 10 preview): no "+ MoMo charge" on top of it.
    const expected = airtimeQuoteReply({ networkLabel: "Telecel", recipientLocal: S, payGhs: 10.4, getsGhs: 9.7, feeOnTop: false, payerNetwork: "TELECEL" })
    expect(result.reply).toBe(expected)
    expect(result.reply).toContain("GHS 10.40")
    expect(result.reply).toContain("GHS 9.70")
    expect(result.reply).not.toContain("9.52")
    oneSegment(result.reply)
    expect(t.deps.reply).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({
      service: "airtime", order_table: "airtime_orders", order_id: ORDER, size: "airtime 10", recipient: S, gift: false, amount: 10.4, state: "awaiting_payment",
    })
  })

  it("a Hubtel-priced text: the quote amount equals the placed amount, whichever the preview was", async () => {
    const t = setup({ placed: { type: "end", message: "x", orderId: ORDER, amount: 10.15, delivers: 9.52 } })
    const { result } = await t.run("airtime 10")
    expect(result.reply).toContain("you pay GHS 10.15,")
    expect(t.f.db.tables.ttb_orders[0].amount).toBe(10.15)
  })

  it("a preview-priced order with the fee on top says so", async () => {
    const t = setup()
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result } = await t.run("airtime 10")
    expect(result.reply).toBe(airtimeQuoteReply({ networkLabel: "Telecel", recipientLocal: S, payGhs: 10, getsGhs: 9.52, feeOnTop: true, payerNetwork: "TELECEL" }))
    expect(result.reply).toContain("+ MoMo charge")
  })

  it("a gift is linked as a gift, to the recipient, with the number in the re-text token", async () => {
    const t = setup()
    const { result } = await t.run(`airtime 10 ${R}`)
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toContain(`airtime for ${R}`)
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ service: "airtime", gift: true, recipient: R, size: `airtime 10 ${R}` })
    expect(t.airtimeConfirm.mock.calls[0][1]).toMatchObject({ airtimeRecipient: R, dialingPhone: "+233200000101" })
  })

  it("below the minimum: the limits reply, nothing placed", async () => {
    const t = setup()
    const { result } = await t.run("airtime 0.5")
    expect(result).toMatchObject({ outcome: "unavailable", reply: "Airtime is GHS 1 to 500. Text e.g. airtime 10." })
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("an open DATA order blocks an airtime order", async () => {
    const t = setup({
      seed: { ttb_orders: [{ id: "L0", line: "main", sender: S, service: "data", order_table: "ussd_orders", order_id: "O0", state: "awaiting_payment", size: "1GB", recipient: S, gift: false, amount: 5, notices: [], created_at: minutesAgo(1) }] },
    })
    const { result } = await t.run("airtime 10")
    expect(result).toMatchObject({ outcome: "open_order", reply: openOrderReply() })
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
  })

  it("the per-sender unpaid-prompt cap applies to airtime too", async () => {
    const t = setup({ counts: { prompts_unpaid: 3 } })
    const { result } = await t.run("airtime 10")
    expect(result).toMatchObject({ outcome: "limited", reply: limitedReply() })
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
  })

  it("a dry run quotes from the preview and calls neither place nor linkOrder", async () => {
    const t = setup()
    const { result } = await t.run("airtime 10", { deps: { dryRun: true } })
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toBe(airtimeQuoteReply({ networkLabel: "Telecel", recipientLocal: S, payGhs: 10, getsGhs: 9.52, feeOnTop: false, payerNetwork: "TELECEL" }))
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_conversations).toHaveLength(0)
  })

  it("the network question is remembered, and picking 2 places a Telecel order", async () => {
    h.map = { MTN: ["24"], TELECEL: [], AT: [] } // 030 is nobody's
    const t = setup()
    const first = await t.run("airtime 10 0301234567")
    expect(first.result).toMatchObject({ outcome: "asked", reply: "Which network is that number on? 1) MTN 2) Telecel 3) AT" })
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
    const second = await t.run("2")
    expect(second.result.outcome).toBe("prompted")
    expect(t.airtimeConfirm).toHaveBeenCalledTimes(1)
    expect(t.airtimeConfirm.mock.calls[0][1]).toMatchObject({ airtimeNetwork: "Telecel", airtimeRecipient: "0301234567", airtimeAmount: 10 })
  })
})

describe("a placed order with unusable amounts", () => {
  it("no delivered amount: the neutral reply, one alert naming the order id, no link row", async () => {
    const t = setup({ placed: { type: "end", message: "x", orderId: ORDER, amount: 10 } })
    const { result } = await t.run("airtime 10")
    expect(result.reply).toBe(placedNeutralReply())
    expect(result.reply).not.toMatch(/GHS|\d/)
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(t.deps.alert).toHaveBeenCalledWith(`Text-to-Buy: order placed without a usable amount: ${ORDER}`)
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("a non-finite amount: the neutral reply for airtime", async () => {
    const t = setup({ placed: { type: "end", message: "x", orderId: ORDER, amount: Number.NaN, delivers: 9.52 } })
    const { result } = await t.run("airtime 10")
    expect(result.reply).toBe(placedNeutralReply())
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
  })

  it("a non-finite delivered amount: the neutral reply", async () => {
    const t = setup({ placed: { type: "end", message: "x", orderId: ORDER, amount: 10, delivers: Number.POSITIVE_INFINITY } })
    const { result } = await t.run("airtime 10")
    expect(result.reply).toBe(placedNeutralReply())
  })
})

describe("failures around place", () => {
  it("confirm returns no order id: the not-available reply, unavailable, nothing linked, no success", async () => {
    const t = setup({ placed: { type: "end", message: "Airtime no longer available" } })
    const { result } = await t.run("airtime 10")
    expect(result).toMatchObject({ outcome: "unavailable", reply: "Telecel airtime is not available now." })
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
    expect(t.deps.alert).not.toHaveBeenCalled()
  })

  it("an exception from place is handled: no crash, outcome recorded, one admin alert, no reply that claims success", async () => {
    const t = setup()
    t.airtimeConfirm.mockRejectedValue(new Error("boom 0200000101"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, id } = await t.run("airtime 10")
    expect(result.outcome).toBe("error")
    expect(result.reply).toBeNull()
    expect(t.deps.reply).not.toHaveBeenCalled()
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
    // recorded, so the recovery sweep does not run the text again and place a second order
    expect(t.f.db.tables.ttb_messages.find((m) => m.id === id)?.outcome).toBe("error")
    expect(JSON.stringify(err.mock.calls)).not.toContain(S)
    expect(JSON.stringify(t.deps.alert.mock.calls)).not.toContain(S)
  })

  it("an alert that fails while handling a place exception does not escape", async () => {
    const t = setup()
    t.airtimeConfirm.mockRejectedValue(new Error("boom"))
    t.deps.alert.mockRejectedValue(new Error("alert down"))
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = await t.run("airtime 10")
    expect(result.outcome).toBe("error")
  })
})

describe("again, yes and status after an airtime order", () => {
  const lastOrder = { service: "airtime", amountGhs: 10, network: "Telecel", recipient: R }
  const conv = (over: Record<string, unknown> = {}) => ({
    line: "main", sender: S, turns: [], pending: null, last_order: lastOrder, expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(), ...over,
  })

  it("again rebuilds the same amount, network and recipient", async () => {
    const t = setup({ seed: { ttb_conversations: [conv()] } })
    const { result } = await t.run("again")
    expect(result.outcome).toBe("prompted")
    expect(t.airtimeConfirm.mock.calls[0][1]).toMatchObject({ airtimeAmount: 10, airtimeNetwork: "Telecel", airtimeRecipient: R })
  })

  it("a placed airtime order stores the lastOrder the next again will use", async () => {
    const t = setup()
    await t.run(`airtime 12 ${R}`)
    expect(t.f.db.tables.ttb_conversations[0].last_order).toEqual({ service: "airtime", amountGhs: 12, network: "Telecel", recipient: R })
  })

  it("yes after an unpaid airtime link rebuilds it", async () => {
    const link = { id: "L1", line: "main", sender: S, service: "airtime", order_table: "airtime_orders", order_id: "O1", state: "closed", size: "airtime 10 " + R, recipient: R, gift: true, amount: 10, notices: ["unpaid"], created_at: minutesAgo(3) }
    const t = setup({ seed: { ttb_orders: [link], ttb_conversations: [conv()] } })
    const { result } = await t.run("yes")
    expect(result.outcome).toBe("prompted")
    expect(t.airtimeConfirm.mock.calls[0][1]).toMatchObject({ airtimeAmount: 10, airtimeRecipient: R })
  })

  it("again with the airtime switch off is not understood, nothing placed", async () => {
    const t = setup({ seed: { ttb_conversations: [conv()] } })
    const { result } = await t.run("again", { settings: { airtimeEnabled: false } })
    expect(result.outcome).toBe("not_order")
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
  })

  it("status reads airtime_orders", async () => {
    const link = { id: "L1", line: "main", sender: S, service: "airtime", order_table: "airtime_orders", order_id: "O1", state: "paid", size: "airtime 10", recipient: S, gift: false, amount: 10, notices: [], created_at: minutesAgo(3) }
    const t = setup({ seed: { ttb_orders: [link], airtime_orders: [{ id: "O1", status: "completed", payment_status: "completed", total_paid: 10 }] } })
    const { result } = await t.run("status")
    expect(result.reply).toBe(statusReply("delivered", "airtime 10"))
  })

  it("status reads the table the link names, never a same-id row in another table", async () => {
    const link = { id: "L1", line: "main", sender: S, service: "airtime", order_table: "airtime_orders", order_id: "O1", state: "awaiting_payment", size: "airtime 10", recipient: S, gift: false, amount: 10, notices: [], created_at: minutesAgo(1) }
    const t = setup({
      seed: {
        ttb_orders: [link],
        ussd_orders: [{ id: "O1", order_status: "completed", payment_status: "completed", amount: 5 }],
        airtime_orders: [{ id: "O1", status: "pending_payment", payment_status: "pending_payment", total_paid: 10 }],
      },
    })
    const { result } = await t.run("status")
    expect(result.reply).toBe(statusReply("awaiting_payment", "airtime 10"))
  })

  it("status with a pair no adapter knows (airtime on ussd_orders) reports from the link alone, never failed from the wrong table", async () => {
    const link = { id: "L1", line: "main", sender: S, service: "airtime", order_table: "ussd_orders", order_id: "O1", state: "awaiting_payment", size: "airtime 10", recipient: S, gift: false, amount: 10, notices: [], created_at: minutesAgo(1) }
    const t = setup({ seed: { ttb_orders: [link], ussd_orders: [{ id: "O1", order_status: "failed", payment_status: "failed", amount: 10 }] } })
    const { result } = await t.run("status")
    expect(result.reply).toBe(statusReply("awaiting_payment", "airtime 10"))
  })
})

describe("checker vouchers by text", () => {
  const rcOn = { settings: { resultsCheckerEnabled: true } }
  const bodies = (t: ReturnType<typeof setup>) => (t.deps.reply.mock.calls as unknown as unknown[][]).map((c) => (c[1] as { body: string }).body)
  const conv = (over: Record<string, unknown> = {}) => ({
    line: "main", sender: S, turns: [], pending: null, last_order: null, expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(), ...over,
  })
  const rcLink = (over: Record<string, unknown> = {}) => ({
    id: "L1", line: "main", sender: S, service: "results_checker", order_table: "results_checker_orders", order_id: "O1", state: "awaiting_payment",
    size: "2 wassce", recipient: S, gift: false, amount: 30, notices: [], created_at: minutesAgo(1), ...over,
  })

  it("switch off: 2 wassce is not an order and nothing is resolved, confirmed or linked", async () => {
    const t = setup()
    const { result } = await t.run("2 wassce", { settings: { resultsCheckerEnabled: false } })
    expect(result.outcome).toBe("not_order")
    expect(t.rcConfirm).not.toHaveBeenCalled()
    expect(h.rcPrice).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("on: one place with the staged session, a link row naming results_checker, and a quote with the PLACED total", async () => {
    // Preview 30; the order row says 31.
    const t = setup()
    t.rcConfirm.mockResolvedValue({ type: "end", message: "x", orderId: ORDER, amount: 31 })
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result, id } = await t.run("2 wassce", rcOn)
    expect(t.rcConfirm).toHaveBeenCalledTimes(1)
    expect(t.rcConfirm.mock.calls[0]).toEqual([`sms:${id}`, { step: "RC_CONFIRM", dialingPhone: "+233200000101", rcBoard: "WASSCE", rcQty: 2 }])
    expect(result.outcome).toBe("prompted")
    expect(result.reply).toBe(voucherQuoteReply({ board: "WASSCE", quantity: 2, amountGhs: 31, feeOnTop: false, payerNetwork: "TELECEL" }))
    expect(result.reply).toContain("GHS 31.00")
    expect(result.reply).not.toContain("30.00")
    oneSegment(result.reply)
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({
      service: "results_checker", order_table: "results_checker_orders", order_id: ORDER, size: "2 wassce", gift: false, recipient: S, amount: 31, state: "awaiting_payment",
    })
    expect(t.f.db.tables.ttb_conversations[0].last_order).toEqual({ service: "results_checker", board: "WASSCE", quantity: 2 })
  })

  it("a preview-priced order with the fee on top says so", async () => {
    const t = setup()
    t.deps.feeOnTop.mockResolvedValue(true)
    const { result } = await t.run("2 wassce", rcOn)
    expect(result.reply).toBe(voucherQuoteReply({ board: "WASSCE", quantity: 2, amountGhs: 30, feeOnTop: true, payerNetwork: "TELECEL" }))
  })

  it("no lane reply ever carries a PIN, whatever the order does", async () => {
    const t = setup()
    await t.run("2 wassce", rcOn)
    await t.run("status", { ...rcOn, input: { from: R } })
    await t.run("help", rcOn)
    expect(bodies(t).length).toBeGreaterThan(1)
    for (const b of bodies(t)) expect(b).not.toMatch(/PIN:|serial/i)
  })

  it("confirm returns no order id: the board-named not-available reply, nothing linked", async () => {
    const t = setup()
    t.rcConfirm.mockResolvedValue({ type: "end", message: "no" })
    const { result } = await t.run("2 wassce", rcOn)
    expect(result).toMatchObject({ outcome: "unavailable", reply: voucherOffReply("WASSCE") })
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("an exception from place: handled, one alert carrying the opaque message id and no PII, no success reply", async () => {
    const t = setup()
    t.rcConfirm.mockRejectedValue(new Error("boom 0200000101"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, id } = await t.run("2 wassce", rcOn)
    expect(result.outcome).toBe("error")
    expect(result.reply).toBeNull()
    expect(t.deps.alert).toHaveBeenCalledTimes(1)
    expect(String((t.deps.alert.mock.calls as unknown as unknown[][])[0][0])).toContain(id)
    expect(JSON.stringify(t.deps.alert.mock.calls)).not.toContain(S)
    expect(JSON.stringify(err.mock.calls)).not.toContain(S)
    expect(t.f.db.tables.ttb_orders).toHaveLength(0)
  })

  it("an open order blocks a voucher order, and the unpaid cap applies", async () => {
    const open = setup({ seed: { ttb_orders: [rcLink({ order_id: "O0", created_at: minutesAgo(1) })] } })
    expect((await open.run("2 wassce", rcOn)).result.outcome).toBe("open_order")
    const capped = setup({ counts: { prompts_unpaid: 3 } })
    expect((await capped.run("2 wassce", rcOn)).result).toMatchObject({ outcome: "limited", reply: limitedReply() })
    expect(open.rcConfirm).not.toHaveBeenCalled()
    expect(capped.rcConfirm).not.toHaveBeenCalled()
  })

  it("the board question is remembered with the quantity; picking 2 places a BECE order for that quantity", async () => {
    h.rcBoards.mockResolvedValue(["WASSCE", "BECE", "NOVDEC"])
    const t = setup()
    const first = await t.run("5 checkers", rcOn)
    expect(first.result).toMatchObject({ outcome: "asked", reply: voucherBoardQuestion(["WASSCE", "BECE", "NOVDEC"]) })
    expect(t.rcConfirm).not.toHaveBeenCalled()
    const second = await t.run("2", rcOn)
    expect(second.result.outcome).toBe("prompted")
    expect(t.rcConfirm.mock.calls[0][1]).toMatchObject({ rcBoard: "BECE", rcQty: 5 })
    expect(t.dataConfirm).not.toHaveBeenCalled()
  })

  describe("a pending 'how many' question from the AI", () => {
    const ask = { kind: "ask", question: "How many checkers do you want?", awaitBoard: "WASSCE" } as unknown as ReadResult

    it("a bare number completes the voucher instead of becoming a data order", async () => {
      const t = setup()
      t.deps.readAi.mockResolvedValue(ask)
      const first = await t.run("wassce checkers", rcOn)
      expect(first.result).toMatchObject({ outcome: "asked", reply: "How many checkers do you want?" })
      expect(t.f.db.tables.ttb_conversations[0].pending).toEqual({ type: "quantity", board: "WASSCE" })
      const second = await t.run("2", rcOn)
      expect(second.result.outcome).toBe("prompted")
      expect(t.rcConfirm.mock.calls[0][1]).toMatchObject({ rcBoard: "WASSCE", rcQty: 2 })
      expect(t.dataConfirm).not.toHaveBeenCalled()
      expect(t.deps.readAi).toHaveBeenCalledTimes(1)
    })

    it("only a bare whole number counts: 5gb stays data, and an out-of-range number is refused by the adapter", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ pending: { type: "quantity", board: "WASSCE" } })] } })
      await t.run("5gb", rcOn)
      expect(t.dataConfirm).toHaveBeenCalledTimes(1)
      expect(t.rcConfirm).not.toHaveBeenCalled()
      const big = setup({ seed: { ttb_conversations: [conv({ pending: { type: "quantity", board: "WASSCE" } })] } })
      const r = await big.run("60", rcOn)
      expect(r.result).toMatchObject({ outcome: "unavailable", reply: "You can buy up to 40 WASSCE checkers per order." })
      expect(big.rcConfirm).not.toHaveBeenCalled()
    })

    it("with the voucher switch off a pending question places nothing", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ pending: { type: "quantity", board: "WASSCE" } })] } })
      const { result } = await t.run("2", { settings: { resultsCheckerEnabled: false } })
      expect(result.outcome).toBe("not_order")
      expect(t.rcConfirm).not.toHaveBeenCalled()
      expect(t.dataConfirm).not.toHaveBeenCalled()
    })

    it("an expired conversation forgets the question: a bare 3 is data again", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ pending: { type: "quantity", board: "WASSCE" }, expires_at: minutesAgo(1) })] } })
      await t.run("3", rcOn)
      expect(t.dataConfirm).toHaveBeenCalledTimes(1)
      expect(t.rcConfirm).not.toHaveBeenCalled()
    })

    it("a malformed stored quantity question is ignored", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ pending: { type: "quantity", board: "GCE" } })] } })
      await t.run("3", rcOn)
      expect(t.dataConfirm).toHaveBeenCalledTimes(1)
      expect(t.rcConfirm).not.toHaveBeenCalled()
    })
  })

  it("a bare number with no pending question stays a data order (Stage 1)", async () => {
    const t = setup()
    await t.run("3", rcOn)
    expect(t.dataConfirm).toHaveBeenCalledTimes(1)
    expect(t.rcConfirm).not.toHaveBeenCalled()
  })

  describe("again, yes, status and Try-it", () => {
    const lastOrder = { service: "results_checker", board: "BECE", quantity: 3 }

    it("again rebuilds the same board and quantity", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ last_order: lastOrder })] } })
      const { result } = await t.run("again", rcOn)
      expect(result.outcome).toBe("prompted")
      expect(t.rcConfirm.mock.calls[0][1]).toMatchObject({ rcBoard: "BECE", rcQty: 3 })
    })

    it("yes after an unpaid voucher link rebuilds it", async () => {
      const t = setup({ seed: { ttb_orders: [rcLink({ state: "closed", notices: ["unpaid"], size: "3 bece" })], ttb_conversations: [conv({ last_order: lastOrder })] } })
      const { result } = await t.run("yes", rcOn)
      expect(result.outcome).toBe("prompted")
      expect(t.rcConfirm.mock.calls[0][1]).toMatchObject({ rcBoard: "BECE", rcQty: 3 })
    })

    it("again with the voucher switch off is not understood, nothing placed", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ last_order: lastOrder })] } })
      const { result } = await t.run("again", { settings: { resultsCheckerEnabled: false } })
      expect(result.outcome).toBe("not_order")
      expect(t.rcConfirm).not.toHaveBeenCalled()
    })

    it("a stored Stage 1 data row still rebuilds as data", async () => {
      const t = setup({ seed: { ttb_conversations: [conv({ last_order: { sizeMb: 5000, network: "MTN", recipient: S } })] } })
      await t.run("again", rcOn)
      expect(t.dataConfirm).toHaveBeenCalledTimes(1)
      expect(t.rcConfirm).not.toHaveBeenCalled()
    })

    it("status reads results_checker_orders", async () => {
      const t = setup({
        seed: {
          ttb_orders: [rcLink({ state: "paid" })],
          results_checker_orders: [{ id: "O1", status: "completed", payment_status: "completed", total_paid: 30 }],
        },
      })
      const { result } = await t.run("status", rcOn)
      expect(result.reply).toBe(statusReply("delivered", "2 wassce"))
    })

    it("a dry run quotes from the preview and writes and places nothing", async () => {
      const t = setup()
      const { result } = await t.run("2 wassce", { ...rcOn, deps: { dryRun: true } })
      expect(result.outcome).toBe("prompted")
      expect(result.reply).toBe(voucherQuoteReply({ board: "WASSCE", quantity: 2, amountGhs: 30, feeOnTop: false, payerNetwork: "TELECEL" }))
      expect(t.rcConfirm).not.toHaveBeenCalled()
      expect(t.f.db.tables.ttb_orders).toHaveLength(0)
      expect(t.f.db.tables.ttb_conversations).toHaveLength(0)
      expect(t.deps.reply).not.toHaveBeenCalled()
    })
  })
})

describe("data stays data", () => {
  it("a data text still goes to the data adapter and never to the airtime one", async () => {
    const t = setup()
    const { result } = await t.run("5gb")
    expect(t.dataConfirm).toHaveBeenCalledTimes(1)
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
    expect(result.reply).toBe(quoteReply({ size: "5GB", networkLabel: "MTN", recipientLocal: S, amountGhs: 23.69, feeOnTop: false, payerNetwork: "TELECEL" }))
  })

  it("a price question never reaches an airtime offer", async () => {
    const t = setup()
    const { result } = await t.run("price of 5gb")
    expect(["price_answer", "not_order"]).toContain(result.outcome)
    expect(t.airtimeConfirm).not.toHaveBeenCalled()
  })
})
