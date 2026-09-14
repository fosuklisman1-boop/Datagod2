import { describe, it, expect, vi, beforeEach } from "vitest"

// Mutable so getActiveMtnRoute's tests can reconfigure it per-case without
// vi.resetModules()/vi.doMock() gymnastics — mirrors the vi.hoisted mutable-
// fixture pattern already established in bundleportal-webhook-processor.test.ts.
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

import { mapNetworkToBundlePortal, mapBundlePortalStatus, isRetryableErrorCode, getActiveMtnRoute } from "./bundleportal-provider"

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
  it("maps AirtelTigo to bigtime only when isBigTime is true", () => {
    expect(mapNetworkToBundlePortal("AirtelTigo", true, "mtn")).toBe("bigtime")
    expect(mapNetworkToBundlePortal("AirtelTigo", false, "mtn")).toBe("airteltigo")
    expect(mapNetworkToBundlePortal("AirtelTigo", undefined, "mtn")).toBe("airteltigo")
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
