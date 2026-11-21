import { describe, it, expect } from "vitest"
import { buildHomePrompt, buildStorefrontPrompt, buildDashboardPrompt, buildAdminPrompt } from "./index"
import { cardNonceRule } from "@/lib/ai-drafts/outcome-notes"

const common = { ussdDialCode: "*999*1#", channelNote: "\nUPDATES CHANNEL: x" }
const userA = { firstName: "Ama", lastName: "Mensah", role: "dealer", phone: "0240000001", balance: "GHS 1.00", today: "2026-01-02", cardNonce: "NONCE_A" }
const userB = { firstName: "Kojo", lastName: "Boateng", role: "user", phone: "0240000002", balance: "GHS 99.00", today: "2026-03-04", cardNonce: "NONCE_B" }

describe("stable_identical_across_users_and_dates", () => {
  it("home", () => {
    const a = buildHomePrompt({ ...common, guestPurchaseUrl: "/g" })
    const b = buildHomePrompt({ ...common, guestPurchaseUrl: "/g" })
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).toBe("")
  })

  it("storefront (same shop; all services and data-only)", () => {
    for (const services of [null, ["data_bundles" as const]]) {
      const input = { shopName: "Kofi Data Hub", storefrontServices: services, ussdDialCode: "*999*1#", shopUssdCode: "4321" }
      expect(buildStorefrontPrompt(input).stable).toBe(buildStorefrontPrompt({ ...input }).stable)
    }
  })

  it("dashboard", () => {
    const a = buildDashboardPrompt({ ...common, ...userA })
    const b = buildDashboardPrompt({ ...common, ...userB })
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).not.toBe(b.volatile)
  })

  it("admin", () => {
    const a = buildAdminPrompt({ ussdDialCode: "*999*1#", firstName: "Ama", lastName: "Mensah", today: "2026-01-02", cardNonce: "N1" })
    const b = buildAdminPrompt({ ussdDialCode: "*999*1#", firstName: "Kojo", lastName: "Boateng", today: "2026-03-04", cardNonce: "N2" })
    expect(a.stable).toBe(b.stable)
    expect(a.volatile).not.toBe(b.volatile)
  })

  it("no per-request value leaks into stable", () => {
    const d = buildDashboardPrompt({ ...common, ...userA })
    for (const v of ["Ama", "Mensah", "0240000001", "GHS 1.00", "2026-01-02", "NONCE_A", "**dealer**"]) {
      expect(d.stable).not.toContain(v)
    }
    const ad = buildAdminPrompt({ ussdDialCode: "*999*1#", firstName: "Ama", lastName: "Mensah", today: "2026-01-02", cardNonce: "NONCE_A" })
    for (const v of ["Ama", "Mensah", "2026-01-02", "NONCE_A"]) expect(ad.stable).not.toContain(v)
  })
})

describe("volatile content", () => {
  it("volatile_contains_name_and_date", () => {
    const d = buildDashboardPrompt({ ...common, ...userA })
    expect(d.volatile).toContain("Ama Mensah")
    expect(d.volatile).toContain("**dealer**")
    expect(d.volatile).toContain("2026-01-02")
    const ad = buildAdminPrompt({ ussdDialCode: "*999*1#", firstName: "Ama", lastName: "Mensah", today: "2026-01-02", cardNonce: "N" })
    expect(ad.volatile).toContain("Ama Mensah")
    expect(ad.volatile).toContain("2026-01-02")
  })

  it("nonce_rule_in_volatile", () => {
    const d = buildDashboardPrompt({ ...common, ...userA })
    expect(d.volatile).toContain(cardNonceRule("NONCE_A"))
    expect(d.stable).not.toContain("CARD RESULT AUTHENTICATION")
    const ad = buildAdminPrompt({ ussdDialCode: "*999*1#", firstName: "A", lastName: "B", today: "2026-01-02", cardNonce: "N9" })
    expect(ad.volatile).toContain(cardNonceRule("N9"))
    expect(ad.stable).not.toContain("CARD RESULT AUTHENTICATION")
  })
})
