import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { runTtbNotify } from "./notify"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import { orderRowFor } from "./store"
import { dataAdapter } from "./services/data"
import { airtimeAdapter } from "./services/airtime"
import { resultsCheckerAdapter } from "./services/results-checker"
import { airtimeGiftDeliveredReply, delayedReply, repricedReply, unpaidReply } from "./replies"
import { calculateSegments } from "@/lib/sms/segments"
import { classifyStatusOrder } from "./services/classify"
import type { Adapters } from "./services"
import type { ServiceAdapter } from "./services/types"

const S = "0200000101"
const now = new Date("2026-11-13T10:00:00Z")
const MIN = 60_000
const iso = (ms: number) => new Date(now.getTime() + ms).toISOString()
const on: TtbSettings = { ...TTB_DEFAULTS, mainEnabled: true, source: "db" }

const link = (o: Record<string, unknown> = {}) => ({
  id: "L1", line: "main", sender: S, service: "data", order_table: "ussd_orders", order_id: "O1", state: "awaiting_payment", size: "1GB", recipient: S,
  gift: false, amount: 5, notices: [], created_at: iso(-1 * MIN), paid_at: null, delivered_at: null, closed_at: null, ...o,
})
const ussd = (o: Record<string, unknown> = {}) => ({ id: "O1", order_status: "pending", payment_status: "pending", amount: 5, ...o })

function setup(links: Record<string, unknown>[], seed: Record<string, Record<string, unknown>[]> = {}, adapters?: Adapters) {
  // A fresh forwarder heartbeat keeps the unrelated quiet-phone alert out of the alert counts below.
  const f = makeFakeTtb({ ttb_orders: links, ttb_heartbeat: [{ line: "main", last_seen_at: iso(-1 * MIN) }], ...seed })
  f.db.rpcImpl = () => ({ data: 0, error: null })
  const reply = vi.fn(async (_db: unknown, _msg: { body: string }) => ({ sent: true }))
  const alert = vi.fn(async () => {})
  const processInbound = vi.fn(async () => ({ outcome: "prompted" as const, readBy: null, reply: null }))
  const run = () => runTtbNotify(f.client as unknown as SupabaseClient, now, on, { reply, alert, processInbound, ...(adapters ? { adapters } : {}) } as never)
  return { f, reply, alert, run }
}

describe("a link whose (service, order table) pair is not known", () => {
  it("stays open and raises one admin alert that names the link id only", async () => {
    // The order exists in ussd_orders and is failed: reading the wrong table would close the link without a word.
    const t = setup([link({ service: "airtime" })], { ussd_orders: [ussd({ payment_status: "failed", order_status: "failed" })] })
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "awaiting_payment", closed_at: null, notices: [] })
    expect(t.reply).not.toHaveBeenCalled()
    expect(r).toMatchObject({ checked: 1, closed: 0 })
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.alert).toHaveBeenCalledWith("Text-to-Buy: link with unknown order table: L1")
  })

  it("alerts once per run however many such links there are", async () => {
    const t = setup([link({ id: "L1", service: "airtime" }), link({ id: "L2", order_id: "O2", service: "airtime" }), link({ id: "L3", order_id: "O3", service: "nonsense" })])
    const r = await t.run()
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.f.db.tables.ttb_orders.map((l) => l.state)).toEqual(["awaiting_payment", "awaiting_payment", "awaiting_payment"])
    expect(r).toMatchObject({ checked: 3, closed: 0 })
  })

  it("a service with an unrecognised order table, and a recognised pair with no adapter registered, are treated the same", async () => {
    const t = setup([link({ order_table: "nonsense_orders" }), link({ id: "L2", order_id: "O2", service: "airtime", order_table: "airtime_orders" })], {
      airtime_orders: [{ id: "O2", status: "failed", payment_status: "failed", total_paid: 5 }],
    }, { airtime: undefined }) // the live registry now has an airtime adapter: take it out to leave a recognised pair with none
    const r = await t.run()
    expect(r.closed).toBe(0)
    expect(t.f.db.tables.ttb_orders.map((l) => l.state)).toEqual(["awaiting_payment", "awaiting_payment"])
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("an alert that fails does not stop the run or close the link", async () => {
    const t = setup([link({ service: "airtime" })])
    t.alert.mockRejectedValue(new Error("down"))
    const r = await t.run()
    expect(r.closed).toBe(0)
    expect(t.f.db.tables.ttb_orders[0].state).toBe("awaiting_payment")
  })
})

