import { describe, it, expect, vi } from "vitest"
import type { BotChargeResult } from "@/lib/bot-commission/momo"
import { BOT_BILL_TOKEN_EXPIRED, type BotOrderResult } from "@/lib/bot-commission/orders"
import type { VerifyResult } from "@/lib/bills/service"
import { cont as mainCont, end as mainEnd } from "../menus"
import { cont as shopCont, end as shopEnd } from "@/lib/ussd-shop/menus"
import type { UzoPbMeter, UzoResponse } from "../types"
import { handlePayBillsStep, pbAmountScreen, startPayBills, type PayBillsDeps, type PbVerifyInput } from "./pay-bills"
import { UZO_BOT_RESTART, type UzoBotCtx, type UzoBotSession } from "./kit"
import { fitsUzo } from "./screen"

const SID = "uzo-session-0002"
const ME = "+233244123456"
const ME_LOCAL = "0244123456"
const OTHER = "0551234567"
const SHOP = "11111111-2222-4333-8444-555555555555"
const ORDER = "99999999-8888-4777-8666-555555555555"
const SENT = `MoMo prompt sent to ${ME_LOCAL}. Approve to complete.\n\nReceived an OTP instead? Redial and enter the code.`
const UNAVAILABLE = "Service unavailable. Please try again later."
const MAIN_BC = { botSurface: "ussd", shopId: null, rail: "paystack", buyerPhone: ME }
const SHOP_BC = { botSurface: "ussd_shop", shopId: SHOP, rail: "paystack", buyerPhone: ME }

const ALL_BILLERS = [
  { key: "ecg", min: 1, max: 5000 },
  { key: "ghana_water", min: 1, max: 5000 },
  { key: "dstv", min: 5, max: 2000 },
  { key: "gotv", min: 5, max: 2000 },
  { key: "startimes", min: 5, max: 2000 },
  { key: "telecel_broadband", min: 10, max: 3000 },
] as Awaited<ReturnType<PayBillsDeps["billers"]>>
const BILLER_LIST = "Pay Bills\n1. ECG\n2. DStv\n3. GOtv\n4. StarTimes\n5. Telecel Broadband\n0. Back"
const ECG_MODE = "ECG\n1. This number\n2. Other number\n3. Meter number\n0. Back"

const meter = (i: number, over: Partial<{ meter: string; name: string | null; outstanding: number | null; token: string }> = {}) => ({
  meter: `P1234567${i}`, name: `K***${i} A***h`, outstanding: i === 1 ? 12.5 : null, token: `tok-m${i}`, ...over,
})

/** Meters linked per phone; DStv & co. verify to a masked name + due; consent links the meter. */
function defaultVerify(meters: Record<string, ReturnType<typeof meter>[]>) {
  return async (_bc: unknown, i: PbVerifyInput): Promise<VerifyResult> => {
    if (i.biller === "ecg" && i.addMeter) {
      return { ok: true, customerName: "N***a O***i", amountDue: null, suggestedAmount: 0, token: "tok-link" }
    }
    if (i.biller === "ecg") {
      const list = meters[i.phone ?? ""] ?? []
      return { ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters: list }
    }
    return { ok: true, customerName: "K***h M***h", amountDue: 120, suggestedAmount: 120, token: `tok-${i.biller}` }
  }
}

