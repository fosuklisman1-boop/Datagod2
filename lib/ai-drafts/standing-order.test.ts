import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const priceMock = vi.fn()
vi.mock("@/lib/pricing/wallet-order-price", () => ({
  walletOrderPrice: (...args: unknown[]) => priceMock(...args),
}))

import { runStandingOrder, standingOrderKey, uuidV5, STANDING_ORDER_NS, createStandingOrderTask } from "./standing-order"

type Row = Record<string, any>

function fakeDb(tables: Record<string, Row[]>) {
  const db = {
    tables,
    from(table: string) {
      if (!tables[table]) tables[table] = []
      const rows = tables[table]
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" | "insert" = "select"
      let patch: Row = {}
      let inserted: Row | null = null
      const run = () => {
        if (op === "insert") {
          rows.push(inserted!)
          return { data: [{ ...inserted! }], error: null as any }
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        return { data: matched.map((r) => ({ ...r })), error: null as any }
      }
      const b: any = {
        update(p: Row) { op = "update"; patch = p; return b },
        insert(p: Row) { op = "insert"; inserted = { id: `task-${rows.length + 1}`, ...p }; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        limit() { return b },
        single() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: x.data.length ? null : { message: "no row" } }) },
        maybeSingle() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return db as unknown as SupabaseClient & { tables: Record<string, Row[]> }
}

const USER = "11111111-1111-4111-8111-111111111111"
const PKG = "33333333-3333-4333-8333-333333333333"
const DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SLOT = "2026-11-21T08:00:00.000Z"

const params = {
  packageId: PKG, network: "MTN", size: "5GB", recipient: "0241234567", price: 20, balanceBefore: 100,
  schedule: { type: "daily", runAtTime: "08:00" },
}

function tables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    ai_drafts: [{ id: DRAFT, user_id: USER, action: "wallet_order", status: "succeeded", params }],
    ai_scheduled_tasks: [{ id: TASK, user_id: USER, is_active: true, consecutive_skips: 0 }],
    users: [{ id: USER, role: "user", is_suspended: false }],
    packages: [{ id: PKG, network: "MTN", size: "5GB", price: 20, dealer_price: 18, is_available: true }],
    wallets: [{ user_id: USER, balance: 100 }],
    ...over,
  }
}

const task = (over: Row = {}) => ({
  id: TASK,
  user_id: USER,
  next_run_at: SLOT,
  approved_draft_id: DRAFT,
  consecutive_skips: 0,
  schedule_type: "daily",
  run_at_time: "08:00",
  run_on_days: null,
  run_at_timestamp: null,
  standing_order: { package_id: PKG, network: "MTN", size: "5GB", recipient: "0241234567", max_price_ghs: 20 },
  ...over,
})

const res = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const ctx = (fetchImpl: any) => ({ baseUrl: "https://app.test", cronSecret: "cron-secret", fetchImpl })

beforeEach(() => {
  priceMock.mockReset()
  priceMock.mockResolvedValue(20)
})

