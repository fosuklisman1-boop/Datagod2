import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { classifyOrder, runTtbNotify } from "./notify"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import { deliveredGiftReply, paidNotDeliveredReply, repricedReply, unpaidReply } from "./replies"

const S = "0200000101"
const now = new Date("2026-11-13T10:00:00Z") // 10:00 in Africa/Accra (UTC+0)
const MIN = 60_000
const HOUR = 60 * MIN
const iso = (ms: number) => new Date(now.getTime() + ms).toISOString()
const on: TtbSettings = { ...TTB_DEFAULTS, mainEnabled: true, source: "db" }

type Seed = Record<string, Record<string, unknown>[]>
function setup(links: Record<string, unknown>[], orders: Record<string, unknown>[], extra: Seed = {}) {
  const f = makeFakeTtb({ ttb_orders: links, ussd_orders: orders, ...extra })
  const reply = vi.fn(async () => ({ sent: true }))
  const alert = vi.fn(async () => {})
  const processInbound = vi.fn(async () => ({ outcome: "prompted" as const, readBy: null, reply: null }))
  const db = f.client as unknown as SupabaseClient
  f.db.rpcImpl = () => ({ data: 0, error: null })
  const run = (at = now, settings = on) => runTtbNotify(db, at, settings, { reply, alert, processInbound } as never)
  return { f, db, reply, alert, processInbound, run }
}
const link = (o: Record<string, unknown> = {}) => ({
  id: "L1", line: "main", sender: S, order_id: "O1", state: "awaiting_payment", size: "1GB", recipient: S, gift: false,
  amount: 5, notices: [], created_at: iso(-1 * MIN), paid_at: null, delivered_at: null, closed_at: null, ...o,
})
const order = (o: Record<string, unknown> = {}) => ({ id: "O1", order_status: "pending", payment_status: "pending", amount: 5, ...o })
const bodies = (reply: ReturnType<typeof vi.fn>) => reply.mock.calls.map((c) => (c[1] as { body: string }).body)

describe("classifyOrder (the real ussd_orders vocabulary)", () => {
  const k = (paymentStatus: string, orderStatus: string) => classifyOrder({ paymentStatus, orderStatus })
  it("waiting for payment", () => {
    expect(k("pending", "pending")).toBe("waiting")
    expect(k("otp_required", "pending")).toBe("waiting")
  })
  it("payment failed or lapsed", () => {
    expect(k("failed", "failed")).toBe("payment_failed")
    expect(k("expired", "expired")).toBe("payment_failed")
    expect(k("abandoned", "pending")).toBe("payment_failed")
    expect(k("pending", "failed")).toBe("payment_failed")
    expect(k("otp_required", "expired")).toBe("payment_failed")
  })
  it("paid and still in progress", () => {
    for (const o of ["pending", "processing", "held_registration", "something_new"]) expect(k("completed", o)).toBe("paid")
  })
  it("delivered", () => expect(k("completed", "completed")).toBe("delivered"))
  it("paid but delivery failed or reversed", () => {
    for (const o of ["failed", "reversed"]) expect(k("completed", o)).toBe("delivery_failed")
  })
  it("refunded or refunding is its own kind, checked before delivery_failed", () => {
    expect(k("completed", "refunding")).toBe("refunded")
    expect(k("completed", "refunded")).toBe("refunded")
    expect(k("refunded", "refunded")).toBe("refunded")
    expect(k("refunded", "failed")).toBe("refunded")
    expect(k("refunded", "pending")).toBe("refunded")
  })
  it("any unknown value is still processing, never a failure notice", () => {
    expect(k("weird", "pending")).toBe("waiting")
    expect(k("", "")).toBe("waiting")
    expect(k("completed", "weird")).toBe("paid")
  })
})

