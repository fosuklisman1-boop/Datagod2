import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  shopAccountFor,
  reserveForOrder,
  drawReserve,
  undrawReserve,
  releaseReserve,
  chargeSingleReply,
  refundSingleReply,
  shopReplyCapReached,
  singleReplyRef,
  reserveRef,
} from "./credits"
import { TTB_DEFAULTS } from "../settings"

type Res = { data?: unknown; error?: { message?: string } | null }

/** A fake client: rpc answers come from a map, table reads from a per-table result; every call is recorded. */
function fake(opts: { rpc?: Record<string, Res | ((args: Record<string, unknown>) => Res)>; tables?: Record<string, Res> } = {}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  const fromCalls: string[] = []
  const filters: { table: string; op: string; args: unknown[] }[] = []
  const db = {
    rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args })
      const h = opts.rpc?.[fn]
      if (!h) return { data: null, error: { message: "no such function" } }
      return typeof h === "function" ? h(args) : h
    }),
    from: vi.fn((table: string) => {
      fromCalls.push(table)
      const result = opts.tables?.[table] ?? { data: null, error: null }
      const q: Record<string, unknown> = {}
      for (const op of ["select", "eq", "gt", "gte", "limit", "order"]) {
        q[op] = (...args: unknown[]) => {
          filters.push({ table, op, args })
          return q
        }
      }
      q.maybeSingle = async () => result
      q.then = (res: (r: Res) => unknown) => Promise.resolve(result).then(res)
      return q
    }),
  } as unknown as SupabaseClient
  return { db, rpcCalls, fromCalls, filters }
}

describe("shopAccountFor", () => {
  it("shop owner's user id -> that user's sms account, read only", async () => {
    const { db, fromCalls, rpcCalls } = fake({
      tables: { user_shops: { data: { user_id: "u1" }, error: null }, sms_accounts: { data: { id: "acct-1" }, error: null } },
    })
    expect(await shopAccountFor(db, "shop-1")).toEqual({ accountId: "acct-1" })
    expect(fromCalls).toEqual(["user_shops", "sms_accounts"])
    expect(rpcCalls).toEqual([]) // never calls any create function
  })

  it("never creates an account: a missing account is null and nothing but two reads happened", async () => {
    const { db, fromCalls, rpcCalls } = fake({ tables: { user_shops: { data: { user_id: "u1" }, error: null }, sms_accounts: { data: null, error: null } } })
    expect(await shopAccountFor(db, "shop-1")).toBeNull()
    expect(rpcCalls).toEqual([])
    expect(fromCalls.every((t) => t === "user_shops" || t === "sms_accounts")).toBe(true)
  })

  it("an unknown shop is null", async () => {
    const { db } = fake({ tables: { user_shops: { data: null, error: null } } })
    expect(await shopAccountFor(db, "nope")).toBeNull()
  })

  it("a read error is null (pause), never a thrown or invented account", async () => {
    const { db } = fake({ tables: { user_shops: { data: null, error: { message: "boom" } } } })
    expect(await shopAccountFor(db, "shop-1")).toBeNull()
  })

  it("the account comes from the shop's own owner row (a sub-agent shop is its own owner, not the parent)", async () => {
    const { db, filters } = fake({
      tables: { user_shops: { data: { user_id: "sub-user", parent_shop_id: "parent" }, error: null }, sms_accounts: { data: { id: "sub-acct" }, error: null } },
    })
    expect(await shopAccountFor(db, "sub-shop")).toEqual({ accountId: "sub-acct" })
    const acctEq = filters.find((f) => f.table === "sms_accounts" && f.op === "eq")
    expect(acctEq?.args).toEqual(["user_id", "sub-user"])
  })
})

