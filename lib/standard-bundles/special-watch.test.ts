import { describe, expect, it } from "vitest"
import {
  SPECIAL_WATCH_AGE_MS, SPECIAL_WATCH_KEY, SPECIAL_WATCH_REALERT_MS, specialStuckMessage, watchStuckSpecialGroups,
} from "./special-watch"

const NOW = Date.parse("2026-10-30T12:00:00Z")
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

/** Records every call per table; answers the orders select, the stamp read and the stamp upsert. */
function fakeDb(o: {
  rows?: { special_group_id: string }[]; ordersError?: unknown; stamps?: Record<string, string> | null; stampReadError?: unknown
} = {}) {
  const calls: { table: string; fn: string; args: any[] }[] = []
  const writes: { table: string; fn: string; args: any[] }[] = []
  const db: any = {
    from: (table: string) => {
      let kind: "orders" | "stampRead" = table === "hubtel_data_orders" ? "orders" : "stampRead"
      const chain: any = new Proxy({}, {
        get(_t, fn: string) {
          if (fn === "then") {
            const r = kind === "orders"
              ? { data: o.ordersError ? null : (o.rows ?? []), error: o.ordersError ?? null }
              : { data: null, error: null }
            return (res: any) => res(r)
          }
          return (...args: any[]) => {
            calls.push({ table, fn, args })
            if (["update", "delete", "insert", "upsert", "rpc"].includes(fn)) {
              writes.push({ table, fn, args })
              return Promise.resolve({ error: null })
            }
            if (fn === "maybeSingle") {
              return Promise.resolve(o.stampReadError
                ? { data: null, error: o.stampReadError }
                : { data: o.stamps === null || o.stamps === undefined ? null : { value: { groups: o.stamps } }, error: null })
            }
            return chain
          }
        },
      })
      return chain
    },
  }
  return { db, calls, writes }
}

const collect = () => {
  const sent: string[] = []
  return { sent, alert: async (m: string) => { sent.push(m) } }
}

describe("specialStuckMessage", () => {
  it("is the exact admin wording", () => {
    expect(specialStuckMessage("g1", 2)).toBe("Special group g1: 2 paid units not sent; send them from Admin > Hubtel Commission > Standard Bundles")
  })
})

