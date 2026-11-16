import { describe, it, expect, vi } from "vitest"

const setSession = vi.hoisted(() => vi.fn(async () => {}))
const blocked = vi.hoisted(() => vi.fn(async () => true))

vi.mock("next/server", () => ({ after: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("../session", () => ({ setSession }))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn() }))
vi.mock("@/lib/paystack", () => ({ submitOtp: vi.fn() }))
vi.mock("@/lib/ussd/gateway-charge", () => ({ guardedReprice: vi.fn(), isUssdHubtelPayer: vi.fn(), startUssdCharge: vi.fn(), ussdOrderAmount: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(), SMSTemplates: {} }))
vi.mock("@/lib/ussd/paystack-provider", () => ({ paystackProviderFromPhone: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn(async () => ({ enabled: false, map: {} })) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({ isRecipientBlocked: blocked, RECIPIENT_BLOCKED_PROMPT: "BLOCKED" }))
vi.mock("@/lib/shop-commerce/pricing", () => ({ fetchShopBundles: vi.fn(), verifyBundlePrice: vi.fn() }))
vi.mock("@/lib/shop-commerce/orders", () => ({ createShopBundleOrder: vi.fn() }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({ getCanonicalShopName: vi.fn() }))

import { handleEnterRecipient } from "./bundles"

describe("ussd-shop handleEnterRecipient: block context", () => {
  it("tells the gate the Uzo shop surface, the shop, the dialler and the product", async () => {
    await handleEnterRecipient("0244123456", "s1", {
      step: "ENTER_RECIPIENT", network: "MTN", bundleSize: "1", bundlePrice: 6,
      shopId: "11111111-1111-4111-8111-111111111111", shopName: "Ama", dialingPhone: "+233200585542",
    } as any)
    expect(blocked).toHaveBeenCalledWith("MTN", "0244123456", expect.objectContaining({
      surface: "ussd_uzo_shop", shopId: "11111111-1111-4111-8111-111111111111", purchaserPhone: "+233200585542", product: "MTN 1", amount: 6,
    }))
    expect(setSession).not.toHaveBeenCalled()
  })
})
