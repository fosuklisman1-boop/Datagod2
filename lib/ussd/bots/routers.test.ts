// Router-level tests for the commission-cashback bots on the Uzo main + shop USSD:
// - the NP_* / PB_* steps get the right shop context (main: null; shop: the session's resolved shop);
// - redial (op=1): the bot OTP pointer is one more pending-OTP candidate (newest created_at wins); its prompt sends
//   the code to submitBotOtp (ok / retry / final fail), and 0 cancels (guarded fail + pointer cleared). The existing
//   OTP candidates and their submit paths are unchanged.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    pending: {} as Record<string, { id: string; created_at: string } | null>,
    mainSessions: new Map<string, any>(),
    shopSessions: new Map<string, any>(),
    pointer: null as any,
    submit: { ok: true, retry: false } as { ok: boolean; retry: boolean },
  }
  /** Supabase fake: every chain method returns the chain; maybeSingle() answers per table (pending OTP rows). */
  const db = {
    from(table: string) {
      const chain: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "maybeSingle") return async () => ({ data: state.pending[table] ?? null, error: null })
          if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: null, error: null })
          return () => chain
        },
      })
      return chain
    },
    rpc: async () => ({ data: false, error: null }),
  }
  return {
    state, db,
    npStep: vi.fn(async () => ({ message: "NP STEP", ussdServiceOp: 2 as const })),
    pbStep: vi.fn(async () => ({ message: "PB STEP", ussdServiceOp: 2 as const })),
    legacyOtp: vi.fn(async (_i: string, id: string, table: string) => ({ message: `LEGACY OTP ${table} ${id}`, ussdServiceOp: 17 as const })),
    mainBundleOtp: vi.fn(async () => ({ message: "MAIN BUNDLE OTP", ussdServiceOp: 17 as const })),
    shopBundleOtp: vi.fn(async () => ({ message: "SHOP BUNDLE OTP", ussdServiceOp: 17 as const })),
    peek: vi.fn(async () => state.pointer),
    submitBotOtp: vi.fn(async () => ({ ...state.submit })),
    clear: vi.fn(async () => {}),
    failBotCharge: vi.fn(async () => {}),
  }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("next/server", () => ({ after: () => {} }))
vi.mock("@/lib/ussd/session", () => ({
  getSession: async (id: string) => h.state.mainSessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.state.mainSessions.set(id, s) },
  deleteSession: async (id: string) => { h.state.mainSessions.delete(id) },
  isRedisConfigured: () => true,
  getUssdRedis: () => null,
}))
vi.mock("@/lib/ussd-shop/session", () => ({
  getSession: async (id: string) => h.state.shopSessions.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.state.shopSessions.set(id, s) },
  deleteSession: async (id: string) => { h.state.shopSessions.delete(id) },
  isRedisConfigured: () => true,
}))
vi.mock("@/lib/ussd/bots/network-plans", () => ({ handleNetworkPlansStep: h.npStep, startNetworkPlans: vi.fn() }))
vi.mock("@/lib/ussd/bots/pay-bills", () => ({ handlePayBillsStep: h.pbStep, startPayBills: vi.fn() }))
vi.mock("@/lib/ussd/handlers/otp", () => ({ handleOtpSubmit: h.legacyOtp }))
vi.mock("@/lib/ussd/handlers/bundles", async (orig) => ({ ...(await orig<object>()), handleSubmitOtp: h.mainBundleOtp }))
vi.mock("@/lib/ussd-shop/handlers/bundles", async (orig) => ({ ...(await orig<object>()), handleSubmitOtp: h.shopBundleOtp }))
vi.mock("@/lib/bot-commission/otp-pointer", () => ({
  peekBotOtpPointer: h.peek, submitBotOtp: h.submitBotOtp, clearBotOtpPointer: h.clear,
}))
vi.mock("@/lib/bot-commission/momo", () => ({ getBotMomoRuntime: () => ({ db: h.db, marker: "runtime" }) }))
vi.mock("@/lib/bot-commission/momo-fail", () => ({ failBotCharge: h.failBotCharge }))

import { router } from "../router"
import { shopRouter } from "@/lib/ussd-shop/router"
import { otpMenu } from "@/lib/ussd-shop/menus"
import { BOT_OTP_TEXT } from "./otp-redial"

const MSISDN = "233244123456"
const SID = "uzo-sid-1"
const SHOP = "11111111-2222-4333-8444-555555555555"
const PROMPT = "Pending payment.\nEnter the OTP sent\nto your number to\ncomplete payment:\n\n0. Cancel"
const APPROVE = "Check your phone for\na MoMo authorization\nprompt and approve\nto complete payment."
const LEGACY_MAIN = "Welcome to Datagod\n1. Browse Services\n2. AFA Registration\n3. Buy Airtime\n4. Results Checker\n0. Exit"
const req = (op: string, input = "", sessionID = SID) => ({
  sessionID, ussdServiceOp: op, ussdString: input, msisdn: MSISDN, network: "01", code: "*1#", country: "GH",
})
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const pointer = (min: number) => ({ reference: "ref-opaque", orderType: "cs_bill", orderId: "order-9", createdAt: ago(min), phone: "0244123456" })

