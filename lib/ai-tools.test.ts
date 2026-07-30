import { describe, it, expect, vi, beforeEach } from "vitest"
import { aiTools, executeToolCall } from "@/lib/ai-tools"

vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: vi.fn(),
  fetchShopNetworks: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({
  setShopPref: vi.fn(),
  getShopPref: vi.fn(),
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({
  fetchShopBundles: vi.fn(),
  shopOwnerIsDealer: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/shop-session", () => ({
  getSession: vi.fn(),
  setSession: vi.fn(),
}))
vi.mock("@/lib/network-prefix-config", () => ({
  getPrefixValidationConfig: vi.fn(),
}))
// Keep the pure helpers (detectAirtimeNetwork, airtimeNetworkKey, splitInclusive)
// real — no DB dependency, deterministic — and only mock the async
// admin-settings-backed ones, matching lib/whatsapp-bot/shop-router.test.ts's
// established pattern for this same module.
vi.mock("@/lib/airtime-pricing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/airtime-pricing")>("@/lib/airtime-pricing")
  return {
    ...actual,
    isAirtimeEnabled: vi.fn(),
    getAirtimeLimits: vi.fn(),
    airtimeBaseFeeRate: vi.fn(),
  }
})
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(),
  getAvailableCount: vi.fn(),
  getMaxQuantity: vi.fn(),
  calculateRCPrice: vi.fn(),
}))

// Backs currentShopForPhone's ussd_shop_codes lookup and place_shop_order's
// airtime-branch user_shops markup read — the only two raw Supabase reads the
// three shop AI tools make outside the mocked lib/* collaborators above.
// lib/phone-format.ts's validateNetworkPrefix and
// lib/ussd/paystack-provider.ts's paystackProviderFromPhone are deliberately
// left un-mocked (pure, deterministic) so tests exercise the real logic.
const fakeSupabase = vi.hoisted(() => ({
  shopCode: "AB12CD" as string | null,
  airtimeMarkup: "0" as string | null,
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "ussd_shop_codes") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: fakeSupabase.shopCode ? { code: fakeSupabase.shopCode } : null,
              }),
            }),
          }),
        }
      }
      if (table === "user_shops") {
        return {
          select: (col: string) => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { [col]: fakeSupabase.airtimeMarkup } }),
            }),
          }),
        }
      }
      throw new Error(`ai-tools.test.ts fake supabase client: unexpected table "${table}"`)
    },
  }),
}))

import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { setShopPref, getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import { fetchShopBundles, shopOwnerIsDealer } from "@/lib/shop-commerce/pricing"
import { getSession, setSession } from "@/lib/whatsapp-bot/shop-session"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate, splitInclusive } from "@/lib/airtime-pricing"
import { isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice } from "@/lib/results-checker-service"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"

// vitest.config.ts doesn't set clearMocks/resetMocks — without a reset, mock
// call history AND custom implementations from one `it` leak into the next.
// A single top-level beforeEach covers every describe block in this file.
beforeEach(() => {
  vi.resetAllMocks()
  fakeSupabase.shopCode = "AB12CD"
  fakeSupabase.airtimeMarkup = "0"
})

// Wires getShopPref + the fake ussd_shop_codes row + resolveShopCode so
// currentShopForPhone (used by get_shop_packages and place_shop_order)
// resolves to a known, active shop. Individual tests override whichever
// piece they need to vary (or override getShopPref to null for "no shop known").
function mockKnownShop() {
  vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
  vi.mocked(resolveShopCode).mockResolvedValue({
    shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
    parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
  })
}

describe("aiTools whatsapp_shop context", () => {
  it("returns exactly the three shop-scoped tools", () => {
    const tools = aiTools("whatsapp_shop").map(t => t.name)
    expect(tools).toEqual(["resolve_shop_code", "get_shop_packages", "place_shop_order"])
  })
})