describe("unpaid", () => {
  it("pending inside the prompt window: nothing", async () => {
    const t = setup([link({ created_at: iso(-4 * MIN) })], [order()])
    const r = await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("awaiting_payment")
    expect(r).toMatchObject({ checked: 1, unpaid: 0 })
  })
  it("pending past the window: sends unpaid once, stays open until 30 minutes", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order({ payment_status: "otp_required" })])
    const r = await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "awaiting_payment", notices: ["unpaid"] })
    expect(r.unpaid).toBe(1)
    await t.run(new Date(now.getTime() + MIN))
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
  it("closes at 30 minutes, with the notice sent once", async () => {
    const t = setup([link({ created_at: iso(-31 * MIN), notices: ["unpaid"] })], [order()])
    const r = await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", closed_at: now.toISOString() })
    expect(r.closed).toBe(1)
  })
  it("payment failed: unpaid immediately, then closed", async () => {
    const t = setup([link({ created_at: iso(-1 * MIN) })], [order({ payment_status: "failed", order_status: "failed" })])
    await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", notices: ["unpaid"] })
  })
  it("two overlapping runs send one unpaid", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    await Promise.all([t.run(), t.run()])
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
  it("a send failure leaves the notice recorded, does not throw and is not retried", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.reply.mockResolvedValue({ sent: false } as never)
    await expect(t.run()).resolves.toBeDefined()
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["unpaid"])
    await t.run(new Date(now.getTime() + MIN))
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
  it("a send that throws does not throw out of the run", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.reply.mockRejectedValue(new Error("x") as never)
    await expect(t.run()).resolves.toBeDefined()
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["unpaid"])
  })
})

describe("paid", () => {
  it("payment completed: link becomes paid with paid_at, order still in progress: no SMS yet", async () => {
    const t = setup([link()], [order({ payment_status: "completed", order_status: "processing" })])
    await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "paid", paid_at: now.toISOString(), delivered_at: null })
    expect(t.reply).not.toHaveBeenCalled()
  })
  it("delivered gift: delivered notice, delivered_at, closed, paid_at kept", async () => {
    const t = setup([link({ gift: true, recipient: "0200000150", state: "paid", paid_at: iso(-5 * MIN) })], [order({ payment_status: "completed", order_status: "completed" })])
    const r = await t.run()
    expect(bodies(t.reply)).toEqual([deliveredGiftReply("1GB", "0200000150")])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", notices: ["delivered"], paid_at: iso(-5 * MIN), delivered_at: now.toISOString(), closed_at: now.toISOString() })
    expect(r.delivered).toBe(1)
  })
  it("delivered, own number: closed with delivered_at, no SMS", async () => {
    const t = setup([link({ state: "paid", paid_at: iso(-5 * MIN) })], [order({ payment_status: "completed", order_status: "completed" })])
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", delivered_at: now.toISOString() })
  })
  it("awaiting link whose order is already delivered goes paid then delivered in one run", async () => {
    const t = setup([link({ gift: true, recipient: "0200000150" })], [order({ payment_status: "completed", order_status: "completed" })])
    await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: now.toISOString(), delivered_at: now.toISOString() })
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
  it("delivery failed or reversed: one delay notice, link stays open", async () => {
    for (const s of ["failed", "reversed"]) {
      const t = setup([link({ state: "paid", paid_at: iso(-2 * MIN) })], [order({ payment_status: "completed", order_status: s })])
      const r = await t.run()
      expect(bodies(t.reply)).toEqual([paidNotDeliveredReply()])
      expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "paid", notices: ["paid_not_delivered"] })
      expect(r.delayed).toBe(1)
      await t.run(new Date(now.getTime() + MIN))
      expect(t.reply).toHaveBeenCalledTimes(1)
    }
  })
  it("still not completed 30 minutes after payment: delay notice; before that nothing", async () => {
    const early = setup([link({ state: "paid", paid_at: iso(-29 * MIN) })], [order({ payment_status: "completed", order_status: "processing" })])
    await early.run()
    expect(early.reply).not.toHaveBeenCalled()
    const late = setup([link({ state: "paid", paid_at: iso(-30 * MIN) })], [order({ payment_status: "completed", order_status: "processing" })])
    await late.run()
    expect(bodies(late.reply)).toEqual([paidNotDeliveredReply()])
  })
  it("after a delay notice the order completes: gift gets delivered, then closes", async () => {
    const t = setup([link({ gift: true, recipient: "0200000150", state: "paid", paid_at: iso(-40 * MIN), notices: ["paid_not_delivered"] })], [order({ payment_status: "completed", order_status: "completed" })])
    await t.run()
    expect(bodies(t.reply)).toEqual([deliveredGiftReply("1GB", "0200000150")])
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
  })
  it("a paid order that never completes closes after 48 hours", async () => {
    const t = setup([link({ state: "paid", paid_at: iso(-48 * HOUR), notices: ["paid_not_delivered"] })], [order({ payment_status: "completed", order_status: "failed" })])
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(r.closed).toBe(1)
    const open = setup([link({ state: "paid", paid_at: iso(-47 * HOUR), notices: ["paid_not_delivered"] })], [order({ payment_status: "completed", order_status: "failed" })])
    await open.run()
    expect(open.f.db.tables.ttb_orders[0].state).toBe("paid")
  })
  it("late approval after 'unpaid' was sent: link becomes paid, then a gift gets delivered", async () => {
    const t = setup([link({ gift: true, recipient: "0200000150", created_at: iso(-20 * MIN), notices: ["unpaid"] })], [order({ payment_status: "completed", order_status: "completed" })])
    await t.run()
    expect(bodies(t.reply)).toEqual([deliveredGiftReply("1GB", "0200000150")])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: now.toISOString(), notices: ["unpaid", "delivered"] })
  })
  it("late approval after the link closed (within 48 h): becomes paid and continues", async () => {
    const t = setup([link({ state: "closed", closed_at: iso(-10 * HOUR), created_at: iso(-11 * HOUR), notices: ["unpaid"] })], [order({ payment_status: "completed", order_status: "processing" })])
    await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "paid", paid_at: now.toISOString() })
  })
  it("a closed link whose order is still unpaid is left alone, and one closed over 48 h ago is not even read", async () => {
    const t = setup([link({ state: "closed", closed_at: iso(-10 * HOUR), notices: ["unpaid"] })], [order()])
    await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: null })
    expect(t.reply).not.toHaveBeenCalled()
    const old = setup([link({ state: "closed", closed_at: iso(-49 * HOUR) })], [order({ payment_status: "completed", order_status: "completed" })])
    await old.run()
    expect(old.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: null })
  })
})

