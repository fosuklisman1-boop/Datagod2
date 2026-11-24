import { createElement } from "react"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { DevelopersListView } from "@/components/admin/api-keys/DevelopersTab"
import { DeveloperProfileView, PauseForm } from "@/components/admin/api-keys/DeveloperProfile"
import type { DeveloperProfile, DeveloperRow } from "./developers"

const UID = "11111111-1111-4111-8111-111111111111"
const noop = () => {}
const row = (o: Partial<DeveloperRow> = {}): DeveloperRow => ({
  userId: UID, name: "Ama Mensah", email: "ama@x.com", role: "dealer", keysActive: 2, keysPending: 1, requests: 120, ok: 118, failed: 2,
  successRate: 98.3, spent: 450.5, orders: 40, lastUsedAt: "2026-11-23T10:00:00Z", granted: false, paused: false, ...o,
})
const profile = (o: Partial<DeveloperProfile> = {}): DeveloperProfile => ({
  user: { id: UID, name: "Ama Mensah", email: "ama@x.com", role: "dealer", suspended: false },
  totals: { requests: 120, ok: 118, failed: 2, successRate: 98.3, spent: 450.5, orders: 40, pending: 1 },
  daily: [{ day: "2026-11-23", requests: 10, ok: 10, failed: 0, revenue: 30 }],
  keys: [{ id: "k1", keyType: "standard", environment: "live", status: "active", name: "Main", keyPrefix: "dg_live_ab", createdAt: "2026-11-01", lastUsedAt: null, activity: { requests: 5 } }],
  orders: [{ reference: "REF-1", network: "MTN", volumeGb: 2, price: 10, status: "completed", createdAt: "2026-11-23T09:00:00Z", recipientPhone: "******4567" }],
  grant: { grantedAt: "2026-11-20T00:00:00Z", grantedBy: "admin" },
  pause: null,
  audit: [],
  ...o,
})
const listProps = { items: [row()], total: 1, page: 0, pageSize: 25, q: "", loading: false, error: null, selected: null, onQuery: noop, onPage: noop, onSelect: noop, onRetry: noop }
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)

describe("DevelopersListView", () => {
  it("rows show name, email, calls, success and spend; PAUSED and grant badges render with text", () => {
    const out = html(createElement(DevelopersListView, { ...listProps, items: [row({ paused: true, granted: true })] }))
    expect(out).toContain("Ama Mensah")
    expect(out).toContain("ama@x.com")
    expect(out).toContain("PAUSED")
    expect(out).toContain("API access granted")
    expect(out).toContain("98.3%")
    expect(out).toContain("GHS 450.50")
  })
  it("paging shows the range and disables Previous on the first page", () => {
    const out = html(createElement(DevelopersListView, { ...listProps, total: 60 }))
    expect(out).toContain("1-25 of 60")
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Previous/)
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Next/)
  })
  it("error shows InlineError with Retry; empty shows a friendly line", () => {
    expect(html(createElement(DevelopersListView, { ...listProps, items: [], total: 0, error: "Not set up yet" }))).toContain("Retry")
    expect(html(createElement(DevelopersListView, { ...listProps, items: [], total: 0 }))).toMatch(/No developers/)
  })
  it("a developer name containing <script> renders as text", () => {
    const out = html(createElement(DevelopersListView, { ...listProps, items: [row({ name: "<script>alert(1)</script>" })] }))
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })
})

describe("DeveloperProfileView", () => {
  const base = { profile: profile(), loading: false, error: null, notice: null, busy: false, onPause: async () => true, onBack: noop, onRetry: noop }
  it("shows 30-day calls, success rate, spend, orders, keys with activity, recent orders with masked phones, grant status", () => {
    const out = html(createElement(DeveloperProfileView, base))
    for (const t of ["120", "98.3%", "GHS 450.50", "40", "dg_live_ab", "REF-1", "******4567", "API access granted"]) expect(out).toContain(t)
    expect(out).toContain("Back")
  })
  it("paused state shows who, when and why, and the switch offers Unpause", () => {
    const out = html(createElement(DeveloperProfileView, { ...base, profile: profile({ pause: { pausedAt: "2026-11-23T08:00:00Z", pausedBy: "aaaaaaaa", reason: "Card testing pattern" } }) }))
    expect(out).toContain("Card testing pattern")
    expect(out).toContain("PAUSED")
    expect(out).toMatch(/Unpause/)
  })
  it("a route error is shown, not swallowed", () => {
    const out = html(createElement(DeveloperProfileView, { ...base, notice: { kind: "error", text: "Developer not found." } }))
    expect(out).toContain("Developer not found.")
    expect(out).toContain('role="alert"')
  })
  it("name with <script> renders as text", () => {
    const out = html(createElement(DeveloperProfileView, { ...base, profile: profile({ user: { id: UID, name: "<script>x</script>", email: null, role: null, suspended: false } }) }))
    expect(out).not.toContain("<script>")
  })
})

describe("PauseForm", () => {
  it("names the effect and disables submit until the reason is 3-200 characters", () => {
    const empty = html(createElement(PauseForm, { paused: true, reason: "ab", busy: false, onReason: noop, onSubmit: noop, onCancel: noop }))
    expect(empty).toMatch(/blocks every v2 key for this person/i)
    expect(empty).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Pause access/)
    const ok = html(createElement(PauseForm, { paused: true, reason: "Fraud pattern", busy: false, onReason: noop, onSubmit: noop, onCancel: noop }))
    expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Pause access/)
  })
  it("busy prevents double submit; unpause needs no reason", () => {
    const busy = html(createElement(PauseForm, { paused: true, reason: "Fraud pattern", busy: true, onReason: noop, onSubmit: noop, onCancel: noop }))
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Pause access/)
    const un = html(createElement(PauseForm, { paused: false, reason: "", busy: false, onReason: noop, onSubmit: noop, onCancel: noop }))
    expect(un).not.toContain("<textarea")
    expect(un).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Unpause/)
  })
})
