import { describe, it, expect } from "vitest"
import { queueRowsToSheetRows, EXPORT_COLUMNS, formatAge } from "./export"
import type { QueueRow } from "./types"

const row = (over: Partial<QueueRow> = {}): QueueRow => ({
  id: "11111111-2222-3333-4444-555555555555",
  createdAt: "2026-11-21T10:00:00.000Z",
  phoneNumber: "0240000001",
  price: 4.5,
  network: "MTN",
  status: "pending",
  paymentStatus: "completed",
  paymentReference: "REF-1",
  volumeGb: "1",
  type: "shop",
  customerEmail: null,
  storeName: null,
  shopOwnerEmail: null,
  lastProvider: "hubnet",
  lastAttemptStatus: "failed",
  lastError: "Insufficient balance",
  attemptCount: 2,
  hasReversal: false,
  isHeld: false,
  failureReason: "out_of_balance",
  ...over,
})

describe("queueRowsToSheetRows", () => {
  it("uses the agreed columns, in order", () => {
    expect(EXPORT_COLUMNS).toEqual([
      "Order ID", "Type", "Network", "Size", "Price", "Status", "Phone", "Reference",
      "Last supplier", "Last error", "Attempts", "Created at",
    ])
    expect(Object.keys(queueRowsToSheetRows([row()])[0])).toEqual(EXPORT_COLUMNS)
  })
  it("maps a row's values", () => {
    expect(queueRowsToSheetRows([row()])[0]).toEqual({
      "Order ID": "11111111-2222-3333-4444-555555555555",
      Type: "shop",
      Network: "MTN",
      Size: "1GB",
      Price: 4.5,
      Status: "pending",
      Phone: "0240000001",
      Reference: "REF-1",
      "Last supplier": "hubnet",
      "Last error": "Insufficient balance",
      Attempts: 2,
      "Created at": "2026-11-21T10:00:00.000Z",
    })
  })
  it("blanks nulls instead of writing 'null'", () => {
    const r = queueRowsToSheetRows([
      row({ phoneNumber: null, price: null, volumeGb: null, lastProvider: null, lastError: null, paymentReference: null, type: null, network: null, status: null }),
    ])[0]
    expect(r.Phone).toBe("")
    expect(r.Price).toBe("")
    expect(r.Size).toBe("")
    expect(r["Last supplier"]).toBe("")
    expect(r["Last error"]).toBe("")
  })
})

describe("formatAge", () => {
  const now = new Date("2026-11-21T12:00:00.000Z").getTime()
  it("under a minute", () => expect(formatAge("2026-11-21T11:59:30.000Z", now)).toBe("<1m"))
  it("minutes", () => expect(formatAge("2026-11-21T11:15:00.000Z", now)).toBe("45m"))
  it("hours", () => expect(formatAge("2026-11-21T09:00:00.000Z", now)).toBe("3h"))
  it("days", () => expect(formatAge("2026-11-19T11:00:00.000Z", now)).toBe("2d"))
  it("future or bad input", () => {
    expect(formatAge("2026-11-21T13:00:00.000Z", now)).toBe("<1m")
    expect(formatAge("not a date", now)).toBe("—")
  })
})