describe("data links keep their Stage 1 behaviour", () => {
  it("a data link whose ussd_orders row is missing still closes, with no alert", async () => {
    const t = setup([link()])
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(r.closed).toBe(1)
    expect(t.alert).not.toHaveBeenCalled()
  })
})

describe("airtime links through the live airtime adapter", () => {
  const R = "0200000102"
  const alink = (o: Record<string, unknown> = {}) => link({ service: "airtime", order_table: "airtime_orders", size: "airtime 10", amount: 10, ...o })
  const arow = (o: Record<string, unknown> = {}) => ({ id: "O1", status: "pending_payment", payment_status: "pending_payment", total_paid: 10, ...o })
  const bodies = (t: ReturnType<typeof setup>) => t.reply.mock.calls.map((c) => (c[1] as { body: string }).body)
  const paid = { state: "paid", paid_at: iso(-5 * MIN) }

  it("a completed gift sends the gift delivered notice", async () => {
    const t = setup([alink({ ...paid, gift: true, recipient: R, size: `airtime 10 ${R}` })], { airtime_orders: [arow({ status: "completed", payment_status: "completed" })] })
    const r = await t.run()
    expect(bodies(t)).toEqual([airtimeGiftDeliveredReply(`airtime 10 ${R}`, R)])
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", delivered_at: now.toISOString() })
    expect(r).toMatchObject({ delivered: 1, closed: 1 })
  })

  it("a completed own-number order closes without an SMS", async () => {
    const t = setup([alink(paid)], { airtime_orders: [arow({ status: "completed", payment_status: "completed" })] })
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
  })

  it("paid 30 minutes and not completed: the delay notice, never 'no need to pay again'", async () => {
    const t = setup([alink({ state: "paid", paid_at: iso(-31 * MIN) })], { airtime_orders: [arow({ status: "processing", payment_status: "completed" })] })
    const r = await t.run()
    expect(bodies(t)).toEqual([delayedReply()])
    expect(bodies(t).join(" ")).not.toContain("No need to pay again")
    expect(r.delayed).toBe(1)
  })

  it("failed after payment: the delay notice, sent once", async () => {
    const t = setup([alink(paid)], { airtime_orders: [arow({ status: "failed", payment_status: "completed" })] })
    await t.run()
    await t.run()
    expect(bodies(t)).toEqual([delayedReply()])
  })

  it("refunded: closed, no SMS, whatever the status column says", async () => {
    for (const row of [arow({ status: "refunded", payment_status: "refunded" }), arow({ status: "failed", payment_status: "refunded" }), arow({ status: "refunding", payment_status: "completed" })]) {
      const t = setup([alink(paid)], { airtime_orders: [row] })
      await t.run()
      expect(t.reply).not.toHaveBeenCalled()
      expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    }
  })

  it("a refunded order that was never marked paid on the link still gets no unpaid notice", async () => {
    const t = setup([alink()], { airtime_orders: [arow({ status: "failed", payment_status: "refunded" })] })
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
  })

  it("pending_payment past the prompt window: the unpaid notice with the re-text token", async () => {
    const t = setup([alink({ created_at: iso(-6 * MIN) })], { airtime_orders: [arow()] })
    const r = await t.run()
    expect(bodies(t)).toEqual([unpaidReply("airtime 10")])
    expect(r.unpaid).toBe(1)
  })

  it("a failed or abandoned payment: the unpaid notice and the link closes", async () => {
    for (const pay of ["failed", "abandoned", "cancelled"]) {
      const t = setup([alink()], { airtime_orders: [arow({ payment_status: pay, status: "pending_payment" })] })
      await t.run()
      expect(bodies(t)).toEqual([unpaidReply("airtime 10")])
      expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    }
  })

  it("a row amount that differs from the link's sends the price-changed notice once", async () => {
    const t = setup([alink()], { airtime_orders: [arow({ total_paid: 10.4 })] })
    const r = await t.run()
    expect(bodies(t)).toEqual([repricedReply(10.4)])
    expect(r.repriced).toBe(1)
  })

  it("every airtime notice is one GSM-7 segment", () => {
    const n = airtimeAdapter().notices
    for (const s of [n.unpaid("airtime 9999.99 " + R), n.paidNotDelivered(), n.delivered({ size: "airtime 9999.99 " + R, recipient: R, gift: true })!]) {
      const seg = calculateSegments(s)
      expect([seg.encoding, seg.segments]).toEqual(["gsm7", 1])
    }
  })
})

