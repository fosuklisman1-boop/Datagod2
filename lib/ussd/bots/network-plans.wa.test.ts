// Network Plans on the WhatsApp bots (WHATSAPP_PROFILE): names as sent, 10 per page, the typed MoMo number, the
// NEEDS_VERIFY SMS check, 1000-char messages.
import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { BotCatalogResult } from "@/lib/bot-commission/catalog"
import type { BotChargeResult } from "@/lib/bot-commission/momo"
import type { BotOrderResult } from "@/lib/bot-commission/orders"
import type { UzoResponse } from "../types"
import { handleNetworkPlansStep, startNetworkPlans, liveNetworkPlansDeps, type NetworkPlansDeps } from "./network-plans"
import type { BotFlowCtx, UzoBotSession } from "./kit"
import { WHATSAPP_MESSAGE_LIMIT } from "./profile"

const SID = "233244123456"
const ME = "233244123456" // the WhatsApp sender
const PAY = "0201234567"   // the typed MoMo number
const SHOP = "11111111-2222-4333-8444-555555555555"
const ORDER = "99999999-8888-4777-8666-555555555555"
const PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Back"
const VERIFY = `We sent a 6-digit code by SMS to ${PAY}.\nReply with the code to verify this MoMo number.\n\n0. Cancel`

type Bundle = Extract<BotCatalogResult, { ok: true }>["categories"][number]["bundles"][number]
const bundle = (i: number, over: Partial<Bundle> = {}): Bundle => ({
  value: `MTN_Data_${i}`, display: `Data ${i}GB Bundle`, amount: 10 + i, category: "Data",
  token: `tok-${i}`, payAmount: 9.5 + i, customerCashback: 0.6, paymentFee: 0.1, ...over,
})
const CATALOG: BotCatalogResult = {
  ok: true,
  categories: [{ name: "Data", bundles: Array.from({ length: 12 }, (_, i) => bundle(i + 1)) }, { name: "Video", bundles: [bundle(50, { display: "Video Bundle" })] }],
}

const ok = (promptedPhone: string | null = PAY): BotChargeResult => ({ ok: true, reference: "ref1", status: "pay_offline", promptedPhone })
const NEEDS: BotChargeResult = { ok: false, code: "NEEDS_VERIFY", message: "Please verify this MoMo number first." }

function setup(o: {
  surface?: "whatsapp" | "whatsapp_shop"; charge?: NetworkPlansDeps["charge"]; catalog?: NetworkPlansDeps["catalog"]
  payer?: NetworkPlansDeps["payer"] | null
} = {}) {
  const surface = o.surface ?? "whatsapp"
  const store = new Map<string, UzoBotSession>()
  const screens: UzoResponse[] = []
  const payer = o.payer === null ? undefined : o.payer ?? {
    send: vi.fn(async () => ({ ok: true as const })),
    verify: vi.fn(async (_p: string, code: string) => (code === "123456" ? { ok: true, retry: false } : { ok: false, retry: true })),
  }
  const deps = {
    io: {
      save: vi.fn(async (id: string, s: UzoBotSession) => { store.set(id, JSON.parse(JSON.stringify(s))) }),
      cont: (message: string): UzoResponse => ({ message, ussdServiceOp: 2 }),
      end: (message: string): UzoResponse => ({ message, ussdServiceOp: 17 }),
      leave: vi.fn(async () => ({ message: "MENU", ussdServiceOp: 2 as const })),
    },
    catalog: vi.fn(o.catalog ?? (async () => CATALOG)),
    createOrder: vi.fn(async (): Promise<BotOrderResult> => ({
      ok: true, order: { id: ORDER, reference: "R1", payAmount: 10.5, faceAmount: 11, customerCashback: 0.6, paymentFee: 0.1 },
    })),
    findOrderId: vi.fn(async () => null),
    readOrder: vi.fn(async () => ({ status: "pending", payment_status: "unpaid" })),
    failOrder: vi.fn(async () => {}),
    charge: vi.fn(o.charge ?? (async () => ok())),
    getPrefixConfig: vi.fn(async () => ({ enabled: true, map: DEFAULT_NETWORK_PREFIXES })),
    ...(payer ? { payer } : {}),
  }
  const ctx: BotFlowCtx = {
    surface, sessionId: SID, dialingPhone: ME, shopId: surface === "whatsapp_shop" ? SHOP : null,
    shopName: surface === "whatsapp_shop" ? "Ama's Shop" : undefined,
  }
  const base: UzoBotSession = { step: "MAIN", dialingPhone: ME }
  async function start() { const r = await startNetworkPlans(ctx, base, deps); screens.push(r); return r }
  async function send(...inputs: string[]) {
    let r!: UzoResponse
    for (const m of inputs) { r = await handleNetworkPlansStep(ctx, m, store.get(SID) ?? base, deps); screens.push(r) }
    return r
  }
  return { deps, ctx, store, screens, start, send, payer }
}

