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

// ---- Task 11: Prices, Services, Rights, Members ----
import { PricesView } from "./_components/PricesTab"
import { ServicesView } from "./_components/ServicesTab"
import { RightsView } from "./_components/RightsTab"
import { MembersView } from "./_components/MembersTab"
import { SaveBar } from "./_components/SaveBar"
import type { PriceRow } from "./_lib/prices-grid"

const noop = () => {}
const prow = (id: string, over: Partial<PriceRow> = {}): PriceRow => ({
  id, network: "MTN", name: `Pkg ${id}`, price: 10, cost_price: 6, role_price: null, effective_price: 10, is_available: true, ...over,
})
const pricesProps = (over: Record<string, unknown> = {}) => ({
  editable: true, rows: [prow("a"), prow("b", { cost_price: null })], edits: {} as Record<string, string>,
  onEdit: noop, network: "all", onNetwork: noop, lossOk: false, onLossOk: noop, reason: "", onReason: noop, busy: false,
  highlight: new Set<string>(), bulkPercent: "", onBulkPercent: noop, bulkDelta: "", onBulkDelta: noop,
  bulkMessage: null as string | null, onApplyPercent: noop, onApplyDelta: noop,
  copyRoles: [] as { id: string; name: string }[], copyFrom: "", onCopyFrom: noop, onLoadCopy: noop, copyNote: null as string | null,
  onSave: noop, onDiscard: noop, ...over,
})
// The button class list contains "disabled:" variants, so match the attribute after the marker.
const savedisabled = (html: string) => /data-save="true"[^>]*disabled=""/.test(html)
const renderPrices = (over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(PricesView, pricesProps(over) as never))

describe("PricesTab", () => {
  it("Save is disabled when nothing is edited", () => {
    expect(savedisabled(renderPrices({ reason: "because" }))).toBe(true)
  })
  it("Save is disabled while a below-cost row is dirty and the loss box is unticked, enabled once ticked", () => {
    const edits = { a: "5" }
    const blocked = renderPrices({ edits, reason: "because" })
    expect(savedisabled(blocked)).toBe(true)
    expect(blocked).toContain("data-below-cost")
    expect(savedisabled(renderPrices({ edits, reason: "because", lossOk: true }))).toBe(false)
  })
  it("a null cost shows a dash and no margin, and never blocks", () => {
    const html = renderPrices({ edits: { b: "1" }, reason: "because" })
    expect(savedisabled(html)).toBe(false)
    expect(html).toContain('data-cost="—"')
  })
  it("highlights ids the server rejected as below cost", () => {
    expect(renderPrices({ highlight: new Set(["a"]) })).toContain("data-below-cost")
  })
  it("read-only roles get no inputs and a note", () => {
    const html = renderPrices({ editable: false })
    expect(html).not.toContain("<input")
    expect(html).toContain("read-only")
  })
})

describe("ServicesTab", () => {
  const rates = [
    { service_key: "airtime_fee:mtn", label: "MTN airtime fee", value: null, effective: 2 },
    { service_key: "cashback_share:bills", label: "Bills cashback share", value: null, effective: 1 },
  ]
  const sprops = (over: Record<string, unknown> = {}) => ({
    editable: true, rates, edits: {}, onEdit: noop, reason: "", onReason: noop, busy: false, onSave: noop, onDiscard: noop, ...over,
  })
  it("is read-only for system roles with links to the real settings pages", () => {
    const html = renderToStaticMarkup(createElement(ServicesView, sprops({ editable: false }) as never))
    expect(html).not.toContain("<input")
    expect(html).toContain('href="/admin/airtime/settings"')
    expect(html).toContain('href="/admin/hubtel-commission?tab=cashback"')
    expect(html).toContain("MTN airtime fee")
  })
  it("custom roles get one input per service key", () => {
    const html = renderToStaticMarkup(createElement(ServicesView, sprops() as never))
    expect((html.match(/data-rate-input/g) ?? []).length).toBe(2)
  })
})

describe("RightsTab", () => {
  it("lists grouped checkboxes with hints and is read-only when not editable", () => {
    const base = { caps: ["buy.data"], onToggle: noop, reason: "", onReason: noop, busy: false, onSave: noop, onDiscard: noop, dirty: false, copyRoles: [], copyFrom: "", onCopyFrom: noop, onLoadCopy: noop }
    const editable = renderToStaticMarkup(createElement(RightsView, { ...base, editable: true } as never))
    expect(editable).toContain("Buy data bundles")
    expect(editable).toContain("Most purchases are paid from the wallet.")
    expect((editable.match(/type="checkbox"/g) ?? []).length).toBe(14)
    const ro = renderToStaticMarkup(createElement(RightsView, { ...base, editable: false } as never))
    expect(ro).not.toContain('type="checkbox"')
  })
})

describe("MembersTab", () => {
  const props = (over: Record<string, unknown> = {}) => ({
    roles: ROLES, currentRoleId: "id-gold", members: [{ id: "u1", name: "Ama", email: "a@x.test", phone: "0240000000" }],
    total: 1, page: 1, q: "", onQ: noop, onSearch: noop, onPage: noop, selected: new Set<string>(), onToggle: noop,
    onSelectPage: noop, onSelectAll: noop, onClear: noop, selectNote: null, target: "", onTarget: noop, reason: "", onReason: noop,
    busy: false, loading: false, tally: null, results: [], onMove: noop, error: null, ...over,
  })
  it("target list excludes admin, sub_agent, archived and the current role", () => {
    const html = renderToStaticMarkup(createElement(MembersView, props() as never))
    expect(html).toContain('value="user"')
    expect(html).toContain('value="dealer"')
    expect(html).toContain('value="silver"')
    for (const s of ["admin", "sub_agent", "old", "gold"]) expect(html).not.toContain(`<option value="${s}"`)
  })
  it("Move is disabled with no selection, target or reason", () => {
    const html = renderToStaticMarkup(createElement(MembersView, props() as never))
    expect(/data-move-go="true"[^>]*disabled=""/.test(html)).toBe(true)
    const ready = renderToStaticMarkup(
      createElement(MembersView, props({ selected: new Set(["u1"]), target: "user", reason: "downgrade" }) as never),
    )
    expect(/data-move-go="true"[^>]*disabled=""/.test(ready)).toBe(false)
  })
  it("shows per-user results with reasons, including the not-assignable-yet 409 rows", () => {
    const html = renderToStaticMarkup(
      createElement(MembersView, props({
        tally: { moved: 0, skipped: 0, errors: 1 },
        results: [{ user_id: "u1", status: "error", reason: "Custom roles can't be assigned yet." }],
      }) as never),
    )
    expect(html).toContain("moved 0, skipped 0, errors 1")
    expect(html).toContain("Custom roles can&#x27;t be assigned yet.")
  })
})

describe("SaveBar", () => {
  it("disables Save when canSave is false and shows the reason hint", () => {
    const html = renderToStaticMarkup(
      createElement(SaveBar, { reason: "", onReason: noop, canSave: false, why: "Add a reason (3+ characters)", busy: false, dirty: true, onSave: noop, onDiscard: noop }),
    )
    expect(savedisabled(html)).toBe(true)
    expect(html).toContain("Add a reason")
  })
})
