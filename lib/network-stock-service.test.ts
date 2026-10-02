import { describe, it, expect, beforeEach } from "vitest"
import {
  getNetworkStockMap,
  setNetworkOutOfStock,
  restockNetwork,
  NETWORK_STOCK_KEY,
  type NetworkStockMap,
} from "./network-stock-service"

interface FakePackage {
  id: string
  network: string
  is_available: boolean | null
}

interface FakeState {
  stockMap: NetworkStockMap | null // null = row never seeded
  packages: FakePackage[]
  updateCalls: Array<{ ids: string[]; patch: any }>
  upsertCalls: Array<{ key: string; value: NetworkStockMap }>
}

// Plain fake object literal — no @supabase/supabase-js mocking needed since
// network-stock-service takes the client as a parameter.
function createFakeSupabase(state: FakeState) {
  return {
    from(table: string) {
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: () =>
                Promise.resolve(
                  key === NETWORK_STOCK_KEY && state.stockMap !== null
                    ? { data: { value: state.stockMap }, error: null }
                    : { data: null, error: null }
                ),
            }),
          }),
          upsert: (row: { key: string; value: NetworkStockMap }) => {
            state.upsertCalls.push(row)
            state.stockMap = row.value
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === "packages") {
        return {
          select: () => ({
            eq: (_col: string, network: string) =>
              Promise.resolve({
                data: state.packages
                  .filter((p) => p.network === network)
                  .map((p) => ({ id: p.id, is_available: p.is_available })),
                error: null,
              }),
          }),
          update: (patch: { is_available: boolean }) => ({
            in: (_col: string, ids: string[]) => {
              state.updateCalls.push({ ids, patch })
              for (const pkg of state.packages) {
                if (ids.includes(pkg.id)) pkg.is_available = patch.is_available
              }
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  } as any
}

let state: FakeState

beforeEach(() => {
  state = { stockMap: {}, packages: [], updateCalls: [], upsertCalls: [] }
})

describe("getNetworkStockMap", () => {
  it("returns {} when the settings row has never been seeded", async () => {
    state.stockMap = null
    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map).toEqual({})
  })
})

describe("setNetworkOutOfStock", () => {
  it("disables all currently-available packages (including is_available: null) and returns their ids", async () => {
    state.packages = [
      { id: "p1", network: "MTN", is_available: true },
      { id: "p2", network: "MTN", is_available: null },
      { id: "p3", network: "Telecel", is_available: true }, // different network — untouched
    ]

    const result = await setNetworkOutOfStock(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 2, alreadyOutOfStock: false })
    expect(state.updateCalls).toHaveLength(1)
    expect(new Set(state.updateCalls[0].ids)).toEqual(new Set(["p1", "p2"]))
    expect(state.updateCalls[0].patch).toEqual({ is_available: false })
    expect(state.packages.find((p) => p.id === "p1")!.is_available).toBe(false)
    expect(state.packages.find((p) => p.id === "p2")!.is_available).toBe(false)
    expect(state.packages.find((p) => p.id === "p3")!.is_available).toBe(true) // other network untouched

    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map.MTN).toEqual({ outOfStock: true, restoreIds: expect.arrayContaining(["p1", "p2"]) })
  })

  it("excludes a package already is_available: false from restoreIds and leaves it untouched", async () => {
    state.packages = [
      { id: "p1", network: "MTN", is_available: true },
      { id: "p2", network: "MTN", is_available: false }, // individually disabled beforehand
    ]

    const result = await setNetworkOutOfStock(createFakeSupabase(state), "MTN")

    expect(result.affected).toBe(1)
    expect(state.updateCalls[0].ids).toEqual(["p1"])
    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map.MTN!.restoreIds).toEqual(["p1"])
    expect(map.MTN!.restoreIds).not.toContain("p2")
  })

  it("is a true no-op on a second call while already out of stock: no re-fetch/update, restoreIds untouched", async () => {
    state.packages = [
      { id: "p1", network: "MTN", is_available: true },
      { id: "p2", network: "MTN", is_available: null },
    ]

    const first = await setNetworkOutOfStock(createFakeSupabase(state), "MTN")
    expect(first.alreadyOutOfStock).toBe(false)
    expect(state.updateCalls).toHaveLength(1)
    expect(state.upsertCalls).toHaveLength(1)
    const snapshotAfterFirst = [...state.stockMap!.MTN!.restoreIds!]

    // Second call: by now both packages are is_available=false in the DB.
    // Without the idempotency guard, re-snapshotting would produce an EMPTY
    // restoreIds (nothing left "available" to disable), permanently losing
    // which packages should be restored later.
    const second = await setNetworkOutOfStock(createFakeSupabase(state), "MTN")

    expect(second).toEqual({ affected: 0, alreadyOutOfStock: true })
    expect(state.updateCalls).toHaveLength(1) // no additional .update() call
    expect(state.upsertCalls).toHaveLength(1) // no additional .upsert() call
    expect(state.stockMap!.MTN!.restoreIds).toEqual(snapshotAfterFirst)
  })

  it("handles a network with zero currently-available packages: empty restoreIds, no .update() call, no crash", async () => {
    state.packages = [{ id: "p1", network: "MTN", is_available: false }]

    const result = await setNetworkOutOfStock(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 0, alreadyOutOfStock: false })
    expect(state.updateCalls).toHaveLength(0) // never call .in("id", [])
    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map.MTN).toEqual({ outOfStock: true, restoreIds: [] })
  })

  it("handles a network with zero packages at all: empty restoreIds, no .update() call, no crash", async () => {
    state.packages = []

    const result = await setNetworkOutOfStock(createFakeSupabase(state), "AT - BigTime")

    expect(result).toEqual({ affected: 0, alreadyOutOfStock: false })
    expect(state.updateCalls).toHaveLength(0)
  })
})

