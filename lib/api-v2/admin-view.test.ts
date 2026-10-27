import { describe, it, expect } from "vitest"
import {
  mergeKeys,
  filterKeys,
  statusCounts,
  keyTypeLabel,
  limitFormValues,
  validateLimitForm,
  type ConsoleKey,
  type V1AdminKey,
  type V2AdminKey,
} from "./admin-view"
import { DEFAULT_LIMITS } from "./limits"

const v1 = (over: Partial<V1AdminKey> = {}): V1AdminKey => ({
  id: "v1-a",
  name: "Old key",
  key_prefix: "dg_live_ab12",
  environment: "live",
  is_active: true,
  rate_limit_per_min: 60,
  last_used_at: "2026-10-20T10:00:00Z",
  created_at: "2026-09-01T10:00:00Z",
  user: { email: "kofi@example.com", first_name: "Kofi", last_name: "Boateng", role: "dealer" },
  ...over,
})

const v2 = (over: Partial<V2AdminKey> = {}): V2AdminKey => ({
  id: "v2-a",
  user_id: "u1",
  key_type: "standard",
  environment: "live",
  status: "pending",
  name: "My key",
  key_prefix: "dg2_live_zz99",
  rate_limits: { status: 7 },
  last_used_at: null,
  created_at: "2026-10-21T10:00:00Z",
  owner: { id: "u1", first_name: "Ama", last_name: "Mensah", email: "ama@example.com", role: "agent" },
  ...over,
})

describe("mergeKeys", () => {
  it("maps v1 and v2 rows and badges the source", () => {
    const out = mergeKeys([v1(), v1({ id: "v1-b", is_active: false })], [v2()])
    expect(out).toHaveLength(3)
    const a = out.find((k) => k.id === "v1-a")!
    expect(a).toMatchObject({
      source: "v1",
      status: "active",
      keyType: null,
      rateLimits: null,
      v1RatePerMin: 60,
      ownerName: "Kofi Boateng",
      ownerEmail: "kofi@example.com",
      ownerRole: "dealer",
      prefix: "dg_live_ab12",
      environment: "live",
      requests24h: null,
    })
    expect(out.find((k) => k.id === "v1-b")!.status).toBe("revoked")
    expect(out.find((k) => k.id === "v2-a")).toMatchObject({
      source: "v2",
      status: "pending",
      keyType: "standard",
      rateLimits: { status: 7 },
      v1RatePerMin: null,
      ownerName: "Ama Mensah",
      ownerRole: "agent",
    })
  })

  it("tolerates a missing owner", () => {
    const out = mergeKeys([v1({ user: null })], [v2({ owner: null })])
    for (const k of out) {
      expect(k.ownerName).toBe("Deleted user")
      expect(k.ownerEmail).toBe("")
      expect(k.ownerRole).toBeNull()
      expect(k.ownerPhone).toBeNull()
    }
  })

  it("never copies key_hash through", () => {
    const out = mergeKeys(
      [{ ...v1(), key_hash: "secret1" } as V1AdminKey],
      [{ ...v2(), key_hash: "secret2" } as V2AdminKey]
    )
    for (const k of out) {
      expect(Object.keys(k).sort()).toEqual(
        [
          "id", "source", "ownerName", "ownerEmail", "ownerRole", "ownerPhone", "prefix", "status",
          "keyType", "environment", "requests24h", "lastUsedAt", "rateLimits", "v1RatePerMin", "createdAt",
        ].sort()
      )
      expect(JSON.stringify(k)).not.toContain("secret")
    }
  })
})

