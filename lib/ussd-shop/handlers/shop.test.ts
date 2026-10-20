// Shop USSD product menu + the commission-cashback bot entries ("Network Plans", "Pay Bills"): appended AFTER the
// existing items, shown only when the bot menus gate is open. With the gate closed the text and the digit dispatch
// are byte-identical to the pre-cashback menu.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  // Any Supabase chain resolves to { data: null, error: null } (no packages, no whitelist, no purchase).
  const chain: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
      return () => chain
    },
  })
  return {
    chain,
    vis: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true },
    bots: { networkPlans: false, payBills: false },
    setSession: vi.fn(async () => {}),
    botMenusVisible: vi.fn(),
    startNetworkPlans: vi.fn(async () => ({ message: "NP START", ussdServiceOp: 2 as const })),
    startPayBills: vi.fn(async () => ({ message: "PB START", ussdServiceOp: 2 as const })),
    boards: ["WASSCE"],
  }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.chain }))
vi.mock("../session", () => ({ setSession: h.setSession }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: async (code: string) =>
    code === "1234" ? { status: "active", shopId: "shop-1", shopCodeId: "code-1", shopName: "Ama", parentShopId: null } : null,
}))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: async () => ({ ...h.vis }) }))
vi.mock("@/lib/ussd/bots/gate", () => ({ botMenusVisible: h.botMenusVisible, UZO_BOT_MENUS_HIDDEN: { networkPlans: false, payBills: false } }))
vi.mock("@/lib/ussd/bots/network-plans", () => ({ startNetworkPlans: h.startNetworkPlans }))
vi.mock("@/lib/ussd/bots/pay-bills", () => ({ startPayBills: h.startPayBills }))
vi.mock("../../ussd/handlers/results-checker", () => ({ buildRcBoardOptions: async () => h.boards }))

import { handleEnterShopCode, handleSelectProduct } from "./shop"
import { productMenu, resolveProductMenu } from "../menus"
import type { USSDShopSession } from "../types"

const SID = "sid-shop"
const ME = "233244123456"
const LEGACY = "Ama\nWhat to buy?\n1. Browse Services\n2. Airtime\n3. Results Checker\n0. Exit"
const session = (over: Partial<USSDShopSession> = {}): USSDShopSession => ({
  step: "SELECT_PRODUCT", dialingPhone: ME, shopId: "shop-1", shopCodeId: "code-1", shopName: "Ama", networks: ["MTN"], ...over,
})
const SHOP_CTX = { surface: "ussd_shop", sessionId: SID, dialingPhone: ME, shopId: "shop-1", shopName: "Ama" }

function expected(o: { data?: boolean; np: boolean; pb: boolean }): string {
  const items = [
    o.data !== false ? "Browse Services" : null, "Airtime", "Results Checker",
    o.np ? "Network Plans" : null, o.pb ? "Pay Bills" : null,
  ].filter(Boolean)
  return `Ama\nWhat to buy?\n${items.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n0. Exit`
}

beforeEach(() => {
  h.vis = { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }
  h.bots = { networkPlans: false, payBills: false }
  h.botMenusVisible.mockReset().mockImplementation(async () => ({ ...h.bots }))
  for (const f of [h.setSession, h.startNetworkPlans, h.startPayBills]) f.mockClear()
})

describe("productMenu (pure)", () => {
  it("no visibility argument is the unchanged 3-item menu; the bot items default to hidden", () => {
    expect(productMenu("Ama")).toBe(LEGACY)
    expect(productMenu("Ama", { data: true, airtime: true, resultsChecker: true })).toBe(LEGACY)
    expect(resolveProductMenu().map(r => r.key)).toEqual(["data", "airtime", "resultsChecker"])
  })

  it("every bot combination appends after the existing items", () => {
    for (const np of [true, false]) for (const pb of [true, false]) {
      expect(productMenu("Ama", { networkPlans: np, payBills: pb })).toBe(expected({ np, pb }))
    }
  })
})

