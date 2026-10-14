// lib/ussd-hubtel/flows/pay-bills.test.ts
import { describe, it, expect, vi } from "vitest"
import { hubtelRouter } from "../router"
import { BOT_ORDER_ID, fakePayBills, fakeShop, fakeSupabase, makeDeps, req, SHOP_CONFIG } from "../testing/fakes"
import { consentScreen, payBillConfirmText, PB_TEXT, startPayBills } from "./pay-bills"
import { USSD_SCREEN_LIMIT } from "../protocol"
import type { HubtelReply, HubtelSession } from "../types"
import type { FlowCtx } from "../flow-kit"

const SID = "3c796dac28174f739de4262d08409c51"
const ME = "+233244123456" // 0244123456 has two ECG meters in the fake
const SHOP_UUID = "11111111-2222-4333-8444-555555555555"
const OPEN_ROW = { id: BOT_ORDER_ID, status: "pending", payment_status: "unpaid" }
const MAIN_CTX = { botSurface: "hubtel_ussd", shopId: null, rail: "hubtel", buyerPhone: ME }

type Setup = ReturnType<typeof makeDeps> & { pb: ReturnType<typeof fakePayBills> }

function setup(opts: { pb?: Parameters<typeof fakePayBills>[0]; sup?: ReturnType<typeof fakeSupabase>; session?: Partial<HubtelSession>; shop?: boolean } = {}): Setup {
  const pb = fakePayBills(opts.pb)
  const sup = opts.sup ?? fakeSupabase({ rows: { hubtel_bill_orders: OPEN_ROW } })
  const made = makeDeps({ payBills: pb, ...(opts.shop ? { getConfig: SHOP_CONFIG, shop: fakeShop() } : {}) }, sup)
  made.store.set(SID, { mode: "main", step: "MAIN", dialingPhone: ME, platform: "USSD", ...opts.session })
  return { ...made, pb }
}

const all: HubtelReply[] = []
async function begin(s: Setup): Promise<HubtelReply> {
  const ctx: FlowCtx = { input: "", req: req({ SessionId: SID }), deps: s.deps, config: await s.deps.getConfig(), session: s.store.get(SID)! }
  const r = await startPayBills(ctx)
  all.push(r)
  return r
}
async function send(s: Setup, ...inputs: string[]): Promise<HubtelReply> {
  let r!: HubtelReply
  for (const m of inputs) {
    r = await hubtelRouter(req({ SessionId: SID, Message: m }), s.deps)
    all.push(r)
  }
  return r
}
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {})

/** ECG, this number, first linked meter, GHS 50 => confirm. */
async function ecgToConfirm(s: Setup) {
  await begin(s)
  return send(s, "1", "1", "1", "50")
}
/** DStv smartcard => confirm at GHS 45.50. */
async function dstvToConfirm(s: Setup) {
  await begin(s)
  return send(s, "2", "7012345678", "45.50")
}

describe("pay bills: biller list", () => {
  it("lists the USSD billers; Ghana Water is never offered", async () => {
    const s = setup()
    const r = await begin(s)
    expect(r.Message).toBe("Pay Bills\n1. ECG\n2. DStv\n3. GOtv\n4. StarTimes\n5. Telecel Broadband\n0. Back")
    expect(r.Message).not.toMatch(/water/i)
    expect(s.store.get(SID)?.pbBillers?.map(b => b.key)).toEqual(["ecg", "dstv", "gotv", "startimes", "telecel_broadband"])
  })
  it("only billers that are switched on are listed; none (or only Ghana Water) => not available", async () => {
    const some = setup({ pb: { billers: async () => [{ key: "gotv", min: 5, max: 500 }, { key: "ecg", min: 1, max: 1000 }] } })
    expect((await begin(some)).Message).toBe("Pay Bills\n1. GOtv\n2. ECG\n0. Back")
    const water = setup({ pb: { billers: async () => [{ key: "ghana_water", min: 1, max: 1000 }] } })
    const r = await begin(water)
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(PB_TEXT.notAvailable)
  })
  it("a config read failure ends the session", async () => {
    const s = setup({ pb: { billers: async () => { throw new Error("db down") } } })
    quiet()
    const r = await begin(s)
    vi.restoreAllMocks()
    expect(r.Message).toBe(PB_TEXT.unavailable)
  })
  it("an invalid choice repaints; '0' goes back to the main menu", async () => {
    const s = setup()
    const list = await begin(s)
    expect((await send(s, "9")).Message).toBe(list.Message)
    const back = await hubtelRouter(req({ SessionId: SID, Message: "0" }), s.deps) // main menu: not this flow's screen
    expect(back.Message).toContain("Welcome to Clingshub")
  })
})

