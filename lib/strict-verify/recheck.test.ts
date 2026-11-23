import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

vi.mock("@/lib/push-service", () => ({ notifyAdminsPush: vi.fn(async () => ({ sent: 1, removed: 0 })) }))
vi.mock("@/lib/fulfillment-service", () => ({ processManualFulfillment: vi.fn(async () => ({ success: true, message: "ok" })) }))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder: vi.fn(async () => ({ success: true, message: "ok" })) }))
vi.mock("./ask", () => ({
  askSupplier: vi.fn(async () => "no_answer"),
  canCheck: (s: string, disabled: Set<string>) => !disabled.has(s) && s !== "nocheck",
}))
vi.mock("./send", () => ({
  buildCandidates: vi.fn(async () => ({ candidates: ["xpress", "hubnet"], disabled: new Set<string>() })),
}))

import { notifyAdminsPush } from "@/lib/push-service"
import { processManualFulfillment } from "@/lib/fulfillment-service"
import { fulfillUssdOrder } from "@/lib/ussd/fulfill"
import { askSupplier } from "./ask"
import { buildCandidates } from "./send"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"
import { runStrictRecheck } from "./recheck"
import { STRICT_VERIFY_KEY } from "./settings"

const NOW = new Date("2026-11-22T12:00:00.000Z")
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString()
const H = 60

// Test-only phone numbers (never real).
const PHONE_A = "0559000201"
const PHONE_B = "0559000202"

type Hold = {
  order_table: string
  order_id: string
  phone: string
  reason: "rejected" | "unanswered"
  state: "open" | "released" | "expired"
  held_at: string
  last_checked_at: string | null
  sms_sent: boolean
  closed_at: string | null
}

const hold = (order_table: string, order_id: string, phone: string, over: Partial<Hold> = {}): Hold => ({
  order_table,
  order_id,
  phone,
  reason: "unanswered",
  state: "open",
  held_at: ago(30),
  last_checked_at: ago(10),
  sms_sent: true,
  closed_at: null,
  ...over,
})

function world(opts: { on?: boolean; holds: Hold[]; tables?: Record<string, any[]>; verdicts?: any[] }): FakeDb {
  const admin_settings: any[] = []
  if (opts.on !== undefined) admin_settings.push({ key: STRICT_VERIFY_KEY, value: { enabled: opts.on } })
  return makeFakeDb({
    admin_settings,
    mtn_strict_holds: opts.holds,
    mtn_supplier_verdicts: opts.verdicts ?? [],
    ...(opts.tables ?? {}),
  })
}

// saveVerdicts upserts an array of rows; the fake stores upserts as one value, so read the calls.
const savedVerdicts = (db: FakeDb) =>
  db.calls.filter((c) => c.table === "mtn_supplier_verdicts" && c.kind === "upsert").flatMap((c) => c.values as any)

const holdOf = (db: FakeDb, table: string, id: string) =>
  db.tables.mtn_strict_holds.find((h) => h.order_table === table && h.order_id === id)!

let logSpy: ReturnType<typeof vi.spyOn>
let errSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.mocked(notifyAdminsPush).mockClear()
  vi.mocked(processManualFulfillment).mockReset().mockResolvedValue({ success: true, message: "ok" } as any)
  vi.mocked(fulfillUssdOrder).mockReset().mockResolvedValue({ success: true, message: "ok" })
  vi.mocked(askSupplier).mockReset().mockResolvedValue("no_answer")
  vi.mocked(buildCandidates).mockReset().mockResolvedValue({ candidates: ["xpress", "hubnet"], disabled: new Set<string>() })
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  logSpy.mockRestore()
  errSpy.mockRestore()
  warnSpy.mockRestore()
})

const allLogs = () => [...logSpy.mock.calls, ...errSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String).join(" ")

