import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ getRoutingConfig: vi.fn() }))
vi.mock("./routing", () => ({ getRoutingConfig: h.getRoutingConfig }))

import {
  resolveOwnSenderProvider,
  resolveConfirmationSender,
  sendBilledConfirmation,
  decideConfirmationSend,
  UNBILLED_NOTIFY_TYPE,
} from "./order-confirmation"

type Res = { data: unknown; error?: { message: string; code?: string } | null }

/**
 * Chainable fake supabase client. `reads[table]` answers maybeSingle()/awaited selects;
 * `guard` answers the sms_order_confirmations upsert; every write is recorded in `calls`.
 */
function fakeDb(opts: {
  reads?: Record<string, Res>
  guard?: Res | (() => never)
  notifInsert?: Res
  notifExisting?: Res
}) {
  const calls: { table: string; op: string; args: unknown[]; filters: unknown[][] }[] = []
  const db = {
    calls,
    from(table: string) {
      const call = { table, op: "select", args: [] as unknown[], filters: [] as unknown[][] }
      const resolve = (): Res => {
        if (table === "sms_order_confirmations" && call.op === "upsert") {
          if (typeof opts.guard === "function") opts.guard()
          return (opts.guard as Res) ?? { data: [{ shop_order_id: "o1" }], error: null }
        }
        if (table === "notifications" && call.op === "insert") return opts.notifInsert ?? { data: null, error: null }
        if (table === "notifications" && call.op === "select") return opts.notifExisting ?? { data: null, error: null }
        if (call.op === "select") return opts.reads?.[table] ?? { data: null, error: null }
        return { data: null, error: null }
      }
      const c: any = {
        then: (ok: (r: Res) => unknown, bad: (e: unknown) => unknown) => {
          try { return Promise.resolve(resolve()).then(ok, bad) } catch (e) { return Promise.reject(e).then(ok, bad) }
        },
      }
      for (const m of ["eq", "gte", "order", "limit", "in"]) c[m] = (...a: unknown[]) => { call.filters.push([m, ...a]); return c }
      c.select = (...a: unknown[]) => { if (call.op === "select") call.args = a; return c }
      for (const op of ["insert", "update", "upsert"]) c[op] = (...a: unknown[]) => { call.op = op; call.args = a; calls.push(call); return c }
      c.maybeSingle = () => { try { return Promise.resolve(resolve()) } catch (e) { return Promise.reject(e) } }
      return c
    },
  }
  return db
}

const okResult = { ok: true as const, sendLogId: "77", total: 1, segments: 1, creditsReserved: 1, invalidSkipped: 0 }

const input = {
  shopOrderId: "o1", shopId: "s1", accountId: "a1", userId: "u1", senderId: "MYSHOP",
  phone: "0241234567", message: "Your order is confirmed",
}

// ---------------------------------------------------------------- resolveConfirmationSender
describe("resolveConfirmationSender", () => {
  const eligible = {
    shop_settings: { data: { order_confirmation_use_own_sender: true } },
    user_shops: { data: { user_id: "u1" } },
    sms_accounts: { data: { id: "a1", status: "active" } },
    sms_sender_ids: { data: { sender_id: "MYSHOP" } },
  }

  it("toggle on + active account + sender => own sender", async () => {
    expect(await resolveConfirmationSender("s1", fakeDb({ reads: eligible }))).toEqual({
      useOwnSender: true, accountId: "a1", userId: "u1", senderId: "MYSHOP",
    })
  })
  it("toggle off => platform sender", async () => {
    const r = await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, shop_settings: { data: { order_confirmation_use_own_sender: false } } } }))
    expect(r).toEqual({ useOwnSender: false })
  })
  it("no settings row => platform sender", async () => {
    expect(await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, shop_settings: { data: null } } }))).toEqual({ useOwnSender: false })
  })
  it("settings read error (e.g. column not migrated yet) => platform sender", async () => {
    const r = await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, shop_settings: { data: null, error: { message: "column does not exist" } } } }))
    expect(r).toEqual({ useOwnSender: false })
  })
  it("no active sender => platform sender", async () => {
    expect(await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, sms_sender_ids: { data: null } } }))).toEqual({ useOwnSender: false })
  })
  it("inactive / suspended account => platform sender", async () => {
    for (const status of ["inactive", "suspended"]) {
      const r = await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, sms_accounts: { data: { id: "a1", status } } } }))
      expect(r).toEqual({ useOwnSender: false })
    }
  })
  it("no sms account => platform sender", async () => {
    expect(await resolveConfirmationSender("s1", fakeDb({ reads: { ...eligible, sms_accounts: { data: null } } }))).toEqual({ useOwnSender: false })
  })
  it("never throws when the client itself throws", async () => {
    const db = { from: () => { throw new Error("boom") } }
    expect(await resolveConfirmationSender("s1", db)).toEqual({ useOwnSender: false })
  })
})