describe("pay bills: ECG this number", () => {
  it("lists the phone's meters (masked names, due), then amount, then confirm", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "1")).Message).toBe("ECG\n1 This number\n2 Other number\n3 Meter number\n0 Back")
    const meters = await send(s, "1")
    expect(s.pb.calls.verify).toEqual([{ ctx: MAIN_CTX, input: { biller: "ecg", phone: "0244123456" } }])
    expect(meters.Message).toBe("Select meter:\n1. P1234567 Kof*** Men*** Due GHS 12.50\n2. P7654321\n00 Back")
    const amount = await send(s, "1")
    expect(amount.Message).toBe("ECG P1234567\nName: Kof*** Men***\nDue: GHS 12.50\nEnter amount (GHS 1.00 - 1000.00):\n0 Back")
    const c = await send(s, "50")
    expect(s.pb.calls.quote).toEqual([{ ctx: MAIN_CTX, biller: "ecg", face: 50 }])
    expect(c.Message).toBe("Pay GHS 49.00 (was GHS 50.00)\nYou receive GHS 50.00 ECG on P1234567\n1 Confirm 2 Cancel")
    expect(s.store.get(SID)).toMatchObject({ step: "PB_CONFIRM", pbToken: "tok-ecg-P1234567", pbFace: 50, pbPay: 49 })
  })
  it("confirm: one engine order, tx row + AddToCart at payAmount, opaque cart name", async () => {
    const s = setup()
    await ecgToConfirm(s)
    const r = await send(s, "1")
    expect(s.pb.calls.create).toEqual([{ ctx: MAIN_CTX, input: { token: "tok-ecg-P1234567", amount: 50, expectedPay: 49 } }])
    expect(s.sup.inserts.hubtel_bill_orders).toBeUndefined()
    expect(s.sup.inserts.hubtel_transactions).toEqual([{
      session_id: SID, platform: "USSD", order_table: "hubtel_bill_orders", order_id: BOT_ORDER_ID, mobile: ME, expected_amount: 49,
    }])
    expect(r.Type).toBe("AddToCart")
    expect(r.Item).toEqual({ ItemName: "CH order 22222222", Qty: 1, Price: 49 })
    expect(s.store.has(SID)).toBe(false)
  })
  it("pages a long meter list 5 per screen with 0 Next / 00 Back", async () => {
    const meters = Array.from({ length: 7 }, (_, i) => ({ meter: `M00000${i}`, name: null, outstanding: null, token: `t${i}` }))
    const s = setup({ pb: { verify: async () => ({ ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters }) } })
    await begin(s)
    const p1 = await send(s, "1", "1")
    expect(p1.Message).toBe("Select meter:\n1. M000000\n2. M000001\n3. M000002\n4. M000003\n5. M000004\n0 Next\n00 Back")
    const p2 = await send(s, "0")
    expect(p2.Message).toBe("Select meter:\n1. M000005\n2. M000006\n00 Back")
    expect((await send(s, "00")).Message).toBe(p1.Message)
    await send(s, "0", "2")
    expect(s.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbAccount: "M000006", pbToken: "t6" })
  })
  it("'00' on the first meter page goes back to the ECG choice", async () => {
    const s = setup()
    await begin(s)
    await send(s, "1", "1")
    expect((await send(s, "00")).Message).toContain("1 This number")
    expect(s.store.get(SID)?.step).toBe("PB_ECG_MODE")
  })
  it("no linked meters: meter entry, type, consent to link to this number", async () => {
    const s = setup({ session: { dialingPhone: "+233201234567" } })
    await begin(s)
    const entry = await send(s, "1", "1")
    expect(entry.Message).toBe("No meters linked to 0201234567.\nEnter meter number:\n0 Back")
    expect((await send(s, "P5555555")).Message).toBe("Meter P5555555\nMeter type:\n1 Prepaid\n2 Postpaid\n0 Back")
    const consent = await send(s, "1")
    expect(consent.Message).toBe("Meter P5555555 is not linked to 0201234567.\n1 Yes, link meter P5555555 to 0201234567\n2 Cancel\n0 Back")
    expect(s.pb.calls.verify).toHaveLength(1) // the phone was already looked up
  })
})