describe("voucher links through the live results-checker adapter", () => {
  const vlink = (o: Record<string, unknown> = {}) =>
    link({ service: "results_checker", order_table: "results_checker_orders", size: "2 wassce", amount: 30, ...o })
  const vrow = (o: Record<string, unknown> = {}) => ({ id: "O1", status: "pending_payment", payment_status: "pending_payment", total_paid: 30, ...o })
  const bodies = (t: ReturnType<typeof setup>) => t.reply.mock.calls.map((c) => (c[1] as { body: string }).body)
  const paid = { state: "paid", paid_at: iso(-5 * MIN) }

  it("a completed order closes with delivered_at and sends nothing: the PINs are the delivery message", async () => {
    const t = setup([vlink(paid)], { results_checker_orders: [vrow({ status: "completed", payment_status: "completed" })] })
    const r = await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", delivered_at: now.toISOString() })
    expect(r).toMatchObject({ closed: 1, delivered: 0 })
  })

  it("paid at 30 minutes with the status still pending (stock ran out): the delay notice", async () => {
    const t = setup([vlink({ state: "paid", paid_at: iso(-31 * MIN) })], { results_checker_orders: [vrow({ status: "pending", payment_status: "completed" })] })
    const r = await t.run()
    expect(bodies(t)).toEqual([delayedReply()])
    expect(r.delayed).toBe(1)
  })

  it("failed after payment: the delay notice, sent once", async () => {
    const t = setup([vlink(paid)], { results_checker_orders: [vrow({ status: "failed", payment_status: "completed" })] })
    await t.run()
    await t.run()
    expect(bodies(t)).toEqual([delayedReply()])
  })

  it("expired payment and expired status: the unpaid notice with the re-text token, and the link closes", async () => {
    const t = setup([vlink()], { results_checker_orders: [vrow({ status: "expired", payment_status: "expired" })] })
    await t.run()
    expect(bodies(t)).toEqual([unpaidReply("2 wassce")])
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
  })

  it("refunded, abandoned and cancelled orders: a refund is never told it was unpaid", async () => {
    for (const row of [vrow({ status: "failed", payment_status: "refunded" }), vrow({ status: "refunding", payment_status: "completed" }), vrow({ status: "refunded", payment_status: "refunded" })]) {
      const t = setup([vlink(paid)], { results_checker_orders: [row] })
      await t.run()
      expect(t.reply).not.toHaveBeenCalled()
      expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
    }
    // Never marked paid on the link: still no unpaid notice for a refund.
    const never = setup([vlink()], { results_checker_orders: [vrow({ status: "failed", payment_status: "refunded" })] })
    await never.run()
    expect(never.reply).not.toHaveBeenCalled()
    // A payment that was abandoned or cancelled is simply unpaid.
    for (const pay of ["abandoned", "cancelled"]) {
      const t = setup([vlink()], { results_checker_orders: [vrow({ status: "cancelled", payment_status: pay })] })
      await t.run()
      expect(bodies(t)).toEqual([unpaidReply("2 wassce")])
    }
  })

  it("an otp_required order left past the prompt window gets the unpaid notice, and is closed once the close age passes", async () => {
    // A text never sends an OTP SMS, so an order the handler parked as otp_required is a payment that cannot be approved.
    const t = setup([vlink({ created_at: iso(-6 * MIN) })], { results_checker_orders: [vrow({ status: "otp_required", payment_status: "otp_required" })] })
    const first = await t.run()
    expect(bodies(t)).toEqual([unpaidReply("2 wassce")])
    expect(first.unpaid).toBe(1)
    const old = setup([vlink({ created_at: iso(-60 * MIN) })], { results_checker_orders: [vrow({ status: "otp_required", payment_status: "otp_required" })] })
    await old.run()
    expect(old.f.db.tables.ttb_orders[0].state).toBe("closed")
    expect(bodies(old)).toEqual([unpaidReply("2 wassce")])
  })

  it("the row total differing from the link sends the price-changed notice once", async () => {
    const t = setup([vlink()], { results_checker_orders: [vrow({ total_paid: 30.6 })] })
    await t.run()
    expect(bodies(t)).toEqual([repricedReply(30.6)])
  })

  it("an airtime-table row with the same id is never read for a voucher link", async () => {
    const t = setup([vlink(paid)], {
      results_checker_orders: [vrow({ status: "processing", payment_status: "completed" })],
      airtime_orders: [{ id: "O1", status: "completed", payment_status: "completed", total_paid: 30 }],
    })
    await t.run()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("paid")
  })

  it("every voucher notice is one GSM-7 segment", () => {
    const n = resultsCheckerAdapter().notices
    for (const s of [n.unpaid("100 novdec"), n.paidNotDelivered()]) {
      const seg = calculateSegments(s)
      expect([seg.encoding, seg.segments]).toEqual(["gsm7", 1])
    }
  })
})

