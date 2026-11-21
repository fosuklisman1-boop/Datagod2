import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const priceMock = vi.fn()
vi.mock("@/lib/pricing/wallet-order-price", () => ({
  walletOrderPrice: (...args: unknown[]) => priceMock(...args),
}))
const resolveMock = vi.fn()
vi.mock("./bulk-status-ids", () => ({
  resolveBulkStatusIds: (...args: unknown[]) => resolveMock(...args),
}))

import { confirmDraft, recheckDraft } from "./confirm"
import { PURCHASE_SETTLE_MS } from "./execute"

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
import { executeDraft, revalidateDraft } from "./execute"

type Row = Record<string, any>

/** In-memory fake of the slice of the Supabase builder used by repo.ts, execute.ts and confirm.ts. Really filters. */
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
        let matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        return { data: matched.map((r) => ({ ...r })), error: null as any }
      }
      const b: any = {
        update(p: Row) { op = "update"; patch = p; return b },
        insert(p: Row) { op = "insert"; inserted = { id: `task-${rows.length + 1}`, ...p }; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        is(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        gt(c: string, v: string) { filters.push((r) => r[c] > v); return b },
        lte(c: string, v: string) { filters.push((r) => r[c] <= v); return b },
        lt(c: string, v: string) { filters.push((r) => r[c] < v); return b },
        gte(c: string, v: string) { filters.push((r) => r[c] != null && r[c] >= v); return b },
        order() { return b },
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
const TARGET = "22222222-2222-4222-8222-222222222222"
const PKG = "33333333-3333-4333-8333-333333333333"
const DRAFT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const W1 = "b1111111-1111-4111-8111-111111111111"
const W2 = "b2222222-2222-4222-8222-222222222222"
const W3 = "b3333333-3333-4333-8333-333333333333"
const O1 = "c1111111-1111-4111-8111-111111111111"
const O2 = "c2222222-2222-4222-8222-222222222222"
const O3 = "c3333333-3333-4333-8333-333333333333"

const orderParams = { packageId: PKG, network: "mtn", size: "1GB", recipient: "0241234567", price: 5, balanceBefore: 20 }

function draftRow(over: Row = {}): Row {
  return {
    id: DRAFT,
    user_id: USER,
    context: "dashboard",
    action: "wallet_order",
    params: orderParams,
    display: { title: "Confirm data order" },
    amount_ghs: 5,
    status: "pending",
    outcome: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    conversation_key: "conv-1",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    executed_at: null,
    ...over,
  }
}

function baseTables(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    ai_drafts: [draftRow()],
    packages: [{ id: PKG, network: "MTN", size: "1GB", price: 5, dealer_price: 4, is_available: true }],
    users: [{ id: USER, role: "user" }, { id: TARGET, role: "user", is_suspended: false }],
    wallets: [{ user_id: TARGET, balance: 100 }, { user_id: USER, balance: 20 }],
    orders: [],
    withdrawal_requests: [],
    ...over,
  }
}

const res = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
const caller = (fetchImpl: any, over: Record<string, unknown> = {}) => ({
  userId: USER,
  isAdmin: false,
  jwt: "jwt-abc",
  baseUrl: "https://app.test",
  fetchImpl,
  ...over,
})

beforeEach(() => {
  priceMock.mockReset()
  priceMock.mockResolvedValue(5)
  resolveMock.mockReset()
})

describe("confirmDraft", () => {
  it("confirm_race_one_executes", async () => {
    const db = fakeDb(baseTables())
    let release!: (v: unknown) => void
    const gate = new Promise((r) => (release = r))
    const fetchFn = vi.fn(async () => {
      await gate
      return res(200, { success: true, order: { order_code: "ORD-1" }, newBalance: 15 })
    })
    const p1 = confirmDraft(db, DRAFT, caller(fetchFn))
    const p2 = confirmDraft(db, DRAFT, caller(fetchFn))
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 5))
    release(null)
    const results = await Promise.all([p1, p2])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const statuses = results.map((r) => r!.status).sort()
    expect(statuses).toEqual(["executing", "succeeded"])
    // A later tap on the used card is a replay.
    const third = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(third!.status).toBe("already_done")
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it("returns null for a draft the caller does not own", async () => {
    const db = fakeDb(baseTables())
    const fetchFn = vi.fn()
    expect(await confirmDraft(db, DRAFT, caller(fetchFn, { userId: TARGET }))).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("terminal_returns_stored_outcome", async () => {
    const stored = { order_code: "ORD-9", new_balance: 15 }
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "succeeded", outcome: stored })] }))
    const fetchFn = vi.fn()
    const out = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(out!.status).toBe("already_done")
    expect(out!.finalStatus).toBe("succeeded")
    expect(out!.outcome).toEqual(stored)
    expect(fetchFn).not.toHaveBeenCalled()

    const db2 = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "failed", outcome: { code: "insufficient_balance" } })] }))
    const out2 = await confirmDraft(db2, DRAFT, caller(fetchFn))
    expect(out2!.status).toBe("failed")
    expect(out2!.outcome).toEqual({ code: "insufficient_balance" })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("expired_marks_expired_no_call", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ expires_at: new Date(Date.now() - 1000).toISOString() })] }))
    const fetchFn = vi.fn()
    const out = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(out!.status).toBe("expired")
    expect(db.tables.ai_drafts[0].status).toBe("expired")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("price_changed_no_call", async () => {
    priceMock.mockResolvedValue(6)
    const db = fakeDb(baseTables())
    const fetchFn = vi.fn()
    const out = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "price_changed", oldPrice: 5, newPrice: 6 })
    expect(db.tables.ai_drafts[0].status).toBe("failed")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("admin_action_requires_isAdmin", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "wallet_adjustment",
            params: { targetUserId: TARGET, type: "credit", amount: 10, reason: "goodwill credit", balanceBefore: 100 },
          }),
        ],
      }),
    )
    const fetchFn = vi.fn()
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: false }))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "admin_required" })
    expect(db.tables.ai_drafts[0].status).toBe("pending")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("withdrawal_partial", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "withdrawal_action",
            params: { action: "approve", ids: [W1, W2, W3], totalGhs: 30 },
          }),
        ],
        withdrawal_requests: [
          { id: W1, status: "pending" },
          { id: W2, status: "pending" },
          { id: W3, status: "pending" },
        ],
      }),
    )
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(res(200, { success: true }))
      .mockResolvedValueOnce(res(400, { error: "Cannot approve withdrawal with status: approved" }))
      .mockResolvedValueOnce(res(200, { success: true }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
    expect(out!.status).toBe("partial")
    expect(db.tables.ai_drafts[0].status).toBe("partial")
    const results = out!.outcome!.results as Array<{ id: string; ok: boolean; error?: string }>
    expect(results.map((r) => [r.id, r.ok])).toEqual([[W1, true], [W2, false], [W3, true]])
    expect(results[1].error).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledTimes(3)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://app.test/api/admin/withdrawals/approve")
    expect(JSON.parse(init.body)).toEqual({ withdrawalId: W1 })
    expect(init.headers.Authorization).toBe("Bearer jwt-abc")
  })

  it("withdrawal drops ids that moved on and fails when none are left", async () => {
    const mk = (statuses: [string, string]) =>
      fakeDb(
        baseTables({
          ai_drafts: [draftRow({ context: "admin", action: "withdrawal_action", params: { action: "approve", ids: [W1, W2], totalGhs: 20 } })],
          withdrawal_requests: [{ id: W1, status: statuses[0] }, { id: W2, status: statuses[1] }],
        }),
      )
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true }))
    const out = await confirmDraft(mk(["pending", "completed"]), DRAFT, caller(fetchFn, { isAdmin: true }))
    // skipped_with_all_ok_is_partial (R14)
    expect(out!.status).toBe("partial")
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchFn.mock.calls[0][1].body).withdrawalId).toBe(W1)
    expect(out!.outcome).toMatchObject({ skipped: 1 })

    const fetch2 = vi.fn()
    const out2 = await confirmDraft(mk(["completed", "rejected"]), DRAFT, caller(fetch2, { isAdmin: true }))
    expect(out2!.status).toBe("failed")
    expect(out2!.outcome).toMatchObject({ code: "all_changed" })
    expect(fetch2).not.toHaveBeenCalled()
  })

  it("bulk_skips_changed_ids", async () => {
    resolveMock.mockResolvedValue({ orders: [O1, O3], shop_orders: [], ussd_orders: [], ussd_shop_orders: [], api_orders: [] })
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "bulk_status_update",
            params: {
              status: "failed",
              idsByTable: { orders: [O1, O2, O3], shop_orders: [], ussd_orders: [], ussd_shop_orders: [], api_orders: [] },
              filter: { filter_status: "pending" },
            },
          }),
        ],
      }),
    )
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true, bulkCount: 2 }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://app.test/api/admin/orders/bulk-update-status")
    expect(JSON.parse(init.body)).toEqual({ orderIds: [O1, O3], status: "failed", orderType: "orders" })
    expect(out!.status).toBe("partial")
    expect(out!.outcome).toMatchObject({ applied: 2, skipped: 1 })
  })

  describe("multi-id progress and heartbeat", () => {
    const wdDraft = () =>
      draftRow({ context: "admin", action: "withdrawal_action", params: { action: "approve", ids: [W1, W2, W3], totalGhs: 30 } })
    const wdTables = () => ({
      ai_drafts: [wdDraft()],
      withdrawal_requests: [
        { id: W1, status: "pending" },
        { id: W2, status: "pending" },
        { id: W3, status: "pending" },
      ],
    })

    it("multi_id_run_heartbeats_updated_at", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        const db = fakeDb(baseTables(wdTables()))
        const seen: Array<{ updated: string; status: string; sent: unknown; results: number }> = []
        const fetchFn = vi.fn(async () => {
          vi.setSystemTime(Date.now() + 40_000)
          const row = db.tables.ai_drafts[0]
          seen.push({ updated: row.updated_at, status: row.status, sent: row.outcome?.sentIds, results: row.outcome?.results?.length ?? -1 })
          return res(200, { success: true })
        })
        await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
        expect(fetchFn).toHaveBeenCalledTimes(3)
        // Before call 1 the narrowed list is already persisted with empty results; before each later call one more result.
        expect(seen.map((s) => s.results)).toEqual([0, 1, 2])
        expect(seen.every((s) => s.status === "executing")).toBe(true)
        expect(seen[0].sent).toEqual([W1, W2, W3])
        const stamps = seen.map((s) => Date.parse(s.updated))
        expect(stamps[1]).toBeGreaterThan(stamps[0])
        expect(stamps[2]).toBeGreaterThan(stamps[1])
      } finally {
        vi.useRealTimers()
      }
    })

    it("stale_recovery_not_triggered_during_heartbeating_run", async () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        const db = fakeDb(baseTables(wdTables()))
        let tap: any = null
        let calls = 0
        const fetchFn = vi.fn(async () => {
          calls++
          vi.setSystemTime(Date.now() + 40_000) // 80 s since the claim by call 2, but only 40 s since the last heartbeat
          if (calls === 2) tap = await confirmDraft(db, DRAFT, caller(vi.fn(), { isAdmin: true }))
          return res(200, { success: true })
        })
        const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
        expect(tap.status).toBe("executing")
        expect(out!.status).toBe("succeeded")
        expect(db.tables.ai_drafts[0].status).toBe("succeeded")
        expect(db.tables.ai_drafts[0].outcome.results).toHaveLength(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it("progress_write_lost_stops_further_sends", async () => {
      const db = fakeDb(baseTables(wdTables()))
      const fetchFn = vi.fn(async () => {
        // The run is recovered/stolen while call 1 is in flight.
        db.tables.ai_drafts[0].status = "unknown"
        return res(200, { success: true })
      })
      const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(out!.status).toBe("unknown")
      expect((out!.outcome!.results as unknown[]).length).toBe(1)
    })
  })

  it("wallet_adjust_sends_expectedBalance_and_reason", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "wallet_adjustment",
            params: { targetUserId: TARGET, type: "credit", amount: 10, reason: "goodwill credit", balanceBefore: 100 },
          }),
        ],
      }),
    )
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true, balance: 110 }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
    expect(out!.status).toBe("succeeded")
    expect(out!.outcome).toMatchObject({ new_balance: 110 })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://app.test/api/admin/update-balance")
    expect(JSON.parse(init.body)).toEqual({ userId: TARGET, type: "credit", amount: 10, reason: "goodwill credit", expectedBalance: 100 })
  })

  it("wallet_adjust_replay_balance_changed_to_already_done", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "wallet_adjustment",
            params: { targetUserId: TARGET, type: "credit", amount: 10, reason: "goodwill credit", balanceBefore: 100 },
          }),
        ],
        wallets: [{ user_id: TARGET, balance: 110 }],
      }),
    )
    const fetchFn = vi.fn().mockResolvedValue(res(409, { error: "The balance changed since you confirmed. Review the new balance and try again." }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
    expect(out!.status).toBe("already_done")
    expect(out!.finalStatus).toBe("succeeded")
    expect(db.tables.ai_drafts[0].status).toBe("succeeded")
  })

  it("wallet_adjust balance changed to something else fails with balance_changed", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            context: "admin",
            action: "wallet_adjustment",
            params: { targetUserId: TARGET, type: "debit", amount: 10, reason: "chargeback fix", balanceBefore: 100 },
          }),
        ],
        wallets: [{ user_id: TARGET, balance: 150 }],
      }),
    )
    const fetchFn = vi.fn().mockResolvedValue(res(409, { error: "The balance changed since you confirmed. Review the new balance and try again." }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "balance_changed" })
  })

  it("suspension and role change call their endpoints with the right bodies", async () => {
    const dbS = fakeDb(
      baseTables({ ai_drafts: [draftRow({ context: "admin", action: "user_suspension", params: { targetUserId: TARGET, suspend: true } })] }),
    )
    const f1 = vi.fn().mockResolvedValue(res(200, { success: true }))
    const o1 = await confirmDraft(dbS, DRAFT, caller(f1, { isAdmin: true }))
    expect(o1!.status).toBe("succeeded")
    expect(f1.mock.calls[0][0]).toBe("https://app.test/api/admin/users/suspend")
    expect(JSON.parse(f1.mock.calls[0][1].body)).toEqual({ userId: TARGET, action: "suspend" })

    const dbR = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ context: "admin", action: "role_change", params: { targetUserId: TARGET, fromRole: "user", toRole: "dealer" } })],
      }),
    )
    const f2 = vi.fn().mockResolvedValue(res(200, { success: true }))
    const o2 = await confirmDraft(dbR, DRAFT, caller(f2, { isAdmin: true }))
    expect(o2!.status).toBe("succeeded")
    expect(f2.mock.calls[0][0]).toBe("https://app.test/api/admin/users/update-role")
    expect(JSON.parse(f2.mock.calls[0][1].body)).toEqual({ userId: TARGET, role: "dealer" })
  })

  it("purchase sends packageId, fresh package network, recipient and the draft id as idempotencyKey", async () => {
    const db = fakeDb(baseTables())
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true, order: { order_code: "ORD-77" }, newBalance: 15 }))
    const out = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(out!.status).toBe("succeeded")
    expect(out!.outcome).toMatchObject({ order_code: "ORD-77", new_balance: 15 })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe("https://app.test/api/orders/purchase")
    // Network comes from the package row read at revalidation ("MTN"), not the stored params ("mtn").
    expect(JSON.parse(init.body)).toEqual({ packageId: PKG, phoneNumber: "0241234567", network: "MTN", idempotencyKey: DRAFT })
  })

  it("revalidation reads the role from users.role", async () => {
    const db = fakeDb(baseTables({ users: [{ id: USER, role: "dealer" }] }))
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true, order: { order_code: "X" } }))
    await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(priceMock).toHaveBeenCalledTimes(1)
    expect(priceMock.mock.calls[0][1]).toBe(USER)
    expect(priceMock.mock.calls[0][2]).toBe("dealer")
  })
})