describe("handleSelectProduct: every gate combination", () => {
  for (const np of [true, false]) for (const pb of [true, false]) for (const dataBlocked of [false, true]) {
    it(`np=${np} pb=${pb} dataBlocked=${dataBlocked}: text and digits agree`, async () => {
      h.bots = { networkPlans: np, payBills: pb }
      const s = session({ dataBlocked })
      // Network Plans is a data product: the data whitelist hides it exactly like Browse Services.
      const npShown = np && !dataBlocked
      const menu = expected({ data: !dataBlocked, np: npShown, pb })
      expect(await handleSelectProduct("", SID, s)).toEqual({ message: menu, ussdServiceOp: 2 })
      if (!np && !pb && !dataBlocked) expect(menu).toBe(LEGACY)

      const first = dataBlocked ? 3 : 4
      const npDigit = npShown ? first : null
      const pbDigit = pb ? (npShown ? first + 1 : first) : null
      for (let d = first; d <= first + 2; d++) {
        h.startNetworkPlans.mockClear()
        h.startPayBills.mockClear()
        const r = await handleSelectProduct(String(d), SID, s)
        if (d === npDigit) {
          expect(r.message).toBe("NP START")
          expect(h.startNetworkPlans).toHaveBeenCalledWith(SHOP_CTX, s)
        } else if (d === pbDigit) {
          expect(r.message).toBe("PB START")
          expect(h.startPayBills).toHaveBeenCalledWith(SHOP_CTX, s)
        } else {
          expect(r).toEqual({ message: menu, ussdServiceOp: 2 })
          expect(h.startNetworkPlans).not.toHaveBeenCalled()
          expect(h.startPayBills).not.toHaveBeenCalled()
        }
      }
    })
  }

  it("existing digits never move with the gate open: 1-3 open the legacy services", async () => {
    h.bots = { networkPlans: true, payBills: true }
    await handleSelectProduct("1", SID, session())
    expect(h.setSession).toHaveBeenLastCalledWith(SID, expect.objectContaining({ step: "SELECT_NETWORK" }))
    await handleSelectProduct("2", SID, session())
    expect(h.setSession).toHaveBeenLastCalledWith(SID, expect.objectContaining({ step: "SHOP_AIRTIME_ENTER_RECIPIENT" }))
    await handleSelectProduct("3", SID, session())
    expect(h.setSession).toHaveBeenLastCalledWith(SID, expect.objectContaining({ step: "SHOP_RC_SELECT_BOARD" }))
    expect(h.startNetworkPlans).not.toHaveBeenCalled()
  })

  it("data whitelist: a blocked caller never sees Network Plans; Pay Bills stays; legacy digits do not move", async () => {
    h.bots = { networkPlans: true, payBills: true }
    const blocked = session({ dataBlocked: true })
    const menu = "Ama\nWhat to buy?\n1. Airtime\n2. Results Checker\n3. Pay Bills\n0. Exit"
    expect((await handleSelectProduct("", SID, blocked)).message).toBe(menu)
    expect((await handleSelectProduct("3", SID, blocked)).message).toBe("PB START")
    expect((await handleSelectProduct("4", SID, blocked)).message).toBe(menu)
    expect(h.startNetworkPlans).not.toHaveBeenCalled()
    await handleSelectProduct("1", SID, blocked)
    expect(h.setSession).toHaveBeenLastCalledWith(SID, expect.objectContaining({ step: "SHOP_AIRTIME_ENTER_RECIPIENT" }))
  })

  it("the bot flows get the session's resolved shop; a session without one passes null (the flow fails closed)", async () => {
    h.bots = { networkPlans: true, payBills: true }
    const s = session({ shopId: undefined })
    await handleSelectProduct("4", SID, s)
    expect(h.startNetworkPlans).toHaveBeenCalledWith({ ...SHOP_CTX, shopId: null }, s)
  })
})

describe("handleEnterShopCode", () => {
  it("gate closed: the product menu after a valid code is byte-identical", async () => {
    expect(await handleEnterShopCode("1234", SID, ME)).toEqual({ message: LEGACY, ussdServiceOp: 2 })
  })

  it("gate open: the bot items follow the legacy ones", async () => {
    h.bots = { networkPlans: true, payBills: true }
    expect((await handleEnterShopCode("1234", SID, ME)).message).toBe(expected({ np: true, pb: true }))
  })
})
