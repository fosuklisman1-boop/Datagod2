import { describe, it, expect, vi, beforeEach } from "vitest"
import { makeFakeDb, type FakeDb } from "@/lib/order-queue/fake-db.test-helper"

const state = vi.hoisted(() => ({ db: null as any }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => state.db }))

const sendSMS = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }))
vi.mock("@/lib/sms-service", async () => {
  const actual = await vi.importActual<any>("@/lib/sms-service")
  return { ...actual, sendSMS }
})

const processManualFulfillment = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true, message: "ok" }))
vi.mock("@/lib/fulfillment-service", () => ({ processManualFulfillment }))
const fulfillUssdOrder = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true, message: "Fulfilled via MTN API" }))
vi.mock("@/lib/ussd/fulfill", () => ({ fulfillUssdOrder }))

import { holdMtnOrder, isStrictHeld, releaseHeldMtnOrders, releaseWhitelistHeldOrders, getHeldOrderPhones } from "./mtn-hold"
import { SMSTemplates } from "@/lib/sms-service"

const STRICT_COPY = (p: string) =>
  `DTGOD: Your MTN data order for ${p} is being checked with our suppliers and will be delivered automatically once approved.`

let db: FakeDb
beforeEach(() => {
  vi.clearAllMocks()
  db = makeFakeDb({
    orders: [{ id: "o1", status: "processing", phone_number: "0551111111" }],
    mtn_strict_holds: [],
  })
  state.db = db
})

describe("SMSTemplates.mtnStrictHold", () => {
  it("uses the exact strict-hold copy", () => {
    expect(SMSTemplates.mtnStrictHold("0551111111")).toBe(STRICT_COPY("0551111111"))
  })
})

describe("holdMtnOrder — strict holds", () => {
  it("writes an open hold row with the reason and sends the strict SMS once", async () => {
    const r = await holdMtnOrder({ table: "orders", orderId: "o1", phone: "233551111111", errorType: "STRICT_HOLD", strictReason: "unanswered" })
    expect(r.held).toBe(true)
    expect(db.tables.orders[0].status).toBe("held_registration")
    expect(db.tables.mtn_strict_holds).toHaveLength(1)
    const h = db.tables.mtn_strict_holds[0]
    expect(h).toMatchObject({ order_table: "orders", order_id: "o1", phone: "0551111111", reason: "unanswered", state: "open", sms_sent: true })
    expect(h.held_at).toBeTruthy()
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0].message).toBe(STRICT_COPY("233551111111"))
    expect(sendSMS.mock.calls[0][0].type).toBe("mtn_strict_hold")
  })

  it("a second strict hold for the same order sends no SMS and keeps held_at", async () => {
    await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "unanswered" })
    const firstHeldAt = db.tables.mtn_strict_holds[0].held_at = "2026-11-20T00:00:00.000Z"
    // Released to pending by a re-check, then the gate holds it again.
    db.tables.orders[0].status = "pending"
    await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "rejected" })
    expect(db.tables.mtn_strict_holds).toHaveLength(1)
    expect(db.tables.mtn_strict_holds[0].held_at).toBe(firstHeldAt)
    expect(db.tables.mtn_strict_holds[0].reason).toBe("rejected")
    expect(sendSMS).toHaveBeenCalledTimes(1)
  })

  it("re-opening a closed hold sends no second SMS", async () => {
    db.tables.mtn_strict_holds.push({ order_table: "orders", order_id: "o1", phone: "0551111111", reason: "unanswered", state: "released", held_at: "2026-11-01T00:00:00.000Z", sms_sent: true, closed_at: "2026-11-02T00:00:00.000Z" })
    await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "unanswered" })
    expect(db.tables.mtn_strict_holds).toHaveLength(1)
    expect(db.tables.mtn_strict_holds[0]).toMatchObject({ state: "open", closed_at: null })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("does nothing when the order is no longer in flight (guarded update)", async () => {
    db.tables.orders[0].status = "completed"
    const r = await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "rejected" })
    expect(r.held).toBe(false)
    expect(db.tables.mtn_strict_holds).toHaveLength(0)
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("if the hold row cannot be written, the order goes back to pending (never stranded)", async () => {
    db.failInsert = (t) => (t === "mtn_strict_holds" ? { message: "boom" } : null)
    const r = await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "rejected" })
    expect(r.held).toBe(false)
    expect(db.tables.orders[0].status).toBe("pending")
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("a row created between the read and the insert (23505) is re-opened, not a failure", async () => {
    db.failInsert = (t) => {
      if (t !== "mtn_strict_holds") return null
      db.tables.mtn_strict_holds.push({ order_table: "orders", order_id: "o1", phone: "0551111111", reason: "rejected", state: "open", held_at: "2026-11-20T00:00:00.000Z", sms_sent: true })
      return { code: "23505", message: "duplicate key" }
    }
    const r = await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "unanswered" })
    expect(r.held).toBe(true)
    expect(db.tables.orders[0].status).toBe("held_registration")
    expect(db.tables.mtn_strict_holds[0]).toMatchObject({ state: "open", reason: "unanswered", held_at: "2026-11-20T00:00:00.000Z" })
    expect(sendSMS).not.toHaveBeenCalled()
  })

  it("non-strict hold is unchanged: registration SMS, no strict row", async () => {
    const r = await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "NUMBER_NOT_REGISTERED" })
    expect(r.held).toBe(true)
    expect(db.tables.orders[0].status).toBe("held_registration")
    expect(db.tables.mtn_strict_holds).toHaveLength(0)
    expect(sendSMS).toHaveBeenCalledTimes(1)
    expect(sendSMS.mock.calls[0][0].type).toBe("mtn_registration_hold")
    expect(sendSMS.mock.calls[0][0].message).toBe(SMSTemplates.mtnRegistrationHold("0551111111"))
  })

  it("never logs the phone number", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await holdMtnOrder({ table: "orders", orderId: "o1", phone: "0551111111", errorType: "STRICT_HOLD", strictReason: "rejected" })
    expect(JSON.stringify(log.mock.calls)).not.toContain("551111111")
    log.mockRestore()
  })
})

