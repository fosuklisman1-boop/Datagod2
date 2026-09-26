import { describe, it, expect, vi, beforeEach } from "vitest"

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

import { getActiveMtnNetworkId } from "./datakazina-provider"

beforeEach(() => {
  fakeSettings.current = { datakazina_mtn_route: { route: "mtn_express" } }
})

describe("getActiveMtnNetworkId", () => {
  it("returns 6 (MTN Express) when configured", async () => {
    expect(await getActiveMtnNetworkId()).toBe(6)
  })

  it("defaults to 3 (MTN) when the setting is missing", async () => {
    fakeSettings.current = {}
    expect(await getActiveMtnNetworkId()).toBe(3)
  })

  it("defaults to 3 (MTN) when the stored value is invalid", async () => {
    fakeSettings.current = { datakazina_mtn_route: { route: "not_a_real_route" } }
    expect(await getActiveMtnNetworkId()).toBe(3)
  })
})
