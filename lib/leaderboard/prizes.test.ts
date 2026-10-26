import { describe, it, expect } from "vitest"
import { validatePrize, validatePresetName, prizeSummary, missingPrizes, defaultPrizeLabel, isPrizeRank } from "./prizes"
import { adminPeriodOptions, parseAdminPeriod } from "./periods"

const PKG = "6f9619ff-8b86-4d11-b42d-00c04fc964ff"

describe("validatePrize", () => {
  it("accepts each type and keeps only its own fields", () => {
    expect(validatePrize({ prize_type: "wallet_topup", amount: "50", label: "GH₵50 CASH", network: "MTN" })).toEqual({
      ok: true,
      value: { prize_type: "wallet_topup", label: "GH₵50 CASH", amount: 50, package_id: null, network: null, role: null, duration_days: null },
    })
    expect(validatePrize({ prize_type: "airtime", amount: 20, network: "MTN" })).toMatchObject({
      ok: true, value: { amount: 20, network: "MTN", label: "GH₵20 MTN Airtime" },
    })
    expect(validatePrize({ prize_type: "data_bundle", package_id: PKG }, "10GB MTN BUNDLE")).toMatchObject({
      ok: true, value: { package_id: PKG, label: "10GB MTN BUNDLE" },
    })
    expect(validatePrize({ prize_type: "role_upgrade", duration_days: "15" })).toMatchObject({
      ok: true, value: { role: "dealer", duration_days: 15, label: "15 days Dealer upgrade" },
    })
    expect(validatePrize({ prize_type: "manual", label: "  Branded   T-shirt " })).toMatchObject({ ok: true, value: { label: "Branded T-shirt" } })
  })

  it("rejects bad or missing fields with a readable reason", () => {
    const cases: [unknown, string][] = [
      [{}, "Choose a prize type"],
      [{ prize_type: "wallet_topup", amount: 0 }, "Cash amount"],
      [{ prize_type: "wallet_topup", amount: 100001 }, "Cash amount"],
      [{ prize_type: "airtime", amount: 5, network: "Glo" }, "network"],
      [{ prize_type: "data_bundle", package_id: "nope" }, "data bundle"],
      [{ prize_type: "role_upgrade", duration_days: 1.5 }, "1 to 365"],
      [{ prize_type: "role_upgrade", duration_days: 366 }, "1 to 365"],
      [{ prize_type: "manual", label: "  " }, "Describe the prize"],
      [{ prize_type: "manual", label: "x".repeat(81) }, "at most 80"],
    ]
    for (const [raw, msg] of cases) {
      const r = validatePrize(raw)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(msg)
    }
  })

  it("rounds money to pesewas", () => {
    expect(validatePrize({ prize_type: "wallet_topup", amount: 10.005 })).toMatchObject({ ok: true, value: { amount: 10.01 } })
  })
})

describe("labels", () => {
  it("formats the Prizes tab summary", () => {
    expect(prizeSummary({ label: "GH₵50 CASH", prize_type: "wallet_topup" })).toBe("GH₵50 CASH (Wallet top-up)")
    expect(prizeSummary({ label: "15DAYS DEALER ROLE UPGRADE", prize_type: "role_upgrade" })).toBe("15DAYS DEALER ROLE UPGRADE (Role upgrade)")
  })
  it("defaults sensibly", () => {
    expect(defaultPrizeLabel({ prize_type: "wallet_topup", amount: 1500, package_id: null, network: null, role: null, duration_days: null })).toBe("GH₵1,500 Cash")
    expect(defaultPrizeLabel({ prize_type: "data_bundle", amount: null, package_id: PKG, network: null, role: null, duration_days: null })).toBe("Data bundle")
  })
})

describe("missingPrizes", () => {
  it("lists ranks without an active prize, cancelled ones included", () => {
    expect(missingPrizes([
      { board: "dashboard", rank: 1, status: "active" },
      { board: "dashboard", rank: 2, status: "cancelled" },
      { board: "shop", rank: 1, status: "active" },
      { board: "shop", rank: 2, status: "active" },
      { board: "shop", rank: 3, status: "active" },
    ])).toEqual(["dashboard rank 2", "dashboard rank 3"])
    expect(missingPrizes([])).toHaveLength(6)
  })
})

describe("small validators", () => {
  it("checks ranks and preset names", () => {
    expect([1, 2, 3, 0, 4, "1"].map(isPrizeRank)).toEqual([true, true, true, false, false, false])
    expect(validatePresetName("  Gold  cash ")).toEqual({ ok: true, value: "Gold cash" })
    expect(validatePresetName("").ok).toBe(false)
  })
})

describe("admin periods", () => {
  const now = new Date("2026-10-26T12:00:00Z")
  it("offers upcoming, current, then past periods", () => {
    const months = adminPeriodOptions("monthly", now)
    expect(months[0]).toEqual({ anchor: "2026-12-01", label: "December 2026", current: false })
    expect(months[2]).toEqual({ anchor: "2026-10-01", label: "October 2026", current: true })
    expect(months).toHaveLength(15)
    expect(adminPeriodOptions("weekly", now)[1]).toMatchObject({ anchor: "2026-10-26", current: true })
  })
  it("accepts what the picker offers and nothing further ahead", () => {
    expect(parseAdminPeriod("monthly", "2026-12-15", now)?.range).toEqual({ start: "2026-12-01", end: "2026-12-31" })
    expect(parseAdminPeriod("monthly", "2027-01-01", now)).toBeNull()
    expect(parseAdminPeriod("daily", "2026-10-27", now)).not.toBeNull()
    expect(parseAdminPeriod("daily", "2026-10-28", now)).toBeNull()
    expect(parseAdminPeriod("custom", undefined, now)).toBeNull()
  })
})