describe("paid orders never get an unpaid notice", () => {
  it("past the prompt window, order paid and still in progress: no SMS, link becomes paid with paid_at", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order({ payment_status: "completed", order_status: "processing" })])
    const r = await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "paid", paid_at: now.toISOString(), notices: [] })
    expect(r.unpaid).toBe(0)
  })
  it("mirror: same age, order still pending: exactly one unpaid SMS", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
  })
})

describe("refunded orders", () => {
  for (const [label, notices] of [["no prior delay notice", []], ["after a delay notice", ["paid_not_delivered"]]] as const) {
    for (const [pay, ord] of [["completed", "refunding"], ["completed", "refunded"], ["refunded", "refunded"]] as const) {
      it(`${pay}/${ord}, ${label}: no SMS, paid_at set, link closed`, async () => {
        const t = setup([link({ state: "paid", paid_at: null, notices: [...notices] })], [order({ payment_status: pay, order_status: ord })])
        const r = await t.run()
        expect(t.reply).not.toHaveBeenCalled()
        expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: now.toISOString(), closed_at: now.toISOString(), notices })
        expect(r).toMatchObject({ closed: 1, delayed: 0 })
      })
    }
  }
  it("an awaiting link whose order is refunded keeps an earlier paid_at and sends nothing", async () => {
    const t = setup([link({ created_at: iso(-20 * MIN), paid_at: iso(-10 * MIN) })], [order({ payment_status: "completed", order_status: "refunded" })])
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", paid_at: iso(-10 * MIN) })
  })
})

describe("counting real sends", () => {
  it("a skipped send (SMS off globally) records the notice, counts skipped, not unpaid", async () => {
    // A global SMS-off period drops follow-up notices: the notice stays recorded and is not retried.
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.reply.mockResolvedValue({ sent: false, skipped: true } as never)
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["unpaid"])
    expect(r).toMatchObject({ unpaid: 0, skipped: 1 })
  })
  it("a failed send (not skipped) counts as neither", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.reply.mockResolvedValue({ sent: false } as never)
    expect(await t.run()).toMatchObject({ unpaid: 0, skipped: 0 })
  })
  it("delivered, delayed and repriced count only on sent", async () => {
    const a = setup([link({ gift: true, recipient: "0200000150", state: "paid", paid_at: iso(-5 * MIN) })], [order({ payment_status: "completed", order_status: "completed" })])
    a.reply.mockResolvedValue({ sent: false, skipped: true } as never)
    expect(await a.run()).toMatchObject({ delivered: 0, skipped: 1 })
    const b = setup([link({ state: "paid", paid_at: iso(-2 * MIN) })], [order({ payment_status: "completed", order_status: "failed" })])
    b.reply.mockResolvedValue({ sent: false, skipped: true } as never)
    expect(await b.run()).toMatchObject({ delayed: 0, skipped: 1 })
    const c = setup([link()], [order({ amount: 5.5 })])
    c.reply.mockResolvedValue({ sent: false, skipped: true } as never)
    expect(await c.run()).toMatchObject({ repriced: 0, skipped: 1 })
  })
})