describe("reserveForOrder", () => {
  const args = { accountId: "a1", shopId: "s1", messageId: "m1", credits: 3 }

  it("ok when the SQL returns true, and again when it returns false (already reserved, nothing debited twice)", async () => {
    for (const data of [true, false]) {
      const { db, rpcCalls } = fake({ rpc: { ttb_reserve_credits: { data, error: null } } })
      expect(await reserveForOrder(db, args)).toEqual({ ok: true })
      expect(rpcCalls[0]).toEqual({ fn: "ttb_reserve_credits", args: { p_account_id: "a1", p_message_id: "m1", p_shop_id: "s1", p_credits: 3 } })
    }
  })

  it.each([
    ["NOT_ACTIVATED", "inactive"],
    ["SUSPENDED", "inactive"],
    ["INSUFFICIENT_CREDITS", "insufficient"],
  ])("%s maps to %s", async (message, reason) => {
    const { db } = fake({ rpc: { ttb_reserve_credits: { data: null, error: { message } } } })
    expect(await reserveForOrder(db, args)).toEqual({ ok: false, reason })
  })

  it("no account id is no_account and nothing is called", async () => {
    const { db, rpcCalls } = fake()
    expect(await reserveForOrder(db, { ...args, accountId: "" })).toEqual({ ok: false, reason: "no_account" })
    expect(rpcCalls).toEqual([])
  })

  it("an unknown database error throws a fixed message that does not echo the error text", async () => {
    const { db } = fake({ rpc: { ttb_reserve_credits: { data: null, error: { message: "secret 0200000101 detail" } } } })
    const err = await reserveForOrder(db, args).catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain("0200000101")
  })

  it("two concurrent reserves on a shop with credits for one: exactly one wins, the other is insufficient", async () => {
    let balance = 3
    const { db } = fake({
      rpc: {
        ttb_reserve_credits: (a) => {
          if (balance < (a.p_credits as number)) return { data: null, error: { message: "INSUFFICIENT_CREDITS" } }
          balance -= a.p_credits as number
          return { data: true, error: null }
        },
      },
    })
    const [x, y] = await Promise.all([
      reserveForOrder(db, { ...args, messageId: "m1" }),
      reserveForOrder(db, { ...args, messageId: "m2" }),
    ])
    expect([x, y].filter((r) => r.ok).length).toBe(1)
    expect([x, y].find((r) => !r.ok)).toEqual({ ok: false, reason: "insufficient" })
  })
})

describe("drawReserve / releaseReserve", () => {
  it("draw is true until held is used, then false", async () => {
    let used = 0
    const held = 3
    const { db } = fake({
      rpc: {
        ttb_draw_reserve: (a) => {
          if (used + (a.p_credits as number) > held) return { data: false, error: null }
          used += a.p_credits as number
          return { data: true, error: null }
        },
      },
    })
    const out: boolean[] = []
    for (let i = 0; i < 4; i++) out.push(await drawReserve(db, "m1", 1))
    expect(out).toEqual([true, true, true, false])
  })

  it("draw passes the exact argument names and is false on an error", async () => {
    const ok = fake({ rpc: { ttb_draw_reserve: { data: true, error: null } } })
    await drawReserve(ok.db, "m1", 2)
    expect(ok.rpcCalls[0]).toEqual({ fn: "ttb_draw_reserve", args: { p_message_id: "m1", p_credits: 2 } })
    const bad = fake({ rpc: { ttb_draw_reserve: { data: null, error: { message: "x" } } } })
    expect(await drawReserve(bad.db, "m1", 1)).toBe(false)
  })

  it("undraw passes exact argument names; true only when the SQL says true; false on false, on an error and on a thrown rpc", async () => {
    const yes = fake({ rpc: { ttb_undraw_reserve: { data: true, error: null } } })
    expect(await undrawReserve(yes.db, "m1", 1)).toBe(true)
    expect(yes.rpcCalls[0]).toEqual({ fn: "ttb_undraw_reserve", args: { p_message_id: "m1", p_credits: 1 } })
    expect(await undrawReserve(fake({ rpc: { ttb_undraw_reserve: { data: false, error: null } } }).db, "m1", 1)).toBe(false)
    expect(await undrawReserve(fake({ rpc: { ttb_undraw_reserve: { data: null, error: { message: "x" } } } }).db, "m1", 1)).toBe(false)
    const throwing = { rpc: vi.fn().mockRejectedValue(new Error("net")) } as unknown as SupabaseClient
    expect(await undrawReserve(throwing, "m1", 1)).toBe(false)
  })

  it("release returns the unused credits once and 0 on a repeat", async () => {
    let released = false
    const { db, rpcCalls } = fake({
      rpc: {
        ttb_release_reserve: () => {
          if (released) return { data: 0, error: null }
          released = true
          return { data: 2, error: null }
        },
      },
    })
    expect(await releaseReserve(db, "m1")).toBe(2)
    expect(await releaseReserve(db, "m1")).toBe(0)
    expect(rpcCalls[0]).toEqual({ fn: "ttb_release_reserve", args: { p_message_id: "m1" } })
  })

  it("a release error throws (so it can be retried), never a silent 0", async () => {
    const { db } = fake({ rpc: { ttb_release_reserve: { data: null, error: { message: "REFUND_FAILED" } } } })
    await expect(releaseReserve(db, "m1")).rejects.toThrow()
  })
})

