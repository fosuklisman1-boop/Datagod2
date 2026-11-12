import { describe, it, expect } from "vitest"
import { fromOrderRow, fromShopOrderRow, fromLegacyOrderDetails, type OrdersRow } from "./support-order"

const orderRow: OrdersRow = {
  id: "o1", network: "MTN", size: 5, price: 20.5, status: "completed",
  phone_number: "0241234567", order_code: "ORD-1", created_at: "2026-11-01T10:00:00Z",
}

describe("fromOrderRow", () => {
  it("maps every field", () => {
    expect(fromOrderRow(orderRow)).toEqual({
      source: "order", id: "o1", reference: "ORD-1", beneficiary: "0241234567", network: "MTN",
      size: "5GB", price: 20.5, status: "completed", created_at: "2026-11-01T10:00:00Z", shop_name: null,
    })
  })
  it("does not double the unit and tolerates null", () => {
    expect(fromOrderRow({ ...orderRow, size: "5GB" }).size).toBe("5GB")
    expect(fromOrderRow({ ...orderRow, size: "5" }).size).toBe("5GB")
    expect(fromOrderRow({ ...orderRow, size: null }).size).toBeNull()
  })
})

describe("fromShopOrderRow", () => {
  it("maps every field", () => {
    expect(
      fromShopOrderRow(
        {
          id: "s1", customer_phone: "0201234567", network: "Telecel", volume_gb: 10, total_price: "35",
          order_status: "pending", reference_code: "REF-9", created_at: "2026-11-02T10:00:00Z",
        },
        "Kofi Shop",
      ),
    ).toEqual({
      source: "shop_order", id: "s1", reference: "REF-9", beneficiary: "0201234567", network: "Telecel",
      size: "10GB", price: 35, status: "pending", created_at: "2026-11-02T10:00:00Z", shop_name: "Kofi Shop",
    })
  })
})

describe("fromLegacyOrderDetails", () => {
  it("maps legacy details", () => {
    expect(
      fromLegacyOrderDetails({ network: "MTN", package: "5GB", phone: "0241234567", amount: 20, date: "2026-10-01", orderRefId: "R1", type: "data" }),
    ).toEqual({
      source: "order", id: "R1", reference: "R1", beneficiary: "0241234567", network: "MTN",
      size: "5GB", price: 20, status: null, created_at: "2026-10-01", shop_name: null,
    })
  })
  it("returns null for null and non-objects", () => {
    expect(fromLegacyOrderDetails(null)).toBeNull()
    expect(fromLegacyOrderDetails("x")).toBeNull()
    expect(fromLegacyOrderDetails(42)).toBeNull()
    expect(fromLegacyOrderDetails([])).toBeNull()
  })
})

describe("fix round 1", () => {
  it("whitespace-only size gives null", () => {
    expect(fromOrderRow({ ...orderRow, size: "  " }).size).toBeNull()
  })
  it("whitespace-only price gives null, not 0", () => {
    expect(fromOrderRow({ ...orderRow, price: "  " }).price).toBeNull()
  })
  it("numeric legacy package becomes 5GB", () => {
    expect(fromLegacyOrderDetails({ package: 5 })?.size).toBe("5GB")
  })
})
