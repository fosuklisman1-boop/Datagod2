// Static-render tests for the send bar, confirm dialog and results (house pattern: roles-hub.test.ts).
import { describe, it, expect } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { BulkActionBar } from "@/components/admin/order-queue/bulk-action-bar"
import {
  SendConfirmBody,
  HARD_PIN_COPY,
  HUBNET_COPY,
  RISKY_WARNING_COPY,
  RISKY_CHECKBOX_COPY,
  ACK_MISMATCH_COPY,
  type SendConfirmBodyProps,
} from "@/components/admin/order-queue/send-confirm-dialog"
import { SendResults } from "@/components/admin/order-queue/send-results"
import { summarizeSelection, REJECT_REASON_LABELS } from "@/lib/order-queue/confirm-summary"
import type { QueueRow } from "@/lib/order-queue/types"

const noop = () => {}
let n = 0
const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: `${String(++n).padStart(8, "a")}-0000-0000-0000-000000000000`,
  createdAt: "2026-11-21T09:00:00.000Z",
  phoneNumber: null,
  price: 4.5,
  network: "MTN",
  status: "pending",
  paymentStatus: "completed",
  paymentReference: null,
  volumeGb: "1",
  type: "shop",
  customerEmail: null,
  storeName: null,
  shopOwnerEmail: null,
  lastProvider: null,
  lastAttemptStatus: null,
  lastError: null,
  attemptCount: 0,
  hasReversal: false,
  isHeld: false,
  failureReason: null,
  ...over,
})

/** The opening tag of the element carrying `attr`. */
const tagWith = (html: string, attr: string) => {
  const i = html.indexOf(attr)
  expect(i, attr).toBeGreaterThan(-1)
  return html.slice(html.lastIndexOf("<", i), html.indexOf(">", i) + 1)
}

describe("BulkActionBar", () => {
  const base = {
    totalGb: 3.5,
    suppliers: [{ value: "xpress", label: "Xpress" }],
    balances: {},
    busy: false,
    exporting: false,
    onSend: noop,
    onChangeStatus: noop,
    onExport: noop,
    onClear: noop,
  }
  it("shows 'N selected · X GB' and the three actions", () => {
    const html = renderToStaticMarkup(createElement(BulkActionBar, { ...base, selectedCount: 2 }))
    expect(html).toContain("2 selected · 3.5 GB")
    expect(html).toContain("Send to supplier")
    expect(html).toContain("Change status")
    expect(html).toContain("Export")
    expect(html).toContain("sticky bottom-0")
  })
  it("renders nothing with no selection", () => {
    expect(renderToStaticMarkup(createElement(BulkActionBar, { ...base, selectedCount: 0 }))).toBe("")
  })
  it("shows a placeholder while all-matching rows load, and disables Send with no capable supplier", () => {
    const html = renderToStaticMarkup(createElement(BulkActionBar, { ...base, selectedCount: 150, totalGb: null, suppliers: [] }))
    expect(html).toContain("150 selected · … GB")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Send to supplier/)
  })
})

describe("SendConfirmBody", () => {
  const props = (rows: QueueRow[], over: Partial<SendConfirmBodyProps> = {}): SendConfirmBodyProps => ({
    summary: summarizeSelection(rows),
    supplier: { value: "xpress", label: "Xpress" },
    typedCount: "",
    onTypedCountChange: noop,
    checked: false,
    onCheckedChange: noop,
    sending: false,
    error: null,
    onSend: noop,
    onCancel: noop,
    ...over,
  })
  const render = (p: SendConfirmBodyProps) => renderToStaticMarkup(createElement(SendConfirmBody, p))

  it("shows count, GB, networks, supplier and the hard-pin warning; no Hubnet or risky copy", () => {
    const html = render(props([row({ volumeGb: "1" }), row({ volumeGb: "2.5", network: "Telecel" })], { balance: "GHS 50.00" }))
    expect(html).toContain(">2<")
    expect(html).toContain("3.5 GB")
    expect(html).toContain("MTN, Telecel")
    expect(html).toContain("Xpress")
    expect(html).toContain("GHS 50.00")
    expect(html).toContain(HARD_PIN_COPY)
    expect(html).not.toContain(HUBNET_COPY)
    expect(html).not.toContain(RISKY_WARNING_COPY)
    expect(tagWith(html, 'data-action="send"')).not.toContain('disabled=""')
  })
  it("shows the Hubnet pace only when Hubnet is chosen", () => {
    const html = render(props([row()], { supplier: { value: "hubnet", label: "Hubnet" } }))
    expect(html).toContain(HUBNET_COPY)
    expect(html).toContain(HARD_PIN_COPY)
  })
  it("shows the risky block with its warning, tick box and number field", () => {
    const html = render(props([row({ status: "reversed" }), row({ status: "processing", isHeld: true }), row()]))
    expect(html).toContain('data-section="risky"')
    expect(html).toContain(RISKY_WARNING_COPY)
    expect(html).toContain(RISKY_CHECKBOX_COPY)
    expect(html).toContain('data-ack="count"')
    expect(html).toContain("2 held/reversed orders")
  })
  it("keeps Send disabled until the box is ticked AND the typed count equals the risky count", () => {
    const rows = [row({ status: "reversed" }), row({ status: "processing", isHeld: true })]
    const send = (over: Partial<SendConfirmBodyProps>) => tagWith(render(props(rows, over)), 'data-action="send"')
    expect(send({})).toContain('disabled=""')
    expect(send({ checked: true, typedCount: "1" })).toContain('disabled=""')
    expect(send({ checked: false, typedCount: "2" })).toContain('disabled=""')
    expect(send({ checked: true, typedCount: "2" })).not.toContain('disabled=""')
  })
  it("lists rows that will not be sent, with readable reasons", () => {
    const html = render(props([row({ status: "completed" }), row()]))
    expect(html).toContain('data-section="blocked"')
    expect(html).toContain(REJECT_REASON_LABELS.completed)
  })
  it("disables Send when nothing can go out, and shows a server error", () => {
    const html = render(props([row({ status: "completed" })], { error: ACK_MISMATCH_COPY }))
    expect(tagWith(html, 'data-action="send"')).toContain('disabled=""')
    expect(html).toContain(ACK_MISMATCH_COPY)
  })
})

describe("SendResults", () => {
  it("lists queued ids and rejected ids with readable reasons", () => {
    const html = renderToStaticMarkup(
      createElement(SendResults, {
        result: {
          supplierLabel: "Xpress",
          queued: ["11111111-x", "22222222-y"],
          rejected: [{ id: "33333333-z", reason: "already_queued" }],
          risky: ["22222222-y"],
        },
        onDismiss: noop,
      }),
    )
    expect(html).toContain("2 queued to Xpress · 1 not sent")
    expect(html).toContain("11111111")
    expect(html).toContain("22222222 (held/reversed)")
    expect(html).toContain(REJECT_REASON_LABELS.already_queued)
  })
})
