import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALL_CAPABILITIES, CAPABILITIES, CAPABILITY_GROUPS, isCapability, rightsFor, canWith, type Capability,
} from "./capabilities"
import type { RoleRow } from "./ladder"

const role = (id: string, slug: string, archived = false): RoleRow => ({
  id, slug, rank: null, is_system: false, archived_at: archived ? "2026-01-01T00:00:00Z" : null,
})

describe("capability registry", () => {
  it("ALL_CAPABILITIES equals the 0187 seed list", () => {
    const sql = readFileSync(join(__dirname, "../../migrations/0187_roles_hub.sql"), "utf8")
    const start = sql.indexOf("INSERT INTO public.role_permissions")
    const block = sql.slice(start, sql.indexOf("]) AS c(cap)", start))
    const seeded = [...block.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1])
    expect(seeded.length).toBe(14)
    expect([...ALL_CAPABILITIES].sort()).toEqual([...seeded].sort())
  })

  it("every capability is registered once, in a known group, and isCapability agrees", () => {
    const groups = new Set(CAPABILITY_GROUPS.map((g) => g.id))
    expect(CAPABILITIES.map((c) => c.key).sort()).toEqual([...ALL_CAPABILITIES].sort())
    for (const c of CAPABILITIES) {
      expect(groups.has(c.group)).toBe(true)
      expect(c.key.startsWith(c.group + ".")).toBe(true)
      expect(isCapability(c.key)).toBe(true)
    }
    expect(isCapability("buy.nope")).toBe(false)
    expect(isCapability(42)).toBe(false)
    expect(CAPABILITIES.find((c) => c.key === "account.wallet")?.hint).toBe("Most purchases are paid from the wallet.")
  })
})

describe("rightsFor / canWith", () => {
  const roles = [role("r-user", "user"), role("r-old", "old", true), role("r-c", "custom")]
  const perms = new Map<string, ReadonlySet<Capability>>([
    ["r-user", new Set(ALL_CAPABILITIES)],
    ["r-old", new Set<Capability>(["buy.data"])],
    ["r-c", new Set<Capability>(["buy.data"])],
  ])

  it("rightsFor: null slug is user; archived and unknown roles get the empty set; admin all; sub_agent sub_agent", () => {
    const u = rightsFor(null, roles, perms)
    expect(u.kind === "set" && u.caps.size).toBe(14)
    expect(rightsFor("admin", roles, perms)).toEqual({ kind: "all" })
    expect(rightsFor("sub_agent", roles, perms)).toEqual({ kind: "sub_agent" })
    const arch = rightsFor("old", roles, perms)
    expect(arch.kind === "set" && arch.caps.size).toBe(0)
    const unk = rightsFor("ghost", roles, perms)
    expect(unk.kind === "set" && unk.caps.size).toBe(0)
    const c = rightsFor("custom", roles, perms)
    expect(c.kind === "set" && [...c.caps]).toEqual(["buy.data"])
  })

  it("rightsFor: a live role with no permission rows gets the empty set", () => {
    const r = rightsFor("custom", roles, new Map())
    expect(r.kind === "set" && r.caps.size).toBe(0)
  })

  it("canWith: all and sub_agent pass, set checks membership", () => {
    expect(canWith({ kind: "all" }, "buy.data")).toBe(true)
    expect(canWith({ kind: "sub_agent" }, "buy.data")).toBe(true)
    expect(canWith({ kind: "set", caps: new Set<Capability>(["buy.data"]) }, "buy.data")).toBe(true)
    expect(canWith({ kind: "set", caps: new Set<Capability>() }, "buy.data")).toBe(false)
  })
})
