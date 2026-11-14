import { describe, it, expect, vi, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import type { SupabaseClient } from "@supabase/supabase-js"
import { calculateSegments } from "@/lib/sms/segments"

const h = vi.hoisted(() => ({
  enabled: vi.fn(async (_b: string) => true),
  available: vi.fn(async (_b: string) => 40),
  maxQty: vi.fn(async () => 50),
  price: vi.fn(async (_p: { examBoard: string; quantity: number; applyBulk?: boolean }) => ({ totalPaid: 30, unitPrice: 15 }) as Record<string, number>),
  boards: vi.fn(async (): Promise<string[]> => ["WASSCE"]),
  confirm: vi.fn(),
}))

vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: h.enabled,
  getAvailableCount: h.available,
  getMaxQuantity: h.maxQty,
  calculateRCPrice: h.price,
  isValidExamBoard: (b: string) => ["WASSCE", "BECE", "NOVDEC"].includes(b),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ confirmRcByText: h.confirm, buildRcBoardOptions: h.boards }))

import { resultsCheckerAdapter, voucherSession, type VoucherOffer } from "./results-checker"
import { classifyStatusOrder } from "./classify"
import { voucherBoardQuestion, voucherMaxReply, voucherOffReply, voucherQuoteReply, unpaidReply, delayedReply } from "../replies"
import { TTB_DEFAULTS } from "../settings"
import type { OrderRead } from "../types"

const S = "0200000101"
const db = {} as SupabaseClient
type Rc = Extract<OrderRead, { service: "results_checker" }>
const read = (o: Partial<Rc> = {}): OrderRead => ({ kind: "order", service: "results_checker", board: "WASSCE", quantity: 2, ...o })
const resolve = (r: OrderRead, sender = S) => resultsCheckerAdapter({ boards: h.boards as never }).resolve(db, sender, r)
const offerOf = async (r: OrderRead, sender = S): Promise<VoucherOffer> => {
  const res = await resolve(r, sender)
  if (!res.ok) throw new Error("expected an offer, got " + res.refusal.reply)
  return res.offer
}
const oneSegment = (s: string) => {
  const r = calculateSegments(s)
  expect([r.encoding, r.segments]).toEqual(["gsm7", 1])
}

beforeEach(() => {
  h.enabled.mockReset().mockResolvedValue(true)
  h.available.mockReset().mockResolvedValue(40)
  h.maxQty.mockReset().mockResolvedValue(50)
  h.price.mockReset().mockResolvedValue({ totalPaid: 30, unitPrice: 15 })
  h.boards.mockReset().mockResolvedValue(["WASSCE"])
  h.confirm.mockReset()
})

describe("resolve: the board", () => {
  it("several boards in stock: asks which, and the digit picks one with the quantity kept", async () => {
    h.boards.mockResolvedValue(["WASSCE", "BECE", "NOVDEC"])
    const res = await resolve(read({ board: null, quantity: 3 }))
    expect(res).toMatchObject({
      ok: false,
      refusal: { outcome: "asked", reply: voucherBoardQuestion(["WASSCE", "BECE", "NOVDEC"]), remember: true, pending: { type: "choices" } },
    })
    if (res.ok || res.refusal.pending?.type !== "choices") throw new Error("expected a pending question")
    const picked = res.refusal.pending.options[1].read
    expect(picked).toEqual({ kind: "order", service: "results_checker", board: "BECE", quantity: 3 })
    const offer = await offerOf(picked as OrderRead)
    expect(offer).toMatchObject({ board: "BECE", quantity: 3, size: "3 bece" })
  })

  it("one board in stock: it is used without a question", async () => {
    h.boards.mockResolvedValue(["BECE"])
    const o = await offerOf(read({ board: null, quantity: 1 }))
    expect(o).toMatchObject({ board: "BECE", quantity: 1 })
  })

  it("no board in stock: not available now, nothing asked", async () => {
    h.boards.mockResolvedValue([])
    const res = await resolve(read({ board: null }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherOffReply(null) } })
  })

  it("a board name the service does not know is dropped before the question is built", async () => {
    h.boards.mockResolvedValue(["WASSCE", "JUNK", "BECE"])
    const res = await resolve(read({ board: null }))
    expect(res).toMatchObject({ ok: false, refusal: { reply: "Which checker? 1) WASSCE 2) BECE" } })
  })

  it("the board is off: unavailable, with the board named", async () => {
    h.enabled.mockResolvedValue(false)
    const res = await resolve(read({ board: "BECE" }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: "BECE checkers are not available now." } })
  })

  it("no stock: unavailable", async () => {
    h.available.mockResolvedValue(0)
    const res = await resolve(read())
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherOffReply("WASSCE") } })
  })

  it("an error anywhere fails closed to the generic not-available reply", async () => {
    h.available.mockRejectedValue(new Error("db down 0200000101"))
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await resolve(read())
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherOffReply(null) } })
    expect(JSON.stringify(err.mock.calls)).not.toContain(S)
    err.mockRestore()
  })
})

