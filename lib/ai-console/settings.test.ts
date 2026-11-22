import { describe, it, expect } from "vitest"
import { buildHomePrompt, buildDashboardPrompt, buildAdminPrompt, buildStorefrontPrompt } from "@/lib/ai-prompts"
import { assistantSettingsInputSchema, resolveAssistantSettings, audienceForContext, maxIterationsFor } from "./settings"
import { toneLine, TONES } from "./tone"

const common = { ussdDialCode: "*999*1#", channelNote: "\nUPDATES CHANNEL: x" }
const user = { firstName: "Ama", lastName: "Mensah", role: "dealer", phone: "0240000001", balance: "GHS 1.00", today: "2026-01-02", cardNonce: "N" }
const shop = { shopName: "Kofi Data Hub", storefrontServices: null, ussdDialCode: "*999*1#", shopUssdCode: "4321" }

describe("defaults_identical_prompts", () => {
  it("default name/tone (explicit or omitted) changes nothing", () => {
    const d = { assistantName: "DATAGOD AI", tone: "default" as const }
    expect(buildHomePrompt({ ...common, guestPurchaseUrl: "/g", ...d })).toEqual(buildHomePrompt({ ...common, guestPurchaseUrl: "/g" }))
    expect(buildDashboardPrompt({ ...common, ...user, ...d })).toEqual(buildDashboardPrompt({ ...common, ...user }))
    expect(buildAdminPrompt({ ...common, ...user, ...d })).toEqual(buildAdminPrompt({ ...common, ...user }))
    expect(buildStorefrontPrompt({ ...shop, ...d })).toEqual(buildStorefrontPrompt(shop))
    expect(resolveAssistantSettings(undefined).name).toBe("DATAGOD AI")
    expect(resolveAssistantSettings({}).tone).toBe("default")
  })
})

describe("custom_name_stable_line", () => {
  it("adds the name line to stable only, per builder; storefront ignores it", () => {
    const line = "Your name is Kofi Bot. Introduce yourself by this name."
    for (const p of [
      buildHomePrompt({ ...common, guestPurchaseUrl: "/g", assistantName: "Kofi Bot" }),
      buildDashboardPrompt({ ...common, ...user, assistantName: "Kofi Bot" }),
      buildAdminPrompt({ ...common, ...user, assistantName: "Kofi Bot" }),
    ]) {
      expect(p.stable).toContain(line)
      expect(p.volatile).not.toContain("Kofi Bot")
      // fixed position: right after the opening identity line
      expect(p.stable.split("\n")[1]).toBe(line)
    }
    expect(buildStorefrontPrompt({ ...shop, assistantName: "Kofi Bot" }).stable).not.toContain("Kofi Bot")
    expect(buildStorefrontPrompt({ ...shop, assistantName: "Kofi Bot" }).stable).toContain("Kofi Data Hub")
  })
})

describe("tone_line_stable", () => {
  it("every non-default preset adds a stable line with the calm-and-serious guard; default adds none", () => {
    expect(toneLine("default")).toBe("")
    for (const t of TONES.filter((x) => x !== "default")) {
      const line = toneLine(t)
      expect(line).toMatch(/upset/)
      expect(line).toMatch(/never joke about money, failed orders or complaints/)
      for (const p of [
        buildHomePrompt({ ...common, guestPurchaseUrl: "/g", tone: t }),
        buildDashboardPrompt({ ...common, ...user, tone: t }),
        buildAdminPrompt({ ...common, ...user, tone: t }),
        buildStorefrontPrompt({ ...shop, tone: t }),
      ]) {
        expect(p.stable).toContain(line)
        expect(p.volatile).not.toContain(line)
      }
    }
  })
})

describe("max_steps_bounds", () => {
  it("accepts null and integers 3-25, rejects the rest; resolver falls back to null", () => {
    const ok = (v: unknown) => assistantSettingsInputSchema.safeParse({ max_tool_steps: v }).success
    expect([null, 3, 10, 25].every(ok)).toBe(true)
    expect([2, 26, 0, -1, 5.5, "10", NaN].some(ok)).toBe(false)
    expect(resolveAssistantSettings({ max_tool_steps: 99 }).maxToolSteps).toBeNull()
    expect(maxIterationsFor("admin", resolveAssistantSettings({}))).toBe(20)
    expect(maxIterationsFor("home", resolveAssistantSettings({}))).toBe(10)
    expect(maxIterationsFor("admin", resolveAssistantSettings({ max_tool_steps: 7 }))).toBe(7)
  })

  it("validates name, tone and audiences strictly", () => {
    expect(assistantSettingsInputSchema.safeParse({ assistant_name: "<script>" }).success).toBe(false)
    expect(assistantSettingsInputSchema.safeParse({ tone: "rude" }).success).toBe(false)
    expect(assistantSettingsInputSchema.safeParse({ audiences: { admins: true } }).success).toBe(false)
    expect(assistantSettingsInputSchema.safeParse({ extra: 1 }).success).toBe(false)
    expect(assistantSettingsInputSchema.safeParse({ assistant_name: " Kofi Bot ", tone: "fun" }).data?.assistant_name).toBe("Kofi Bot")
  })
})

describe("audienceForContext", () => {
  it("maps contexts", () => {
    expect(["admin", "dashboard", "storefront", "home"].map(audienceForContext)).toEqual(["admins", "signedIn", "shopVisitors", "publicVisitors"])
  })
})
