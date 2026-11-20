import { describe, it, expect } from "vitest"
import {
  validateNewRole, validateRolePatch, validatePriceChanges, validateRateChanges,
  validateCapabilities, validateReason, validateMove, HUB_SERVICE_KEYS,
} from "./validate"
import type { RoleRow } from "../ladder"

const roles: RoleRow[] = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: 100, is_system: true, archived_at: null },
  { id: "r-gold", slug: "gold", rank: 20, is_system: false, archived_at: null },
  { id: "r-old", slug: "old_tier", rank: 30, is_system: false, archived_at: "2026-01-01" },
]
const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"

const goodRole = { slug: "platinum", name: "Platinum", rank: 25, cloneFrom: null, reason: "new tier" }

describe("validateReason", () => {
  it("trims and bounds 3-300", () => {
    expect(validateReason("  abc  ")).toEqual({ ok: true, value: "abc" })
    expect(validateReason("ab").ok).toBe(false)
    expect(validateReason("a".repeat(301)).ok).toBe(false)
    expect(validateReason(5).ok).toBe(false)
  })
})

describe("validateNewRole", () => {
  it("accepts a good role", () => {
    expect(validateNewRole(goodRole, roles)).toEqual({ ok: true, value: goodRole })
  })
  it("rejects bad slugs", () => {
    for (const slug of ["Admin", "dealer", "a", "a".repeat(21), "1abc", "gold", "old_tier", "user", "sub_agent", "admin", 5])
      expect(validateNewRole({ ...goodRole, slug }, roles).ok).toBe(false)
  })
  it("accepts a 20-char slug and 2-char slug", () => {
    expect(validateNewRole({ ...goodRole, slug: "a".repeat(20) }, roles).ok).toBe(true)
    expect(validateNewRole({ ...goodRole, slug: "ab" }, roles).ok).toBe(true)
  })
  it("name trimmed 2-40", () => {
    const r = validateNewRole({ ...goodRole, name: "  Plat  " }, roles)
    expect(r.ok && r.value.name).toBe("Plat")
    expect(validateNewRole({ ...goodRole, name: " a " }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, name: "a".repeat(41) }, roles).ok).toBe(false)
  })
  it("rank: positive int, not used by a live role; archived rank is free", () => {
    expect(validateNewRole({ ...goodRole, rank: 0 }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, rank: 1.5 }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, rank: "5" }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, rank: 20 }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, rank: 30 }, roles).ok).toBe(true)
  })
  it("rank must be strictly above dealer; fails closed when dealer is missing", () => {
    for (const rank of [1, 5, 10]) {
      const r = validateNewRole({ ...goodRole, rank }, roles)
      expect(r).toEqual({ ok: false, error: "Custom tiers must rank above Dealer." })
    }
    expect(validateNewRole({ ...goodRole, rank: 11 }, roles).ok).toBe(true)
    const noDealer = roles.filter((r) => r.slug !== "dealer")
    expect(validateNewRole(goodRole, noDealer)).toEqual({ ok: false, error: "Custom tiers must rank above Dealer." })
  })
  it("cloneFrom: null or live non-admin existing", () => {
    expect(validateNewRole({ ...goodRole, cloneFrom: "gold" }, roles).ok).toBe(true)
    expect(validateNewRole({ ...goodRole, cloneFrom: "admin" }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, cloneFrom: "old_tier" }, roles).ok).toBe(false)
    expect(validateNewRole({ ...goodRole, cloneFrom: "nope" }, roles).ok).toBe(false)
  })
  it("bad reason / non-object", () => {
    expect(validateNewRole({ ...goodRole, reason: "x" }, roles).ok).toBe(false)
    expect(validateNewRole(null, roles).ok).toBe(false)
  })
})

describe("validateRolePatch", () => {
  it("accepts valid keys", () => {
    const r = validateRolePatch({ name: " Gold ", description: null, badge_color: "navy", icon: "Crown", theme: { skin: "dealer" } })
    expect(r).toEqual({ ok: true, value: { name: "Gold", description: null, badge_color: "navy", icon: "Crown", theme: { skin: "dealer" } } })
  })
  it("rejects empty, unknown, bad values", () => {
    expect(validateRolePatch({}).ok).toBe(false)
    expect(validateRolePatch({ slug: "x" }).ok).toBe(false)
    expect(validateRolePatch({ description: "a".repeat(201) }).ok).toBe(false)
    expect(validateRolePatch({ badge_color: "pink" }).ok).toBe(false)
    expect(validateRolePatch({ icon: "Skull" }).ok).toBe(false)
    expect(validateRolePatch({ theme: { skin: "neon" } }).ok).toBe(false)
    expect(validateRolePatch({ name: "a" }).ok).toBe(false)
    expect(validateRolePatch([]).ok).toBe(false)
  })
})

