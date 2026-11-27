import { describe, it, expect } from "vitest"
import { loadShopStockNotices } from "./stock-notices"

// Fake client: admin_settings returns the stock map; package tables filter like PostgREST.
function fakeClient(stockMap: unknown, tables: Record<string, Record<string, unknown>[]>, calls: string[] = []) {
  return {
    from: (table: string) => {
      calls.push(table)
      let rows = [...(tables[table] ?? [])]
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { rows = rows.filter(r => r[col] === val); return chain },
        in: (col: string, vals: unknown[]) => { rows = rows.filter(r => vals.includes(r[col])); return chain },
        maybeSingle: () => Promise.resolve(
          stockMap instanceof Error ? { data: null, error: stockMap } : { data: { value: stockMap }, error: null }
        ),
        then: (resolve: any, reject: any) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      }
      return chain
    },
  } as any
}

const tables = {
  shop_packages: [{ shop_id: "s1", package_id: "p-mtn", is_available: true }],
  packages: [
    { id: "p-mtn", network: "MTN", is_available: false },
    { id: "p-tel", network: "Telecel", is_available: false },
  ],
}

describe("loadShopStockNotices", () => {
  it("returns notices only for out-of-stock networks the shop sells", async () => {
    const map = { MTN: { outOfStock: true, reason: "Back at 6pm" }, Telecel: { outOfStock: true } }
    expect(await loadShopStockNotices(fakeClient(map, tables), "s1", null)).toEqual({ MTN: "Back at 6pm" })
  })

  it("skips the package lookup when nothing is out of stock", async () => {
    const calls: string[] = []
    expect(await loadShopStockNotices(fakeClient({ MTN: { outOfStock: false } }, tables, calls), "s1", null)).toEqual({})
    expect(calls).toEqual(["admin_settings"])
  })

  it("fails open to {} when the settings read errors", async () => {
    expect(await loadShopStockNotices(fakeClient(new Error("down"), tables), "s1", null)).toEqual({})
  })
})
