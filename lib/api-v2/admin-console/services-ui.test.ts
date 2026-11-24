import { createElement } from "react"
import { describe, it, expect, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { ServicesTabView, ServicePauseForm, type ServiceCardData } from "@/components/admin/api-keys/ServicesTab"
import { AnnouncementsTabView, AnnouncementForm, draftToPublic } from "@/components/admin/api-keys/AnnouncementsTab"
import { AnnouncementBannerView } from "@/components/developer/AnnouncementBanner"
import { SERVICES } from "@/lib/api-v2/services"
import type { AdminAnnouncement } from "./announcements"

const noop = () => {}
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el)
const cards: ServiceCardData[] = SERVICES.map((s, i) => ({
  id: s.id, title: s.title, paused: i === 1, message: i === 1 ? "Supplier maintenance" : null, missing: false,
  state: i === 1 ? "paused" : i === 2 ? "degraded" : "operational", successRate24h: i === 6 ? null : 99,
}))

describe("ServicesTabView", () => {
  it("seven cards with state, the same 24 h rate as the public page, and the public message", () => {
    const out = html(createElement(ServicesTabView, { services: cards, loading: false, error: null, notice: null, busyId: null, onSave: async () => true, onRetry: noop }))
    for (const s of SERVICES) expect(out).toContain(s.title)
    expect(out).toContain("Supplier maintenance")
    expect(out).toContain("Paused")
    expect(out).toContain("Degraded")
    expect(out).toContain("99%")
    expect(out).toMatch(/Not enough traffic/)
    expect(out).toMatch(/Resume/)
    expect(out).toMatch(/lg:grid-cols-2/)
  })
  it("a missing controls row is flagged", () => {
    const out = html(createElement(ServicesTabView, { services: [{ ...cards[0], missing: true }], loading: false, error: null, notice: null, busyId: null, onSave: async () => true, onRetry: noop }))
    expect(out).toMatch(/no control row/i)
  })
})

describe("ServicePauseForm", () => {
  it("confirm states what stops; message has a 200 counter; over 200 disables submit", () => {
    const ok = html(createElement(ServicePauseForm, { title: "Airtime", pausing: true, message: "abc", busy: false, onMessage: noop, onSubmit: noop, onCancel: noop }))
    expect(ok).toContain("new purchases and sends stop, order lookups keep working")
    expect(ok).toContain("3/200")
    expect(ok).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Pause service/)
    const long = html(createElement(ServicePauseForm, { title: "Airtime", pausing: true, message: "x".repeat(201), busy: false, onMessage: noop, onSubmit: noop, onCancel: noop }))
    expect(long).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Pause service/)
  })
  it("resume: no message box; says the message is cleared", () => {
    const out = html(createElement(ServicePauseForm, { title: "Airtime", pausing: false, message: "", busy: false, onMessage: noop, onSubmit: noop, onCancel: noop }))
    expect(out).not.toContain("<textarea")
    expect(out).toMatch(/message is cleared/i)
  })
})

const item = (o: Partial<AdminAnnouncement>): AdminAnnouncement => ({ id: "a", title: "Maintenance", body: "Tonight", severity: "info", startsAt: "2026-11-24T00:00:00.000Z", endsAt: "2026-11-25T00:00:00.000Z", state: "active", ...o })

describe("AnnouncementsTabView", () => {
  it("lists announcements with active / scheduled / ended chips, plus edit and delete", () => {
    const out = html(
      createElement(AnnouncementsTabView, {
        items: [item({ id: "1" }), item({ id: "2", state: "scheduled" }), item({ id: "3", state: "ended" })],
        loading: false, error: null, notice: null, busy: false, onSave: async () => true, onDelete: async () => true, onRetry: noop,
      }),
    )
    for (const t of ["Active", "Scheduled", "Ended", "Edit", "Delete", "New announcement"]) expect(out).toContain(t)
  })
})

describe("AnnouncementForm", () => {
  const draft = { title: "Maintenance <b>", body: "Tonight 22:00-23:00", severity: "warning", startsAt: "2026-11-24T22:00", endsAt: "2026-11-24T23:00" }
  it("preview equals the public banner output", () => {
    const out = html(createElement(AnnouncementForm, { draft, busy: false, editing: false, onChange: noop, onSubmit: noop, onCancel: noop }))
    const banner = html(createElement(AnnouncementBannerView, { items: [draftToPublic(draft)], dismissed: [], onDismiss: noop }))
    expect(banner.length).toBeGreaterThan(0)
    expect(out).toContain(banner)
  })
  it("validation mirrors SQL: errors are listed and Save is disabled", () => {
    const out = html(createElement(AnnouncementForm, { draft: { ...draft, title: "x".repeat(81), endsAt: "2026-11-24T21:00" }, busy: false, editing: false, onChange: noop, onSubmit: noop, onCancel: noop }))
    expect(out).toContain("Title must be 1 to 80 characters.")
    expect(out).toContain("The end must be after the start.")
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Publish/)
    expect(out).toContain("81/80")
  })
})
