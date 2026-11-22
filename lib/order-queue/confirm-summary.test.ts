import { describe, it, expect } from "vitest"
import {
  summarizeSelection,
  formatGb,
  REJECT_REASON_LABELS,
  rejectReasonLabel,
  riskyAckReady,
  parseSupplierBalances,
  buildSendBody,
} from "./confirm-summary"
import type { QueueRow } from "./types"

let n = 0
const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
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

describe("summarizeSelection", () => {
  it("counts rows and sums GB from the volume strings", () => {
    const s = summarizeSelection([row({ volumeGb: "1" }), row({ volumeGb: "2.5" })])
    expect(s.count).toBe(2)
    expect(s.totalGb).toBe(3.5)
    expect(s.sendable).toHaveLength(2)
  })
  it("ignores missing or non-numeric volumes in the GB sum", () => {
    expect(summarizeSelection([row({ volumeGb: null }), row({ volumeGb: "abc" }), row({ volumeGb: "0.5" })]).totalGb).toBe(0.5)
  })
  it("splits risky rows: reversed orders and held processing orders", () => {
    const reversed = row({ status: "reversed", lastAttemptStatus: "reversed" })
    const held = row({ status: "processing", isHeld: true, lastAttemptStatus: "abandoned" })
    const ok = row()
    const s = summarizeSelection([reversed, held, ok])
    expect(s.risky.map((r) => r.id)).toEqual([reversed.id, held.id])
    expect(s.sendable.map((r) => r.id)).toEqual([ok.id])
    expect(s.blocked).toEqual([])
  })
  it("lists completed rows under blocked", () => {
    const done = row({ status: "completed" })
    const s = summarizeSelection([done, row()])
    expect(s.blocked).toEqual([{ row: done, reason: "completed" }])
    expect(s.sendable).toHaveLength(1)
  })
  it("blocks a processing order that is not held (live at the supplier)", () => {
    const live = row({ status: "processing", lastAttemptStatus: "processing" })
    expect(summarizeSelection([live]).blocked).toEqual([{ row: live, reason: "live_at_supplier" }])
  })
  it("blocks any order whose latest attempt is live, even a reversed or pending one", () => {
    const a = row({ status: "reversed", lastAttemptStatus: "pending" })
    const b = row({ status: "pending", lastAttemptStatus: "processing" })
    expect(summarizeSelection([a, b]).blocked.map((x) => x.reason)).toEqual(["live_at_supplier", "live_at_supplier"])
  })
  it("a held order with an abandoned attempt is not treated as live", () => {
    const held = row({ status: "processing", isHeld: true, lastAttemptStatus: "processing" })
    expect(summarizeSelection([held]).risky).toEqual([held])
  })
  it("a pending order with isHeld set is plain sendable (the server only treats processing as held)", () => {
    const r = row({ status: "pending", isHeld: true, lastAttemptStatus: "abandoned" })
    expect(summarizeSelection([r]).sendable).toEqual([r])
  })
  it("blocks failed and other non-pending statuses", () => {
    const f = row({ status: "failed" })
    expect(summarizeSelection([f]).blocked).toEqual([{ row: f, reason: "not_pending" }])
  })
  it("blocks networks the bulk send does not map, and unknown order types", () => {
    const at = row({ network: "AirtelTigo" })
    const noType = row({ type: null })
    const s = summarizeSelection([at, noType])
    expect(s.blocked).toEqual([
      { row: at, reason: "supplier_cannot_serve_network" },
      { row: noType, reason: "unknown_type" },
    ])
  })
  it("networks lists the distinct networks of rows that could be sent (risky included, blocked left out)", () => {
    const s = summarizeSelection([
      row({ network: "MTN" }),
      row({ network: "Telecel", status: "reversed" }),
      row({ network: "MTN" }),
      row({ network: "AT - iShare", status: "completed" }),
    ])
    expect(s.networks).toEqual(["MTN", "Telecel"])
  })
  it("is case- and space-tolerant on status", () => {
    expect(summarizeSelection([row({ status: " Completed " })]).blocked[0].reason).toBe("completed")
  })
})

describe("formatGb", () => {
  it("drops trailing zeros and keeps up to two decimals", () => {
    expect(formatGb(3.5)).toBe("3.5")
    expect(formatGb(4)).toBe("4")
    expect(formatGb(0.1 + 0.2)).toBe("0.3")
  })
})

describe("buildSendBody", () => {
  it("sends sendable + risky orders to the supplier and no riskyAck when nothing is risky", () => {
    const ok = row()
    const s = summarizeSelection([ok, row({ status: "completed" })])
    expect(buildSendBody(s, "sykes", "")).toEqual({ orders: [{ id: ok.id, type: "shop" }], provider: "sykes" })
  })
  it("acknowledges risky orders with the typed count AND the ids shown in the dialog", () => {
    const ok = row()
    const rev = row({ status: "reversed" })
    const held = row({ status: "processing", isHeld: true })
    const s = summarizeSelection([ok, rev, held])
    expect(buildSendBody(s, "sykes", " 2 ")).toEqual({
      orders: [
        { id: ok.id, type: "shop" },
        { id: rev.id, type: "shop" },
        { id: held.id, type: "shop" },
      ],
      provider: "sykes",
      riskyAck: { count: 2, ids: [rev.id, held.id] },
    })
  })
})

describe("riskyAckReady", () => {
  it("is ready with no risky rows, whatever was typed", () => {
    expect(riskyAckReady(0, "", false)).toBe(true)
  })
  it("needs the box ticked AND the typed number equal to the risky count", () => {
    expect(riskyAckReady(3, "3", false)).toBe(false)
    expect(riskyAckReady(3, "2", true)).toBe(false)
    expect(riskyAckReady(3, "", true)).toBe(false)
    expect(riskyAckReady(3, "3.0", true)).toBe(false)
    expect(riskyAckReady(3, " 3 ", true)).toBe(true)
  })
})

describe("parseSupplierBalances", () => {
  it("maps each supplier's GHS balance and SPFastIT's GB balance to a label", () => {
    const out = parseSupplierBalances({
      success: true,
      spfastit: { balance_gb: 12.5 },
      balances: { xpress: { balance: 1234.5, currency: "GHS" }, sykes: { balance: null, currency: "GHS" } },
    })
    expect(out).toEqual({ xpress: "GHS 1,234.50", spfastit: "12.5 GB" })
  })
  it("returns nothing for a missing or malformed response", () => {
    expect(parseSupplierBalances(null)).toEqual({})
    expect(parseSupplierBalances({ balances: "x" })).toEqual({})
    expect(parseSupplierBalances({ balances: { xpress: { balance: "9" } } })).toEqual({})
  })
})

describe("reject reason labels", () => {
  it("has a human label for every server reason", () => {
    for (const k of [
      "completed", "live_at_supplier", "already_queued", "not_pending", "supplier_cannot_serve_network", "not_found",
      "needs_confirmation", "duplicate_in_request", "changed", "update_failed", "insert_failed",
    ] as const) {
      expect(REJECT_REASON_LABELS[k]).toBeTruthy()
    }
  })
  it("falls back to the raw reason for anything unknown", () => {
    expect(rejectReasonLabel("something_new")).toBe("something_new")
    expect(rejectReasonLabel("needs_confirmation")).toBe(REJECT_REASON_LABELS.needs_confirmation)
  })
})
