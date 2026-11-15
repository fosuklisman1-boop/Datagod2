import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { planRecord, recordBlockedRecipients, dedupeKey, type RpcRow, type RecordDeps } from "./record"
import { DEFAULT_BLOCKED_SETTINGS } from "./settings"
import { TRUSTED_PURCHASER_SURFACES, BLOCK_SURFACES } from "./types"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const base = (over: Partial<Parameters<typeof planRecord>[0]> = {}) => ({
  phones: ["0241234567"],
  ctx: { surface: "storefront" as const, shopId: "shop-1", userId: "u1", product: "1GB", amount: 5 },
  retentionDays: 30,
  providers: ["a", "b"],
  recentKeys: new Set<string>(),
  ...over,
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("planRecord", () => {
  it("new phone: bump 1 rpc row and one attempt", () => {
    const r = planRecord(base())
    expect(r.deduped).toBe(0)
    expect(r.rpcRows).toEqual<RpcRow[]>([
      { phone: "0241234567", bump: 1, providers: ["a", "b"], surface: "storefront", shop_id: "shop-1", retention_days: 30 },
    ])
    expect(r.attempts).toEqual([
      { phone: "0241234567", surface: "storefront", shop_id: "shop-1", user_id: "u1", purchaser_phone: null, product: "1GB", amount: 5 },
    ])
  })

  it("recent key: no attempt, deduped 1, bump 0 (last_blocked_at still refreshed by the SQL)", () => {
    const r = planRecord(base({ recentKeys: new Set([dedupeKey("0241234567", "storefront", "shop-1")]) }))
    expect(r.attempts).toHaveLength(0)
    expect(r.deduped).toBe(1)
    expect(r.rpcRows[0].bump).toBe(0)
  })

  it("dedupe key ignores purchaser and product", () => {
    expect(dedupeKey("0241234567", "storefront")).toBe("0241234567|storefront|")
  })

  it("collapses 0241234567, 233241234567 and +233241234567 to one row", () => {
    const r = planRecord(base({ phones: ["0241234567", "233241234567", "+233241234567"] }))
    expect(r.rpcRows.map((u) => u.phone)).toEqual(["0241234567"])
    expect(r.attempts).toHaveLength(1)
  })

  it("drops invalid input", () => {
    const r = planRecord(base({ phones: ["abc", ""] }))
    expect(r.rpcRows).toHaveLength(0)
    expect(r.attempts).toHaveLength(0)
  })

  it("500 phones: one array of 500", () => {
    const phones = Array.from({ length: 500 }, (_, i) => "024" + String(1000000 + i))
    const r = planRecord(base({ phones }))
    expect(r.rpcRows).toHaveLength(500)
    expect(r.attempts).toHaveLength(500)
  })

  it("purchaser phone is an allowlist: each trusted surface keeps it", () => {
    expect([...TRUSTED_PURCHASER_SURFACES].sort()).toEqual(
      ["text_to_buy", "text_to_buy_airtime", "ussd_hubtel", "ussd_hubtel_shop", "ussd_uzo", "ussd_uzo_shop", "whatsapp_ai", "whatsapp_shop"]
    )
    for (const surface of TRUSTED_PURCHASER_SURFACES) {
      const r = planRecord(base({ ctx: { surface, purchaserPhone: "233551234567" } }))
      expect(r.attempts[0].purchaser_phone).toBe("0551234567")
    }
  })

  it("purchaser phone is dropped on every other surface (fails closed)", () => {
    const dropped = BLOCK_SURFACES.filter((s) => !TRUSTED_PURCHASER_SURFACES.includes(s))
    expect(dropped).toEqual(expect.arrayContaining(["storefront", "storefront_preview", "dashboard", "api_v1", "unknown"]))
    for (const surface of dropped) {
      const r = planRecord(base({ ctx: { surface, purchaserPhone: "0551234567" } }))
      expect(r.attempts[0].purchaser_phone).toBeNull()
    }
  })
})

type Call = { kind: string; table?: string; op: string; args: unknown[] }
type Handlers = {
  recent?: unknown[]
  rpc?: (args: { p_rows: { phone: string }[] }, n: number) => unknown[]
  rpcDelayMs?: number
  fail?: boolean
  hang?: boolean
}
function fakeDb(h: Handlers = {}) {
  const calls: Call[] = []
  let rpcN = 0
  const settle = (data: unknown[], res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
    if (h.hang) return new Promise(() => {}).then(res, rej)
    if (h.fail) return Promise.reject(new Error("db down for 0241234567")).then(res, rej)
    return Promise.resolve({ data, error: null }).then(res, rej)
  }
  const db = {
    from(table: string) {
      let op = "select"
      const q: Record<string, unknown> = {}
      for (const n of ["select", "in", "gte", "limit", "insert"]) {
        q[n] = (...args: unknown[]) => {
          if (n === "insert") op = "insert"
          calls.push({ kind: "from", table, op: n, args })
          return q
        }
      }
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        settle(op === "select" ? (h.recent ?? []) : [], res, rej)
      return q
    },
    rpc(name: string, args: { p_rows: { phone: string }[] }) {
      calls.push({ kind: "rpc", op: name, args: [args] })
      const n = rpcN++
      const data = h.rpc ? h.rpc(args, n) : args.p_rows.map((r, i) => ({ id: `id-${n}-${i}`, phone: r.phone }))
      return {
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
          if (h.rpcDelayMs) return new Promise((r) => setTimeout(r, h.rpcDelayMs)).then(() => settle(data, res, rej))
          return settle(data, res, rej)
        },
      }
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}
const deps = (db: SupabaseClient, over: Partial<RecordDeps> = {}): RecordDeps => ({
  db,
  settings: async () => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled: true }),
  now: () => NOW,
  ...over,
})
const ctx = { surface: "storefront" as const }
const manyPhones = (n: number) => Array.from({ length: n }, (_, i) => "024" + String(1000000 + i))

describe("recordBlockedRecipients", () => {
  it("enabled:false makes no DB call", async () => {
    const f = fakeDb()
    const r = await recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db, { settings: async () => DEFAULT_BLOCKED_SETTINGS }))
    expect(r).toEqual({ recorded: 0, deduped: 0 })
    expect(f.calls).toHaveLength(0)
  })

  it("happy path: limited dedupe select, one rpc, attempts use the returned ids, afterInsert called", async () => {
    const f = fakeDb()
    const afterInsert = vi.fn(async () => {})
    const r = await recordBlockedRecipients(["0241234567"], ctx, ["a"], deps(f.db, { afterInsert }))
    expect(r).toEqual({ recorded: 1, deduped: 0 })
    expect(f.calls.find((c) => c.op === "limit")?.args).toEqual([5000])
    const rpcs = f.calls.filter((c) => c.kind === "rpc")
    expect(rpcs).toHaveLength(1)
    expect(rpcs[0].op).toBe("record_mtn_blocked")
    const ins = f.calls.find((c) => c.table === "mtn_blocked_attempts" && c.op === "insert")
    expect((ins?.args[0] as { blocked_number_id: string }[])[0].blocked_number_id).toBe("id-0-0")
    expect(afterInsert).toHaveBeenCalledWith(1)
  })

  it("more than 500 phones: two rpc calls", async () => {
    const f = fakeDb()
    const r = await recordBlockedRecipients(manyPhones(501), ctx, [], deps(f.db))
    expect(f.calls.filter((c) => c.kind === "rpc")).toHaveLength(2)
    expect(r.recorded).toBe(501)
  })

  it("a recent attempt dedupes: bump 0 and no attempt row", async () => {
    const f = fakeDb({ recent: [{ phone: "0241234567", surface: "storefront", shop_id: null }] })
    const r = await recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db))
    expect(r).toEqual({ recorded: 0, deduped: 1 })
    const rpc = f.calls.find((c) => c.kind === "rpc")
    expect((rpc?.args[0] as { p_rows: RpcRow[] }).p_rows[0].bump).toBe(0)
    expect(f.calls.some((c) => c.op === "insert")).toBe(false)
  })

  it("a never-resolving db returns zeros after 1,000 ms", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fakeDb({ hang: true })
    const p = recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toEqual({ recorded: 0, deduped: 0 })
  })

  it("an rpc that resolves after the timeout: no attempt insert and no afterInsert", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fakeDb({ rpcDelayMs: 1500 })
    const afterInsert = vi.fn(async () => {})
    const p = recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db, { afterInsert }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toEqual({ recorded: 0, deduped: 0 })
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.calls.some((c) => c.op === "insert")).toBe(false)
    expect(afterInsert).not.toHaveBeenCalled()
  })

  it("a throwing db returns zeros and logs no phone number", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ fail: true })
    const r = await recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db))
    expect(r).toEqual({ recorded: 0, deduped: 0 })
    expect(err).toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/\d{9,}/)
  })

  it("settings() rejecting returns zeros with no DB call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb()
    const r = await recordBlockedRecipients(["0241234567"], ctx, [], deps(f.db, { settings: async () => { throw new Error("boom 0241234567") } }))
    expect(r).toEqual({ recorded: 0, deduped: 0 })
    expect(f.calls).toHaveLength(0)
  })

  it("afterInsert throwing still returns the result and logs no phone number", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb()
    const r = await recordBlockedRecipients(
      ["0241234567"],
      ctx,
      [],
      deps(f.db, { afterInsert: async () => { throw new Error("hook 0241234567") } })
    )
    expect(r).toEqual({ recorded: 1, deduped: 0 })
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/\d{9,}/)
  })

  it("rpc returning fewer ids than phones: attempts only for returned ids, count logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fakeDb({ rpc: (a) => a.p_rows.slice(0, 1).map((r) => ({ id: "only", phone: r.phone })) })
    const r = await recordBlockedRecipients(["0241234567", "0551234567", "0201234567"], ctx, [], deps(f.db))
    expect(r.recorded).toBe(1)
    const ins = f.calls.find((c) => c.op === "insert")
    expect(ins?.args[0]).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fewer ids"), 2)
  })
})
