// Real singleton + wrappers (direct-charge.ts -> read-config.ts -> legacy-direct-charge.ts -> storefront-otp.ts),
// with only @supabase/supabase-js mocked. Verifies legacy fallback, OTP inheritance and config-row precedence.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key"
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost"
  return {
    /** admin_settings rows by key; absent key => no row. */
    rows: {} as Record<string, unknown>,
    /** keys whose read returns a DB error */
    errorKeys: new Set<string>(),
  }
})

vi.mock("../security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table !== "admin_settings") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_c: string, key: string) => ({
            async maybeSingle() {
              if (h.errorKeys.has(key)) return { data: null, error: { message: "db error" } }
              return key in h.rows ? { data: { value: h.rows[key] }, error: null } : { data: null, error: null }
            },
          }),
        }),
      }
    },
  }),
}))

type Mods = {
  direct: typeof import("./direct-charge")
  read: typeof import("./read-config")
}

async function load(): Promise<Mods> {
  vi.resetModules()
  return {
    direct: await import("./direct-charge"),
    read: await import("./read-config"),
  }
}

const configRow = (modes: Partial<Record<"wallet_topup" | "storefront" | "dashboard_direct" | "sms", "direct" | "checkout">>) => {
  const mk = (mode: string) => ({ gateway: "paystack", mode, feeBearer: "customer" })
  return {
    version: 1,
    surfaces: {
      wallet_topup: mk(modes.wallet_topup ?? "checkout"),
      storefront: mk(modes.storefront ?? "checkout"),
      dashboard_direct: mk(modes.dashboard_direct ?? "checkout"),
      sms: mk(modes.sms ?? "checkout"),
      ussd: mk("direct"),
      whatsapp: mk("direct"),
    },
    hubtelFeePercent: 0,
  }
}

beforeEach(() => {
  h.rows = {}
  h.errorKeys = new Set()
})

describe("direct-charge wrappers over the real config singleton", () => {
  it("no config row, storefront_direct_charge={enabled:true} -> storefront direct", async () => {
    h.rows.storefront_direct_charge = { enabled: true }
    const { direct } = await load()
    expect(await direct.isStorefrontDirectChargeEnabled()).toBe(true)
  })

  it("no config row, legacy row absent: inherits the storefront OTP gate", async () => {
    h.rows.storefront_otp_required = { enabled: true }
    let m = await load()
    expect(await m.direct.isStorefrontDirectChargeEnabled()).toBe(true)

    h.rows.storefront_otp_required = { enabled: false }
    m = await load()
    expect(await m.direct.isStorefrontDirectChargeEnabled()).toBe(false)
  })

  it("wallet_direct_charge={enabled:true}, no config row -> wallet, dashboard and SMS all direct", async () => {
    h.rows.wallet_direct_charge = { enabled: true }
    const { direct } = await load()
    expect(await direct.isWalletDirectChargeEnabled()).toBe(true)
    expect(await direct.isDashboardDirectChargeEnabled()).toBe(true)
    expect(await direct.isSmsDirectChargeEnabled()).toBe(true)
    expect(await direct.isStorefrontDirectChargeEnabled()).toBe(false)
  })

  it("config row present overrides the legacy rows (storefront checkout beats legacy enabled:true)", async () => {
    h.rows.payment_gateway_config = configRow({ storefront: "checkout" })
    h.rows.storefront_direct_charge = { enabled: true }
    const { direct } = await load()
    expect(await direct.isStorefrontDirectChargeEnabled()).toBe(false)
  })

  it("config row present: surfaces are independent (wallet checkout, dashboard direct)", async () => {
    h.rows.payment_gateway_config = configRow({ dashboard_direct: "direct" })
    h.rows.wallet_direct_charge = { enabled: true } // legacy must be ignored
    const { direct } = await load()
    expect(await direct.isWalletDirectChargeEnabled()).toBe(false)
    expect(await direct.isDashboardDirectChargeEnabled()).toBe(true)
  })
})

describe("readGatewayConfigFresh", () => {
  it("rejects when the DB read errors", async () => {
    h.errorKeys.add("payment_gateway_config")
    const { read } = await load()
    await expect(read.readGatewayConfigFresh()).rejects.toThrow("db error")
  })

  it("row absent: derives from legacy and invalidates the caches", async () => {
    h.rows.storefront_direct_charge = { enabled: true }
    const { read, direct } = await load()
    // Prime the caches with the old state.
    expect(await direct.isStorefrontDirectChargeEnabled()).toBe(true)
    // Flip the legacy row; a stale cache would still answer true.
    h.rows.storefront_direct_charge = { enabled: false }
    const fresh = await read.readGatewayConfigFresh()
    expect(fresh.surfaces.storefront.mode).toBe("checkout")
    // Caches were invalidated, so the cached reader now sees the new state too.
    expect(await direct.isStorefrontDirectChargeEnabled()).toBe(false)
  })

  it("row present: returns the sanitized row, not the legacy-derived state", async () => {
    h.rows.payment_gateway_config = configRow({ sms: "direct", wallet_topup: "direct" })
    h.rows.wallet_direct_charge = { enabled: false }
    const { read } = await load()
    const fresh = await read.readGatewayConfigFresh()
    expect(fresh.surfaces.sms.mode).toBe("direct")
    expect(fresh.surfaces.wallet_topup.mode).toBe("direct")
    expect(fresh.surfaces.storefront.mode).toBe("checkout")
    expect(fresh.surfaces.ussd.mode).toBe("direct")
  })
})
