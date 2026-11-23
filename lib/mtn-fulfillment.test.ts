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
        // Order-table mirror writes (syncMTNOrderStatus): awaitable chain, always ok.
        update() {
          const chain: any = { eq: () => chain, then: (ok: any, bad: any) => Promise.resolve({ error: null }).then(ok, bad) }
          return chain
        },
      }
    },
  } as any
}

vi.mock("@/lib/mtn-reversal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mtn-reversal")>()
  return { ...actual, flagReversal: vi.fn().mockResolvedValue({ flagged: true, superseded: false }) }
})

vi.mock("@/lib/refunds/dispatch-guard", () => ({
  withDispatchGuard: async (_id: unknown, run: () => Promise<unknown>) => run(),
}))

// Spy on rows written to mtn_fulfillment_tracking (saveMTNTracking).
const trackingInsert = vi.hoisted(() => vi.fn())
const trackingRow = vi.hoisted(() => ({ current: null as any }))
// admin_settings rows served by the fake; tests flip the strict switch here.
const settingsRows = vi.hoisted(() => ({
  // Registration gate OFF (the gate itself is covered by mtn-hold.test.ts).
  rows: { mtn_registration_gate_enabled: { enabled: false } } as Record<string, any>,
}))

vi.mock("@/lib/strict-verify/ask", () => ({
  canCheck: (s: string, disabled: Set<string>) => s !== "sykes" && !disabled.has(s),
  askSupplier: vi.fn(),
}))

vi.mock("@/lib/supabase", () => {
  const settings = fakeSupabase(settingsRows.rows)
  return {
    supabaseAdmin: {
      from(table: string) {
        if (table !== "mtn_fulfillment_tracking") return settings.from(table)
        return {
          select() {
            return { eq: () => ({ single: () => Promise.resolve({ data: trackingRow.current, error: null }) }) }
          },
          update() {
            const chain: any = { eq: () => chain, in: () => Promise.resolve({ error: null }) }
            return chain
          },
          insert(row: unknown) {
            trackingInsert(row)
            return { select: () => ({ single: () => Promise.resolve({ data: { id: "trk-1" }, error: null }) }) }
          },
        }
      },
    },
  }
})

vi.mock("@/lib/mtn-providers/factory", async (importOriginal) => {
  // Keep the real isValidMtnProviderName (a pure, supabase-free check) so the
  // new explicit-override validation in createMTNOrder behaves realistically
  // against the "sykes"/"codecraft" providers these tests pass — only the
  // settings-backed selection functions need to be test-doubles.
  const actual = await importOriginal<typeof import("@/lib/mtn-providers/factory")>()
  return {
    ...actual,
    getMTNProvider: vi.fn(),
    getProviderByName: vi.fn(),
    getRetrySequence: vi.fn().mockResolvedValue([]),
  }
})

