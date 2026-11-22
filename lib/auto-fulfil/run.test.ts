import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn(async () => ({ sent: 1, removed: 0 })) }))

import { notifyAdminsPush } from "@/lib/push-service"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"
import { DEFAULT_AUTO_FULFIL_SETTINGS, AUTO_FULFIL_SETTINGS_KEY, type AutoFulfilSettings } from "./settings"
import { runAutoFulfil, cancelWaitingAutoRows } from "./run"

const NOW = new Date("2026-11-22T12:00:00.000Z")
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString()

// Test-only phone numbers (never real).
const PHONE_A = "0559000101"
const PHONE_B = "0559000102"
const PHONE_C = "0559000103"
const PHONE_BL = "0559000199"

type Cand = { id: string; type: string; network: string; phone_number: string | null; created_at: string }

const on = (over: Partial<AutoFulfilSettings> = {}): AutoFulfilSettings => ({ ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: true, ...over })

function world(opts: {
  settings?: unknown
  mtnSwitch?: unknown
  nonMtnSwitch?: unknown
  candidates?: Cand[]
  tables?: Record<string, any[]>
}): FakeDb {
  const admin_settings: any[] = []
  if (opts.settings !== undefined) admin_settings.push({ key: AUTO_FULFIL_SETTINGS_KEY, value: opts.settings })
  if (opts.mtnSwitch !== undefined) admin_settings.push({ key: "mtn_auto_fulfillment_enabled", value: opts.mtnSwitch })
  if (opts.nonMtnSwitch !== undefined) admin_settings.push({ key: "auto_fulfillment_enabled", value: opts.nonMtnSwitch })
  const db = makeFakeDb({ admin_settings, ...(opts.tables ?? {}) })
  // Pages like the SQL: oldest first, LIMIT p_scan OFFSET p_offset (the candidates are given in that order).
  db.rpcs = {
    auto_fulfil_candidates: (a) => {
      const from = a.p_offset ?? 0
      return { data: (opts.candidates ?? []).slice(from, from + a.p_scan), error: null }
    },
  }
  return db
}

const ALL_ON = {
  mtnSwitch: { enabled: true },
  nonMtnSwitch: { enabled: true, networks: ["Telecel", "AT - iShare", "AT - BigTime"] },
}

const bulk = (id: string, network = "MTN") => ({ id, status: "pending", network })
const cand = (id: string, mins: number, phone: string | null = PHONE_A, network = "MTN", type = "bulk"): Cand => ({
  id,
  type,
  network,
  phone_number: phone,
  created_at: ago(mins),
})
const track = (orderId: string, extra: Record<string, any>) => ({
  id: `t-${orderId}-${Math.random()}`,
  order_id: orderId,
  shop_order_id: null,
  api_order_id: null,
  status: "failed",
  mtn_order_id: "ext-1",
  created_at: ago(120),
  external_message: null,
  api_response_payload: null,
  ...extra,
})

const queueRows = (db: FakeDb) => db.tables.fulfillment_queue ?? []
// Rows this run inserted (seeded rows carry no batch_id).
const autoQueued = (db: FakeDb) => queueRows(db).filter((r) => r.source === "auto" && r.batch_id).map((r) => r.order_id)

let logSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.mocked(notifyAdminsPush).mockClear()
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => logSpy.mockRestore())

