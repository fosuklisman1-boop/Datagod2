import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import type { Offer, OfferResult } from "./catalogue"
import type { ReadResult } from "./types"

/**
 * Golden test of the Stage 1 data lane. Written against the lane BEFORE the per-service refactor and kept unchanged after it:
 * the snapshots pin what the lane reads, asks, places, links, saves and sends, and what the notifier does with a link in each
 * order state. Generated ids are replaced by stable placeholders so the snapshot is deterministic.
 */

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
import { runTtbNotify } from "./notify"

const S = "0200000101"
const R = "0200000150"
const ORDER = "6f0c1a9e-0163-4163-8163-0000000000c1"
const now = new Date("2026-11-13T12:00:00Z")
const MIN = 60_000
const minutesAgo = (m: number) => new Date(now.getTime() - m * MIN)
const tier = { effectivePriceTier: "customer", subAgentParentShopId: null, userId: null, mtnWhitelistActive: false } as unknown as Offer["tier"]
const offer = (over: Partial<Offer> = {}): Offer => ({
  network: "MTN", networkLabel: "MTN", bundleId: "b5", size: "5", price: 23.69, recipientLocal: S, gift: false, tier, paystackProvider: "mtn", ...over,
})
const ok = (over: Partial<Offer> = {}): OfferResult => ({ ok: true, offer: offer(over) })
const settings: TtbSettings = { ...TTB_DEFAULTS, mainEnabled: true }

/** Replaces every uuid by a placeholder numbered in order of first appearance, so snapshots do not depend on generated ids. */
function stable<T>(value: T): T {
  const seen = new Map<string, string>()
  const text = JSON.stringify(value ?? null).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
    if (!seen.has(u)) seen.set(u, `<uuid-${seen.size + 1}>`)
    return seen.get(u)!
  })
  return JSON.parse(text) as T
}

function setup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const f = makeFakeTtb(seed)
  f.db.rpcImpl = (name) =>
    name === "ttb_counts"
      ? { data: [{ prompts_unpaid: 0, replies: 0, ai_reads: 0, not_understood: 0 }], error: null }
      : { data: 0, error: null }
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
  const steps: { text: string; result: unknown }[] = []
  async function run(text: string, over: { at?: number; dryRun?: boolean } = {}) {
    const input: InboundInput = { line: "main", from: S, text, receivedAt: null, now: new Date(now.getTime() + (over.at ?? 0)) }
    const { id } = await acceptInbound(c, input)
    const result = await processInbound(c, id, input, settings, { ...deps, ...(over.dryRun ? { dryRun: true } : {}) } as unknown as InboundDeps)
    steps.push({ text, result })
    return result
  }
  const snapshot = () => ({
    steps,
    confirmCalls: confirm.mock.calls,
    orders: f.db.tables.ttb_orders,
    conversations: f.db.tables.ttb_conversations,
    messages: f.db.tables.ttb_messages.map((m) => ({ ...m, body: undefined, text: m.body })),
    replies: deps.reply.mock.calls.map((x) => (x as unknown as [unknown, Record<string, unknown>])[1]),
    alerts: deps.alert.mock.calls,
  })
  return { f, c, deps, confirm, run, snapshot }
}

