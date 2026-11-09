// lib/ussd-hubtel/special-group.test.ts
// An unpaid Special group (N hubtel_data_orders rows sharing special_group_id) fails as one, through every
// "fail this order" path, which only ever receives child 1's id.
import { describe, it, expect, vi, afterEach } from "vitest"
import { readSpecialGroup } from "./special-group"
import { createFailHandlers, createStrictFailHandlers, failOrderStrict } from "./order-handlers"
import { failOrderGuarded } from "./order-tables"

type Row = Record<string, any>

/** In-memory PostgREST-ish fake: select/eq/in/order/maybeSingle, update + filters (+ .select), with an op log. */
function fakeDb(tables: Record<string, Row[]>, failSelect: (table: string, cols: string) => boolean = () => false) {
  const log: Array<{ table: string; op: "select" | "update"; cols?: string; filters: string[]; matched?: number }> = []
  const client: any = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = []
      const desc: string[] = []
      let patch: Row | null = null
      let cols = ""
      let ord: string | null = null
      const rows = () => {
        let out = (tables[table] ?? []).filter(r => filters.every(f => f(r)))
        if (ord) out = [...out].sort((a, b) => a[ord!] - b[ord!])
        return out
      }
      const runUpdate = () => {
        const hit = rows()
        for (const r of hit) Object.assign(r, patch)
        log.push({ table, op: "update", filters: desc, matched: hit.length })
        return { data: hit.map(r => ({ id: r.id })), error: null }
      }
      const q: any = {
        select: (c?: string) => {
          if (patch) return Promise.resolve(runUpdate())
          cols = c ?? ""
          return q
        },
        update: (p: Row) => { patch = p; return q },
        eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); desc.push(`eq:${c}`); return q },
        in: (c: string, vs: unknown[]) => { filters.push(r => vs.includes(r[c])); desc.push(`in:${c}`); return q },
        order: (c: string) => { ord = c; return q },
        maybeSingle: () => {
          log.push({ table, op: "select", cols, filters: desc })
          if (failSelect(table, cols)) return Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } })
          return Promise.resolve({ data: rows()[0] ?? null, error: null })
        },
        then(ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
          if (patch) return Promise.resolve(runUpdate()).then(ok, ko)
          log.push({ table, op: "select", cols, filters: desc })
          if (failSelect(table, cols)) return Promise.resolve({ data: null, error: { message: "boom", code: "XX000" } }).then(ok, ko)
          return Promise.resolve({ data: rows(), error: null }).then(ok, ko)
        },
      }
      return q
    },
  }
  return { client, log }
}

const G = "group-1"
function child(i: number, over: Row = {}): Row {
  return {
    id: `c${i}`, special_group_id: G, special_index: i, channel: "bots", status: "pending", payment_status: "unpaid",
    paid_amount: 3, payment_reference: null, failure_reason: null, ...over,
  }
}
const group = (n = 3) => Array.from({ length: n }, (_, i) => child(i + 1))

afterEach(() => vi.restoreAllMocks())

describe("readSpecialGroup", () => {
  it("returns the group's children ordered by special_index", async () => {
    const rows = [child(3), child(1), child(2)]
    const { client } = fakeDb({ hubtel_data_orders: rows })
    const g = await readSpecialGroup(client, "hubtel_data_orders", "c3")
    expect(g?.groupId).toBe(G)
    expect(g?.children.map(c => c.id)).toEqual(["c1", "c2", "c3"])
  })

  it("is null for a row that is not in a group, a missing row, and every other table (no query for those)", async () => {
    const { client, log } = fakeDb({ hubtel_data_orders: [child(1, { special_group_id: null })], hubtel_bill_orders: group() })
    expect(await readSpecialGroup(client, "hubtel_data_orders", "c1")).toBeNull()
    expect(await readSpecialGroup(client, "hubtel_data_orders", "nope")).toBeNull()
    log.length = 0
    expect(await readSpecialGroup(client, "hubtel_bill_orders", "c1")).toBeNull()
    expect(log).toEqual([])
  })

  it("throws on a read error", async () => {
    const { client } = fakeDb({ hubtel_data_orders: group() }, () => true)
    await expect(readSpecialGroup(client, "hubtel_data_orders", "c1")).rejects.toBeTruthy()
  })
})

