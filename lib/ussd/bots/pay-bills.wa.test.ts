// Pay Bills on the WhatsApp bots (WHATSAPP_PROFILE): Ghana Water + email, names as sent, 10 per page, the typed MoMo
// number, the NEEDS_VERIFY SMS check, 1000-char messages.
import { describe, it, expect, vi } from "vitest"
import type { BotChargeResult } from "@/lib/bot-commission/momo"
import type { BotOrderResult } from "@/lib/bot-commission/orders"
import type { VerifyResult } from "@/lib/bills/service"
import type { UzoResponse } from "../types"
import { handlePayBillsStep, livePayBillsDeps, startPayBills, type PayBillsDeps, type PbVerifyInput } from "./pay-bills"
import type { BotFlowCtx, UzoBotSession } from "./kit"
import { WHATSAPP_MESSAGE_LIMIT } from "./profile"

const SID = "233244123456"
const ME = "233244123456"
const ME_LOCAL = "0244123456"
const PAY = "0201234567"
const SHOP = "11111111-2222-4333-8444-555555555555"
const ORDER = "99999999-8888-4777-8666-555555555555"
const PROMPT = "Enter MoMo number to charge:\n(e.g. 0244123456)\n\n0. Back"
const VERIFY = `We sent a 6-digit code by SMS to ${PAY}.\nReply with the code to verify this MoMo number.\n\n0. Cancel`
const BILLERS = [
  { key: "ecg", min: 1, max: 5000 }, { key: "ghana_water", min: 1, max: 5000 }, { key: "dstv", min: 5, max: 2000 },
  { key: "gotv", min: 5, max: 2000 }, { key: "startimes", min: 5, max: 2000 }, { key: "telecel_broadband", min: 10, max: 3000 },
] as Awaited<ReturnType<PayBillsDeps["billers"]>>
const LIST = "Pay Bills\n1. ECG\n2. Ghana Water\n3. DStv\n4. GOtv\n5. StarTimes\n6. Telecel Broadband\n0. Back"

const meter = (i: number) => ({ meter: `P1234567${i}`, name: `Data Bundle K***${i}`, outstanding: null, token: `tok-m${i}` })

const verifyFake = async (_bc: unknown, i: PbVerifyInput): Promise<VerifyResult> => {
  if (i.biller === "ecg") return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters: Array.from({ length: 12 }, (_, k) => meter(k + 1)) }
  return { ok: true, customerName: "K***h  M***h", amountDue: 80, suggestedAmount: 80, token: `tok-${i.biller}` }
}
const ok = (promptedPhone: string | null = PAY): BotChargeResult => ({ ok: true, reference: "ref1", status: "pay_offline", promptedPhone })
const NEEDS: BotChargeResult = { ok: false, code: "NEEDS_VERIFY", message: "Please verify this MoMo number first." }

function setup(o: { surface?: "whatsapp" | "whatsapp_shop"; charge?: PayBillsDeps["charge"]; verify?: PayBillsDeps["verify"] } = {}) {
  const surface = o.surface ?? "whatsapp"
  const store = new Map<string, UzoBotSession>()
  const screens: UzoResponse[] = []
  const payer = {
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
    billers: vi.fn(async () => BILLERS),
    verify: vi.fn(o.verify ?? verifyFake),
    quote: vi.fn(async (_bc: unknown, _b: unknown, face: number) => ({ payAmount: Math.round(face * 99) / 100 })),
    createOrder: vi.fn(async (_bc: unknown, i: { amount: number; expectedPay: number }): Promise<BotOrderResult> => ({
      ok: true, order: { id: ORDER, reference: "R1", payAmount: i.expectedPay, faceAmount: i.amount, customerCashback: 0.5, paymentFee: 0 },
    })),
    findOrderId: vi.fn(async () => null),
    readOrder: vi.fn(async () => ({ status: "pending", payment_status: "unpaid" })),
    failOrder: vi.fn(async () => {}),
    charge: vi.fn(o.charge ?? (async () => ok())),
    payer,
  }
  const ctx: BotFlowCtx = { surface, sessionId: SID, dialingPhone: ME, shopId: surface === "whatsapp_shop" ? SHOP : null, shopName: "Ama Shop" }
  const base: UzoBotSession = { step: "MAIN", dialingPhone: ME }
  const d = deps as unknown as PayBillsDeps
  async function start() { const r = await startPayBills(ctx, base, d); screens.push(r); return r }
  async function send(...inputs: string[]) {
    let r!: UzoResponse
    for (const m of inputs) { r = await handlePayBillsStep(ctx, m, store.get(SID) ?? base, d); screens.push(r) }
    return r
  }
  const verifyCalls = () => deps.verify.mock.calls.map(c => c[1] as PbVerifyInput)
  return { deps, ctx, store, screens, start, send, payer, verifyCalls }
}