// ---------------------------------------------------------------- sendBilledConfirmation
describe("sendBilledConfirmation", () => {
  it("success => guard inserted first, enqueueSend called with source, send_log_id recorded, billed_sent", async () => {
    const db = fakeDb({})
    const order: string[] = []
    const enqueue = vi.fn(async () => { order.push("enqueue"); return okResult })
    const origFrom = db.from.bind(db)
    db.from = (t: string) => { order.push(t); return origFrom(t) }

    const r = await sendBilledConfirmation(input, { db, enqueue })
    expect(r.status).toBe("billed_sent")
    expect(order[0]).toBe("sms_order_confirmations")
    expect(order.indexOf("enqueue")).toBeGreaterThan(0)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith("u1", "a1", "Your order is confirmed", ["0241234567"], undefined, "MYSHOP", undefined, undefined, { source: "order_confirmation" })

    const guard = db.calls.find((c) => c.table === "sms_order_confirmations" && c.op === "upsert")!
    expect(guard.args[0]).toEqual({ shop_order_id: "o1", shop_id: "s1", sms_account_id: "a1", mode: "billed" })
    expect(guard.args[1]).toEqual({ onConflict: "shop_order_id", ignoreDuplicates: true })
    const upd = db.calls.find((c) => c.table === "sms_order_confirmations" && c.op === "update")!
    expect(upd.args[0]).toEqual({ send_log_id: 77 })
    expect(upd.filters).toContainEqual(["eq", "shop_order_id", "o1"])
    expect(db.calls.some((c) => c.table === "notifications")).toBe(false)
  })

  it("duplicate order id (guard conflict) => duplicate, nothing enqueued", async () => {
    const enqueue = vi.fn(async () => okResult)
    const db = fakeDb({ guard: { data: [], error: null } })
    expect((await sendBilledConfirmation(input, { db, enqueue })).status).toBe("duplicate")
    expect(enqueue).not.toHaveBeenCalled()
    expect(db.calls.filter((c) => c.op === "update")).toHaveLength(0)
  })

  it("guard unique violation surfaced as an error => duplicate", async () => {
    const enqueue = vi.fn(async () => okResult)
    const db = fakeDb({ guard: { data: null, error: { message: "duplicate key", code: "23505" } } })
    expect((await sendBilledConfirmation(input, { db, enqueue })).status).toBe("duplicate")
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("second call for the same order bills/sends nothing", async () => {
    const enqueue = vi.fn(async () => okResult)
    let seen = false
    const db = fakeDb({})
    const origFrom = db.from.bind(db)
    db.from = (t: string) => {
      const c = origFrom(t)
      if (t !== "sms_order_confirmations") return c
      const origUpsert = c.upsert
      c.upsert = (...a: unknown[]) => {
        const r = origUpsert(...a)
        r.select = () => ({ then: (ok: (x: Res) => unknown) => { const res = seen ? { data: [], error: null } : { data: [{ shop_order_id: "o1" }], error: null }; seen = true; return Promise.resolve(res).then(ok) } })
        return r
      }
      return c
    }
    expect((await sendBilledConfirmation(input, { db, enqueue })).status).toBe("billed_sent")
    expect((await sendBilledConfirmation(input, { db, enqueue })).status).toBe("duplicate")
    expect(enqueue).toHaveBeenCalledTimes(1)
  })

  it("guard insert DB error (not a unique violation) => fallback, nothing enqueued", async () => {
    const enqueue = vi.fn(async () => okResult)
    const db = fakeDb({ guard: { data: null, error: { message: "relation does not exist", code: "42P01" } } })
    const r = await sendBilledConfirmation(input, { db, enqueue })
    expect(r.status).toBe("fallback")
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("guard insert throws => fallback", async () => {
    const enqueue = vi.fn(async () => okResult)
    const db = fakeDb({ guard: () => { throw new Error("network") } })
    expect((await sendBilledConfirmation(input, { db, enqueue })).status).toBe("fallback")
    expect(enqueue).not.toHaveBeenCalled()
  })

  for (const error of ["BLOCKED", "SMS_DISABLED", "NOT_ACTIVATED", "SUSPENDED", "INVALID_SENDER_ID", "ENQUEUE_FAILED", "NO_VALID_RECIPIENTS"] as const) {
    it(`enqueue returns ${error} => fallback, guard mode free, no notification`, async () => {
      const db = fakeDb({})
      const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error }) })
      expect(r).toEqual({ status: "fallback", reason: error })
      const upd = db.calls.find((c) => c.table === "sms_order_confirmations" && c.op === "update")!
      expect(upd.args[0]).toEqual({ mode: "free" })
      expect(upd.filters).toContainEqual(["eq", "shop_order_id", "o1"])
      expect(db.calls.some((c) => c.table === "notifications")).toBe(false)
    })
  }

  it("enqueue throws => fallback, guard mode free", async () => {
    const db = fakeDb({})
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => { throw new Error("kaboom") } })
    expect(r.status).toBe("fallback")
    expect(db.calls.find((c) => c.op === "update")!.args[0]).toEqual({ mode: "free" })
  })

  it("fallback still returned when the mode=free update itself fails", async () => {
    const db = fakeDb({})
    const origFrom = db.from.bind(db)
    db.from = (t: string) => {
      const c = origFrom(t)
      c.update = () => { throw new Error("update down") }
      return c
    }
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "SMS_DISABLED" as const }) })
    expect(r.status).toBe("fallback")
  })

  it("billed_sent still returned when recording send_log_id fails", async () => {
    const db = fakeDb({})
    const origFrom = db.from.bind(db)
    db.from = (t: string) => {
      const c = origFrom(t)
      c.update = () => { throw new Error("update down") }
      return c
    }
    expect((await sendBilledConfirmation(input, { db, enqueue: async () => okResult })).status).toBe("billed_sent")
  })

  it("INSUFFICIENT_CREDITS => fallback + one notification to the owner when none today", async () => {
    const db = fakeDb({ notifExisting: { data: null, error: null } })
    const now = new Date("2026-10-11T15:30:00Z")
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" as const }), now: () => now })
    expect(r).toEqual({ status: "fallback", reason: "INSUFFICIENT_CREDITS" })
    const lookup = db.calls // selects aren't recorded as writes; check insert
    const ins = lookup.filter((c) => c.table === "notifications" && c.op === "insert")
    expect(ins).toHaveLength(1)
    const row = ins[0].args[0] as Record<string, unknown>
    expect(row).toMatchObject({ user_id: "u1", type: UNBILLED_NOTIFY_TYPE, read: false })
    expect(typeof row.title).toBe("string")
    expect(String(row.message)).toMatch(/platform sender/)
    expect(row.created_at).toBe(now.toISOString())
    expect(row.updated_at).toBe(now.toISOString())
  })

  it("INSUFFICIENT_CREDITS => dedupe: no notification when one already exists today", async () => {
    const db = fakeDb({ notifExisting: { data: { id: "n1" }, error: null } })
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" as const }) })
    expect(r.status).toBe("fallback")
    expect(db.calls.filter((c) => c.table === "notifications" && c.op === "insert")).toHaveLength(0)
  })

  it("dedupe lookup is scoped to owner, type and start of today (UTC = Ghana)", async () => {
    const filters: unknown[][] = []
    const db = fakeDb({ notifExisting: { data: null, error: null } })
    const origFrom = db.from.bind(db)
    db.from = (t: string) => {
      const c = origFrom(t)
      if (t === "notifications") {
        for (const m of ["eq", "gte"]) { const o = c[m]; c[m] = (...a: unknown[]) => { filters.push([m, ...a]); return o(...a) } }
      }
      return c
    }
    await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" as const }), now: () => new Date("2026-10-11T23:59:00Z") })
    expect(filters).toContainEqual(["eq", "user_id", "u1"])
    expect(filters).toContainEqual(["eq", "type", UNBILLED_NOTIFY_TYPE])
    expect(filters).toContainEqual(["gte", "created_at", "2026-10-11T00:00:00.000Z"])
  })

  it("INSUFFICIENT_CREDITS => notification lookup error skips notifying, still fallback", async () => {
    const db = fakeDb({ notifExisting: { data: null, error: { message: "x" } } })
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" as const }) })
    expect(r.status).toBe("fallback")
    expect(db.calls.filter((c) => c.table === "notifications" && c.op === "insert")).toHaveLength(0)
  })

  it("INSUFFICIENT_CREDITS => notification insert failure is swallowed", async () => {
    const db = fakeDb({ notifInsert: { data: null, error: { message: "x" } } })
    const r = await sendBilledConfirmation(input, { db, enqueue: async () => ({ ok: false, error: "INSUFFICIENT_CREDITS" as const }) })
    expect(r.status).toBe("fallback")
  })
})

