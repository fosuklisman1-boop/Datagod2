import { describe, it, expect } from "vitest"
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  USER_SORTS,
  clampPageSize,
  isIsoDate,
  listParamsToSearchParams,
  mapRowToUser,
  nextDay,
  normaliseSearch,
  parseRpcResult,
  parseUsersListParams,
  readListParamsFromUrl,
  toRpcArgs,
  type AdminListUsersRow,
  type UsersListParams,
} from "./list-params"

const parse = (qs: string) => parseUsersListParams(new URLSearchParams(qs))
const ok = (qs: string): UsersListParams => {
  const r = parse(qs)
  if (!r.ok) throw new Error(`expected ok for ${qs}: ${r.errors.join("; ")}`)
  return r.params
}
const errs = (qs: string): string[] => {
  const r = parse(qs)
  if (r.ok) throw new Error(`expected errors for ${qs}`)
  return r.errors
}

describe("parseUsersListParams", () => {
  it("defaults to everyone, newest first, page 1 of 50", () => {
    expect(ok("")).toEqual({
      q: null, role: null, suspended: null, hasShop: null, pricingMode: null, from: null, to: null,
      sort: "created_at", dir: "desc", page: 1, pageSize: 50,
    })
  })

  it("reads every filter", () => {
    expect(ok("q=ama&role=dealer&suspended=true&hasShop=false&pricingMode=custom&from=2026-01-01&to=2026-01-31&sort=shop_balance&dir=asc&page=3&pageSize=100"))
      .toEqual({
        q: "ama", role: "dealer", suspended: true, hasShop: false, pricingMode: "custom",
        from: "2026-01-01", to: "2026-01-31", sort: "shop_balance", dir: "asc", page: 3, pageSize: 100,
      })
  })

  it("treats empty and 'all' as no filter", () => {
    const p = ok("q=%20%20&role=all&suspended=all&hasShop=&pricingMode=all&from=&to=")
    expect([p.q, p.role, p.suspended, p.hasShop, p.pricingMode, p.from, p.to]).toEqual([null, null, null, null, null, null, null])
  })

  it("accepts the four real roles, case-insensitively, and rejects anything else", () => {
    for (const r of ["user", "dealer", "sub_agent", "admin"]) expect(ok(`role=${r}`).role).toBe(r)
    expect(ok("role=ADMIN").role).toBe("admin")
    expect(errs("role=shop_owner")[0]).toMatch(/role must be one of/)
    expect(errs("role=admin'--")[0]).toMatch(/role/)
  })

  it("parses booleans and rejects junk", () => {
    expect(ok("suspended=1").suspended).toBe(true)
    expect(ok("suspended=false").suspended).toBe(false)
    expect(ok("hasShop=yes").hasShop).toBe(true)
    expect(ok("hasShop=0").hasShop).toBe(false)
    expect(errs("suspended=maybe")).toEqual(["suspended must be true or false"])
    expect(errs("hasShop=2")).toEqual(["hasShop must be true or false"])
  })

  it("only allows role/custom pricing modes", () => {
    expect(ok("pricingMode=role").pricingMode).toBe("role")
    expect(errs("pricingMode=free")).toEqual(["pricingMode must be role or custom"])
  })

  it("whitelists sorts and dirs", () => {
    for (const s of USER_SORTS) expect(ok(`sort=${s}`).sort).toBe(s)
    expect(ok("sort=EMAIL&dir=ASC")).toMatchObject({ sort: "email", dir: "asc" })
    expect(errs("sort=id")[0]).toMatch(/sort must be one of: created_at, balance, email, shop_balance, last_sign_in_at/)
    expect(errs("sort=created_at;drop table users")[0]).toMatch(/sort/)
    expect(errs("sort=phone_number")[0]).toMatch(/sort/)
    expect(errs("dir=up")).toEqual(["dir must be asc or desc"])
  })

  it("validates dates and the range", () => {
    expect(ok("from=2026-02-28").from).toBe("2026-02-28")
    expect(errs("from=2026-02-30")).toEqual(["from must be a date (YYYY-MM-DD)"])
    expect(errs("to=yesterday")).toEqual(["to must be a date (YYYY-MM-DD)"])
    expect(errs("from=2026-01-01T00:00:00Z")).toEqual(["from must be a date (YYYY-MM-DD)"])
    expect(errs("from=2026-03-01&to=2026-02-01")).toEqual(["from must not be after to"])
    expect(ok("from=2026-03-01&to=2026-03-01")).toMatchObject({ from: "2026-03-01", to: "2026-03-01" })
  })

  it("validates page and clamps pageSize", () => {
    expect(ok("page=2").page).toBe(2)
    expect(errs("page=0")[0]).toMatch(/page must be an integer/)
    expect(errs("page=-1")[0]).toMatch(/page/)
    expect(errs("page=1.5")[0]).toMatch(/page/)
    expect(errs("page=abc")[0]).toMatch(/page/)
    expect(errs("page=100001")[0]).toMatch(/page/)
    expect(ok("pageSize=1000").pageSize).toBe(MAX_PAGE_SIZE)
    expect(ok("pageSize=0").pageSize).toBe(1)
    expect(ok("pageSize=200").pageSize).toBe(200)
    expect(errs("pageSize=-5")[0]).toMatch(/pageSize/)
    expect(errs("pageSize=ten")[0]).toMatch(/pageSize/)
  })

  it("collects every error at once", () => {
    expect(errs("role=x&sort=y&dir=z")).toHaveLength(3)
  })
})