beforeEach(() => {
  h.state.pending = {}
  h.state.mainSessions.clear()
  h.state.shopSessions.clear()
  h.state.pointer = null
  h.state.submit = { ok: true, retry: false }
  for (const f of [h.npStep, h.pbStep, h.legacyOtp, h.mainBundleOtp, h.shopBundleOtp, h.peek, h.submitBotOtp, h.clear, h.failBotCharge]) f.mockClear()
})

describe("OTP prompt text", () => {
  it("the bot OTP prompt is byte-identical to the existing prompt on both menus", () => {
    expect(BOT_OTP_TEXT.prompt).toBe(PROMPT)
    expect(otpMenu()).toBe(PROMPT)
  })
})

for (const [name, route, sessions] of [
  ["main", router, () => h.state.mainSessions],
  ["shop", shopRouter, () => h.state.shopSessions],
] as const) {
  describe(`${name} router: redial with a bot OTP pointer`, () => {
    it("pointer newest of all candidates => the OTP prompt; the next input goes to submitBotOtp (ok => approve text)", async () => {
      h.state.pointer = pointer(1)
      h.state.pending = { airtime_orders: { id: "air-1", created_at: ago(5) } }
      expect(await route(req("1"))).toEqual({ message: PROMPT, ussdServiceOp: 2 })
      expect(h.peek).toHaveBeenCalledWith(MSISDN)
      expect(sessions().get(SID)).toMatchObject({ step: "SUBMIT_OTP", botOtp: true })
      expect(sessions().get(SID)?.pendingOrderTable).toBeUndefined()

      expect(await route(req("18", "123456"))).toEqual({ message: APPROVE, ussdServiceOp: 17 })
      expect(h.submitBotOtp).toHaveBeenCalledWith(expect.objectContaining({ marker: "runtime" }), h.state.pointer, "123456")
      expect(h.legacyOtp).not.toHaveBeenCalled()
    })

    it("an older pointer loses to a newer pending order: the existing OTP path, unchanged", async () => {
      h.state.pointer = pointer(8)
      h.state.pending = { airtime_orders: { id: "air-1", created_at: ago(2) } }
      expect(await route(req("1"))).toEqual({ message: PROMPT, ussdServiceOp: 2 })
      expect(sessions().get(SID)).toMatchObject({ step: "SUBMIT_OTP", pendingOrderId: "air-1", pendingOrderTable: "airtime_orders" })
      expect(sessions().get(SID)?.botOtp).toBeUndefined()
      expect((await route(req("18", "123456"))).message).toBe("LEGACY OTP airtime_orders air-1")
      expect(h.submitBotOtp).not.toHaveBeenCalled()
    })

    it("retry => 'Wrong code. Try again.' + the prompt, still on the OTP step; the next code can succeed", async () => {
      h.state.pointer = pointer(1)
      await route(req("1"))
      h.state.submit = { ok: false, retry: true }
      expect(await route(req("18", "000000"))).toEqual({ message: `Wrong code. Try again.\n${PROMPT}`, ussdServiceOp: 2 })
      expect(sessions().get(SID)).toMatchObject({ step: "SUBMIT_OTP", botOtp: true })
      h.state.submit = { ok: true, retry: false }
      expect(await route(req("18", "123456"))).toEqual({ message: APPROVE, ussdServiceOp: 17 })
      expect(h.submitBotOtp).toHaveBeenCalledTimes(2)
    })

    it("a non-numeric code is a retry without calling Paystack", async () => {
      h.state.pointer = pointer(1)
      await route(req("1"))
      expect((await route(req("18", "abc"))).message).toBe(`Wrong code. Try again.\n${PROMPT}`)
      expect(h.submitBotOtp).not.toHaveBeenCalled()
    })

    it("a final failure ends with the payment-failed text", async () => {
      h.state.pointer = pointer(1)
      await route(req("1"))
      h.state.submit = { ok: false, retry: false }
      expect(await route(req("18", "123456"))).toEqual({ message: BOT_OTP_TEXT.failed, ussdServiceOp: 17 })
    })

    it("0 cancels: guarded fail of the payment + order, pointer cleared, nothing submitted", async () => {
      h.state.pointer = pointer(1)
      await route(req("1"))
      expect(await route(req("18", "0"))).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
      expect(h.failBotCharge).toHaveBeenCalledWith(h.db, "cs_bill", "order-9", "ref-opaque", "USSD-BOT-OTP")
      expect(h.clear).toHaveBeenCalledWith("0244123456")
      expect(h.submitBotOtp).not.toHaveBeenCalled()
    })

    it("the pointer expired between the dial and the code: an end text, nothing submitted or failed", async () => {
      h.state.pointer = pointer(1)
      await route(req("1"))
      h.state.pointer = null
      expect(await route(req("18", "123456"))).toEqual({ message: BOT_OTP_TEXT.expired, ussdServiceOp: 17 })
      expect(h.submitBotOtp).not.toHaveBeenCalled()
      expect(h.failBotCharge).not.toHaveBeenCalled()
    })

    it("no pointer and nothing pending: today's first screen", async () => {
      const r = await route(req("1"))
      expect(r.message).toBe(name === "main" ? LEGACY_MAIN : "Welcome to DataGod\nEnter shop code:\n\n0. Exit")
    })

    it("a pointer read that throws is ignored (the existing candidates still work)", async () => {
      h.peek.mockImplementationOnce(async () => { throw new Error("redis") })
      h.state.pending = { airtime_orders: { id: "air-1", created_at: ago(2) } }
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      expect(await route(req("1"))).toEqual({ message: PROMPT, ussdServiceOp: 2 })
      expect(sessions().get(SID)).toMatchObject({ pendingOrderTable: "airtime_orders" })
      err.mockRestore()
    })
  })
}

