// Main USSD menu + the commission-cashback bot entries ("Network Plans", "Pay Bills"): appended AFTER the existing
// items, shown only when the bot menus gate is open, and only on the Uzo main USSD (channel "ussd"). With the gate
// closed (and for any caller that does not pass "ussd", i.e. the WhatsApp bot) the text and the digit dispatch are
// byte-identical to the pre-cashback menu.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  vis: { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true },
  bots: { networkPlans: false, payBills: false },
  setSession: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => {}),
  botMenusVisible: vi.fn(),
  startNetworkPlans: vi.fn(async () => ({ message: "NP START", ussdServiceOp: 2 as const })),
  startPayBills: vi.fn(async () => ({ message: "PB START", ussdServiceOp: 2 as const })),
}))
vi.mock("../session", () => ({ setSession: h.setSession, deleteSession: h.deleteSession }))
vi.mock("../../ussd-service-visibility", () => ({ getUssdServiceVisibility: async () => ({ ...h.vis }) }))
vi.mock("../bots/gate", () => ({ botMenusVisible: h.botMenusVisible, UZO_BOT_MENUS_HIDDEN: { networkPlans: false, payBills: false } }))
vi.mock("../bots/network-plans", () => ({ startNetworkPlans: h.startNetworkPlans }))
vi.mock("../bots/pay-bills", () => ({ startPayBills: h.startPayBills }))

import { handleMain, mainMenuVisibility } from "./main"
import { mainMenu, resolveMainMenu } from "../menus"
import type { USSDSession } from "../types"

const SID = "sid-1"
const ME = "+233244123456"
const LEGACY = "Welcome to Datagod\n1. Browse Services\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit"
const session = (over: Partial<USSDSession> = {}): USSDSession => ({ step: "MAIN", dialingPhone: ME, ...over })

/** The expected menu: the visible legacy items in order, then the open bot items, renumbered. */
function expected(o: { data?: boolean; afa?: boolean; np: boolean; pb: boolean }): string {
  const items = [
    o.data !== false ? "Browse Services" : null,
    o.afa !== false ? "AFA Registration" : null,
    "Buy Airtime",
    "Results Checker",
    o.np ? "Network Plans" : null,
    o.pb ? "Pay Bills" : null,
  ].filter(Boolean)
  return `Welcome to Datagod\n${items.map((l, i) => `${i + 1}. ${l}`).join("\n")}\n0. Exit`
}

beforeEach(() => {
  h.vis = { data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: true }
  h.bots = { networkPlans: false, payBills: false }
  h.botMenusVisible.mockReset().mockImplementation(async () => ({ ...h.bots }))
  for (const f of [h.setSession, h.deleteSession, h.startNetworkPlans, h.startPayBills]) f.mockClear()
})

describe("mainMenu (pure)", () => {
  it("no arguments (WhatsApp bot, AI tool) is the unchanged 4-item menu; the bot items default to hidden", () => {
    expect(mainMenu()).toBe(LEGACY)
    expect(mainMenu({ data: true, afa: true, airtime: true, resultsChecker: true })).toBe(LEGACY)
    expect(resolveMainMenu().map(r => r.key)).toEqual(["data", "afa", "airtime", "resultsChecker"])
  })

  it("every bot combination appends after the existing items", () => {
    for (const np of [true, false]) for (const pb of [true, false]) {
      expect(mainMenu({ networkPlans: np, payBills: pb })).toBe(expected({ np, pb }))
    }
  })
})