describe("WhatsApp pay bills: Ghana Water", () => {
  it("is listed; meter, linked mobile, email (a bad email re-prompts), then the lookup carries the email", async () => {
    const t = setup()
    expect((await t.start()).message).toBe(LIST)
    expect((await t.send("2")).message).toBe("Enter meter number:\n0. Back")
    expect((await t.send("#!")).message).toBe("Enter a valid meter number.\nEnter meter number:\n0. Back")
    expect((await t.send("GW 123456")).message).toBe("Enter the phone number linked to the meter:\n0. Back")
    expect((await t.send("123")).message).toBe("Invalid number.\nEnter the phone number linked to the meter:\n0. Back")
    expect((await t.send("055 123 4567")).message).toBe("Enter your email address (Ghana Water requires it):\n0. Back")
    expect(t.store.get(SID)).toMatchObject({ step: "PB_EMAIL", pbAccount: "GW123456", pbPhone: "0551234567" })
    for (const bad of ["kofi", "kofi@mail", "a b@c.de"]) {
      expect((await t.send(bad)).message).toBe("Enter a valid email.\nEnter your email address (Ghana Water requires it):\n0. Back")
    }
    expect(t.deps.verify).not.toHaveBeenCalled()
    const a = await t.send("kofi@mail.com")
    expect(t.verifyCalls()).toEqual([{ biller: "ghana_water", account: "GW123456", phone: "0551234567", email: "kofi@mail.com" }])
    expect(a.message).toBe("Ghana Water GW123456\nName: K***h M***h\nDue: GHS 80.00\nEnter amount (GHS 1.00 - 5000.00):\n0. Back")
    expect(t.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbEmail: "kofi@mail.com", pbToken: "tok-ghana_water" })
    expect((await t.send("80")).message).toBe(PROMPT)
    const c = await t.send(PAY)
    expect(c.message).toBe(`Pay GHS 79.20 (was GHS 80.00)\nYou get GHS 80.00 Ghana Water on GW123456\nMoMo: ${PAY}\n1. Confirm\n2. Cancel`)
    expect((await t.send("1")).message.startsWith(`MoMo prompt sent to ${PAY}.`)).toBe(true)
    expect(t.deps.createOrder).toHaveBeenCalledWith(
      { botSurface: "whatsapp", shopId: null, rail: "paystack", buyerPhone: ME }, { token: "tok-ghana_water", amount: 80, expectedPay: 79.2 },
    )
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bill", orderId: ORDER, botSurface: "whatsapp", shopId: null, dialingPhone: ME, payPhone: PAY })
  })

  it("back: email => linked mobile => meter => billers; a failed lookup returns to the meter entry with fixed text", async () => {
    const t = setup()
    await t.start()
    await t.send("2", "GW123456", "0551234567")
    expect((await t.send("0")).message).toBe("Enter the phone number linked to the meter:\n0. Back")
    expect((await t.send("0")).message).toBe("Enter meter number:\n0. Back")
    expect((await t.send("0")).message).toBe(LIST)
    const f = setup({ verify: async () => ({ ok: false, status: 422, error: "provider secret" }) })
    await f.start()
    expect((await f.send("2", "GW123456", "0551234567", "a@b.co")).message).toBe(
      "Could not verify this account. Check and try again.\nEnter meter number:\n0. Back",
    )
  })
})