describe("existing OTP submit paths are unchanged", () => {
  it("main: bundle (ussd_orders) and results-checker tables", async () => {
    h.state.pending = { ussd_orders: { id: "b-1", created_at: ago(1) } }
    await router(req("1"))
    expect((await router(req("18", "1234"))).message).toBe("MAIN BUNDLE OTP")
    h.state.pending = { results_check_requests: { id: "rc-1", created_at: ago(1) } }
    await router(req("1", "", "sid-2"))
    expect((await router(req("18", "1234", "sid-2"))).message).toBe("LEGACY OTP results_check_requests rc-1")
  })

  it("shop: bundle (ussd_shop_orders) and results-checker tables", async () => {
    h.state.pending = { ussd_shop_orders: { id: "b-1", created_at: ago(1) } }
    await shopRouter(req("1"))
    expect((await shopRouter(req("18", "1234"))).message).toBe("SHOP BUNDLE OTP")
    h.state.pending = { results_checker_orders: { id: "rc-1", created_at: ago(1) } }
    await shopRouter(req("1", "", "sid-2"))
    expect((await shopRouter(req("18", "1234", "sid-2"))).message).toBe("LEGACY OTP results_checker_orders rc-1")
  })
})

describe("NP_* / PB_* steps: shop context from the router", () => {
  const NP = ["NP_NETWORK", "NP_CATEGORY", "NP_PLAN", "NP_RECIPIENT", "NP_CONFIRM"]
  const PB = ["PB_BILLER", "PB_ECG_MODE", "PB_ACCOUNT", "PB_METERS", "PB_METER_TYPE", "PB_CONSENT", "PB_AMOUNT", "PB_CONFIRM"]

  it("main router: every step gets surface ussd and shopId null (even if a shopId were in the session)", async () => {
    for (const step of [...NP, ...PB]) {
      h.state.mainSessions.set(SID, { step, dialingPhone: MSISDN, shopId: SHOP })
      await router(req("18", "1"))
    }
    expect(h.npStep).toHaveBeenCalledTimes(NP.length)
    expect(h.pbStep).toHaveBeenCalledTimes(PB.length)
    for (const call of [...h.npStep.mock.calls, ...h.pbStep.mock.calls] as unknown as [any, string, any][]) {
      expect(call[0]).toEqual({ surface: "ussd", sessionId: SID, dialingPhone: MSISDN, shopId: null })
      expect(call[1]).toBe("1")
    }
  })

  it("shop router: every step gets surface ussd_shop and the session's shopId + name; none => null", async () => {
    for (const step of [...NP, ...PB]) {
      h.state.shopSessions.set(SID, { step, dialingPhone: MSISDN, shopId: SHOP, shopName: "Ama" })
      await shopRouter(req("18", "2"))
    }
    for (const call of [...h.npStep.mock.calls, ...h.pbStep.mock.calls] as unknown as [any, string, any][]) {
      expect(call[0]).toEqual({ surface: "ussd_shop", sessionId: SID, dialingPhone: MSISDN, shopId: SHOP, shopName: "Ama" })
    }
    h.npStep.mockClear()
    h.state.shopSessions.set(SID, { step: "NP_PLAN", dialingPhone: MSISDN })
    await shopRouter(req("18", "2"))
    expect((h.npStep.mock.calls[0] as unknown as [any])[0]).toMatchObject({ surface: "ussd_shop", shopId: null })
  })
})
