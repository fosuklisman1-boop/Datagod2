import { describe, it, expect, vi, beforeEach } from "vitest"
import { deriveFromLegacy } from "./config"

const invalidate = vi.fn()
const getConfig = vi.fn()
const getFresh = vi.fn()

vi.mock("@/lib/payment-gateway/read-config", () => ({
  GATEWAY_CONFIG_KEY: "payment_gateway_config",
  getGatewayConfig: () => getConfig(),
  readGatewayConfigFresh: () => getFresh(),
  invalidateGatewayConfigCache: () => invalidate(),
}))

import { setSurfaceModes, saveGatewayConfig } from "./write-config"

function fakeDb() {
  const upsert = vi.fn(async () => ({ error: null }))
  return { db: { from: vi.fn(() => ({ upsert })) } as any, upsert }
}

beforeEach(() => {
  vi.clearAllMocks()
  getConfig.mockResolvedValue(deriveFromLegacy({ storefrontDirect: false, walletDirect: false }))
  getFresh.mockResolvedValue(deriveFromLegacy({ storefrontDirect: false, walletDirect: false }))
})

describe("setSurfaceModes", () => {
  it("sets the listed surfaces, leaves others, upserts under the config key and invalidates cache", async () => {
    const { db, upsert } = fakeDb()
    const result = await setSurfaceModes(db, ["wallet_topup", "dashboard_direct", "sms"], "direct", "a@x")
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, opts] = upsert.mock.calls[0] as any
    const row = rows[0]
    expect(row.key).toBe("payment_gateway_config")
    expect(row.value.surfaces.wallet_topup.mode).toBe("direct")
    expect(row.value.surfaces.dashboard_direct.mode).toBe("direct")
    expect(row.value.surfaces.sms.mode).toBe("direct")
    expect(row.value.surfaces.storefront.mode).toBe("checkout")
    expect(opts).toEqual({ onConflict: "key" })
    expect(result).toEqual(row.value)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("writes config + both legacy rows in ONE upsert, with correct enabled flags (wallet_topup independent of dashboard_direct)", async () => {
    const { db, upsert } = fakeDb()
    getFresh.mockResolvedValue(deriveFromLegacy({ storefrontDirect: false, walletDirect: false }))
    await setSurfaceModes(db, ["dashboard_direct"], "direct", "admin@example.com")
    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, opts] = upsert.mock.calls[0] as any
    expect(opts).toEqual({ onConflict: "key" })
    expect(rows.map((r: any) => r.key)).toEqual(["payment_gateway_config", "storefront_direct_charge", "wallet_direct_charge"])
    expect(rows[1].value).toEqual({ enabled: false })
    expect(rows[2].value).toEqual({ enabled: false }) // wallet_topup untouched, dashboard_direct is now direct
    expect(rows[0].value.surfaces.dashboard_direct.mode).toBe("direct")

    upsert.mockClear()
    await setSurfaceModes(db, ["storefront", "wallet_topup"], "direct", "admin@example.com")
    const rows2 = (upsert.mock.calls[0] as any)[0]
    expect(rows2[1].value).toEqual({ enabled: true })
    expect(rows2[2].value).toEqual({ enabled: true })
  })

  it("does not persist the admin email in any row", async () => {
    const { db, upsert } = fakeDb()
    await setSurfaceModes(db, ["sms"], "direct", "admin@example.com")
    expect(JSON.stringify(upsert.mock.calls[0])).not.toContain("admin@example.com")
  })

  it("skips direct-only surfaces", async () => {
    const { db, upsert } = fakeDb()
    await setSurfaceModes(db, ["ussd"], "checkout", "a@x")
    expect((upsert.mock.calls[0] as any)[0][0].value.surfaces.ussd.mode).toBe("direct")
  })

  it("sms_order never touches the legacy direct-charge rows", async () => {
    const { db, upsert } = fakeDb()
    const a = deriveFromLegacy({ storefrontDirect: true, walletDirect: false })
    const b = JSON.parse(JSON.stringify(a))
    b.surfaces.sms_order = { gateway: "hubtel", mode: "direct", feeBearer: "merchant" }
    await saveGatewayConfig(db, a, "x")
    await saveGatewayConfig(db, b, "x")
    const [rowsA, rowsB] = [(upsert.mock.calls[0] as any)[0], (upsert.mock.calls[1] as any)[0]]
    expect(rowsB[0].value.surfaces.sms_order.gateway).toBe("hubtel")
    const noStamp = (rows: any[]) => rows.map(({ updated_at: _u, ...r }) => r)
    expect(noStamp(rowsB.slice(1))).toEqual(noStamp(rowsA.slice(1)))
    expect(rowsA.slice(1).map((r: any) => r.key)).toEqual(["storefront_direct_charge", "wallet_direct_charge"])
  })

  it("setSurfaceModes cannot flip sms_order to checkout", async () => {
    const { db, upsert } = fakeDb()
    await setSurfaceModes(db, ["sms_order"], "checkout", "a@x")
    expect((upsert.mock.calls[0] as any)[0][0].value.surfaces.sms_order.mode).toBe("direct")
  })

  it("throws and does not invalidate when the upsert fails", async () => {
    const upsert = vi.fn(async () => ({ error: { message: "boom" } }))
    const db = { from: () => ({ upsert }) } as any
    await expect(saveGatewayConfig(db, await getConfig(), "a@x")).rejects.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it("builds from the FRESH row, not the stale cache (keeps other surfaces and fee)", async () => {
    const stale = deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
    const fresh = deriveFromLegacy({ storefrontDirect: true, walletDirect: false })
    fresh.hubtelFeePercent = 2.5
    getConfig.mockResolvedValue(stale)
    getFresh.mockResolvedValue(fresh)
    const { db, upsert } = fakeDb()
    await setSurfaceModes(db, ["wallet_topup", "dashboard_direct", "sms"], "direct", "a@x")
    const saved = (upsert.mock.calls[0] as any)[0][0].value
    expect(saved.surfaces.storefront.mode).toBe("direct")
    expect(saved.hubtelFeePercent).toBe(2.5)
    expect(saved.surfaces.wallet_topup.mode).toBe("direct")
  })

  it("rejects and saves nothing when the fresh read throws", async () => {
    getFresh.mockRejectedValue(new Error("db down"))
    const { db, upsert } = fakeDb()
    await expect(setSurfaceModes(db, ["storefront"], "direct", "a@x")).rejects.toThrow("db down")
    expect(upsert).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })
})