describe("resolve: quantity and price", () => {
  it("above the stock: the cap is the stock", async () => {
    h.available.mockResolvedValue(4)
    const res = await resolve(read({ quantity: 5 }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherMaxReply("WASSCE", 4) } })
  })

  it("above the max quantity: the cap is the max quantity", async () => {
    h.maxQty.mockResolvedValue(10)
    const res = await resolve(read({ quantity: 11 }))
    expect(res).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherMaxReply("WASSCE", 10) } })
  })

  it("the cap is the smaller of stock and max quantity", async () => {
    h.available.mockResolvedValue(7)
    h.maxQty.mockResolvedValue(10)
    expect(await resolve(read({ quantity: 8 }))).toMatchObject({ refusal: { reply: voucherMaxReply("WASSCE", 7) } })
    h.available.mockResolvedValue(70)
    h.maxQty.mockResolvedValue(3)
    expect(await resolve(read({ quantity: 4 }))).toMatchObject({ refusal: { reply: voucherMaxReply("WASSCE", 3) } })
    expect((await resolve(read({ quantity: 3 }))).ok).toBe(true)
  })

  it("a zero, negative or fractional quantity is never priced", async () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      const res = await resolve(read({ quantity }))
      expect(res.ok).toBe(false)
    }
    expect(h.price).not.toHaveBeenCalled()
  })

  it("prices with the bulk total, and that total is the preview", async () => {
    h.price.mockResolvedValue({ totalPaid: 270, unitPrice: 13.5 })
    const o = await offerOf(read({ quantity: 20 }))
    expect(h.price).toHaveBeenCalledWith({ examBoard: "WASSCE", quantity: 20, applyBulk: true })
    expect(o.previewGhs).toBe(270)
  })

  it("a zero or non-numeric total is never offered", async () => {
    for (const totalPaid of [0, -5, Number.NaN]) {
      h.price.mockResolvedValue({ totalPaid, unitPrice: 1 })
      expect(await resolve(read())).toMatchObject({ ok: false, refusal: { outcome: "unavailable", reply: voucherOffReply("WASSCE") } })
    }
  })

  it("the recipient is the sender, never a gift; the token is quantity and board", async () => {
    const o = await offerOf(read({ board: "NOVDEC", quantity: 2 }))
    expect(o).toMatchObject({
      service: "results_checker", recipientLocal: S, gift: false, size: "2 novdec", paystackProvider: "vod",
      lastOrder: { service: "results_checker", board: "NOVDEC", quantity: 2 },
    })
  })

  it("a sender with no known MoMo provider still resolves (the handler refuses it)", async () => {
    const o = await offerOf(read(), "0300000101")
    expect(o.paystackProvider).toBe("mtn")
  })
})