describe("normaliseSearch", () => {
  it("trims, collapses whitespace, strips control characters, caps at 100", () => {
    expect(normaliseSearch(null)).toBeNull()
    expect(normaliseSearch("   ")).toBeNull()
    expect(normaliseSearch("  ama   boateng ")).toBe("ama boateng")
    expect(normaliseSearch("a\u0000b\nc\td")).toBe("a b c d")
    expect(normaliseSearch("x".repeat(300))).toHaveLength(100)
  })

  it("leaves LIKE wildcards for the database to escape (they are searched literally there)", () => {
    // admin_list_users escapes \ % _ itself; escaping here too would double-escape.
    expect(normaliseSearch("50%_off\\")).toBe("50%_off\\")
    expect(toRpcArgs({ ...ok(""), q: "a%b_c" }).p_search).toBe("a%b_c")
  })
})

describe("clampPageSize / isIsoDate / nextDay", () => {
  it("clamps", () => {
    expect(clampPageSize(0)).toBe(1)
    expect(clampPageSize(-10)).toBe(1)
    expect(clampPageSize(50.9)).toBe(50)
    expect(clampPageSize(201)).toBe(200)
    expect(clampPageSize(NaN)).toBe(DEFAULT_PAGE_SIZE)
  })
  it("dates", () => {
    expect(isIsoDate("2024-02-29")).toBe(true)
    expect(isIsoDate("2026-02-29")).toBe(false)
    expect(isIsoDate("2026-1-1")).toBe(false)
    expect(nextDay("2026-01-31")).toBe("2026-02-01")
    expect(nextDay("2026-12-31")).toBe("2027-01-01")
  })
})

describe("toRpcArgs", () => {
  it("maps params to the RPC, with an exclusive end-of-day upper bound", () => {
    expect(toRpcArgs(ok("q=ama&role=dealer&suspended=false&hasShop=true&pricingMode=custom&from=2026-01-01&to=2026-01-31&sort=email&dir=asc&page=3&pageSize=20")))
      .toEqual({
        p_search: "ama", p_role: "dealer", p_suspended: false, p_has_shop: true, p_pricing_mode: "custom",
        p_created_from: "2026-01-01T00:00:00Z", p_created_to: "2026-02-01T00:00:00Z",
        p_sort: "email", p_dir: "asc", p_limit: 20, p_offset: 40,
      })
  })

  it("passes nulls for absent filters and clamps paging defensively", () => {
    const a = toRpcArgs({ ...ok(""), page: 0, pageSize: 5000 })
    expect(a).toMatchObject({ p_search: null, p_role: null, p_suspended: null, p_has_shop: null, p_pricing_mode: null,
      p_created_from: null, p_created_to: null, p_sort: "created_at", p_dir: "desc", p_limit: 200, p_offset: 0 })
  })
})

