import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  setMain: vi.fn(async () => {}),
  setShop: vi.fn(async () => {}),
  handleMain: vi.fn(async () => ({ message: "MAIN MENU", ussdServiceOp: 2 as const })),
  handleSelectProduct: vi.fn(async () => ({ message: "PRODUCT MENU", ussdServiceOp: 2 as const })),
}))
vi.mock("../session", () => ({ setSession: h.setMain }))
vi.mock("@/lib/ussd-shop/session", () => ({ setSession: h.setShop }))
vi.mock("../handlers/main", () => ({ handleMain: h.handleMain }))
vi.mock("@/lib/ussd-shop/handlers/shop", () => ({ handleSelectProduct: h.handleSelectProduct }))

import { liveUzoBotIo, uzoBotContext, uzoPromptSentText, type UzoBotCtx } from "./kit"

const SHOP = "11111111-2222-4333-8444-555555555555"
const main: UzoBotCtx = { surface: "ussd", sessionId: "s1", dialingPhone: "+233244123456", shopId: null }
const shop: UzoBotCtx = { surface: "ussd_shop", sessionId: "s2", dialingPhone: "233244123456", shopId: SHOP, shopName: "Ama" }

beforeEach(() => { for (const f of Object.values(h)) f.mockClear() })

describe("uzoBotContext", () => {
  it("main => ussd, no shop; shop => ussd_shop + shop; shop without a shop => null (fail closed)", () => {
    expect(uzoBotContext(main)).toEqual({ botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: "+233244123456" })
    expect(uzoBotContext(shop)).toEqual({ botSurface: "ussd_shop", shopId: SHOP, rail: "paystack", buyerPhone: "233244123456" })
    expect(uzoBotContext({ ...shop, shopId: null })).toBeNull()
    expect(uzoBotContext({ ...shop, shopId: "" })).toBeNull()
  })
})

describe("liveUzoBotIo.leave", () => {
  it("main: back to MAIN (dialing phone + whitelist flag kept), rendered by handleMain", async () => {
    const r = await liveUzoBotIo("ussd").leave(main, { step: "NP_NETWORK", dialingPhone: "+233244123456", dataBlocked: true, npNetwork: "MTN" })
    const next = { step: "MAIN", dialingPhone: "+233244123456", dataBlocked: true }
    expect(h.setMain).toHaveBeenCalledWith("s1", next)
    expect(h.handleMain).toHaveBeenCalledWith("", "s1", next, "ussd")
    expect(r.message).toBe("MAIN MENU")
    expect(h.setShop).not.toHaveBeenCalled()
  })

  it("shop: back to SELECT_PRODUCT with the shop fields kept and the flow fields dropped", async () => {
    const r = await liveUzoBotIo("ussd_shop").leave(shop, {
      step: "NP_PLAN", dialingPhone: "233244123456", shopId: SHOP, shopName: "Ama", shopCodeId: "c1", networks: ["MTN"],
      npNetwork: "MTN", npCategories: ["Data"], npPage: 1, npPlans: [], npCategory: "Data",
    })
    const next = { step: "SELECT_PRODUCT", dialingPhone: "233244123456", shopId: SHOP, shopName: "Ama", shopCodeId: "c1", networks: ["MTN"] }
    expect(h.setShop).toHaveBeenCalledWith("s2", next)
    expect(h.handleSelectProduct).toHaveBeenCalledWith("", "s2", next)
    expect(r.message).toBe("PRODUCT MENU")
    expect(h.setMain).not.toHaveBeenCalled()
  })
})

it("prompt-sent text shows the local dialing number", () => {
  expect(uzoPromptSentText("+233244123456")).toBe(
    "MoMo prompt sent to 0244123456. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.",
  )
})
