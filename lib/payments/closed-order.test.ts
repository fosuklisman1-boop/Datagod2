import { describe, expect, it, vi } from "vitest"
import { alertClosedOrderPayment, isClosedUnpaidShopOrder, isLatePaidShopOrder } from "./closed-order"

describe("isClosedUnpaidShopOrder", () => {
  it.each(["expired", "failed", "cancelled", "canceled", "abandoned", "refunded", "refunding"])("%s and unpaid is closed", (order_status) => {
    expect(isClosedUnpaidShopOrder({ order_status, payment_status: "expired" })).toBe(true)
  })
  it.each(["pending", "processing", "completed", undefined])("%s is not closed", (order_status) => {
    expect(isClosedUnpaidShopOrder({ order_status, payment_status: "pending" })).toBe(false)
  })
  it("an order paid before it failed is not a late payment: a repeat event stays as it was", () => {
    expect(isClosedUnpaidShopOrder({ order_status: "failed", payment_status: "completed" })).toBe(false)
  })
})

describe("isLatePaidShopOrder", () => {
  it("needs a closed status, an unrecorded payment and the completed payment row", () => {
    expect(isLatePaidShopOrder({ order_status: "expired", payment_status: "expired" }, true)).toBe(true)
    expect(isLatePaidShopOrder({ order_status: "expired", payment_status: "expired" }, false)).toBe(false)
    expect(isLatePaidShopOrder({ order_status: "failed", payment_status: "completed" }, true)).toBe(false)
    expect(isLatePaidShopOrder({ order_status: "refunded", payment_status: "expired" }, true)).toBe(false)
    expect(isLatePaidShopOrder({ order_status: "pending", payment_status: "pending" }, true)).toBe(false)
  })
})

describe("alertClosedOrderPayment", () => {
  const settingsDb = () => {
    const rows = new Map<string, any>()
    const db: any = {
      from: () => {
        let key = ""
        const q: any = {
          select: () => q,
          eq: (_c: string, v: string) => ((key = v), q),
          maybeSingle: async () => ({ data: rows.has(key) ? { value: rows.get(key) } : null, error: null }),
          upsert: async (r: any) => (rows.set(r.key, r.value), { error: null }),
        }
        return q
      },
    }
    return { db, rows }
  }

  it("alerts once per payment, carries no phone number, and a different payment alerts again", async () => {
    const { db } = settingsDb()
    const notify = vi.fn(async (_m: string, _t: string) => {})
    const a = { orderId: "order-1", reference: "WALLET-1", amountGhs: 12.5 }
    await alertClosedOrderPayment(db, a, { notify })
    await alertClosedOrderPayment(db, a, { notify })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]).toEqual([expect.stringContaining("/admin/refunds"), "closed_order_payment"])
    expect(notify.mock.calls[0][0]).not.toMatch(/\d{9,}/)
    await alertClosedOrderPayment(db, { ...a, reference: "WALLET-2" }, { notify })
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it("never throws", async () => {
    await expect(alertClosedOrderPayment({ from: () => { throw new Error("db down") } } as any, { orderId: "o", reference: "r", amountGhs: 1 }, { notify: async () => { throw new Error("no") } })).resolves.toBeUndefined()
  })
})