const fixtures = (): ConsoleKey[] =>
  mergeKeys(
    [
      v1({ id: "a", created_at: "2026-09-01T00:00:00Z", user: { email: "kofi@example.com", first_name: "Kofi", last_name: "B", role: "dealer", phone: "0241112222" } }),
    ],
    [
      v2({ id: "b", created_at: "2026-10-01T00:00:00Z", status: "active", requests_24h: 50 }),
      v2({ id: "c", created_at: "2026-10-10T00:00:00Z", status: "revoked", requests_24h: 900, key_prefix: "dg2_live_qq11", owner: { id: "u2", first_name: "Yaw", last_name: "Z", email: "yaw@example.com", role: "customer" } }),
      v2({ id: "d", created_at: "2026-10-15T00:00:00Z", status: "pending", requests_24h: null }),
    ]
  )

const base = { q: "", status: "all" as const, role: "all", sort: "newest" as const }

describe("filterKeys", () => {
  it("searches name, email, phone and prefix case-insensitively", () => {
    const keys = fixtures()
    expect(filterKeys(keys, { ...base, q: "YAW@EXAMPLE" }).map((k) => k.id)).toEqual(["c"])
    expect(filterKeys(keys, { ...base, q: "0241112" }).map((k) => k.id)).toEqual(["a"])
    expect(filterKeys(keys, { ...base, q: "dg2_live_QQ" }).map((k) => k.id)).toEqual(["c"])
    expect(filterKeys(keys, { ...base, q: "ama mensah" }).map((k) => k.id).sort()).toEqual(["b", "d"])
  })

  it("filters by status and role", () => {
    const keys = fixtures()
    expect(filterKeys(keys, { ...base, status: "pending" }).map((k) => k.id)).toEqual(["d"])
    expect(filterKeys(keys, { ...base, role: "customer" }).map((k) => k.id)).toEqual(["c"])
  })

  it("sorts newest, oldest and most_used with nulls last", () => {
    const keys = fixtures()
    expect(filterKeys(keys, base).map((k) => k.id)).toEqual(["d", "c", "b", "a"])
    expect(filterKeys(keys, { ...base, sort: "oldest" }).map((k) => k.id)).toEqual(["a", "b", "c", "d"])
    expect(filterKeys(keys, { ...base, sort: "most_used" }).map((k) => k.id)).toEqual(["c", "b", "d", "a"])
  })

  it("does not mutate its input", () => {
    const keys = fixtures()
    const before = keys.map((k) => k.id)
    filterKeys(keys, { ...base, sort: "oldest" })
    expect(keys.map((k) => k.id)).toEqual(before)
  })
})

describe("statusCounts", () => {
  it("adds up", () => {
    expect(statusCounts(fixtures())).toEqual({ all: 4, pending: 1, active: 2, revoked: 1 })
    expect(statusCounts([])).toEqual({ all: 0, pending: 0, active: 0, revoked: 0 })
  })
})

describe("limit form", () => {
  it("fills defaults", () => {
    expect(limitFormValues(null)).toEqual(DEFAULT_LIMITS)
    expect(limitFormValues({ status: 7 })).toEqual({ ...DEFAULT_LIMITS, status: 7 })
  })

  it("rejects invalid entries per group", () => {
    for (const bad of ["", "0", "10001", "1.5", "abc", "-3"]) {
      const r = validateLimitForm({ purchase: bad, bulk: "3", balance: "30", status: "30" })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(Object.keys(r.errors)).toEqual(["purchase"])
        expect(r.errors.purchase).toMatch(/1.*10000/)
      }
    }
  })

  it("accepts valid values", () => {
    const r = validateLimitForm({ purchase: "25", bulk: "1", balance: "10000", status: " 30 " })
    expect(r).toEqual({ ok: true, value: { purchase: 25, bulk: 1, balance: 10000, status: 30 } })
  })
})

describe("admin console handles sms keys", () => {
  it("merges an sms key and labels it SMS", () => {
    const out = mergeKeys([], [v2({ id: "v2-sms", key_type: "sms" })])
    expect(out[0]).toMatchObject({ source: "v2", keyType: "sms" })
    expect(keyTypeLabel(out[0])).toBe("SMS")
  })
})
