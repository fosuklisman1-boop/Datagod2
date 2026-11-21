import { describe, expect, it, vi } from "vitest"

const fakeSettings = vi.hoisted(() => ({ current: {} as Record<string, any> }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from() {
      return {
        select() {
          return {
            eq(_c: string, key: string) {
              return {
                maybeSingle: () =>
                  Promise.resolve({ data: fakeSettings.current[key] ? { value: fakeSettings.current[key] } : null, error: null }),
              }
            },
          }
        },
      }
    },
  },
}))

import {
  NON_MTN_CAPABLE,
  VALID_PROVIDERS,
  getMTNProvider,
  getProviderByName,
  getProviderNameForNetwork,
  getRetrySequence,
  isProviderCapableForNetwork,
  isValidMtnProviderName,
} from "./factory"
import { getProviderDisplay } from "./provider-display"

describe("hubnet wiring", () => {
  it("getProviderByName returns the Hubnet provider", () => {
    expect(getProviderByName("hubnet").name).toBe("hubnet")
  })

  it("is a valid provider name", () => {
    expect(VALID_PROVIDERS).toContain("hubnet")
    expect(isValidMtnProviderName("hubnet")).toBe(true)
  })

  it("is capable for Telecel, AT iShare and AT BigTime", () => {
    expect(isProviderCapableForNetwork("TELECEL", "hubnet")).toBe(true)
    expect(isProviderCapableForNetwork("AT - ISHARE", "hubnet")).toBe(true)
    expect(isProviderCapableForNetwork("AT - BIGTIME", "hubnet")).toBe(true)
    for (const list of Object.values(NON_MTN_CAPABLE)) expect(list).toContain("hubnet")
  })

  it("has a display label", () => {
    expect(getProviderDisplay("hubnet").label).toBe("Hubnet")
  })

  it("is not in any default selection or default retry sequence", async () => {
    fakeSettings.current = {}
    expect((await getMTNProvider()).name).not.toBe("hubnet")
    expect(await getRetrySequence()).not.toContain("hubnet")
    for (const n of ["TELECEL", "AT - ISHARE", "AT - BIGTIME"]) {
      expect(await getProviderNameForNetwork(n)).not.toBe("hubnet")
    }
  })

  it("can be explicitly selected", async () => {
    fakeSettings.current = { telecel_provider_selection: { provider: "hubnet" } }
    expect(await getProviderNameForNetwork("TELECEL")).toBe("hubnet")
  })
})
