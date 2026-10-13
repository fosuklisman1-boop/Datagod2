import { describe, it, expect } from "vitest"
import {
  senderHealthStatus,
  NOT_DELIVERING_MIN_SENT,
  DEGRADED_MIN_RESOLVED,
  HEALTHY_MIN_RESOLVED,
  HEALTHY_MIN_RATE,
  formatDeliveryRate,
  formatRelativeTime,
  normalizeSenderHealthRows,
  sortSenderHealth,
  withHealthStatus,
} from "./sender-health"

const c = (delivered: number, failed: number, in_flight = 0, total = delivered + failed + in_flight) =>
  ({ delivered, failed, in_flight, total })

describe("thresholds", () => {
  it("are the documented values", () => {
    expect(NOT_DELIVERING_MIN_SENT).toBe(10)
    expect(DEGRADED_MIN_RESOLVED).toBe(10)
    expect(HEALTHY_MIN_RESOLVED).toBe(5)
    expect(HEALTHY_MIN_RATE).toBe(0.7)
  })
})

describe("senderHealthStatus", () => {
  it("not_delivering at exactly 10 sends and none delivered (even if all still in flight)", () => {
    expect(senderHealthStatus(c(0, 10))).toBe("not_delivering")
    expect(senderHealthStatus(c(0, 0, 10))).toBe("not_delivering")
    expect(senderHealthStatus(c(0, 3, 7))).toBe("not_delivering")
  })
  it("9 sends with none delivered is too few", () => {
    expect(senderHealthStatus(c(0, 9))).toBe("insufficient")
  })
  it("one delivery lifts it out of not_delivering", () => {
    expect(senderHealthStatus(c(1, 9))).toBe("degraded")
  })
  it("degraded at 10 resolved and rate just below 0.7", () => {
    expect(senderHealthStatus(c(6, 4))).toBe("degraded") // 0.6
    expect(senderHealthStatus(c(69, 31))).toBe("degraded") // 0.69
  })
  it("rate exactly 0.7 is healthy", () => {
    expect(senderHealthStatus(c(7, 3))).toBe("healthy")
  })
  it("low rate with fewer than 10 resolved is too few", () => {
    expect(senderHealthStatus(c(2, 7))).toBe("insufficient")
  })
  it("healthy at exactly 5 resolved with rate >= 0.7", () => {
    expect(senderHealthStatus(c(5, 0))).toBe("healthy")
    expect(senderHealthStatus(c(4, 1))).toBe("healthy") // 0.8
  })
  it("4 resolved is too few even at 100%", () => {
    expect(senderHealthStatus(c(4, 0, 20))).toBe("insufficient")
  })
  it("the LINKSTOREGH batch (47 delivered / 48 failed / 5 in flight) is degraded", () => {
    expect(senderHealthStatus(c(47, 48, 5))).toBe("degraded")
  })
  it("zero everything is too few", () => {
    expect(senderHealthStatus(c(0, 0, 0))).toBe("insufficient")
  })
})

describe("formatDeliveryRate", () => {
  it("formats 0..1 as a whole percent, null as a dash", () => {
    expect(formatDeliveryRate(null)).toBe("—")
    expect(formatDeliveryRate(0)).toBe("0%")
    expect(formatDeliveryRate(0.4947)).toBe("49%")
    expect(formatDeliveryRate(1)).toBe("100%")
  })
})

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-13T12:00:00Z")
  it("handles null / invalid", () => {
    expect(formatRelativeTime(null, now)).toBe("Never")
    expect(formatRelativeTime("garbage", now)).toBe("Never")
  })
  it("buckets by minutes, hours, days", () => {
    expect(formatRelativeTime("2026-10-13T11:59:40Z", now)).toBe("just now")
    expect(formatRelativeTime("2026-10-13T11:55:00Z", now)).toBe("5 min ago")
    expect(formatRelativeTime("2026-10-13T09:00:00Z", now)).toBe("3 h ago")
    expect(formatRelativeTime("2026-10-11T12:00:00Z", now)).toBe("2 d ago")
  })
})

describe("normalizeSenderHealthRows", () => {
  it("returns [] for non-arrays and coerces numbers", () => {
    expect(normalizeSenderHealthRows(null)).toEqual([])
    expect(normalizeSenderHealthRows({})).toEqual([])
    const [r] = normalizeSenderHealthRows([{ sender: "ABC", total: "12", delivered: 3, failed: 9, in_flight: null, delivery_rate: "0.25", registry_status: "active", is_pool: true }])
    expect(r).toMatchObject({ sender: "ABC", total: 12, delivered: 3, failed: 9, in_flight: 0, delivery_rate: 0.25, registry_status: "active", is_pool: true, kyc_free: false, accounts: 0, last_delivered_at: null, last_sent_at: null })
  })
  it("keeps a null delivery_rate null", () => {
    const [r] = normalizeSenderHealthRows([{ sender: "X", total: 1, delivered: 0, failed: 0, in_flight: 1, delivery_rate: null }])
    expect(r.delivery_rate).toBeNull()
    expect(r.registry_status).toBeNull()
  })
})

describe("withHealthStatus + sortSenderHealth", () => {
  it("adds status and sorts not-delivering first, then degraded, healthy, insufficient; ties by total desc", () => {
    const rows = withHealthStatus(normalizeSenderHealthRows([
      { sender: "OK", total: 50, delivered: 45, failed: 5, in_flight: 0 },
      { sender: "FEW", total: 2, delivered: 1, failed: 0, in_flight: 1 },
      { sender: "DEAD_SMALL", total: 10, delivered: 0, failed: 10, in_flight: 0 },
      { sender: "DEAD_BIG", total: 30, delivered: 0, failed: 25, in_flight: 5 },
      { sender: "MEH", total: 100, delivered: 47, failed: 48, in_flight: 5 },
    ]))
    expect(rows.find((r) => r.sender === "OK")!.status).toBe("healthy")
    expect(sortSenderHealth(rows).map((r) => r.sender)).toEqual(["DEAD_BIG", "DEAD_SMALL", "MEH", "OK", "FEW"])
  })
  it("does not mutate the input", () => {
    const rows = withHealthStatus(normalizeSenderHealthRows([
      { sender: "A", total: 1, delivered: 1, failed: 0 },
      { sender: "B", total: 20, delivered: 0, failed: 20 },
    ]))
    sortSenderHealth(rows)
    expect(rows.map((r) => r.sender)).toEqual(["A", "B"])
  })
})
