import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  prepareWalletAdjustment,
  prepareWithdrawalAction,
  prepareUserSuspension,
  prepareRoleChange,
  prepareBulkStatusUpdate,
} from "./prepare-admin"
import { EXPIRY_MS } from "./types"

type Row = Record<string, any>

/** In-memory fake of the query-builder slice the builders use. Filters rows for real. */
function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0
  tables.ai_drafts ??= []
  const db = {
    tables,
    from(table: string) {
      const rows = (tables[table] ??= [])
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" | "insert" = "select"
      let patch: Row = {}
      let inserted: Row | null = null
      const run = () => {
        if (op === "insert") {
          const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, status: "pending", ...inserted }
          rows.push(row)
          return { data: [row], error: null }
        }
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        return { data: matched.map((r) => ({ ...r })), error: null }
      }
      const b: any = {
        insert(r: Row) { op = "insert"; inserted = r; return b },
        update(p: Row) { op = "update"; patch = p; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        ilike(c: string, v: string) { filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return b },
        gte(c: string, v: string) { filters.push((r) => r[c] >= v); return b },
        lte(c: string, v: string) { filters.push((r) => r[c] <= v); return b },
        single() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: x.data.length ? null : { message: "no row" } }) },
        maybeSingle() { const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return db as unknown as SupabaseClient & { tables: Record<string, Row[]> }
}