describe("pay bills: ECG other number", () => {
  it("typed phone: validated, looked up, no meters => meter, postpaid, consent, amount, confirm", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "1", "2")).Message).toBe("Enter the phone number linked to the meter:\n0 Back")
    expect((await send(s, "12")).Message).toBe("Invalid number. Enter a valid Ghana phone number.\nEnter the phone number linked to the meter:\n0 Back")
    expect(s.pb.calls.verify).toHaveLength(0)
    const entry = await send(s, "020 123 4567")
    expect(s.pb.calls.verify[0].input).toEqual({ biller: "ecg", phone: "0201234567" })
    expect(entry.Message).toBe("No meters linked to 0201234567.\nEnter meter number:\n0 Back")
    expect((await send(s, "x")).Message).toBe("Enter a valid meter number.\nEnter meter number:\n0 Back")
    await send(s, "P9999999", "2")
    const amount = await send(s, "1")
    expect(s.pb.calls.verify[1]).toEqual({ ctx: MAIN_CTX, input: { biller: "ecg", phone: "0201234567", account: "P9999999", addMeter: true, consent: true } })
    expect(amount.Message).toBe("ECG P9999999\nEnter amount (GHS 1.00 - 1000.00):\n0 Back")
    const c = await send(s, "20")
    expect(c.Message).toBe("Pay GHS 19.60 (was GHS 20.00)\nYou receive GHS 20.00 ECG Postpaid on P9999999\n1 Confirm 2 Cancel")
    await send(s, "1")
    expect(s.pb.calls.create[0].input).toEqual({ token: "tok-ecg-P9999999", amount: 20, expectedPay: 19.6 })
  })
  it("a phone with meters lists them", async () => {
    const s = setup({ session: { dialingPhone: "+233201234567" } })
    await begin(s)
    const r = await send(s, "1", "2", "0244123456")
    expect(r.Message).toContain("1. P1234567 Kof*** Men***")
    expect(s.store.get(SID)).toMatchObject({ step: "PB_METERS", pbPhone: "0244123456", pbEcgMode: "other" })
  })
})

describe("pay bills: ECG meter number", () => {
  it("a meter already linked to this number skips consent (its own token)", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "1", "3")).Message).toBe("Enter meter number:\n0 Back")
    await send(s, "p1234567")
    const amount = await send(s, "1")
    expect(s.pb.calls.verify).toEqual([{ ctx: MAIN_CTX, input: { biller: "ecg", phone: "0244123456" } }])
    expect(amount.Message.startsWith("ECG P1234567\nName: Kof*** Men***")).toBe(true)
    const c = await send(s, "10")
    expect(c.Message).toBe("Pay GHS 9.80 (was GHS 10.00)\nYou receive GHS 10.00 ECG Prepaid on P1234567\n1 Confirm 2 Cancel")
    expect(s.store.get(SID)?.pbToken).toBe("tok-ecg-P1234567")
  })
  it("an unlinked meter gets the consent screen; 1 links it, 2 cancels, 0 goes back to the type", async () => {
    const s = setup()
    await begin(s)
    const consent = await send(s, "1", "3", "P5555555", "1")
    expect(consent.Message).toBe(consentScreen("P5555555", "0244123456"))
    expect(consent.Message).toContain("1 Yes, link meter P5555555 to 0244123456")
    expect((await send(s, "0")).Message).toContain("Meter type:")
    await send(s, "1")
    await send(s, "1")
    expect(s.pb.calls.verify.at(-1)?.input).toEqual({ biller: "ecg", phone: "0244123456", account: "P5555555", addMeter: true, consent: true })
    expect(s.store.get(SID)).toMatchObject({ step: "PB_AMOUNT", pbToken: "tok-ecg-P5555555", pbMeterType: "prepaid" })

    const no = setup()
    await begin(no)
    const r = await send(no, "1", "3", "P5555555", "1", "2")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(PB_TEXT.cancelled)
    expect(no.pb.calls.verify).toHaveLength(1)
  })
})