describe("handleMain on the Uzo main USSD: every gate combination", () => {
  for (const np of [true, false]) for (const pb of [true, false]) for (const dataBlocked of [false, true]) {
    it(`np=${np} pb=${pb} dataBlocked=${dataBlocked}: text and digits agree`, async () => {
      h.bots = { networkPlans: np, payBills: pb }
      const s = session({ dataBlocked })
      const menu = expected({ data: !dataBlocked, np, pb })
      expect(await handleMain("", SID, s, "ussd")).toEqual({ message: menu, ussdServiceOp: 2 })
      if (!np && !pb && !dataBlocked) expect(menu).toBe(LEGACY)

      const first = dataBlocked ? 4 : 5 // the first digit after the legacy items
      const npDigit = np ? first : null
      const pbDigit = pb ? (np ? first + 1 : first) : null
      for (let d = first; d <= first + 2; d++) {
        h.startNetworkPlans.mockClear()
        h.startPayBills.mockClear()
        const r = await handleMain(String(d), SID, s, "ussd")
        if (d === npDigit) {
          expect(r.message).toBe("NP START")
          expect(h.startNetworkPlans).toHaveBeenCalledWith({ surface: "ussd", sessionId: SID, dialingPhone: ME, shopId: null }, s)
        } else if (d === pbDigit) {
          expect(r.message).toBe("PB START")
          expect(h.startPayBills).toHaveBeenCalledWith({ surface: "ussd", sessionId: SID, dialingPhone: ME, shopId: null }, s)
        } else {
          expect(r).toEqual({ message: menu, ussdServiceOp: 2 }) // no item at this digit: the menu repaints
          expect(h.startNetworkPlans).not.toHaveBeenCalled()
          expect(h.startPayBills).not.toHaveBeenCalled()
        }
      }
    })
  }

  it("existing digits never move: 1-4 still open the legacy services with the gate open", async () => {
    h.bots = { networkPlans: true, payBills: true }
    await handleMain("1", SID, session(), "ussd")
    expect(h.setSession).toHaveBeenLastCalledWith(SID, { step: "SELECT_NETWORK", dialingPhone: ME, dataBlocked: false })
    await handleMain("2", SID, session(), "ussd")
    expect(h.setSession).toHaveBeenLastCalledWith(SID, { step: "AFA_ENTER_NAME", dialingPhone: ME, dataBlocked: false })
    await handleMain("3", SID, session(), "ussd")
    expect(h.setSession).toHaveBeenLastCalledWith(SID, { step: "AIRTIME_ENTER_RECIPIENT", dialingPhone: ME, dataBlocked: false })
    await handleMain("4", SID, session(), "ussd")
    expect(h.setSession).toHaveBeenLastCalledWith(SID, { step: "RC_MENU", dialingPhone: ME, dataBlocked: false })
    expect(h.startNetworkPlans).not.toHaveBeenCalled()
  })

  it("an admin-hidden legacy item renumbers the bot items too (one resolved list for text and digits)", async () => {
    h.vis.afa = false
    h.bots = { networkPlans: true, payBills: true }
    expect((await handleMain("", SID, session(), "ussd")).message).toBe(expected({ afa: false, np: true, pb: true }))
    expect((await handleMain("4", SID, session(), "ussd")).message).toBe("NP START")
    expect((await handleMain("5", SID, session(), "ussd")).message).toBe("PB START")
  })

  it("the gate gets the visibility map already read (no second read)", async () => {
    await handleMain("", SID, session(), "ussd")
    expect(h.botMenusVisible).toHaveBeenCalledTimes(1)
    expect((h.botMenusVisible.mock.calls[0] as unknown[])[1]).toEqual(h.vis)
  })
})

describe("handleMain for any other caller (the WhatsApp bot)", () => {
  it("never reads the gate, never shows or dispatches the bot items, even with the gate open", async () => {
    h.bots = { networkPlans: true, payBills: true }
    expect(await handleMain("", SID, session())).toEqual({ message: LEGACY, ussdServiceOp: 2 })
    expect(await handleMain("5", SID, session())).toEqual({ message: LEGACY, ussdServiceOp: 2 })
    expect(await handleMain("6", SID, session())).toEqual({ message: LEGACY, ussdServiceOp: 2 })
    expect(h.botMenusVisible).not.toHaveBeenCalled()
    expect(h.startNetworkPlans).not.toHaveBeenCalled()
    expect(h.startPayBills).not.toHaveBeenCalled()
  })
})

describe("mainMenuVisibility", () => {
  it("bots=false is the legacy map with the bot items off; bots=true adds the gate", async () => {
    h.bots = { networkPlans: true, payBills: false }
    expect(await mainMenuVisibility(false, false)).toEqual({
      data: true, afa: true, airtime: true, resultsChecker: true, networkPlans: false, payBills: false,
    })
    expect(h.botMenusVisible).not.toHaveBeenCalled()
    expect(await mainMenuVisibility(true, true)).toEqual({
      data: false, afa: true, airtime: true, resultsChecker: true, networkPlans: true, payBills: false,
    })
  })
})
