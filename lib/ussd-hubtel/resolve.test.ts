// lib/ussd-hubtel/resolve.test.ts
import { describe, it, expect, vi } from "vitest"
import { resolveNeedsReview } from "./resolve"

/** select→eq→maybeSingle returns `row`; update chain records filters; `matches: false` simulates losing the race. */
function fakeDb(row: any, opts: { matches?: boolean; auditError?: any } = {}) {
  const updates: any[] = []
  const filters: Array<[string, string, unknown]> = []
  const audits: any[] = []
  const client: any = {
    from(table: string) {
      if (table === "admin_audit_log") return { insert: async (rows: any[]) => { audits.push(...rows); return { error: opts.auditError ?? null } } }
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

function run(row: any, over: Partial<Parameters<typeof resolveNeedsReview>[0]> = {}, opts: { matches?: boolean; auditError?: any } = {}) {
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
  it("(M2) not_paid update is guarded on the parked shape (needs_review, not_due, paid_at null)", async () => {
    const { p, db } = run(parked, { outcome: "not_paid", note: "Hubtel dashboard shows Unpaid" })
    await p
    expect(db.filters).toContainEqual(["eq", "session_id", "S1"])
    expect(db.filters).toContainEqual(["eq", "state", "needs_review"])
    expect(db.filters).toContainEqual(["eq", "callback_status", "not_due"])
    expect(db.filters).toContainEqual(["is", "paid_at", null])
  })
  it("(M2) not_paid whose fail handler throws: still resolved, but a warning tells the admin the order may still be payable", async () => {
    const db = fakeDb(parked)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await resolveNeedsReview({
      supabase: db.client, sessionId: "S1", outcome: "not_paid", note: "Hubtel dashboard shows Unpaid", adminId: "admin-1", now: NOW,
      failHandlers: { airtime_orders: async () => { throw Object.assign(new Error("update failed"), { details: "Failing row contains (0244123456)" }) } },
    })
    const logged = JSON.stringify(err.mock.calls)
    err.mockRestore()
    expect(r).toMatchObject({ ok: true, state: "failed" })
    expect(r.ok && r.warning).toMatch(/may still be payable/i)
    expect(r.ok && r.warning).toContain("airtime_orders")
    expect(logged).not.toContain("0244123456")
    expect(db.audits[0].new_value).toMatchObject({ warning: expect.stringMatching(/may still be payable/i) })
  })
  it("(M2) not_paid with no fail handler for the table: warning, order row untouched", async () => {
    const db = fakeDb(parked)
    const r = await resolveNeedsReview({
      supabase: db.client, failHandlers: {}, sessionId: "S1", outcome: "not_paid", note: "Hubtel dashboard shows Unpaid", adminId: "admin-1", now: NOW,
    })
    expect(r.ok && r.warning).toMatch(/may still be payable/i)
  })
  it("(M2) a clean resolution carries no warning", async () => {
    const r = await run(parked, { outcome: "not_paid", note: "Hubtel dashboard shows Unpaid" }).p
    expect(r).not.toHaveProperty("warning")
  })
  it("(M2) audit old_value includes paid_at, hubtel_order_id and amount_paid", async () => {
    const { p, db } = run({ ...paidHeld, amount_paid: 10.5 })
    await p
    expect(db.audits[0].old_value).toMatchObject({ paid_at: paidHeld.paid_at, hubtel_order_id: "H1", amount_paid: 10.5 })
  })
  it("(final I1) audit old_value includes review_reason (null when the row has none / pre-0108)", async () => {
    const a = run({ ...paidHeld, review_reason: "underpaid: after_charges 5 < expected 10" })
    await a.p
    expect(a.db.audits[0].old_value).toMatchObject({ review_reason: "underpaid: after_charges 5 < expected 10" })
    const b = run(paidHeld)
    await b.p
    expect(b.db.audits[0].old_value).toHaveProperty("review_reason", null)
  })
  it("(M2) an audit insert error does not fail the resolution and is logged without details", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const r = await run(paidHeld, {}, { auditError: { code: "23502", message: "null value", details: "Failing row contains (secret-note)" } }).p
    const logged = JSON.stringify(warn.mock.calls)
    warn.mockRestore()
    expect(r).toMatchObject({ ok: true })
    expect(logged).toContain("23502")
    expect(logged).not.toContain("secret-note")
  })
  it("the row changed underneath (late webhook): 409, no fail handler, no audit (review focus #7)", async () => {
    const { p, db, fail } = run(parked, { outcome: "not_paid" }, { matches: false })
    expect(await p).toMatchObject({ ok: false, status: 409 })
    expect(fail).not.toHaveBeenCalled()
    expect(db.audits).toHaveLength(0)
  })
})