describe("single reply charge and refund", () => {
  it("charge passes exact names; true only when debited; false on a repeat or any error", async () => {
    const yes = fake({ rpc: { ttb_debit_reply: { data: true, error: null } } })
    expect(await chargeSingleReply(yes.db, { accountId: "a1", credits: 1, ref: "ttb:reply:k1" })).toBe(true)
    expect(yes.rpcCalls[0]).toEqual({ fn: "ttb_debit_reply", args: { p_account_id: "a1", p_credits: 1, p_ref: "ttb:reply:k1" } })
    const dup = fake({ rpc: { ttb_debit_reply: { data: false, error: null } } })
    expect(await chargeSingleReply(dup.db, { accountId: "a1", credits: 1, ref: "r" })).toBe(false)
    const err = fake({ rpc: { ttb_debit_reply: { data: null, error: { message: "INSUFFICIENT_CREDITS" } } } })
    expect(await chargeSingleReply(err.db, { accountId: "a1", credits: 1, ref: "r" })).toBe(false)
  })

  it("refund passes exact names; false on any error", async () => {
    const yes = fake({ rpc: { ttb_refund_reply: { data: true, error: null } } })
    expect(await refundSingleReply(yes.db, { accountId: "a1", credits: 1, ref: "ttb:reply:k1" })).toBe(true)
    expect(yes.rpcCalls[0]).toEqual({ fn: "ttb_refund_reply", args: { p_account_id: "a1", p_credits: 1, p_ref: "ttb:reply:k1" } })
    const err = fake({ rpc: { ttb_refund_reply: { data: null, error: { message: "x" } } } })
    expect(await refundSingleReply(err.db, { accountId: "a1", credits: 1, ref: "r" })).toBe(false)
  })
})

describe("reply refs", () => {
  it("a single-reply ref is ttb:reply:<key> and never equals or contains a reserve ref", () => {
    const messageId = "3f2b9c1e-1111-4222-8333-444455556666"
    const keys = [messageId, `${messageId}-1`, "abc", `${messageId}_release`]
    for (const k of keys) {
      const ref = singleReplyRef(k)!
      expect(ref).toBe(`ttb:reply:${k}`)
      expect(ref).not.toBe(reserveRef(messageId))
      expect(ref).not.toBe(`${reserveRef(messageId)}:release`)
      expect(ref.includes(reserveRef(messageId))).toBe(false)
      expect(ref.endsWith(":release") || ref.endsWith(":refund")).toBe(false)
    }
  })

  it("a key that could smuggle a reserve ref (colons, empty, too long) is rejected", () => {
    expect(singleReplyRef("")).toBeNull()
    expect(singleReplyRef("a:b")).toBeNull()
    expect(singleReplyRef("m1:release")).toBeNull()
    expect(singleReplyRef("release")).toBeNull()
    expect(singleReplyRef("refund")).toBeNull()
    expect(singleReplyRef("x".repeat(200))).toBeNull()
    expect(singleReplyRef("has space")).toBeNull()
  })
})

describe("shopReplyCapReached", () => {
  const now = new Date("2026-11-14T12:00:00Z")
  const settings = { ...TTB_DEFAULTS, shopRepliesPerHourPerShop: 3 }

  it("trips at the setting and not before, counting only this shop's paid out rows of the last hour", async () => {
    const rows = (n: number) => ({ data: Array.from({ length: n }, (_, i) => ({ id: String(i) })), error: null })
    expect(await shopReplyCapReached(fake({ tables: { ttb_messages: rows(2) } }).db, "s1", settings, now)).toBe(false)
    const hit = fake({ tables: { ttb_messages: rows(3) } })
    expect(await shopReplyCapReached(hit.db, "s1", settings, now)).toBe(true)
    const f = hit.filters.filter((x) => x.table === "ttb_messages")
    expect(f).toContainEqual({ table: "ttb_messages", op: "eq", args: ["shop_id", "s1"] })
    expect(f).toContainEqual({ table: "ttb_messages", op: "eq", args: ["direction", "out"] })
    expect(f).toContainEqual({ table: "ttb_messages", op: "gt", args: ["credits", 0] })
    expect(f).toContainEqual({ table: "ttb_messages", op: "gte", args: ["created_at", "2026-11-14T11:00:00.000Z"] })
    expect(f).toContainEqual({ table: "ttb_messages", op: "limit", args: [3] })
  })

  it("a read error fails closed (cap reached) so a broken count never lets spend run free", async () => {
    const { db } = fake({ tables: { ttb_messages: { data: null, error: { message: "x" } } } })
    expect(await shopReplyCapReached(db, "s1", settings, now)).toBe(true)
  })
})