const ADMIN = "11111111-1111-4111-8111-111111111111"
const TARGET = "22222222-2222-4222-8222-222222222222"
const ctx = { adminId: ADMIN, conversationKey: "conv-1" }
const REASON = "Customer paid twice by mistake"
const uid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`

const drafts = (db: any) => db.tables.ai_drafts as Row[]
const refusedCode = (r: any) => (r.refused ? r.code : null)

describe("prepareWalletAdjustment", () => {
  const base = { user_id: TARGET, type: "credit", amount: 50, reason: REASON }
  const mk = () => fakeDb({ users: [{ id: TARGET }], wallets: [{ user_id: TARGET, balance: 100 }] })

  it("drafts a credit with before/after and stores an admin draft", async () => {
    const db = mk()
    const r: any = await prepareWalletAdjustment(db, ctx, base)
    expect(r.draft_id).toBeTruthy()
    expect(r.display.balanceBefore).toBe(100)
    expect(r.display.balanceAfter).toBe(150)
    const d = drafts(db)[0]
    expect(d).toMatchObject({ user_id: ADMIN, context: "admin", action: "wallet_adjustment", amount_ghs: 50, conversation_key: "conv-1" })
    expect(d.params).toMatchObject({ targetUserId: TARGET, type: "credit", amount: 50, balanceBefore: 100 })
    expect(new Date(d.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(EXPIRY_MS.admin)
  })
  it("background drafts live 12 h", async () => {
    const db = mk()
    await prepareWalletAdjustment(db, { ...ctx, background: true }, base)
    expect(new Date(drafts(db)[0].expires_at).getTime() - Date.now()).toBeGreaterThan(EXPIRY_MS.admin)
  })
  it("refuses self", async () => {
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, user_id: ADMIN }))).toBe("self_not_allowed")
  })
  it("refuses amounts over 2000", async () => {
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, amount: 2000.01 }))).toBe("over_cap")
  })
  it("refuses bad amounts", async () => {
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, amount: 0 }))).toBe("invalid_amount")
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, amount: 1.005 }))).toBe("invalid_amount")
  })
  it("refuses a short or long reason", async () => {
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, reason: "oops" }))).toBe("reason_required")
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, reason: "x".repeat(501) }))).toBe("reason_required")
  })
  it("refuses a missing user", async () => {
    const db = fakeDb({ users: [], wallets: [] })
    expect(refusedCode(await prepareWalletAdjustment(db, ctx, base))).toBe("user_not_found")
  })
  it("refuses a debit below 0", async () => {
    expect(refusedCode(await prepareWalletAdjustment(mk(), ctx, { ...base, type: "debit", amount: 100.01 }))).toBe("insufficient_balance")
  })
  it("refuses without an admin id and writes nothing", async () => {
    const db = mk()
    expect(refusedCode(await prepareWalletAdjustment(db, { ...ctx, adminId: "" }, base))).toBe("admin_required")
    expect(drafts(db)).toHaveLength(0)
  })
})

describe("prepareWithdrawalAction", () => {
  const w = (n: number, status: string, amount: number, shop = "s" + n) => ({ id: uid(n), shop_id: shop, amount, status })
  const shops = [1, 2, 3, 4, 5, 6].map((n) => ({ id: "s" + n, shop_name: `Shop ${n}` }))

  it("withdrawal_display_totals: 3 ids -> count 3, total is the sum", async () => {
    const db = fakeDb({
      withdrawal_requests: [w(1, "pending", 100.1), w(2, "failed", 200.2), w(3, "pending", 300)],
      user_shops: shops,
    })
    const r: any = await prepareWithdrawalAction(db, ctx, { action: "approve", withdrawal_ids: [uid(1), uid(2), uid(3)] })
    expect(r.display.count).toBe(3)
    expect(r.display.totalGhs).toBe(600.3)
    expect(r.display.requesters).toHaveLength(3)
    expect(drafts(db)[0]).toMatchObject({ action: "withdrawal_action", amount_ghs: 600.3 })
    expect(drafts(db)[0].params.ids).toHaveLength(3)
  })
  it("shows only the first 5 requesters", async () => {
    const db = fakeDb({
      withdrawal_requests: [1, 2, 3, 4, 5, 6].map((n) => w(n, "pending", 10)),
      user_shops: shops,
    })
    const r: any = await prepareWithdrawalAction(db, ctx, { action: "approve", withdrawal_ids: [1, 2, 3, 4, 5, 6].map(uid) })
    expect(r.display.requesters).toHaveLength(5)
    expect(r.display.count).toBe(6)
  })
  it("refuses an id that does not exist", async () => {
    const db = fakeDb({ withdrawal_requests: [w(1, "pending", 10)], user_shops: shops })
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "approve", withdrawal_ids: [uid(1), uid(9)] }))).toBe("invalid_withdrawal_state")
  })
  it("refuses states a route would not accept", async () => {
    const db = fakeDb({ withdrawal_requests: [w(1, "approved", 10), w(2, "completed", 10)], user_shops: shops })
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "approve", withdrawal_ids: [uid(1)] }))).toBe("invalid_withdrawal_state")
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "complete", withdrawal_ids: [uid(1), uid(2)] }))).toBe("invalid_withdrawal_state")
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "reject", withdrawal_ids: [uid(2)], reason: REASON }))).toBe("invalid_withdrawal_state")
    const ok: any = await prepareWithdrawalAction(db, ctx, { action: "complete", withdrawal_ids: [uid(1)] })
    expect(ok.draft_id).toBeTruthy()
  })
  it("refuses a total over 10000", async () => {
    const db = fakeDb({ withdrawal_requests: [w(1, "pending", 6000), w(2, "pending", 4000.01)], user_shops: shops })
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "approve", withdrawal_ids: [uid(1), uid(2)] }))).toBe("over_cap")
  })
  it("reject needs a reason", async () => {
    const db = fakeDb({ withdrawal_requests: [w(1, "pending", 10)], user_shops: shops })
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "reject", withdrawal_ids: [uid(1)] }))).toBe("reason_required")
    expect(refusedCode(await prepareWithdrawalAction(db, ctx, { action: "reject", withdrawal_ids: [uid(1)], reason: "no" }))).toBe("reason_required")
    const ok: any = await prepareWithdrawalAction(db, ctx, { action: "reject", withdrawal_ids: [uid(1)], reason: REASON })
    expect(ok.draft_id).toBeTruthy()
    expect(drafts(db)[0].params.reason).toBe(REASON)
  })
})

describe("prepareUserSuspension", () => {
  it("drafts a suspension", async () => {
    const db = fakeDb({ users: [{ id: TARGET, is_suspended: false }] })
    const r: any = await prepareUserSuspension(db, ctx, { user_id: TARGET, suspend: true })
    expect(r.draft_id).toBeTruthy()
    expect(drafts(db)[0]).toMatchObject({ action: "user_suspension", amount_ghs: null })
  })
  it("refuses self, no-op and missing user", async () => {
    const db = fakeDb({ users: [{ id: TARGET, is_suspended: true }] })
    expect(refusedCode(await prepareUserSuspension(db, ctx, { user_id: ADMIN, suspend: true }))).toBe("self_not_allowed")
    expect(refusedCode(await prepareUserSuspension(db, ctx, { user_id: TARGET, suspend: true }))).toBe("no_change")
    expect(refusedCode(await prepareUserSuspension(fakeDb({ users: [] }), ctx, { user_id: TARGET, suspend: true }))).toBe("user_not_found")
  })
})

describe("prepareRoleChange", () => {
  it("drafts a system-role change", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "user" }], user_shops: [] })
    const r: any = await prepareRoleChange(db, ctx, { user_id: TARGET, role: "dealer" })
    expect(r.draft_id).toBeTruthy()
    expect(drafts(db)[0].params).toMatchObject({ targetUserId: TARGET, fromRole: "user", toRole: "dealer" })
  })
  it("refuses self", async () => {
    const db = fakeDb({ users: [{ id: ADMIN, role: "admin" }] })
    expect(refusedCode(await prepareRoleChange(db, ctx, { user_id: ADMIN, role: "user" }))).toBe("self_not_allowed")
  })
  it("refuses removing the last admin", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "admin" }] })
    expect(refusedCode(await prepareRoleChange(db, ctx, { user_id: TARGET, role: "user" }))).toBe("last_admin")
  })
  it("allows demoting an admin when another remains", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "admin" }, { id: ADMIN, role: "admin" }] })
    expect(((await prepareRoleChange(db, ctx, { user_id: TARGET, role: "user" })) as any).draft_id).toBeTruthy()
  })
  it("refuses an unknown or unassignable role", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "user" }] })
    expect(refusedCode(await prepareRoleChange(db, ctx, { user_id: TARGET, role: "superhero" }))).toBe("invalid_role")
  })
  it("refuses a no-op", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "dealer" }] })
    expect(refusedCode(await prepareRoleChange(db, ctx, { user_id: TARGET, role: "dealer" }))).toBe("no_change")
  })
  it("refuses a sub-agent becoming a dealer", async () => {
    const db = fakeDb({ users: [{ id: TARGET, role: "sub_agent" }], user_shops: [{ id: "s", user_id: TARGET, parent_shop_id: "p" }] })
    expect(refusedCode(await prepareRoleChange(db, ctx, { user_id: TARGET, role: "dealer" }))).toBe("invalid_role")
  })
})

describe("prepareBulkStatusUpdate", () => {
  it("bulk_ids_frozen_with_payment_guard: ids frozen in params, unpaid shop/ussd orders excluded", async () => {
    const db = fakeDb({
      orders: [{ id: uid(1), status: "pending", network: "mtn" }],
      shop_orders: [
        { id: uid(2), order_status: "pending", payment_status: "completed" },
        { id: uid(3), order_status: "pending", payment_status: "pending" },
      ],
      ussd_orders: [{ id: uid(4), order_status: "pending", payment_status: "failed" }],
      ussd_shop_orders: [{ id: uid(5), order_status: "pending", payment_status: "completed" }],
      api_orders: [{ id: uid(6), status: "pending" }],
    })
    const r: any = await prepareBulkStatusUpdate(db, ctx, { status: "failed", filters: { filter_status: "pending" } })
    expect(r.draft_id).toBeTruthy()
    const p = drafts(db)[0].params
    expect(p.idsByTable).toEqual({
      orders: [uid(1)],
      shop_orders: [uid(2)],
      ussd_orders: [],
      ussd_shop_orders: [uid(5)],
      api_orders: [uid(6)],
    })
    expect(p.status).toBe("failed")
    expect(r.display.total).toBe(4)
    expect(r.display.samples.length).toBeLessThanOrEqual(5)
  })
  it("refuses with no filters, no matches and more than 500", async () => {
    const empty = fakeDb({ orders: [], shop_orders: [], ussd_orders: [], ussd_shop_orders: [], api_orders: [] })
    expect(refusedCode(await prepareBulkStatusUpdate(empty, ctx, { status: "failed", filters: {} }))).toBe("filter_required")
    expect(refusedCode(await prepareBulkStatusUpdate(empty, ctx, { status: "failed", filters: { filter_status: "pending" } }))).toBe("no_matching_orders")
    const big = fakeDb({
      orders: Array.from({ length: 501 }, (_, i) => ({ id: uid(i + 1), status: "pending" })),
      shop_orders: [], ussd_orders: [], ussd_shop_orders: [], api_orders: [],
    })
    expect(refusedCode(await prepareBulkStatusUpdate(big, ctx, { status: "failed", filters: { filter_status: "pending" } }))).toBe("over_cap")
    expect(drafts(big)).toHaveLength(0)
  })
  it("refuses an invalid status", async () => {
    const empty = fakeDb({})
    expect(refusedCode(await prepareBulkStatusUpdate(empty, ctx, { status: "bogus", filters: { filter_status: "pending" } }))).toBe("invalid_status")
  })
})
