// Uzo USSD bundle menu + confirm priced through the role resolver (Phase 2c, Task 2).
// Parity: with only the system roles, every price equals the old dealer_price / price rule. A role_package_prices row
// for a role moves BOTH the menu and the confirm. Sessions without priceRole price by their tier label.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ afterFns: [] as Array<() => Promise<void>>, failRoles: false }))

vi.mock("@supabase/supabase-js", async () => {
  const k = await import("@/lib/ussd/gateway-test-kit")
  const failing = (): any => {
    const b: any = new Proxy(function () {}, {
      get: (_t, p: string) => (p === "then" ? (r: any, j: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(r, j) : () => b),
    })
    return b
  }
  return { createClient: () => ({ ...k.fakeClient, from: (t: string) => (h.failRoles && t === "roles" ? failing() : k.fakeClient.from(t)) }) }
})
vi.mock("@/lib/payment-gateway/read-config", async () => (await import("@/lib/ussd/gateway-test-kit")).readConfigMock())
vi.mock("@/lib/payment-gateway/hubtel-readiness", async () => (await import("@/lib/ussd/gateway-test-kit")).readinessMock())
vi.mock("@/lib/hubtel-pay/client", async (orig) => (await import("@/lib/ussd/gateway-test-kit")).relayMock(await orig()))
vi.mock("@/lib/hubtel-pay/alert-throttle", async () => (await import("@/lib/ussd/gateway-test-kit")).alertMock())
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => { h.afterFns.push(fn) } }))
vi.mock("../session", () => ({ setSession: vi.fn(async () => {}) }))
vi.mock("../resolve-email", () => ({ resolveEmail: vi.fn(async () => "payer@example.com") }))
vi.mock("../wallet-balance", () => ({ liveWalletBalance: vi.fn(async () => undefined) }))
vi.mock("../fulfill", () => ({ fulfillUssdOrder: vi.fn() }))
vi.mock("@/lib/paystack", async (orig) => ({ ...(await orig<object>()), chargeMobileMoney: vi.fn(), submitOtp: vi.fn() }))
vi.mock("../gateway-charge", async (orig) => {
  const real = await orig<typeof import("../gateway-charge")>()
  return { ...real, startUssdCharge: vi.fn(real.startUssdCharge) }
})
vi.mock("../../sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { ussdOtpRequired: () => "otp" } }))
vi.mock("../../whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn() }))
vi.mock("../../whatsapp-bot/session", () => ({ setWaSession: vi.fn(async () => {}) }))
vi.mock("../../app-settings", () => ({ getJoinCommunityLink: vi.fn(async () => "") }))
vi.mock("../../network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: vi.fn(async () => false), RECIPIENT_BLOCKED_PROMPT: "" }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: vi.fn(async () => ({})) }))
vi.mock("@/lib/storefront-otp", async (orig) => ({ ...(await orig<object>()), isPhoneOtpVerified: vi.fn(async () => false) }))

import { fetchBundles, fetchAllBundles, handleConfirm, handleSelectNetwork, handleSelectBundle } from "./bundles"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"
import { startUssdCharge } from "../gateway-charge"
import { setSession } from "../session"
import { kit, resetKit, rows } from "../gateway-test-kit"

// 0184 seed: user 0, dealer 10, sub_agent / admin off-ladder. The dealer price is mirrored (dealer_price > 0).
const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const DIAL = "+233200000101"
const session = (over: Record<string, unknown> = {}): any => ({
  step: "CONFIRM", network: "MTN", paystackProvider: "vod", bundleId: "p1", bundleSize: "1", bundlePrice: 10,
  recipientPhone: "0200000102", dialingPhone: DIAL, effectivePriceTier: "regular", ...over,
})
const order = () => rows("ussd_orders")[0]
const priceOf = async (role?: string, tier = "regular") =>
  (await fetchBundles("MTN", 0, tier, undefined, undefined, role)).bundles[0].price

beforeEach(() => {
  resetKit()
  h.afterFns = []
  h.failRoles = false
  vi.mocked(startUssdCharge).mockClear()
  vi.mocked(setSession).mockClear()
  kit.db.packages = [{ id: "p1", network: "MTN", size: "1", price: 10, dealer_price: 8, is_available: true }]
  kit.db.roles = ROLES.map((r) => ({ ...r }))
  kit.db.role_package_prices = [{ role_id: "r-dealer", package_id: "p1", price: 8 }]
  kit.db.app_settings = [{ key: null, paystack_fee_percentage: 3, ussd_price_tier: "regular" }]
})

describe("menu: role parity", () => {
  it("dealer 8, user 10, admin (price role user) 10, unknown caller defaults by tier", async () => {
    expect(await priceOf("dealer", "dealer")).toBe(8)
    expect(await priceOf("user", "regular")).toBe(10)
    expect(await priceOf("user", "regular")).toBe(10) // admin carries tier "regular" and price role "user"
    expect(await priceOf(undefined, "dealer")).toBe(8) // unknown caller, ussd_price_tier "dealer"
    expect(await priceOf(undefined, "regular")).toBe(10)
  })

  it("a role_package_prices row for user 5.5 is shown", async () => {
    rows("role_package_prices").push({ role_id: "r-user", package_id: "p1", price: 5.5 })
    expect(await priceOf("user")).toBe(5.5)
    expect(await priceOf("dealer", "dealer")).toBe(8)
  })

  it("the price role, not the tier label, decides the price", async () => {
    expect(await priceOf("user", "dealer")).toBe(10)
    expect(await priceOf("dealer", "regular")).toBe(8)
  })

  it("display degrades to the public price when roles cannot be read; the strict list throws", async () => {
    h.failRoles = true
    expect(await priceOf("dealer", "dealer")).toBe(10)
    await expect(fetchAllBundles("MTN", "dealer", undefined, undefined, "dealer")).rejects.toThrow()
  })

  it("the strict list prices like the menu", async () => {
    rows("role_package_prices").push({ role_id: "r-user", package_id: "p1", price: 5.5 })
    expect((await fetchAllBundles("MTN", "regular", undefined, undefined, "user"))[0].price).toBe(5.5)
    expect((await fetchAllBundles("MTN", "dealer"))[0].price).toBe(8) // no role passed: tier fallback
  })
})

describe("confirm: role parity and menu = confirm", () => {
  it.each([
    ["dealer", "dealer", 8],
    ["user", "regular", 10],
    [undefined, "dealer", 8], // legacy session without priceRole
    [undefined, "regular", 10],
  ] as const)("session priceRole %s / tier %s confirms at %s, the menu price", async (role, tier, price) => {
    expect(await priceOf(role, tier)).toBe(price)
    const r: any = await handleConfirm("1", "S1", session({ priceRole: role, effectivePriceTier: tier, bundlePrice: price }))
    expect(JSON.stringify(r)).not.toContain("Price changed")
    expect(order().amount).toBeCloseTo(price * 1.03, 2)
  })

  it("a user role price of 5.5 is on the menu and charged at confirm", async () => {
    rows("role_package_prices").push({ role_id: "r-user", package_id: "p1", price: 5.5 })
    expect(await priceOf("user")).toBe(5.5)
    await handleConfirm("1", "S1", session({ priceRole: "user", bundlePrice: 5.5 }))
    expect(order().amount).toBeCloseTo(5.665, 1) // 5.5 + the 3% card fee
  })

  it("a stale menu price is refused as a price change", async () => {
    rows("role_package_prices").push({ role_id: "r-user", package_id: "p1", price: 5.5 })
    const r: any = await handleConfirm("1", "S1", session({ priceRole: "user", bundlePrice: 10 }))
    expect(JSON.stringify(r)).toContain("Price changed to GHS 5.50")
    expect(rows("ussd_orders")).toHaveLength(0)
  })

  it("refuses when roles cannot be read: no order, no charge, no payment prompt", async () => {
    h.failRoles = true
    const r: any = await handleConfirm("1", "S1", session({ priceRole: "dealer", effectivePriceTier: "dealer", bundlePrice: 8, userId: "u1", walletBalance: 50 }))
    expect(JSON.stringify(r)).toContain(MSG_PRICES_UNAVAILABLE)
    expect(rows("ussd_orders")).toHaveLength(0)
    expect(h.afterFns).toHaveLength(0)
    expect(startUssdCharge).not.toHaveBeenCalled()
    expect(setSession).toHaveBeenCalledWith("S1", { step: "MAIN", dialingPhone: DIAL })
  })
})

describe("session stores the price role", () => {
  it("network step: a dealer's price role goes into the session and the list is at dealer prices", async () => {
    kit.db.users = [{ id: "u1", role: "dealer", phone_number: "0200000101", pricing_mode: null }]
    kit.db.wallets = []
    kit.db.admin_settings = []
    kit.db.user_shops = []
    const r: any = await handleSelectNetwork("1", "S1", { step: "SELECT_NETWORK", dialingPhone: DIAL } as any)
    const written = vi.mocked(setSession).mock.calls[0][1] as any
    expect(written).toMatchObject({ effectivePriceTier: "dealer", priceRole: "dealer", bundleCache: [{ id: "p1", size: "1", price: 8 }] })
    expect(JSON.stringify(r)).toContain("8")
  })

  it("paging uses the session's price role; a legacy session falls back to its tier", async () => {
    const base: any = { step: "SELECT_BUNDLE", network: "MTN", bundlePage: 0, dialingPhone: DIAL }
    await handleSelectBundle("1", "S1", { ...base, effectivePriceTier: "dealer", priceRole: "dealer" })
    expect(vi.mocked(setSession).mock.calls.at(-1)![1]).toMatchObject({ bundlePrice: 8 })
    await handleSelectBundle("1", "S1", { ...base, effectivePriceTier: "dealer" })
    expect(vi.mocked(setSession).mock.calls.at(-1)![1]).toMatchObject({ bundlePrice: 8 })
    await handleSelectBundle("1", "S1", { ...base, effectivePriceTier: "dealer", priceRole: "user" })
    expect(vi.mocked(setSession).mock.calls.at(-1)![1]).toMatchObject({ bundlePrice: 10 })
  })
})
