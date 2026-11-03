import { describe, it, expect } from "vitest"
import { provisionShopCode } from "./provision-code"

type Call = { table: string; op: string; payload?: any; filters: any[][] }

function fakeDb(existingRows: any[]) {
  const calls: Call[] = []
  const db: any = {
    from(table: string) {
      const c: Call = { table, op: "select", filters: [] }
      calls.push(c)
      const chain: any = {
        select() { return chain },
        insert(p: any) { c.op = "insert"; c.payload = p; return chain },
        async single() { return { data: { id: "new-code", activation_fee_paid: false }, error: null } },
        async maybeSingle() {
          // The code-uniqueness probe finds nothing.
          return { data: null, error: null }
        },
        then(res: any, rej: any) {
          const isShopRead = c.op === "select" && c.filters.some(f => f[0] === "eq" && f[1] === "shop_id")
          return Promise.resolve({ data: isShopRead ? existingRows : null, error: null }).then(res, rej)
        },
      }
      for (const m of ["eq", "order", "limit"]) chain[m] = (...a: any[]) => { c.filters.push([m, ...a]); return chain }
      return chain
    },
  }
  return { db, calls }
}

describe("provisionShopCode", () => {
  it("returns the existing code row with no insert, even when a shop has two", async () => {
    const { db, calls } = fakeDb([
      { id: "first", activation_fee_paid: true },
      { id: "second", activation_fee_paid: false },
    ])
    const r = await provisionShopCode(db, "shop-1")
    expect(r).toEqual({ id: "first", activation_fee_paid: true })
    expect(calls.filter(c => c.op === "insert")).toHaveLength(0)
  })

  it("inserts exactly one code when the shop has none", async () => {
    const { db, calls } = fakeDb([])
    const r = await provisionShopCode(db, "shop-1")
    expect(r).toEqual({ id: "new-code", activation_fee_paid: false })
    expect(calls.filter(c => c.op === "insert")).toHaveLength(1)
  })
})