describe("executeToolCall resolve_shop_code", () => {
  const baseCtx = { baseUrl: "http://localhost:3000", phone: "233559919037" }

  it("resolves a valid active code and remembers it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN", "Telecel"])

    const result = await executeToolCall("resolve_shop_code", { code: "AB12CD" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(true)
    expect(result.shopName).toBe("Kofi's Data Hub")
    expect(setShopPref).toHaveBeenCalledWith("233559919037", "code-1")
  })

  it("returns a reason without remembering an invalid code", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    const result = await executeToolCall("resolve_shop_code", { code: "ZZZZZZ" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })

  it("rejects an inactive shop without remembering it", async () => {
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-2", shopId: "shop-2", shopName: "Ama's Shop",
      parentShopId: null, status: "suspended", tokenBalance: 5, whatsappActivated: true,
    })

    const result = await executeToolCall("resolve_shop_code", { code: "CD34EF" }, baseCtx) as Record<string, unknown>

    expect(result.resolved).toBe(false)
    expect(setShopPref).not.toHaveBeenCalled()
  })
})

describe("executeToolCall get_shop_packages", () => {
  const baseCtx = { baseUrl: "http://localhost:3000", phone: "233559919037" }

  beforeEach(() => {
    mockKnownShop()
  })

  it("returns bundles grouped by network, airtime availability/limits, and RC board pricing from mocked collaborators (not real DB calls)", async () => {
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN", "Telecel"])
    vi.mocked(fetchShopBundles).mockImplementation(async (_shopId, network) => {
      if (network === "MTN") return [{ id: "m1", size: "1", price: 6 }, { id: "m5", size: "5", price: 25 }]
      if (network === "Telecel") return [{ id: "t2", size: "2", price: 12 }]
      return []
    })
    vi.mocked(getAirtimeLimits).mockResolvedValue({ min: 1, max: 500 })
    vi.mocked(isAirtimeEnabled).mockResolvedValue(true)
    // Only WASSCE enabled — exercises the "skip disabled board" branch too.
    vi.mocked(isExamBoardEnabled).mockImplementation(async board => board === "WASSCE")
    vi.mocked(getAvailableCount).mockResolvedValue(12)
    vi.mocked(getMaxQuantity).mockResolvedValue(50)
    vi.mocked(calculateRCPrice).mockResolvedValue({
      basePrice: 5, markupPerVoucher: 0, unitPrice: 5, totalPaid: 5, merchantCommission: 0, bulkApplied: false,
    })

    const result = await executeToolCall("get_shop_packages", {}, baseCtx) as Record<string, unknown>

    expect(result.shopName).toBe("Kofi's Data Hub")
    expect(result.dataBundles).toEqual({
      MTN: [{ size: "1", price: 6 }, { size: "5", price: 25 }],
      Telecel: [{ size: "2", price: 12 }],
    })
    expect(result.airtime).toEqual({
      available: { MTN: true, Telecel: true, AT: true },
      minGHS: 1,
      maxGHS: 500,
    })
    // BECE/NOVDEC are disabled in this test and must NOT appear at all.
    expect(result.resultsChecker).toEqual({
      WASSCE: { available: 12, maxPerOrder: 50, unitPrice: 5 },
    })
  })

  it("narrows to just the requested network when `network` is passed", async () => {
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN", "Telecel"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "m1", size: "1", price: 6 }])
    vi.mocked(getAirtimeLimits).mockResolvedValue({ min: 1, max: 500 })
    vi.mocked(isAirtimeEnabled).mockResolvedValue(true)
    vi.mocked(isExamBoardEnabled).mockResolvedValue(false)

    const result = await executeToolCall("get_shop_packages", { network: "mtn" }, baseCtx) as Record<string, unknown>

    expect(fetchShopBundles).toHaveBeenCalledTimes(1)
    expect(fetchShopBundles).toHaveBeenCalledWith("shop-1", "MTN", undefined)
    expect(result.dataBundles).toEqual({ MTN: [{ size: "1", price: 6 }] })
  })

  it("returns no_shop when the customer's phone has no remembered shop", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)

    const result = await executeToolCall("get_shop_packages", {}, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("no_shop")
    expect(fetchShopBundles).not.toHaveBeenCalled()
  })
})

