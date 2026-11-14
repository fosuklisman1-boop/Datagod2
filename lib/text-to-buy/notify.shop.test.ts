import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { runTtbNotify } from "./notify"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import { deliveredGiftReply, paidNotDeliveredReply, unpaidReply } from "./replies"

const S = "0200000101"
const now = new Date("2026-11-14T10:00:00Z") // 10:00 in Africa/Accra (UTC+0)
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(now.getTime() + ms).toISOString()
const shopOn: TtbSettings = { ...TTB_DEFAULTS, shopEnabled: true, source: "db" }
const mainOn: TtbSettings = { ...TTB_DEFAULTS, mainEnabled: true, source: "db" }
const bothOn: TtbSettings = { ...TTB_DEFAULTS, mainEnabled: true, shopEnabled: true, source: "db" }

type Seed = Record<string, Record<string, unknown>[]>
type ReplyArg = { line: string; sender: string; body: string; orderLinkId?: string; payer?: { kind: string; [k: string]: unknown } }

function setup(links: Record<string, unknown>[], orders: Record<string, unknown>[], extra: Seed = {}) {
  // Both forwarder phones seen a minute ago unless a test says otherwise (so the quiet alert stays out of the way).
  const seen = [{ line: "main", last_seen_at: iso(-MIN) }, { line: "shop", last_seen_at: iso(-MIN) }]
  const f = makeFakeTtb({ ttb_orders: links, ussd_shop_orders: orders, ttb_heartbeat: seen, ...extra })
  const reply = vi.fn(async (_db: unknown, _r: ReplyArg) => ({ sent: true, skipped: undefined as boolean | "unpaid" | undefined }))
  const alert = vi.fn(async (_m: string) => {})
  const processInbound = vi.fn(async (..._a: unknown[]) => ({ outcome: "prompted" as const, readBy: null, reply: null }))
  const accountFor = vi.fn(async (_db: unknown, _shopId: string): Promise<{ accountId: string } | null> => ({ accountId: "A1" }))
  const db = f.client as unknown as SupabaseClient
  f.db.rpcImpl = () => ({ data: 0, error: null })
  const run = (settings = shopOn, at = now) => runTtbNotify(db, at, settings, { reply, alert, processInbound, accountFor } as never)
  return { f, db, reply, alert, processInbound, accountFor, run }
}
const link = (o: Record<string, unknown> = {}) => ({
  id: "L1", line: "shop", service: "data", order_table: "ussd_shop_orders", shop_id: "SH1", sender: S, order_id: "O1", state: "awaiting_payment",
  size: "1GB", recipient: S, gift: false, amount: 5, notices: [], created_at: iso(-1 * MIN), paid_at: null, delivered_at: null, closed_at: null, ...o,
})
const order = (o: Record<string, unknown> = {}) => ({ id: "O1", order_status: "pending", payment_status: "pending", amount: 5, ...o })
const inboundOf = (id: string, linkId: string | null, o: Record<string, unknown> = {}) => ({
  id, line: "shop", sender: S, direction: "in", body: "1gb", outcome: "prompted", order_link_id: linkId, created_at: iso(-HOUR), ...o,
})
const reserve = (messageId: string, o: Record<string, unknown> = {}) => ({
  message_id: messageId, account_id: "A1", shop_id: "SH1", held: 3, used: 1, released_at: null, created_at: iso(-HOUR), ...o,
})
const bodies = (reply: { mock: { calls: unknown[][] } }) => reply.mock.calls.map((c) => (c[1] as ReplyArg).body)
const payers = (reply: { mock: { calls: unknown[][] } }) => reply.mock.calls.map((c) => (c[1] as ReplyArg).payer)

