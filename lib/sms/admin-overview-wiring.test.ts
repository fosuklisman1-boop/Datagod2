import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  settings: { value: null as unknown, fail: false },
  loadSmsSettings: vi.fn(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: () => Promise.resolve({ data: [], error: null }) }),
}))
vi.mock("./wholesale", () => ({ getWholesaleSnapshot: () => Promise.resolve({ provider: "moolre", backedCredits: 1, balanceGhs: null, ratePerSms: null, queuedUnsent: 0 }) }))
vi.mock("./routing", () => ({ getRoutingConfig: () => Promise.resolve({ primary: "moolre" }) }))
vi.mock("./platform-settings", () => ({ loadSmsSettings: h.loadSmsSettings }))
vi.mock("./admin-settings", () => ({
  getAdminSettings: () => (h.settings.fail ? Promise.reject(new Error("settings read failed: boom")) : Promise.resolve(h.settings.value)),
}))

import { getOverview } from "./admin-overview"

describe("getOverview kill-switch wiring", () => {
  beforeEach(() => { h.settings.fail = false; h.loadSmsSettings.mockReset() })

  it("reads featureEnabled/policyEnforced from the fresh admin settings, not the cached loader", async () => {
    h.settings.value = { settings: { featureEnabled: false, policyEnforced: true }, pricing: {} }
    h.loadSmsSettings.mockResolvedValue({ featureEnabled: true, policyEnforced: false })
    const o = await getOverview()
    expect(o.featureEnabled).toBe(false)
    expect(o.policyEnforced).toBe(true)
    expect(h.loadSmsSettings).not.toHaveBeenCalled()
  })

  it("throws when the fresh settings read fails (no guessing the switch state)", async () => {
    h.settings.fail = true
    await expect(getOverview()).rejects.toThrow(/settings read failed/)
  })
})