describe("WhatsApp network plans: presentation", () => {
  it("networks by name; names exactly as Hubtel sends them; 10 per page", async () => {
    const t = setup()
    expect((await t.start()).message).toBe("Network Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    expect((await t.send("1")).message).toBe("MTN\nSelect type:\n1. Data\n2. Video\n0. Back")
    const p0 = await t.send("1")
    expect(p0.message).toBe(
      "MTN Data\n" + Array.from({ length: 10 }, (_, i) => `${i + 1}. ${(10.5 + i).toFixed(2)} Data ${i + 1}GB Bundle`).join("\n") + "\n11. More...\n0. Back",
    )
    expect(t.store.get(SID)?.npPlans).toHaveLength(10)
    const p1 = await t.send("11")
    expect(p1.message).toBe("MTN Data\n11. 20.50 Data 11GB Bundle\n12. 21.50 Data 12GB Bundle\n0. Back")
    expect((await t.send("12")).message).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    expect(t.store.get(SID)?.npPlan?.t).toBe("tok-12")
  })

  it("WhatsApp shop: the shop name heads the screens as stored", async () => {
    const t = setup({ surface: "whatsapp_shop" })
    expect((await t.start()).message).toBe("Ama's Shop\nNetwork Plans\n1. MTN\n2. Telecel\n3. AT\n0. Back")
    await t.send("1", "1", "1", "1", PAY, "1")
    expect(t.deps.createOrder).toHaveBeenCalledWith(
      { botSurface: "whatsapp_shop", shopId: SHOP, rail: "paystack", buyerPhone: ME },
      { token: "tok-1", recipient: "0244123456", idempotencyKey: SID, expectedPay: 10.5 },
    )
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bundle", orderId: ORDER, botSurface: "whatsapp_shop", shopId: SHOP, dialingPhone: ME, payPhone: PAY })
  })
})

describe("WhatsApp network plans: the MoMo number", () => {
  it("is asked before confirm; an invalid number re-prompts; confirm names it; the charge goes to it", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("1", "1", "1", "1")).message).toBe(PROMPT)
    expect(t.store.get(SID)).toMatchObject({ step: "NP_PAY_PHONE", npRecipient: "0244123456" })
    expect((await t.send("123")).message).toBe(`Invalid number.\n${PROMPT}`)
    expect(t.store.get(SID)?.step).toBe("NP_PAY_PHONE")
    const c = await t.send("020 123 4567")
    expect(c.message).toBe("Pay GHS 10.50 (was GHS 11.00)\nYou get MTN Data 1GB Bundle\nTo: 0244123456\nMoMo: 0201234567\n1. Confirm\n2. Cancel")
    expect(t.store.get(SID)).toMatchObject({ step: "NP_CONFIRM", npPayPhone: PAY })
    const r = await t.send("1")
    expect(r).toEqual({ message: "MoMo prompt sent to 0201234567. Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.", ussdServiceOp: 17 })
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bundle", orderId: ORDER, botSurface: "whatsapp", shopId: null, dialingPhone: ME, payPhone: PAY })
  })

  it("the prompt text names the number actually prompted (replay), or none", async () => {
    const t = setup({ charge: async () => ({ ok: true, reference: "r0", status: "pending", promptedPhone: "0551234567" }) })
    await t.start()
    expect((await t.send("1", "1", "1", "1", PAY, "1")).message.startsWith("MoMo prompt sent to 0551234567.")).toBe(true)
    const n = setup({ charge: async () => ok(null) })
    await n.start()
    expect((await n.send("1", "1", "1", "1", PAY, "1")).message.startsWith("MoMo prompt sent. Approve")).toBe(true)
  })

  it("0 at the MoMo number goes back to the recipient; 0 at confirm goes back to the MoMo number", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1", "1", "1")
    expect((await t.send("0")).message).toBe("Recipient:\n1. My number\n2. Other number\n0. Back")
    await t.send("1", PAY)
    expect((await t.send("0")).message).toBe(PROMPT)
    expect(t.store.get(SID)?.npPayPhone).toBeUndefined()
  })

  it("a confirm without a MoMo number (stale session) asks for it and never charges", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1", "1", "1", PAY)
    t.store.set(SID, { ...t.store.get(SID)!, npPayPhone: undefined })
    expect((await t.send("1")).message).toBe(PROMPT)
    expect(t.deps.createOrder).not.toHaveBeenCalled()
    expect(t.deps.charge).not.toHaveBeenCalled()
  })
})

