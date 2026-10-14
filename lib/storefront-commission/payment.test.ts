import { describe, it, expect } from "vitest"
import {
  isStorefrontOrderType, STOREFRONT_ORDER_TABLE, newPaystackReference, extraPaystackFeeRate, checkStorefrontPayable,
  STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE, STOREFRONT_CONFIRMATION_PATH, storefrontMomoStatus, DIRECT_CHARGE_OFF,
} from "./payment"

const row = (o: Record<string, unknown> = {}) => ({
  channel: "storefront", shop_id: "shop1", status: "pending", payment_status: "unpaid", paid_amount: 98.5,
  buyer_email: "buyer@example.com", ...o,
}) as any

describe("storefront payment init helpers", () => {
  it("order types map to the commission tables; nothing else is a storefront type", () => {
    expect(STOREFRONT_ORDER_TABLE).toEqual({ cs_bill: "hubtel_bill_orders", cs_bundle: "hubtel_data_orders" })
    for (const t of ["cs_bill", "cs_bundle"]) expect(isStorefrontOrderType(t)).toBe(true)
    for (const t of ["airtime", "results_checker", "results_check_service", "data", undefined, null, "", "CS_BILL"]) {
      expect(isStorefrontOrderType(t)).toBe(false)
    }
  })

  it("Paystack reference is 32 opaque hex characters, unique per call", () => {
    const a = newPaystackReference(), b = newPaystackReference()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it("Paystack-facing labels carry no product words", () => {
    for (const s of [STOREFRONT_PAYMENT_CHANNEL, STOREFRONT_PAYMENT_PURPOSE, STOREFRONT_CONFIRMATION_PATH]) {
      expect(s).not.toMatch(/bill|bundle|data|airtime|ecg|water|broadband|cashback|commission/i)
    }
  })

  it("cs_bill / cs_bundle add a 0% Paystack fee; every existing type is unchanged", () => {
    expect(extraPaystackFeeRate("cs_bill", 3)).toBe(0)
    expect(extraPaystackFeeRate("cs_bundle", 5)).toBe(0)
    expect(extraPaystackFeeRate("airtime", 3)).toBe(0)
    // previous rule: (paystack_fee_percentage || 3.0) / 100
    for (const t of [undefined, "data", "results_checker", "results_check_service"]) {
      expect(extraPaystackFeeRate(t, 2.5)).toBe(0.025)
      expect(extraPaystackFeeRate(t, null)).toBe(0.03)
      expect(extraPaystackFeeRate(t, 0)).toBe(0.03)
    }
  })

  it("payable: uses paid_amount and the buyer email", () => {
    expect(checkStorefrontPayable(row(), "shop1")).toEqual({ ok: true, amount: 98.5, email: "buyer@example.com", shopId: "shop1" })
    expect(checkStorefrontPayable(row({ paid_amount: "12.30" }), "shop1")).toMatchObject({ ok: true, amount: 12.3 })
  })

  it("refuses non-pending or already-paid orders (e.g. a replayed bundle key)", () => {
    for (const o of [
      { status: "processing" }, { status: "completed" }, { status: "failed" }, { status: "refunded" },
      { payment_status: "paid" }, { payment_status: "refunded" }, { status: "pending", payment_status: "paid" },
    ]) {
      expect(checkStorefrontPayable(row(o), "shop1")).toEqual({ ok: false, status: 400, error: "This order is no longer available for payment." })
    }
  })

  it("refuses a missing row, a dashboard row, or another shop's order", () => {
    expect(checkStorefrontPayable(null, "shop1")).toMatchObject({ ok: false, status: 400 })
    expect(checkStorefrontPayable(row({ channel: "dashboard" }), "shop1")).toMatchObject({ ok: false, status: 400 })
    expect(checkStorefrontPayable(row(), "shop2")).toMatchObject({ ok: false, status: 400 })
    expect(checkStorefrontPayable(row(), null)).toMatchObject({ ok: false, status: 400 })
  })

  it("direct-charge polling: paid flip => completed; failed attempt => failed; else pending", () => {
    expect(storefrontMomoStatus("paid", null)).toBe("completed")
    expect(storefrontMomoStatus("refunded", "failed")).toBe("completed") // it was paid
    expect(storefrontMomoStatus("unpaid", "failed")).toBe("failed")
    expect(storefrontMomoStatus("unpaid", "abandoned")).toBe("failed")
    expect(storefrontMomoStatus("unpaid", "pending")).toBe("pending")
    expect(storefrontMomoStatus("unpaid", null)).toBe("pending")
    expect(storefrontMomoStatus(null, null)).toBe("pending")
    expect(DIRECT_CHARGE_OFF).toBe("DIRECT_CHARGE_OFF")
  })

  it("bad amount or missing buyer email => configuration error", () => {
    for (const o of [{ paid_amount: null }, { paid_amount: 0 }, { paid_amount: "x" }, { buyer_email: null }, { buyer_email: " " }]) {
      expect(checkStorefrontPayable(row(o), "shop1")).toMatchObject({ ok: false, status: 500 })
    }
  })
})
