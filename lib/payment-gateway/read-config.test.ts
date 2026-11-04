import { describe, it, expect, vi } from "vitest"
import { createGatewayConfigReader } from "./read-config"
import { deriveFromLegacy } from "./config"

function mk(opts: {
  row?: unknown
  rowFn?: () => Promise<unknown>
  legacy?: { storefrontDirect: boolean; walletDirect: boolean }
  legacyFn?: () => Promise<{ storefrontDirect: boolean; walletDirect: boolean }>
}) {
  let t = 1000
  const readRow = vi.fn(opts.rowFn ?? (async () => opts.row ?? null))
  const readLegacy = vi.fn(
    opts.legacyFn ?? (async () => opts.legacy ?? { storefrontDirect: false, walletDirect: false }),
  )
  const reader = createGatewayConfigReader({
    readRow,
    readLegacy,
    now: () => t,
    ttlMs: 30_000,
  })
  return { reader, readRow, readLegacy, advance: (ms: number) => { t += ms } }
}

describe("createGatewayConfigReader", () => {
  it("row absent derives everything from legacy", async () => {
    const { reader } = mk({ row: null, legacy: { storefrontDirect: true, walletDirect: true } })
    const c = await reader.get()
    expect(c.surfaces.storefront.mode).toBe("direct")
    expect(c.surfaces.wallet_topup.mode).toBe("direct")
    expect(c.surfaces.dashboard_direct.mode).toBe("direct")
    expect(c.surfaces.sms.mode).toBe("direct")
  })

  it("row present overrides its surface; others come from legacy", async () => {
    const { reader } = mk({
      row: { version: 1, surfaces: { storefront: { gateway: "paystack", mode: "checkout", feeBearer: "merchant" } } },
      legacy: { storefrontDirect: true, walletDirect: true },
    })
    const c = await reader.get()
    expect(c.surfaces.storefront.mode).toBe("checkout")
    expect(c.surfaces.storefront.feeBearer).toBe("merchant")
    expect(c.surfaces.wallet_topup.mode).toBe("direct")
  })

  it("caches within TTL, refetches after invalidate and after TTL", async () => {
    const { reader, readRow, advance } = mk({ row: null })
    await reader.get()
    await reader.get()
    expect(readRow).toHaveBeenCalledTimes(1)
    reader.invalidate()
    await reader.get()
    expect(readRow).toHaveBeenCalledTimes(2)
    advance(30_001)
    await reader.get()
    expect(readRow).toHaveBeenCalledTimes(3)
  })

  it("falls back to last-known config when a later read throws", async () => {
    let fail = false
    const { reader, advance } = mk({
      rowFn: async () => {
        if (fail) throw new Error("db down")
        return { version: 1, surfaces: { storefront: { gateway: "paystack", mode: "direct", feeBearer: "customer" } } }
      },
    })
    expect((await reader.get()).surfaces.storefront.mode).toBe("direct")
    fail = true
    advance(30_001)
    expect((await reader.get()).surfaces.storefront.mode).toBe("direct")
  })

  it("first-ever readRow throw falls back to legacy and resolves", async () => {
    const { reader } = mk({
      rowFn: async () => { throw new Error("db down") },
      legacy: { storefrontDirect: true, walletDirect: false },
    })
    expect(await reader.get()).toEqual(deriveFromLegacy({ storefrontDirect: true, walletDirect: false }))
  })

  it("never rejects even if legacy also throws", async () => {
    const { reader } = mk({
      rowFn: async () => { throw new Error("db down") },
      legacyFn: async () => { throw new Error("legacy down") },
    })
    expect(await reader.get()).toEqual(deriveFromLegacy({ storefrontDirect: false, walletDirect: false }))
  })
})