describe("pay bills: other billers", () => {
  it("DStv: smartcard, verify (masked name, due), amount, confirm, order", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "2")).Message).toBe("Enter smartcard number:\n0 Back")
    expect((await send(s, "12")).Message).toBe("Invalid details. Check and try again.\nEnter smartcard number:\n0 Back")
    expect(s.pb.calls.verify).toHaveLength(0)
    const amount = await send(s, "7012345678")
    expect(s.pb.calls.verify).toEqual([{ ctx: MAIN_CTX, input: { biller: "dstv", account: "7012345678" } }])
    expect(amount.Message).toBe("DStv 7012345678\nName: Ama*** Ser***\nDue: GHS 45.50\nEnter amount (GHS 1.00 - 1000.00):\n0 Back")
    const c = await send(s, "45.50")
    expect(c.Message).toBe("Pay GHS 44.59 (was GHS 45.50)\nYou receive GHS 45.50 DStv on 7012345678\n1 Confirm 2 Cancel")
    const r = await send(s, "1")
    expect(s.pb.calls.create).toEqual([{ ctx: MAIN_CTX, input: { token: "tok-dstv-7012345678", amount: 45.5, expectedPay: 44.59 } }])
    expect(r.Item?.Price).toBe(44.59)
  })
  it("StarTimes asks for the account number", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "4")).Message).toBe("Enter account number:\n0 Back")
  })
  it("Telecel Broadband: landline then broadband account", async () => {
    const s = setup()
    await begin(s)
    expect((await send(s, "5")).Message).toBe("Enter the landline number (e.g. 0302450262):\n0 Back")
    expect((await send(s, "302")).Message).toContain("Enter the 10-digit landline.")
    expect((await send(s, "0302450262")).Message).toBe("Enter the broadband account number:\n0 Back")
    expect((await send(s, "0")).Message).toContain("Enter the landline number")
    await send(s, "0302450262")
    const amount = await send(s, "P0444101")
    expect(s.pb.calls.verify).toEqual([{ ctx: MAIN_CTX, input: { biller: "telecel_broadband", account: "0302450262", broadbandAccount: "P0444101" } }])
    expect(amount.Message.startsWith("Telecel Broadband 0302450262\n")).toBe(true)
  })
  it("amount outside the biller's limits (or not a number) is refused with the range", async () => {
    const s = setup({ pb: { billers: async () => [{ key: "dstv", min: 5, max: 200 }] } })
    await begin(s)
    await send(s, "1", "7012345678")
    for (const bad of ["4.99", "200.01", "abc", "1e3", "-5", "10.123"]) {
      const r = await send(s, bad)
      expect(r.Message.startsWith("Enter an amount from GHS 5.00 to GHS 200.00.\n")).toBe(true)
    }
    expect(s.pb.calls.quote).toHaveLength(0)
    expect((await send(s, "200")).Message).toContain("Pay GHS 196.00 (was GHS 200.00)")
  })
  it("'0' on the amount goes back to the biller list", async () => {
    const s = setup()
    await begin(s)
    await send(s, "2", "7012345678")
    expect((await send(s, "0")).Message.startsWith("Pay Bills\n1. ECG")).toBe(true)
    expect(s.store.get(SID)).toMatchObject({ step: "PB_BILLER", pbToken: undefined, pbBiller: undefined })
  })
  it("no '(was …)' when the price is not below face", async () => {
    const s = setup({ pb: { quote: async (_c, _b, face) => ({ applied: false, faceAmount: face, payAmount: face }) as any } })
    const c = await dstvToConfirm(s)
    expect(c.Message).toBe("Pay GHS 45.50\nYou receive GHS 45.50 DStv on 7012345678\n1 Confirm 2 Cancel")
  })
  it("a quote failure ends the session", async () => {
    const s = setup({ pb: { quote: async () => { throw new Error("cfg") } } })
    quiet()
    const r = await dstvToConfirm(s)
    vi.restoreAllMocks()
    expect(r.Message).toBe(PB_TEXT.unavailable)
  })
})