describe("WhatsApp pay bills: presentation + MoMo number", () => {
  it("names as sent, 10 meters per page", async () => {
    const t = setup()
    await t.start()
    const p0 = await t.send("1", "1")
    expect(p0.message.split("\n")).toHaveLength(13) // header + 10 + More + Back
    expect(p0.message).toContain("1. P12345671 Data Bundle K***1")
    expect(p0.message).toContain("11. More...")
    expect((await t.send("11")).message).toBe("Select meter:\n11. P123456711 Data Bundle K***11\n12. P123456712 Data Bundle K***12\n0. Back")
  })

  it("the MoMo number comes after the amount: invalid re-prompts, 0 goes back to the amount, confirm 0 back to it", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("3", "7012345678", "50")).message).toBe(PROMPT)
    expect((await t.send("12")).message).toBe(`Invalid number.\n${PROMPT}`)
    expect((await t.send("0")).message.startsWith("DStv 7012345678\n")).toBe(true)
    await t.send("50", PAY)
    expect(t.store.get(SID)).toMatchObject({ step: "PB_CONFIRM", pbPayPhone: PAY })
    expect((await t.send("0")).message).toBe(PROMPT)
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })

  it("shop: the charge carries the shop and the typed number", async () => {
    const t = setup({ surface: "whatsapp_shop" })
    expect((await t.start()).message).toBe(`Ama Shop\n${LIST}`)
    await t.send("3", "7012345678", "50", PAY, "1")
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bill", orderId: ORDER, botSurface: "whatsapp_shop", shopId: SHOP, dialingPhone: ME, payPhone: PAY })
  })
})

describe("WhatsApp pay bills: NEEDS_VERIFY", () => {
  it("code sent; wrong code retries; the right code charges the SAME order", async () => {
    const charge = vi.fn<PayBillsDeps["charge"]>().mockResolvedValueOnce(NEEDS).mockResolvedValueOnce(ok(null))
    const t = setup({ charge })
    await t.start()
    expect(await t.send("3", "7012345678", "50", PAY, "1")).toEqual({ message: VERIFY, ussdServiceOp: 2 })
    expect(t.payer.send).toHaveBeenCalledWith(PAY, ME)
    expect(t.store.get(SID)).toMatchObject({ step: "PB_PAY_VERIFY", pbOrderId: ORDER, pbPayPhone: PAY })
    expect(t.store.get(SID)?.pbToken).toBeUndefined()
    expect((await t.send("999999")).message).toBe(`Wrong code. Try again.\n${VERIFY}`)
    const r = await t.send("123456")
    expect(r).toEqual({ message: "MoMo prompt sent. Approve it on your phone to complete.\n\nReceived an OTP instead? Reply here with the code.", ussdServiceOp: 17 })
    expect(charge).toHaveBeenCalledTimes(2)
    expect(charge.mock.calls[1][0]).toEqual(charge.mock.calls[0][0])
    expect(t.deps.createOrder).toHaveBeenCalledTimes(1)
    expect(t.deps.failOrder).not.toHaveBeenCalled()
    expect(t.store.get(SID)?.step).toBe("MAIN")
  })

  it("0 cancels and fails the order", async () => {
    const t = setup({ charge: async () => NEEDS })
    await t.start()
    await t.send("3", "7012345678", "50", PAY, "1")
    expect(await t.send("0")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
  })
})

describe("WhatsApp pay bills: limits + wiring", () => {
  it("every message is at most 1000 chars", async () => {
    const long = "Akwasi-Kwabena Oppong-Mensah Enterprises Limited Data Bundle ".repeat(6)
    const t = setup({
      surface: "whatsapp_shop",
      verify: async (_bc, i) => (i.biller === "ecg"
        ? { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters: Array.from({ length: 30 }, (_, k) => ({ ...meter(k), name: long, outstanding: 1234.56 })) }
        : { ok: true, customerName: long, amountDue: 1234.56, suggestedAmount: 0, token: "t" }),
    })
    await t.start()
    await t.send("1", "1", "11", "21", "0", "1", "4999.99", PAY, "0", "0", "0")
    await t.send("0", "0", "2", "GW1234", "0551234567", "a@b.co", "100", PAY, "1")
    for (const r of t.screens) expect(r.message.length).toBeLessThanOrEqual(WHATSAPP_MESSAGE_LIMIT)
    expect(t.screens.length).toBeGreaterThan(15)
  })

  it("the live deps refuse a WhatsApp surface without an injected io", () => {
    expect(() => livePayBillsDeps("whatsapp_shop")).toThrow()
  })
})
