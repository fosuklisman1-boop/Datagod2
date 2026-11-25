import { createElement } from "react"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import {
  MoneyProtectionCardView, DeveloperMoneyView, THRESHOLD_FIELDS, switchConfirmCopy, type MoneySettingsView, type DeveloperSpendView,
} from "@/components/admin/api-keys/MoneyProtection"
import { THRESHOLD_KEYS } from "./money"

const noop = () => {}
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const settings: MoneySettingsView = {
  capsEnabled: false, alertsEnabled: true, alertsToday: 3, updatedAt: null,
  thresholds: { spike_multiplier: 3, spike_min_ghs: 200, new_key_hours: 24, new_key_min_ghs: 100, fanout_recipients: 30, fanout_minutes: 10, cap_hits: 3, cap_hits_minutes: 60, failure_min_orders: 20, failure_ratio: 0.5, failure_minutes: 15 },
}
const card = (p: Partial<Parameters<typeof MoneyProtectionCardView>[0]> = {}) =>
  html(createElement(MoneyProtectionCardView, { settings, loading: false, error: null, notice: null, busy: false, onToggle: async () => true, onSaveThresholds: async () => true, onRetry: noop, ...p }))

describe("MoneyProtectionCardView", () => {
  it("switches render as words (On / Off), with today's alert count", () => {
    const out = card()
    expect(out).toContain("Money protection")
    expect(out).toMatch(/Daily spending limits[\s\S]*Off/)
    expect(out).toMatch(/Fraud warnings[\s\S]*On/)
    expect(out).toContain("3 alerts today")
  })
  it("a thresholds editor with one field per SQL key, holding the current values", () => {
    expect(THRESHOLD_FIELDS.map((f) => f.key).sort()).toEqual([...THRESHOLD_KEYS].sort())
    const out = card()
    expect((out.match(/<input/g) ?? []).length).toBe(11)
    expect(out).toContain('value="0.5"')
    expect(out).toMatch(/Save thresholds/)
  })
  it("loading, error with retry, and a notice", () => {
    expect(card({ settings: null, loading: true })).toMatch(/Loading/)
    expect(card({ settings: null, error: "Money protection is not set up yet" })).toContain("Money protection is not set up yet")
    expect(card({ notice: { kind: "ok", text: "Saved." } })).toContain("Saved.")
  })
})

describe("switchConfirmCopy", () => {
  it("switching caps on says what changes for developers: over-limit purchases get 402 and nothing is charged", () => {
    const c = switchConfirmCopy("caps", true)
    expect(c.body).toMatch(/402/)
    expect(c.body).toMatch(/nothing is charged/i)
    expect(c.body).toMatch(/without a limit/i)
    expect(switchConfirmCopy("caps", false).body).toMatch(/stay saved/i)
  })
  it("switching alerts on says admins get messages and nothing is blocked", () => {
    const c = switchConfirmCopy("alerts", true)
    expect(c.body).toMatch(/every 5 minutes/i)
    expect(c.body).toMatch(/nothing is blocked/i)
    expect(switchConfirmCopy("alerts", false).body).toMatch(/no new alerts/i)
  })
})

describe("DeveloperMoneyView", () => {
  const spend: DeveloperSpendView = {
    today: 12, userCap: 50, refusalsToday: 2,
    keys: [{ keyId: "k1", spent: 7.5, cap: 30 }, { keyId: "k2", spent: 4.5, cap: null }],
    alerts: [{ signal: "recipient_fanout", createdAt: "2026-11-25T09:00:00Z", details: { recipients: 41 } }],
  }
  const view = (p: Partial<Parameters<typeof DeveloperMoneyView>[0]> = {}) =>
    html(createElement(DeveloperMoneyView, {
      spend, keyLabels: { k1: "standard dg2_live_ab", k2: "bulk dg2_live_cd" }, capsEnabled: true, value: "50", busy: false, error: null, notice: null,
      loading: false, onChange: noop, onSave: noop, onRetry: noop, ...p,
    }))
  it("today's spend against the admin limit and each key's own limit, refusals today", () => {
    const out = view()
    expect(out).toContain("Spent today: GHS 12.00")
    expect(out).toContain("Datagod limit (GHS)")
    expect(out).toContain('value="50"')
    expect(out).toMatch(/standard dg2_live_ab[\s\S]*GHS 7.50[\s\S]*GHS 30.00/)
    expect(out).toMatch(/bulk dg2_live_cd[\s\S]*No limit/)
    expect(out).toMatch(/Refused today[\s\S]*2/)
  })
  it("recent alerts show the signal in words, the time and numbers only", () => {
    const out = view()
    expect(out).toContain("Many recipients")
    expect(out).toContain("recipients: 41")
    expect(out).not.toContain("recipient_fanout")
  })
  it("says when limits are not active yet; no alerts; errors", () => {
    expect(view({ capsEnabled: false })).toMatch(/Not active yet/)
    expect(view({ spend: { ...spend, alerts: [] } })).toMatch(/No alerts/)
    expect(view({ error: "The limit must be an amount" })).toContain("The limit must be an amount")
  })
})