describe("missing order and repricing", () => {
  it("a repriced notice already sent does not hold back the unpaid notice later", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN), notices: ["repriced"] })], [order({ amount: 5.5 })])
    await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
  })
  it("no repriced notice once the prompt has expired (30 minutes); the unpaid notice goes out instead", async () => {
    const t = setup([link({ created_at: iso(-31 * MIN) })], [order({ amount: 5.5 })])
    await t.run()
    expect(bodies(t.reply)).toEqual([unpaidReply("1GB")])
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["unpaid"])
  })
  it("ussd_orders row missing: link closed", async () => {
    const t = setup([link()], [])
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(r.closed).toBe(1)
  })
  it("amount differs from the link while still waiting: one corrective notice, from the order's amount", async () => {
    const t = setup([link()], [order({ amount: 5.5 })])
    await t.run()
    expect(bodies(t.reply)).toEqual([repricedReply(5.5)])
    expect(t.f.db.tables.ttb_orders[0].notices).toEqual(["repriced"])
    await t.run(new Date(now.getTime() + MIN))
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
  it("a difference under half a pesewa is not a reprice, and a paid order is not repriced", async () => {
    const a = setup([link()], [order({ amount: 5.004 })])
    await a.run()
    expect(a.reply).not.toHaveBeenCalled()
    const b = setup([link()], [order({ amount: 6, payment_status: "completed", order_status: "processing" })])
    await b.run()
    expect(b.reply).not.toHaveBeenCalled()
  })
})

describe("recovery sweep", () => {
  const msg = (id: string, ageMs: number, extra: Record<string, unknown> = {}) =>
    ({ id, line: "main", sender: S, direction: "in", body: "1GB", received_at: iso(-ageMs), outcome: null, created_at: iso(-ageMs), ...extra })
  it("processes a stranded row once, with the row's own input", async () => {
    const t = setup([], [], { ttb_messages: [msg("m1", 5 * MIN)] })
    const r = await t.run()
    expect(t.processInbound).toHaveBeenCalledTimes(1)
    const [, id, input, settings] = t.processInbound.mock.calls[0] as unknown as [unknown, string, Record<string, unknown>, TtbSettings]
    expect(id).toBe("m1")
    expect(input).toEqual({ line: "main", from: S, text: "1GB", receivedAt: new Date(iso(-5 * MIN)), now })
    expect(settings).toBe(on)
    expect(r.recovered).toBe(1)
  })
  it("recovered counts only rows processInbound actually handled, not a lost claim", async () => {
    const t = setup([], [], { ttb_messages: [msg("a", 6 * MIN), msg("b", 5 * MIN)] })
    t.processInbound.mockResolvedValueOnce({ outcome: "duplicate", readBy: null, reply: null } as never)
    const r = await t.run()
    expect(t.processInbound).toHaveBeenCalledTimes(2)
    expect(r.recovered).toBe(1)
  })
  it("skips fresh rows, finished rows, outbound rows and rows older than 15 minutes", async () => {
    const t = setup([], [], { ttb_messages: [msg("fresh", 60_000), msg("done", 5 * MIN, { outcome: "prompted" }), msg("out", 5 * MIN, { direction: "out" }), msg("old", 16 * MIN)] })
    await t.run()
    expect(t.processInbound).not.toHaveBeenCalled()
  })
  it("never runs while the feature is off", async () => {
    const t = setup([], [], { ttb_messages: [msg("m1", 5 * MIN)] })
    await t.run(now, { ...on, mainEnabled: false })
    expect(t.processInbound).not.toHaveBeenCalled()
  })
  it("handles at most 20 per run", async () => {
    const t = setup([], [], { ttb_messages: Array.from({ length: 25 }, (_, i) => msg(`m${i}`, 5 * MIN + i)) })
    await t.run()
    expect(t.processInbound).toHaveBeenCalledTimes(20)
  })
  it("stops the sweep after its 30 s budget: with 12 s per text only 3 of 5 are processed, the rest wait for the next run", async () => {
    const t = setup([], [], { ttb_messages: Array.from({ length: 5 }, (_, i) => msg(`m${i}`, 5 * MIN + i)) })
    let elapsed = 0
    t.processInbound.mockImplementation((async () => {
      elapsed += 12_000
      return { outcome: "prompted", readBy: null, reply: null }
    }) as never)
    const r = await runTtbNotify(t.db, now, on, { reply: t.reply, alert: t.alert, processInbound: t.processInbound, clock: () => elapsed } as never)
    expect(t.processInbound).toHaveBeenCalledTimes(3)
    expect(r.recovered).toBe(3)
  })
  it("a failing processInbound does not stop the other rows or the rest of the run", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()], { ttb_messages: [msg("a", 6 * MIN), msg("b", 5 * MIN)] })
    t.processInbound.mockRejectedValueOnce(new Error("x") as never)
    await t.run()
    expect(t.processInbound).toHaveBeenCalledTimes(2)
    expect(t.reply).toHaveBeenCalledTimes(1)
  })
})

