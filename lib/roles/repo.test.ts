import { describe, expect, it } from "vitest"
import { loadRolePrices, loadRoles, rolePricesFor, RoleReadError, ROLE_ID_CHUNK, ROW_CAP } from "./repo"

type Call = { table: string; filters: Array<[string, unknown[]]> }
type Result = { data: unknown; error: unknown }

/** Minimal fake: from(table).select().in()...limit() is awaitable; `respond` decides each result. */
function fakeClient(respond: (call: Call, n: number) => Result, fakeCap = Infinity) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] }
      let lim = Infinity
      const cap = (r: Result): Result => {
        const eff = Math.min(lim, fakeCap)
        return Array.isArray(r.data) && r.data.length > eff ? { ...r, data: r.data.slice(0, eff) } : r
      }
      const b: any = {
        select: () => b,
        limit: (n: number) => ((lim = n), b),
        in: (col: string, vals: unknown[]) => (call.filters.push([col, vals]), b),
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
          calls.push(call)
          try {
            return Promise.resolve(cap(respond(call, calls.length))).then(res, rej)
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

const ROLES = [
  { id: "r-super", slug: "super", rank: 30, is_system: false, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 20, is_system: true, archived_at: null },
  { id: "r-user", slug: "user", rank: 10, is_system: true, archived_at: null },
  { id: "r-other", slug: "other", rank: null, is_system: false, archived_at: null },
]

describe("loadRoles", () => {
  it("maps rows", async () => {
    const { client } = fakeClient(() => ({ data: ROLES, error: null }))
    expect(await loadRoles(client)).toEqual(ROLES)
  })
  it("rejects RoleReadError on { error }", async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: "boom" } }))
    await expect(loadRoles(client)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("rejects RoleReadError when from() throws", async () => {
    const client = { from: () => { throw new Error("down") } }
    await expect(loadRoles(client)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("rejects RoleReadError on non-array data", async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }))
    await expect(loadRoles(client)).rejects.toBeInstanceOf(RoleReadError)
  })
})

describe("loadRolePrices", () => {
  const ids = Array.from({ length: 1201 }, (_, i) => `p${i}`)
  const respondAll = (call: Call): Result => {
    const pk = call.filters.find(([c]) => c === "package_id")![1] as string[]
    return { data: pk.map((p) => ({ role_id: "r-super", package_id: p, price: "5.5" })), error: null }
  }

  it("chunks package ids by ROLE_ID_CHUNK and returns all prices", async () => {
    const { client, calls } = fakeClient(respondAll)
    const map = await loadRolePrices(client, ["r-super"], ids)
    expect(calls).toHaveLength(3)
    for (const c of calls) {
      const pk = c.filters.find(([col]) => col === "package_id")![1] as unknown[]
      expect(pk.length).toBeLessThanOrEqual(ROLE_ID_CHUNK)
    }
    expect(map.get("r-super")!.size).toBe(1201)
    expect(map.get("r-super")!.get("p1200")).toBe(5.5)
  })
  it("rejects with no partial map when the 2nd chunk errors", async () => {
    const { client } = fakeClient((call, n) => (n === 2 ? { data: null, error: { message: "x" } } : respondAll(call)))
    await expect(loadRolePrices(client, ["r-super"], ids)).rejects.toBeInstanceOf(RoleReadError)
  })
  it("string-keys ids and skips non-positive / non-finite prices", async () => {
    const { client } = fakeClient(() => ({
      data: [
        { role_id: 7, package_id: 1, price: "3" },
        { role_id: 7, package_id: 2, price: 0 },
        { role_id: 7, package_id: 3, price: "abc" },
        { role_id: 7, package_id: 4, price: -1 },
      ],
      error: null,
    }))
    const map = await loadRolePrices(client, ["7"], ["1", "2", "3", "4"])
    expect([...map.get("7")!.entries()]).toEqual([["1", 3]])
  })
  it("sizes chunks so roles x chunk stays under ROW_CAP: 3 roles x 1201 packages, capped server", async () => {
    const roles = ["r1", "r2", "r3"]
    const { client, calls } = fakeClient((call) => {
      const pk = call.filters.find(([c]) => c === "package_id")![1] as string[]
      return { data: pk.flatMap((p) => roles.map((r) => ({ role_id: r, package_id: p, price: 2 }))), error: null }
    }, ROW_CAP)
    const map = await loadRolePrices(client, roles, ids)
    for (const r of roles) expect(map.get(r)!.size).toBe(1201)
    for (const c of calls) {
      const pk = c.filters.find(([col]) => col === "package_id")![1] as unknown[]
      expect(pk.length * roles.length).toBeLessThan(ROW_CAP)
    }
  })
  it("rejects RoleReadError when a response comes back full (cannot know it is complete)", async () => {
    const { client } = fakeClient(() => ({
      data: Array.from({ length: ROW_CAP }, (_, i) => ({ role_id: "r1", package_id: `p${i}`, price: 1 })),
      error: null,
    }))
    await expect(loadRolePrices(client, ["r1"], ["p0", "p1"])).rejects.toBeInstanceOf(RoleReadError)
  })
  it("makes no query for empty inputs", async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }))
    expect((await loadRolePrices(client, [], ["a"])).size).toBe(0)
    expect((await loadRolePrices(client, ["r"], [])).size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe("rolePricesFor", () => {
  const pkgs = [
    { id: "a", price: 10 },
    { id: "b", price: 20 },
  ]
  it("queries only the ladder's role ids and applies fallback", async () => {
    const { client, calls } = fakeClient((call) =>
      call.table === "roles"
        ? { data: ROLES, error: null }
        : { data: [{ role_id: "r-dealer", package_id: "a", price: 8 }, { role_id: "r-super", package_id: "b", price: 15 }], error: null }
    )
    const out = await rolePricesFor(client, "super", pkgs)
    const priceCall = calls.find((c) => c.table === "role_package_prices")!
    expect(priceCall.filters.find(([c]) => c === "role_id")![1]).toEqual(["r-super", "r-dealer", "r-user"])
    expect(out.get("a")).toBe(8)
    expect(out.get("b")).toBe(15)
  })
  it("unknown slug makes no price query and returns public prices", async () => {
    const { client, calls } = fakeClient(() => ({ data: ROLES, error: null }))
    const out = await rolePricesFor(client, "nope", pkgs)
    expect(calls.some((c) => c.table === "role_package_prices")).toBe(false)
    expect(out.get("a")).toBe(10)
    expect(out.get("b")).toBe(20)
  })
  it("fails closed when the price read errors", async () => {
    const { client } = fakeClient((call) =>
      call.table === "roles" ? { data: ROLES, error: null } : { data: null, error: { message: "x" } }
    )
    await expect(rolePricesFor(client, "super", pkgs)).rejects.toBeInstanceOf(RoleReadError)
  })
})