describe("runStrictRecheck: switch off", () => {
  it("releases every open hold to today's normal (unpinned) dispatch without asking anyone", async () => {
    const db = world({
      holds: [
        hold("orders", "o1", PHONE_A, { reason: "rejected", last_checked_at: ago(1) }),
        hold("ussd_orders", "u1", PHONE_B),
        hold("shop_orders", "s0", PHONE_B, { state: "released", closed_at: ago(5) }),
      ],
      tables: {
        orders: [{ id: "o1", status: "held_registration" }],
        ussd_orders: [{ id: "u1", order_status: "held_registration", network: "MTN", package_size: "2GB", recipient_phone: PHONE_B }],
        shop_orders: [{ id: "s0", order_status: "completed" }],
      },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r).toEqual({ checked: 0, released: 2, expired: 0, stillHeld: 0 })
    expect(db.tables.orders[0].status).toBe("pending")
    expect(db.tables.ussd_orders[0].order_status).toBe("pending")
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "released", closed_at: NOW.toISOString() })
    expect(holdOf(db, "ussd_orders", "u1")).toMatchObject({ state: "released", closed_at: NOW.toISOString() })
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(vi.mocked(processManualFulfillment).mock.calls[0]).toEqual(["o1", "bulk"])
    expect(vi.mocked(fulfillUssdOrder).mock.calls[0]).toEqual(["u1", "MTN", PHONE_B, "2GB", false, "ussd_orders"])
    expect(askSupplier).not.toHaveBeenCalled()
    expect(buildCandidates).not.toHaveBeenCalled()
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("closes the hold BEFORE dispatching, so a re-hold during dispatch stays open (never stranded)", async () => {
    const db = world({
      holds: [hold("orders", "o1", PHONE_A)],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    vi.mocked(processManualFulfillment).mockImplementation(async () => {
      // At dispatch time the hold must already be closed; the gate then holds the order again (Task 4's re-open).
      const h = holdOf(db, "orders", "o1")
      expect(h.state).toBe("released")
      db.tables.orders[0].status = "held_registration"
      Object.assign(h, { state: "open", held_at: NOW.toISOString(), last_checked_at: null, closed_at: null })
      return { success: false, message: "held", held: true } as any
    })
    await runStrictRecheck(db as any, NOW)
    expect(db.tables.orders[0].status).toBe("held_registration")
    expect(holdOf(db, "orders", "o1").state).toBe("open")
  })

  it("an order that already moved on is closed without dispatch", async () => {
    const db = world({
      holds: [hold("shop_orders", "s1", PHONE_A)],
      tables: { shop_orders: [{ id: "s1", order_status: "completed" }] },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.released).toBe(0)
    expect(holdOf(db, "shop_orders", "s1").state).toBe("released")
    expect(processManualFulfillment).not.toHaveBeenCalled()
  })
})

describe("runStrictRecheck: switch on", () => {
  it("one approval releases both orders for a phone (one ask, verdict saved, unpinned dispatch)", async () => {
    vi.mocked(askSupplier).mockImplementation(async (s) => (s === "xpress" ? "yes" : "no_answer"))
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A), hold("shop_orders", "s1", PHONE_A, { reason: "rejected", last_checked_at: ago(60) })],
      tables: {
        orders: [{ id: "o1", status: "held_registration" }],
        shop_orders: [{ id: "s1", order_status: "held_registration" }],
      },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r).toMatchObject({ released: 2, expired: 0, stillHeld: 0 })
    expect(askSupplier).toHaveBeenCalledTimes(1)
    expect(vi.mocked(askSupplier).mock.calls[0][0]).toBe("xpress")
    expect(db.tables.orders[0].status).toBe("pending")
    expect(db.tables.shop_orders[0].order_status).toBe("pending")
    expect(holdOf(db, "orders", "o1").state).toBe("released")
    expect(holdOf(db, "shop_orders", "s1").state).toBe("released")
    expect(vi.mocked(processManualFulfillment).mock.calls.map((c) => c)).toEqual([
      ["o1", "bulk"],
      ["s1", "shop"],
    ])
    expect(savedVerdicts(db)).toEqual([{ phone: PHONE_A, supplier: "xpress", verdict: "yes", checked_at: NOW.toISOString() }])
  })

  it("a fresh saved yes releases without asking", async () => {
    const db = world({
      on: true,
      holds: [hold("api_orders", "a1", PHONE_A)],
      tables: { api_orders: [{ id: "a1", status: "held_registration" }] },
      verdicts: [{ phone: PHONE_A, supplier: "hubnet", verdict: "yes", checked_at: ago(60) }],
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.released).toBe(1)
    expect(askSupplier).not.toHaveBeenCalled()
    expect(vi.mocked(processManualFulfillment).mock.calls[0]).toEqual(["a1", "api"])
  })

  it("a rejected hold is not re-asked before 24 h, and is after", async () => {
    const db = world({
      on: true,
      holds: [
        hold("orders", "o1", PHONE_A, { reason: "rejected", last_checked_at: ago(23 * H) }),
        hold("orders", "o2", PHONE_B, { reason: "rejected", last_checked_at: ago(25 * H), held_at: ago(26 * H) }),
      ],
      tables: {
        orders: [
          { id: "o1", status: "held_registration" },
          { id: "o2", status: "held_registration" },
        ],
      },
    })
    vi.mocked(askSupplier).mockResolvedValue("no")
    const r = await runStrictRecheck(db as any, NOW)
    expect(vi.mocked(askSupplier).mock.calls.map((c) => c[1])).toEqual([PHONE_B, PHONE_B])
    expect(r).toEqual({ checked: 1, released: 0, expired: 0, stillHeld: 2 })
    expect(holdOf(db, "orders", "o1").last_checked_at).toBe(ago(23 * H))
    expect(holdOf(db, "orders", "o2")).toMatchObject({ state: "open", reason: "rejected", last_checked_at: NOW.toISOString() })
    expect(processManualFulfillment).not.toHaveBeenCalled()
  })

  it("a rejected hold that was never re-checked counts from held_at", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { reason: "rejected", last_checked_at: null, held_at: ago(30) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    await runStrictRecheck(db as any, NOW)
    expect(askSupplier).not.toHaveBeenCalled()
  })

  it("an unanswered hold is re-asked after 5 min, not before; no_answer keeps it open as unanswered", async () => {
    const db = world({
      on: true,
      holds: [
        hold("orders", "o1", PHONE_A, { last_checked_at: ago(6) }),
        hold("orders", "o2", PHONE_B, { last_checked_at: ago(3) }),
      ],
      tables: {
        orders: [
          { id: "o1", status: "held_registration" },
          { id: "o2", status: "held_registration" },
        ],
      },
    })
    vi.mocked(askSupplier).mockImplementation(async (s) => (s === "xpress" ? "no" : "no_answer"))
    const r = await runStrictRecheck(db as any, NOW)
    expect(vi.mocked(askSupplier).mock.calls.every((c) => c[1] === PHONE_A)).toBe(true)
    expect(r).toEqual({ checked: 1, released: 0, expired: 0, stillHeld: 2 })
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "open", reason: "unanswered", last_checked_at: NOW.toISOString() })
    expect(holdOf(db, "orders", "o2").last_checked_at).toBe(ago(3))
    // Only the definite "no" is saved.
    expect(savedVerdicts(db)).toEqual([expect.objectContaining({ phone: PHONE_A, supplier: "xpress", verdict: "no" })])
  })

  it("every supplier saying no turns the hold into rejected", async () => {
    vi.mocked(askSupplier).mockResolvedValue("no")
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A)],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    await runStrictRecheck(db as any, NOW)
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "open", reason: "rejected" })
  })

  it("stops asking Hubnet for the rest of the run after its first no_answer", async () => {
    vi.mocked(buildCandidates).mockResolvedValue({ candidates: ["hubnet", "xpress"], disabled: new Set<string>() })
    vi.mocked(askSupplier).mockImplementation(async (s) => (s === "hubnet" ? "no_answer" : "no"))
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A), hold("orders", "o2", PHONE_B)],
      tables: {
        orders: [
          { id: "o1", status: "held_registration" },
          { id: "o2", status: "held_registration" },
        ],
      },
    })
    await runStrictRecheck(db as any, NOW)
    const hubnetAsks = vi.mocked(askSupplier).mock.calls.filter((c) => c[0] === "hubnet")
    expect(hubnetAsks).toHaveLength(1)
    expect(vi.mocked(askSupplier).mock.calls.filter((c) => c[0] === "xpress")).toHaveLength(2)
    // Hubnet's skipped ask is still no answer, never a "no".
    expect(holdOf(db, "orders", "o2").reason).toBe("unanswered")
  })

  it("after 72 h: order back to pending, hold expired, nothing dispatched, one push with no phone", async () => {
    const db = world({
      on: true,
      holds: [
        hold("orders", "o1", PHONE_A, { held_at: ago(73 * H) }),
        hold("ussd_shop_orders", "u1", PHONE_B, { held_at: ago(72 * H + 1), reason: "rejected", last_checked_at: ago(1) }),
      ],
      tables: {
        orders: [{ id: "o1", status: "held_registration" }],
        ussd_shop_orders: [{ id: "u1", order_status: "held_registration", network: "MTN", package_size: "1GB", recipient_phone: PHONE_B }],
      },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r).toEqual({ checked: 0, released: 0, expired: 2, stillHeld: 0 })
    expect(db.tables.orders[0].status).toBe("pending")
    expect(db.tables.ussd_shop_orders[0].order_status).toBe("pending")
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "expired", closed_at: NOW.toISOString() })
    expect(holdOf(db, "ussd_shop_orders", "u1")).toMatchObject({ state: "expired", closed_at: NOW.toISOString() })
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
    expect(askSupplier).not.toHaveBeenCalled()
    expect(notifyAdminsPush).toHaveBeenCalledTimes(1)
    const payload = vi.mocked(notifyAdminsPush).mock.calls[0][0]
    expect(payload.body).toBe("2 MTN orders could not be verified for 72 hours — check Needs action")
    expect(JSON.stringify(payload)).not.toMatch(/\d{7,}/)
  })

  it("no push when nothing expired", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A)],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    await runStrictRecheck(db as any, NOW)
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("a hold whose order moved on is closed (released) without asking or dispatch", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { held_at: ago(80 * H) })],
      tables: { orders: [{ id: "o1", status: "completed" }] },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r).toEqual({ checked: 0, released: 0, expired: 0, stillHeld: 0 })
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "released", closed_at: NOW.toISOString() })
    expect(db.tables.orders[0].status).toBe("completed")
    expect(askSupplier).not.toHaveBeenCalled()
    expect(processManualFulfillment).not.toHaveBeenCalled()
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("an order held again while its hold is being closed keeps an open hold", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A)],
      tables: { orders: [{ id: "o1", status: "processing" }] },
    })
    db.beforeUpdate = (t, v) => {
      if (t === "mtn_strict_holds" && v.state === "released") db.tables.orders[0].status = "held_registration"
    }
    const r = await runStrictRecheck(db as any, NOW)
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "open", closed_at: null })
    expect(r.stillHeld).toBe(1)
  })

  it("a failed expiry write puts the order back on hold (never pending with an open hold)", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { held_at: ago(73 * H) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    db.failUpdate = (t, v) => (t === "mtn_strict_holds" && v.state === "expired" ? { message: "boom" } : null)
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.expired).toBe(0)
    expect(db.tables.orders[0].status).toBe("held_registration")
    expect(holdOf(db, "orders", "o1").state).toBe("open")
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("an overlapping run closing the hold as released between claim and expiry still ends expired", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { held_at: ago(73 * H) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    db.beforeUpdate = (t, v) => {
      // The other run's closeMovedOn lands right after this run's claim.
      if (t === "orders" && v.status === "pending") {
        const h = holdOf(db, "orders", "o1")
        h.state = "released"
        h.closed_at = NOW.toISOString()
      }
    }
    const r = await runStrictRecheck(db as any, NOW)
    expect(holdOf(db, "orders", "o1")).toMatchObject({ state: "expired" })
    expect(r.expired).toBe(1)
  })

  it("an expiry write that matches nothing is not counted or pushed", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { held_at: ago(73 * H) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    db.beforeUpdate = (t, v) => {
      // The hold row vanishes into a later episode (different held_at, so nothing can match).
      if (t === "orders" && v.status === "pending") holdOf(db, "orders", "o1").held_at = ago(1 * H)
    }
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.expired).toBe(0)
    expect(notifyAdminsPush).not.toHaveBeenCalled()
  })

  it("switch off: stops starting releases once the run budget is spent; leftovers stay open", async () => {
    let clock = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock)
    vi.mocked(processManualFulfillment).mockImplementation(async () => {
      clock += 300_000
      return { success: true, message: "ok" } as any
    })
    try {
      const db = world({
        holds: [hold("orders", "o1", PHONE_A), hold("orders", "o2", PHONE_B)],
        tables: { orders: [{ id: "o1", status: "held_registration" }, { id: "o2", status: "held_registration" }] },
      })
      const r = await runStrictRecheck(db as any, NOW)
      expect(r.released).toBe(1)
      expect(r.stillHeld).toBe(1)
      expect(holdOf(db, "orders", "o2").state).toBe("open")
      expect(db.tables.orders[1].status).toBe("held_registration")
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("approved: stops starting releases once the run budget is spent; leftovers stay open", async () => {
    vi.mocked(askSupplier).mockResolvedValue("yes")
    let clock = 1_000_000
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock)
    vi.mocked(processManualFulfillment).mockImplementation(async () => {
      clock += 300_000
      return { success: true, message: "ok" } as any
    })
    try {
      const db = world({
        on: true,
        holds: [hold("orders", "o1", PHONE_A, { last_checked_at: ago(60) }), hold("shop_orders", "s1", PHONE_A, { last_checked_at: ago(60) })],
        tables: { orders: [{ id: "o1", status: "held_registration" }], shop_orders: [{ id: "s1", order_status: "held_registration" }] },
      })
      const r = await runStrictRecheck(db as any, NOW)
      expect(r.released).toBe(1)
      expect(r.stillHeld).toBe(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("a failing verdict save does not abort the run", async () => {
    vi.mocked(askSupplier).mockImplementation(async (s) => (s === "xpress" ? "yes" : "no_answer"))
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { last_checked_at: ago(60) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    db.failUpsert = () => ({ message: `boom ${PHONE_A}` })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.released).toBe(1)
    expect(allLogs()).not.toContain(PHONE_A)
  })

  it("an order status read error leaves those holds alone", async () => {
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A, { held_at: ago(80 * H) })],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    db.failSelect = (t) => (t === "orders" ? { message: "boom" } : null)
    const r = await runStrictRecheck(db as any, NOW)
    expect(r).toEqual({ checked: 0, released: 0, expired: 0, stillHeld: 1 })
    expect(holdOf(db, "orders", "o1").state).toBe("open")
    expect(db.tables.orders[0].status).toBe("held_registration")
  })

  it("a candidate list error asks nobody and leaves holds open", async () => {
    vi.mocked(buildCandidates).mockRejectedValue(new Error("settings down"))
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A)],
      tables: { orders: [{ id: "o1", status: "held_registration" }] },
    })
    const r = await runStrictRecheck(db as any, NOW)
    expect(r.stillHeld).toBe(1)
    expect(askSupplier).not.toHaveBeenCalled()
    expect(holdOf(db, "orders", "o1").last_checked_at).toBe(ago(10))
  })

  it("never logs a phone number", async () => {
    vi.mocked(askSupplier).mockResolvedValue("yes")
    vi.mocked(processManualFulfillment).mockRejectedValue(new Error(`send failed for ${PHONE_A}`))
    const db = world({
      on: true,
      holds: [hold("orders", "o1", PHONE_A), hold("orders", "o2", PHONE_B, { held_at: ago(73 * H) })],
      tables: {
        orders: [
          { id: "o1", status: "held_registration" },
          { id: "o2", status: "held_registration" },
        ],
      },
    })
    await runStrictRecheck(db as any, NOW)
    expect(allLogs()).not.toMatch(/\d{7,}/)
  })
})