describe("URL round trip", () => {
  it("omits defaults", () => {
    expect(listParamsToSearchParams(ok("")).toString()).toBe("")
    expect(listParamsToSearchParams({ page: 1, pageSize: 50, sort: "created_at", dir: "desc" }).toString()).toBe("")
  })

  it("round-trips every field", () => {
    const qs = "q=ama+b&role=admin&suspended=false&hasShop=true&pricingMode=custom&from=2026-01-01&to=2026-02-01&sort=balance&dir=asc&page=4&pageSize=100"
    const p = ok(qs)
    expect(ok(listParamsToSearchParams(p).toString())).toEqual(p)
  })

  it("the page's lenient reader drops only the bad keys", () => {
    const p = readListParamsFromUrl(new URLSearchParams("role=boss&sort=email&page=zero&suspended=true&from=2026-05-01&to=2026-04-01"))
    expect(p).toMatchObject({ role: null, sort: "email", page: 1, suspended: true, from: null, to: null })
  })
})

describe("mapRowToUser", () => {
  const row: AdminListUsersRow = {
    id: "u1", email: "a@x.com", phone_number: "0244123456", first_name: "Ama", last_name: "B",
    role: "dealer", is_suspended: false, pricing_mode: "custom", created_at: "2026-01-01T00:00:00+00:00",
    last_sign_in_at: null, shop_id: "s1", shop_name: "Ama Data", shop_created_at: "2026-01-02T00:00:00+00:00",
    wallet_balance: 10.5, shop_balance: "2.25", customer_count: 3, sub_agent_count: 1,
  }

  it("keeps the fields the page, admin-service and ai-tools always used", () => {
    expect(mapRowToUser(row)).toEqual({
      id: "u1", email: "a@x.com", phoneNumber: "0244123456", created_at: "2026-01-01T00:00:00+00:00",
      shop: { id: "s1", user_id: "u1", shop_name: "Ama Data", created_at: "2026-01-02T00:00:00+00:00" },
      walletBalance: 10.5, shopBalance: 2.25, balance: 12.75, role: "dealer", customerCount: 3, subAgentCount: 1,
      is_suspended: false, pricing_mode: "custom", first_name: "Ama", last_name: "B", last_sign_in_at: null,
    })
  })

  it("no shop: shop null, shop balance and counts 0, balance = wallet", () => {
    const u = mapRowToUser({ ...row, shop_id: null, shop_name: null, shop_balance: 99, customer_count: 5, sub_agent_count: 5 })
    expect(u).toMatchObject({ shop: null, shopBalance: 0, balance: 10.5, customerCount: 0, subAgentCount: 0 })
  })

  it("fills old defaults for missing values", () => {
    const u = mapRowToUser({ ...row, phone_number: null, email: null, role: "", wallet_balance: null, pricing_mode: null as any })
    expect(u).toMatchObject({ phoneNumber: "", email: "", role: "user", walletBalance: 0, pricing_mode: "role" })
  })
})

describe("parseRpcResult", () => {
  it("accepts {total, rows}", () => {
    expect(parseRpcResult({ total: 2, rows: [] })).toEqual({ total: 2, rows: [] })
    expect(parseRpcResult({ total: "7", rows: [] }).total).toBe(7)
  })
  it("throws on anything else", () => {
    expect(() => parseRpcResult(null)).toThrow()
    expect(() => parseRpcResult([])).toThrow()
    expect(() => parseRpcResult({ total: -1, rows: [] })).toThrow()
    expect(() => parseRpcResult({ total: 1 })).toThrow()
  })
})