describe("retention purge", () => {
  it("calls ttb_purge with now minus retentionDays, and not again within the hour", async () => {
    const t = setup([], [])
    t.f.db.rpcImpl = () => ({ data: 4, error: null })
    const r = await t.run()
    expect(t.f.db.rpcCalls).toEqual([{ name: "ttb_purge", args: { p_before: iso(-30 * 24 * HOUR) } }])
    expect(r.purged).toBe(4)
    await t.run(new Date(now.getTime() + 59 * MIN))
    expect(t.f.db.rpcCalls).toHaveLength(1)
    await t.run(new Date(now.getTime() + 61 * MIN))
    expect(t.f.db.rpcCalls).toHaveLength(2)
  })
  it("a failing purge does not break the run", async () => {
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    t.f.db.rpcImpl = () => ({ data: null, error: { message: "x" } })
    await expect(t.run()).resolves.toMatchObject({ purged: 0, unpaid: 1 })
  })
})

describe("quiet-phone alert", () => {
  const hb = (ageMin: number, at = now) => ({ ttb_heartbeat: [{ line: "main", last_seen_at: new Date(at.getTime() - ageMin * MIN).toISOString() }] })
  it("fires at 61 minutes silent at 10:00 Accra, with no numbers or texts in it", async () => {
    const t = setup([], [], hb(61))
    const r = await t.run()
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(String((t.alert.mock.calls[0] as unknown as [string])[0])).toBe("Text-to-Buy: the forwarder phone has been quiet for 61 minutes")
    expect(r.quietAlert).toBe(true)
  })
  it("does not fire at 60 minutes or less", async () => {
    const t = setup([], [], hb(60))
    await t.run()
    expect(t.alert).not.toHaveBeenCalled()
  })
  it("does not fire at 02:00 or 22:00 Accra, but does at 07:00 and 21:59", async () => {
    for (const [h, m, fires] of [[2, 0, false], [22, 0, false], [6, 59, false], [7, 0, true], [21, 59, true]] as const) {
      const at = new Date(Date.UTC(2026, 10, 13, h, m))
      const t = setup([], [], hb(120, at))
      await t.run(at)
      expect(t.alert).toHaveBeenCalledTimes(fires ? 1 : 0)
    }
  })
  it("not twice within 6 hours, again after", async () => {
    const t = setup([], [], hb(61))
    await t.run()
    await t.run(new Date(now.getTime() + 5 * HOUR))
    expect(t.alert).toHaveBeenCalledTimes(1)
    await t.run(new Date(now.getTime() + 6 * HOUR + MIN))
    expect(t.alert).toHaveBeenCalledTimes(2)
  })
  it("never when the feature is off", async () => {
    const t = setup([], [], hb(500))
    await t.run(now, { ...on, mainEnabled: false })
    expect(t.alert).not.toHaveBeenCalled()
  })
  it("a heartbeat that never existed counts as quiet", async () => {
    const t = setup([], [])
    await t.run()
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
  it("a failing alert does not break the run and is recorded so it does not spam", async () => {
    const t = setup([], [], hb(61))
    t.alert.mockRejectedValue(new Error("x") as never)
    await expect(t.run()).resolves.toBeDefined()
    await t.run(new Date(now.getTime() + MIN))
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("run result and logging", () => {
  it("never logs a phone number, text or amount", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const t = setup([link({ created_at: iso(-6 * MIN) })], [order()])
    await t.run()
    const all = JSON.stringify([...spy.mock.calls, ...err.mock.calls])
    expect(all).not.toContain(S)
    spy.mockRestore()
    err.mockRestore()
  })
})