describe("shop links are followed", () => {
  it("a shop data link is read through the shop adapter: never an unknown-table alert", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    await t.run()
    expect(t.alert).not.toHaveBeenCalled()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
  })

  it("paid then delivered (gift): shop-paid notice drawing on the reserve, link closed, unused credits refunded once", async () => {
    const t = setup(
      [link({ gift: true, recipient: "0200000150", state: "paid", paid_at: iso(-5 * MIN) })],
      [order({ payment_status: "completed", order_status: "completed" })],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1")] },
    )
    const r = await t.run()
    expect(bodies(t.reply)).toEqual([deliveredGiftReply("1GB", "0200000150")])
    expect(payers(t.reply)).toEqual([{ kind: "shop", shopId: "SH1", accountId: "A1", messageId: "M1", replyKey: "n-L1-delivered" }])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", notices: ["delivered"] })
    expect(t.f.db.refunds).toEqual([{ messageId: "M1", credits: 2 }])
    expect(r).toMatchObject({ delivered: 1, closed: 1, reservesReleased: 1 })
    // A later run (and a second close of the same order) refunds nothing more.
    await t.run()
    expect(t.f.db.refunds).toHaveLength(1)
  })

  it("a link that closes with its reserve already released refunds nothing and does not throw", async () => {
    const t = setup(
      [link({ created_at: iso(-31 * MIN), notices: ["unpaid"] })],
      [order()],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1", { released_at: iso(-10 * MIN) })] },
    )
    await expect(t.run()).resolves.toMatchObject({ closed: 1 })
    expect(t.f.db.refunds).toEqual([])
  })

  it("unpaid at 30 minutes closes the link and releases the reserve", async () => {
    const t = setup(
      [link({ created_at: iso(-31 * MIN), notices: ["unpaid"] })],
      [order()],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1", { used: 2 })] },
    )
    await t.run()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(t.f.db.refunds).toEqual([{ messageId: "M1", credits: 1 }])
  })

  it("payment failed: 'try again' notice goes out shop-paid, no Datagod fallback, link closed, reserve released", async () => {
    const t = setup(
      [link()],
      [order({ payment_status: "failed", order_status: "failed" })],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1")] },
    )
    t.reply.mockResolvedValue({ sent: false, skipped: "unpaid" })
    await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
    expect(payers(t.reply).map((p) => p?.kind)).toEqual(["shop"])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", notices: ["unpaid"] })
    expect(t.f.db.refunds).toEqual([{ messageId: "M1", credits: 2 }])
  })

  it("a refunded order closes and releases", async () => {
    const t = setup(
      [link({ state: "paid", paid_at: iso(-5 * MIN) })],
      [order({ payment_status: "completed", order_status: "refunded" })],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1")] },
    )
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(t.f.db.refunds).toHaveLength(1)
  })

  it("a main link never touches the reserve functions", async () => {
    const t = setup(
      [link({ line: "main", order_table: "ussd_orders", shop_id: null, created_at: iso(-31 * MIN), notices: ["unpaid"] })],
      [],
      { ussd_orders: [order()] },
    )
    await t.run(mainOn)
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(t.f.db.rpcCalls.filter((c) => c.name === "ttb_release_reserve")).toEqual([])
  })

  it("a failed release at close does not stop the close, and the sweep retries it later", async () => {
    const t = setup(
      [link({ created_at: iso(-31 * MIN), notices: ["unpaid"] })],
      [order()],
      { ttb_messages: [inboundOf("M1", "L1")], ttb_credit_reserves: [reserve("M1")] },
    )
    t.f.db.failOn.ttb_release_reserve = { message: "REFUND_FAILED" }
    const r = await t.run()
    expect(r.closed).toBe(1)
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    delete t.f.db.failOn.ttb_release_reserve
    // The reserve is 1 hour old and its link is closed: the sweep gives the credits back.
    // The failed attempt was marked for today (backoff), so the sweep retries it the next day.
    await t.run(shopOn, new Date(now.getTime() + 25 * HOUR))
    expect(t.f.db.refunds).toEqual([{ messageId: "M1", credits: 2 }])
  })
})

