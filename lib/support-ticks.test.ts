import { describe, it, expect } from "vitest"
import { getCounterpartReceipt, getMessageTickState, type ReceiptColumns } from "./support-ticks"

const row: ReceiptColumns = {
  delivered_to_user_at: "u-del",
  delivered_to_admin_at: "a-del",
  read_by_user_at: "u-read",
  read_by_admin_at: null,
}

describe("getCounterpartReceipt", () => {
  it("admin message uses the user columns", () => {
    expect(getCounterpartReceipt("admin", row)).toEqual({ delivered_at: "u-del", read_at: "u-read" })
  })
  it("ai behaves exactly like admin", () => {
    expect(getCounterpartReceipt("ai", row)).toEqual(getCounterpartReceipt("admin", row))
  })
  it("user message uses the admin columns", () => {
    expect(getCounterpartReceipt("user", row)).toEqual({ delivered_at: "a-del", read_at: null })
  })
})

describe("getMessageTickState", () => {
  it("is sent with no receipts", () => {
    expect(getMessageTickState({ delivered_at: null, read_at: null })).toBe("sent")
  })
  it("is delivered when only delivered", () => {
    expect(getMessageTickState({ delivered_at: "x", read_at: null })).toBe("delivered")
  })
  it("is read when read_at set, even if delivered_at is null", () => {
    expect(getMessageTickState({ delivered_at: null, read_at: "x" })).toBe("read")
    expect(getMessageTickState({ delivered_at: "x", read_at: "y" })).toBe("read")
  })
})