describe("sendBilledConfirmation provider passthrough", () => {
  it("provider hubtel => enqueue opts include provider", async () => {
    const enqueue = vi.fn(async () => okResult)
    await sendBilledConfirmation({ ...input, provider: "hubtel" }, { db: fakeDb({}), enqueue })
    expect((enqueue.mock.calls[0] as unknown[])[8]).toEqual({ source: "order_confirmation", provider: "hubtel" })
  })
  it("no provider => opts is exactly { source } (no provider key)", async () => {
    const enqueue = vi.fn(async () => okResult)
    await sendBilledConfirmation(input, { db: fakeDb({}), enqueue })
    const opts = (enqueue.mock.calls[0] as unknown[])[8] as object
    expect(opts).toEqual({ source: "order_confirmation" })
    expect("provider" in opts).toBe(false)
  })
})

describe("resolveOwnSenderProvider", () => {
  beforeEach(() => { h.getRoutingConfig.mockReset() })
  it("returns the selected provider", async () => {
    h.getRoutingConfig.mockResolvedValue({ categoryProviders: { order_confirmation_own_sender: "hubtel" } })
    expect(await resolveOwnSenderProvider()).toBe("hubtel")
    h.getRoutingConfig.mockResolvedValue({ categoryProviders: { order_confirmation_own_sender: "moolre" } })
    expect(await resolveOwnSenderProvider()).toBe("moolre")
  })
  it("global => undefined", async () => {
    h.getRoutingConfig.mockResolvedValue({ categoryProviders: { order_confirmation_own_sender: "global" } })
    expect(await resolveOwnSenderProvider()).toBeUndefined()
  })
  it("failure => undefined", async () => {
    h.getRoutingConfig.mockImplementation(() => { throw new Error("db down") })
    expect(await resolveOwnSenderProvider()).toBeUndefined()
  })
})

