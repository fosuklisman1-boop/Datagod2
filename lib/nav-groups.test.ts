import { describe, it, expect } from "vitest"
import {
  groupNavItems,
  findActiveHref,
  findActiveGroupId,
  isGroupOpen,
  openGroup,
  toggleGroup,
  parseGroupState,
} from "./nav-groups"

const GROUPS = [
  { id: "buy", label: "Buy" },
  { id: "money", label: "Money" },
  { id: "empty", label: "Nothing here" },
]

describe("groupNavItems", () => {
  it("puts ungrouped items first, then groups in definition order, dropping empty groups", () => {
    const items = [
      { href: "/m1", group: "money" },
      { href: "/home" },
      { href: "/b1", group: "buy" },
      { href: "/m2", group: "money" },
    ]
    const out = groupNavItems(items, GROUPS)
    expect(out.map(s => s.group?.id ?? null)).toEqual([null, "buy", "money"])
    expect(out[0].items.map(i => i.href)).toEqual(["/home"])
    expect(out[2].items.map(i => i.href)).toEqual(["/m1", "/m2"]) // keeps item order
  })

  it("treats an unknown group id as ungrouped rather than losing the link", () => {
    const out = groupNavItems([{ href: "/x", group: "typo" }], GROUPS)
    expect(out).toEqual([{ group: null, items: [{ href: "/x", group: "typo" }] }])
  })
})

describe("findActiveHref", () => {
  const hrefs = ["/admin", "/admin/settings", "/admin/settings/mtn", "/admin/airtime"]
  it("prefers the longest matching href", () => {
    expect(findActiveHref("/admin/settings/mtn", hrefs)).toBe("/admin/settings/mtn")
    expect(findActiveHref("/admin/settings", hrefs)).toBe("/admin/settings")
  })
  it("matches sub-routes on a path boundary only", () => {
    expect(findActiveHref("/admin/airtime/123", hrefs)).toBe("/admin/airtime")
    expect(findActiveHref("/admin/airtimex", hrefs)).toBe("/admin")
  })
  it("returns null when nothing matches", () => {
    expect(findActiveHref("/dashboard", hrefs)).toBeNull()
  })
})

describe("findActiveGroupId", () => {
  it("returns the group of the best-matching item", () => {
    const items = [
      { href: "/admin", group: "overview" },
      { href: "/admin/settings", group: "system" },
      { href: "/admin/settings/mtn", group: "mtn" },
    ]
    expect(findActiveGroupId("/admin/settings/mtn", items)).toBe("mtn")
    expect(findActiveGroupId("/admin/unlisted-page", items)).toBe("overview")
    expect(findActiveGroupId("/elsewhere", items)).toBeNull()
  })
})

describe("group open state", () => {
  it("falls back to the default when the user never touched the group", () => {
    expect(isGroupOpen({}, "buy", true)).toBe(true)
    expect(isGroupOpen({}, "buy", false)).toBe(false)
  })
  it("an explicit user choice beats the default", () => {
    expect(isGroupOpen({ buy: false }, "buy", true)).toBe(false)
    expect(isGroupOpen({ buy: true }, "buy", false)).toBe(true)
  })
  it("toggleGroup flips the effective state and never mutates the input", () => {
    const s = {}
    const next = toggleGroup(s, "buy", true)
    expect(next).toEqual({ buy: false })
    expect(s).toEqual({})
    expect(toggleGroup(next, "buy", true)).toEqual({ buy: true })
  })
  it("openGroup opens the active group and returns the same object when nothing changes", () => {
    const s = { buy: true }
    expect(openGroup(s, "buy")).toBe(s)
    expect(openGroup({ buy: false }, "buy")).toEqual({ buy: true })
    expect(openGroup(s, null)).toBe(s)
  })
})

describe("parseGroupState", () => {
  it("keeps only boolean entries", () => {
    expect(parseGroupState('{"buy":true,"money":false,"x":1,"y":"true"}')).toEqual({ buy: true, money: false })
  })
  it("returns {} for missing or garbage storage", () => {
    expect(parseGroupState(null)).toEqual({})
    expect(parseGroupState("not json")).toEqual({})
    expect(parseGroupState("[true]")).toEqual({})
    expect(parseGroupState("null")).toEqual({})
  })
})