describe("an unreadable shop link stays open", () => {
  it("a shop link with no shop id is never closed or read as main: one id-only alert per run", async () => {
    const t = setup([link({ id: "L1", shop_id: null }), link({ id: "L2", shop_id: null, order_id: "O2", sender: "0200000102" })], [order(), order({ id: "O2" })])
    await t.run()
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(String(t.alert.mock.calls[0][0])).toContain("L1")
    expect(t.f.db.tables.ttb_orders.map((r) => r.state)).toEqual(["awaiting_payment", "awaiting_payment"])
    expect(t.reply).not.toHaveBeenCalled()
  })

  it("a shop link naming a main order table stays open with the alert", async () => {
    const t = setup([link({ order_table: "ussd_orders", created_at: iso(-90 * MIN) })], [order()], { ussd_orders: [order()] })
    await t.run()
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_orders[0].state).toBe("awaiting_payment")
  })

  it("a shop link is followed even while the shop switch is off (a paid order is never dropped)", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    await t.run({ ...TTB_DEFAULTS, source: "db" })
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
  })
})

describe("paid but not delivered (the one Datagod-paid exception)", () => {
  const paidFailed = () => [order({ payment_status: "completed", order_status: "failed" })]
  const paidLink = () => [link({ state: "paid", paid_at: iso(-1 * HOUR) })]
  const shopCannotPay = (r: ReplyArg) => (r.payer?.kind === "shop" ? { sent: false, skipped: "unpaid" as const } : { sent: true, skipped: undefined })

  it("shop cannot cover it: exactly one Datagod-paid message, and none on later runs", async () => {
    const t = setup(paidLink(), paidFailed())
    t.reply.mockImplementation(async (_db, r) => shopCannotPay(r))
    const r = await t.run()
    expect(payers(t.reply).map((p) => p?.kind)).toEqual(["shop", "datagod"])
    expect(bodies(t.reply)).toEqual([paidNotDeliveredReply(), paidNotDeliveredReply()])
    expect(r.delayed).toBe(1)
    await t.run()
    await t.run()
    expect(t.reply).toHaveBeenCalledTimes(2)
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["paid_not_delivered"])
  })

  it("shop covers it: one shop-paid message, no Datagod message", async () => {
    const t = setup(paidLink(), paidFailed())
    await t.run()
    expect(payers(t.reply).map((p) => p?.kind)).toEqual(["shop"])
  })

  it("the shop has no SMS account: the single message is Datagod-paid", async () => {
    const t = setup(paidLink(), paidFailed())
    t.accountFor.mockResolvedValue(null)
    await t.run()
    expect(payers(t.reply)).toEqual([{ kind: "datagod" }])
  })

  it("a shop send that failed for another reason is not retried by Datagod", async () => {
    const t = setup(paidLink(), paidFailed())
    t.reply.mockResolvedValue({ sent: false, skipped: undefined })
    await t.run()
    expect(payers(t.reply).map((p) => p?.kind)).toEqual(["shop"])
  })

  it("other notices never fall back to Datagod: an unpaid notice the shop cannot cover is dropped", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.reply.mockImplementation(async (_db, r) => shopCannotPay(r))
    const r = await t.run()
    expect(payers(t.reply).map((p) => p?.kind)).toEqual(["shop"])
    expect(r.skipped).toBe(1)
  })
})

