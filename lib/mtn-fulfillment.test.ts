// admin_settings lookups return the row matching the queried key; anything
// else (e.g. a table this fake doesn't know) resolves to no row, matching a
// real fail-open Supabase response instead of throwing.
function fakeSupabase(settingsByKey: Record<string, any>) {
  return {
    from(_table: string) {
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: settingsByKey[key] ? { value: settingsByKey[key] } : null,
                    error: null,
                  }),
              }
            },
          }
        },
        upsert() {
          return Promise.resolve({ data: null, error: null })
        },
      }
    },
  } as any
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: fakeSupabase({
    // Registration gate OFF isolates these tests to the whitelist pre-check
    // (the gate itself is already covered by mtn-hold.test.ts).
    mtn_registration_gate_enabled: { enabled: false },
    mtn_whitelist_enabled: { enabled: true },
  }),
}))

vi.mock("@/lib/mtn-providers/factory", () => ({
  getMTNProvider: vi.fn(),
  getProviderByName: vi.fn(),
  getRetrySequence: vi.fn().mockResolvedValue([]),
}))

vi.mock("@/lib/mtn-providers/provider-whitelist", () => ({
  hasWhitelistProviders: vi.fn(() => true),
  // Mirrors the real WHITELIST_REGISTRY shape: only codecraft/xpress-style
  // providers participate in whitelisting — sykes/datakazina/etc. don't.
  isWhitelistProvider: vi.fn((name: string) => name === "codecraft" || name === "xpress"),
  checkWhitelistForOrder: vi.fn(),
}))

import {
  normalizePhoneNumber,
  isValidPhoneFormat,
  getNetworkFromPhone,
  validatePhoneNetworkMatch,
  extractOrderIdFromReference,
  createMTNOrder,
} from "@/lib/mtn-fulfillment"
import { getProviderByName, getMTNProvider, getRetrySequence } from "@/lib/mtn-providers/factory"
import { checkWhitelistForOrder } from "@/lib/mtn-providers/provider-whitelist"
import type { MTNProvider } from "@/lib/mtn-providers/types"

function fakeMtnProvider(name: string, result: any): MTNProvider {
  return {
    name,
    createOrder: vi.fn().mockResolvedValue(result),
    checkOrderStatus: vi.fn(),
    checkBalance: vi.fn(),
  }
}