describe("pay bills: verify errors (fixed text, never the provider's)", () => {
  const RAW = "Couldn't verify this account: PROVIDER SECRET 0xdead"
  it("422 => retry screen on the same entry", async () => {
    const s = setup({ pb: { verify: async () => ({ ok: false, status: 422, error: RAW }) } })
    await begin(s)
    const r = await send(s, "2", "7012345678")
    expect(r.Type).not.toBe("release")
    expect(r.Message).toBe("Could not verify this account. Check and try again.\nEnter smartcard number:\n0 Back")
    expect(s.store.get(SID)?.step).toBe("PB_ACCOUNT")
  })
  it("400 on the ECG lookup => back on the ECG choice with fixed text", async () => {
    const s = setup({ pb: { verify: async () => ({ ok: false, status: 400, error: RAW }) } })
    await begin(s)
    const r = await send(s, "1", "1")
    expect(r.Message).toBe("Invalid details. Check and try again.\nECG\n1 This number\n2 Other number\n3 Meter number\n0 Back")
  })
  it.each([
    [429, "Too many attempts. Please try later."],
    [403, "Not available right now."],
    [503, "Service unavailable. Please try again later."],
    [500, "Service unavailable. Please try again later."],
  ])("verify %i => ends with friendly text", async (status, text) => {
    const s = setup({ pb: { verify: async () => ({ ok: false, status, error: RAW }) } })
    await begin(s)
    const r = await send(s, "2", "7012345678")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(text)
    expect(r.Message).not.toContain("SECRET")
  })
  it("a throwing verify ends with the unavailable text", async () => {
    const s = setup({ pb: { verify: async () => { throw new Error("PROVIDER SECRET") } } })
    await begin(s)
    quiet()
    const r = await send(s, "1", "3", "P5555555", "1")
    vi.restoreAllMocks()
    expect(r.Message).toBe(PB_TEXT.unavailable)
  })
})

describe("pay bills: confirm", () => {
  it("carts at the engine's payAmount", async () => {
    const s = setup({ pb: { createResult: { ok: true, order: { id: BOT_ORDER_ID, reference: "BILL-1", payAmount: 48.99, faceAmount: 50, customerCashback: 1.01, paymentFee: 0 } } } })
    await ecgToConfirm(s)
    const r = await send(s, "1")
    expect(r.Item?.Price).toBe(48.99)
    expect(s.sup.inserts.hubtel_transactions?.[0].expected_amount).toBe(48.99)
  })
  it("idempotent: a repeated confirm never makes a second order", async () => {
    const s = setup()
    await ecgToConfirm(s)
    const stale = s.store.get(SID)!
    const first = await send(s, "1")
    s.store.set(SID, stale)
    const again = await send(s, "1")
    const lost = await send(s, "1")
    expect(s.pb.calls.create).toHaveLength(1)
    expect(s.sup.inserts.hubtel_transactions).toHaveLength(1)
    expect(again).toEqual(first)
    expect(lost).toEqual(first)
  })
  it.each([
    [409, "Price updated — please review", "Price changed. Please try again."],
    [429, "Too many requests. Please try again later.", "Too many attempts. Please try later."],
    [403, "This biller is not available here", "Not available right now."],
    [503, "Temporarily unavailable", "Service unavailable. Please try again later."],
    [400, "Please verify the account again", "Service unavailable. Please try again later."],
  ])("engine %i => friendly text, session ended, no tx row", async (status, error, literal) => {
    const s = setup({ pb: { createResult: { ok: false, status, error } } })
    await ecgToConfirm(s)
    const r = await send(s, "1")
    expect(r.Type).toBe("release")
    expect(r.Message).toBe(literal)
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
    expect(s.store.has(SID)).toBe(false)
  })
  it.each([
    ["failed", "unpaid"],
    ["pending", "paid"],
    ["completed", "paid"],
  ])("an engine-returned order that is %s/%s is never carted", async (status, payment_status) => {
    const sup = fakeSupabase({ rows: { hubtel_bill_orders: { id: BOT_ORDER_ID, status, payment_status } } })
    const s = setup({ sup })
    await ecgToConfirm(s)
    quiet()
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Message).toBe(PB_TEXT.unavailable)
    expect(sup.inserts.hubtel_transactions).toBeUndefined()
    expect(sup.updates).toEqual([])
  })
  it("an engine order that cannot be read back is never carted", async () => {
    const s = setup({ sup: fakeSupabase() })
    await ecgToConfirm(s)
    quiet()
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Message).toBe(PB_TEXT.unavailable)
    expect(s.sup.inserts.hubtel_transactions).toBeUndefined()
  })
  it("tx insert failure: the engine order gets the bot fail patch", async () => {
    const sup = fakeSupabase({ txError: true, rows: { hubtel_bill_orders: OPEN_ROW } })
    const s = setup({ sup })
    await ecgToConfirm(s)
    quiet()
    const r = await send(s, "1")
    vi.restoreAllMocks()
    expect(r.Type).toBe("release")
    expect(sup.updates).toEqual([{ table: "hubtel_bill_orders", patch: expect.objectContaining({ status: "failed", failure_reason: "payment not completed" }) }])
  })
  it("2 cancels without an order", async () => {
    const s = setup()
    await ecgToConfirm(s)
    const r = await send(s, "2")
    expect(r.Message).toBe("Order cancelled.")
    expect(s.pb.calls.create).toHaveLength(0)
  })
})