function setup(o: {
  surface?: "ussd" | "ussd_shop"; shopId?: string | null; shopName?: string
  billers?: PayBillsDeps["billers"]; verify?: PayBillsDeps["verify"]; quote?: PayBillsDeps["quote"]
  createOrder?: PayBillsDeps["createOrder"]; readOrder?: PayBillsDeps["readOrder"]; charge?: PayBillsDeps["charge"]
  findOrderId?: PayBillsDeps["findOrderId"]; meters?: Record<string, ReturnType<typeof meter>[]>
} = {}) {
  const surface = o.surface ?? "ussd"
  const shop = surface === "ussd_shop"
  const store = new Map<string, UzoBotSession>()
  const screens: UzoResponse[] = []
  const leave = vi.fn(async () => ({ message: "MENU", ussdServiceOp: 2 as const }))
  const deps = {
    io: {
      save: vi.fn(async (id: string, s: UzoBotSession) => { store.set(id, JSON.parse(JSON.stringify(s))) }),
      cont: shop ? shopCont : mainCont,
      end: shop ? shopEnd : mainEnd,
      leave,
    },
    billers: vi.fn(o.billers ?? (async () => ALL_BILLERS)),
    verify: vi.fn(o.verify ?? defaultVerify(o.meters ?? { [ME_LOCAL]: [meter(1), meter(2)] })),
    // Cashback 1% off face, paystack fee on top.
    quote: vi.fn(o.quote ?? (async (_bc: unknown, _b: unknown, face: number) => ({ payAmount: Math.round(face * 99) / 100 }))),
    createOrder: vi.fn(o.createOrder ?? (async (_bc: unknown, i: { amount: unknown; expectedPay: unknown }): Promise<BotOrderResult> => ({
      ok: true,
      order: { id: ORDER, reference: "R1", payAmount: i.expectedPay as number, faceAmount: i.amount as number, customerCashback: 0.5, paymentFee: 0 },
    }))),
    findOrderId: vi.fn(o.findOrderId ?? (async () => null)),
    readOrder: vi.fn(o.readOrder ?? (async () => ({ status: "pending", payment_status: "unpaid" }))),
    failOrder: vi.fn(async () => {}),
    charge: vi.fn(o.charge ?? (async (): Promise<BotChargeResult> => ({ ok: true, reference: "ref1", status: "pay_offline", promptedPhone: "0241234567" }))),
  }
  const ctx: UzoBotCtx = {
    surface, sessionId: SID, dialingPhone: ME,
    shopId: o.shopId === undefined ? (shop ? SHOP : null) : o.shopId,
    shopName: o.shopName ?? (shop ? "Ama Shop" : undefined),
  }
  const base: UzoBotSession = shop
    ? { step: "SELECT_PRODUCT", dialingPhone: ME, shopId: ctx.shopId ?? undefined, shopName: ctx.shopName, shopCodeId: "c1" }
    : { step: "MAIN", dialingPhone: ME }
  async function start() {
    const r = await startPayBills(ctx, base, deps as unknown as PayBillsDeps)
    screens.push(r)
    return r
  }
  async function send(...inputs: string[]) {
    let r!: UzoResponse
    for (const m of inputs) {
      r = await handlePayBillsStep(ctx, m, store.get(SID) ?? base, deps as unknown as PayBillsDeps)
      screens.push(r)
    }
    return r
  }
  const verifyCalls = () => deps.verify.mock.calls.map(c => c[1] as PbVerifyInput)
  return { deps, ctx, store, screens, start, send, leave, verifyCalls }
}

/** A screen the 160-char truncation did not touch: fits, no "...", footer intact. */
function whole(r: UzoResponse) {
  expect(fitsUzo(r.message)).toBe(true)
  expect(r.message.endsWith("...")).toBe(false)
  if (r.ussdServiceOp === 2 && r.message !== "MENU") expect(r.message).toMatch(/(0\. Back|2\. Cancel)$/)
}
const noProductWords = (r: UzoResponse) => expect(r.message).not.toMatch(/data|bundle|water/i)
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})

describe("pay bills: biller list", () => {
  it("lists the USSD billers in order; Ghana Water is never offered", async () => {
    const t = setup()
    expect(await t.start()).toEqual({ message: BILLER_LIST, ussdServiceOp: 2 })
    expect(t.store.get(SID)).toMatchObject({ step: "PB_BILLER" })
    expect(t.store.get(SID)?.pbBillers?.map(b => b.key)).toEqual(["ecg", "dstv", "gotv", "startimes", "telecel_broadband"])
  })

  it("none switched on (or only Ghana Water) => not available; a config read error => unavailable", async () => {
    const w = setup({ billers: async () => [{ key: "ghana_water", min: 1, max: 10 }] as Awaited<ReturnType<PayBillsDeps["billers"]>> })
    expect(await w.start()).toEqual({ message: "Not available right now.", ussdServiceOp: 17 })
    quiet()
    const e = setup({ billers: async () => { throw new Error("db down") } })
    expect(await e.start()).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
  })

  it("an invalid choice repaints; 0 leaves the flow", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("9")).message).toBe(BILLER_LIST)
    expect(await t.send("0")).toEqual({ message: "MENU", ussdServiceOp: 2 })
    expect(t.leave).toHaveBeenCalledTimes(1)
    const left = t.leave.mock.calls[0] as unknown as [UzoBotCtx, UzoBotSession]
    expect(left[1].pbBillers).toBeUndefined()
  })

  it("a session that still has a biller list never offers Ghana Water even if it was stored there", async () => {
    const t = setup()
    await t.start()
    t.store.set(SID, { ...t.store.get(SID)!, pbBillers: [{ key: "ghana_water", min: 1, max: 10 }] })
    expect((await t.send("1")).message).toContain("Pay Bills")
    expect(t.store.get(SID)?.step).toBe("PB_BILLER")
    expect(t.deps.verify).not.toHaveBeenCalled()
  })
})