describe("restockNetwork", () => {
  it("re-enables exactly the snapshotted restoreIds, not a package individually disabled before the network-wide disable", async () => {
    state.packages = [
      { id: "p1", network: "MTN", is_available: true },
      { id: "p2", network: "MTN", is_available: false }, // individually disabled beforehand — must stay disabled
    ]
    await setNetworkOutOfStock(createFakeSupabase(state), "MTN")
    expect(state.packages.find((p) => p.id === "p1")!.is_available).toBe(false)
    expect(state.packages.find((p) => p.id === "p2")!.is_available).toBe(false)

    const result = await restockNetwork(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 1, alreadyInStock: false })
    expect(state.packages.find((p) => p.id === "p1")!.is_available).toBe(true) // restored
    expect(state.packages.find((p) => p.id === "p2")!.is_available).toBe(false) // stays disabled

    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map.MTN).toEqual({ outOfStock: false })
    expect(map.MTN).not.toHaveProperty("restoreIds")
  })

  it("is a no-op when the network is not currently out of stock (never tracked)", async () => {
    const result = await restockNetwork(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 0, alreadyInStock: true })
    expect(state.updateCalls).toHaveLength(0)
    expect(state.upsertCalls).toHaveLength(0)
  })

  it("is a no-op when the network was restocked already (outOfStock: false)", async () => {
    state.stockMap = { MTN: { outOfStock: false } }

    const result = await restockNetwork(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 0, alreadyInStock: true })
    expect(state.updateCalls).toHaveLength(0)
    expect(state.upsertCalls).toHaveLength(0)
  })

  it("handles an empty restoreIds snapshot: no .update() call, no crash, still flips outOfStock to false", async () => {
    state.stockMap = { MTN: { outOfStock: true, restoreIds: [] } }

    const result = await restockNetwork(createFakeSupabase(state), "MTN")

    expect(result).toEqual({ affected: 0, alreadyInStock: false })
    expect(state.updateCalls).toHaveLength(0)
    const map = await getNetworkStockMap(createFakeSupabase(state))
    expect(map.MTN).toEqual({ outOfStock: false })
  })

  it("is robust to restoreIds referencing packages since deleted — matches only what still exists", async () => {
    state.packages = [{ id: "p1", network: "MTN", is_available: false }]
    state.stockMap = { MTN: { outOfStock: true, restoreIds: ["p1", "deleted-id"] } }

    const result = await restockNetwork(createFakeSupabase(state), "MTN")

    expect(result.affected).toBe(2) // affected reflects the snapshot size, not actual DB rows touched
    expect(state.packages.find((p) => p.id === "p1")!.is_available).toBe(true)
  })
})