describe("dispatch by order table", () => {
  // No airtime code exists yet: this stand-in adapter reads the airtime_orders columns the way the real one will.
  const airtime = (): ServiceAdapter => ({
    ...(dataAdapter() as unknown as ServiceAdapter),
    service: "airtime",
    orderTable: "airtime_orders",
    readOrder: (db, id) => orderRowFor(db, "airtime_orders", id),
    classify: classifyStatusOrder,
    notices: { unpaid: () => "AIRTIME UNPAID", delivered: () => "AIRTIME DELIVERED", paidNotDelivered: () => "AIRTIME DELAYED" },
  })

  it("an airtime link whose order lives only in airtime_orders is read from that table", async () => {
    const t = setup(
      [link({ service: "airtime", order_table: "airtime_orders", state: "paid", paid_at: iso(-5 * MIN) })],
      { airtime_orders: [{ id: "O1", status: "completed", payment_status: "completed", total_paid: 5 }] },
      { airtime: airtime() },
    )
    const r = await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", delivered_at: now.toISOString() })
    expect(t.reply.mock.calls.map((c) => (c[1] as { body: string }).body)).toEqual(["AIRTIME DELIVERED"])
    expect(r).toMatchObject({ checked: 1, delivered: 1, closed: 1 })
    expect(t.alert).not.toHaveBeenCalled()
  })

  it("a failed payment in airtime_orders sends that service's unpaid notice and closes", async () => {
    const t = setup(
      [link({ service: "airtime", order_table: "airtime_orders" })],
      { airtime_orders: [{ id: "O1", status: "failed", payment_status: "failed", total_paid: 5 }] },
      { airtime: airtime() },
    )
    await t.run()
    expect(t.reply.mock.calls.map((c) => (c[1] as { body: string }).body)).toEqual(["AIRTIME UNPAID"])
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
  })

  it("a refunded airtime order never gets the unpaid notice", async () => {
    const t = setup(
      [link({ service: "airtime", order_table: "airtime_orders", state: "paid", paid_at: iso(-5 * MIN) })],
      { airtime_orders: [{ id: "O1", status: "failed", payment_status: "refunded", total_paid: 5 }] },
      { airtime: airtime() },
    )
    await t.run()
    expect(t.reply).not.toHaveBeenCalled()
    expect(t.f.db.tables.ttb_orders[0].state).toBe("closed")
  })

  it("a data link is still read from ussd_orders when other adapters are registered", async () => {
    const t = setup([link({ state: "paid", paid_at: iso(-5 * MIN) })], { ussd_orders: [ussd({ payment_status: "completed", order_status: "completed" })] }, { airtime: airtime() })
    await t.run()
    expect(t.f.db.tables.ttb_orders[0]).toMatchObject({ state: "closed", delivered_at: now.toISOString() })
  })
})