describe("pay bills: shop vs main context", () => {
  it("shop: the biller list starts with the shop name; verify / quote / order / charge carry the shop", async () => {
    const t = setup({ surface: "ussd_shop" })
    expect((await t.start()).message).toBe(`Ama Shop\n${BILLER_LIST}`)
    const c = await t.send("2", "7012345678", "50")
    expect(c.message.startsWith("Ama Shop\nPay GHS 49.50 (was GHS 50.00)")).toBe(true)
    expect(await t.send("1")).toEqual({ message: SENT, ussdServiceOp: 17 })
    expect(t.deps.verify).toHaveBeenCalledWith(SHOP_BC, { biller: "dstv", account: "7012345678" })
    expect(t.deps.quote).toHaveBeenCalledWith(SHOP_BC, "dstv", 50)
    expect(t.deps.createOrder).toHaveBeenCalledWith(SHOP_BC, { token: "tok-dstv", amount: 50, expectedPay: 49.5 })
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bill", orderId: ORDER, botSurface: "ussd_shop", shopId: SHOP, dialingPhone: ME })
  })

  it("main: never a shop", async () => {
    const t = setup()
    await t.start()
    await t.send("2", "7012345678", "50", "1")
    expect(t.deps.verify).toHaveBeenCalledWith(MAIN_BC, { biller: "dstv", account: "7012345678" })
    expect(t.deps.createOrder).toHaveBeenCalledWith(MAIN_BC, { token: "tok-dstv", amount: 50, expectedPay: 49.5 })
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bill", orderId: ORDER, botSurface: "ussd", shopId: null, dialingPhone: ME })
  })

  it("shop menu without a resolved shop fails closed: nothing saved, nothing looked up", async () => {
    const t = setup({ surface: "ussd_shop", shopId: null })
    expect(await t.start()).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
    expect(t.store.size).toBe(0)
    expect((await t.send("1")).ussdServiceOp).toBe(17)
    expect(t.deps.billers).not.toHaveBeenCalled()
    expect(t.deps.verify).not.toHaveBeenCalled()
  })
})