describe("executeDraft mapping", () => {
  const draft = () => draftRow({ status: "executing" }) as any

  it("402 maps to insufficient_balance", async () => {
    const f = vi.fn().mockResolvedValue(res(402, { error: "Insufficient balance", required: 5, available: 1 }))
    const out = await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("failed")
    expect(out.outcome).toMatchObject({ code: "insufficient_balance" })
  })

  it("alreadyPlaced maps to succeeded", async () => {
    const f = vi.fn().mockResolvedValue(res(200, { success: true, alreadyPlaced: true, order: { order_code: "ORD-5" }, newBalance: 9 }))
    const out = await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("succeeded")
    expect(out.outcome).toMatchObject({ alreadyPlaced: true, order_code: "ORD-5" })
  })

  it("a thrown fetch maps to unknown", async () => {
    const f = vi.fn().mockRejectedValue(new Error("socket hang up"))
    const out = await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("unknown")
  })

  it("a timeout aborts the call and maps to unknown", async () => {
    const f = vi.fn((_url: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))))
    const out = await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f as any, timeoutMs: 20 })
    expect(out.status).toBe("unknown")
  })

  it("purchase 5xx is ambiguous (unknown); a duplicate 409 is unknown too", async () => {
    const f5 = vi.fn().mockResolvedValue(res(500, { error: "Failed to create order" }))
    expect((await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f5 })).status).toBe("unknown")
    const f9 = vi.fn().mockResolvedValue(res(409, { error: "Duplicate request" }))
    expect((await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f9 })).status).toBe("unknown")
  })

  it("purchase 4xx maps to rejected with the endpoint message", async () => {
    const f = vi.fn().mockResolvedValue(res(409, { error: "Number not verified", code: "NOT_VERIFIED" }))
    const out = await executeDraft(draft(), { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("failed")
    expect(out.outcome).toMatchObject({ code: "NOT_VERIFIED", message: "Number not verified" })
  })

  it("admin endpoint 5xx maps to failed endpoint_error", async () => {
    const f = vi.fn().mockResolvedValue(res(500, { error: "boom" }))
    const d = draftRow({ status: "executing", context: "admin", action: "user_suspension", params: { targetUserId: TARGET, suspend: true } }) as any
    const out = await executeDraft(d, { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("failed")
    expect(out.outcome).toMatchObject({ code: "endpoint_error" })
  })

  it("confirm_with_schedule_creates_task_not_order", async () => {
    const f = vi.fn()
    const db = fakeDb(baseTables({ ai_scheduled_tasks: [] }))
    const d = draftRow({ status: "executing", params: { ...orderParams, schedule: { type: "daily", runAtTime: "08:00" } } }) as any
    const out = await executeDraft(d, { baseUrl: "https://app.test", jwt: "j", fetchImpl: f, db })
    expect(f).not.toHaveBeenCalled() // no order placed at confirm
    expect(out.status).toBe("succeeded")
    expect(out.outcome).toMatchObject({ code: "scheduled" })
    expect(typeof out.outcome.task_id).toBe("string")
    expect(Number.isFinite(Date.parse(String(out.outcome.next_run_at)))).toBe(true)
    const row = db.tables.ai_scheduled_tasks[0]
    expect(row).toMatchObject({
      user_id: USER, approved_draft_id: DRAFT, is_active: true,
      standing_order: { package_id: PKG, network: "mtn", size: "1GB", recipient: "0241234567", max_price_ghs: 5 },
    })
  })

  it("a scheduled confirm without a db fails closed and places nothing", async () => {
    const f = vi.fn()
    const d = draftRow({ status: "executing", params: { ...orderParams, schedule: { type: "daily", runAtTime: "08:00" } } }) as any
    const out = await executeDraft(d, { baseUrl: "https://app.test", jwt: "j", fetchImpl: f })
    expect(out.status).toBe("failed")
    expect(f).not.toHaveBeenCalled()
  })
})

describe("revalidateDraft", () => {
  it("fails with package_unavailable when the package is gone or disabled", async () => {
    const db = fakeDb(baseTables({ packages: [{ id: PKG, network: "MTN", size: "1GB", price: 5, dealer_price: 4, is_available: false }] }))
    const out = await revalidateDraft(db, draftRow({ status: "executing" }) as any)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.outcome).toMatchObject({ code: "package_unavailable" })
  })

  it("fails with prices_unavailable when pricing throws", async () => {
    priceMock.mockRejectedValue(new Error("read failed"))
    const out = await revalidateDraft(fakeDb(baseTables()), draftRow({ status: "executing" }) as any)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.outcome).toMatchObject({ code: "prices_unavailable" })
  })
})

