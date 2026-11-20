import { beforeEach, describe, expect, it } from "vitest"
import { requireCapability } from "./require-capability"
import { __resetRightsCache } from "./permissions-repo"

function client(opts: { role: string | null; perms?: unknown[]; fail?: "users" | "roles" | "role_permissions" }) {
  return {
    from(table: string) {
      const result = () => {
        if (opts.fail === table) return { data: null, error: { message: "boom" } }
        if (table === "users") return { data: { role: opts.role }, error: null }
        if (table === "roles")
          return {
            data: [
              { id: "r-user", slug: "user", rank: 10, is_system: true, archived_at: null },
              { id: "r-dealer", slug: "dealer", rank: 20, is_system: true, archived_at: null },
            ],
            error: null,
          }
        return { data: opts.perms ?? [], error: null }
      }
      const b: any = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        order: () => b,
        range: () => b,
        maybeSingle: () => Promise.resolve(result()),
        then: (res: any, rej: any) => Promise.resolve(result()).then(res, rej),
      }
      return b
    },
  }
}

beforeEach(() => __resetRightsCache())

describe("requireCapability", () => {
  it("allows a role holding the capability", async () => {
    const c = client({ role: "dealer", perms: [{ role_id: "r-dealer", capability: "buy.airtime" }] })
    expect(await requireCapability(c, "u1", "buy.airtime")).toBeNull()
  })

  it("denies with 403 when the capability is missing", async () => {
    const c = client({ role: "dealer", perms: [{ role_id: "r-dealer", capability: "buy.data" }] })
    const res = await requireCapability(c, "u1", "buy.airtime")
    expect(res?.status).toBe(403)
    expect(await res!.json()).toEqual({ error: "This feature isn't available for your account." })
  })

  it("sub_agent and admin are always allowed", async () => {
    expect(await requireCapability(client({ role: "sub_agent" }), "u1", "shop.sms")).toBeNull()
    __resetRightsCache()
    expect(await requireCapability(client({ role: "admin" }), "u1", "account.api")).toBeNull()
  })

  it("a read error rejects; requireCapability returns 503, never null", async () => {
    for (const fail of ["users", "roles", "role_permissions"] as const) {
      __resetRightsCache()
      const res = await requireCapability(client({ role: "dealer", fail }), "u1", "buy.data")
      expect(res).not.toBeNull()
      expect(res!.status).toBe(503)
      expect(await res!.json()).toEqual({ error: "Couldn't check your access. Please try again." })
    }
  })
})
