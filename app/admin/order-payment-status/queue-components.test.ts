// Static-render tests for the order work queue pieces (no jsdom in this repo; same approach as roles-hub.test.ts).
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueueTabs } from "@/components/admin/order-queue/queue-tabs"
import { QueueTable } from "@/components/admin/order-queue/queue-table"
import { FilterPanel } from "@/components/admin/order-queue/filter-panel"
import { ActionsMenu } from "@/components/admin/order-queue/actions-menu"
import { FAILURE_REASON_LABELS, type FailureReason } from "@/lib/order-queue/failure-reason"
import { parseQueueParams } from "@/lib/order-queue/params"
import type { QueueParams, QueueRow, QueueView } from "@/lib/order-queue/types"

const noop = () => {}

const defaults = (): QueueParams => {
  const r = parseQueueParams(new URLSearchParams())
  if (!r.ok) throw new Error("defaults")
  return r.value
}

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: "abcdef12-0000-0000-0000-000000000001",
  createdAt: "2026-11-21T09:00:00.000Z",
  phoneNumber: null,
  price: 4.5,
  network: "MTN",
  status: "pending",
  paymentStatus: "completed",
  paymentReference: "REF-XYZ",
  volumeGb: "2",
  type: "shop",
  customerEmail: null,
  storeName: null,
  shopOwnerEmail: null,
  lastProvider: "apexprime",
  lastAttemptStatus: "failed",
  lastError: "Insufficient balance on the supplier account for this request",
  attemptCount: 3,
  hasReversal: false,
  isHeld: false,
  failureReason: "out_of_balance",
  ...over,
})

/** Slice of markup belonging to one element found by a data attribute. */
const slice = (html: string, attr: string) => {
  const start = html.indexOf(attr)
  expect(start, attr).toBeGreaterThan(-1)
  return html.slice(start, start + 400)
}

describe("QueueTabs", () => {
  const counts: Record<QueueView, number> = { needs_action: 12, held: 3, stuck: 7, failed: 41, all: 980 }

  it("renders every view with its count", () => {
    const html = renderToStaticMarkup(createElement(QueueTabs, { view: "needs_action", counts, onChange: noop }))
    for (const [v, n] of Object.entries(counts)) {
      expect(slice(html, `data-count="${v}"`)).toContain(`>${n}<`)
    }
    for (const label of ["Needs action", "Held", "Stuck", "Failed", "All"]) expect(html).toContain(label)
  })
  it("marks the active view", () => {
    const html = renderToStaticMarkup(createElement(QueueTabs, { view: "held", counts, onChange: noop }))
    expect(html).toMatch(/aria-selected="true"[^>]*data-view="held"/)
    expect(html).toMatch(/aria-selected="false"[^>]*data-view="all"/)
  })
  it("shows a placeholder while counts are loading", () => {
    const html = renderToStaticMarkup(createElement(QueueTabs, { view: "all", counts: null, onChange: noop }))
    expect(slice(html, 'data-count="failed"')).toContain("…")
  })
})

describe("QueueTable", () => {
  const render = (rows: QueueRow[], selected: string[] = [], allMatching = false) =>
    renderToStaticMarkup(
      createElement(QueueTable, {
        rows,
        selectedIds: new Set(selected),
        allMatching,
        onToggle: noop,
        onTogglePage: noop,
        now: new Date("2026-11-21T12:00:00.000Z").getTime(),
      }),
    )

  it("renders last supplier, failure reason, truncated error with full text in title, attempts and age", () => {
    const html = render([row()])
    const cell = slice(html, 'data-col="last-supplier"')
    expect(cell).toContain("Apex Prime")
    expect(cell).toContain("failed")
    expect(cell).toContain(FAILURE_REASON_LABELS.out_of_balance)
    expect(html).toContain('title="Insufficient balance on the supplier account for this request"')
    expect(html).toContain("truncate")
    expect(slice(html, 'data-col="attempts"')).toContain(">3<")
    expect(html).toContain(">3h<")
    expect(html).toContain(">abcdef12<")
    expect(html).toContain("2GB")
    expect(html).toContain("4.50")
  })
  it("a never-sent row says so", () => {
    const html = render([row({ lastProvider: null, lastAttemptStatus: null, lastError: null, attemptCount: 0, failureReason: "none" })])
    expect(slice(html, 'data-col="last-supplier"')).toContain("Not sent yet")
  })
  it("flags held and previously reversed rows", () => {
    const html = render([row({ isHeld: true, hasReversal: true })])
    expect(html).toContain('data-flag="held"')
    expect(html).toContain('data-flag="reversal"')
  })
  it("checks selected rows, and all rows when 'all matching' is on", () => {
    const a = row({ id: "aaaaaaaa-1" })
    const b = row({ id: "bbbbbbbb-2" })
    const one = render([a, b], ["aaaaaaaa-1"])
    expect(slice(one, 'data-row-id="aaaaaaaa-1"')).toContain('data-state="checked"')
    expect(slice(one, 'data-row-id="bbbbbbbb-2"')).toContain('data-state="unchecked"')
    const all = render([a, b], [], true)
    expect(slice(all, 'data-row-id="bbbbbbbb-2"')).toContain('data-state="checked"')
  })
})

describe("FilterPanel", () => {
  const html = renderToStaticMarkup(createElement(FilterPanel, { params: defaults(), onChange: noop, onReset: noop }))

  it("offers every failure reason (except 'none') from FAILURE_REASON_LABELS", () => {
    for (const [reason, label] of Object.entries(FAILURE_REASON_LABELS) as [FailureReason, string][]) {
      if (reason === "none") {
        expect(html).not.toContain('value="none"')
        continue
      }
      expect(html).toContain(`<option value="${reason}">${label}</option>`)
    }
  })
  it("has status, network, type, date range, last supplier and search filters", () => {
    for (const f of ['data-filter="status"', 'data-filter="network"', 'data-filter="type"', 'data-filter="dates"']) expect(html).toContain(f)
    expect(html).toContain('id="f-last-supplier"')
    expect(html).toContain('<option value="hubnet">Hubnet</option>')
    expect(html).toContain('id="f-search"')
  })
  it("shows the current filters as checked", () => {
    const p = { ...defaults(), networks: ["Telecel"] }
    const out = renderToStaticMarkup(createElement(FilterPanel, { params: p, onChange: noop, onReset: noop }))
    expect(out).toMatch(/data-state="checked"[^>]*id="f-network-Telecel"|id="f-network-Telecel"[^>]*data-state="checked"/)
  })
})

describe("ActionsMenu", () => {
  it("renders the trigger", () => {
    const html = renderToStaticMarkup(
      createElement(ActionsMenu, { selectedCount: 2, exporting: false, onExportSelected: noop, onOpenBulkTool: noop }),
    )
    expect(html).toContain("Actions")
  })
})
