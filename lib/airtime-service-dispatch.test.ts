import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  provider: "legacy" as string,
  configured: true,
  legacyEnabled: true,
  runtimeThrows: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
}))
vi.mock("@/lib/airtime-provider", () => ({
  // mirrors the real contract: explicit setting wins, else the legacy toggle decides digiwapy vs manual
  getAirtimeProvider: vi.fn(async (_db: any, n: string, legacy: (n: string) => Promise<boolean>) =>
    h.provider !== "legacy" ? h.provider : (await legacy(n)) ? "digiwapy" : "manual"),
}))
vi.mock("@/lib/digiwapy-provider", () => ({
  isDigiWapyConfigured: vi.fn(() => h.configured),
  isDigiWapyEnabledForNetwork: vi.fn(async () => h.legacyEnabled),
  sendAirtimeViaDigiwapy: vi.fn(async () => ({ success: true, digiwapyRef: "d1" })),
}))
vi.mock("@/lib/airtime-hubtel", () => ({ fulfillAirtimeViaHubtel: vi.fn(async () => true) }))
vi.mock("@/lib/hubtel-cs/runtime", () => ({
  getHubtelCsRuntime: () => { if (h.runtimeThrows) throw new Error("no creds"); return { client: { purchase: vi.fn() } } },
}))
vi.mock("@/lib/sms-service", () => ({
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: { adminAirtimeManualRequired: () => "manual", adminAirtimeDigiwapyFailed: () => "dgwfail" },
}))
vi.mock("@/lib/secure-random", () => ({ secureReference: () => "REF" }))
vi.mock("@/lib/phone-format", () => ({ validateNetworkPrefix: () => ({ ok: true }) }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))

import { triggerAirtimeFulfillment } from "./airtime-service"
import { sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { fulfillAirtimeViaHubtel } from "@/lib/airtime-hubtel"
import { notifyAdmins } from "@/lib/sms-service"

const order = { id: "o1", reference_code: "AT-1", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 5 }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(h, { provider: "legacy", configured: true, legacyEnabled: true, runtimeThrows: false })
})

describe("triggerAirtimeFulfillment routing", () => {
  it("setting 'hubtel' -> Hubtel path, not Digiwapy", async () => {
    h.provider = "hubtel"
    expect(await triggerAirtimeFulfillment(order)).toBe(true)
    expect(fulfillAirtimeViaHubtel).toHaveBeenCalledTimes(1)
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
  })
  it("explicit 'digiwapy' with Digiwapy env missing -> manual alert, nothing sent anywhere", async () => {
    h.provider = "digiwapy"; h.configured = false
    expect(await triggerAirtimeFulfillment(order)).toBe(false)
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
    expect(fulfillAirtimeViaHubtel).not.toHaveBeenCalled()
    expect(notifyAdmins).toHaveBeenCalledWith("manual", "airtime_manual_needed", "o1", true)
  })
  it("no setting -> legacy toggle: enabled -> Digiwapy, disabled -> manual", async () => {
    expect(await triggerAirtimeFulfillment(order)).toBe(true)
    expect(sendAirtimeViaDigiwapy).toHaveBeenCalledTimes(1)
    h.legacyEnabled = false
    vi.clearAllMocks()
    expect(await triggerAirtimeFulfillment(order)).toBe(false)
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
    expect(notifyAdmins).toHaveBeenCalledWith("manual", "airtime_manual_needed", "o1", true)
  })
  it("Hubtel runtime unavailable -> manual alert, no fallback to Digiwapy", async () => {
    h.provider = "hubtel"; h.runtimeThrows = true
    expect(await triggerAirtimeFulfillment(order)).toBe(false)
    expect(fulfillAirtimeViaHubtel).not.toHaveBeenCalled()
    expect(sendAirtimeViaDigiwapy).not.toHaveBeenCalled()
    expect(notifyAdmins).toHaveBeenCalledWith("manual", "airtime_manual_needed", "o1", true)
  })
})