describe("recheckDraft", () => {
  it("unknown_purchase_recheck_finds_order_by_key", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ status: "unknown", outcome: { code: "no_response" } })],
        orders: [{ id: "o-1", idempotency_key: DRAFT, user_id: USER, order_code: "ORD-42" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("succeeded")
    expect(out!.outcome).toMatchObject({ order_code: "ORD-42" })
    expect(db.tables.ai_drafts[0].status).toBe("succeeded")
  })

  it("an order with the same key for a different user is not found", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ status: "unknown", executed_at: ago(PURCHASE_SETTLE_MS + 60_000) })],
        orders: [{ id: "o-1", idempotency_key: DRAFT, user_id: TARGET, order_code: "ORD-42" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("failed")
  })

  it("unknown_purchase_recheck_no_order", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "unknown", executed_at: ago(PURCHASE_SETTLE_MS + 60_000) })] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "not_placed" })
  })

  it("recheck_purchase_not_found_recent_still_checking", async () => {
    const stored = { code: "no_response", message: "We couldn't confirm the result." }
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "unknown", outcome: stored, executed_at: ago(60_000) })] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("unknown")
    expect(out!.outcome).toMatchObject({ code: "still_checking" })
    // Not written: the settle clock must not restart.
    expect(db.tables.ai_drafts[0].status).toBe("unknown")
    expect(db.tables.ai_drafts[0].outcome).toEqual(stored)
    expect(db.tables.ai_drafts[0].executed_at).toBeTruthy()
  })

  it("recheck_purchase_not_found_after_settle_failed", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "unknown", executed_at: ago(PURCHASE_SETTLE_MS + 1_000) })] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "not_placed" })
  })

  it("recovered draft with no executed_at settles from the original claim time", async () => {
    const recent = draftRow({ status: "unknown", executed_at: null, outcome: { code: "interrupted", claimed_at: ago(60_000) } })
    const dbRecent = fakeDb(baseTables({ ai_drafts: [recent] }))
    expect((await recheckDraft(dbRecent, DRAFT, caller(vi.fn())))!.outcome).toMatchObject({ code: "still_checking" })
    const old = draftRow({ status: "unknown", executed_at: null, outcome: { code: "interrupted", claimed_at: ago(PURCHASE_SETTLE_MS + 1_000) } })
    const dbOld = fakeDb(baseTables({ ai_drafts: [old] }))
    expect((await recheckDraft(dbOld, DRAFT, caller(vi.fn())))!.status).toBe("failed")
  })

  const wdUnknown = (outcome: Record<string, unknown>) =>
    draftRow({
      status: "unknown",
      context: "admin",
      action: "withdrawal_action",
      params: { action: "approve", ids: [W1, W2, W3], totalGhs: 30 },
      outcome,
    })

  it("recheck_uses_sent_ids_after_lost_finish", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [wdUnknown({ code: "interrupted", sentIds: [W1], skipped: 2, results: [] })],
        withdrawal_requests: [{ id: W1, status: "approved" }, { id: W2, status: "pending" }, { id: W3, status: "pending" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn(), { isAdmin: true }))
    const results = out!.outcome!.results as Array<{ id: string; ok: boolean }>
    expect(results.map((r) => r.id)).toEqual([W1])
    // The one sent id applied, but ids were skipped at confirm: partial, not succeeded and not a false failure.
    expect(out!.status).toBe("partial")
  })

  it("recheck_keeps_recorded_results", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [wdUnknown({ code: "interrupted", sentIds: [W1, W2], results: [{ id: W1, ok: true }] })],
        // W1 reads back as pending, but its ok result was recorded and is not re-read.
        withdrawal_requests: [{ id: W1, status: "pending" }, { id: W2, status: "approved" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn(), { isAdmin: true }))
    const results = out!.outcome!.results as Array<{ id: string; ok: boolean }>
    expect(results.map((r) => [r.id, r.ok])).toEqual([[W1, true], [W2, true]])
    expect(out!.status).toBe("succeeded")
  })

  it("recheck_resolves_interrupted_purchase", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ status: "executing", updated_at: ago(120_000) })],
        orders: [{ id: "o-1", idempotency_key: DRAFT, user_id: USER, order_code: "ORD-8" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("succeeded")
    expect(out!.outcome).toMatchObject({ order_code: "ORD-8" })
    expect(db.tables.ai_drafts[0].status).toBe("succeeded")
  })

  it("confirm on a stale executing draft recovers it to unknown without calling an endpoint", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "executing", updated_at: ago(120_000) })] }))
    const fetchFn = vi.fn()
    const out = await confirmDraft(db, DRAFT, caller(fetchFn))
    expect(out!.status).toBe("unknown")
    expect(out!.outcome).toMatchObject({ code: "interrupted" })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("recheck on a non-unknown draft just returns its state", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [draftRow({ status: "failed", outcome: { code: "x" } })] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toEqual({ code: "x" })
  })

  const adjDraft = (over: Row = {}) =>
    draftRow({
      status: "unknown",
      context: "admin",
      action: "wallet_adjustment",
      params: { targetUserId: TARGET, type: "credit", amount: 10, reason: "goodwill credit", balanceBefore: 100 },
      ...over,
    })

  it("unknown_adjust_ambiguous_balance_stays_unknown", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [adjDraft()], wallets: [{ user_id: TARGET, balance: 137 }] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn(), { isAdmin: true }))
    expect(out!.status).toBe("unknown")
    expect(out!.outcome).toMatchObject({ code: "check_wallet_history" })
    expect(db.tables.ai_drafts[0].status).toBe("unknown")
  })

  it("unknown adjust: balance equals after succeeds, equals before is not_applied", async () => {
    const dbA = fakeDb(baseTables({ ai_drafts: [adjDraft()], wallets: [{ user_id: TARGET, balance: 110 }] }))
    expect((await recheckDraft(dbA, DRAFT, caller(vi.fn(), { isAdmin: true })))!.status).toBe("succeeded")
    const dbB = fakeDb(baseTables({ ai_drafts: [adjDraft()], wallets: [{ user_id: TARGET, balance: 100 }] }))
    const out = await recheckDraft(dbB, DRAFT, caller(vi.fn(), { isAdmin: true }))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "not_applied" })
  })

  it("recheck of an admin draft needs isAdmin", async () => {
    const db = fakeDb(baseTables({ ai_drafts: [adjDraft()], wallets: [{ user_id: TARGET, balance: 110 }] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn(), { isAdmin: false }))
    expect(out!.outcome).toMatchObject({ code: "admin_required" })
    expect(db.tables.ai_drafts[0].status).toBe("unknown")
  })

  it("unknown suspension and role compare the target's current state", async () => {
    const dbS = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ status: "unknown", context: "admin", action: "user_suspension", params: { targetUserId: TARGET, suspend: true } })],
        users: [{ id: TARGET, role: "user", is_suspended: true }],
      }),
    )
    expect((await recheckDraft(dbS, DRAFT, caller(vi.fn(), { isAdmin: true })))!.status).toBe("succeeded")
    const dbR = fakeDb(
      baseTables({
        ai_drafts: [draftRow({ status: "unknown", context: "admin", action: "role_change", params: { targetUserId: TARGET, fromRole: "user", toRole: "dealer" } })],
        users: [{ id: TARGET, role: "user" }],
      }),
    )
    const out = await recheckDraft(dbR, DRAFT, caller(vi.fn(), { isAdmin: true }))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "not_applied" })
  })

  it("unknown withdrawals re-read each id: some applied is partial", async () => {
    const db = fakeDb(
      baseTables({
        ai_drafts: [
          draftRow({
            status: "unknown",
            context: "admin",
            action: "withdrawal_action",
            params: { action: "reject", ids: [W1, W2], totalGhs: 20, reason: "bad details" },
            outcome: { results: [{ id: W1, ok: false, error: "no_response" }, { id: W2, ok: false, error: "http_400" }] },
          }),
        ],
        withdrawal_requests: [{ id: W1, status: "rejected" }, { id: W2, status: "pending" }],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn(), { isAdmin: true }))
    expect(out!.status).toBe("partial")
    const results = out!.outcome!.results as Array<{ id: string; ok: boolean }>
    expect(results.map((r) => [r.id, r.ok])).toEqual([[W1, true], [W2, false]])
  })
})

