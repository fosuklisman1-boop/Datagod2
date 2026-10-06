// lib/ussd-hubtel/resolve.test.ts
import { describe, it, expect, vi } from "vitest"
import { resolveNeedsReview } from "./resolve"

/** select→eq→maybeSingle returns `row`; update chain records filters; `matches: false` simulates losing the race. */
function fakeDb(row: any, opts: { matches?: boolean } = {}) {
  const updates: any[] = []
  const filters: Array<[string, string, unknown]> = []
  const audits: any[] = []
  const client: any = {
    from(table: string) {
      if (table === "admin_audit_log") return { insert: async (rows: any[]) => { audits.push(...rows); return { error: null } } }
      const read: any = { select: () => read, eq: () => read, maybeSingle: async () => ({ data: row, error: null }) }
      return {
        select: read.select,
        update: (patch: any) => {
          const u: any = {
            eq: (c: string, v: unknown) => { filters.push(["eq", c, v]); return u },
            is: (c: string, v: unknown) => { filters.push(["is", c, v]); return u },
            select: async () => {
              const ok = opts.matches !== false
              if (ok) updates.push(patch)
              return { data: ok ? [{ session_id: row?.session_id }] : [], error: null }
            },
          }
          return u
        },
      }
    },
  }
  return { client, updates, filters, audits }
}

const NOW = new Date("2026-10-06T12:00:00.000Z")
// Parked by an indeterminate expiry: no payment recorded, no callback due.
const parked = {
  session_id: "S1", order_table: "airtime_orders", order_id: "o1", state: "needs_review",
  callback_status: "not_due", paid_at: null, hubtel_order_id: null,
  callback_last_error: "status check indeterminate at expiry: relay down",
}
// Paid but held (e.g. under-payment or a failing handler): callback already due.
const paidHeld = { ...parked, callback_status: "pending", paid_at: "2026-10-06T11:00:00.000Z", hubtel_order_id: "H1", callback_last_error: "x" }

function run(row: any, over: Partial<Parameters<typeof resolveNeedsReview>[0]> = {}, opts: { matches?: boolean } = {}) {
  const db = fakeDb(row, opts)
  const fail = vi.fn(async () => {})
  const p = resolveNeedsReview({
    supabase: db.client, failHandlers: { airtime_orders: fail }, sessionId: "S1",
    outcome: "fulfilled", note: "Delivered manually via Digiwapy dashboard", adminId: "admin-1", now: NOW, ...over,
  })
  return { db, fail, p }
}

describe("resolveNeedsReview", () => {
  it("requires a 5-500 character note", async () => {
    const { p, db } = run(paidHeld, { note: " ok " })
    expect(await p).toMatchObject({ ok: false, status: 400 })
    expect(db.updates).toHaveLength(0)
  })
  it("404 for an unknown session", async () => {
    expect(await run(null).p).toMatchObject({ ok: false, status: 404 })
  })
  it("refuses a row that is not needs_review (review focus #7)", async () => {
    const { p, db } = run({ ...paidHeld, state: "fulfilled" })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(db.updates).toHaveLength(0)
  })
  it("fulfilled on a paid row: state fulfilled, callback untouched, guarded update, audited", async () => {
    const { p, db } = run(paidHeld)
    expect(await p).toEqual({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Callback left as pending." })
    expect(db.updates[0]).toMatchObject({
      state: "fulfilled", resolution_note: "Delivered manually via Digiwapy dashboard", resolved_by: "admin-1", resolved_at: NOW.toISOString(),
    })
    expect(db.updates[0]).not.toHaveProperty("callback_status")
    expect(db.filters).toContainEqual(["eq", "state", "needs_review"])
    expect(db.filters).toContainEqual(["eq", "callback_status", "pending"])
    expect(db.filters).not.toContainEqual(["is", "paid_at", null])
    expect(db.audits[0]).toMatchObject({ admin_id: "admin-1", action: "hubtel_resolve_needs_review", target_user_id: null })
  })
  it("fulfilled on a parked row WITH a Hubtel order id: callback becomes pending with a fresh paid_at", async () => {
    const { p, db } = run({ ...parked, hubtel_order_id: "H9" })
    expect(await p).toMatchObject({ ok: true, state: "fulfilled", callbackStatus: "pending", callbackNote: "Success callback queued." })
    expect(db.updates[0]).toMatchObject({ callback_status: "pending", paid_at: NOW.toISOString() })
    expect(db.filters).toContainEqual(["is", "paid_at", null])
  })
  it("fulfilled on a parked row WITHOUT a Hubtel order id: no callback, and it says so", async () => {
    const { p, db } = run(parked)
    const r = await p
    expect(r).toMatchObject({ ok: true, state: "fulfilled", callbackStatus: "not_due" })
    expect(r.ok && r.callbackNote).toMatch(/No Hubtel order id/)
    expect(db.updates[0]).not.toHaveProperty("callback_status")
  })
  it("not_paid is refused for a row with a recorded payment (review focus #7)", async () => {
    const { p, db, fail } = run(paidHeld, { outcome: "not_paid" })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(db.updates).toHaveLength(0)
    expect(fail).not.toHaveBeenCalled()
  })
  it("not_paid on a parked row: state failed and the order's fail handler runs", async () => {
    const { p, db, fail } = run(parked, { outcome: "not_paid", note: "Hubtel dashboard shows Unpaid" })
    expect(await p).toMatchObject({ ok: true, state: "failed", callbackStatus: "not_due" })
    expect(db.updates[0]).toMatchObject({ state: "failed" })
    expect(fail).toHaveBeenCalledWith("o1")
  })
  it("the row changed underneath (late webhook): 409, no fail handler, no audit (review focus #7)", async () => {
    const { p, db, fail } = run(parked, { outcome: "not_paid" }, { matches: false })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(fail).not.toHaveBeenCalled()
    expect(db.audits).toHaveLength(0)
  })
})
