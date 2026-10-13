import { describe, it, expect, vi, beforeEach } from "vitest"

type Result = { data: any; error: null | { message: string } }

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Result[]>,
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  audit: vi.fn((..._a: any[]) => Promise.resolve()),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      const q = h.tables[table] ?? []
      const result: Result = q.length > 1 ? q.shift()! : q[0] ?? { data: null, error: null }
      const c: any = {}
      for (const m of ["select", "update", "eq", "maybeSingle"]) c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))

import { setReviewHold } from "./review-hold-service"

const ACCT = "11111111-1111-4111-8111-111111111111"
const updates = (table: string) => h.ops.filter((o) => o.table === table && o.ops.some((x) => x.m === "update"))
const patchOf = (o: { ops: { m: string; args: any[] }[] }) => o.ops.find((x) => x.m === "update")!.args[0]
const eqs = (o: { ops: { m: string; args: any[] }[] }) => o.ops.filter((x) => x.m === "eq").map((x) => x.args)

beforeEach(() => { h.tables = {}; h.ops = []; h.audit.mockClear() })

describe("setReviewHold", () => {
  it("validates the account id and the flag before touching the DB", async () => {
    expect(await setReviewHold("admin1", "nope", false)).toEqual({ ok: false, error: "Invalid account id" })
    expect(await setReviewHold("admin1", ACCT, "yes" as any)).toEqual({ ok: false, error: "review_hold must be true or false" })
    expect(h.ops).toHaveLength(0)
  })

  it("unknown account → not found", async () => {
    h.tables.sms_accounts = [{ data: null, error: null }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: false, error: "Account not found", notFound: true })
  })

  it("lookup error → error", async () => {
    h.tables.sms_accounts = [{ data: null, error: { message: "boom" } }]
    expect((await setReviewHold("admin1", ACCT, false)).ok).toBe(false)
  })

  it("no change → idempotent no-op (no update, no audit)", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: false }, error: null }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: true, changed: false, review_hold: false, flagsClosed: 0 })
    expect(updates("sms_accounts")).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("clearing: conditional update, closes open INFO flags as dismissed, audits sms_review_hold_clear", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: true }, error: null }, { data: [{ id: ACCT }], error: null }]
    h.tables.sms_flags = [{ data: [{ id: "f1" }, { id: "f2" }], error: null }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: true, changed: true, review_hold: false, flagsClosed: 2 })

    const [acctUpd] = updates("sms_accounts")
    expect(patchOf(acctUpd)).toMatchObject({ review_hold: false })
    expect(eqs(acctUpd)).toEqual([["id", ACCT], ["review_hold", true]])

    const [flagUpd] = updates("sms_flags")
    expect(patchOf(flagUpd)).toMatchObject({ status: "dismissed", resolved_by: "admin1" })
    expect(eqs(flagUpd)).toEqual([["sms_account_id", ACCT], ["status", "open"], ["severity", "info"]])

    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_review_hold_clear", "u1", { accountId: ACCT, review_hold: true }, { accountId: ACCT, review_hold: false, flagsClosed: 2 })
  })

  it("placing on hold: no flags touched, audits sms_review_hold_set", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: false }, error: null }, { data: [{ id: ACCT }], error: null }]
    expect(await setReviewHold("admin1", ACCT, true)).toEqual({ ok: true, changed: true, review_hold: true, flagsClosed: 0 })
    expect(eqs(updates("sms_accounts")[0])).toEqual([["id", ACCT], ["review_hold", false]])
    expect(updates("sms_flags")).toHaveLength(0)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_review_hold_set", "u1", { accountId: ACCT, review_hold: false }, { accountId: ACCT, review_hold: true, flagsClosed: 0 })
  })

  it("lost a race (conditional update matched nothing) → no-op, no audit", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: true }, error: null }, { data: [], error: null }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: true, changed: false, review_hold: false, flagsClosed: 0 })
    expect(updates("sms_flags")).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("update error → error, no audit", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: true }, error: null }, { data: null, error: { message: "x" } }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: false, error: "Could not update the review hold" })
    expect(h.audit).not.toHaveBeenCalled()
  })

  it("hold cleared but closing flags fails → still ok (flagsClosed null) and audited", async () => {
    h.tables.sms_accounts = [{ data: { id: ACCT, user_id: "u1", review_hold: true }, error: null }, { data: [{ id: ACCT }], error: null }]
    h.tables.sms_flags = [{ data: null, error: { message: "x" } }]
    expect(await setReviewHold("admin1", ACCT, false)).toEqual({ ok: true, changed: true, review_hold: false, flagsClosed: null })
    expect(h.audit).toHaveBeenCalled()
  })
})