describe("final-review fixes", () => {
  const emptyIds = { orders: [], shop_orders: [], ussd_orders: [], ussd_shop_orders: [], api_orders: [] }
  const bulkDraft = (idsByTable: Record<string, string[]>) =>
    draftRow({
      context: "admin",
      action: "bulk_status_update",
      params: { status: "failed", idsByTable: { ...emptyIds, ...idsByTable }, filter: { filter_status: "pending" } },
    })
  const runBulk = async (idsByTable: Record<string, string[]>, body: Record<string, unknown>) => {
    resolveMock.mockResolvedValue({ ...emptyIds, ...idsByTable })
    const db = fakeDb(baseTables({ ai_drafts: [bulkDraft(idsByTable)] }))
    const fetchFn = vi.fn().mockResolvedValue(res(200, { success: true, ...body }))
    return confirmDraft(db, DRAFT, caller(fetchFn, { isAdmin: true }))
  }

  it("bulk_short_count_is_partial", async () => {
    const out = await runBulk({ orders: [O1, O2, O3] }, { bulkCount: 2, skippedPending: 0, skippedRefunding: 0 })
    expect(out!.status).toBe("partial")
    expect(out!.outcome).toMatchObject({ applied: 2 })
    expect((out!.outcome as any).results[0]).toMatchObject({ table: "orders", sent: 3, updated: 2, ok: false })
  })

  it("bulk_skipped_pending_reported", async () => {
    const out = await runBulk({ orders: [O1, O2] }, { bulkCount: 2, skippedPending: 3, skippedRefunding: 1 })
    expect(out!.status).toBe("partial")
    expect((out!.outcome as any).results[0]).toMatchObject({ table: "orders", sent: 2, updated: 2, skippedPending: 3, skippedRefunding: 1, ok: false })
    expect(out!.outcome).toMatchObject({ skippedPending: 3, skippedRefunding: 1 })
  })

  it("bulk_zero_updated_is_failed", async () => {
    const out = await runBulk({ orders: [O1, O2] }, { bulkCount: 0, skippedPending: 2, skippedRefunding: 0 })
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ applied: 0 })
  })

  it("bulk clean run stays succeeded", async () => {
    const out = await runBulk({ orders: [O1, O2] }, { bulkCount: 2, skippedPending: 0, skippedRefunding: 0 })
    expect(out!.status).toBe("succeeded")
    expect((out!.outcome as any).results[0]).toMatchObject({ ok: true, sent: 2, updated: 2 })
  })

  it("recheck_scheduled_draft_finds_task", async () => {
    const sched = draftRow({
      status: "unknown",
      executed_at: ago(PURCHASE_SETTLE_MS + 60_000),
      params: { ...orderParams, schedule: { type: "daily", run_at_time: "08:00" } },
    })
    const db = fakeDb(
      baseTables({
        ai_drafts: [sched],
        ai_scheduled_tasks: [
          { id: "t-other", approved_draft_id: DRAFT, user_id: TARGET, next_run_at: "2026-11-22T08:00:00Z" },
          { id: "t-1", approved_draft_id: DRAFT, user_id: USER, next_run_at: "2026-11-22T08:00:00Z" },
        ],
      }),
    )
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("succeeded")
    expect(out!.outcome).toMatchObject({ code: "scheduled", task_id: "t-1", next_run_at: "2026-11-22T08:00:00Z" })
  })

  it("recheck of a scheduled draft with no task after settle is not_placed", async () => {
    const sched = draftRow({
      status: "unknown",
      executed_at: ago(PURCHASE_SETTLE_MS + 60_000),
      params: { ...orderParams, schedule: { type: "daily", run_at_time: "08:00" } },
    })
    const db = fakeDb(baseTables({ ai_drafts: [sched], ai_scheduled_tasks: [] }))
    const out = await recheckDraft(db, DRAFT, caller(vi.fn()))
    expect(out!.status).toBe("failed")
    expect(out!.outcome).toMatchObject({ code: "not_placed" })
  })

  it("role_change_state_changed_fails", async () => {
    const d = draftRow({ context: "admin", action: "role_change", params: { targetUserId: TARGET, fromRole: "user", toRole: "dealer" } }) as any
    const db = fakeDb(baseTables({ users: [{ id: USER, role: "admin" }, { id: TARGET, role: "dealer" }] }))
    const out = await revalidateDraft(db, d)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.outcome).toMatchObject({ code: "state_changed" })
    expect((await revalidateDraft(fakeDb(baseTables()), d)).ok).toBe(true)
  })

  it("suspension_state_changed_fails", async () => {
    const d = draftRow({ context: "admin", action: "user_suspension", params: { targetUserId: TARGET, suspend: true } }) as any
    const db = fakeDb(baseTables({ users: [{ id: USER, role: "admin" }, { id: TARGET, role: "user", is_suspended: true }] }))
    const out = await revalidateDraft(db, d)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.outcome).toMatchObject({ code: "state_changed" })
    expect((await revalidateDraft(fakeDb(baseTables()), d)).ok).toBe(true)
  })
})
