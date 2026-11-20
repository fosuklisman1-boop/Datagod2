import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadRolePermissions, rightsForUser, __resetRightsCache } from "./permissions-repo"
import { RoleReadError, ROW_CAP } from "./repo"

type Result = { data: unknown; error: unknown }

function fakeClient(opts: {
  userRole?: string | null
  userError?: boolean
  roles?: unknown[]
  perms?: unknown[]
  rolesError?: boolean
  permsError?: boolean
  permsErrorOnPage?: number
}) {
  const reads: string[] = []
  const permsReads: Array<[number, number] | null> = []
  const client = {
    from(table: string) {
      reads.push(table)
      let range: [number, number] | null = null
      const result = (): Result => {
        if (table === "users") {
          return opts.userError
            ? { data: null, error: { message: "boom" } }
            : { data: { role: opts.userRole ?? null }, error: null }
        }
        if (table === "roles") {
          return opts.rolesError ? { data: null, error: { message: "boom" } } : { data: opts.roles ?? [], error: null }
        }
        permsReads.push(range)
        if (opts.permsErrorOnPage !== undefined && permsReads.length - 1 === opts.permsErrorOnPage) {
          return { data: null, error: { message: "boom" } }
        }
        if (opts.permsError) return { data: null, error: { message: "boom" } }
        const all = opts.perms ?? []
        return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null }
      }
      const b: any = {
        select: () => b,
        eq: () => b,
        limit: () => b,
        order: () => b,
        range: (from: number, to: number) => {
          range = [from, to]
          return b
        },
        maybeSingle: () => Promise.resolve(result()),
        then: (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result()).then(res, rej),
      }
      return b
    },
  }
  return { client, reads, permsReads }
}

const ROLES = [
  { id: "r-user", slug: "user", rank: 10, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 20, is_system: true, archived_at: null },
]

beforeEach(() => __resetRightsCache())
afterEach(() => vi.useRealTimers())

describe("loadRolePermissions", () => {
  it("unknown capability strings are ignored", async () => {
    const { client } = fakeClient({
      perms: [
        { role_id: "r-user", capability: "buy.data" },
        { role_id: "r-user", capability: "not.a.capability" },
      ],
    })
    const m = await loadRolePermissions(client)
    expect([...(m.get("r-user") ?? [])]).toEqual(["buy.data"])
  })

  it("pages past ROW_CAP rows with .range() until a short page, and loses nothing", async () => {
    const caps = ["buy.data", "buy.airtime", "buy.afa", "buy.bills", "buy.results", "shop.storefront", "shop.subagents",
      "shop.bots", "shop.sms", "shop.text_orders", "account.wallet", "account.api", "account.leaderboard", "account.upgrade"]
    const roles = Math.ceil((ROW_CAP + 300) / caps.length)
    const perms = Array.from({ length: roles * caps.length }, (_, i) => ({ role_id: `r-${Math.floor(i / caps.length)}`, capability: caps[i % caps.length] }))
    expect(perms.length).toBeGreaterThan(ROW_CAP)
    const { client, permsReads } = fakeClient({ perms })
    const m = await loadRolePermissions(client)
    expect(m.size).toBe(roles)
    expect([...(m.get(`r-${roles - 1}`) ?? [])]).toHaveLength(caps.length)
    expect(permsReads.length).toBeGreaterThan(1)
    expect(permsReads[0]).toEqual([0, 499])
  })

  it("an exact multiple of the page size ends on an empty page, not a failure", async () => {
    const perms = Array.from({ length: 500 }, (_, i) => ({ role_id: `r-${i}`, capability: "buy.data" }))
    const { client, permsReads } = fakeClient({ perms })
    expect((await loadRolePermissions(client)).size).toBe(500)
    expect(permsReads).toHaveLength(2)
  })

  it("a read error on a later page fails closed (never a partial map)", async () => {
    const perms = Array.from({ length: 700 }, (_, i) => ({ role_id: `r-${i}`, capability: "buy.data" }))
    await expect(loadRolePermissions(fakeClient({ perms, permsErrorOnPage: 1 }).client)).rejects.toBeInstanceOf(RoleReadError)
  })

  it("a read error rejects", async () => {
    await expect(loadRolePermissions(fakeClient({ permsError: true }).client)).rejects.toBeInstanceOf(RoleReadError)
  })
})

describe("rightsForUser", () => {
  it("NULL users.role gets user rights", async () => {
    const { client } = fakeClient({
      userRole: null,
      roles: ROLES,
      perms: [{ role_id: "r-user", capability: "buy.airtime" }],
    })
    const r = await rightsForUser(client, "u1")
    expect(r.slug).toBe("user")
    expect(r.rights.kind === "set" && r.rights.caps.has("buy.airtime")).toBe(true)
  })

  it("a read error rejects", async () => {
    await expect(rightsForUser(fakeClient({ userError: true }).client, "u1")).rejects.toBeInstanceOf(RoleReadError)
    __resetRightsCache()
    await expect(
      rightsForUser(fakeClient({ userRole: "user", rolesError: true }).client, "u1")
    ).rejects.toBeInstanceOf(RoleReadError)
  })

  it("cache: a second call within 60s does not read; after 60s it reads", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-19T00:00:00Z"))
    const { client, reads } = fakeClient({ userRole: "dealer", roles: ROLES, perms: [] })
    await rightsForUser(client, "u1")
    const first = reads.filter((t) => t !== "users").length
    expect(first).toBe(2)
    vi.advanceTimersByTime(30_000)
    await rightsForUser(client, "u1")
    expect(reads.filter((t) => t !== "users").length).toBe(first)
    vi.advanceTimersByTime(31_000)
    await rightsForUser(client, "u1")
    expect(reads.filter((t) => t !== "users").length).toBe(first * 2)
    // the user's own role is read every time
    expect(reads.filter((t) => t === "users").length).toBe(3)
  })
})
