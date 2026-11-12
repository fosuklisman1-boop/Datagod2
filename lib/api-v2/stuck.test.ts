import { describe, it, expect, vi } from "vitest"
import { findStuckV2, shouldAlert, runStuckSweep } from "./stuck"

const NOW = new Date("2026-11-12T12:00:00.000Z")
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60000).toISOString()

type Row = Record<string, any>

/** In-memory chainable fake. Records every write call so tests can prove none touch the audited tables. */
function fakeClient(tables: Record<string, Row[]>) {
  const writes: { table: string; op: string }[] = []
  const settings: Row[] = []
  const client = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let cap = Infinity
      const q: any = {
        select: () => q,
        neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
        lt: (c: string, v: string) => (filters.push((r) => r[c] < v), q),
        not: (c: string, _op: string, v: unknown) => (filters.push((r) => r[c] !== v), q),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        order: () => q,
        limit: (n: number) => ((cap = n), q),
        maybeSingle: async () => {
          const rows = (table === "admin_settings" ? settings : tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
          return { data: rows[0] ?? null, error: null }
        },
        upsert: async (row: Row) => {
          writes.push({ table, op: "upsert" })
          if (table === "admin_settings") {
            const i = settings.findIndex((s) => s.key === row.key)
            if (i >= 0) settings[i] = row
            else settings.push(row)
          }
          return { error: null }
        },
        update: () => (writes.push({ table, op: "update" }), q),
        delete: () => (writes.push({ table, op: "delete" }), q),
        insert: () => (writes.push({ table, op: "insert" }), q),
        then: (res: (v: unknown) => unknown) =>
          res({ data: (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, cap), error: null }),
      }
      return q
    },
  }
  return { client, writes, settings }
}

const claim = (id: string, status: string, ageMin: number): Row => ({
  id, user_id: "u1", kind: "data", reference: "ref-" + id, status, created_at: minsAgo(ageMin),
})
const order = (id: string, status: string, ageMin: number, keyId: string | null): Row => ({
  id, user_id: "u1", network: "mtn", api_reference: "r-" + id, status, created_at: minsAgo(ageMin), api_v2_key_id: keyId,
})

describe("findStuckV2", () => {
  it("excludes 9-minute-old and done claims, includes 11-minute-old pending ones", async () => {
    const { client } = fakeClient({
      api_v2_idempotency: [claim("a", "pending", 9), claim("b", "pending", 11), claim("c", "done", 60)],
      api_orders: [],
    })
    const r = await findStuckV2(client, NOW)
    expect(r.claims.map((c) => c.id)).toEqual(["b"])
  })

  it("only v2 orders in pending/processing past 10 minutes; v1 orders excluded", async () => {
    const { client } = fakeClient({
      api_v2_idempotency: [],
      api_orders: [
        order("o1", "pending", 11, "k1"),
        order("o2", "processing", 30, "k1"),
        order("o3", "pending", 9, "k1"),
        order("o4", "pending", 60, null),
        order("o5", "completed", 60, "k1"),
      ],
    })
    const r = await findStuckV2(client, NOW)
    expect(r.orders.map((o) => o.id).sort()).toEqual(["o1", "o2"])
  })

  it("caps each list at 200", async () => {
    const many = Array.from({ length: 250 }, (_, i) => claim("c" + i, "pending", 30))
    const { client } = fakeClient({ api_v2_idempotency: many, api_orders: [] })
    expect((await findStuckV2(client, NOW)).claims).toHaveLength(200)
  })
})

describe("shouldAlert", () => {
  it("same set => false, empty => false, different => true", () => {
    expect(shouldAlert(["a", "b"], ["b", "a"])).toBe(false)
    expect(shouldAlert([], [])).toBe(false)
    expect(shouldAlert(["a"], [])).toBe(false)
    expect(shouldAlert([], ["a"])).toBe(true)
    expect(shouldAlert(["a"], ["a", "b"])).toBe(true)
    expect(shouldAlert(["a", "b"], ["a", "c"])).toBe(true)
  })
})

describe("runStuckSweep", () => {
  const tables = () => ({
    api_v2_idempotency: [claim("a", "pending", 25)],
    api_orders: [order("o1", "pending", 40, "k1")],
  })

  it("alerts once for a new id set and not again for the same set", async () => {
    const { client } = fakeClient(tables())
    const notify = vi.fn(async () => {})
    const first = await runStuckSweep(client, NOW, notify)
    const second = await runStuckSweep(client, NOW, notify)
    expect(first.alerted).toBe(true)
    expect(second.alerted).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("alert message has counts and oldest age only (no PII)", async () => {
    const { client } = fakeClient(tables())
    const notify = vi.fn(async (_m: string) => {})
    await runStuckSweep(client, NOW, notify)
    const msg = notify.mock.calls[0][0]
    expect(msg).toContain("1 claim(s)")
    expect(msg).toContain("1 order(s)")
    expect(msg).toContain("40 minutes")
    expect(msg).not.toMatch(/u1|ref-a|r-o1|@|\d{9,}/)
  })

  it("re-alerts when the set changes", async () => {
    const t = tables()
    const { client } = fakeClient(t)
    const notify = vi.fn(async () => {})
    await runStuckSweep(client, NOW, notify)
    t.api_orders.push(order("o2", "processing", 20, "k1"))
    await runStuckSweep(client, NOW, notify)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("never calls update/delete/insert/upsert on api_v2_idempotency or api_orders", async () => {
    const { client, writes } = fakeClient(tables())
    await runStuckSweep(client, NOW, async () => {})
    expect(writes.filter((w) => w.table === "api_v2_idempotency" || w.table === "api_orders")).toEqual([])
    expect(writes).toEqual([{ table: "admin_settings", op: "upsert" }])
  })
})