// ---------------------------------------------------------------- decideConfirmationSend
describe("decideConfirmationSend", () => {
  it("skip toggle => none, regardless of anything else", () => {
    expect(decideConfirmationSend({ skipShopSms: true, useOwnSender: false })).toBe("none")
    expect(decideConfirmationSend({ skipShopSms: true, useOwnSender: true })).toBe("none")
    expect(decideConfirmationSend({ skipShopSms: true, useOwnSender: true, billedStatus: "fallback" })).toBe("none")
  })
  it("not own sender => free (no senderId)", () => {
    expect(decideConfirmationSend({ skipShopSms: false, useOwnSender: false })).toBe("free")
  })
  it("own sender, not attempted yet => billed", () => {
    expect(decideConfirmationSend({ skipShopSms: false, useOwnSender: true })).toBe("billed")
  })
  it("billed_sent / duplicate => none (never also send the free one)", () => {
    expect(decideConfirmationSend({ skipShopSms: false, useOwnSender: true, billedStatus: "billed_sent" })).toBe("none")
    expect(decideConfirmationSend({ skipShopSms: false, useOwnSender: true, billedStatus: "duplicate" })).toBe("none")
  })
  it("fallback => free", () => {
    expect(decideConfirmationSend({ skipShopSms: false, useOwnSender: true, billedStatus: "fallback" })).toBe("free")
  })
})