import {
  normalizePhoneNumber,
  isValidPhoneFormat,
  getNetworkFromPhone,
  validatePhoneNetworkMatch,
  extractOrderIdCandidatesFromReference,
  createMTNOrder,
  saveMTNTracking,
} from "@/lib/mtn-fulfillment"
import { getProviderByName, getMTNProvider, getRetrySequence } from "@/lib/mtn-providers/factory"
import { askSupplier } from "@/lib/strict-verify/ask"
import { flagReversal } from "@/lib/mtn-reversal"
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
  // The strict switch ships off; only the strict tests turn it on.
  beforeEach(() => {
    delete settingsRows.rows.mtn_strict_supplier_verification
  })

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

  describe("extractOrderIdCandidatesFromReference", () => {
    it("should include the order UUID among candidates for a 3-char-prefixed reference", () => {
      // "498" prefix + UUID (dashes stripped) + 10-digit suffix, re-dashed 11-4-4-4-22
      expect(
        extractOrderIdCandidatesFromReference("49892a44c02-47f4-47bb-9785-86dee73e89c20558395818")
      ).toContain("92a44c02-47f4-47bb-9785-86dee73e89c2")
    })

    it("should include the order UUID among candidates for a 2-char-prefixed reference (prefix length varies per order)", () => {
      // "62" prefix + UUID (dashes stripped) + 10-digit phone suffix — a real,
      // shorter prefix seen live, proving the prefix isn't a fixed width.
      expect(
        extractOrderIdCandidatesFromReference("62d7042b79-3106-4dbf-a96d-576d33a8a9410546422027")
      ).toContain("d7042b79-3106-4dbf-a96d-576d33a8a941")
    })

    it("should be insensitive to dashing and casing", () => {
      expect(
        extractOrderIdCandidatesFromReference("49892A44C0247F447BB978586DEE73E89C20558395818")
      ).toContain("92a44c02-47f4-47bb-9785-86dee73e89c2")
    })

    it("should return no candidates for empty, non-hex, or too-short values", () => {
      expect(extractOrderIdCandidatesFromReference(null)).toEqual([])
      expect(extractOrderIdCandidatesFromReference(undefined)).toEqual([])
      expect(extractOrderIdCandidatesFromReference("")).toEqual([])
      expect(extractOrderIdCandidatesFromReference("ORDER-758918")).toEqual([])
      expect(extractOrderIdCandidatesFromReference("498abc")).toEqual([]) // too short
    })
  })

  describe("createMTNOrder — strict supplier gate and switch-off parity", () => {
    beforeEach(() => {
      vi.clearAllMocks()
    })

    it("switch off: a pinned send goes straight to that provider, nobody is asked", async () => {
      const codecraft = fakeMtnProvider("codecraft", { success: true, order_id: "2", message: "ok" })
      vi.mocked(getProviderByName).mockReturnValue(codecraft)

      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1, provider: "codecraft" })

      expect(askSupplier).not.toHaveBeenCalled()
      expect(codecraft.createOrder).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ success: true, provider: "codecraft" })
      expect(result.held).toBeUndefined()
    })

    it("switch off: an auto-selected provider is sent without any whitelist hold", async () => {
      const codecraft = fakeMtnProvider("codecraft", { success: true, order_id: "3", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(codecraft)
      vi.mocked(getRetrySequence).mockResolvedValue([])

      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1 })

      expect(askSupplier).not.toHaveBeenCalled()
      expect(codecraft.createOrder).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(true)
    })

    it("switch on: only an approving supplier is sent; the unapproved primary is never contacted", async () => {
      settingsRows.rows.mtn_strict_supplier_verification = { enabled: true }
      const primary = fakeMtnProvider("codecraft", { success: true, order_id: "p", message: "ok" })
      const next = fakeMtnProvider("xpress", { success: true, order_id: "n", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(primary)
      vi.mocked(getRetrySequence).mockResolvedValue(["xpress"])
      vi.mocked(getProviderByName).mockImplementation(((n: string) => (n === "xpress" ? next : primary)) as any)
      vi.mocked(askSupplier).mockImplementation(async (s: string) => (s === "xpress" ? "yes" : "no"))

      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1 })

      expect(result).toMatchObject({ success: true, provider: "xpress" })
      expect(primary.createOrder).not.toHaveBeenCalled()
      expect(next.createOrder).toHaveBeenCalledTimes(1)
    })

    it("switch on: a pin the supplier rejects is refused and never re-routed", async () => {
      settingsRows.rows.mtn_strict_supplier_verification = { enabled: true }
      const pinned = fakeMtnProvider("codecraft", { success: true, order_id: "p", message: "ok" })
      const other = fakeMtnProvider("xpress", { success: true, order_id: "n", message: "ok" })
      vi.mocked(getRetrySequence).mockResolvedValue(["xpress"])
      vi.mocked(getProviderByName).mockImplementation(((n: string) => (n === "xpress" ? other : pinned)) as any)
      vi.mocked(askSupplier).mockResolvedValue("no")

      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1, provider: "codecraft" })

      expect(result.error_type).toBe("SUPPLIER_NOT_APPROVED")
      expect(pinned.createOrder).not.toHaveBeenCalled()
      expect(other.createOrder).not.toHaveBeenCalled()
      expect(vi.mocked(askSupplier).mock.calls.map((c) => c[0])).toEqual(["codecraft"])
    })
  })

  describe("createMTNOrder — OUTCOME_UNKNOWN stops the retry sequence", () => {
    beforeEach(() => vi.clearAllMocks())
    const unknown = { success: false, message: "x may have been created", error_type: "OUTCOME_UNKNOWN" }

    it("does not try any retry-sequence provider after an unknown primary outcome", async () => {
      const primary = fakeMtnProvider("sykes", unknown)
      const next = fakeMtnProvider("datakazina", { success: true, order_id: "9", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(primary)
      vi.mocked(getRetrySequence).mockResolvedValue(["datakazina"])
      vi.mocked(getProviderByName).mockReturnValue(next)
      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1 })
      expect(next.createOrder).not.toHaveBeenCalled()
      expect(result.error_type).toBe("OUTCOME_UNKNOWN")
      expect(result.provider).toBe("sykes")
    })

    it("stops at the retry provider that returned unknown, trying nobody after it", async () => {
      const primary = fakeMtnProvider("sykes", { success: false, message: "down", error_type: "API_ERROR" })
      const second = fakeMtnProvider("datakazina", unknown)
      const third = fakeMtnProvider("xpress", { success: true, order_id: "9", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(primary)
      vi.mocked(getRetrySequence).mockResolvedValue(["datakazina", "xpress"])
      vi.mocked(getProviderByName).mockImplementation(((n: string) => (n === "datakazina" ? second : third)) as any)
      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1 })
      expect(third.createOrder).not.toHaveBeenCalled()
      expect(result.error_type).toBe("OUTCOME_UNKNOWN")
      expect(result.provider).toBe("datakazina")
    })

    it("an explicit provider (hard pin) that fails never calls a retry-sequence provider", async () => {
      const pinned = fakeMtnProvider("hubnet", { success: false, message: "down", error_type: "API_ERROR" })
      const fallback = fakeMtnProvider("datakazina", { success: true, order_id: "9", message: "ok" })
      vi.mocked(getRetrySequence).mockResolvedValue(["datakazina", "xpress"])
      vi.mocked(getProviderByName).mockImplementation(((n: string) => (n === "hubnet" ? pinned : fallback)) as any)
      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1, provider: "hubnet" })
      expect(pinned.createOrder).toHaveBeenCalledTimes(1)
      expect(fallback.createOrder).not.toHaveBeenCalled()
      expect(getRetrySequence).not.toHaveBeenCalled()
      expect(getMTNProvider).not.toHaveBeenCalled()
      expect(vi.mocked(getProviderByName).mock.calls.map((c) => c[0])).toEqual(["hubnet"])
      expect(result.success).toBe(false)
      expect(result.provider).toBe("hubnet")
    })

    it("ordinary failures still fall through the retry sequence", async () => {
      const primary = fakeMtnProvider("sykes", { success: false, message: "bad", error_type: "API_ERROR" })
      const next = fakeMtnProvider("datakazina", { success: true, order_id: "9", message: "ok" })
      vi.mocked(getMTNProvider).mockResolvedValue(primary)
      vi.mocked(getRetrySequence).mockResolvedValue(["datakazina"])
      vi.mocked(getProviderByName).mockReturnValue(next)
      const result = await createMTNOrder({ recipient_phone: "0551234567", network: "MTN", size_gb: 1 })
      expect(result.success).toBe(true)
    })
  })

  describe("syncMTNOrderStatus — completed rows the provider now reports failed", () => {
    // Admin "sync status" (and the Kuntanii webhook) must not turn a delivered-looking
    // order straight back into a pending one: that skips the reversal review and the
    // order could be re-sent. It goes through flagReversal like the provider crons.
    beforeEach(() => vi.mocked(flagReversal).mockClear())

    it("flags a reversal instead of mirroring failed -> pending", async () => {
      trackingRow.current = { id: "t9", mtn_order_id: "ext-9", provider: "kuntanii", status: "completed", external_status: "processed", order_type: "bulk", order_id: "o9" }
      const provider = { checkOrderStatus: vi.fn().mockResolvedValue({ success: true, status: "failed", message: "refunded", order: { status: "refunded" } }) }
      vi.mocked(getProviderByName).mockReturnValue(provider as any)
      const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
      const r = await syncMTNOrderStatus("t9")
      expect(flagReversal).toHaveBeenCalledTimes(1)
      expect(vi.mocked(flagReversal).mock.calls[0][1]).toMatchObject({ id: "t9", provider: "kuntanii" })
      expect(vi.mocked(flagReversal).mock.calls[0][2]).toMatchObject({ status: "refunded" })
      expect(r).toMatchObject({ success: true, newStatus: "reversed" })
    })

    it("leaves an admin-completed row alone (provider never confirmed it): no reversal, no pending", async () => {
      trackingRow.current = { id: "t11", mtn_order_id: "ext-11", provider: "kuntanii", status: "completed", external_status: null, order_type: "bulk", order_id: "o11" }
      const provider = { checkOrderStatus: vi.fn().mockResolvedValue({ success: true, status: "failed", message: "x", order: { status: "refunded" } }) }
      vi.mocked(getProviderByName).mockReturnValue(provider as any)
      const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
      const r = await syncMTNOrderStatus("t11")
      expect(flagReversal).not.toHaveBeenCalled()
      expect(r).toMatchObject({ success: true, newStatus: "completed" })
    })

    it("reports failure and changes nothing when flagging the reversal fails", async () => {
      vi.mocked(flagReversal).mockResolvedValueOnce({ flagged: false, superseded: false })
      trackingRow.current = { id: "t12", mtn_order_id: "ext-12", provider: "kuntanii", status: "completed", external_status: "processed", order_type: "bulk", order_id: "o12" }
      const provider = { checkOrderStatus: vi.fn().mockResolvedValue({ success: true, status: "failed", message: "x", order: { status: "refunded" } }) }
      vi.mocked(getProviderByName).mockReturnValue(provider as any)
      const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
      const r = await syncMTNOrderStatus("t12")
      expect(r.success).toBe(false)
      expect(r.newStatus).toBeUndefined()
    })

    it("still applies failed normally for a row that was not completed", async () => {
      trackingRow.current = { id: "t10", mtn_order_id: "ext-10", provider: "kuntanii", status: "processing", order_type: "bulk", order_id: "o10" }
      const provider = { checkOrderStatus: vi.fn().mockResolvedValue({ success: true, status: "failed", message: "x", order: { status: "cancelled" } }) }
      vi.mocked(getProviderByName).mockReturnValue(provider as any)
      const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
      const r = await syncMTNOrderStatus("t10")
      expect(flagReversal).not.toHaveBeenCalled()
      expect(r.newStatus).toBe("failed")
    })
  })

  describe("syncMTNOrderStatus — UNKNOWN_ ids", () => {
    it("does no provider lookup and changes nothing", async () => {
      trackingRow.current = { id: "t1", mtn_order_id: "UNKNOWN_123", provider: "apexprime", status: "abandoned" }
      const { syncMTNOrderStatus } = await import("@/lib/mtn-fulfillment")
      const r = await syncMTNOrderStatus("t1")
      expect(r.success).toBe(false)
      expect(r.newStatus).toBeUndefined()
      expect(r.message).toContain("outcome unknown")
    })
  })

  describe("saveMTNTracking — UNKNOWN_ rows", () => {
    const req = { recipient_phone: "0551234567", network: "MTN" as const, size_gb: 1 }
    beforeEach(() => trackingInsert.mockClear())

    it("writes status abandoned with the message, never claiming a real id", async () => {
      await saveMTNTracking(
        "order-1",
        "UNKNOWN_123",
        req,
        { success: false, message: "Apex may have created it", error_type: "OUTCOME_UNKNOWN" },
        "shop",
        "apexprime"
      )
      expect(trackingInsert.mock.calls[0][0]).toMatchObject({
        mtn_order_id: "UNKNOWN_123",
        status: "abandoned",
        external_message: "Apex may have created it",
      })
    })
  })

  describe("saveMTNTracking provider cost/reference", () => {
    const req = { recipient_phone: "0551234567", network: "MTN" as const, size_gb: 1 }

    beforeEach(() => trackingInsert.mockClear())

    it("saveMTNTracking writes provider_cost_ghs and provider_reference when present", async () => {
      await saveMTNTracking(
        "order-1",
        "o1",
        req,
        { success: true, order_id: "o1", message: "ok", provider_cost_ghs: 3.85, provider_reference: "KT-1" },
        "shop",
        "kuntanii"
      )
      expect(trackingInsert).toHaveBeenCalledTimes(1)
      expect(trackingInsert.mock.calls[0][0]).toMatchObject({
        provider_cost_ghs: 3.85,
        provider_reference: "KT-1",
      })
    })

    it("omits both keys when absent", async () => {
      await saveMTNTracking("order-1", "o1", req, { success: true, order_id: "o1", message: "ok" }, "shop", "sykes")
      expect(trackingInsert).toHaveBeenCalledTimes(1)
      const row = trackingInsert.mock.calls[0][0]
      expect(row).not.toHaveProperty("provider_cost_ghs")
      expect(row).not.toHaveProperty("provider_reference")
    })
  })
})
