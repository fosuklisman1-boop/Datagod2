// Release 6 dashboard Webhooks tab. Lives under lib/ because vitest only collects lib/ and app/. Static render only.
import { describe, it, expect, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }))

import { WebhooksTab, WebhooksView, type WebhooksViewProps } from "@/components/developer/dashboard/WebhooksTab"

const noop = () => undefined
const base: WebhooksViewProps = {
  loading: false,
  error: null,
  info: null,
  deliveries: [],
  next: null,
  busy: false,
  shownSecret: null,
  onSave: noop,
  onDelete: noop,
  onToggle: noop,
  onReveal: noop,
  onRotate: noop,
  onTest: noop,
  onResend: noop,
  onMore: noop,
  onRetry: noop,
}

describe("Webhooks tab", () => {
  it("first frame renders and says what it is", () => {
    expect(renderToStaticMarkup(createElement(WebhooksTab))).toContain("Webhooks")
  })
  it("switched off: says not available yet and offers no form", () => {
    const html = renderToStaticMarkup(createElement(WebhooksView, { ...base, info: { enabled_globally: false, endpoint: null } }))
    expect(html).toContain("not switched on yet")
    expect(html).not.toContain("Save URL")
  })
  it("no endpoint: shows the URL form", () => {
    const html = renderToStaticMarkup(createElement(WebhooksView, { ...base, info: { enabled_globally: true, endpoint: null } }))
    expect(html).toContain("Save URL")
    expect(html).not.toContain("Send test event")
  })
  it("with an endpoint and deliveries: masked secret, test button, attempts; a hostile snippet is shown as text", () => {
    const html = renderToStaticMarkup(
      createElement(WebhooksView, {
        ...base,
        info: { enabled_globally: true, endpoint: { url: "https://h.example.com/x", enabled: true, secret_hint: "AbCd", created_at: null, updated_at: null } },
        deliveries: [
          {
            id: "evt_" + "a".repeat(24),
            type: "order.updated",
            state: "failed",
            attempts: 7,
            last_code: 500,
            last_error: "HTTP 500",
            created_at: "2026-11-26T01:00:00Z",
            next_attempt_at: null,
            delivered_at: null,
            payload: { data: { reference: "ORDER-1", status: "completed" } },
            attempts_log: [{ attempt: 7, at: "2026-11-26T01:00:00Z", ok: false, code: 500, duration_ms: 20, error: "HTTP 500", snippet: "<script>alert(1)</script>" }],
          },
        ],
      }),
    )
    expect(html).toContain("Send test event")
    expect(html).toContain("whsec_…AbCd")
    expect(html).toContain("ORDER-1")
    expect(html).toContain("Resend")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })
  it("a just-created or rotated secret is shown in full once", () => {
    const html = renderToStaticMarkup(
      createElement(WebhooksView, {
        ...base,
        shownSecret: "whsec_" + "Q".repeat(43),
        info: { enabled_globally: true, endpoint: { url: "https://h.example.com/x", enabled: true, secret_hint: "QQQQ", created_at: null, updated_at: null } },
      }),
    )
    expect(html).toContain("whsec_" + "Q".repeat(43))
  })
})
