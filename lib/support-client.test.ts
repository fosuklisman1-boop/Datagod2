import { describe, it, expect } from "vitest"
import {
  mergeMessage,
  countUnread,
  buildThreadFormData,
  customerTextError,
  orderSubject,
  visiblePanes,
  validateScreenshot,
  complaintTargetForOrder,
  type ClientMessage,
} from "./support-client"

const msg = (id: string, over: Partial<ClientMessage> = {}): ClientMessage => ({
  id,
  thread_id: "t1",
  sender_role: "admin",
  body: "hi",
  attachment_path: null,
  delivered_to_user_at: null,
  read_by_user_at: null,
  created_at: "2026-11-12T10:00:00Z",
  ...over,
})

describe("mergeMessage", () => {
  it("appends a new message in time order", () => {
    const out = mergeMessage([msg("a", { created_at: "2026-11-12T10:00:00Z" })], msg("b", { created_at: "2026-11-12T09:00:00Z" }))
    expect(out.map((m) => m.id)).toEqual(["b", "a"])
  })
  it("does not duplicate an id and keeps the newer receipt data", () => {
    const out = mergeMessage([msg("a")], msg("a", { read_by_user_at: "2026-11-12T11:00:00Z" }))
    expect(out).toHaveLength(1)
    expect(out[0].read_by_user_at).toBe("2026-11-12T11:00:00Z")
  })
})

describe("countUnread", () => {
  it("counts only unread support-side messages", () => {
    const list = [
      msg("1"),
      msg("2", { sender_role: "ai" }),
      msg("3", { sender_role: "user" }),
      msg("4", { read_by_user_at: "2026-11-12T11:00:00Z" }),
    ]
    expect(countUnread(list)).toBe(2)
  })
  it("is zero for undefined", () => {
    expect(countUnread(undefined)).toBe(0)
  })
})

describe("orderSubject", () => {
  it("uses the reference when present", () => {
    expect(orderSubject("ABC123", "11111111-2222")).toBe("Issue with order ABC123")
  })
  it("falls back to a short id", () => {
    expect(orderSubject(null, "11111111-2222-3333")).toBe("Issue with order 11111111")
  })
})

describe("customerTextError", () => {
  it("rejects markup characters with a clear message", () => {
    expect(customerTextError("a < b")).toMatch(/< > &/)
    expect(customerTextError("fish & chips")).toMatch(/< > &/)
  })
  it("accepts plain text", () => {
    expect(customerTextError("My data did not arrive.")).toBeNull()
  })
})

describe("validateScreenshot", () => {
  it("rejects wrong type and oversize", () => {
    expect(validateScreenshot({ type: "image/gif", size: 10 })).toMatch(/JPG/)
    expect(validateScreenshot({ type: "image/png", size: 5 * 1024 * 1024 })).toMatch(/4 MB/)
  })
  it("accepts a small png", () => {
    expect(validateScreenshot({ type: "image/png", size: 1000 })).toBeNull()
  })
})

describe("buildThreadFormData", () => {
  it("sets order_id for order kind and omits shop_order_id", () => {
    const fd = buildThreadFormData({
      kind: "order", id: "o1", reference: "R1", message: "m", phone: "0241234567", whatsapp: "0241234567", image: null,
    })
    expect(fd.get("order_id")).toBe("o1")
    expect(fd.get("shop_order_id")).toBeNull()
    expect(fd.get("category")).toBe("order")
    expect(fd.get("subject")).toBe("Issue with order R1")
    expect(fd.get("image")).toBeNull()
  })
  it("sets shop_order_id for shop_order kind and attaches the image", () => {
    const file = new File(["x"], "s.png", { type: "image/png" })
    const fd = buildThreadFormData({
      kind: "shop_order", id: "s1", reference: null, message: "m", phone: "p", whatsapp: "w", image: file,
    })
    expect(fd.get("shop_order_id")).toBe("s1")
    expect(fd.get("order_id")).toBeNull()
    expect((fd.get("image") as File).name).toBe("s.png")
  })
})

describe("complaintTargetForOrder", () => {
  const row = (over: Partial<Parameters<typeof complaintTargetForOrder>[0]> = {}) => ({
    id: "abcdef12-3456-7890",
    type: "bulk" as string | null,
    reference: "REF1" as string | null,
    network_name: "MTN",
    package_name: "5GB",
    phone_number: "0241234567",
    ...over,
  })

  it("maps each of the five types", () => {
    expect(complaintTargetForOrder(row({ type: "bulk" }))).toMatchObject({ kind: "order", id: "abcdef12-3456-7890" })
    expect(complaintTargetForOrder(row({ type: "shop" }))).toMatchObject({ kind: "shop_order", id: "abcdef12-3456-7890" })
    for (const t of ["ussd_shop", "ussd", "api"]) {
      expect(complaintTargetForOrder(row({ type: t }))).toMatchObject({ kind: "none", id: null })
    }
  })
  it("treats a null type as none", () => {
    expect(complaintTargetForOrder(row({ type: null }))).toMatchObject({ kind: "none", id: null })
  })
  it("uses the reference, or the id prefix when absent", () => {
    expect(complaintTargetForOrder(row()).subject).toBe("Issue with order REF1")
    expect(complaintTargetForOrder(row({ reference: null })).subject).toBe("Issue with order abcdef12")
  })
  it("unlinked subject carries network, package and phone", () => {
    const s = complaintTargetForOrder(row({ type: "api" })).subject
    expect(s).toBe("Issue with order REF1 - MTN 5GB to 0241234567")
  })
  it("strips <, > and & from every piece", () => {
    const s = complaintTargetForOrder(row({ type: "api", reference: "A&B<x>", network_name: "M&N" })).subject
    expect(s).not.toMatch(/[<>&]/)
    expect(s).toContain("ABx")
  })
  it("truncates to 200 characters", () => {
    expect(complaintTargetForOrder(row({ reference: "R".repeat(500) })).subject).toHaveLength(200)
  })
})

describe("buildThreadFormData none", () => {
  it("sends neither order id when kind is none", () => {
    const fd = buildThreadFormData({ kind: "none", subject: "S ok", message: "m", phone: "p", whatsapp: "w", image: null })
    expect(fd.get("order_id")).toBeNull()
    expect(fd.get("shop_order_id")).toBeNull()
    expect(fd.get("category")).toBe("order")
    expect(fd.get("subject")).toBe("S ok")
  })
})

describe("visiblePanes", () => {
  it("shows the list when nothing is selected on mobile", () => {
    expect(visiblePanes(null)).toEqual({ list: true, chat: false })
  })
  it("shows the chat when a thread is selected on mobile", () => {
    expect(visiblePanes("t1")).toEqual({ list: false, chat: true })
  })
})