describe("validatePriceChanges", () => {
  const costs = new Map<string, number | null>([["p1", 5], ["p2", null], ["p3", 5]])
  it("rounds, reports belowCost, allows null", () => {
    const r = validatePriceChanges([
      { package_id: "p1", price: 4.994 }, { package_id: "p2", price: 1 }, { package_id: "p3", price: null },
    ], costs)
    expect(r).toEqual({ ok: true, value: {
      changes: [{ package_id: "p1", price: 4.99 }, { package_id: "p2", price: 1 }, { package_id: "p3", price: null }],
      belowCost: ["p1"],
    } })
  })
  it("rejects bad prices", () => {
    for (const price of [0.004, 0, "12,5", "12", NaN, Infinity, -1])
      expect(validatePriceChanges([{ package_id: "p1", price }], costs).ok).toBe(false)
  })
  it("missing price key, unknown package, dup ids, too many, non-array", () => {
    const m = validatePriceChanges([{ package_id: "p1" }], costs)
    expect(m).toEqual({ ok: false, error: expect.stringContaining("price key required") })
    const u = validatePriceChanges([{ package_id: "zz", price: 1 }], costs)
    expect(u).toEqual({ ok: false, error: expect.stringContaining("unknown package") })
    expect(validatePriceChanges([{ package_id: "p1", price: 1 }, { package_id: "p1", price: 2 }], costs).ok).toBe(false)
    expect(validatePriceChanges("x", costs).ok).toBe(false)
    const big = new Map<string, number | null>()
    const arr = Array.from({ length: 1001 }, (_, i) => { big.set("k" + i, null); return { package_id: "k" + i, price: 1 } })
    expect(validatePriceChanges(arr, big).ok).toBe(false)
    expect(validatePriceChanges(arr.slice(0, 1000), big).ok).toBe(true)
  })
  it("rejects overflow and numeric(10,2) overflow; allows the max", () => {
    for (const price of [1e307, 1e8, 100000000, 99999999.995]) {
      const r = validatePriceChanges([{ package_id: "p2", price }], costs)
      expect(r).toEqual({ ok: false, error: expect.stringContaining("price too large") })
    }
    const ok = validatePriceChanges([{ package_id: "p2", price: 99999999.99 }], costs)
    expect(ok.ok && ok.value.changes[0].price).toBe(99999999.99)
  })
  it("0.005 edge rounds to 0.01 and is allowed", () => {
    const r = validatePriceChanges([{ package_id: "p2", price: 0.005 }], costs)
    expect(r.ok && r.value.changes[0].price).toBe(0.01)
  })
})

describe("validateRateChanges", () => {
  const allowed = new Set(HUB_SERVICE_KEYS.map((k) => k.key))
  it("accepts, rounds, clears", () => {
    expect(validateRateChanges([
      { service_key: "airtime_fee:mtn", value: 1.234 }, { service_key: "cashback_share:bills", value: null },
    ], allowed)).toEqual({ ok: true, value: [
      { service_key: "airtime_fee:mtn", value: 1.23 }, { service_key: "cashback_share:bills", value: null },
    ] })
  })
  it("rejects bad", () => {
    expect(validateRateChanges([{ service_key: "x", value: 1 }], allowed).ok).toBe(false)
    expect(validateRateChanges([{ service_key: "airtime_fee:mtn" }], allowed)).toEqual({ ok: false, error: expect.stringContaining("value key required") })
    for (const value of [-1, 100.01, "5", NaN, Infinity])
      expect(validateRateChanges([{ service_key: "airtime_fee:mtn", value }], allowed).ok).toBe(false)
    expect(validateRateChanges([{ service_key: "airtime_fee:mtn", value: 100 }, { service_key: "airtime_fee:mtn", value: 0 }], allowed).ok).toBe(false)
    expect(validateRateChanges({}, allowed).ok).toBe(false)
  })
  it("rejects values that overflow on rounding", () => {
    expect(validateRateChanges([{ service_key: "airtime_fee:mtn", value: 1e307 }], allowed).ok).toBe(false)
  })
  it("has six hub keys", () => expect(HUB_SERVICE_KEYS).toHaveLength(6))
})

describe("validateCapabilities", () => {
  it("dedups and validates", () => {
    expect(validateCapabilities(["buy.data", "buy.data", "shop.sms"])).toEqual({ ok: true, value: ["buy.data", "shop.sms"] })
    expect(validateCapabilities(["bogus"]).ok).toBe(false)
    expect(validateCapabilities("buy.data").ok).toBe(false)
    expect(validateCapabilities([]).ok).toBe(true)
  })
})

describe("validateMove", () => {
  const ok = { userIds: [U1, U2, U1], toRole: "gold", reason: "promo" }
  it("dedups and accepts", () => {
    expect(validateMove(ok, roles)).toEqual({ ok: true, value: { userIds: [U1, U2], toRole: "gold", reason: "promo" } })
  })
  it("rejects bad targets and ids", () => {
    for (const toRole of ["admin", "sub_agent", "old_tier", "nope"])
      expect(validateMove({ ...ok, toRole }, roles).ok).toBe(false)
    expect(validateMove({ ...ok, userIds: [] }, roles).ok).toBe(false)
    expect(validateMove({ ...ok, userIds: ["not-uuid"] }, roles).ok).toBe(false)
    const many = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`)
    expect(validateMove({ ...ok, userIds: many }, roles).ok).toBe(false)
    expect(validateMove({ ...ok, userIds: many.slice(0, 200) }, roles).ok).toBe(true)
    expect(validateMove({ ...ok, reason: "" }, roles).ok).toBe(false)
  })
})