describe("executeToolCall place_shop_order", () => {
  const baseCtx = { baseUrl: "http://localhost:3000", phone: "233559919037" }

  beforeEach(() => {
    mockKnownShop()
    vi.mocked(getSession).mockResolvedValue(null)
    vi.mocked(getPrefixValidationConfig).mockResolvedValue({ enabled: false, map: DEFAULT_NETWORK_PREFIXES })
    vi.mocked(isAirtimeEnabled).mockResolvedValue(true)
    vi.mocked(getAirtimeLimits).mockResolvedValue({ min: 1, max: 500 })
    vi.mocked(shopOwnerIsDealer).mockResolvedValue(false)
    vi.mocked(airtimeBaseFeeRate).mockResolvedValue(5)
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(20)
    vi.mocked(getMaxQuantity).mockResolvedValue(50)
  })

  const baseExpectedSession = {
    shopCodeId: "code-1",
    shopId: "shop-1",
    parentShopId: undefined,
    shopName: "Kofi's Data Hub",
    paymentPhone: "0244000000",
    paystackProvider: "mtn",
  }

  // ── Happy paths — verify the EXACT WaShopSession staged at the EXACT step ──
  it("stages a data order at CONFIRM with the DB-verified price, not a guessed one", async () => {
    vi.mocked(fetchShopBundles).mockResolvedValue([
      { id: "pkg-1gb", size: "1", price: 6 },
      { id: "pkg-5gb", size: "5", price: 25 },
    ])

    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0244123456", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.staged).toBe(true)
    expect(result.price).toBe(25)
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledWith("233559919037", {
      ...baseExpectedSession,
      step: "CONFIRM",
      network: "MTN",
      bundleId: "pkg-5gb",
      bundleSize: "5",
      bundlePrice: 25,
      recipientPhone: "0244123456",
    })
  })

  it("stages an airtime order at AIRTIME_CONFIRM, auto-detecting the network from the recipient", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "airtime", recipient_phone: "0244123456", amount: "10",
      payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    const { fee, toDeliver } = splitInclusive(10, 5) // baseRate 5%, no shop markup (fakeSupabase.airtimeMarkup = "0")

    expect(result.staged).toBe(true)
    expect(result.network).toBe("MTN") // detected from the 024 prefix
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledWith("233559919037", {
      ...baseExpectedSession,
      step: "AIRTIME_CONFIRM",
      airtimeNetwork: "MTN",
      airtimeRecipient: "0244123456",
      airtimeAmount: 10,
      airtimeFee: fee,
      airtimeToDeliver: toDeliver,
    })
  })

  it("stages an RC order at RC_CONFIRM with the DB-priced total", async () => {
    vi.mocked(calculateRCPrice).mockResolvedValue({
      basePrice: 4, markupPerVoucher: 1, unitPrice: 5, totalPaid: 10, merchantCommission: 2, bulkApplied: false,
    })

    const result = await executeToolCall("place_shop_order", {
      service: "rc", board: "wassce", quantity: "2", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.staged).toBe(true)
    expect(result.total).toBe(10)
    expect(setSession).toHaveBeenCalledTimes(1)
    expect(setSession).toHaveBeenCalledWith("233559919037", {
      ...baseExpectedSession,
      step: "RC_CONFIRM",
      rcBoard: "WASSCE",
      rcQty: 2,
      rcUnitPrice: 5,
      rcTotal: 10,
      rcMerchantCommission: 2,
    })
  })

  // ── payment_phone validation — must fail closed, no session written ──────
  it("rejects a malformed payment_phone and writes no session", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0244123456", payment_phone: "12345",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("invalid_payment_phone")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("rejects a payment_phone whose prefix has no Paystack provider and writes no session", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0244123456", payment_phone: "0230000000", // valid Ghana shape, unsupported prefix
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("invalid_payment_phone")
    expect(setSession).not.toHaveBeenCalled()
  })

  // ── DATA validation ───────────────────────────────────────────────────────
  it("data: rejects an invalid recipient number and writes no session", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "123", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("invalid_recipient")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("data: rejects a network/recipient prefix mismatch and writes no session", async () => {
    vi.mocked(getPrefixValidationConfig).mockResolvedValue({ enabled: true, map: DEFAULT_NETWORK_PREFIXES })

    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0201234567", // 020 = Telecel, not MTN
      payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("prefix_mismatch")
    expect(fetchShopBundles).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })

  it("data: rejects a bundle size that doesn't exist for the network and writes no session", async () => {
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "pkg-1gb", size: "1", price: 6 }])

    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5", // only "1" exists per the mock above
      recipient_phone: "0244123456", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("unknown_bundle")
    expect(setSession).not.toHaveBeenCalled()
  })

  // ── AIRTIME validation ────────────────────────────────────────────────────
  it("airtime: rejects an undetectable network with no explicit network given and writes no session", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "airtime", recipient_phone: "0230000000", amount: "10", // 023 isn't in any network's prefix list
      payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("unknown_network")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("airtime: rejects an amount outside getAirtimeLimits() and writes no session", async () => {
    vi.mocked(getAirtimeLimits).mockResolvedValue({ min: 1, max: 500 })

    const result = await executeToolCall("place_shop_order", {
      service: "airtime", recipient_phone: "0244123456", amount: "1000",
      payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("out_of_range")
    expect(setSession).not.toHaveBeenCalled()
  })

  // ── RC validation ─────────────────────────────────────────────────────────
  it("rc: rejects an unrecognised exam board and writes no session", async () => {
    const result = await executeToolCall("place_shop_order", {
      service: "rc", board: "not-a-board", quantity: "2", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("unknown_board")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("rc: rejects a quantity above the availability cap and writes no session", async () => {
    vi.mocked(getAvailableCount).mockResolvedValue(3)
    vi.mocked(getMaxQuantity).mockResolvedValue(50)

    const result = await executeToolCall("place_shop_order", {
      service: "rc", board: "WASSCE", quantity: "10", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("too_many")
    expect(setSession).not.toHaveBeenCalled()
  })

  // ── Duplicate-in-flight-order guard ──────────────────────────────────────
  // This is the one thing standing between "customer has an order pending OTP"
  // and the AI silently staging a second order on top of it — every step that
  // means "money is already in motion" must block a re-stage.
  for (const step of ["CONFIRM", "AIRTIME_CONFIRM", "RC_CONFIRM", "SUBMIT_OTP"] as const) {
    it(`refuses to stage a new order when an existing session is at ${step}`, async () => {
      vi.mocked(getSession).mockResolvedValue({ step } as never)
      vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "pkg-5gb", size: "5", price: 25 }])

      const result = await executeToolCall("place_shop_order", {
        service: "data", network: "MTN", size: "5",
        recipient_phone: "0244123456", payment_phone: "0244000000",
      }, baseCtx) as Record<string, unknown>

      expect(result.duplicate).toBe(true)
      expect(setSession).not.toHaveBeenCalled()
    })
  }

  it("does NOT flag a duplicate for a session at a non-money-moving step (e.g. SELECT_PRODUCT)", async () => {
    vi.mocked(getSession).mockResolvedValue({ step: "SELECT_PRODUCT" } as never)
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "pkg-5gb", size: "5", price: 25 }])

    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0244123456", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.duplicate).toBeUndefined()
    expect(setSession).toHaveBeenCalledTimes(1)
  })

  // ── No shop known ─────────────────────────────────────────────────────────
  it("returns no_shop when the customer's phone has no remembered shop, before ever checking for a duplicate session", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)

    const result = await executeToolCall("place_shop_order", {
      service: "data", network: "MTN", size: "5",
      recipient_phone: "0244123456", payment_phone: "0244000000",
    }, baseCtx) as Record<string, unknown>

    expect(result.error).toBe("no_shop")
    expect(getSession).not.toHaveBeenCalled()
    expect(setSession).not.toHaveBeenCalled()
  })
})
