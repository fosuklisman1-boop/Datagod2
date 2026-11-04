import { describe, it, expect, vi, beforeEach } from "vitest"
import { deriveFromLegacy } from "./config"

const invalidate = vi.fn()
const getConfig = vi.fn()

vi.mock("@/lib/payment-gateway/read-config", () => ({
  GATEWAY_CONFIG_KEY: "payment_gateway_config",
  getGatewayConfig: () => getConfig(),
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
})

describe("setSurfaceModes", () => {
  it("sets the listed surfaces, leaves others, upserts under the config key and invalidates cache", async () => {
    const { db, upsert } = fakeDb()
    const result = await setSurfaceModes(db, ["wallet_topup", "dashboard_direct", "sms"], "direct", "a@x")
    expect(upsert).toHaveBeenCalledTimes(1)
    const [row, opts] = upsert.mock.calls[0] as any
    expect(row.key).toBe("payment_gateway_config")
    expect(row.value.surfaces.wallet_topup.mode).toBe("direct")
    expect(row.value.surfaces.dashboard_direct.mode).toBe("direct")
    expect(row.value.surfaces.sms.mode).toBe("direct")
    expect(row.value.surfaces.storefront.mode).toBe("checkout")
    expect(opts).toEqual({ onConflict: "key" })
    expect(result).toEqual(row.value)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it("skips direct-only surfaces", async () => {
    const { db, upsert } = fakeDb()
    await setSurfaceModes(db, ["ussd"], "checkout", "a@x")
    expect((upsert.mock.calls[0] as any)[0].value.surfaces.ussd.mode).toBe("direct")
  })

  it("throws and does not invalidate when the upsert fails", async () => {
    const upsert = vi.fn(async () => ({ error: { message: "boom" } }))
    const db = { from: () => ({ upsert }) } as any
    await expect(saveGatewayConfig(db, await getConfig(), "a@x")).rejects.toThrow()
    expect(invalidate).not.toHaveBeenCalled()
  })
})
