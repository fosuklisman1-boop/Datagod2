import { createElement } from "react"
import { readFileSync } from "node:fs"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import type { ConsoleKey } from "@/lib/api-v2/admin-view"
import { ConsoleTabBar } from "@/components/admin/api-keys/ConsoleTabBar"
import { OverviewTabView } from "@/components/admin/api-keys/OverviewTab"
import { LegacyTab } from "@/components/admin/api-keys/LegacyTab"
import { KeyList } from "@/components/admin/api-keys/KeyList"
import { TrendBarsView } from "@/components/admin/api-keys/TrendBars"

const key = (o: Partial<ConsoleKey>): ConsoleKey => ({
  id: "k", source: "v2", ownerName: "Ama Mensah", ownerEmail: "ama@x.com", ownerRole: "dealer", ownerPhone: null,
  prefix: "dg_live_aa", status: "active", keyType: "standard", environment: "live", requests24h: 3, lastUsedAt: null,
  rateLimits: null, v1RatePerMin: null, createdAt: "2026-11-01T00:00:00Z", ...o,
})
const keys = [key({ id: "v2a", prefix: "dg_live_v2a" }), key({ id: "v1a", source: "v1", prefix: "dgk_v1aa", keyType: null })]
const noop = () => {}
const handlers = { approve: noop, revoke: noop, saveLimits: async () => true, resetLimits: noop, v1Toggle: noop, v1Delete: noop, v1SetRate: noop } as never
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)

describe("ConsoleTabBar", () => {
  it("nine tabs in order with the Legacy end date; approval and pending-key badges kept", () => {
    const out = html(createElement(ConsoleTabBar, { value: "overview", onChange: noop, approvals: 3, pendingKeys: 2 }))
    const labels = [...out.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""))
    expect(labels.map((l) => l.replace(/\d+$/, "").trim())).toEqual([
      "Overview", "Approvals", "Developers", "Keys", "Logs", "Services and status", "Announcements", "Report", "Legacy v1 (ends 30 Nov 2026)",
    ])
    expect(labels[1]).toContain("3")
    expect(labels[3]).toContain("2")
    expect(out).toMatch(/flex-wrap/)
  })
})

describe("OverviewTabView", () => {
  const base = {
    keys, stats: null, config: { enabled: true, allowed_roles: ["dealer"] }, roles: null,
    errors: { v1: null, v2: null, stats: null, config: null }, loading: false,
    onRetry: noop, saveConfig: async () => true, globalKill: async () => {},
  }
  it("renders OverviewTiles, the trend, FeatureControls and StuckV2Panel; Global Kill labelled irreversible, distinct from pauses", () => {
    const out = html(createElement(OverviewTabView, { ...base, trend: { points: [{ day: "2026-11-23", requests: 10, ok: 9, failed: 1, revenue: 5 }], loading: false, error: null }, onTrendRetry: noop }))
    expect(out).toContain("30-day trend")
    expect(out).toContain("Global Kill")
    expect(out).toContain("Stuck v2 work")
    expect(out).toMatch(/Irreversible/)
    expect(out).toMatch(/revoke nothing/i)
    expect(out).toMatch(/lg:grid-cols-2/)
  })
  it("failed trend source shows InlineError with Retry, other panels still render", () => {
    const out = html(createElement(OverviewTabView, { ...base, trend: { points: [], loading: false, error: "Not set up yet" }, onTrendRetry: noop }))
    expect(out).toContain('role="alert"')
    expect(out).toContain("Retry")
    expect(out).toContain("Global Kill")
    expect(out).toContain("Stuck v2 work")
  })
})

describe("Legacy and Keys split", () => {
  it("Legacy renders the v1 retirement card and only v1 keys", () => {
    const out = html(createElement(LegacyTab, { keys, busy: {}, handlers, loading: false, sourceErrors: [], onRetry: noop }))
    expect(out).toContain("Legacy API v1, ends 30 Nov 2026")
    expect(out).toContain("dgk_v1aa")
    expect(out).not.toContain("dg_live_v2a")
  })
  it("Keys tab (source v2) shows no v1 keys", () => {
    const out = html(createElement(KeyList, { keys, source: "v2", busy: {}, handlers, loading: false, sourceErrors: [], onRetry: noop }))
    expect(out).toContain("dg_live_v2a")
    expect(out).not.toContain("dgk_v1aa")
  })
})

describe("TrendBarsView", () => {
  it("empty -> a friendly empty state, never a broken chart", () => {
    const out = html(createElement(TrendBarsView, { points: [], loading: false, error: null, onRetry: noop }))
    expect(out).toMatch(/No API traffic/)
    expect(out).not.toContain("<rect")
  })
  it("draws one bar group per day with an accessible label", () => {
    const out = html(createElement(TrendBarsView, { points: [{ day: "2026-11-23", requests: 10, ok: 9, failed: 1, revenue: 5 }], loading: false, error: null, onRetry: noop }))
    expect(out).toContain("<svg")
    expect(out).toContain("2026-11-23: 10 requests, 1 failed")
  })
})

describe("lazy loading", () => {
  it("the shell fetch does not request developers, report, services or announcements", () => {
    const src = readFileSync("components/admin/api-keys/use-console-data.ts", "utf8")
    for (const p of ["/developers", "/report", "/services", "/announcements", "/trend"]) expect(src).not.toContain(`/api/admin/api-v2${p}`)
  })
})