describe("stale reserve sweep", () => {
  it("an unlinked reserve older than the stale window is released; a fresh one is not", async () => {
    const t = setup([], [], {
      ttb_credit_reserves: [reserve("OLD", { created_at: iso(-20 * MIN) }), reserve("NEW", { created_at: iso(-5 * MIN) })],
    })
    const r = await t.run()
    expect(t.f.db.refunds).toEqual([{ messageId: "OLD", credits: 2 }])
    expect(t.f.db.tables.ttb_credit_reserves.find((x) => x.message_id === "NEW")?.released_at).toBeNull()
    expect(r.reservesReleased).toBe(1)
  })

  it("a reserve whose text has an open order is NOT released", async () => {
    const t = setup([link({ state: "paid", paid_at: iso(-30 * MIN), created_at: iso(-40 * MIN) })], [order({ payment_status: "completed", order_status: "processing" })], {
      ttb_messages: [inboundOf("M1", "L1")],
      ttb_credit_reserves: [reserve("M1", { created_at: iso(-40 * MIN) })],
    })
    await t.run()
    expect(t.f.db.refunds).toEqual([])
    expect(t.f.db.tables.ttb_credit_reserves[0].released_at).toBeNull()
  })

  it("a reserve whose order link is already closed (closed elsewhere, release missed) is released", async () => {
    const t = setup([link({ state: "closed", closed_at: iso(-20 * MIN), paid_at: iso(-30 * MIN), created_at: iso(-40 * MIN) })], [], {
      ttb_messages: [inboundOf("M1", "L1")],
      ttb_credit_reserves: [reserve("M1", { created_at: iso(-40 * MIN) })],
    })
    await t.run()
    expect(t.f.db.refunds).toEqual([{ messageId: "M1", credits: 2 }])
  })

  it("an already released reserve is left alone", async () => {
    const t = setup([], [], { ttb_credit_reserves: [reserve("OLD", { created_at: iso(-20 * MIN), released_at: iso(-10 * MIN) })] })
    await t.run()
    expect(t.f.db.rpcCalls.filter((c) => c.name === "ttb_release_reserve")).toEqual([])
  })

  it("a reserve that can never be refunded is tolerated: no throw, counted, one fixed alert, not repeated the same day", async () => {
    const t = setup([], [], { ttb_credit_reserves: [reserve("DEAD", { created_at: iso(-20 * MIN) }), reserve("DEAD2", { created_at: iso(-21 * MIN) })] })
    t.f.db.failOn.ttb_release_reserve = { message: "REFUND_FAILED: account gone" }
    const r = await t.run()
    expect(r.reservesReleased ?? 0).toBe(0)
    expect(t.alert).toHaveBeenCalledTimes(1)
    const text = String(t.alert.mock.calls[0][0])
    expect(text).toMatch(/reserve/i)
    expect(text).not.toMatch(/DEAD|SH1|A1|REFUND_FAILED/)
    await t.run(shopOn, new Date(now.getTime() + MIN))
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("25 dead reserves ahead of one good one: the good one is released in the same run, the dead ones are retried once a day", async () => {
    const dead = Array.from({ length: 25 }, (_, i) => reserve(`D${i}`, { created_at: iso(-3 * HOUR - i * MIN) }))
    const t = setup([], [], { ttb_credit_reserves: [...dead, reserve("GOOD", { created_at: iso(-20 * MIN) })] })
    t.f.db.failRelease = (id) => (id.startsWith("D") ? { message: "REFUND_FAILED: account gone" } : null)
    const r = await t.run()
    expect(t.f.db.refunds).toEqual([{ messageId: "GOOD", credits: 2 }])
    expect(r.reservesReleased).toBe(1)
    expect(t.alert).toHaveBeenCalledTimes(1)
    const calls = () => t.f.db.rpcCalls.filter((c) => c.name === "ttb_release_reserve" && String(c.args.p_message_id).startsWith("D")).length
    expect(calls()).toBe(25)
    // Same day, later runs: no RPC for the dead ones, no second alert.
    await t.run(shopOn, new Date(now.getTime() + MIN))
    await t.run(shopOn, new Date(now.getTime() + 2 * MIN))
    expect(calls()).toBe(25)
    expect(t.alert).toHaveBeenCalledTimes(1)
    // The next day they are tried once more.
    await t.run(shopOn, new Date(now.getTime() + 25 * HOUR))
    expect(calls()).toBe(50)
  })

  it("reserves whose order link is still open do not crowd newer releasable reserves out of the read", async () => {
    const n = 120
    const links = Array.from({ length: n }, (_, i) => link({ id: `OL${i}`, order_id: `OO${i}`, sender: `02000${String(i).padStart(5, "0")}`, state: "paid", paid_at: iso(-10 * MIN), created_at: iso(-40 * MIN) }))
    const orders = Array.from({ length: n }, (_, i) => order({ id: `OO${i}`, payment_status: "completed", order_status: "processing" }))
    const msgs = links.map((l, i) => inboundOf(`OM${i}`, `OL${i}`, { sender: l.sender }))
    const reserves = links.map((_, i) => reserve(`OM${i}`, { created_at: iso(-60 * MIN - (n - i) * 1000) }))
    const t = setup(links, orders, { ttb_messages: msgs, ttb_credit_reserves: [...reserves, reserve("GOOD", { created_at: iso(-20 * MIN) })] })
    await t.run()
    expect(t.f.db.refunds).toEqual([{ messageId: "GOOD", credits: 2 }])
  })

  it("a reserve older than the give-up age is no longer retried", async () => {
    const t = setup([], [], { ttb_credit_reserves: [reserve("ANCIENT", { created_at: iso(-10 * 24 * HOUR) })] })
    await t.run()
    expect(t.f.db.rpcCalls.filter((c) => c.name === "ttb_release_reserve")).toEqual([])
  })
})

describe("per-line recovery sweep and quiet alert", () => {
  const stranded = (id: string, line: string) => ({
    id, line, sender: S, direction: "in", body: "1gb", received_at: null, outcome: null, created_at: iso(-5 * MIN),
  })

  it("a stranded shop text is re-run with the shop line when only the shop switch is on", async () => {
    const t = setup([], [], { ttb_messages: [stranded("X1", "shop")] })
    const r = await t.run(shopOn)
    expect(t.processInbound).toHaveBeenCalledTimes(1)
    expect(t.processInbound.mock.calls[0][1]).toBe("X1")
    expect(t.processInbound.mock.calls[0][2]).toMatchObject({ line: "shop", from: S })
    expect(r.recovered).toBe(1)
  })

  it("a stranded shop text is left alone when the shop switch is off", async () => {
    const t = setup([], [], { ttb_messages: [stranded("X1", "shop")] })
    await t.run(mainOn)
    expect(t.processInbound).not.toHaveBeenCalled()
  })

  it("main-off / shop-on leaves a stranded main text alone, and the reverse", async () => {
    const t = setup([], [], { ttb_messages: [stranded("XM", "main"), stranded("XS", "shop")] })
    await t.run(shopOn)
    expect(t.processInbound.mock.calls.map((c) => c[1])).toEqual(["XS"])
    const u = setup([], [], { ttb_messages: [stranded("XM", "main"), stranded("XS", "shop")] })
    await u.run(mainOn)
    expect(u.processInbound.mock.calls.map((c) => c[1])).toEqual(["XM"])
  })

  it("both on: both lines are recovered", async () => {
    const t = setup([], [], { ttb_messages: [stranded("XM", "main"), stranded("XS", "shop")] })
    await t.run(bothOn)
    expect(t.processInbound.mock.calls.map((c) => c[1]).sort()).toEqual(["XM", "XS"])
  })

  it("quiet alert: one per enabled line with its own marker", async () => {
    const t = setup([], [], { ttb_heartbeat: [] })
    const r = await t.run(bothOn)
    expect(r.quietAlert).toBe(true)
    expect(t.alert).toHaveBeenCalledTimes(2)
    const markers = t.f.db.tables.ttb_heartbeat.map((h) => h.line).sort()
    expect(markers).toEqual(["purge", "quiet_alert", "quiet_alert_shop"])
    // Both again a minute later: throttled per marker.
    await t.run(bothOn, new Date(now.getTime() + MIN))
    expect(t.alert).toHaveBeenCalledTimes(2)
  })

  it("quiet alert: shop only uses the shop marker and the shop heartbeat; main stays silent", async () => {
    const t = setup([], [], { ttb_heartbeat: [{ line: "main", last_seen_at: iso(-24 * HOUR) }] })
    await t.run(shopOn)
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_heartbeat.map((h) => h.line).sort()).toEqual(["main", "purge", "quiet_alert_shop"])
  })

  it("a recently seen shop phone raises no shop alert", async () => {
    const t = setup([], [], { ttb_heartbeat: [{ line: "shop", last_seen_at: iso(-1 * MIN) }] })
    const r = await t.run(shopOn)
    expect(r.quietAlert).toBe(false)
    expect(t.alert).not.toHaveBeenCalled()
  })
})