describe("WhatsApp network plans: NEEDS_VERIFY", () => {
  it("sends a code to the paying number; a wrong code retries; the right code charges the SAME order", async () => {
    const charge = vi.fn<NetworkPlansDeps["charge"]>().mockResolvedValueOnce(NEEDS).mockResolvedValueOnce(ok())
    const t = setup({ charge })
    await t.start()
    const v = await t.send("1", "1", "1", "1", PAY, "1")
    expect(v).toEqual({ message: VERIFY, ussdServiceOp: 2 })
    expect(t.payer!.send).toHaveBeenCalledWith(PAY, ME)
    const s = t.store.get(SID)!
    expect(s).toMatchObject({ step: "NP_PAY_VERIFY", npOrderId: ORDER, npPayPhone: PAY })
    expect(s.npPlan).toBeUndefined() // no token left: no second order possible
    expect(t.deps.failOrder).not.toHaveBeenCalled()

    expect(await t.send("000000")).toEqual({ message: `Wrong code. Try again.\n${VERIFY}`, ussdServiceOp: 2 })
    expect(charge).toHaveBeenCalledTimes(1)
    const r = await t.send("123456")
    expect(t.payer!.verify).toHaveBeenLastCalledWith(PAY, "123456")
    expect(r.message.startsWith("MoMo prompt sent to 0201234567.")).toBe(true)
    expect(r.ussdServiceOp).toBe(17)
    expect(charge).toHaveBeenCalledTimes(2)
    expect(charge.mock.calls[1][0]).toEqual(charge.mock.calls[0][0])
    expect(t.deps.createOrder).toHaveBeenCalledTimes(1)
    expect(t.store.get(SID)?.npOrderId).toBeUndefined()
    expect(t.store.get(SID)?.step).toBe("MAIN")
  })

  it("0 cancels and fails the order; an expired code fails it; a send refusal fails it", async () => {
    const c = setup({ charge: async () => NEEDS })
    await c.start()
    await c.send("1", "1", "1", "1", PAY, "1")
    expect(await c.send("0")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(c.deps.failOrder).toHaveBeenCalledWith(ORDER)

    const e = setup({ charge: async () => NEEDS, payer: { send: async () => ({ ok: true }), verify: async () => ({ ok: false, retry: false }) } })
    await e.start()
    await e.send("1", "1", "1", "1", PAY, "1")
    expect(await e.send("111111")).toEqual({ message: "Code expired or too many tries. Please start over.", ussdServiceOp: 17 })
    expect(e.deps.failOrder).toHaveBeenCalledWith(ORDER)

    const l = setup({ charge: async () => NEEDS, payer: { send: async () => ({ ok: false, code: "RATE_LIMITED" }), verify: vi.fn() } })
    await l.start()
    expect(await l.send("1", "1", "1", "1", PAY, "1")).toEqual({ message: "Too many attempts. Please try later.", ussdServiceOp: 17 })
    expect(l.deps.failOrder).toHaveBeenCalledWith(ORDER)
  })

  it("no payer verification wired => fail closed; still NEEDS_VERIFY after a verified code => fail closed, no loop", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    const n = setup({ charge: async () => NEEDS, payer: null })
    await n.start()
    expect(await n.send("1", "1", "1", "1", PAY, "1")).toEqual({ message: "Service unavailable. Please try again later.", ussdServiceOp: 17 })
    expect(n.deps.failOrder).toHaveBeenCalledWith(ORDER)

    const a = setup({ charge: async () => NEEDS })
    await a.start()
    await a.send("1", "1", "1", "1", PAY, "1")
    expect(await a.send("123456")).toEqual({ message: "Service unavailable. Please try again later.", ussdServiceOp: 17 })
    expect(a.deps.failOrder).toHaveBeenCalledWith(ORDER)
    quiet.mockRestore()
  })
})

describe("WhatsApp network plans: limits + wiring", () => {
  it("every message is at most 1000 chars, even with long names", async () => {
    const long = "Super Mega Data Bundle Ultra Value Pack For Students With Bonus Social Media Minutes Night ".repeat(3)
    const t = setup({
      surface: "whatsapp_shop",
      catalog: async () => ({ ok: true, categories: [{ name: long, bundles: Array.from({ length: 25 }, (_, i) => bundle(i, { display: `${i} ${long}` })) }] }),
    })
    await t.start()
    await t.send("1", "1", "11", "0", "1", "2", "0551234567", PAY, "1")
    expect(t.screens.length).toBeGreaterThan(8)
    for (const r of t.screens) expect(r.message.length).toBeLessThanOrEqual(WHATSAPP_MESSAGE_LIMIT)
  })

  it("the live deps refuse a WhatsApp surface without an injected io", () => {
    expect(() => liveNetworkPlansDeps("whatsapp")).toThrow()
  })
})
