// Static-render tests for the roles hub (no jsdom in this repo; same approach as the other admin render tests).
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RoleList } from "./_components/RoleList"
import { RoleBadge } from "./_components/RoleBadge"
import { validateCreateRoleForm, defaultNewRank } from "./_lib/create-form"
import { ladderState, type HubRole } from "./_lib/ladder-view"

const mk = (over: Partial<HubRole> & { slug: string }): HubRole => ({
  id: `id-${over.slug}`,
  name: over.slug,
  description: null,
  badge_color: "navy",
  icon: "Star",
  rank: null,
  is_system: false,
  archived_at: null,
  theme: { skin: "default" },
  member_count: 0,
  priced_count: 0,
  ...over,
})

const ROLES: HubRole[] = [
  mk({ slug: "admin", name: "Admin", rank: 100, is_system: true }),
  mk({ slug: "dealer", name: "Dealer", rank: 50, is_system: true }),
  mk({ slug: "gold", name: "Gold", rank: 30 }),
  mk({ slug: "silver", name: "Silver", rank: 20 }),
  mk({ slug: "user", name: "User", rank: 1, is_system: true }),
  mk({ slug: "sub_agent", name: "Sub agent", rank: null, is_system: true }),
  mk({ slug: "old", name: "Old", rank: 5, archived_at: "2026-01-01" }),
]

const render = () =>
  renderToStaticMarkup(
    createElement(RoleList, { roles: ROLES, busy: false, onMove: () => {}, onClone: () => {} }),
  )

/** The markup of one role row, found by its data attribute. */
const row = (html: string, slug: string) => {
  const start = html.indexOf(`data-role-row="${slug}"`)
  expect(start, `row ${slug}`).toBeGreaterThan(-1)
  const next = html.indexOf("data-role-row=", start + 10)
  return html.slice(start, next === -1 ? undefined : next)
}

describe("RoleList", () => {
  it("admin row is read-only: no edit link", () => {
    const admin = row(render(), "admin")
    expect(admin).not.toContain("/admin/roles/id-admin")
  })
  it("non-admin rows link to the editor", () => {
    expect(row(render(), "gold")).toContain('href="/admin/roles/id-gold"')
  })
  it("user, admin and sub_agent have no move arrows; gold and silver do", () => {
    const html = render()
    for (const s of ["user", "admin", "sub_agent"]) expect(row(html, s)).not.toContain("data-move=")
    expect(row(html, "gold")).toContain('data-move="up"')
    expect(row(html, "gold")).toContain('data-move="down"')
  })
  it("ends of the ladder are disabled", () => {
    const html = render()
    // dealer is the top movable role, silver the bottom one.
    expect(row(html, "dealer")).toMatch(/data-move="up"[^>]*disabled/)
    expect(row(html, "silver")).toMatch(/data-move="down"[^>]*disabled/)
    expect(row(html, "gold")).not.toMatch(/data-move="up"[^>]*disabled/)
  })
  it("admin cannot be cloned", () => {
    const html = render()
    expect(row(html, "admin")).not.toContain("data-clone")
    expect(row(html, "gold")).toContain("data-clone")
  })
  it("archived roles are listed separately from the ladder", () => {
    expect(render()).toContain('data-role-row="old"')
    expect(ladderState(ROLES).archived.map((r) => r.slug)).toEqual(["old"])
    expect(ladderState(ROLES).ladder.map((r) => r.slug)).toEqual(["admin", "dealer", "gold", "silver", "user"])
    expect(ladderState(ROLES).offLadder.map((r) => r.slug)).toEqual(["sub_agent"])
  })
})

describe("create dialog validation", () => {
  const form = (over: Record<string, unknown>) => ({
    slug: "platinum", name: "Platinum", rank: "40", cloneFrom: "", reason: "new tier", ...over,
  })
  it("rejects the reserved slug Admin", () => {
    const r = validateCreateRoleForm(form({ slug: "Admin" }), ROLES)
    expect(r.ok).toBe(false)
  })
  it("rejects a rank already in use and a short reason", () => {
    expect(validateCreateRoleForm(form({ rank: "30" }), ROLES).ok).toBe(false)
    expect(validateCreateRoleForm(form({ reason: "no" }), ROLES).ok).toBe(false)
  })
  it("accepts a valid clone and maps clone_from", () => {
    const r = validateCreateRoleForm(form({ cloneFrom: "gold" }), ROLES)
    expect(r).toEqual({
      ok: true,
      value: { slug: "platinum", name: "Platinum", rank: 40, clone_from: "gold", reason: "new tier" },
    })
  })
  it("defaults the rank to the highest live rank + 10, ignoring admin and sub_agent even when ranked", () => {
    // Fixture: admin has rank 100 and sub_agent a rank too; neither counts. Dealer (50) is the highest.
    const withSub = ROLES.map((r) => (r.slug === "sub_agent" ? { ...r, rank: 200 } : r))
    expect(defaultNewRank(withSub)).toBe(60)
    expect(defaultNewRank(ROLES.filter((r) => ["admin", "sub_agent"].includes(r.slug)))).toBe(10)
  })
})

describe("RoleBadge", () => {
  it("renders the name", () => {
    expect(renderToStaticMarkup(createElement(RoleBadge, { name: "Gold", color: "amber", icon: "Crown" }))).toContain("Gold")
  })
})
