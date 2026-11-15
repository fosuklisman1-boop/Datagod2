import { describe, it, expect, vi, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { planRecord, recordBlockedRecipients, dedupeKey, type ExistingRow, type RecordDeps } from "./record"
import { DEFAULT_BLOCKED_SETTINGS } from "./settings"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const DAY = 86_400_000
const base = (over: Partial<Parameters<typeof planRecord>[0]> = {}) => ({
  phones: ["0241234567"],
  ctx: { surface: "storefront" as const, shopId: "shop-1", userId: "u1", product: "1GB", amount: 5 },
  now: NOW,
  retentionDays: 30,
  providers: ["a", "b"],
  recentKeys: new Set<string>(),
  existing: new Map<string, ExistingRow>(),
  ...over,
})
const row = (over: Partial<ExistingRow> = {}): ExistingRow => ({
  phone: "0241234567",
  status: "blocked",
  attempts: 3,
  first_blocked_at: "2026-11-01T00:00:00.000Z",
  expires_at: "2026-12-01T00:00:00.000Z",
  recheck_count: 2,
  next_recheck_at: "2026-11-16T00:00:00.000Z",
  customer_notified_at: null,
  ...over,
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("planRecord", () => {
  it("new phone: blocked upsert and one attempt", () => {
    const r = planRecord(base())
    expect(r.deduped).toBe(0)
    expect(r.numberUpserts).toHaveLength(1)
    expect(r.numberUpserts[0]).toMatchObject({
      phone: "0241234567",
      status: "blocked",
      attempts: 1,
      recheck_count: 0,
      next_recheck_at: new Date(NOW.getTime() + DAY).toISOString(),
      expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      first_blocked_at: NOW.toISOString(),
      providers_rejected: ["a", "b"],
      last_surface: "storefront",
      last_shop_id: "shop-1",
      updated_at: NOW.toISOString(),
    })
    expect(r.attempts).toEqual([
      { phone: "0241234567", surface: "storefront", shop_id: "shop-1", user_id: "u1", purchaser_phone: null, product: "1GB", amount: 5 },
    ])
  })

  it("recent key: no attempt, deduped 1, last_blocked_at bumped, attempts not", () => {
    const r = planRecord(
      base({ recentKeys: new Set([dedupeKey("0241234567", "storefront", "shop-1")]), existing: new Map([["0241234567", row()]]) })
    )
    expect(r.attempts).toHaveLength(0)
    expect(r.deduped).toBe(1)
    expect(r.numberUpserts[0].attempts).toBe(3)
    expect(r.numberUpserts[0].last_blocked_at).toBe(NOW.toISOString())
  })

  it("dedupe key ignores purchaser and product", () => {
    expect(dedupeKey("0241234567", "storefront")).toBe("0241234567|storefront|")
  })

  it("existing allowed row returns to blocked with a fresh schedule, never sending ready_sms_* or allowed_by", () => {
    const r = planRecord(
      base({ existing: new Map([["0241234567", row({ status: "allowed", customer_notified_at: "2026-11-10T00:00:00.000Z" })]]) })
    )
    const u = r.numberUpserts[0]
    expect(u).toMatchObject({
      status: "blocked",
      recheck_count: 0,
      customer_notified_at: null,
      attempts: 4,
      first_blocked_at: "2026-11-01T00:00:00.000Z",
      expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      next_recheck_at: new Date(NOW.getTime() + DAY).toISOString(),
    })
    for (const k of ["ready_sms_count", "ready_sms_window_start", "allowed_by", "allowed_at", "created_at"]) {
      expect(k in u).toBe(false)
    }
  })

  it("existing blocked row: attempts+1, first_blocked_at/expires_at/recheck state kept", () => {
    const r = planRecord(base({ existing: new Map([["0241234567", row()]]) }))
    expect(r.numberUpserts[0]).toMatchObject({
      attempts: 4,
      first_blocked_at: "2026-11-01T00:00:00.000Z",
      expires_at: "2026-12-01T00:00:00.000Z",
      recheck_count: 2,
      next_recheck_at: "2026-11-16T00:00:00.000Z",
    })
  })

  it("all upserts share one key set", () => {
    const r = planRecord(
      base({
        phones: ["0241234567", "0551234567", "0201234567"],
        existing: new Map([["0551234567", row({ phone: "0551234567", status: "expired" })]]),
      })
    )
    const sets = r.numberUpserts.map((u) => Object.keys(u).sort().join(","))
    expect(new Set(sets).size).toBe(1)
  })

  it("collapses 0241234567 and 233241234567 to one upsert", () => {
    const r = planRecord(base({ phones: ["0241234567", "233241234567", "+233241234567"] }))
    expect(r.numberUpserts.map((u) => u.phone)).toEqual(["0241234567"])
    expect(r.attempts).toHaveLength(1)
  })

  it("drops invalid input", () => {
    const r = planRecord(base({ phones: ["abc", ""] }))
    expect(r.numberUpserts).toHaveLength(0)
    expect(r.attempts).toHaveLength(0)
  })

  it("500 phones: one array of 500", () => {
    const phones = Array.from({ length: 500 }, (_, i) => "024" + String(1000000 + i))
    const r = planRecord(base({ phones }))
    expect(r.numberUpserts).toHaveLength(500)
    expect(r.attempts).toHaveLength(500)
  })

  it("purchaser phone kept only for trusted surfaces", () => {
    const keep = planRecord(base({ ctx: { surface: "ussd_hubtel", purchaserPhone: "233551234567" } }))
    expect(keep.attempts[0].purchaser_phone).toBe("0551234567")
    for (const surface of ["storefront_preview", "dashboard", "dashboard_bulk_preview", "api_v2"] as const) {
      const r = planRecord(base({ ctx: { surface, purchaserPhone: "0551234567" } }))
      expect(r.attempts[0].purchaser_phone).toBeNull()
    }
  })
})

type Call = { table: string; op: string; args: unknown[] }
function fakeDb(handlers: { select?: (table: string) => unknown[]; fail?: boolean; hang?: boolean } = {}) {
  const calls: Call[] = []
  const db = {
    from(table: string) {
      let op = "select"
      const q: Record<string, unknown> = {}
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          if (name === "upsert" || name === "insert") op = name
          calls.push({ table, op: name, args })
          return q
        }
      for (const n of ["select", "in", "gte", "upsert", "insert"]) q[n] = chain(n)
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        if (handlers.hang) return new Promise(() => {}).then(res, rej)
        if (handlers.fail) return Promise.reject(new Error("db down for 0241234567")).then(res, rej)
        let data: unknown[] = []
        if (op === "select") data = handlers.select?.(table) ?? []
        if (op === "upsert") data = [{ id: "id-1", phone: "0241234567" }]
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
      return q
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}
const deps = (db: SupabaseClient, enabled = true): RecordDeps => ({
  db,
  settings: async () => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled }),
  now: () => NOW,
})

describe("recordBlockedRecipients", () => {
  it("enabled:false makes no DB call", async () => {
    const f = fakeDb()
    const r = await recordBlockedRecipients(["0241234567"], { surface: "storefront" }, [], deps(f.db, false))
    expect(r).toEqual({ recorded: 0, deduped: 0 })
    expect(f.calls).toHaveLength(0)
  })

  it("happy path upserts then inserts attempts and calls afterInsert", async () => {
    const f = fakeDb()
    const afterInsert = vi.fn(async () => {})
    const r = await recordBlockedRecipients(["0241234567"], { surface: "storefront" }, ["a"], { ...deps(f.db), afterInsert })
    expect(r).toEqual({ recorded: 1, deduped: 0 })
    const ins = f.calls.find((c) => c.table === "mtn_blocked_attempts" && c.op === "insert")
    expect((ins?.args[0] as { blocked_number_id: string }[])[0].blocked_number_id).toBe("id-1")
    expect(afterInsert).toHaveBeenCalledWith(1)
  })

  it("a never-resolving db returns zeros after 1,000 ms", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = fakeDb({ hang: true })
    const p = recordBlockedRecipients(["0241234567"], { surface: "storefront" }, [], deps(f.db))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await p).toEqual({ recorded: 0, deduped: 0 })
  })

  it("a throwing db returns zeros and logs no phone number", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ fail: true })
    const r = await recordBlockedRecipients(["0241234567"], { surface: "storefront" }, [], deps(f.db))
    expect(r).toEqual({ recorded: 0, deduped: 0 })
    expect(err).toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/\d{9,}/)
  })
})
