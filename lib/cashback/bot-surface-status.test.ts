import { describe, expect, it } from "vitest"
import { botSurfaceStatus } from "./bot-surface-status"

const cfgOn = { enabled: true, surfaces: { bots: true }, botGroups: { bills: true, bundles: true, airtime: true } }

describe("botSurfaceStatus (bills)", () => {
  it("each bot is on only when the cashback bots gate AND its own Pay Bills switch are on", () => {
    expect(botSurfaceStatus("bills", cfgOn, { visibility: { payBills: true } }, { payBills: true }, { payBills: true }))
      .toEqual({ gate: true, hubtel: true, uzo: true, whatsapp: true })
  })

  it("Hubtel USSD defaults its switch to on (missing => on); Uzo and WhatsApp are on only when stored true", () => {
    expect(botSurfaceStatus("bills", cfgOn, { visibility: {} }, {}, {}))
      .toEqual({ gate: true, hubtel: true, uzo: false, whatsapp: false })
    expect(botSurfaceStatus("bills", cfgOn, { visibility: { payBills: false } }, { payBills: "yes" }, { payBills: 1 }))
      .toEqual({ gate: true, hubtel: false, uzo: false, whatsapp: false })
  })

  it("gate off (master, bots surface or bills group) => every bot off, whatever its switch", () => {
    for (const cfg of [
      { ...cfgOn, enabled: false },
      { ...cfgOn, surfaces: { bots: false } },
      { ...cfgOn, botGroups: { ...cfgOn.botGroups, bills: false } },
    ]) {
      expect(botSurfaceStatus("bills", cfg, { visibility: { payBills: true } }, { payBills: true }, { payBills: true }))
        .toEqual({ gate: false, hubtel: false, uzo: false, whatsapp: false })
    }
  })

  it("an unloaded source reads as off (null), never as on", () => {
    expect(botSurfaceStatus("bills", null, null, null, null)).toEqual({ gate: false, hubtel: false, uzo: false, whatsapp: false })
    expect(botSurfaceStatus("bills", cfgOn, null, null, null)).toEqual({ gate: true, hubtel: false, uzo: false, whatsapp: false })
  })

  it("bundles reads the Network Plans switches", () => {
    expect(botSurfaceStatus("bundles", cfgOn, { visibility: { networkPlans: true } }, { networkPlans: true }, { networkPlans: false }))
      .toEqual({ gate: true, hubtel: true, uzo: true, whatsapp: false })
  })
})