describe("pay bills: shop vs main context", () => {
  it("an accepted shop verifies, quotes and orders with the shop context", async () => {
    const s = setup({ shop: true, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } })
    await ecgToConfirm(s)
    await send(s, "1")
    const ctx = { botSurface: "hubtel_ussd", shopId: SHOP_UUID, rail: "hubtel", buyerPhone: ME }
    expect(s.pb.calls.verify[0].ctx).toEqual(ctx)
    expect(s.pb.calls.quote[0].ctx).toEqual(ctx)
    expect(s.pb.calls.create[0].ctx).toEqual(ctx)
  })
  it("main mode never carries a shop", async () => {
    const s = setup({ session: { shopId: SHOP_UUID } }) // stray shopId on a main session is ignored
    await ecgToConfirm(s)
    await send(s, "1")
    expect(s.pb.calls.create[0].ctx).toEqual(MAIN_CTX)
  })
  it("shop mode without an accepted shop fails closed, nothing looked up", async () => {
    const s = setup({ shop: true, session: { mode: "shop" } })
    const r = await begin(s)
    expect(r.Message).toBe(PB_TEXT.unavailable)
    expect(s.pb.calls.verify).toHaveLength(0)
  })
  it("'0' on the biller list goes back to the shop's product menu in shop mode", async () => {
    const s = setup({ shop: true, session: { mode: "shop", shopId: SHOP_UUID, shopName: "Ama Data Hub" } })
    await begin(s)
    const r = await hubtelRouter(req({ SessionId: SID, Message: "0" }), s.deps)
    expect(r.Message).toContain("What would you like to buy?")
  })
})

describe("pay bills: screen limits", () => {
  it("long names, accounts and amounts stay within 182 chars", async () => {
    const long = "Z".repeat(200)
    const s = setup({ pb: { verify: async () => ({ ok: true, customerName: long, amountDue: 99999.99, suggestedAmount: 0, token: "t" }) } })
    await begin(s)
    const screens = [await send(s, "2", "A".repeat(30)), await send(s, "1000")]
    for (const r of screens) expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    const worst = payBillConfirmText({ pbBiller: "telecel_broadband", pbAccount: "X".repeat(300), pbMeterType: "postpaid", pbFace: 99999.99, pbPay: 99999.98 })
    expect(worst.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(worst.endsWith("\n1 Confirm 2 Cancel")).toBe(true)
    expect(consentScreen("M".repeat(30), "0244123456").length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
  })
  it("long meter names are shortened on the list", async () => {
    const meters = Array.from({ length: 5 }, (_, i) => ({ meter: `P00000${i}`, name: "Q".repeat(80), outstanding: 1234.56, token: `t${i}` }))
    const s = setup({ pb: { verify: async () => ({ ok: true, customerName: null, amountDue: null, suggestedAmount: 0, meters }) } })
    await begin(s)
    const r = await send(s, "1", "1")
    expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
    expect(r.Message.endsWith("00 Back")).toBe(true)
  })
})

describe("pay bills: wording", () => {
  it("every screen in this file's runs is <= 182 chars and never says data or bundle", () => {
    expect(all.length).toBeGreaterThan(50)
    for (const r of all) {
      expect(r.Message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT)
      expect(r.Message).not.toMatch(/data|bundle|water/i)
      if (r.Item) expect(r.Item.ItemName).not.toMatch(/data|bundle|bill|ecg|dstv/i)
    }
  })
})