describe("uuid v5", () => {
  it("uuid_v5_rfc_vector", () => {
    expect(uuidV5("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2")
  })
  it("standingOrderKey is deterministic per task+slot and differs across slots", () => {
    const a = standingOrderKey(TASK, SLOT)
    expect(a).toBe(uuidV5(`${TASK}:${SLOT}`, STANDING_ORDER_NS))
    expect(standingOrderKey(TASK, SLOT)).toBe(a)
    expect(standingOrderKey(TASK, "2026-11-22T08:00:00.000Z")).not.toBe(a)
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it("normalises a postgres-style timestamp to the same slot key", () => {
    expect(standingOrderKey(TASK, "2026-11-21T08:00:00+00:00")).toBe(standingOrderKey(TASK, SLOT))
  })
})

describe("runStandingOrder", () => {
  it("standing_order_double_fire_one_order", async () => {
    const db = fakeDb(tables())
    const f = vi.fn()
      .mockResolvedValueOnce(res(200, { success: true, order: { order_code: "ORD-1" } }))
      .mockResolvedValueOnce(res(200, { success: true, order: { order_code: "ORD-1" }, alreadyPlaced: true }))
    const a = await runStandingOrder(db, task(), ctx(f))
    const b = await runStandingOrder(db, task(), ctx(f))
    const keys = f.mock.calls.map((c) => JSON.parse(c[1].body).idempotencyKey)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toBe(standingOrderKey(TASK, SLOT))
    expect(a).toMatchObject({ result: "ordered", orderCode: "ORD-1" })
    expect(b.result).toBe("ordered")
  })

  it("already_placed_counts_as_success", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { success: true, order: { order_code: "ORD-9" }, alreadyPlaced: true }))
    const out = await runStandingOrder(fakeDb(tables()), task(), ctx(f))
    expect(out).toMatchObject({ result: "ordered", orderCode: "ORD-9" })
  })

  it("sends the cron secret path body with userId and the fresh package network", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { order: { order_code: "ORD-1" } }))
    await runStandingOrder(fakeDb(tables()), task(), ctx(f))
    const [url, init] = f.mock.calls[0]
    expect(url).toBe("https://app.test/api/orders/purchase")
    expect(init.headers.Authorization).toBe("Bearer cron-secret")
    expect(JSON.parse(init.body)).toMatchObject({ packageId: PKG, phoneNumber: "0241234567", network: "MTN", userId: USER })
  })

  it("standing_order_above_cap_skips_no_purchase", async () => {
    priceMock.mockResolvedValue(20.5)
    const f = vi.fn()
    const out = await runStandingOrder(fakeDb(tables()), task(), ctx(f))
    expect(out).toMatchObject({ result: "skipped", reason: "above_cap" })
    expect(f).not.toHaveBeenCalled()
  })

  it("skips when the package is unavailable or the balance is short", async () => {
    const f = vi.fn()
    const off = fakeDb(tables({ packages: [{ id: PKG, network: "MTN", size: "5GB", price: 20, dealer_price: 18, is_available: false }] }))
    expect(await runStandingOrder(off, task(), ctx(f))).toMatchObject({ result: "skipped", reason: "package_unavailable" })
    const poor = fakeDb(tables({ wallets: [{ user_id: USER, balance: 19.99 }] }))
    expect(await runStandingOrder(poor, task(), ctx(f))).toMatchObject({ result: "skipped", reason: "insufficient_balance" })
    expect(f).not.toHaveBeenCalled()
  })

  it("a 402 from the purchase is a skip, not a failure", async () => {
    const f = vi.fn().mockResolvedValue(res(402, { error: "Insufficient balance" }))
    expect(await runStandingOrder(fakeDb(tables()), task(), ctx(f))).toMatchObject({ result: "skipped", reason: "insufficient_balance" })
  })

  it("other non-2xx and unreachable are failures, with exactly one attempt", async () => {
    const f = vi.fn().mockResolvedValue(res(500, { error: "boom" }))
    expect(await runStandingOrder(fakeDb(tables()), task(), ctx(f))).toMatchObject({ result: "failed" })
    expect(f).toHaveBeenCalledTimes(1)
    const g = vi.fn().mockRejectedValue(new Error("net"))
    expect(await runStandingOrder(fakeDb(tables()), task(), ctx(g))).toMatchObject({ result: "failed" })
    expect(g).toHaveBeenCalledTimes(1)
  })

  it("re-prices with the current users.role", async () => {
    const db = fakeDb(tables({ users: [{ id: USER, role: "dealer", is_suspended: false }] }))
    await runStandingOrder(db, task(), ctx(vi.fn().mockResolvedValue(res(200, { order: {} }))))
    expect(priceMock.mock.calls[0][2]).toBe("dealer")
  })

  it("standing_order_mismatched_draft_pauses_no_purchase", async () => {
    const f = vi.fn()
    for (const bad of [
      task({ standing_order: { ...task().standing_order, recipient: "0249999999" } }),
      task({ standing_order: { ...task().standing_order, package_id: "44444444-4444-4444-8444-444444444444" } }),
      task({ standing_order: { ...task().standing_order, max_price_ghs: 500 } }),
    ]) {
      const db = fakeDb(tables())
      const out = await runStandingOrder(db, bad, ctx(f))
      expect(out).toMatchObject({ result: "paused", reason: "safety_check" })
      expect(db.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    }
    // Draft owned by someone else / not succeeded / not scheduled / wrong action.
    for (const draftOver of [{ user_id: "99999999-9999-4999-8999-999999999999" }, { status: "failed" }, { action: "wallet_adjustment" }, { params: { ...params, schedule: undefined } }]) {
      const db = fakeDb(tables({ ai_drafts: [{ id: DRAFT, user_id: USER, action: "wallet_order", status: "succeeded", params, ...draftOver }] }))
      expect(await runStandingOrder(db, task(), ctx(f))).toMatchObject({ result: "paused" })
      expect(db.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    }
    expect(f).not.toHaveBeenCalled()
  })

  it("standing_order_missing_draft_pauses", async () => {
    const f = vi.fn()
    const db = fakeDb(tables({ ai_drafts: [] }))
    expect(await runStandingOrder(db, task(), ctx(f))).toMatchObject({ result: "paused" })
    expect(db.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    const db2 = fakeDb(tables())
    expect(await runStandingOrder(db2, task({ approved_draft_id: null }), ctx(f))).toMatchObject({ result: "paused" })
    expect(f).not.toHaveBeenCalled()
  })

  it("suspended_user_standing_order_pauses", async () => {
    const f = vi.fn()
    const db = fakeDb(tables({ users: [{ id: USER, role: "user", is_suspended: true }] }))
    expect(await runStandingOrder(db, task(), ctx(f))).toMatchObject({ result: "paused", reason: "suspended" })
    expect(db.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    expect(f).not.toHaveBeenCalled()
  })

  it("standing_order_schedule_tampered_pauses", async () => {
    const f = vi.fn()
    const weekly = { type: "weekly", runAtTime: "08:00", runOnDays: [1, 3] }
    const once = { type: "once", runAtTimestamp: "2026-12-01T08:00:00.000Z" }
    const withSchedule = (schedule: unknown) =>
      tables({ ai_drafts: [{ id: DRAFT, user_id: USER, action: "wallet_order", status: "succeeded", params: { ...params, schedule } }] })
    const cases: Array<[Row, any]> = [
      [{ run_at_time: "09:00" }, undefined], // time changed
      [{ schedule_type: "weekly", run_on_days: [1, 3, 5] }, undefined], // type + days changed
      [{ run_at_timestamp: "2026-12-01T08:00:00.000Z" }, undefined], // timestamp added
      [{ schedule_type: "weekly", run_at_time: "08:00", run_on_days: [1, 3, 4] }, weekly], // days differ from a weekly draft
      [{ schedule_type: "once", run_at_time: null, run_at_timestamp: "2026-12-02T08:00:00.000Z" }, once], // timestamp differs
    ]
    for (const [over, sched] of cases) {
      const db = fakeDb(sched ? withSchedule(sched) : tables())
      expect(await runStandingOrder(db, task(over), ctx(f)), JSON.stringify(over)).toMatchObject({ result: "paused", reason: "safety_check" })
      expect(db.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    }
    expect(f).not.toHaveBeenCalled()
    // Matching schedules still run: day order is irrelevant and a postgres-style timestamp equals the ISO one.
    const g = vi.fn().mockResolvedValue(res(200, { order: { order_code: "O" } }))
    expect((await runStandingOrder(fakeDb(withSchedule(weekly)), task({ schedule_type: "weekly", run_on_days: [3, 1] }), ctx(g))).result).toBe("ordered")
    expect((await runStandingOrder(fakeDb(withSchedule(once)), task({ schedule_type: "once", run_at_time: null, run_at_timestamp: "2026-12-01T08:00:00+00:00" }), ctx(g))).result).toBe("ordered")
  })

  it("timeout_but_order_exists_is_success", async () => {
    const key = standingOrderKey(TASK, SLOT)
    const db = fakeDb(tables({ orders: [{ id: "o1", user_id: USER, idempotency_key: key, order_code: "ORD-55" }] }))
    const timeout = vi.fn().mockRejectedValue(new Error("aborted"))
    expect(await runStandingOrder(db, task(), ctx(timeout))).toMatchObject({ result: "ordered", orderCode: "ORD-55" })
    const fiveHundred = vi.fn().mockResolvedValue(res(500, { error: "boom" }))
    expect(await runStandingOrder(db, task(), ctx(fiveHundred))).toMatchObject({ result: "ordered", orderCode: "ORD-55" })
    expect(timeout).toHaveBeenCalledTimes(1)
  })

  it("timeout_and_no_order_is_failure", async () => {
    const other = { id: "o2", user_id: "99999999-9999-4999-8999-999999999999", idempotency_key: standingOrderKey(TASK, SLOT), order_code: "ORD-X" }
    const db = fakeDb(tables({ orders: [other, { id: "o3", user_id: USER, idempotency_key: "00000000-0000-5000-8000-000000000000" }] }))
    const timeout = vi.fn().mockRejectedValue(new Error("aborted"))
    expect(await runStandingOrder(db, task(), ctx(timeout))).toMatchObject({ result: "failed" })
    expect(await runStandingOrder(db, task(), ctx(vi.fn().mockResolvedValue(res(500, {}))))).toMatchObject({ result: "failed" })
  })

  it("logs no PII when pausing", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await runStandingOrder(fakeDb(tables({ ai_drafts: [] })), task(), ctx(vi.fn()))
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).not.toContain("0241234567")
    expect(logged).not.toContain(USER)
    spy.mockRestore()
  })
})

describe("createStandingOrderTask", () => {
  const draft = { id: DRAFT, user_id: USER, params } as any
  it("inserts a masked, model-free task keyed to the approved draft", async () => {
    const db = fakeDb(tables({ ai_scheduled_tasks: [] }))
    const out = await createStandingOrderTask(db, draft)
    expect(out.ok).toBe(true)
    const row = db.tables.ai_scheduled_tasks[0]
    expect(row).toMatchObject({
      user_id: USER, context: "dashboard", schedule_type: "daily", run_at_time: "08:00",
      notify_channels: ["push"], approved_draft_id: DRAFT, is_active: true, consecutive_skips: 0,
      standing_order: { package_id: PKG, network: "MTN", size: "5GB", recipient: "0241234567", max_price_ghs: 20 },
    })
    expect(row.name).toBe("Data order: MTN 5GB → 024***4567")
    expect(row.prompt).toBe("Standing data order (runs without AI)")
    expect(Number.isFinite(Date.parse(row.next_run_at))).toBe(true)
  })
  it("is idempotent per approved draft", async () => {
    const db = fakeDb(tables({ ai_scheduled_tasks: [] }))
    await createStandingOrderTask(db, draft)
    await createStandingOrderTask(db, draft)
    expect(db.tables.ai_scheduled_tasks).toHaveLength(1)
  })
})
