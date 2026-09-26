import { describe, it, expect, vi, beforeEach } from "vitest"

// Mutable so getActiveMtnRoute's tests can reconfigure it per-case without
// vi.resetModules()/vi.doMock() gymnastics — this mutable-fixture pattern will
// be reused by bundleportal-webhook-processor.test.ts (Task 7) for the same reason.
const fakeSettings = vi.hoisted(() => ({ current: {} as Record<string, any> }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(_table: string) {
      return {
        select() {
          return {
            eq(_col: string, key: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({
                    data: fakeSettings.current[key] ? { value: fakeSettings.current[key] } : null,
                    error: null,
                  }),
              }
            },
          }
        },
      }
    },
  },
}))

import { mapNetworkToBundlePortal, mapBundlePortalStatus, isRetryableErrorCode, extractRetryAfterSeconds, getActiveMtnRoute, BundlePortalProvider } from "./bundleportal-provider"

beforeEach(() => {
  fakeSettings.current = { bundleportal_mtn_route: { route: "mtn_2" } }
})

describe("mapNetworkToBundlePortal", () => {
  it("maps MTN using the given route", () => {
    expect(mapNetworkToBundlePortal("MTN", false, "mtn")).toBe("mtn")
    expect(mapNetworkToBundlePortal("MTN", false, "mtn_2")).toBe("mtn_2")
    expect(mapNetworkToBundlePortal("MTN", false, "mtn_3")).toBe("mtn_3")
  })
  it("maps Telecel regardless of route or BigTime flag", () => {
    expect(mapNetworkToBundlePortal("Telecel", false, "mtn")).toBe("telecel")
    expect(mapNetworkToBundlePortal("Telecel", true, "mtn_3")).toBe("telecel")
  })
  it("maps AirtelTigo to airteltigo (BigTime) or ishare (regular) — airteltigo/ishare are distinct products, not synonyms, per Bundle Portal's direct confirmation", () => {
    expect(mapNetworkToBundlePortal("AirtelTigo", true, "mtn")).toBe("airteltigo")
    expect(mapNetworkToBundlePortal("AirtelTigo", false, "mtn")).toBe("ishare")
    expect(mapNetworkToBundlePortal("AirtelTigo", undefined, "mtn")).toBe("ishare")
  })
})

describe("mapBundlePortalStatus", () => {
  it("maps in-flight statuses to processing", () => {
    expect(mapBundlePortalStatus("processing")).toBe("processing")
    expect(mapBundlePortalStatus("cached")).toBe("processing")
  })
  it("maps completed and failed directly", () => {
    expect(mapBundlePortalStatus("completed")).toBe("completed")
    expect(mapBundlePortalStatus("failed")).toBe("failed")
  })
  it("is case-insensitive and trims whitespace", () => {
    expect(mapBundlePortalStatus(" COMPLETED ")).toBe("completed")
  })
  it("defaults an unrecognized status to processing rather than guessing failed", () => {
    expect(mapBundlePortalStatus("some_new_status")).toBe("processing")
  })
})

describe("isRetryableErrorCode", () => {
  it("treats documented retry-later codes as retryable", () => {
    expect(isRetryableErrorCode("pending_order")).toBe(true)
    expect(isRetryableErrorCode("network_locked")).toBe(true)
    expect(isRetryableErrorCode("rate_limit")).toBe(true)
    expect(isRetryableErrorCode("read_rate_limited")).toBe(true)
    expect(isRetryableErrorCode("server_error")).toBe(true)
    expect(isRetryableErrorCode("order_capacity_busy")).toBe(true)
    expect(isRetryableErrorCode("balance_changed")).toBe(true)
  })
  it("treats a hard validation/rejection code as not retryable", () => {
    expect(isRetryableErrorCode("unknown_bundle")).toBe(false)
    expect(isRetryableErrorCode("not_allowlisted")).toBe(false)
    expect(isRetryableErrorCode(undefined)).toBe(false)
  })
})

describe("extractRetryAfterSeconds", () => {
  it("prefers the Retry-After header when present and numeric", () => {
    expect(extractRetryAfterSeconds("30", 45)).toBe(30)
  })
  it("falls back to the JSON body's retry_after when the header is absent", () => {
    expect(extractRetryAfterSeconds(null, 45)).toBe(45)
  })
  it("falls back to the JSON body when the header is present but not numeric", () => {
    expect(extractRetryAfterSeconds("not-a-number", 45)).toBe(45)
  })
  it("returns null when neither signal is available", () => {
    expect(extractRetryAfterSeconds(null, undefined)).toBeNull()
    expect(extractRetryAfterSeconds(null, "not-a-number")).toBeNull()
  })
})

describe("checkOrderStatus", () => {
  it("short-circuits without calling the API — v2 permanently removed status polling", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
    const result = await new BundlePortalProvider().checkOrderStatus("some-order-id")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.message).toMatch(/no status polling/i)
    fetchSpy.mockRestore()
  })

  it("still recognizes a locally-failed order without calling the API", async () => {
    const fetchSpy = vi.spyOn(global, "fetch")
    const result = await new BundlePortalProvider().checkOrderStatus("FAILED_INIT_12345")
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, status: "failed", message: "Order was never submitted to Bundle Portal (local failure)" })
    fetchSpy.mockRestore()
  })
})

describe("getActiveMtnRoute", () => {
  it("returns the configured route when valid", async () => {
    expect(await getActiveMtnRoute()).toBe("mtn_2")
  })

  it("defaults to mtn when the setting is missing", async () => {
    fakeSettings.current = {}
    expect(await getActiveMtnRoute()).toBe("mtn")
  })

  it("defaults to mtn when the stored value is invalid", async () => {
    fakeSettings.current = { bundleportal_mtn_route: { route: "not_a_real_route" } }
    expect(await getActiveMtnRoute()).toBe("mtn")
  })
})