describe("pay bills: ECG this number", () => {
  it("lists the dialler's meters (masked names, due), then amount (due hint), confirm, order, charge", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("1")).message).toBe(ECG_MODE)
    const list = await t.send("1")
    expect(list.message).toBe("Select meter:\n1. P12345671 Due:12.50 K***1 A***h\n2. P12345672 K***2 A***h\n0. Back")
    expect(t.verifyCalls()).toEqual([{ biller: "ecg", phone: ME_LOCAL }])
    const amount = await t.send("1")
    expect(amount.message).toBe("ECG P12345671\nName: K***1 A***h\nDue: GHS 12.50\nEnter amount (GHS 1.00 - 5000.00):\n0. Back")
    const c = await t.send("50")
    expect(c.message).toBe(`Pay GHS 49.50 (was GHS 50.00)\nYou get GHS 50.00 ECG on P12345671\nMoMo: ${ME_LOCAL}\n1. Confirm\n2. Cancel`)
    expect(await t.send("1")).toEqual({ message: SENT, ussdServiceOp: 17 })
    expect(t.deps.createOrder).toHaveBeenCalledWith(MAIN_BC, { token: "tok-m1", amount: 50, expectedPay: 49.5 })
    expect(t.deps.readOrder).toHaveBeenCalledWith(ORDER)
    expect(t.deps.charge).toHaveBeenCalledWith({ orderType: "cs_bill", orderId: ORDER, botSurface: "ussd", shopId: null, dialingPhone: ME })
    expect(t.deps.failOrder).not.toHaveBeenCalled()
  })

  it("pages a long meter list the Uzo way (More / 0 Back) and picks by the number shown", async () => {
    const t = setup({ meters: { [ME_LOCAL]: [1, 2, 3, 4, 5, 6, 7].map(i => meter(i)) } })
    await t.start()
    const p0 = await t.send("1", "1")
    expect(p0.message).toContain("6. More...")
    expect(p0.message.endsWith("0. Back")).toBe(true)
    const p1 = await t.send("6")
    expect(p1.message).toBe("Select meter:\n6. P12345676 K***6 A***h\n7. P12345677 K***7 A***h\n0. Back")
    expect(t.store.get(SID)?.pbPage).toBe(1)
    expect((await t.send("8")).message).toBe(p1.message) // "More" past the end repaints the last page
    expect((await t.send("0")).message).toBe(p0.message) // back a page
    await t.send("6", "7")
    expect(t.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbAccount: "P12345677", pbToken: "tok-m7" })
  })

  it("a stale page number is clamped; 0 on the first page goes back to the ECG choice", async () => {
    const t = setup({ meters: { [ME_LOCAL]: [1, 2, 3, 4, 5, 6, 7].map(i => meter(i)) } })
    await t.start()
    await t.send("1", "1")
    t.store.set(SID, { ...t.store.get(SID)!, pbPage: 9 })
    expect((await t.send("x")).message).toContain("6. P12345676")
    expect(t.store.get(SID)?.pbPage).toBe(1)
    await t.send("0")
    expect((await t.send("0")).message).toBe(ECG_MODE)
  })

  it("no meters linked: meter entry, type (informational), consent links it to this number only on 1", async () => {
    const t = setup({ meters: {} })
    await t.start()
    expect((await t.send("1", "1")).message).toBe(`No meters linked to ${ME_LOCAL}.\nEnter meter number:\n0. Back`)
    expect((await t.send("P99887766")).message).toBe("Meter P99887766\nMeter type:\n1. Prepaid\n2. Postpaid\n0. Back")
    const consent = await t.send("1")
    expect(consent.message).toBe(
      `Meter P99887766 is not linked to ${ME_LOCAL}.\n1. Yes, link meter P99887766 to ${ME_LOCAL}\n2. Cancel\n0. Back`,
    )
    // Nothing is linked yet: every lookup so far was read-only.
    expect(t.verifyCalls().some(i => i.addMeter || i.consent)).toBe(false)
    expect((await t.send("9")).message).toBe(consent.message) // anything else repaints, still nothing linked
    expect(t.verifyCalls().some(i => i.addMeter || i.consent)).toBe(false)
    const amount = await t.send("1")
    expect(t.verifyCalls().filter(i => i.addMeter)).toEqual([
      { biller: "ecg", phone: ME_LOCAL, account: "P99887766", addMeter: true, consent: true },
    ])
    expect(amount.message).toContain("Name: N***a O***i")
    expect(t.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbToken: "tok-link", pbMeterType: "prepaid" })
    const c = await t.send("20")
    expect(c.message).toContain("You get GHS 20.00 ECG Prepaid on P99887766")
  })

  it("consent: 2 cancels (nothing linked), 0 goes back to the meter type", async () => {
    const t = setup({ meters: {} })
    await t.start()
    await t.send("1", "1", "P99887766", "2")
    expect((await t.send("0")).message).toBe("Meter P99887766\nMeter type:\n1. Prepaid\n2. Postpaid\n0. Back")
    await t.send("2")
    expect(await t.send("2")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(t.verifyCalls().some(i => i.addMeter || i.consent)).toBe(false)
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })
})

describe("pay bills: ECG other number", () => {
  it("typed phone: validated, looked up; no meters => meter entry, postpaid, consent links to THAT phone", async () => {
    const t = setup({ meters: {} })
    await t.start()
    expect((await t.send("1", "2")).message).toBe("Enter the phone number linked to the meter:\n0. Back")
    expect((await t.send("123")).message).toBe("Invalid number.\nEnter the phone number linked to the meter:\n0. Back")
    expect((await t.send("055 123 4567")).message).toBe(`No meters linked to ${OTHER}.\nEnter meter number:\n0. Back`)
    await t.send("P55555555", "2")
    expect(t.store.get(SID)?.step).toBe("PB_CONSENT")
    await t.send("1")
    expect(t.verifyCalls().at(-1)).toEqual({ biller: "ecg", phone: OTHER, account: "P55555555", addMeter: true, consent: true })
    expect(t.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbMeterType: "postpaid" })
  })

  it("a phone with meters lists them", async () => {
    const t = setup({ meters: { [OTHER]: [meter(3)] } })
    await t.start()
    expect((await t.send("1", "2", OTHER)).message).toBe("Select meter:\n1. P12345673 K***3 A***h\n0. Back")
  })
})

