import { describe, it, expect } from "vitest"
import {
  GH_PHONE_RE,
  SUPPORT_CATEGORIES,
  createThreadSchema,
  userMessageSchema,
  adminActionSchema,
  resolveComplaintSchema,
  isUuid,
} from "./support-validation"

const UUID = "123e4567-e89b-42d3-a456-426614174000"
const base = {
  subject: "Data not received",
  category: "order",
  message: "My order has not arrived yet",
  phone_number: "0241234567",
  whatsapp_number: "0241234567",
}

describe("GH_PHONE_RE", () => {
  it("accepts local and +233 numbers", () => {
    expect(GH_PHONE_RE.test("0241234567")).toBe(true)
    expect(GH_PHONE_RE.test("+233241234567")).toBe(true)
  })
  it("rejects bad prefix and short numbers", () => {
    expect(GH_PHONE_RE.test("0141234567")).toBe(false)
    expect(GH_PHONE_RE.test("024123456")).toBe(false)
  })
})

describe("categories", () => {
  it("lists the four categories", () => {
    expect([...SUPPORT_CATEGORIES]).toEqual(["order", "payment", "account", "other"])
  })
})

describe("createThreadSchema", () => {
  it("accepts a valid body", () => {
    expect(createThreadSchema.safeParse(base).success).toBe(true)
  })
  it("accepts a single order id", () => {
    expect(createThreadSchema.safeParse({ ...base, order_id: UUID }).success).toBe(true)
  })
  it("rejects subject of 2 and 201 chars", () => {
    expect(createThreadSchema.safeParse({ ...base, subject: "ab" }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, subject: "a".repeat(201) }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, subject: "a".repeat(200) }).success).toBe(true)
  })
  it("rejects message of 4 and 5001 chars", () => {
    expect(createThreadSchema.safeParse({ ...base, message: "abcd" }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, message: "a".repeat(5001) }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, message: "abcde" }).success).toBe(true)
  })
  it("trims before length checks", () => {
    expect(createThreadSchema.safeParse({ ...base, message: "   abcd   " }).success).toBe(false)
  })
  it("rejects customer text with < > & or script patterns", () => {
    for (const bad of ["hello <b>there</b>", "a > b is true", "fish & chips", "javascript:alert(1)", "x onclick=foo()"]) {
      expect(createThreadSchema.safeParse({ ...base, message: bad }).success).toBe(false)
    }
    expect(createThreadSchema.safeParse({ ...base, subject: "Fish & chips" }).success).toBe(false)
  })
  it("rejects both order_id and shop_order_id", () => {
    expect(createThreadSchema.safeParse({ ...base, order_id: UUID, shop_order_id: UUID }).success).toBe(false)
  })
  it("rejects bad phone numbers and categories", () => {
    expect(createThreadSchema.safeParse({ ...base, phone_number: "0141234567" }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, whatsapp_number: "12" }).success).toBe(false)
    expect(createThreadSchema.safeParse({ ...base, category: "billing" }).success).toBe(false)
  })
})

describe("userMessageSchema", () => {
  it("accepts 1 to 5000 chars", () => {
    expect(userMessageSchema.safeParse({ message: "k" }).success).toBe(true)
    expect(userMessageSchema.safeParse({ message: "a".repeat(5000) }).success).toBe(true)
  })
  it("rejects empty, whitespace, too long and unsafe text", () => {
    expect(userMessageSchema.safeParse({ message: "" }).success).toBe(false)
    expect(userMessageSchema.safeParse({ message: "   " }).success).toBe(false)
    expect(userMessageSchema.safeParse({ message: "a".repeat(5001) }).success).toBe(false)
    expect(userMessageSchema.safeParse({ message: "a<b" }).success).toBe(false)
    expect(userMessageSchema.safeParse({ message: "javascript:void(0)" }).success).toBe(false)
  })
})

describe("adminActionSchema", () => {
  it("allows angle brackets and ampersand in a reply", () => {
    expect(adminActionSchema.safeParse({ action: "reply", message: "Use a < b & c > d" }).success).toBe(true)
  })
  it("rejects script injection in a reply", () => {
    expect(adminActionSchema.safeParse({ action: "reply", message: "<script>alert(1)</script>" }).success).toBe(false)
    expect(adminActionSchema.safeParse({ action: "reply", message: "javascript:x" }).success).toBe(false)
  })
  it("accepts close with and without note, and read", () => {
    expect(adminActionSchema.safeParse({ action: "close" }).success).toBe(true)
    expect(adminActionSchema.safeParse({ action: "close", note: "done" }).success).toBe(true)
    expect(adminActionSchema.safeParse({ action: "read" }).success).toBe(true)
  })
  it("rejects unknown action", () => {
    expect(adminActionSchema.safeParse({ action: "delete" }).success).toBe(false)
  })
})

describe("resolveComplaintSchema", () => {
  it("accepts valid input", () => {
    expect(resolveComplaintSchema.safeParse({ id: UUID, status: "resolved", resolution_notes: " ok " }).success).toBe(true)
  })
  it("rejects 2500-char notes and bad status/id", () => {
    expect(resolveComplaintSchema.safeParse({ id: UUID, status: "resolved", resolution_notes: "a".repeat(2500) }).success).toBe(false)
    expect(resolveComplaintSchema.safeParse({ id: UUID, status: "open", resolution_notes: "x" }).success).toBe(false)
    expect(resolveComplaintSchema.safeParse({ id: "nope", status: "rejected", resolution_notes: "x" }).success).toBe(false)
  })
})

describe("isUuid", () => {
  it("checks uuid strings", () => {
    expect(isUuid(UUID)).toBe(true)
    expect(isUuid("abc")).toBe(false)
    expect(isUuid(5)).toBe(false)
    expect(isUuid(null)).toBe(false)
  })
})
