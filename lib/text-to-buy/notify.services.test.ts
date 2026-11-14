import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { makeFakeTtb } from "./fake-db.test-helper"
import { runTtbNotify } from "./notify"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"
import { orderRowFor } from "./store"
import { dataAdapter } from "./services/data"
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
    })
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
