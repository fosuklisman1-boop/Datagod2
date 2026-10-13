import { describe, expect, it } from "vitest"
import { BILLERS, BILLER_KEYS, isBillerKey, lookupRequest, normaliseInputs, parseLookup, purchaseFields, suggestedAmount } from "./billers"

const it_ = (Display: string, Value: string, Amount: number) => ({ Display, Value, Amount })

describe("billers", () => {
  it("six billers mapped to the Hubtel services", () => {
    expect(BILLER_KEYS).toEqual(["ecg", "ghana_water", "dstv", "gotv", "startimes", "telecel_broadband"])
    expect(BILLERS.ecg.serviceKey).toBe("bill_ecg")
    expect(BILLERS.telecel_broadband.page).toBe("broadband")
    expect(BILLERS.dstv.logo).toBe("/billers/dstv.png")
    expect(isBillerKey("ecg")).toBe(true)
    expect(isBillerKey("constructor")).toBe(false)
  })
  it("normalises and validates inputs", () => {
    expect(normaliseInputs("ecg", { phone: "024 123 4567" })).toEqual({ ok: true, value: { account: "", phone: "233241234567", email: null, broadbandAccount: null } })
    expect(normaliseInputs("ecg", { phone: "12" }).ok).toBe(false)
    expect(normaliseInputs("ghana_water", { account: "091019010006", phone: "0242825109", email: "bad" }).ok).toBe(false)
    expect(normaliseInputs("ghana_water", { account: "091019010006", phone: "0242825109", email: "a@b.co" }))
      .toEqual({ ok: true, value: { account: "091019010006", phone: "233242825109", email: "a@b.co", broadbandAccount: null } })
    expect(normaliseInputs("dstv", { account: " 7029864396 " })).toEqual({ ok: true, value: { account: "7029864396", phone: null, email: null, broadbandAccount: null } })
    expect(normaliseInputs("dstv", { account: "<script>" }).ok).toBe(false)
    expect(normaliseInputs("telecel_broadband", { account: "0302450262" }).ok).toBe(false)
    expect(normaliseInputs("telecel_broadband", { account: "0302450262", broadbandAccount: "P0444101" }).ok).toBe(true)
  })
  it("lookup requests", () => {
    expect(lookupRequest("ecg", { account: "", phone: "233541312238", email: null, broadbandAccount: null })).toEqual({ destination: "233541312238" })
    expect(lookupRequest("ghana_water", { account: "091019010006", phone: "233242825109", email: "a@b.co", broadbandAccount: null }))
      .toEqual({ destination: "091019010006", mobile: "233242825109" })
    expect(lookupRequest("startimes", { account: "02190617357", phone: null, email: null, broadbandAccount: null })).toEqual({ destination: "02190617357" })
  })
  it("parses DSTV/GOtv (negative due => suggested 0)", () => {
    const p = parseLookup("gotv", [it_("name", "Senya Duku", 0), it_("amountDue", "-201.00", 0), it_("account", "7032371505", 0)])
    expect(p.customerName).toBe("Senya Duku")
    expect(p.amountDue).toBe(-201)
    expect(suggestedAmount(p.amountDue)).toBe(0)
    expect(suggestedAmount(371.889)).toBe(371.89)
  })
  it("parses StarTimes' different key casing", () => {
    const p = parseLookup("startimes", [it_("Name", "Joe Nti", 0), it_("Account Number", "02190617357", 0), it_("Bouquet", "DTH_Super ", 0)])
    expect(p.customerName).toBe("Joe Nti")
    expect(p.amountDue).toBeNull()
  })
  it("parses Ghana Water incl. sessionId", () => {
    const p = parseLookup("ghana_water", [it_("name", "AMAKYE FREMPONG", 0), it_("amountDue", "371.89", 371.89), it_("sessionId", "3792660ccf", 0)])
    expect(p).toMatchObject({ customerName: "AMAKYE FREMPONG", amountDue: 371.89, sessionId: "3792660ccf" })
  })
  it("parses ECG meter lists with leading spaces", () => {
    const p = parseLookup("ecg", [it_(" THOMAS ANANE (G131099826)", " G131099826", -1.1432), it_(" ADEMAU LYDIA (24911947992)", " 24911947992", 0)])
    expect(p.meters).toEqual([
      { meter: "G131099826", name: "THOMAS ANANE", outstanding: -1.1432 },
      { meter: "24911947992", name: "ADEMAU LYDIA", outstanding: 0 },
    ])
  })
  it("empty data is safe", () => {
    expect(parseLookup("dstv", [])).toEqual({ customerName: null, amountDue: null, sessionId: null, meters: [] })
  })
  it("purchase fields per biller", () => {
    expect(purchaseFields("ecg", { account: "P09137104", phone: "233541312238", email: null, broadbandAccount: null, sessionId: null }))
      .toEqual({ destination: "233541312238", bundle: "P09137104" })
    expect(purchaseFields("ghana_water", { account: "080706070056", phone: "233548359582", email: "u@x.com", broadbandAccount: null, sessionId: "e7a1" }))
      .toEqual({ destination: "233548359582", bundle: "080706070056", extra: { email: "u@x.com", sessionId: "e7a1" } })
    expect(purchaseFields("dstv", { account: "7029864396", phone: null, email: null, broadbandAccount: null, sessionId: null })).toEqual({ destination: "7029864396" })
    expect(purchaseFields("telecel_broadband", { account: "0302450262", phone: null, email: null, broadbandAccount: "P0444101", sessionId: null }))
      .toEqual({ destination: "0302450262", bundle: "P0444101" })
  })
  it("tolerates non-strings, inner spaces, thousands separators", () => {
    expect(normaliseInputs("dstv", { account: 7029864396 as unknown as string })).toMatchObject({ ok: true, value: { account: "7029864396" } })
    expect(normaliseInputs("dstv", { account: "7029 864 396" })).toMatchObject({ ok: true, value: { account: "7029864396" } })
    expect(normaliseInputs("telecel_broadband", { account: "0302 450 262", broadbandAccount: "P044 4101" })).toMatchObject({ ok: true, value: { account: "0302450262", broadbandAccount: "P0444101" } })
    expect(normaliseInputs("dstv", { account: null as unknown as string }).ok).toBe(false)
    expect(parseLookup("dstv", [it_("amountDue", "1,234.50", 0)]).amountDue).toBe(1234.5)
    expect(parseLookup("dstv", [it_("amountDue", "n/a", 0)]).amountDue).toBeNull()
    expect(parseLookup("ghana_water", [it_("amountDue", "", 55)]).amountDue).toBe(55)
  })
})
