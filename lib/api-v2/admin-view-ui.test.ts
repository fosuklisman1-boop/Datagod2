import { describe, it, expect } from "vitest"
import {
  roleLabel,
  keyTypeLabel,
  keyActions,
  parseV1RateLimit,
  roleOptions,
  toggleRole,
  formatCount,
  formatPercent,
  formatLatency,
  sanitizeV1Search,
  sameConfig,
  type ConsoleKey,
} from "./admin-view"

const key = (over: Partial<ConsoleKey> = {}): ConsoleKey => ({
  id: "k1",
  source: "v2",
  ownerName: "Ama Mensah",
  ownerEmail: "ama@example.com",
  ownerRole: "dealer",
  ownerPhone: null,
  prefix: "dg_live_ab12",
  status: "active",
  keyType: "standard",
  environment: "live",
  requests24h: 4,
  lastUsedAt: null,
  rateLimits: null,
  v1RatePerMin: null,
  createdAt: "2026-10-20T10:00:00Z",
  ...over,
})

describe("roleLabel", () => {
  it("labels known roles and humanizes unknown ones", () => {
    expect(roleLabel("user")).toBe("Customer")
    expect(roleLabel("sub_agent")).toBe("Subagent")
    expect(roleLabel("dealer")).toBe("Dealer")
    expect(roleLabel("admin")).toBe("Admin")
    expect(roleLabel("shop_owner")).toBe("Shop owner")
    expect(roleLabel(null)).toBe("No role")
    expect(roleLabel("")).toBe("No role")
  })
})

describe("keyTypeLabel", () => {
  it("labels v1 and each v2 type", () => {
    expect(keyTypeLabel(key({ source: "v1", keyType: null }))).toBe("v1")
    expect(keyTypeLabel(key({ keyType: "standard" }))).toBe("Standard")
    expect(keyTypeLabel(key({ keyType: "commission" }))).toBe("Commission · Utilities")
    expect(keyTypeLabel(key({ keyType: "sms" }))).toBe("SMS")
  })
})

describe("keyActions", () => {
  it("pending v2: approve, revoke, activity, limits", () => {
    expect(keyActions(key({ status: "pending" }))).toEqual({
      approve: true, revoke: true, activity: true, limits: true, v1Toggle: false, v1Delete: false, v1Rate: false,
    })
  })
  it("active v2: no approve", () => {
    const a = keyActions(key({ status: "active" }))
    expect(a.approve).toBe(false)
    expect(a.revoke).toBe(true)
    expect(a.limits).toBe(true)
  })
  it("revoked v2: only activity", () => {
    expect(keyActions(key({ status: "revoked" }))).toEqual({
      approve: false, revoke: false, activity: true, limits: false, v1Toggle: false, v1Delete: false, v1Rate: false,
    })
  })
  it("v1: only v1 controls, no activity", () => {
    expect(keyActions(key({ source: "v1", keyType: null, status: "revoked" }))).toEqual({
      approve: false, revoke: false, activity: false, limits: false, v1Toggle: true, v1Delete: true, v1Rate: true,
    })
  })
})

describe("parseV1RateLimit", () => {
  it("accepts whole numbers 1-10000", () => {
    expect(parseV1RateLimit("1")).toEqual({ ok: true, value: 1 })
    expect(parseV1RateLimit(" 10000 ")).toEqual({ ok: true, value: 10000 })
  })
  it("rejects anything else", () => {
    for (const bad of ["", "0", "10001", "1.5", "abc", "-3", "1e3"]) {
      const r = parseV1RateLimit(bad)
      expect(r.ok).toBe(false)
    }
  })
})

describe("roleOptions", () => {
  it("returns distinct non-null roles, sorted by label", () => {
    const keys = [key({ ownerRole: "user" }), key({ ownerRole: "dealer" }), key({ ownerRole: null }), key({ ownerRole: "dealer" })]
    expect(roleOptions(keys)).toEqual(["user", "dealer"])
  })
})

describe("toggleRole", () => {
  it("adds and removes without duplicates and keeps V2_ROLES order", () => {
    expect(toggleRole(["dealer"], "user")).toEqual(["user", "dealer"])
    expect(toggleRole(["user", "dealer"], "user")).toEqual(["dealer"])
    expect(toggleRole([], "admin")).toEqual(["admin"])
  })
})

describe("sanitizeV1Search", () => {
  it("strips the PostgREST .or() separators and grouping characters", () => {
    expect(sanitizeV1Search("/v1/bundles")).toBe("/v1/bundles")
    expect(sanitizeV1Search("x,status_code.eq.200")).toBe("xstatus_code.eq.200")
    expect(sanitizeV1Search("and(a.eq.1,b.eq.2)")).toBe("anda.eq.1b.eq.2")
    expect(sanitizeV1Search("  POST  ")).toBe("POST")
    expect(sanitizeV1Search(",()")).toBe("")
  })
})

describe("sameConfig", () => {
  it("compares enabled and roles by value, ignoring role order", () => {
    expect(sameConfig({ enabled: true, allowed_roles: ["dealer", "user"] }, { enabled: true, allowed_roles: ["user", "dealer"] })).toBe(true)
    expect(sameConfig({ enabled: true, allowed_roles: ["dealer"] }, { enabled: false, allowed_roles: ["dealer"] })).toBe(false)
    expect(sameConfig({ enabled: true, allowed_roles: ["dealer"] }, { enabled: true, allowed_roles: ["dealer", "user"] })).toBe(false)
    expect(sameConfig(null, null)).toBe(true)
    expect(sameConfig(null, { enabled: true, allowed_roles: [] })).toBe(false)
  })
})

describe("formatters", () => {
  it("never shows NaN or a fake zero for null", () => {
    expect(formatCount(null)).toBe("—")
    expect(formatCount(1234)).toBe("1,234")
    expect(formatPercent(null)).toBe("—")
    expect(formatPercent(99.5)).toBe("99.5%")
    expect(formatPercent(Number.NaN)).toBe("—")
    expect(formatLatency(null)).toBe("—")
    expect(formatLatency(240)).toBe("240 ms")
    expect(formatLatency(1530)).toBe("1.53 s")
  })
})