describe("createFailHandlers on a Special group", () => {
  it("fails every pending + unpaid bots child from child 1's id", async () => {
    const rows = group(3)
    const { client } = fakeDb({ hubtel_data_orders: rows })
    await createFailHandlers(client).hubtel_data_orders("c1")
    for (const r of rows) expect(r).toMatchObject({ status: "failed", failure_reason: "payment not completed", payment_status: "unpaid" })
  })

  it("never touches a paid child, a non-pending child, or another group", async () => {
    const rows = [child(1), child(2, { payment_status: "paid", status: "processing" }), child(3, { status: "failed" })]
    const other = [child(1, { id: "x1", special_group_id: "other" })]
    const { client } = fakeDb({ hubtel_data_orders: [...rows, ...other] })
    await createFailHandlers(client).hubtel_data_orders("c1")
    expect(rows[0].status).toBe("failed")
    expect(rows[1]).toMatchObject({ status: "processing", payment_status: "paid", failure_reason: null })
    expect(rows[2].failure_reason).toBeNull()
    expect(other[0].status).toBe("pending")
  })

  it("never touches a dashboard Special group (channel guard), whatever id it is given", async () => {
    const rows = group(3).map(r => ({ ...r, channel: "dashboard" }))
    const before = JSON.parse(JSON.stringify(rows))
    const { client, log } = fakeDb({ hubtel_data_orders: rows })
    await createFailHandlers(client).hubtel_data_orders("c1")
    await failOrderGuarded(client, "hubtel_data_orders", "c1", true, "T")
    await expect(failOrderStrict(client, "hubtel_data_orders", "c1")).rejects.toThrow(/not in an unpaid state/)
    expect(rows).toEqual(before)
    const updates = log.filter(l => l.op === "update")
    expect(updates.length).toBe(3)
    for (const u of updates) { expect(u.matched).toBe(0); expect(u.filters).toContain("in:channel") }
  })

  it("a non-Special row gets the same single by-id update plus one cheap read, on hubtel_data_orders only", async () => {
    const rows = [child(1, { special_group_id: null })]
    const { client, log } = fakeDb({ hubtel_data_orders: rows, hubtel_bill_orders: [child(1, { id: "b1", special_group_id: null })] })
    await createFailHandlers(client).hubtel_data_orders("c1")
    expect(rows[0].status).toBe("failed")
    expect(log).toEqual([
      { table: "hubtel_data_orders", op: "select", cols: "special_group_id", filters: ["eq:id"] },
      { table: "hubtel_data_orders", op: "update", filters: ["eq:id", "in:payment_status", "in:channel", "in:status"], matched: 1 },
    ])
    log.length = 0
    await createFailHandlers(client).hubtel_bill_orders("b1")
    expect(log.map(l => `${l.table}:${l.op}`)).toEqual(["hubtel_bill_orders:update"])
  })

  it("a group read error logs an error and fails child 1 by id", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const rows = group(3)
    const { client } = fakeDb({ hubtel_data_orders: rows }, () => true)
    await createFailHandlers(client).hubtel_data_orders("c1")
    expect(rows.map(r => r.status)).toEqual(["failed", "pending", "pending"])
    expect(err).toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).toContain("c1")
  })
})

describe("failOrderStrict on a Special group", () => {
  it("fails all children from child 1", async () => {
    const rows = group(3)
    const { client } = fakeDb({ hubtel_data_orders: rows })
    await failOrderStrict(client, "hubtel_data_orders", "c1")
    expect(rows.every(r => r.status === "failed")).toBe(true)
    const rows2 = group(2)
    await createStrictFailHandlers(fakeDb({ hubtel_data_orders: rows2 }).client).hubtel_data_orders("c1")
    expect(rows2.every(r => r.status === "failed")).toBe(true)
  })

  it("succeeds when only some children changed (one already paid)", async () => {
    const rows = [child(1), child(2, { payment_status: "paid", status: "processing" })]
    const { client } = fakeDb({ hubtel_data_orders: rows })
    await expect(failOrderStrict(client, "hubtel_data_orders", "c1")).resolves.toBeUndefined()
    expect(rows[0].status).toBe("failed")
    expect(rows[1].status).toBe("processing")
  })

  it("throws when no child changed", async () => {
    const rows = group(2).map(r => ({ ...r, status: "failed" }))
    const { client } = fakeDb({ hubtel_data_orders: rows })
    await expect(failOrderStrict(client, "hubtel_data_orders", "c1")).rejects.toThrow(/not in an unpaid state/)
  })

  it("throws on a group read error and changes nothing", async () => {
    const rows = group(2)
    const { client } = fakeDb({ hubtel_data_orders: rows }, () => true)
    await expect(failOrderStrict(client, "hubtel_data_orders", "c1")).rejects.toThrow(/could not be marked failed|read/)
    expect(rows.every(r => r.status === "pending")).toBe(true)
  })
})

describe("failOrderGuarded on a Special group", () => {
  it("engine mode fails every pending unpaid child; a paid child is untouched", async () => {
    const rows = [child(1), child(2), child(3, { payment_status: "paid", status: "processing" })]
    const { client } = fakeDb({ hubtel_data_orders: rows })
    await failOrderGuarded(client, "hubtel_data_orders", "c2", true, "T")
    expect(rows.map(r => r.status)).toEqual(["failed", "failed", "processing"])
  })

  it("non-engine mode never looks up a group (no extra read)", async () => {
    const rows = group(2)
    const { client, log } = fakeDb({ hubtel_data_orders: rows })
    await failOrderGuarded(client, "hubtel_data_orders", "c1", false, "T")
    expect(log.map(l => l.op)).toEqual(["update"])
    expect(rows.map(r => r.status)).toEqual(["failed", "pending"])
  })

  it("a group read error logs and fails child 1 by id, never throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const rows = group(3)
    const { client } = fakeDb({ hubtel_data_orders: rows }, () => true)
    await expect(failOrderGuarded(client, "hubtel_data_orders", "c1", true, "T")).resolves.toBeUndefined()
    expect(rows.map(r => r.status)).toEqual(["failed", "pending", "pending"])
    expect(err).toHaveBeenCalled()
  })
})
