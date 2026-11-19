import { describe, expect, it } from "vitest"
import { parseRoleResponse, EMPTY_RIGHTS, shouldRedirectUnavailable, skinFor } from "./client-rights"
import { menuItems } from "../dashboard-nav-items"

const loaded = (slug: string, rights: any) => ({ status: "ok" as const, slug, rights: parseRoleResponse({ slug, rights, theme: { skin: "default" } })!.rights })

describe("parseRoleResponse", () => {
  it("maps all, sub_agent and capability lists; drops unknown strings", () => {
    expect(parseRoleResponse({ slug: "admin", rights: "all", theme: { skin: "default" } })!.rights).toEqual({ kind: "all" })
    expect(parseRoleResponse({ slug: "sub_agent", rights: "sub_agent", theme: { skin: "default" } })!.rights).toEqual({ kind: "sub_agent" })
    const r = parseRoleResponse({ slug: "x", rights: ["buy.data", "bogus"], theme: { skin: "dealer" } })!
    expect(r.rights.kind === "set" && [...r.rights.caps]).toEqual(["buy.data"])
    expect(r.skin).toBe("dealer")
  })
  it("returns null for malformed bodies", () => {
    expect(parseRoleResponse(null)).toBeNull()
    expect(parseRoleResponse({ slug: 3 })).toBeNull()
    expect(parseRoleResponse({ slug: "x", rights: 5 })).toBeNull()
  })
})

describe("skinFor", () => {
  it("admin wins, else the role's skin, else default", () => {
    expect(skinFor(true, "dealer")).toBe("admin")
    expect(skinFor(false, "dealer")).toBe("dealer")
    expect(skinFor(false, null)).toBe("default")
  })
})

describe("shouldRedirectUnavailable", () => {
  const airtimeOnly = loaded("custom", ["buy.airtime"])
  it("redirects a /dashboard page whose nav item is hidden", () => {
    expect(shouldRedirectUnavailable("/dashboard/data-packages", airtimeOnly, false)).toBe(true)
  })
  it("does not redirect a visible page, an unknown path or /dashboard/unavailable", () => {
    expect(shouldRedirectUnavailable("/dashboard/airtime", airtimeOnly, false)).toBe(false)
    expect(shouldRedirectUnavailable("/dashboard/some-detail-page", airtimeOnly, false)).toBe(false)
    expect(shouldRedirectUnavailable("/dashboard/unavailable", airtimeOnly, false)).toBe(false)
  })
  it("never redirects while loading, after an error, or for admins", () => {
    expect(shouldRedirectUnavailable("/dashboard/data-packages", { status: "loading", slug: null, rights: EMPTY_RIGHTS }, false)).toBe(false)
    expect(shouldRedirectUnavailable("/dashboard/data-packages", { status: "error", slug: null, rights: EMPTY_RIGHTS }, false)).toBe(false)
    expect(shouldRedirectUnavailable("/dashboard/data-packages", airtimeOnly, true)).toBe(false)
  })
  it("matches sub-paths of a nav item", () => {
    expect(shouldRedirectUnavailable("/dashboard/data-packages/x", airtimeOnly, false)).toBe(true)
  })
  it("only considers real menu items", () => {
    expect(menuItems.some((i) => i.href === "/dashboard/airtime")).toBe(true)
  })
})
