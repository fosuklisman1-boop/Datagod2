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
  it("queries only paid + pending + never-sent Special children older than 5 minutes, read-only on orders", async () => {
    const { db, calls, writes } = fakeDb({ rows: [] })
    const a = collect()
    await watchStuckSpecialGroups(db, { alert: a.alert, now: () => NOW })
    const q = calls.filter(c => c.table === "hubtel_data_orders")
    expect(q.find(c => c.fn === "select")!.args[0]).toBe("special_group_id")
    expect(q.find(c => c.fn === "not")!.args).toEqual(["special_group_id", "is", null])
    expect(q.filter(c => c.fn === "eq").map(c => c.args)).toEqual([["payment_status", "paid"], ["status", "pending"]])
    expect(q.find(c => c.fn === "is")!.args).toEqual(["hubtel_client_reference", null])
    expect(q.find(c => c.fn === "lt")!.args).toEqual(["created_at", iso(SPECIAL_WATCH_AGE_MS)])
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