describe("pay bills: ECG meter number", () => {
  it("a meter already linked to this number skips consent and uses its own token", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("1", "3")).message).toBe("Enter meter number:\n0. Back")
    const a = await t.send("p12345672", "1")
    expect(a.message.startsWith("ECG P12345672\nName: K***2 A***h\n")).toBe(true)
    expect(t.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbToken: "tok-m2", pbMeterType: "prepaid" })
    expect(t.verifyCalls().some(i => i.addMeter || i.consent)).toBe(false)
  })

  it("an unlinked meter goes to consent; an invalid meter number is refused", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("1", "3", "#!")).message).toBe("Enter a valid meter number.\nEnter meter number:\n0. Back")
    await t.send("P00000001", "2")
    expect(t.store.get(SID)?.step).toBe("PB_CONSENT")
  })
})

describe("pay bills: other billers", () => {
  it("DStv (a TV biller): smartcard, masked name + due, amount, confirm", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("2")).message).toBe("Enter smartcard number:\n0. Back")
    const a = await t.send("70 1234 5678")
    expect(a.message).toBe("DStv 7012345678\nName: K***h M***h\nDue: GHS 120.00\nEnter amount (GHS 5.00 - 2000.00):\n0. Back")
    const c = await t.send("120")
    expect(c.message).toBe(`Pay GHS 118.80 (was GHS 120.00)\nYou get GHS 120.00 DStv on 7012345678\nMoMo: ${ME_LOCAL}\n1. Confirm\n2. Cancel`)
    expect(await t.send("1")).toEqual({ message: SENT, ussdServiceOp: 17 })
  })

  it("StarTimes asks for the account number", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("4")).message).toBe("Enter account number:\n0. Back")
  })

  it("Telecel Broadband: landline, then broadband account; 0 on the account goes back to the landline", async () => {
    const t = setup()
    await t.start()
    expect((await t.send("5")).message).toBe("Enter the landline number (e.g. 0302450262):\n0. Back")
    expect((await t.send("12")).message).toBe("Enter the 10-digit landline.\nEnter the landline number (e.g. 0302450262):\n0. Back")
    expect((await t.send("0302450262")).message).toBe("Enter the broadband account number:\n0. Back")
    expect((await t.send("0")).message).toBe("Enter the landline number (e.g. 0302450262):\n0. Back")
    await t.send("0302450262", "P0444101")
    expect(t.verifyCalls().at(-1)).toEqual({ biller: "telecel_broadband", account: "0302450262", broadbandAccount: "P0444101" })
    expect(t.store.get(SID)?.step).toBe("PB_AMOUNT")
  })
})