describe("place and the staged session", () => {
  it("the session carries only the step, the sender, the board and the quantity", async () => {
    const o = await offerOf(read())
    expect(voucherSession(S, o)).toEqual({ step: "RC_CONFIRM", dialingPhone: "+233200000101", rcBoard: "WASSCE", rcQty: 2 })
  })

  it("place confirms with an opaque id and returns the order id and the placed total", async () => {
    h.confirm.mockResolvedValue({ message: "x", ussdServiceOp: 17, orderId: "O1", amount: 31 })
    const o = await offerOf(read())
    const placed = await resultsCheckerAdapter({ confirm: h.confirm as never }).place(o, "MSG1", S)
    expect(h.confirm).toHaveBeenCalledWith("sms:MSG1", { step: "RC_CONFIRM", dialingPhone: "+233200000101", rcBoard: "WASSCE", rcQty: 2 })
    expect(placed).toEqual({ orderId: "O1", amountGhs: 31 })
  })

  it("the quote states the PLACED total, and no fee line when the placed total is above the preview", async () => {
    const a = resultsCheckerAdapter()
    const o = await offerOf(read())
    const ctx = { feeOnTop: true, payerNetwork: "MTN" as const }
    expect(a.quote(o, { amountGhs: 30 }, ctx)).toBe(voucherQuoteReply({ board: "WASSCE", quantity: 2, amountGhs: 30, feeOnTop: true, payerNetwork: "MTN" }))
    const placed = a.quote(o, { amountGhs: 30.6 }, ctx)
    expect(placed).toBe(voucherQuoteReply({ board: "WASSCE", quantity: 2, amountGhs: 30.6, feeOnTop: false, payerNetwork: "MTN" }))
    expect(placed).toContain("GHS 30.60")
    expect(placed).not.toContain("GHS 30.00")
  })

  it("an unusable placed amount states no money", async () => {
    const o = await offerOf(read())
    const text = resultsCheckerAdapter().quote(o, { amountGhs: Number.NaN }, { feeOnTop: false, payerNetwork: "MTN" })
    expect(text).not.toMatch(/GHS|\d/)
  })

  it("not placed names the board", async () => {
    const o = await offerOf(read({ board: "BECE" }))
    expect(resultsCheckerAdapter().notPlacedReply(o)).toBe(voucherOffReply("BECE"))
  })
})

describe("notices and status", () => {
  const a = resultsCheckerAdapter()
  it("unpaid carries the re-text token; delivered is never sent; delayed is the delay notice", () => {
    expect(a.notices.unpaid("2 wassce")).toBe(unpaidReply("2 wassce"))
    expect(a.notices.delivered({ size: "2 wassce", recipient: S, gift: false })).toBeNull()
    expect(a.notices.delivered({ size: "2 wassce", recipient: S, gift: true })).toBeNull()
    expect(a.notices.paidNotDelivered()).toBe(delayedReply())
    oneSegment(a.notices.unpaid("100 novdec"))
  })

  it("is on the results-checker text switch and reads results_checker_orders", () => {
    expect(a.orderTable).toBe("results_checker_orders")
    expect(a.textEnabled({ ...TTB_DEFAULTS, resultsCheckerEnabled: true })).toBe(true)
    expect(a.textEnabled({ ...TTB_DEFAULTS, resultsCheckerEnabled: false })).toBe(false)
    expect(a.classify).toBe(classifyStatusOrder)
  })

  it("statusOf follows the status vocabulary", () => {
    const row = (paymentStatus: string, orderStatus: string) => ({ paymentStatus, orderStatus, amount: 30 })
    expect(a.statusOf({ state: "paid" }, row("completed", "completed"))).toBe("delivered")
    expect(a.statusOf({ state: "paid" }, row("completed", "processing"))).toBe("processing")
    expect(a.statusOf({ state: "awaiting_payment" }, row("failed", "pending_payment"))).toBe("failed")
    expect(a.statusOf({ state: "awaiting_payment" }, row("completed", "refunded"))).toBe("failed")
    expect(a.statusOf({ state: "awaiting_payment" }, row("pending_payment", "pending_payment"))).toBe("awaiting_payment")
    expect(a.statusOf({ state: "paid" }, null)).toBe("processing")
    expect(a.statusOf({ state: "closed" }, null)).toBe("failed")
    expect(a.statusOf({ state: "awaiting_payment" }, null)).toBe("awaiting_payment")
  })
})

describe("PIN handling", () => {
  it("the module source never touches the voucher delivery path", () => {
    const src = readFileSync(new URL("./results-checker.ts", import.meta.url), "utf8")
    expect(src).not.toContain("deliverVouchers")
    expect(src).not.toContain("sms-service")
    expect(src).not.toContain("results-checker-notification-service")
  })
})