describe("cancelWaitingAutoRows / off", () => {
  it("off => cancels waiting auto rows only (admin pending row untouched), queues nothing", async () => {
    const db = world({
      settings: { ...DEFAULT_AUTO_FULFIL_SETTINGS, enabled: false },
      ...ALL_ON,
      candidates: [cand("o1", 30)],
      tables: {
        orders: [bulk("o1")],
        fulfillment_queue: [
          { id: "q1", order_id: "x1", source: "auto", status: "pending" },
          { id: "q2", order_id: "x2", source: "admin", status: "pending" },
          { id: "q3", order_id: "x3", source: "auto", status: "processing" },
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s).toEqual({ ran: false, reason: "off", queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled: 1, scanned: 0 })
    const byId = Object.fromEntries(queueRows(db).map((r) => [r.id, r]))
    expect(byId.q1).toMatchObject({ status: "failed", error_message: "auto-fulfil switched off" })
    expect(byId.q2).toMatchObject({ status: "pending" })
    expect(byId.q2.error_message).toBeUndefined()
    expect(byId.q3).toMatchObject({ status: "processing" })
    expect(db.calls.some((c) => c.kind === "rpc")).toBe(false)
    expect(db.tables.auto_fulfil_runs ?? []).toHaveLength(0)
  })

  it("missing settings row => off (defaults are off)", async () => {
    const db = world({ ...ALL_ON, candidates: [cand("o1", 30)], tables: { orders: [bulk("o1")] } })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s).toMatchObject({ ran: false, reason: "off" })
    expect(queueRows(db)).toHaveLength(0)
  })

  it("invalid settings => same as off", async () => {
    const db = world({
      settings: { enabled: true, minAgeMinutes: 1 },
      ...ALL_ON,
      candidates: [cand("o1", 30)],
      tables: { orders: [bulk("o1")], fulfillment_queue: [{ id: "q1", order_id: "x1", source: "auto", status: "pending" }] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s).toEqual({ ran: false, reason: "invalid_settings", queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled: 1, scanned: 0 })
    expect(autoQueued(db)).toEqual([])
    expect(db.calls.some((c) => c.kind === "rpc")).toBe(false)
  })

  it("cancelWaitingAutoRows throws when the update fails", async () => {
    const db = makeFakeDb({ fulfillment_queue: [] })
    db.failUpdate = () => ({ message: "boom" })
    await expect(cancelWaitingAutoRows(db as any)).rejects.toThrow()
  })

  it("cancelling closes the cancelled rows' open attempts as 'skipped' (other attempts untouched)", async () => {
    const db = makeFakeDb({
      fulfillment_queue: [
        { id: "q1", order_id: "x1", source: "auto", status: "pending" },
        { id: "q3", order_id: "x3", source: "auto", status: "processing" },
      ],
      auto_fulfil_attempts: [
        { id: "a1", queue_id: "q1", order_id: "x1", outcome: null },
        { id: "a3", queue_id: "q3", order_id: "x3", outcome: null },
        { id: "a0", queue_id: "q1", order_id: "x1", outcome: "rate_limited" },
      ],
    })
    expect(await cancelWaitingAutoRows(db as any)).toBe(1)
    const byId = Object.fromEntries(db.tables.auto_fulfil_attempts.map((a) => [a.id, a]))
    expect(byId.a1.outcome).toBe("skipped")
    expect(typeof byId.a1.finished_at).toBe("string")
    expect(byId.a3.outcome).toBeNull() // still being sent by the drain
    expect(byId.a0.outcome).toBe("rate_limited")
  })

  it("an attempt update error is logged (ids only) and does not change the cancelled count", async () => {
    const db = makeFakeDb({
      fulfillment_queue: [{ id: "q1", order_id: "x1", source: "auto", status: "pending" }],
      auto_fulfil_attempts: [{ id: "a1", queue_id: "q1", order_id: "x1", outcome: null }],
    })
    db.failUpdate = (t) => (t === "auto_fulfil_attempts" ? { message: "boom" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await cancelWaitingAutoRows(db as any)).toBe(1)
      expect(err).toHaveBeenCalled()
      expect(err.mock.calls.flat().join(" ")).toContain("q1")
    } finally {
      err.mockRestore()
    }
  })

  it("switch off then on => the cancelled order is queued again (not needs_you)", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    const first = await runAutoFulfil(db as any, NOW)
    expect(first.queued).toBe(1)

    db.tables.admin_settings.find((r) => r.key === AUTO_FULFIL_SETTINGS_KEY)!.value = on({ enabled: false })
    const off = await runAutoFulfil(db as any, new Date(NOW.getTime() + 60_000))
    expect(off.cancelled).toBe(1)

    db.tables.admin_settings.find((r) => r.key === AUTO_FULFIL_SETTINGS_KEY)!.value = on()
    const again = await runAutoFulfil(db as any, new Date(NOW.getTime() + 20 * 60_000))
    expect(again).toMatchObject({ queued: 1, needsYou: 0 })
    expect(queueRows(db).filter((r) => r.order_id === "o1" && r.status === "pending")).toHaveLength(1)
  })
})

describe("runAutoFulfil", () => {
  it("queues eligible candidates up to perRun, oldest first, source 'auto', provider null", async () => {
    const db = world({
      settings: on({ perRun: 2 }),
      ...ALL_ON,
      // Deliberately out of order: the engine sorts oldest first itself.
      candidates: [cand("o2", 40, PHONE_B), cand("o3", 20, PHONE_C), cand("o1", 60, PHONE_A)],
      tables: { orders: [bulk("o1"), bulk("o2"), bulk("o3")] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.ran).toBe(true)
    expect(s.queued).toBe(2)
    expect(s.skipped).toEqual({ per_run_limit: 1 })
    const runId = s.runId!
    expect(runId).toBeTruthy()

    const rows = queueRows(db)
    expect(rows.map((r) => r.order_id)).toEqual(["o1", "o2"])
    for (const r of rows) expect(r).toMatchObject({ batch_id: runId, order_type: "bulk", provider: null, source: "auto", status: "pending" })

    const attempts = db.tables.auto_fulfil_attempts
    expect(attempts).toHaveLength(2)
    expect(attempts.map((a) => [a.order_id, a.queue_id, a.run_id, a.outcome ?? null])).toEqual([
      ["o1", rows[0].id, runId, null],
      ["o2", rows[1].id, runId, null],
    ])

    const rpc = db.calls.find((c) => c.kind === "rpc")!
    expect(rpc.table).toBe("auto_fulfil_candidates")
    expect(rpc.values).toEqual({
      p_min_age_minutes: 10,
      p_max_age_days: 7,
      p_networks: DEFAULT_AUTO_FULFIL_SETTINGS.networks,
      p_scan: 300,
      p_offset: 0,
    })
    expect(s.scanned).toBe(3)

    const run = db.tables.auto_fulfil_runs[0]
    expect(run).toMatchObject({ id: runId, started_at: NOW.toISOString(), queued: 2, waiting: 0, needs_you: 0, skipped: { per_run_limit: 1 } })
    expect(run.error ?? null).toBeNull()
  })

  it("finished_at is the real clock at the end of the run, not the injected now", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    const before = Date.now()
    await runAutoFulfil(db as any, NOW)
    const run = db.tables.auto_fulfil_runs[0]
    expect(run.started_at).toBe(NOW.toISOString())
    expect(Date.parse(run.finished_at)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(run.finished_at)).toBeLessThanOrEqual(Date.now())
  })

  it("single flight: an unfinished run started within 2 minutes => busy, nothing written", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("o1", 60)],
      tables: { orders: [bulk("o1")], auto_fulfil_runs: [{ id: "live", started_at: ago(1), finished_at: null, summary_sent: false }] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s).toEqual({ ran: false, reason: "busy", queued: 0, waiting: 0, needsYou: 0, skipped: {}, cancelled: 0, scanned: 0 })
    expect(db.tables.auto_fulfil_runs).toHaveLength(1)
    expect(db.calls.some((c) => c.kind === "rpc")).toBe(false)
    expect(db.calls.some((c) => c.kind === "insert" || c.kind === "update" || c.kind === "delete")).toBe(false)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("single flight: a crashed run older than 2 minutes does not block", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("o1", 60)],
      tables: { orders: [bulk("o1")], auto_fulfil_runs: [{ id: "dead", started_at: ago(5), finished_at: null, summary_sent: false }] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.ran).toBe(true)
    expect(autoQueued(db)).toEqual(["o1"])
  })

  it("bulk and shop orders with queue = 'blacklisted' are skipped as blacklisted_queue", async () => {
    const SHOP_BL = "33333333-3333-4333-8333-333333333333"
    const SHOP_OK = "44444444-4444-4444-8444-444444444444"
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("bl", 60), cand("ok", 60), cand(SHOP_BL, 60, PHONE_B, "MTN", "shop"), cand(SHOP_OK, 60, PHONE_C, "MTN", "shop")],
      tables: {
        orders: [{ ...bulk("bl"), queue: "blacklisted" }, { ...bulk("ok"), queue: "default" }],
        shop_orders: [
          { id: SHOP_BL, order_status: "pending", network: "MTN", payment_status: "completed", queue: "blacklisted" },
          { id: SHOP_OK, order_status: "pending", network: "MTN", payment_status: "completed", queue: null },
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ blacklisted_queue: 2 })
    expect(autoQueued(db).sort()).toEqual(["ok", SHOP_OK].sort())
  })

  it("a queue-flag read error => fails closed (nothing queued)", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    let ordersReads = 0
    // loadSnapshots reads orders first; fail the second read (the queue flag).
    db.failSelect = (t) => (t === "orders" && ++ordersReads === 2 ? { message: "queue read failed" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(queueRows(db)).toHaveLength(0)
  })

  describe("fulfillment_logs history (CodeCraft non-MTN)", () => {
    const U = (n: number) => `5555555${n}-5555-4555-8555-555555555555`
    const naiveAgo = (mins: number) => ago(mins).replace("Z", "")
    const log = (orderId: string, extra: Record<string, any>) => ({
      id: `l-${orderId}-${Math.random()}`,
      order_id: orderId,
      api_order_id: null,
      status: "failed",
      error_message: null,
      updated_at: naiveAgo(100),
      created_at: naiveAgo(100),
      ...extra,
    })

    it("success, pending or processing rows block (live at supplier); never queued", async () => {
      const API = U(4)
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [
          cand(U(1), 300, PHONE_A, "Telecel"),
          cand(U(2), 300, PHONE_B, "Telecel"),
          cand(U(3), 300, PHONE_C, "Telecel"),
          cand(API, 300, PHONE_A, "Telecel", "api"),
        ],
        tables: {
          orders: [bulk(U(1), "Telecel"), bulk(U(2), "Telecel"), bulk(U(3), "Telecel")],
          api_orders: [{ id: API, status: "pending", network: "Telecel" }],
          fulfillment_logs: [
            log(U(1), { status: "success" }),
            log(U(2), { status: "pending" }),
            log(U(3), { status: "processing" }),
            log("x", { order_id: null, api_order_id: API, status: "success" }),
          ],
        },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.skipped).toEqual({ live_at_supplier: 4 })
      expect(queueRows(db)).toHaveLength(0)
    })

    it("a failed row with 'Insufficient balance' waits per out_of_balance (updated_at read as UTC)", async () => {
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [cand(U(1), 300, PHONE_A, "Telecel"), cand(U(2), 300, PHONE_B, "Telecel")],
        tables: {
          orders: [bulk(U(1), "Telecel"), bulk(U(2), "Telecel")],
          fulfillment_logs: [
            log(U(1), { error_message: "Insufficient balance", updated_at: naiveAgo(10) }), // 30 min wait not over
            log(U(2), { error_message: "Insufficient balance", updated_at: naiveAgo(40) }), // wait over => retry
          ],
        },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.waiting).toBe(1)
      expect(autoQueued(db)).toEqual([U(2)])
    })

    it("a failed row with unknown text => needs you", async () => {
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [cand(U(1), 300, PHONE_A, "Telecel")],
        tables: { orders: [bulk(U(1), "Telecel")], fulfillment_logs: [log(U(1), { error_message: "weird gateway thing" })] },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.needsYou).toBe(1)
      expect(queueRows(db)).toHaveLength(0)
    })

    it("a fulfillment_logs read error => fails closed", async () => {
      const db = world({ settings: on(), ...ALL_ON, candidates: [cand(U(1), 300, PHONE_A, "Telecel")], tables: { orders: [bulk(U(1), "Telecel")] } })
      db.failSelect = (t) => (t === "fulfillment_logs" ? { message: "logs read failed" } : null)
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
      } finally {
        err.mockRestore()
      }
      expect(db.tables.auto_fulfil_runs[0].error).toMatch(/logs read failed/)
      expect(queueRows(db)).toHaveLength(0)
    })
  })

  it("23505 on insert => skipped.already_queued, no attempt row, run continues", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("o1", 60, PHONE_A), cand("o2", 50, PHONE_B)],
      tables: { orders: [bulk("o1"), bulk("o2")] },
    })
    // An admin queued o1 between the read and the insert.
    db.failInsert = (t, row) => (t === "fulfillment_queue" && row.order_id === "o1" ? { code: "23505", message: "duplicate key" } : null)
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.queued).toBe(1)
    expect(s.skipped).toEqual({ already_queued: 1 })
    expect(autoQueued(db)).toEqual(["o2"])
    expect(db.tables.auto_fulfil_attempts.map((a) => a.order_id)).toEqual(["o2"])
  })

  it("other insert error => skipped.insert_failed, logged with the order id only", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
      db.failInsert = (t) => (t === "fulfillment_queue" ? { code: "XX000", message: "boom" } : null)
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.skipped).toEqual({ insert_failed: 1 })
      expect(db.tables.auto_fulfil_attempts ?? []).toHaveLength(0)
      expect(err.mock.calls.flat().join(" ")).toContain("o1")
    } finally {
      err.mockRestore()
    }
  })

  it("attempt record insert fails => the waiting queue row is removed (no untracked auto send)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
      db.failInsert = (t) => (t === "auto_fulfil_attempts" ? { message: "boom" } : null)
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.queued).toBe(0)
      expect(s.skipped).toEqual({ attempt_record_failed: 1 })
      expect(queueRows(db)).toHaveLength(0)
    } finally {
      err.mockRestore()
    }
  })

  it("MTN skipped when mtn_auto_fulfillment_enabled is false; Telecel skipped when not in auto_fulfillment_enabled.networks", async () => {
    const db = world({
      settings: on(),
      mtnSwitch: { enabled: false },
      nonMtnSwitch: { enabled: true, networks: ["at-ishare"] },
      candidates: [cand("m1", 60, PHONE_A, "MTN"), cand("t1", 50, PHONE_B, "Telecel"), cand("i1", 40, PHONE_C, "AT - iShare")],
      tables: { orders: [bulk("m1", "MTN"), bulk("t1", "telecel"), bulk("i1", "AT - iShare")] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ network_switch_off: 2 })
    expect(autoQueued(db)).toEqual(["i1"])
  })

  it("non-MTN switch with enabled false (or missing switch rows) => off for those networks", async () => {
    const db = world({
      settings: on(),
      nonMtnSwitch: { enabled: false, networks: ["Telecel"] },
      candidates: [cand("m1", 60, PHONE_A, "MTN"), cand("t1", 50, PHONE_B, "Telecel")],
      tables: { orders: [bulk("m1", "MTN"), bulk("t1", "Telecel")] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ network_switch_off: 2 })
    expect(queueRows(db)).toHaveLength(0)
  })

  it("a network outside the auto-fulfil settings networks is never queued", async () => {
    const db = world({
      settings: on({ networks: ["Telecel"] }),
      ...ALL_ON,
      candidates: [cand("m1", 60, PHONE_A, "MTN")],
      tables: { orders: [bulk("m1", "MTN")] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.queued).toBe(0)
    expect(s.skipped).toEqual({ network_switch_off: 1 })
  })

  it("blacklisted phone skipped; no phone appears in any console call", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    try {
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [cand("b1", 60, PHONE_BL), cand("o2", 50, PHONE_B)],
        tables: {
          orders: [bulk("b1"), bulk("o2")],
          blacklisted_phone_numbers: [{ id: 1, phone_number: PHONE_BL.slice(1) }],
        },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.skipped).toEqual({ blacklisted: 1 })
      expect(autoQueued(db)).toEqual(["o2"])
      const logged = spies.flatMap((sp) => sp.mock.calls.flat().map((a) => (typeof a === "string" ? a : JSON.stringify(a)))).join(" ")
      for (const p of [PHONE_A, PHONE_B, PHONE_C, PHONE_BL]) {
        expect(logged).not.toContain(p)
        expect(logged).not.toContain(p.slice(1))
      }
      // Nothing persisted carries a phone either.
      const persisted = JSON.stringify([db.tables.fulfillment_queue, db.tables.auto_fulfil_attempts, db.tables.auto_fulfil_runs])
      for (const p of [PHONE_BL, PHONE_B]) expect(persisted).not.toContain(p.slice(1))
    } finally {
      for (const sp of spies) sp.mockRestore()
    }
  })

  it("does not queue an order whose old tracking row is completed or processing (live at supplier)", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("c1", 60), cand("p1", 60), cand("ok", 60)],
      tables: {
        orders: [bulk("c1"), bulk("p1"), bulk("ok")],
        mtn_fulfillment_tracking: [
          track("c1", { status: "completed", mtn_order_id: "ext-77", created_at: ago(90) }),
          track("p1", { status: "processing", mtn_order_id: "ext-78", created_at: ago(90) }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ live_at_supplier: 2 })
    expect(autoQueued(db)).toEqual(["ok"])
  })

  it("does not queue an order with a live (pending/processing) fulfillment_queue row", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("a1", 60), cand("a2", 60)],
      tables: {
        orders: [bulk("a1"), bulk("a2")],
        fulfillment_queue: [
          { id: "qa", order_id: "a1", source: "admin", status: "pending", enqueued_at: ago(30) },
          { id: "qb", order_id: "a2", source: "admin", status: "processing", enqueued_at: ago(30) },
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ already_queued: 2 })
    expect(db.calls.filter((c) => c.kind === "insert" && c.table === "fulfillment_queue")).toHaveLength(0)
  })

  it("a candidate whose order is no longer pending (or not found) is skipped", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("d1", 60), cand("gone", 60)],
      tables: { orders: [{ id: "d1", status: "completed", network: "MTN" }] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.skipped).toEqual({ completed: 1, not_found: 1 })
    expect(queueRows(db)).toHaveLength(0)
  })

  it("any held or reversed tracking row in the history => needs you", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("h1", 300), cand("h2", 300), cand("r1", 300)],
      tables: {
        orders: [bulk("h1"), bulk("h2"), bulk("r1")],
        mtn_fulfillment_tracking: [
          track("h1", { status: "abandoned", mtn_order_id: "UNKNOWN_1", created_at: ago(200) }),
          track("h1", { status: "failed", external_message: "rate limit", created_at: ago(100) }),
          track("h2", { status: "failed", mtn_order_id: "UNKNOWN_2", created_at: ago(200) }),
          track("r1", { status: "reversed", created_at: ago(200) }),
          track("r1", { status: "failed", created_at: ago(100) }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(3)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("tracking rows linked through shop_order_id / api_order_id count as history", async () => {
    const SHOP = "11111111-1111-4111-8111-111111111111"
    const API = "22222222-2222-4222-8222-222222222222"
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand(SHOP, 300, PHONE_A, "MTN", "shop"), cand(API, 300, PHONE_B, "MTN", "api")],
      tables: {
        shop_orders: [{ id: SHOP, order_status: "pending", network: "MTN", payment_status: "completed" }],
        api_orders: [{ id: API, status: "pending", network: "MTN" }],
        mtn_fulfillment_tracking: [
          track("x", { order_id: null, shop_order_id: SHOP, status: "reversed" }),
          track("y", { order_id: null, api_order_id: API, status: "abandoned", mtn_order_id: "UNKNOWN_9" }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(2)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("autoTries counts attempts whose outcome is not 'skipped' (NULL counts: the send may be in flight)", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("n1", 60), cand("s1", 60)],
      tables: {
        orders: [bulk("n1"), bulk("s1")],
        auto_fulfil_attempts: [
          { id: "at1", run_id: "r0", queue_id: "qx", order_id: "n1", order_type: "bulk", outcome: null },
          { id: "at2", run_id: "r0", queue_id: "qy", order_id: "s1", order_type: "bulk", outcome: "skipped" },
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    // n1: an earlier auto send with no failure on record => never send twice. s1: only a skipped attempt => never tried.
    expect(s.needsYou).toBe(1)
    expect(autoQueued(db)).toEqual(["s1"])
  })

  it("out of tries counts NULL and failure outcomes, not 'skipped'", async () => {
    const failed = (orderId: string) =>
      track(orderId, { status: "failed", external_message: "Rate limit exceeded", created_at: ago(100) })
    const attempts = (orderId: string, outcomes: (string | null)[]) =>
      outcomes.map((outcome, i) => ({ id: `${orderId}-a${i}`, run_id: "r0", queue_id: `${orderId}-q${i}`, order_id: orderId, order_type: "bulk", outcome }))
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("full", 300), cand("room", 300)],
      tables: {
        orders: [bulk("full"), bulk("room")],
        mtn_fulfillment_tracking: [failed("full"), failed("room")],
        auto_fulfil_attempts: [
          ...attempts("full", ["rate_limited", "rate_limited", "rate_limited", "rate_limited", null]),
          ...attempts("room", ["rate_limited", "rate_limited", "rate_limited", "rate_limited", "skipped", "skipped"]),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(1)
    expect(autoQueued(db)).toEqual(["room"])
  })

  it("failed queue rows of any source are failure events (at = last_attempted_at ?? completed_at ?? enqueued_at, the claim time); non-send messages ignored", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("w1", 300), cand("w2", 300), cand("w3", 300), cand("n1", 300), cand("u1", 300)],
      tables: {
        orders: [bulk("w1"), bulk("w2"), bulk("w3"), bulk("n1"), bulk("u1")],
        fulfillment_queue: [
          // rate_limited waits 2 min: each of these failed 1 minute ago by its own best timestamp.
          { id: "f1", order_id: "w1", source: "admin", status: "failed", error_message: "Rate limit hit", enqueued_at: ago(100), last_attempted_at: ago(1), completed_at: ago(90) },
          { id: "f2", order_id: "w2", source: "auto", status: "failed", error_message: "rate limit", enqueued_at: ago(100), last_attempted_at: ago(1), completed_at: null },
          { id: "f3", order_id: "w3", source: "admin", status: "failed", error_message: "rate limit", enqueued_at: ago(1), last_attempted_at: null, completed_at: null },
          // A drain skip that never reached a supplier is not a failure.
          { id: "f4", order_id: "n1", source: "auto", status: "failed", error_message: "auto-fulfil switched off", enqueued_at: ago(1), completed_at: ago(1) },
          // A queue message with no keyword is unclassified => a person decides.
          { id: "f5", order_id: "u1", source: "admin", status: "failed", error_message: "something odd", enqueued_at: ago(100), completed_at: ago(100) },
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.waiting).toBe(3)
    expect(s.needsYou).toBe(1)
    expect(autoQueued(db)).toEqual(["n1"])
  })

  it("C1: a tracking failure written during the send (after the claim) beats the vaguer queue failure => classified 'rejected', waits 60 min", async () => {
    const naive = (mins: number) => ago(mins).replace("Z", "")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("c1", 300)],
      tables: {
        orders: [bulk("c1")],
        // claim at T = 30 min ago; the supplier refusal is written to tracking at T+5 s; the queue row is failed at T+6 s
        // (stamped completed_at by an older drain) with an unknown message.
        fulfillment_queue: [
          { id: "q1", order_id: "c1", source: "admin", status: "failed", error_message: "Something unknown", enqueued_at: ago(31), last_attempted_at: ago(30), completed_at: ago(30 - 6 / 60) },
        ],
        mtn_fulfillment_tracking: [
          track("c1", { status: "failed", external_message: "some refusal", created_at: naive(120), updated_at: naive(30 - 5 / 60) }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(0)
    expect(s.waiting).toBe(1) // rejected waits 60 min from the failure; 30 min have passed
    expect(autoQueued(db)).toEqual([])
  })

  it("C1: a tracking failure older than the claim loses to the newer unknown queue failure => unclassified, needs you", async () => {
    const naive = (mins: number) => ago(mins).replace("Z", "")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("c2", 300)],
      tables: {
        orders: [bulk("c2")],
        fulfillment_queue: [
          { id: "q2", order_id: "c2", source: "admin", status: "failed", error_message: "Something unknown", enqueued_at: ago(31), last_attempted_at: ago(30), completed_at: ago(29) },
        ],
        mtn_fulfillment_tracking: [
          track("c2", { status: "failed", external_message: "some refusal", created_at: naive(120), updated_at: naive(90) }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(1)
    expect(s.waiting).toBe(0)
    expect(autoQueued(db)).toEqual([])
  })

  it("tracking timestamps without a zone are read as UTC", async () => {
    const naive = new Date(NOW.getTime() - 60_000).toISOString().replace("Z", "")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("z1", 300)],
      tables: {
        orders: [bulk("z1")],
        mtn_fulfillment_tracking: [track("z1", { status: "failed", external_message: "rate limit", created_at: naive })],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.waiting).toBe(1)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("a tracking row updated in place is timed by updated_at (UTC), not its old created_at", async () => {
    const naive = (mins: number) => ago(mins).replace("Z", "")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("u1", 300), cand("u2", 300)],
      tables: {
        orders: [bulk("u1"), bulk("u2")],
        mtn_fulfillment_tracking: [
          // created at purchase 2 h ago, refused (rate limit, 2 min wait) 1 min ago => still waiting
          track("u1", { status: "failed", external_message: "rate limit", created_at: naive(120), updated_at: naive(1) }),
          // no updated_at => falls back to created_at (wait long over)
          track("u2", { status: "failed", external_message: "rate limit", created_at: naive(120), updated_at: null }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.waiting).toBe(1)
    expect(autoQueued(db)).toEqual(["u2"])
  })

  it("10 skipped automatic attempts => needs you (repeatedly_skipped), not queued again", async () => {
    const skips = (orderId: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `${orderId}-s${i}`, run_id: "r0", queue_id: `${orderId}-q${i}`, order_id: orderId, order_type: "bulk", outcome: "skipped" }))
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("loop", 60), cand("fine", 60)],
      tables: { orders: [bulk("loop"), bulk("fine")], auto_fulfil_attempts: [...skips("loop", 10), ...skips("fine", 9)] },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(1)
    expect(autoQueued(db)).toEqual(["fine"])
  })

  describe("paging past parked orders", () => {
    const parked = (n: number) => Array.from({ length: n }, (_, i) => `p${String(i).padStart(4, "0")}`)

    it("300 parked (needs you) orders on page 1 + 1 eligible on page 2 => the eligible one is queued", async () => {
      const ids = parked(300)
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [...ids.map((id) => cand(id, 600)), cand("late", 60)],
        tables: {
          orders: [...ids.map((id) => bulk(id)), bulk("late")],
          // an earlier auto send with no failure on record => needs you
          auto_fulfil_attempts: ids.map((id) => ({ id: `a-${id}`, run_id: "r0", queue_id: `q-${id}`, order_id: id, order_type: "bulk", outcome: null })),
        },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s).toMatchObject({ queued: 1, needsYou: 300, scanned: 301 })
      expect(autoQueued(db)).toEqual(["late"])
      expect(db.calls.filter((c) => c.kind === "rpc").map((c) => c.values!.p_offset)).toEqual([0, 300])
    })

    it("stops paging once perRun orders are found", async () => {
      const db = world({
        settings: on({ perRun: 2 }),
        ...ALL_ON,
        candidates: Array.from({ length: 400 }, (_, i) => cand(`o${String(i).padStart(3, "0")}`, 600 - i)),
        tables: { orders: Array.from({ length: 400 }, (_, i) => bulk(`o${String(i).padStart(3, "0")}`)) },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.queued).toBe(2)
      expect(s.scanned).toBe(300)
      expect(db.calls.filter((c) => c.kind === "rpc")).toHaveLength(1)
    })

    it("scans at most 3000 candidates per run", async () => {
      // 3300 orders that are not found (skipped), then one eligible order past the cap.
      const ids = parked(3300)
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [...ids.map((id) => cand(id, 600)), cand("late", 60)],
        tables: { orders: [bulk("late")] },
      })
      const s = await runAutoFulfil(db as any, NOW)
      expect(s.scanned).toBe(3000)
      expect(s.queued).toBe(0)
      expect(db.calls.filter((c) => c.kind === "rpc")).toHaveLength(10)
    }, 30_000)
  })

  it("tracking message falls back to api_response_payload.message", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("p1", 300)],
      tables: {
        orders: [bulk("p1")],
        mtn_fulfillment_tracking: [track("p1", { status: "failed", api_response_payload: { message: "No active bundle" }, created_at: ago(100) })],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(1) // no_bundle is never retried
    expect(queueRows(db)).toHaveLength(0)
  })

  it("summary push sent at most once per 60 min when needsYou > 0", async () => {
    const tables = () => ({
      orders: [bulk("h1")],
      mtn_fulfillment_tracking: [track("h1", { status: "abandoned", mtn_order_id: "UNKNOWN_1" })],
    })
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("h1", 300)], tables: tables() })

    const first = await runAutoFulfil(db as any, NOW)
    expect(first.needsYou).toBe(1)
    expect(notifyAdminsPush).toHaveBeenCalledTimes(1)
    expect(notifyAdminsPush).toHaveBeenCalledWith({
      title: "Auto-fulfil",
      body: "1 orders need you on Order Payment Status",
      data: { url: "/admin/order-payment-status" },
    })
    expect(db.tables.auto_fulfil_runs.find((r) => r.id === first.runId)).toMatchObject({ summary_sent: true })

    // 30 minutes later: still throttled.
    await runAutoFulfil(db as any, new Date(NOW.getTime() + 30 * 60_000))
    expect(notifyAdminsPush).toHaveBeenCalledTimes(1)

    // 61 minutes after the sent summary: allowed again.
    await runAutoFulfil(db as any, new Date(NOW.getTime() + 61 * 60_000))
    expect(notifyAdminsPush).toHaveBeenCalledTimes(2)
  })

  it("no summary push when nobody is needed", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    await runAutoFulfil(db as any, NOW)
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("candidate RPC error => run row error set and the run throws", async () => {
    const db = world({ settings: on(), ...ALL_ON })
    db.rpcs = { auto_fulfil_candidates: () => ({ data: null, error: { message: "statement timeout" } }) }
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow(/candidates/)
    } finally {
      err.mockRestore()
    }
    const run = db.tables.auto_fulfil_runs[0]
    expect(run.error).toMatch(/statement timeout/)
    expect(Number.isNaN(Date.parse(run.finished_at))).toBe(false)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("a history read error => run row error set, nothing queued, throws", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    db.failSelect = (t) => (t === "auto_fulfil_attempts" ? { message: "read failed" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(db.tables.auto_fulfil_runs[0].error).toMatch(/read failed/)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("a blacklist lookup error => run fails closed (nothing queued)", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    db.failSelect = (t) => (t === "blacklisted_phone_numbers" ? { message: "nope" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(queueRows(db)).toHaveLength(0)
  })
})

describe("runAutoFulfil: order_dispatch_claims (S1)", () => {
  const U1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
  const U2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
  const U3 = "cccccccc-3333-4333-8333-cccccccccccc"
  const U4 = "dddddddd-4444-4444-8444-dddddddddddd"
  const claimRow = (orderId: string, outcome: string, minsAgo: number) => ({
    order_id: orderId,
    attempts: 1,
    last_outcome: outcome,
    last_claimed_at: ago(minsAgo + 1),
    updated_at: ago(minsAgo),
  })

  it("claimed / unknown claims => needs you; failed claim and no claim => queued", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand(U1, 300), cand(U2, 300), cand(U3, 300), cand(U4, 300)],
      tables: {
        orders: [bulk(U1), bulk(U2), bulk(U3), bulk(U4)],
        order_dispatch_claims: [claimRow(U1, "claimed", 60), claimRow(U2, "unknown", 60), claimRow(U3, "failed", 60)],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(2)
    expect(autoQueued(db).sort()).toEqual([U3, U4].sort())
  })

  it("submitted with no failure => needs you; submitted + a later tracking failure => normal retry rules", async () => {
    const naive = (m: number) => ago(m).replace("Z", "")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand(U1, 300), cand(U2, 300), cand(U3, 300)],
      tables: {
        orders: [bulk(U1), bulk(U2), bulk(U3)],
        order_dispatch_claims: [claimRow(U1, "submitted", 60), claimRow(U2, "submitted", 60), claimRow(U3, "submitted", 60)],
        mtn_fulfillment_tracking: [
          // U2: refusal recorded after the claim (rate limit, wait over) => retried
          track(U2, { status: "failed", external_message: "rate limit", created_at: naive(120), updated_at: naive(50) }),
          // U3: only an older failure => the submit has no outcome on record => needs you
          track(U3, { status: "failed", external_message: "rate limit", created_at: naive(120), updated_at: naive(90) }),
        ],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.needsYou).toBe(2)
    expect(autoQueued(db)).toEqual([U2])
  })

  it("non-uuid ids are not sent to order_dispatch_claims", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    await runAutoFulfil(db as any, NOW)
    expect(db.calls.some((c) => c.table === "order_dispatch_claims")).toBe(false)
  })

  it("a claims read error fails closed: run error set, nothing queued, throws", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand(U1, 60)], tables: { orders: [bulk(U1)] } })
    db.failSelect = (t) => (t === "order_dispatch_claims" ? { message: "claims read failed" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(db.tables.auto_fulfil_runs[0].error).toMatch(/claims read failed/)
    expect(queueRows(db)).toHaveLength(0)
  })
})

describe("runAutoFulfil: backpressure and run time (S3)", () => {
  const ids = (n: number, p = "o") => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, "0")}`)
  const waitingRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `w${i}`, order_id: `w-order-${i}`, source: "auto", status: "pending" }))

  it("waiting automatic rows >= perRun => nothing queued, no candidates read, the run row still finishes", async () => {
    const o = ids(5)
    const db = world({
      settings: on({ perRun: 3 }),
      ...ALL_ON,
      candidates: o.map((id) => cand(id, 60)),
      tables: { orders: o.map((id) => bulk(id)), fulfillment_queue: waitingRows(3) },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s).toMatchObject({ ran: true, queued: 0, scanned: 0 })
    expect(db.calls.filter((c) => c.kind === "rpc")).toHaveLength(0)
    expect(autoQueued(db)).toEqual([])
    expect(Number.isNaN(Date.parse(db.tables.auto_fulfil_runs[0].finished_at))).toBe(false)
  })

  it("partial room: perRun 3 with 2 waiting => at most 1 queued", async () => {
    const o = ids(5)
    const db = world({
      settings: on({ perRun: 3 }),
      ...ALL_ON,
      candidates: o.map((id) => cand(id, 60)),
      tables: { orders: o.map((id) => bulk(id)), fulfillment_queue: waitingRows(2) },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(s.queued).toBe(1)
    expect(autoQueued(db)).toEqual([o[0]])
  })

  it("only pending automatic rows count as waiting (admin, processing, failed rows do not)", async () => {
    const o = ids(5)
    const db = world({
      settings: on({ perRun: 2 }),
      ...ALL_ON,
      candidates: o.map((id) => cand(id, 60)),
      tables: {
        orders: o.map((id) => bulk(id)),
        fulfillment_queue: [
          { id: "a", order_id: "x1", source: "admin", status: "pending" },
          { id: "b", order_id: "x2", source: "auto", status: "processing" },
          { id: "c", order_id: "x3", source: "auto", status: "failed" },
        ],
      },
    })
    expect((await runAutoFulfil(db as any, NOW)).queued).toBe(2)
  })

  it("a failing waiting-rows count fails closed: run error set, nothing queued, throws", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    db.failSelect = (t) => (t === "fulfillment_queue" ? { message: "count failed" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(db.tables.auto_fulfil_runs[0].error).toMatch(/count failed/)
    expect(queueRows(db)).toHaveLength(0)
  })

  it("after 40 s of real time no new page is started, but what was found is queued", async () => {
    const parked = ids(299, "p")
    const base = 1_000_000
    let clock = base
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock)
    try {
      const db = world({
        settings: on(),
        ...ALL_ON,
        candidates: [...parked.map((id) => cand(id, 600)), cand("good", 60), cand("late", 59)],
        tables: {
          orders: [...parked.map((id) => bulk(id)), bulk("good"), bulk("late")],
          auto_fulfil_attempts: parked.map((id) => ({ id: `a-${id}`, run_id: "r0", queue_id: `q-${id}`, order_id: id, order_type: "bulk", outcome: null })),
        },
      })
      const rpc = db.rpcs!.auto_fulfil_candidates
      db.rpcs!.auto_fulfil_candidates = (a: any) => {
        const r = rpc(a)
        clock += 41_000 // reading the first page took 41 s
        return r
      }
      const s = await runAutoFulfil(db as any, NOW)
      expect(db.calls.filter((c) => c.kind === "rpc")).toHaveLength(1)
      expect(autoQueued(db)).toEqual(["good"])
      expect(s.queued).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("under the time budget paging continues", async () => {
    const parked = ids(300, "p")
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [...parked.map((id) => cand(id, 600)), cand("late", 60)],
      tables: {
        orders: [...parked.map((id) => bulk(id)), bulk("late")],
        auto_fulfil_attempts: parked.map((id) => ({ id: `a-${id}`, run_id: "r0", queue_id: `q-${id}`, order_id: id, order_type: "bulk", outcome: null })),
      },
    })
    await runAutoFulfil(db as any, NOW)
    expect(autoQueued(db)).toEqual(["late"])
  })
})

describe("runAutoFulfil: strict holds (strict supplier verification)", () => {
  const sh = (order_table: string, order_id: string, state: string) => ({ order_table, order_id, phone: PHONE_A, reason: "unanswered", state })

  it("skips a candidate whose strict hold expired (strict_hold_expired); a released hold is queued normally", async () => {
    const db = world({
      settings: on(),
      ...ALL_ON,
      candidates: [cand("o1", 60, PHONE_A), cand("o2", 50, PHONE_B), cand("s1", 40, PHONE_C, "MTN", "shop")],
      tables: {
        orders: [bulk("o1"), bulk("o2")],
        shop_orders: [{ id: "s1", order_status: "pending", network: "MTN" }],
        // o2's expired row is filed for shop_orders, not orders: it must not block the bulk order o2.
        mtn_strict_holds: [sh("orders", "o1", "expired"), sh("shop_orders", "o2", "expired"), sh("shop_orders", "s1", "released")],
      },
    })
    const s = await runAutoFulfil(db as any, NOW)
    expect(autoQueued(db)).not.toContain("o1")
    expect(autoQueued(db)).toContain("o2")
    expect(s.skipped.strict_hold_expired).toBe(1)
  })

  it("a strict hold read error fails closed (nothing queued, throws)", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    db.failSelect = (t) => (t === "mtn_strict_holds" ? { message: "read failed" } : null)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(runAutoFulfil(db as any, NOW)).rejects.toThrow()
    } finally {
      err.mockRestore()
    }
    expect(queueRows(db)).toHaveLength(0)
  })

  it("the strict holds table not existing yet (0194 not applied) blocks nothing", async () => {
    const db = world({ settings: on(), ...ALL_ON, candidates: [cand("o1", 60)], tables: { orders: [bulk("o1")] } })
    db.failSelect = (t) => (t === "mtn_strict_holds" ? ({ code: "PGRST205", message: "not in schema cache" } as any) : null)
    await runAutoFulfil(db as any, NOW)
    expect(autoQueued(db)).toEqual(["o1"])
  })
})