describe("isStrictHeld", () => {
  it("true only for an open hold", async () => {
    db.tables.mtn_strict_holds.push(
      { order_table: "orders", order_id: "a", state: "open" },
      { order_table: "orders", order_id: "b", state: "released" },
    )
    expect(await isStrictHeld(db as any, "orders", "a")).toBe(true)
    expect(await isStrictHeld(db as any, "orders", "b")).toBe(false)
    expect(await isStrictHeld(db as any, "orders", "c")).toBe(false)
    expect(await isStrictHeld(db as any, "shop_orders", "a")).toBe(false)
  })
  it("read error = held (never release what we cannot classify)", async () => {
    db.failSelect = (t) => (t === "mtn_strict_holds" ? { message: "down" } : null)
    expect(await isStrictHeld(db as any, "orders", "a")).toBe(true)
  })
  it("table missing (0194 not applied yet) = not held, so today's releases keep working", async () => {
    db.failSelect = (t) => (t === "mtn_strict_holds" ? ({ code: "PGRST205", message: "Could not find the table" } as any) : null)
    expect(await isStrictHeld(db as any, "orders", "a")).toBe(false)
    db.failSelect = (t) => (t === "mtn_strict_holds" ? ({ code: "42P01", message: "relation does not exist" } as any) : null)
    expect(await isStrictHeld(db as any, "orders", "a")).toBe(false)
  })
})

function seedTwoHeld() {
  db.tables.orders = [
    { id: "strict", status: "held_registration", phone_number: "0551111111" },
    { id: "reg", status: "held_registration", phone_number: "0552222222" },
  ]
  db.tables.mtn_strict_holds = [{ order_table: "orders", order_id: "strict", phone: "0551111111", reason: "rejected", state: "open" }]
  db.tables.mtn_number_registry = [
    { phone: "0551111111", status: "registered" },
    { phone: "0552222222", status: "registered" },
  ]
}

describe("old releasers skip open strict holds", () => {
  it("releaseHeldMtnOrders releases the registration hold only", async () => {
    seedTwoHeld()
    const r = await releaseHeldMtnOrders()
    expect(r.released).toBe(1)
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(processManualFulfillment.mock.calls[0][0]).toBe("reg")
    expect(db.tables.orders.find((o) => o.id === "strict")!.status).toBe("held_registration")
  })

  it("releaseWhitelistHeldOrders releases the registration hold only", async () => {
    seedTwoHeld()
    const r = await releaseWhitelistHeldOrders(["0551111111", "0552222222"])
    expect(r.released).toBe(1)
    expect(processManualFulfillment).toHaveBeenCalledTimes(1)
    expect(processManualFulfillment.mock.calls[0][0]).toBe("reg")
    expect(db.tables.orders.find((o) => o.id === "strict")!.status).toBe("held_registration")
  })

  it("a released (closed) strict hold no longer blocks the old releasers", async () => {
    seedTwoHeld()
    db.tables.mtn_strict_holds[0].state = "expired"
    const r = await releaseHeldMtnOrders()
    expect(r.released).toBe(2)
  })

  it("getHeldOrderPhones leaves out strict-held orders", async () => {
    seedTwoHeld()
    expect(await getHeldOrderPhones()).toEqual(["0552222222"])
  })

  it("USSD strict hold is skipped too", async () => {
    db.tables.ussd_orders = [{ id: "u1", order_status: "held_registration", recipient_phone: "0553333333", network: "MTN", package_size: "1GB" }]
    db.tables.mtn_strict_holds = [{ order_table: "ussd_orders", order_id: "u1", state: "open" }]
    db.tables.mtn_number_registry = [{ phone: "0553333333", status: "registered" }]
    const r = await releaseHeldMtnOrders()
    expect(r.released).toBe(0)
    expect(fulfillUssdOrder).not.toHaveBeenCalled()
  })
})