describe("MTN Fulfillment Service", () => {
  describe("normalizePhoneNumber", () => {
    it("should handle 10-digit format with 0 prefix", () => {
      expect(normalizePhoneNumber("0241234567")).toBe("0241234567")
    })

    it("should add 0 prefix to 9-digit numbers", () => {
      expect(normalizePhoneNumber("241234567")).toBe("0241234567")
    })

    it("should convert country code format", () => {
      expect(normalizePhoneNumber("233241234567")).toBe("0241234567")
    })

    it("should remove dashes and spaces", () => {
      expect(normalizePhoneNumber("024-123-4567")).toBe("0241234567")
      expect(normalizePhoneNumber("024 123 4567")).toBe("0241234567")
    })

    it("should remove plus sign", () => {
      expect(normalizePhoneNumber("+233241234567")).toBe("0241234567")
    })
  })

  describe("isValidPhoneFormat", () => {
    it("should accept valid MTN numbers", () => {
      expect(isValidPhoneFormat("0241234567")).toBe(true)
      expect(isValidPhoneFormat("0251234567")).toBe(true)
      expect(isValidPhoneFormat("0531234567")).toBe(true)
    })

    it("should accept 9-digit format", () => {
      expect(isValidPhoneFormat("241234567")).toBe(true)
    })

    it("should accept country code format", () => {
      expect(isValidPhoneFormat("233241234567")).toBe(true)
    })

    it("should reject invalid formats", () => {
      expect(isValidPhoneFormat("024123")).toBe(false) // Too short
      expect(isValidPhoneFormat("024123456789")).toBe(false) // Too long
      expect(isValidPhoneFormat("abc123456")).toBe(false) // Non-numeric
    })
  })

  describe("getNetworkFromPhone", () => {
    it("should detect MTN numbers", () => {
      expect(getNetworkFromPhone("0241234567")).toBe("MTN")
      expect(getNetworkFromPhone("0251234567")).toBe("MTN")
      expect(getNetworkFromPhone("0531234567")).toBe("MTN")
      expect(getNetworkFromPhone("0541234567")).toBe("MTN")
      expect(getNetworkFromPhone("0551234567")).toBe("MTN")
      expect(getNetworkFromPhone("0591234567")).toBe("MTN")
    })

    it("should detect Telecel numbers", () => {
      expect(getNetworkFromPhone("0201234567")).toBe("Telecel")
      expect(getNetworkFromPhone("0501234567")).toBe("Telecel")
    })

    it("should detect AirtelTigo numbers", () => {
      expect(getNetworkFromPhone("0261234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0271234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0561234567")).toBe("AirtelTigo")
      expect(getNetworkFromPhone("0571234567")).toBe("AirtelTigo")
    })

    it("should return null for invalid numbers", () => {
      expect(getNetworkFromPhone("0301234567")).toBe(null)
      expect(getNetworkFromPhone("1234567890")).toBe(null)
    })
  })

  describe("validatePhoneNetworkMatch", () => {
    it("should match valid MTN numbers", () => {
      expect(validatePhoneNetworkMatch("0241234567", "MTN")).toBe(true)
      expect(validatePhoneNetworkMatch("241234567", "MTN")).toBe(true)
    })

    it("should reject mismatched networks", () => {
      expect(validatePhoneNetworkMatch("0201234567", "MTN")).toBe(false) // Telecel
      expect(validatePhoneNetworkMatch("0261234567", "MTN")).toBe(false) // AirtelTigo
    })

    it("should work across different formats", () => {
      expect(validatePhoneNetworkMatch("233241234567", "MTN")).toBe(true)
      expect(validatePhoneNetworkMatch("024-123-4567", "MTN")).toBe(true)
    })
  })

  describe("extractOrderIdFromReference", () => {
    it("should decode the order UUID from a DataKazina webhook reference", () => {
      // "498" prefix + UUID (dashes stripped) + 10-digit suffix, re-dashed 11-4-4-4-22
      expect(
        extractOrderIdFromReference("49892a44c02-47f4-47bb-9785-86dee73e89c20558395818")
      ).toBe("92a44c02-47f4-47bb-9785-86dee73e89c2")
    })

    it("should be insensitive to dashing and casing", () => {
      expect(
        extractOrderIdFromReference("49892A44C0247F447BB978586DEE73E89C20558395818")
      ).toBe("92a44c02-47f4-47bb-9785-86dee73e89c2")
    })

    it("should return null for empty or non-matching values", () => {
      expect(extractOrderIdFromReference(null)).toBe(null)
      expect(extractOrderIdFromReference(undefined)).toBe(null)
      expect(extractOrderIdFromReference("")).toBe(null)
      expect(extractOrderIdFromReference("ORDER-758918")).toBe(null)
      expect(extractOrderIdFromReference("498abc")).toBe(null) // too short
    })
  })

  describe("createMTNOrder — whitelist pre-check scoping", () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it("does not run the whitelist pre-check when the active provider has no whitelist endpoint", async () => {
      // sykes has no entry in WHITELIST_REGISTRY (it's the system default provider) —
      // an unrelated provider's whitelist database not knowing this number must
      // never block an order that was never going through that provider anyway.
      const sykes = fakeMtnProvider("sykes", { success: true, order_id: "1", message: "ok" })
      vi.mocked(getProviderByName).mockReturnValue(sykes)
      vi.mocked(checkWhitelistForOrder).mockResolvedValue({ allowed: false, provider: null })

      const result = await createMTNOrder({
        recipient_phone: "0551234567",
        network: "MTN",
        size_gb: 1,
        provider: "sykes",
      })

      expect(checkWhitelistForOrder).not.toHaveBeenCalled()
      expect(sykes.createOrder).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
    })

    it("still runs the whitelist pre-check when the active provider does have a whitelist endpoint", async () => {
      // codecraft is whitelist-capable, so the check still runs and is still
      // logged/visible — but an explicit admin pick (order.provider set) is no
      // longer pre-emptively held on a whitelist "not recognized" result. The
      // admin already chose this specific provider, so it gets a real attempt;
      // codecraft's own API decides success/failure, not a whitelist guess.
      const codecraft = fakeMtnProvider("codecraft", { success: true, order_id: "2", message: "ok" })
      vi.mocked(getProviderByName).mockReturnValue(codecraft)
      vi.mocked(checkWhitelistForOrder).mockResolvedValue({ allowed: false, provider: null })

      const result = await createMTNOrder({
        recipient_phone: "0551234567",
        network: "MTN",
        size_gb: 1,
        provider: "codecraft",
      })

      expect(checkWhitelistForOrder).toHaveBeenCalledTimes(1)
      expect(codecraft.createOrder).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
      expect(result.held).toBeUndefined()
    })

    it("holds on a whitelist block when the provider was auto-selected (not an explicit pick)", async () => {
      // The auto-selected path keeps the original protection: a whitelist block
      // still skips the attempt and holds (after the retry sequence, tested
      // elsewhere, also fails) — only an explicit admin pick bypasses the hold.
      const codecraft = fakeMtnProvider("codecraft", { success: true, order_id: "3", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(codecraft)
      vi.mocked(getRetrySequence).mockResolvedValue([])
      vi.mocked(checkWhitelistForOrder).mockResolvedValue({ allowed: false, provider: null })

      const result = await createMTNOrder({
        recipient_phone: "0551234567",
        network: "MTN",
        size_gb: 1,
      })

      expect(checkWhitelistForOrder).toHaveBeenCalledTimes(1)
      expect(codecraft.createOrder).not.toHaveBeenCalled()
      expect(result.success).toBe(false)
      expect(result.held).toBe(true)
      expect(result.error_type).toBe("WHITELIST_BLOCKED")
    })
  })
})
