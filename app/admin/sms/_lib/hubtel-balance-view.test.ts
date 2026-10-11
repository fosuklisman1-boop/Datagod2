import { describe, it, expect } from "vitest"
import { supplyProviderLabel, parseManualBalanceInput, balanceSourceSummary } from "./hubtel-balance-view"

describe("supplyProviderLabel", () => {
  it("labels a manual estimate", () => expect(supplyProviderLabel("hubtel", { balanceSource: "manual" })).toBe("Hubtel (manual estimate)"))
  it("relay / absent source → plain provider label", () => {
    expect(supplyProviderLabel("hubtel", { balanceSource: "relay" })).toBe("Hubtel")
    expect(supplyProviderLabel("hubtel", {})).toBe("Hubtel")
    expect(supplyProviderLabel("moolre", {})).toBe("Moolre")
  })
})

describe("parseManualBalanceInput", () => {
  it("accepts 0–1,000,000 with up to 2 decimals", () => {
    expect(parseManualBalanceInput(" 150.25 ")).toEqual({ ok: true, value: 150.25 })
    expect(parseManualBalanceInput("0")).toEqual({ ok: true, value: 0 })
    expect(parseManualBalanceInput("1000000")).toEqual({ ok: true, value: 1_000_000 })
    expect(parseManualBalanceInput("1,250.5")).toEqual({ ok: true, value: 1250.5 })
  })
  it.each(["", "abc", "-1", "1000000.01", "12.345", "1e3", "GH₵5"])("rejects %j", (t) => {
    expect(parseManualBalanceInput(t).ok).toBe(false)
  })
})

describe("balanceSourceSummary", () => {
  it("relay", () => expect(balanceSourceSummary({ ok: true, amountGhs: 35, source: "relay" })).toEqual({ tone: "success", label: "Live Hubtel balance (relay)" }))
  it("manual", () => expect(balanceSourceSummary({ ok: true, amountGhs: 30, source: "manual", manualSetAt: "x" })).toEqual({ tone: "warning", label: "Manual estimate" }))
  it("unavailable", () => expect(balanceSourceSummary({ ok: false, error: "403" })).toEqual({ tone: "danger", label: "Unavailable — 403" }))
})