describe("pay bills: amount", () => {
  it("outside the biller's limits or not a number => refused with the range; no quote", async () => {
    const t = setup()
    await t.start()
    await t.send("2", "7012345678")
    for (const bad of ["4.99", "2000.01", "abc", "1.234", "0.00", "-5"]) {
      const r = await t.send(bad)
      expect(r.message.startsWith("Enter an amount from GHS 5.00 to GHS 2000.00.\nDStv 7012345678")).toBe(true)
      whole(r)
      expect(t.store.get(SID)?.step).toBe("PB_AMOUNT")
    }
    expect(t.deps.quote).not.toHaveBeenCalled()
    await t.send("5")
    expect(t.store.get(SID)).toMatchObject({ step: "PB_CONFIRM", pbFace: 5, pbPay: 4.95 })
  })

  it("no '(was ...)' when the price is not below face", async () => {
    const t = setup({ quote: async (_bc, _b, face) => ({ payAmount: face + 1 }) })
    await t.start()
    const c = await t.send("2", "7012345678", "50")
    expect(c.message.startsWith("Pay GHS 51.00\n")).toBe(true)
  })

  it("a quote failure ends the session; 0 on the amount goes back to the billers", async () => {
    quiet()
    const t = setup({ quote: async () => { throw new Error("cfg") } })
    await t.start()
    expect(await t.send("2", "7012345678", "50")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
    const b = setup()
    await b.start()
    await b.send("2", "7012345678")
    expect((await b.send("0")).message).toBe(BILLER_LIST)
    expect(b.store.get(SID)?.pbToken).toBeUndefined()
  })

  it("amountScreen: a long name is shortened, then dropped, then the account; prompt + 0. Back always whole", () => {
    const s = { pbBiller: "dstv", pbAccount: "A".repeat(30), pbName: "N".repeat(40), pbDue: 1234.56, pbMin: 5, pbMax: 2000 }
    for (const prefix of ["", "Enter an amount from GHS 5.00 to GHS 2000.00.\n"]) {
      const r = pbAmountScreen(s, prefix)
      expect(fitsUzo(r)).toBe(true)
      expect(r.endsWith("Enter amount (GHS 5.00 - 2000.00):\n0. Back")).toBe(true)
    }
  })
})

describe("pay bills: verify errors (fixed text, never the provider's)", () => {
  const SECRET = "Hubtel: ECG backend 0x55 secret provider text"
  it("422 => retry the same entry with fixed text; 400 => 'Invalid details'", async () => {
    for (const [status, text] of [[422, "Could not verify this account. Check and try again."], [400, "Invalid details. Check and try again."]] as const) {
      const t = setup({ verify: async () => ({ ok: false, status, error: SECRET }) })
      await t.start()
      const r = await t.send("2", "7012345678")
      expect(r).toEqual({ message: `${text}\nEnter smartcard number:\n0. Back`, ussdServiceOp: 2 })
      expect(t.store.get(SID)?.step).toBe("PB_ACCOUNT")
    }
  })

  it("ECG lookup on this number fails (422) => back on the ECG choice with fixed text", async () => {
    const t = setup({ verify: async () => ({ ok: false, status: 422, error: SECRET }) })
    await t.start()
    expect((await t.send("1", "1")).message).toBe(`Could not verify this account. Check and try again.\n${ECG_MODE}`)
  })

  it.each([
    [429, "Too many attempts. Please try later."],
    [403, "Not available right now."],
    [503, UNAVAILABLE],
    [500, UNAVAILABLE],
  ])("%i ends with '%s'", async (status, text) => {
    const t = setup({ verify: async () => ({ ok: false, status, error: SECRET }) })
    await t.start()
    expect(await t.send("2", "7012345678")).toEqual({ message: text, ussdServiceOp: 17 })
  })

  it("a throwing verify, or an ok result without a token, ends with the unavailable text", async () => {
    quiet()
    const t = setup({ verify: async () => { throw new Error(SECRET) } })
    await t.start()
    expect(await t.send("2", "7012345678")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
    const n = setup({ verify: async () => ({ ok: true, customerName: "x", amountDue: null, suggestedAmount: 0 }) })
    await n.start()
    expect(await n.send("2", "7012345678")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
  })

  it("consent lookup failure never links and shows fixed text on the meter entry", async () => {
    const t = setup({
      meters: {},
      verify: async (_bc, i) => (i.addMeter ? { ok: false, status: 422, error: SECRET } : defaultVerify({})(_bc, i)),
    })
    await t.start()
    const r = await t.send("1", "1", "P99887766", "1", "1")
    expect(r.message).toBe("Could not verify this account. Check and try again.\nEnter meter number:\n0. Back")
  })
})

describe("pay bills: confirm + pay", () => {
  async function toConfirm(t: ReturnType<typeof setup>) {
    await t.start()
    return t.send("2", "7012345678", "50")
  }

  it.each([
    [409, "Price changed. Please try again."],
    [429, "Too many attempts. Please try later."],
    [403, "Not available right now."],
    [400, UNAVAILABLE],
    [503, UNAVAILABLE],
  ])("engine %i => '%s', nothing charged, never the engine text", async (status, text) => {
    const t = setup({ createOrder: async () => ({ ok: false, status, error: "Hubtel said: secret provider text" }) })
    await toConfirm(t)
    expect(await t.send("1")).toEqual({ message: text, ussdServiceOp: 17 })
    expect(t.deps.readOrder).not.toHaveBeenCalled()
    expect(t.deps.charge).not.toHaveBeenCalled()
  })

  it("engine replay (same verify token) at another price or face => 'Price changed', nothing read back or charged", async () => {
    quiet()
    for (const order of [
      { id: ORDER, reference: "R0", payAmount: 60, faceAmount: 50, customerCashback: 0, paymentFee: 0 },
      { id: ORDER, reference: "R0", payAmount: 49.5, faceAmount: 80, customerCashback: 0, paymentFee: 0 },
    ]) {
      const t = setup({ createOrder: async () => ({ ok: true, order }) })
      await toConfirm(t)
      expect(await t.send("1")).toEqual({ message: "Price changed. Please try again.", ussdServiceOp: 17 })
      expect(t.deps.readOrder).not.toHaveBeenCalled()
      expect(t.deps.charge).not.toHaveBeenCalled()
      expect(t.deps.failOrder).not.toHaveBeenCalled()
    }
  })

  it("read-back not pending+unpaid => refusal, no charge, the order left alone", async () => {
    quiet()
    for (const row of [{ status: "pending", payment_status: "paid" }, { status: "failed", payment_status: "unpaid" }]) {
      const t = setup({ readOrder: async () => row })
      await toConfirm(t)
      expect(await t.send("1")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
      expect(t.deps.charge).not.toHaveBeenCalled()
      expect(t.deps.failOrder).not.toHaveBeenCalled()
    }
  })

  it("read-back error / no row => the order is failed (guarded), no charge", async () => {
    quiet()
    for (const readOrder of [async () => null, async () => { throw new Error("read") }]) {
      const t = setup({ readOrder })
      await toConfirm(t)
      expect((await t.send("1")).message).toBe(UNAVAILABLE)
      expect(t.deps.charge).not.toHaveBeenCalled()
      expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
    }
  })

  it("charge throws => guarded fail of the order and a friendly text", async () => {
    quiet()
    const t = setup({ charge: async () => { throw new Error("paystack 500: raw") } })
    await toConfirm(t)
    expect(await t.send("1")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
    expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
  })

  it("charge refusals show their own buyer text", async () => {
    const t = setup({ charge: async () => ({ ok: false, code: "NO_PROVIDER", message: "Payment not available for your number." }) })
    await toConfirm(t)
    expect(await t.send("1")).toEqual({ message: "Payment not available for your number.", ussdServiceOp: 17 })
  })

  it("engine throws: an order committed from this verify token is failed (guarded); nothing charged", async () => {
    quiet()
    const t = setup({ createOrder: async () => { throw new Error("db") }, findOrderId: async () => ORDER })
    await toConfirm(t)
    expect((await t.send("1")).message).toBe(UNAVAILABLE)
    expect(t.deps.findOrderId).toHaveBeenCalledWith(MAIN_BC, "tok-dstv")
    expect(t.deps.failOrder).toHaveBeenCalledWith(ORDER)
    expect(t.deps.charge).not.toHaveBeenCalled()
    const n = setup({ createOrder: async () => { throw new Error("db") }, findOrderId: async () => { throw new Error("read") } })
    await toConfirm(n)
    expect((await n.send("1")).message).toBe(UNAVAILABLE)
    expect(n.deps.failOrder).not.toHaveBeenCalled()
  })

  it("2 cancels; 0 goes back to the amount; anything else repaints the confirm screen", async () => {
    const t = setup()
    const c = await toConfirm(t)
    expect((await t.send("9")).message).toBe(c.message)
    expect((await t.send("0")).message.startsWith("DStv 7012345678\n")).toBe(true)
    await t.send("50")
    expect(await t.send("2")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })

  it("a confirm without a verified token / price never orders", async () => {
    const t = setup()
    await toConfirm(t)
    t.store.set(SID, { ...t.store.get(SID)!, pbToken: undefined })
    expect(await t.send("1")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })
})

describe("pay bills: every screen fits 160 with its footer, and never says data/bundle/water", () => {
  const longName = "Bundle Data Akwasi-Kwabena Oppong-Mensah Enterprises Ltd"
  for (const surface of ["ussd", "ussd_shop"] as const) {
    it(`${surface}: every path, long names and accounts`, async () => {
      const longMeters = [1, 2, 3, 4, 5, 6].map(i => meter(i, { meter: `${i}`.repeat(13), name: longName, outstanding: 1234.56 }))
      const t = setup({
        surface, shopName: "The Very Long Shop Name Enterprises Limited Ghana",
        meters: { [ME_LOCAL]: longMeters },
        verify: async (bc, i) => {
          const r = await defaultVerify({ [ME_LOCAL]: longMeters })(bc, i)
          return r.ok && !r.meters ? { ...r, customerName: longName, amountDue: 1234.56 } : r
        },
      })
      await t.start()
      // ECG this number, page 2, back, pick, bad amount, confirm, back, pay.
      await t.send("x", "1", "x", "1", "6", "x", "0", "1", "abc", "4999.99", "x", "0", "4999.99", "1")
      // ECG other number + meter number + consent, DStv, StarTimes, Telecel Broadband.
      const u = setup({ surface, shopName: "The Very Long Shop Name Enterprises Limited Ghana", meters: {}, verify: t.deps.verify })
      await u.start()
      await u.send("1", "2", "1", "0551234567", "x", "0", "3", "X".repeat(30), "x", "1", "x", "0", "2", "1", "0")
      await u.send("0", "0", "0", "2", "1", "0", "4", "7".repeat(30), "100", "2")
      const v = setup({ surface, meters: {}, verify: t.deps.verify })
      await v.start()
      await v.send("5", "0302450262", "x", "P0444101", "100", "1")
      const all = [...t.screens, ...u.screens, ...v.screens]
      expect(all.length).toBeGreaterThan(35)
      for (const r of all) {
        whole(r)
        noProductWords(r)
      }
    })
  }
})

describe("pay bills: meter list keeps the due amount whole", () => {
  it("'Due:<amount>' is one token: shown whole or dropped, never a bare 'Due' or a cut amount", async () => {
    let seenDue = 0
    let seenCut = 0
    for (let ml = 8; ml <= 22; ml++) {
      for (let nl = 0; nl <= 30; nl += 3) {
        const name = nl ? "Kofi Mensah Akwasi Oppong Ltd".slice(0, nl) : null
        const meters = [1, 2, 3, 4, 5].map(i => meter(i, { meter: `${i}`.repeat(ml), name, outstanding: 111.11 }))
        const t = setup({ meters: { [ME_LOCAL]: meters } })
        await t.start()
        const r = await t.send("1", "1")
        whole(r)
        for (const line of r.message.split("\n").filter(l => /^\d\. \d/.test(l))) {
          expect(line).not.toMatch(/Due$/)
          expect(line).not.toMatch(/Due(?!:111\.11(?: |$))/)
          if (line.includes("Due:111.11")) seenDue++
          else seenCut++
        }
      }
    }
    // Both cases happen across the sweep (shown whole, and dropped whole).
    expect(seenDue).toBeGreaterThan(0)
    expect(seenCut).toBeGreaterThan(0)
  })
})

describe("pay bills: the flow is closed once the engine was called", () => {
  for (const surface of ["ussd", "ussd_shop"] as const) {
    it(`${surface}: success, refusal or a throw all close it: no token left, a replayed 1 / 0 never orders again`, async () => {
      quiet()
      for (const createOrder of [
        undefined,
        async (): Promise<BotOrderResult> => ({ ok: false, status: 503, error: "x" }),
        async (): Promise<BotOrderResult> => { throw new Error("db") },
      ]) {
        const t = setup({ surface, ...(createOrder ? { createOrder } : {}) })
        await t.start()
        await t.send("2", "7012345678", "50", "1")
        const s = t.store.get(SID)!
        expect(s.step).toBe(surface === "ussd_shop" ? "SELECT_PRODUCT" : "MAIN")
        expect(s.pbToken).toBeUndefined()
        expect(s.pbMeters).toBeUndefined()
        if (surface === "ussd_shop") expect(s).toMatchObject({ shopId: SHOP, shopName: "Ama Shop", shopCodeId: "c1" })
        expect(await t.send("1")).toEqual({ message: "MENU", ussdServiceOp: 2 })
        await t.send("0")
        expect(t.deps.createOrder).toHaveBeenCalledTimes(1)
      }
    })
  }

  it("cancel (2) before ordering also leaves nothing to order with", async () => {
    const t = setup()
    await t.start()
    await t.send("2", "7012345678", "50")
    expect(t.store.get(SID)?.pbToken).toBe("tok-dstv")
    expect(await t.send("2")).toEqual({ message: "Order cancelled.", ussdServiceOp: 17 })
    expect(t.deps.createOrder).not.toHaveBeenCalled()
  })
})

describe("pay bills: verify token expired at confirm", () => {
  it("the engine's expired-token 400 shows a start-again hint; any other 400 stays generic", async () => {
    const t = setup({ createOrder: async () => ({ ok: false, status: 400, error: BOT_BILL_TOKEN_EXPIRED }) })
    await t.start()
    await t.send("2", "7012345678", "50")
    expect(await t.send("1")).toEqual({ message: UZO_BOT_RESTART, ussdServiceOp: 17 })
    expect(t.deps.charge).not.toHaveBeenCalled()
    const o = setup({ createOrder: async () => ({ ok: false, status: 400, error: "Amount out of range" }) })
    await o.start()
    await o.send("2", "7012345678", "50")
    expect(await o.send("1")).toEqual({ message: UNAVAILABLE, ussdServiceOp: 17 })
  })
})

describe("pay bills: meter session shape", () => {
  it("the stored meter list carries only meter, masked name, due and token", async () => {
    const t = setup()
    await t.start()
    await t.send("1", "1")
    const meters = t.store.get(SID)?.pbMeters as UzoPbMeter[]
    expect(meters[0]).toEqual({ m: "P12345671", n: "K***1 A***h", o: 12.5, t: "tok-m1" })
  })
})
