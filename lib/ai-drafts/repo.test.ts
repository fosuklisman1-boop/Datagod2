import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  createDraft,
  getOwnDraft,
  claimDraft,
  finishDraft,
  expireIfDue,
  cancelDraft,
  terminalDraftsSince,
  recoverStaleExecuting,
} from "./repo"
import { paramsSchemaFor } from "./types"

type Row = Record<string, any>

/** In-memory fake of the slice of the Supabase query builder the repo uses. Actually filters rows. */
function fakeDb(rows: Row[] = [], opts: { failOn?: string } = {}) {
  let seq = 0
  const db = {
    rows,
    from(table: string) {
      if (table !== "ai_drafts") throw new Error(`unexpected table ${table}`)
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" | "insert" = "select"
      let patch: Row = {}
      let inserted: Row | null = null
      let orderBy: { col: string; asc: boolean } | null = null
      const run = () => {
        if (opts.failOn === op) return { data: null, error: { message: `boom ${op}` } }
        if (op === "insert") {
          const row = {
            id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
            status: "pending",
            outcome: null,
            executed_at: null,
            created_at: new Date(Date.now() + seq).toISOString(),
            updated_at: new Date().toISOString(),
            ...inserted,
          }
          rows.push(row)
          return { data: [row], error: null }
        }
        let matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") {
          matched.forEach((r) => Object.assign(r, patch))
        }
        if (orderBy) {
          const { col, asc } = orderBy
          matched = [...matched].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1))
        }
        return { data: matched.map((r) => ({ ...r })), error: null }
      }
      const b: any = {
        insert(r: Row) { op = "insert"; inserted = r; return b },
        update(p: Row) { op = "update"; patch = p; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        is(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        gt(c: string, v: string) { filters.push((r) => r[c] > v); return b },
        lte(c: string, v: string) { filters.push((r) => r[c] <= v); return b },
        lt(c: string, v: string) { filters.push((r) => r[c] < v); return b },
        gte(c: string, v: string) { filters.push((r) => r[c] != null && r[c] >= v); return b },
        order(col: string, o?: { ascending?: boolean }) { orderBy = { col, asc: o?.ascending !== false }; return b },
        single() { const x = run(); return Promise.resolve(x.error ? x : { data: x.data![0] ?? null, error: x.data!.length ? null : { message: "no row" } }) },
        maybeSingle() { const x = run(); return Promise.resolve(x.error ? x : { data: x.data![0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
  return db as unknown as SupabaseClient & { rows: Row[] }
}

const USER = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"
const PKG = "33333333-3333-4333-8333-333333333333"

const goodOrder = { packageId: PKG, network: "mtn", size: "1GB", recipient: "0241234567", price: 5, balanceBefore: 20 }

function input(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    context: "dashboard" as const,
    action: "wallet_order" as const,
    params: goodOrder,
    display: { title: "Buy 1GB" },
    amountGhs: 5,
    conversationKey: "conv-1",
    expiresInMs: 600_000,
    ...over,
  }
}

function pendingRow(over: Row = {}): Row {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: USER,
    context: "dashboard",
    action: "wallet_order",
    params: goodOrder,
    display: {},
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

describe("params schemas", () => {
  it("rejects_unknown_param_keys", () => {
    expect(paramsSchemaFor("wallet_order").safeParse({ ...goodOrder, sneaky: 1 }).success).toBe(false)
    expect(paramsSchemaFor("wallet_order").safeParse(goodOrder).success).toBe(true)
  })

  it("rejects_negative_amount", () => {
    const s = paramsSchemaFor("wallet_adjustment")
    const ok = { targetUserId: OTHER, type: "credit", amount: 10, reason: "x", balanceBefore: 0 }
    expect(s.safeParse(ok).success).toBe(true)
    expect(s.safeParse({ ...ok, amount: -1 }).success).toBe(false)
    expect(s.safeParse({ ...ok, amount: 0 }).success).toBe(false)
    expect(s.safeParse({ ...ok, amount: Infinity }).success).toBe(false)
  })

  it("rejects hourly schedule and empty withdrawal ids", () => {
    expect(paramsSchemaFor("wallet_order").safeParse({ ...goodOrder, schedule: { type: "hourly" } }).success).toBe(false)
    expect(paramsSchemaFor("withdrawal_action").safeParse({ action: "approve", ids: [], totalGhs: 5 }).success).toBe(false)
  })

  it("createDraft rejects invalid params without touching the db", async () => {
    const db = fakeDb()
    await expect(createDraft(db, input({ params: { ...goodOrder, price: -1 } }))).rejects.toThrow()
    expect(db.rows).toHaveLength(0)
  })
})

describe("createDraft", () => {
  it("inserts a pending draft with expiry", async () => {
    const db = fakeDb()
    const d = await createDraft(db, input())
    expect(d.status).toBe("pending")
    expect(d.user_id).toBe(USER)
    expect(d.amount_ghs).toBe(5)
    expect(new Date(d.expires_at).getTime()).toBeGreaterThan(Date.now() + 500_000)
  })

  it("new_draft_supersedes_older_pending_same_conversation", async () => {
    const older = pendingRow()
    const otherConv = pendingRow({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", conversation_key: "conv-2" })
    const otherUser = pendingRow({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", user_id: OTHER })
    const db = fakeDb([older, otherConv, otherUser])
    const d = await createDraft(db, input())
    expect(older.status).toBe("superseded")
    expect(otherConv.status).toBe("pending")
    expect(otherUser.status).toBe("pending")
    expect(d.status).toBe("pending")
  })

  it("null conversationKey supersedes nothing", async () => {
    const older = pendingRow({ conversation_key: null })
    const db = fakeDb([older])
    await createDraft(db, input({ conversationKey: null }))
    expect(older.status).toBe("pending")
  })

  it("throws on DB error", async () => {
    await expect(createDraft(fakeDb([], { failOn: "insert" }), input())).rejects.toThrow(/boom/)
  })
})

describe("claimDraft", () => {
  it("claim_only_from_pending", async () => {
    const db = fakeDb([pendingRow()])
    const first = await claimDraft(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", USER)
    expect(first?.status).toBe("executing")
    const second = await claimDraft(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", USER)
    expect(second).toBeNull()
  })

  it("claim_refuses_expired", async () => {
    const row = pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const db = fakeDb([row])
    expect(await claimDraft(db, row.id, USER)).toBeNull()
    expect(row.status).toBe("pending")
  })

  it("claim refuses a non-owner", async () => {
    const row = pendingRow()
    expect(await claimDraft(fakeDb([row]), row.id, OTHER)).toBeNull()
    expect(row.status).toBe("pending")
  })
})

describe("recoverStaleExecuting", () => {
  it("stale_executing_becomes_unknown", async () => {
    const claimedAt = new Date(Date.now() - 90_000).toISOString()
    const row = pendingRow({ status: "executing", updated_at: claimedAt })
    const out = await recoverStaleExecuting(fakeDb([row]), row as any)
    expect(out.status).toBe("unknown")
    expect(row.status).toBe("unknown")
    expect(row.outcome).toMatchObject({ code: "interrupted", claimed_at: claimedAt })
  })

  it("fresh_executing_untouched", async () => {
    const row = pendingRow({ status: "executing", updated_at: new Date(Date.now() - 5_000).toISOString() })
    const out = await recoverStaleExecuting(fakeDb([row]), row as any)
    expect(out.status).toBe("executing")
    expect(row.status).toBe("executing")
    expect(row.outcome).toBeNull()
  })

  it("non-executing drafts are returned as is", async () => {
    const row = pendingRow({ status: "succeeded", updated_at: new Date(Date.now() - 900_000).toISOString() })
    expect((await recoverStaleExecuting(fakeDb([row]), row as any)).status).toBe("succeeded")
  })

  it("re-reads when the conditional update matched nothing (finished meanwhile)", async () => {
    const stale = pendingRow({ status: "executing", updated_at: new Date(Date.now() - 90_000).toISOString() })
    const db = fakeDb([{ ...stale, status: "succeeded", outcome: { order_code: "X" } }])
    const out = await recoverStaleExecuting(db, stale as any)
    expect(out.status).toBe("succeeded")
  })
})

describe("cancelDraft", () => {
  it("cancel_only_owner_and_pending", async () => {
    const row = pendingRow()
    const db = fakeDb([row])
    expect(await cancelDraft(db, row.id, OTHER)).toBeNull()
    expect(row.status).toBe("pending")
    const done = await cancelDraft(db, row.id, USER)
    expect(done?.status).toBe("cancelled")
    expect(await cancelDraft(db, row.id, USER)).toBeNull()

    const executing = pendingRow({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "executing" })
    expect(await cancelDraft(fakeDb([executing]), executing.id, USER)).toBeNull()
    expect(executing.status).toBe("executing")
  })
})

describe("getOwnDraft / finishDraft / expireIfDue / terminalDraftsSince", () => {
  it("getOwnDraft returns only the owner's row", async () => {
    const row = pendingRow()
    const db = fakeDb([row])
    expect((await getOwnDraft(db, row.id, USER))?.id).toBe(row.id)
    expect(await getOwnDraft(db, row.id, OTHER)).toBeNull()
  })

  it("finishDraft sets status, outcome, executed_at for outcome statuses", async () => {
    const row = pendingRow({ status: "executing" })
    await finishDraft(fakeDb([row]), row.id, "succeeded", { order_code: "X1" })
    expect(row.status).toBe("succeeded")
    expect(row.outcome).toEqual({ order_code: "X1" })
    expect(row.executed_at).toBeTruthy()
  })

  it("finishDraft leaves executed_at unset for non-outcome statuses", async () => {
    const row = pendingRow({ status: "executing" })
    await finishDraft(fakeDb([row]), row.id, "cancelled", {})
    expect(row.executed_at).toBeNull()
    expect(row.updated_at).toBeTruthy()
  })

  it("finish_only_from_executing", async () => {
    for (const status of ["pending", "succeeded", "failed", "cancelled", "expired", "unknown"]) {
      const row = pendingRow({ status, outcome: { keep: true } })
      await expect(finishDraft(fakeDb([row]), row.id, "succeeded", { order_code: "X1" })).rejects.toThrow()
      expect(row.status).toBe(status)
      expect(row.outcome).toEqual({ keep: true })
    }
  })

  it("finishDraft can finish from an explicit status (unknown recheck)", async () => {
    const row = pendingRow({ status: "unknown" })
    await finishDraft(fakeDb([row]), row.id, "succeeded", { order_code: "X1" }, "unknown")
    expect(row.status).toBe("succeeded")
    const executing = pendingRow({ status: "executing" })
    await expect(finishDraft(fakeDb([executing]), executing.id, "succeeded", {}, "unknown")).rejects.toThrow()
  })

  it("finishDraft throws on DB error", async () => {
    await expect(finishDraft(fakeDb([pendingRow({ status: "executing" })], { failOn: "update" }), "x", "failed", {})).rejects.toThrow(/boom/)
  })

  it("expireIfDue expires only a due pending draft", async () => {
    const due = pendingRow({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const db = fakeDb([due])
    const out = await expireIfDue(db, due as any)
    expect(out.status).toBe("expired")
    expect(due.status).toBe("expired")

    const fresh = pendingRow({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })
    const out2 = await expireIfDue(fakeDb([fresh]), fresh as any)
    expect(out2.status).toBe("pending")
  })

  it("terminalDraftsSince returns finished drafts for the conversation after the cutoff", async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString()
    const old = new Date(Date.now() - 3_600_000).toISOString()
    const rows = [
      pendingRow({ id: "a1", status: "succeeded" }),
      pendingRow({ id: "a2", status: "pending" }),
      pendingRow({ id: "a3", status: "failed", updated_at: old }),
      pendingRow({ id: "a4", status: "succeeded", conversation_key: "conv-2" }),
      pendingRow({ id: "a5", status: "succeeded", user_id: OTHER }),
    ]
    const out = await terminalDraftsSince(fakeDb(rows), USER, "conv-1", t0)
    expect(out.map((d) => d.id)).toEqual(["a1"])
  })

  it("terminal_since_includes_cancelled_and_expired", async () => {
    const rows = ["succeeded", "partial", "failed", "unknown", "expired", "cancelled"].map((s) =>
      pendingRow({ id: `s-${s}`, status: s }),
    )
    const out = await terminalDraftsSince(fakeDb(rows), USER, "conv-1", new Date(Date.now() - 60_000).toISOString())
    expect(out.map((d) => d.status).sort()).toEqual(["cancelled", "expired", "failed", "partial", "succeeded", "unknown"])
  })

  it("terminal_since_excludes_superseded_and_pending", async () => {
    const rows = [
      pendingRow({ id: "p", status: "pending" }),
      pendingRow({ id: "x", status: "superseded" }),
      pendingRow({ id: "e", status: "executing" }),
    ]
    const out = await terminalDraftsSince(fakeDb(rows), USER, "conv-1", new Date(Date.now() - 60_000).toISOString())
    expect(out).toEqual([])
  })

  it("terminal_since_uses_updated_at", async () => {
    const t = (ms: number) => new Date(Date.now() + ms).toISOString()
    const rows = [
      // expired/cancelled never get executed_at; only updated_at places them
      pendingRow({ id: "late-cancel", status: "cancelled", executed_at: null, updated_at: t(-1000) }),
      pendingRow({ id: "old-expired", status: "expired", executed_at: null, updated_at: t(-3_600_000) }),
      pendingRow({ id: "early-done", status: "succeeded", executed_at: t(-1000), updated_at: t(-500) }),
    ]
    const out = await terminalDraftsSince(fakeDb(rows), USER, "conv-1", t(-5000))
    expect(out.map((d) => d.id)).toEqual(["late-cancel", "early-done"])
  })
})