beforeEach(() => {
  h.map = { MTN: ["20"], TELECEL: [], AT: [] }
  h.surface.mockReset()
  h.payer.mockReset()
  h.notify.mockReset()
  resetReplyCapAlert()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("lane golden: inbound", () => {
  it("5gb", async () => {
    const t = setup()
    await t.run("5gb")
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("5gb to a gift number", async () => {
    const t = setup()
    t.deps.resolve.mockResolvedValue(ok({ recipientLocal: R, gift: true }))
    await t.run(`5gb ${R}`)
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("PRICES then 2", async () => {
    const t = setup()
    await t.run("prices")
    await t.run("2", { at: MIN })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("how much is 10gb then yes", async () => {
    const t = setup()
    t.deps.readAi.mockResolvedValue({ kind: "price_query", service: "data", sizeMb: 10000, networkHint: null })
    t.deps.resolve.mockResolvedValueOnce(ok({ size: "10", price: 45 }))
    await t.run("how much is 10gb")
    t.deps.resolve.mockResolvedValueOnce(ok({ size: "10", price: 46 }))
    await t.run("yes", { at: MIN })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("again after an order", async () => {
    const t = setup()
    await t.run("5gb")
    await t.run("again", { at: 6 * MIN })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("again with a remembered last order and no open link", async () => {
    const t = setup({
      ttb_conversations: [{ line: "main", sender: S, turns: [], pending: null, last_order: { sizeMb: 5000, network: "AT-iShare", recipient: R }, expires_at: minutesAgo(30).toISOString() }],
    })
    await t.run("again")
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("status after an order", async () => {
    const t = setup({ ussd_orders: [{ id: ORDER, order_status: "pending", payment_status: "pending", amount: 23.69 }] })
    await t.run("5gb")
    await t.run("status", { at: MIN })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("yes with nothing pending", async () => {
    const t = setup()
    await t.run("yes")
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("hello (not understood)", async () => {
    const t = setup()
    await t.run("hello")
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("an AT sender with both products, then 1", async () => {
    h.map = { MTN: [], TELECEL: [], AT: ["20"] }
    const t = setup()
    const two = [offer({ network: "AT-iShare", networkLabel: "AT", bundleId: "i5" }), offer({ network: "AT-BigTime", networkLabel: "AT", bundleId: "b5" })]
    t.deps.resolve.mockResolvedValueOnce({ ok: false, reason: "choose_product", options: two })
    await t.run("5gb")
    t.deps.resolve.mockResolvedValueOnce(ok({ network: "AT-iShare", networkLabel: "AT", bundleId: "i5" }))
    await t.run("1", { at: MIN })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })

  it("dry run of 5gb", async () => {
    const t = setup()
    await t.run("5gb", { dryRun: true })
    expect(stable(t.snapshot())).toMatchSnapshot()
  })
})

describe("lane golden: notifier", () => {
  const MS = 60_000
  const HOUR = 60 * MS
  const iso = (ms: number) => new Date(now.getTime() + ms).toISOString()
  const link = (o: Record<string, unknown> = {}) => ({
    id: "L1", line: "main", sender: S, order_id: "O1", state: "awaiting_payment", size: "1GB", recipient: S, gift: false,
    amount: 5, notices: [], created_at: iso(-1 * MS), paid_at: null, delivered_at: null, closed_at: null, ...o,
  })
  const order = (o: Record<string, unknown> = {}) => ({ id: "O1", order_status: "pending", payment_status: "pending", amount: 5, ...o })

  const cases: [string, Record<string, unknown>, Record<string, unknown> | null][] = [
    ["waiting under the window", link({ created_at: iso(-4 * MS) }), order()],
    ["waiting over the window", link({ created_at: iso(-6 * MS) }), order({ payment_status: "otp_required" })],
    ["waiting past 30 minutes", link({ created_at: iso(-31 * MS), notices: ["unpaid"] }), order()],
    ["payment failed", link(), order({ payment_status: "failed", order_status: "failed" })],
    ["repriced", link(), order({ amount: 5.5 })],
    ["paid and processing", link(), order({ payment_status: "completed", order_status: "processing" })],
    ["delivered gift", link({ gift: true, recipient: R, state: "paid", paid_at: iso(-5 * MS) }), order({ payment_status: "completed", order_status: "completed" })],
    ["delivered own number", link({ state: "paid", paid_at: iso(-5 * MS) }), order({ payment_status: "completed", order_status: "completed" })],
    ["delivery failed", link({ state: "paid", paid_at: iso(-2 * MS) }), order({ payment_status: "completed", order_status: "failed" })],
    ["paid not delivered after 30 minutes", link({ state: "paid", paid_at: iso(-30 * MS) }), order({ payment_status: "completed", order_status: "processing" })],
    ["paid never delivered after 48 hours", link({ state: "paid", paid_at: iso(-48 * HOUR), notices: ["paid_not_delivered"] }), order({ payment_status: "completed", order_status: "failed" })],
    ["refunded", link({ state: "paid", paid_at: iso(-5 * MS) }), order({ payment_status: "completed", order_status: "refunded" })],
    ["refunding", link({ state: "paid", paid_at: iso(-5 * MS) }), order({ payment_status: "completed", order_status: "refunding" })],
    ["order row missing", link(), null],
  ]

  it.each(cases)("%s", async (_name, l, o) => {
    const f = makeFakeTtb({ ttb_orders: [l], ussd_orders: o ? [o] : [] })
    f.db.rpcImpl = () => ({ data: 0, error: null })
    const reply = vi.fn(async () => ({ sent: true }))
    const alert = vi.fn(async () => {})
    const processInboundStub = vi.fn(async () => ({ outcome: "prompted" as const, readBy: null, reply: null }))
    const result = await runTtbNotify(f.client as unknown as SupabaseClient, now, settings, { reply, alert, processInbound: processInboundStub } as never)
    expect(
      stable({ result, links: f.db.tables.ttb_orders, replies: reply.mock.calls.map((x) => (x as unknown as [unknown, Record<string, unknown>])[1]), alerts: alert.mock.calls }),
    ).toMatchSnapshot()
  })
})