describe("watchStuckSpecialGroups", () => {
  it("queries only paid, never-referenced Special children, pending or on a Dispatching claim, older than 5 minutes, read-only on orders", async () => {
    const { db, calls, writes } = fakeDb({ rows: [] })
    const a = collect()
    await watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })
    const q = calls.filter(c => c.table === "hubtel_data_orders")
    expect(q.find(c => c.fn === "select")!.args[0]).toBe("special_group_id, status")
    expect(q.find(c => c.fn === "not")!.args).toEqual(["special_group_id", "is", null])
    expect(q.filter(c => c.fn === "eq").map(c => c.args)).toEqual([["payment_status", "paid"]])
    expect(q.find(c => c.fn === "or")!.args).toEqual(["status.eq.pending,and(status.eq.processing,notes.like.Dispatching*)"])
    expect(q.find(c => c.fn === "is")!.args).toEqual(["hubtel_client_reference", null])
    expect(q.find(c => c.fn === "lt")!.args).toEqual(["updated_at", iso(SPECIAL_WATCH_AGE_MS)])
    expect(q.find(c => c.fn === "limit")).toBeTruthy()
    expect(writes.filter(w => w.table === "hubtel_data_orders")).toEqual([])
    expect(a.sent).toEqual([])
  })

  it("ONE urgent alert per group with its unit count, then stamps the groups (never writes an order row)", async () => {
    const rows = [{ special_group_id: "A" }, { special_group_id: "B" }, { special_group_id: "A" }, { special_group_id: "A" }]
    const { db, writes } = fakeDb({ rows })
    const a = collect()
    const r = await watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })
    expect(a.sent.sort()).toEqual([specialStuckMessage("A", 3), specialStuckMessage("B", 1)].sort())
    expect(r).toEqual({ skipped: false, groups: 2, alerted: 2 })
    expect(writes.filter(w => w.table === "hubtel_data_orders")).toEqual([])
    const up = writes.find(w => w.table === "admin_settings" && w.fn === "upsert")!
    expect(up.args[0].key).toBe(SPECIAL_WATCH_KEY)
    expect(up.args[0].value.groups).toEqual({ A: new Date(NOW).toISOString(), B: new Date(NOW).toISOString() })
  })

  it("a group alerted less than 6 hours ago is not alerted again; after 6 hours it is", async () => {
    const rows = [{ special_group_id: "A" }, { special_group_id: "B" }]
    const stamps = { A: iso(SPECIAL_WATCH_REALERT_MS - 60_000), B: iso(SPECIAL_WATCH_REALERT_MS) }
    const { db, writes } = fakeDb({ rows, stamps })
    const a = collect()
    const r = await watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })
    expect(a.sent).toEqual([specialStuckMessage("B", 1)])
    expect(r.alerted).toBe(1)
    const up = writes.find(w => w.fn === "upsert")!
    expect(up.args[0].value.groups).toEqual({ A: stamps.A, B: new Date(NOW).toISOString() })
  })

  it("stamps of groups no longer stuck are dropped; nothing stuck and nothing stored => no write at all", async () => {
    const one = fakeDb({ rows: [], stamps: { OLD: iso(1000) } })
    await watchStuckSpecialGroups(one.db, { alert: collect().alert, now: () => NOW })
    expect(one.writes.find(w => w.fn === "upsert")!.args[0].value.groups).toEqual({})
    const none = fakeDb({ rows: [], stamps: null })
    await watchStuckSpecialGroups(none.db, { alert: collect().alert, now: () => NOW })
    expect(none.writes).toEqual([])
  })

  it("a failed alert is not stamped (retried next run)", async () => {
    const { db, writes } = fakeDb({ rows: [{ special_group_id: "A" }, { special_group_id: "B" }] })
    const sent: string[] = []
    const r = await watchStuckSpecialGroups(db, {
      alert: async (m) => { if (m.includes("group A")) throw new Error("sms down"); sent.push(m) }, now: () => NOW,
    })
    expect(r.alerted).toBe(1)
    expect(Object.keys(writes.find(w => w.fn === "upsert")!.args[0].value.groups)).toEqual(["B"])
  })

  it("before migration 0141 (42703 undefined column) it skips silently: no alert, no write", async () => {
    const { db, writes } = fakeDb({ ordersError: { code: "42703", message: "column special_group_id does not exist" } })
    const a = collect()
    expect(await watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })).toEqual({ skipped: true, groups: 0, alerted: 0 })
    expect(a.sent).toEqual([])
    expect(writes).toEqual([])
  })

  describe("a unit that died between the claim and the POST", () => {
    /** Applies the query's filters to the rows, including the one `or` expression the watch sends. */
    function filteringDb(rows: Record<string, any>[]) {
      const db: any = {
        from: (table: string) => {
          const filters: Array<(r: Record<string, any>) => boolean> = []
          const q: any = {
            select: () => q,
            limit: () => q,
            not: (c: string) => { filters.push(r => r[c] != null); return q },
            eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q },
            is: (c: string) => { filters.push(r => r[c] == null); return q },
            lt: (c: string, v: string) => { filters.push(r => r[c] < v); return q },
            or: (expr: string) => {
              expect(expr).toBe("status.eq.pending,and(status.eq.processing,notes.like.Dispatching*)")
              filters.push(r => r.status === "pending" || (r.status === "processing" && String(r.notes ?? "").startsWith("Dispatching")))
              return q
            },
            maybeSingle: async () => ({ data: null, error: null }),
            upsert: async () => ({ error: null }),
            then: (res: any) => res({ data: table === "hubtel_data_orders" ? rows.filter(r => filters.every(f => f(r))) : [], error: null }),
          }
          return q
        },
      }
      return db
    }
    const unit = (group: string, o: Record<string, any> = {}) => ({
      special_group_id: group, payment_status: "paid", status: "processing", notes: "Dispatching…",
      hubtel_client_reference: null, updated_at: iso(SPECIAL_WATCH_AGE_MS + 60_000), ...o,
    })
    const run = async (rows: Record<string, any>[]) => {
      const a = collect()
      const r = await watchStuckSpecialGroups(filteringDb(rows), { alert: a.alert, now: () => NOW })
      return { sent: a.sent, r }
    }

    it("older than the age rule: alerted, saying it may have reached Hubtel, so check before resending", async () => {
      const { sent, r } = await run([unit("A")])
      expect(r.alerted).toBe(1)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("Special group A")
      expect(sent[0]).toContain("may have reached Hubtel")
      expect(sent[0]).toMatch(/check .*before resending/i)
      expect(sent[0]).not.toContain("paid units not sent")
    })

    it("an in-flight send (claim younger than the age rule) is not reported", async () => {
      const { sent, r } = await run([unit("A", { updated_at: iso(SPECIAL_WATCH_AGE_MS - 60_000) })])
      expect(sent).toEqual([])
      expect(r.groups).toBe(0)
    })

    it("a processing unit that reached Hubtel, or has any other note, is not reported", async () => {
      const { sent } = await run([
        unit("A", { hubtel_client_reference: "HCS-1", notes: null }),
        unit("B", { hubtel_client_reference: "HCS-2" }),
        unit("C", { notes: "A live Hubtel transaction already exists for this order; do not resend." }),
      ])
      expect(sent).toEqual([])
    })

    it("a group with both kinds counts them apart: the pending ones can be sent, the claimed ones are checked first", async () => {
      const { sent } = await run([unit("A", { status: "pending", notes: null }), unit("A", { status: "pending", notes: null }), unit("A")])
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("2 paid units not sent")
      expect(sent[0]).toContain("1 unit")
      expect(sent[0]).toContain("may have reached Hubtel")
    })

    it("a group with only pending units keeps the exact existing wording", async () => {
      const { sent } = await run([unit("A", { status: "pending", notes: null })])
      expect(sent).toEqual([specialStuckMessage("A", 1)])
    })
  })

  it("any other orders error throws (the cron logs it)", async () => {
    const { db } = fakeDb({ ordersError: { code: "57014", message: "timeout" } })
    await expect(watchStuckSpecialGroups(db, { alert: collect().alert, now: () => NOW })).rejects.toBeTruthy()
  })

  it("a stamp read error throws rather than alerting every run", async () => {
    const { db } = fakeDb({ rows: [{ special_group_id: "A" }], stampReadError: { message: "boom" } })
    const a = collect()
    await expect(watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })).rejects.toBeTruthy()
    expect(a.sent).toEqual([])
  })
})
