import { describe, it, expect } from "vitest"
import { supplyProviderLabel, parseManualBalanceInput, balanceSourceSummary, MANUAL_BALANCE_NOTES, SET_BALANCE_CONFIRM_NOTE,
  relayInfoText, PREFER_MANUAL_LABEL, PREFER_MANUAL_HELP, PREFER_MANUAL_CONFIRM } from "./hubtel-balance-view"

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

describe("copy", () => {
  it("the notes say what is not counted", () => {
    const all = MANUAL_BALANCE_NOTES.join(" ")
    expect(all).toMatch(/every top-up/)
    expect(all).toMatch(/outside this app/)
    expect(all).toMatch(/admin notify/i)
    expect(all).toMatch(/notify-self/i)
    expect(all).toMatch(/AI tasks/i)
    expect(all).toMatch(/30 days/)
  })
  it("the confirm dialog warns about the gap before clicking", () => {
    expect(SET_BALANCE_CONFIRM_NOTE).toBe("Enter the balance exactly as shown on the Hubtel dashboard right now — messages sent in the gap before you click are not counted.")
  })
})

describe("prefer-manual helpers", () => {
  it("relayInfoText labels the relay reading as the Disbursement wallet", () => {
    expect(relayInfoText({ ok: true, amountGhs: 0 })).toBe("Relay reads GH₵0.00 — Disbursement wallet")
    expect(relayInfoText({ ok: true, amountGhs: 1234.5 })).toBe("Relay reads GH₵1,234.50 — Disbursement wallet")
    expect(relayInfoText({ ok: false, error: "relay not configured" })).toBe("Relay unavailable — relay not configured")
  })
  it("toggle copy", () => {
    expect(PREFER_MANUAL_LABEL).toBe("Use my manual balance instead of the relay — the relay reads a different Hubtel wallet")
    expect(PREFER_MANUAL_HELP).toMatch(/Disbursement wallet/)
    expect(PREFER_MANUAL_HELP).toMatch(/SMS/)
    expect(PREFER_MANUAL_CONFIRM).toMatch(/relay.*not used/i)
    expect(PREFER_MANUAL_CONFIRM).toMatch(/30 days/)
  })
})

describe("balanceSourceSummary", () => {
  it("manual preferred", () => expect(balanceSourceSummary({ ok: true, amountGhs: 30, source: "manual", manualSetAt: "x", preferred: true }))
    .toEqual({ tone: "warning", label: "Manual estimate (preferred over the relay)" }))
  it("relay", () => expect(balanceSourceSummary({ ok: true, amountGhs: 35, source: "relay" })).toEqual({ tone: "success", label: "Live Hubtel balance (relay)" }))
  it("manual", () => expect(balanceSourceSummary({ ok: true, amountGhs: 30, source: "manual", manualSetAt: "x" })).toEqual({ tone: "warning", label: "Manual estimate" }))
  it("unavailable", () => expect(balanceSourceSummary({ ok: false, error: "403" })).toEqual({ tone: "danger", label: "Unavailable — 403" }))
})
