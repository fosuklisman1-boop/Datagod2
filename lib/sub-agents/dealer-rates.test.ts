import { describe, it, expect } from "vitest"
import { getDealerRateTier } from "./dealer-rates"

type Res = { data: any; error: any }

function fakeDb(opts: { role?: string | null; usersError?: any; shop?: Res }) {
  const shopCalls: string[] = []
  const db: any = {
    from: (t: string) => {
      if (t === "users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.role === null || opts.role === undefined ? null : { role: opts.role },
                error: opts.usersError ?? null,
              }),
            }),
          }),
        }
      }
      if (t === "user_shops") {
        shopCalls.push(t)
        const res = opts.shop ?? { data: null, error: null }
        return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => res }) }) }) }
      }
      throw new Error(`Unexpected table ${t}`)
    },
  }
  return { db, shopCalls }
}

describe("getDealerRateTier", () => {
  it("dealer role is dealer without reading the shop", async () => {
    const { db, shopCalls } = fakeDb({ role: "dealer" })
    expect(await getDealerRateTier(db, "u1")).toBe("dealer")
    expect(shopCalls).toHaveLength(0)
  })

  it("user, admin and unknown roles are customer", async () => {
    for (const role of ["user", "admin", null]) {
      const { db } = fakeDb({ role })
      expect(await getDealerRateTier(db, "u1")).toBe("customer")
    }
  })

  it("sub_agent is dealer when their shop has dealer rates on", async () => {
    const { db } = fakeDb({ role: "sub_agent", shop: { data: { dealer_rates_enabled: true }, error: null } })
    expect(await getDealerRateTier(db, "u1")).toBe("dealer")
  })

  it("sub_agent is customer when their shop has dealer rates off", async () => {
    const { db } = fakeDb({ role: "sub_agent", shop: { data: { dealer_rates_enabled: false }, error: null } })
    expect(await getDealerRateTier(db, "u1")).toBe("customer")
  })

  it("sub_agent with no shop row is dealer, matching today", async () => {
    const { db } = fakeDb({ role: "sub_agent", shop: { data: null, error: null } })
    expect(await getDealerRateTier(db, "u1")).toBe("dealer")
  })

  it("sub_agent is dealer when the column does not exist yet (42703 / PGRST204), so a deploy before the migration changes nothing", async () => {
    for (const code of ["42703", "PGRST204"]) {
      const { db } = fakeDb({ role: "sub_agent", shop: { data: null, error: { code, message: "missing" } } })
      expect(await getDealerRateTier(db, "u1")).toBe("dealer")
    }
  })

  it("other shop read errors throw", async () => {
    const { db } = fakeDb({ role: "sub_agent", shop: { data: null, error: { code: "57014", message: "timeout" } } })
    await expect(getDealerRateTier(db, "u1")).rejects.toBeTruthy()
  })

  it("a user read error throws", async () => {
    const { db } = fakeDb({ role: null, usersError: { message: "x" } })
    await expect(getDealerRateTier(db, "u1")).rejects.toBeTruthy()
  })
})
