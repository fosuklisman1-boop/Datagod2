// app/api/cron/expire-stale-bot-orders/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  client: { tag: "db" } as any,
  sweepResult: null as any,
  sweep: vi.fn(),
  watch: vi.fn(),
  notify: vi.fn(),
  order: [] as string[],
  afterTasks: [] as Array<() => Promise<void>>,
  cont: vi.fn(),
}))

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => { h.order.push("after"); h.afterTasks.push(fn) },
}))
vi.mock("@/lib/standard-bundles/runtime", () => ({ getBundlesRuntime: () => ({ deps: { tag: "deps" }, db: { tag: "bdb" } }) }))
vi.mock("@/lib/standard-bundles/special-continue", () => ({
  buildSpecialContinueDeps: (db: any, deps: any) => ({ db, deps }),
  continueSpecialGroups: async (d: any, startedAt: number) => h.cont(d, startedAt),
}))

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/bot-commission/stale-sweep", () => ({
  expireStaleBotOrders: async (db: any) => { h.order.push("sweep"); h.sweep(db); return h.sweepResult },
}))
vi.mock("@/lib/standard-bundles/special-watch", () => ({
  watchStuckSpecialGroups: async (db: any, deps: any) => { h.order.push("watch"); return h.watch(db, deps) },
}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins: (...a: any[]) => h.notify(...a) }))

import { GET } from "./route"

const req = () => new NextRequest("https://x/api/cron/expire-stale-bot-orders")
const counts = { found: 1, failed: 1, payments: 0 }

beforeEach(() => {
  h.sweep.mockReset(); h.watch.mockReset(); h.notify.mockReset(); h.order = []
  h.afterTasks = []; h.cont.mockReset(); h.cont.mockResolvedValue({ groups: 0, units: 0, skippedLedger: 0 })
  h.sweepResult = { cutoff: "2026-10-30T11:30:00.000Z", tables: { hubtel_bill_orders: counts, hubtel_data_orders: counts }, errors: 0 }
  h.watch.mockResolvedValue({ skipped: false, groups: 0, alerted: 0 })
})

describe("expire-stale-bot-orders cron", () => {
  it("runs the sweep exactly as before (same client), then the read-only Special watch", async () => {
    const res = await GET(req())
    expect(h.sweep).toHaveBeenCalledWith(h.client)
    expect(h.order).toEqual(["sweep", "watch", "after"])
    expect(h.watch.mock.calls[0][0]).toBe(h.client)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, ...h.sweepResult })
  })

  it("sweep errors still give 500 (status follows the sweep only)", async () => {
    h.sweepResult = { ...h.sweepResult, errors: 2 }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ ok: false, errors: 2 })
  })

  it("a failing Special watch never changes the sweep's response", async () => {
    h.watch.mockRejectedValue(new Error("db down"))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, ...h.sweepResult })
  })

  it("schedules the Special continuation in after() on the bundle runtime, from the request's start time", async () => {
    const before = Date.now()
    await GET(req())
    expect(h.cont).not.toHaveBeenCalled() // nothing runs before the response
    expect(h.afterTasks).toHaveLength(1)
    await h.afterTasks[0]()
    expect(h.cont).toHaveBeenCalledTimes(1)
    expect(h.cont.mock.calls[0][0]).toEqual({ db: { tag: "bdb" }, deps: { tag: "deps" } })
    expect(h.cont.mock.calls[0][1]).toBeGreaterThanOrEqual(before)
  })

  it("a failing continuation never throws out of after() and sends no alert of its own", async () => {
    h.cont.mockRejectedValue(new Error("db down"))
    await GET(req())
    await expect(h.afterTasks[0]()).resolves.toBeUndefined()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it("the watch's alert is URGENT: notifyAdmins with email fallback kept (4th arg false)", async () => {
    await GET(req())
    const deps = h.watch.mock.calls[0][1]
    await deps.alert("Special group g: 2 paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles")
    expect(h.notify).toHaveBeenCalledWith(
      "Special group g: 2 paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles", "bills_review", undefined, false,
    )
  })
})
