import { describe, expect, it } from "vitest"
import type { RoleRow } from "./ladder"
import { RoleReadError, ROW_CAP } from "./repo"
import { rateSlug, resolveServiceRate, serviceRatesFor } from "./service-rates"

const ROLES: RoleRow[] = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  { id: "r-old", slug: "old", rank: 15, is_system: false, archived_at: "2026-01-01" },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const LEGACY = { customer: 3, dealer: 5 }
const none = new Map<string, Map<string, number>>()

describe("resolveServiceRate", () => {
  it("empty table: dealer -> legacy.dealer, user -> legacy.customer, unknown -> legacy.customer", () => {
    expect(resolveServiceRate("dealer", "k", ROLES, none, LEGACY)).toBe(5)
    expect(resolveServiceRate("user", "k", ROLES, none, LEGACY)).toBe(3)
    expect(resolveServiceRate("nope", "k", ROLES, none, LEGACY)).toBe(3)
    expect(resolveServiceRate("old", "k", ROLES, none, LEGACY)).toBe(3)
  })
  it("off-ladder system slugs with no row are safe (legacy.customer)", () => {
    expect(resolveServiceRate("sub_agent", "k", ROLES, none, LEGACY)).toBe(3)
    expect(resolveServiceRate("admin", "k", ROLES, none, LEGACY)).toBe(3)
  })
  it("custom role row wins", () => {
    const rows = new Map([["r-gold", new Map([["k", 1.5]])]])
    expect(resolveServiceRate("gold", "k", ROLES, rows, LEGACY)).toBe(1.5)
  })
  it("custom role without a row falls to the next lower (dealer -> legacy.dealer)", () => {
    expect(resolveServiceRate("gold", "k", ROLES, none, LEGACY)).toBe(5)
    const rows = new Map([["r-gold", new Map([["other", 9]])]])
    expect(resolveServiceRate("gold", "k", ROLES, rows, LEGACY)).toBe(5)
  })
  it("a dealer row beats legacy.dealer and is used by custom roles lacking a row", () => {
    const rows = new Map([["r-dealer", new Map([["k", 4]])]])
    expect(resolveServiceRate("dealer", "k", ROLES, rows, LEGACY)).toBe(4)
    expect(resolveServiceRate("gold", "k", ROLES, rows, LEGACY)).toBe(4)
  })
  it("a zero rate row is a real value", () => {
    const rows = new Map([["r-gold", new Map([["k", 0]])]])
    expect(resolveServiceRate("gold", "k", ROLES, rows, LEGACY)).toBe(0)
  })
})

describe("rateSlug", () => {
  it("maps tier decision for system roles", () => {
    expect(rateSlug(true, "admin", ROLES)).toBe("dealer")
    expect(rateSlug(false, "admin", ROLES)).toBe("user")
    expect(rateSlug(true, "sub_agent", ROLES)).toBe("dealer")
    expect(rateSlug(false, "dealer", ROLES)).toBe("user")
    expect(rateSlug(true, null, ROLES)).toBe("dealer")
    expect(rateSlug(false, undefined, ROLES)).toBe("user")
  })
  it("a non-archived custom role keeps its own slug", () => {
    expect(rateSlug(true, "gold", ROLES)).toBe("gold")
    expect(rateSlug(false, "gold", ROLES)).toBe("gold")
  })
  it("archived or unknown custom role falls back to the tier", () => {
    expect(rateSlug(true, "old", ROLES)).toBe("dealer")
    expect(rateSlug(false, "ghost", ROLES)).toBe("user")
  })
})

type Call = { table: string; filters: Array<[string, unknown[]]> }
type Result = { data: unknown; error: unknown }
function fakeClient(respond: (call: Call, n: number) => Result) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] }
      const b: any = {
        select: () => b,
        limit: () => b,
        in: (col: string, vals: unknown[]) => (call.filters.push([col, vals]), b),
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
          calls.push(call)
          try {
            return Promise.resolve(respond(call, calls.length)).then(res, rej)
          } catch (e) {
            return Promise.reject(e).then(res, rej)
          }
        },
      }
      return b
    },
  }
  return { client, calls }
}
const legacy = () => LEGACY

describe("serviceRatesFor", () => {
  it("empty table gives legacy values with one roles read and one rates query", async () => {
    const { client, calls } = fakeClient((c) =>
      c.table === "roles" ? { data: ROLES, error: null } : { data: [], error: null }
    )
    const dealer = await serviceRatesFor(client, "dealer", ["a", "b"], legacy)
    expect(dealer.get("a")).toBe(5)
    expect(dealer.get("b")).toBe(5)
    const user = await serviceRatesFor(client, "user", ["a"], legacy)
    expect(user.get("a")).toBe(3)
    const rateCalls = calls.filter((c) => c.table === "role_service_rates")
    expect(rateCalls).toHaveLength(2)
    expect(rateCalls[0].filters).toEqual([
      ["role_id", ["r-dealer", "r-user"]],
      ["service_key", ["a", "b"]],
    ])
  })
  it("rows override, numeric strings are parsed, per-key legacy is used", async () => {
    const { client } = fakeClient((c) =>
      c.table === "roles"
        ? { data: ROLES, error: null }
        : { data: [{ role_id: "r-gold", service_key: "a", value: "1.50" }], error: null }
    )
    const m = await serviceRatesFor(client, "gold", ["a", "b"], (k) => (k === "b" ? { customer: 1, dealer: 2 } : LEGACY))
    expect(m.get("a")).toBe(1.5)
    expect(m.get("b")).toBe(2)
  })
  it("unknown slug makes no rates query and returns legacy.customer", async () => {
    const { client, calls } = fakeClient(() => ({ data: ROLES, error: null }))
    const m = await serviceRatesFor(client, "ghost", ["a"], legacy)
    expect(m.get("a")).toBe(3)
    expect(calls.filter((c) => c.table === "role_service_rates")).toHaveLength(0)
  })
  it("chunks keys at 500", async () => {
    const keys = Array.from({ length: 1200 }, (_, i) => `k${i}`)
    const { client, calls } = fakeClient((c) =>
      c.table === "roles" ? { data: ROLES, error: null } : { data: [], error: null }
    )
    await serviceRatesFor(client, "user", keys, legacy)
    const sizes = calls.filter((c) => c.table === "role_service_rates").map((c) => (c.filters[1][1] as unknown[]).length)
    expect(sizes).toEqual([500, 500, 200])
  })
  it("roles read failure -> RoleReadError", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }))
    await expect(serviceRatesFor(client, "dealer", ["a"], legacy)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("rates read failure -> RoleReadError (no partial map)", async () => {
    const { client } = fakeClient((c) =>
      c.table === "roles" ? { data: ROLES, error: null } : { data: null, error: { message: "boom" } }
    )
    await expect(serviceRatesFor(client, "dealer", ["a"], legacy)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("thrown query -> RoleReadError", async () => {
    const { client } = fakeClient((c) => {
      if (c.table === "roles") return { data: ROLES, error: null }
      throw new Error("net")
    })
    await expect(serviceRatesFor(client, "dealer", ["a"], legacy)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("a full page is rejected as possibly truncated", async () => {
    const full = Array.from({ length: ROW_CAP }, (_, i) => ({ role_id: "r-dealer", service_key: `k${i}`, value: 1 }))
    const { client } = fakeClient((c) => (c.table === "roles" ? { data: ROLES, error: null } : { data: full, error: null }))
    await expect(serviceRatesFor(client, "dealer", ["a"], legacy)).rejects.toBeInstanceOf(RoleReadError)
  })
})
