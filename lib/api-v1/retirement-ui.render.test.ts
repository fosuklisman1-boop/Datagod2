// Lives here, not beside the components: vitest only collects tests under lib/ and app/.
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { V1RetirementBanner } from "@/components/developer/V1RetirementBanner"
import { V1RetirementCardView, type RetirementData } from "@/components/admin/api-keys/V1RetirementCard"
import { StuckV2PanelView } from "@/components/admin/api-keys/StuckV2Panel"

const SUNSET = "2026-11-26T00:00:00.000Z"

describe("V1RetirementBanner", () => {
  const render = (p: { sunsetAt: string | null; exempt: boolean; hasActiveKey: boolean }) =>
    renderToStaticMarkup(createElement(V1RetirementBanner, p))

  it("non-exempt text with a docs link", () => {
    const html = render({ sunsetAt: SUNSET, exempt: false, hasActiveKey: true })
    expect(html).toContain("API v1 will be retired on 26 Nov 2026, 00:00 GMT. After that your v1 requests will be refused. Create a v2 key below and follow the v2 docs.")
    expect(html).toContain('href="/developers"')
    expect(html).toContain('data-variant="notice"')
  })
  it("exempt text", () => {
    const html = render({ sunsetAt: SUNSET, exempt: true, hasActiveKey: true })
    expect(html).toContain("API v1 retires on 26 Nov 2026, 00:00 GMT. Your access continues for now; please plan your move to v2.")
    expect(html).toContain('data-variant="exempt"')
  })
  it("renders nothing without a sunset or an active key", () => {
    expect(render({ sunsetAt: null, exempt: false, hasActiveKey: true })).toBe("")
    expect(render({ sunsetAt: SUNSET, exempt: false, hasActiveKey: false })).toBe("")
  })
})

describe("V1RetirementCardView", () => {
  const data: RetirementData = {
    sunset_at: SUNSET,
    notice_sent_at: "2026-11-12T10:00:00.000Z",
    updated_at: "2026-11-12T08:00:00.123456+00:00",
    exempt_users: [{ id: "3f2b8c1e-9a4d-4e6b-8c1d-2a3b4c5d6e7f", email: "big@example.com", phone: null, first_name: "Big" }],
    stragglers: [
      { user_id: "u1", email: "a@example.com", last_call: "2026-11-11T08:00:00.000Z", calls_7d: 120, orders_7d: 9, exempt: false },
      { user_id: "u2", email: "b@example.com", last_call: null, calls_7d: 3, orders_7d: 0, exempt: true },
    ],
  }
  const render = (over: Partial<Parameters<typeof V1RetirementCardView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(V1RetirementCardView, {
        data, busy: false, error: null, resendSentAt: null, notifyResult: null,
        now: new Date("2026-11-12T12:00:00.000Z"), onSave: async () => {}, onNotify: async () => {}, ...over,
      })
    )

  it("shows the date in GMT, picker value, exempt users, stragglers and actions", () => {
    const html = render()
    expect(html).toContain("26 Nov 2026, 00:00 GMT")
    expect(html).toContain('value="2026-11-26T00:00"')
    expect(html).toContain("big@example.com")
    expect(html).toContain("a@example.com")
    expect(html).toContain("Clear date (undo)")
    expect(html).toContain("Notify v1 users")
    expect(html).toContain("lg:grid-cols-2")
    expect(html).not.toMatch(/emerald|green/)
  })
  it("offers no clear button and disables notify when no date is set", () => {
    const html = render({ data: { ...data, sunset_at: null, notice_sent_at: null } })
    expect(html).not.toContain("Clear date (undo)")
    expect(html).toContain("Set a date first.")
  })
  it("shows the resend prompt after a 409 and disables actions while busy", () => {
    expect(render({ resendSentAt: "2026-11-12T10:00:00.000Z" })).toContain("already sent on 12 Nov 2026, 10:00 GMT")
    const busyHtml = render({ busy: true })
    expect(busyHtml).toContain("Clear date (undo)")
    // Every button the card renders is disabled while a request is in flight.
    const buttons = busyHtml.match(/<button[^>]*>/g) ?? []
    expect(buttons.length).toBeGreaterThan(4)
    expect(buttons.every((b) => b.includes('disabled=""'))).toBe(true)
  })
})

describe("StuckV2PanelView", () => {
  it("lists claims and orders", () => {
    const html = renderToStaticMarkup(
      createElement(StuckV2PanelView, {
        loading: false, error: null, onRefresh: () => {},
        data: {
          claims: [{ id: "c1", user_id: "u1", kind: "bundle", reference: "REF1", status: "processing", created_at: "2026-11-12T09:00:00.000Z" }],
          orders: [{ id: "o1", user_id: "u2", network: "MTN", api_reference: "API1", status: "pending", created_at: "2026-11-12T09:30:00.000Z" }],
        },
      })
    )
    expect(html).toContain("Claims (1)")
    expect(html).toContain("REF1")
    expect(html).toContain("Orders (1)")
    expect(html).toContain("API1")
  })
  it("says nothing is stuck, and shows load errors", () => {
    const base = { loading: false, onRefresh: () => {} }
    expect(renderToStaticMarkup(createElement(StuckV2PanelView, { ...base, error: null, data: { claims: [], orders: [] } }))).toContain("Nothing is stuck.")
    expect(renderToStaticMarkup(createElement(StuckV2PanelView, { ...base, error: "boom", data: null }))).toContain("boom")
  })
})
