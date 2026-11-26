import { describe, it, expect } from "vitest"
import { parseTab, reasonLabel, usageTotals, orderTone, httpTone, ghs, shortTime, DASH_TABS, latestGate, withStatus } from "./dev-dashboard-view"

describe("stale responses and row updates", () => {
  it("latestGate: only the newest request may apply its answer", () => {
    const gate = latestGate()
    const first = gate.next()
    const second = gate.next()
    expect(gate.isLatest(first)).toBe(false)
    expect(gate.isLatest(second)).toBe(true)
  })
  it("withStatus changes the matching order only, wherever it sits in the list", () => {
    const rows = [{ product: "data", reference: "A", status: "processing" }, { product: "airtime", reference: "A", status: "processing" }]
    expect(withStatus(rows, "airtime", "A", "completed")).toEqual([rows[0], { product: "airtime", reference: "A", status: "completed" }])
    expect(withStatus(rows, "bill", "A", "failed")).toEqual(rows)
  })
})

describe("dashboard view helpers", () => {
  it("tabs: six, unknown reads overview", () => {
    expect(DASH_TABS).toEqual(["overview", "keys", "usage", "logs", "orders", "webhooks", "docs"])
    expect(parseTab("webhooks")).toBe("webhooks")
    expect(parseTab("logs")).toBe("logs")
    expect(parseTab("legacy")).toBe("overview")
    expect(parseTab(null)).toBe("overview")
  })
  it("reasons read as words; http_N as a status; unknown slugs readable", () => {
    expect(reasonLabel("insufficient_balance")).toBe("Wallet balance too low")
    expect(reasonLabel("daily_limit")).toBe("Daily spending limit reached")
    expect(reasonLabel("http_429")).toBe("HTTP 429")
    expect(reasonLabel("vouchers_unavailable")).toBe("Vouchers unavailable")
    expect(reasonLabel(null)).toBe("")
  })
  it("usage totals and success rate (none when no requests)", () => {
    expect(usageTotals([{ day: "a", ok: 3, failed: 1 }, { day: "b", ok: 0, failed: 0 }])).toEqual({ ok: 3, failed: 1, total: 4, successRate: 75 })
    expect(usageTotals([]).successRate).toBeNull()
  })
  it("tones, money and time", () => {
    expect(orderTone("completed")).toBe("green")
    expect(orderTone("failed")).toBe("red")
    expect(orderTone("processing")).toBe("primary")
    expect(httpTone(201)).toBe("green")
    expect(httpTone(402)).toBe("amber")
    expect(httpTone(503)).toBe("red")
    expect(ghs(6.5)).toBe("GHS 6.50")
    expect(ghs(null)).toBe("-")
    expect(shortTime("2026-11-25T09:05:00.123456+00:00")).toBe("25 Nov, 09:05")
  })
})
