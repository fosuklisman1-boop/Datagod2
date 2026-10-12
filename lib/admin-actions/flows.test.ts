import { FLOWS } from "./registry"
import type { FlowId, Outcome } from "./types"

const EVIL = `<script>alert(1)</script>`
const LONG = "very long text ".repeat(40)

const ctxFor: Record<FlowId, any> = {
  withdrawal: { withdrawalId: "w1", amount: 120.5, shopName: EVIL, method: "Mobile Money", phone: "0241112222", reason: EVIL + LONG, remainingBalance: "10.00" },
  afa: { orderCode: "AFA-123", fullName: EVIL, reason: EVIL + LONG },
  results_check: { requestId: "r1", examBoard: "WASSCE", indexNumber: "1234567890", examYear: 2025, channel: "web", shopName: EVIL, reason: EVIL + LONG },
  shop: { shopId: "s1", shopName: EVIL, reason: EVIL + LONG },
  sender_id: { senderIdId: "x1", senderId: EVIL, reason: EVIL + LONG },
  complaint: { complaintId: "c1", orderId: "o1", priority: "high", summary: EVIL + LONG, resolutionNotes: EVIL + LONG },
}
const SUPPORTED: Record<FlowId, Outcome[]> = {
  withdrawal: ["approved", "rejected", "completed"],
  afa: ["completed", "rejected"],
  results_check: ["completed", "rejected"],
  shop: ["approved", "rejected"],
  sender_id: ["approved", "rejected"],
  complaint: ["resolved", "rejected"],
}
const ALL: Outcome[] = ["approved", "rejected", "completed", "resolved"]

describe.each(Object.keys(FLOWS) as FlowId[])("flow %s", (flow) => {
  const def = FLOWS[flow]
  it("admin alert has a subject, push text and an /admin deep link, with escaped html", () => {
    const a = def.adminAlert(ctxFor[flow])
    expect(a.subject.length).toBeGreaterThan(5)
    expect(a.pushTitle.length).toBeGreaterThan(2)
    expect(a.pushBody.length).toBeGreaterThan(0)
    expect(a.url.startsWith("/admin/")).toBe(true)
    expect(a.html).not.toContain("<script>")
  })
  it.each(ALL)("outcome %s is supported or null as declared", (outcome) => {
    const m = def.userMessage(outcome, ctxFor[flow])
    if (!SUPPORTED[flow].includes(outcome)) {
      expect(m).toBeNull()
      return
    }
    expect(m).not.toBeNull()
    expect(m!.emailSubject.length).toBeGreaterThan(5)
    expect(m!.emailHtml).not.toContain("<script>")
    expect(m!.sms.length).toBeLessThanOrEqual(160)
    expect(m!.sms.length).toBeGreaterThan(10)
  })
  it("rejection messages carry the admin's reason (clipped in SMS) and fall back gracefully without one", () => {
    const withReason = def.userMessage("rejected", { ...ctxFor[flow], reason: "Bad number", resolutionNotes: "Bad number" })
    expect(withReason!.emailHtml).toContain("Bad number")
    const without = def.userMessage("rejected", { ...ctxFor[flow], reason: undefined, resolutionNotes: undefined })
    expect(without!.sms.length).toBeGreaterThan(10)
  })
  it("never leaks the literal 'undefined' or 'null' into messages", () => {
    const sparse: any = { ...ctxFor[flow] }
    for (const k of Object.keys(sparse)) if (!/id$|Id$|code$|Code$|amount|board|index|name|summary/i.test(k)) delete sparse[k]
    for (const o of SUPPORTED[flow]) {
      const m = def.userMessage(o, sparse)!
      expect(m.sms).not.toMatch(/undefined|null|NaN/)
      expect(m.emailHtml).not.toMatch(/undefined|null|NaN/)
    }
  })
})

describe("withdrawal specifics", () => {
  it("approved keeps push + in-app (existing channels preserved) and shows the amount", () => {
    const m = FLOWS.withdrawal.userMessage("approved", { withdrawalId: "w1", amount: 120.5 })!
    expect(m.sms).toContain("GHS 120.50")
    expect(m.push?.url).toBe("/dashboard/shop-dashboard")
    expect(m.inApp?.type).toBe("withdrawal_approved")
  })
  it("rejected in-app uses the existing withdrawal_rejected type", () => {
    expect(FLOWS.withdrawal.userMessage("rejected", { withdrawalId: "w1", amount: 5 })!.inApp?.type).toBe("withdrawal_rejected")
  })
})
describe("shop specifics", () => {
  it("approved keeps push + in-app", () => {
    const m = FLOWS.shop.userMessage("approved", { shopId: "s", shopName: "Kofi Data" })!
    expect(m.push).toBeDefined()
    expect(m.inApp).toBeDefined()
    expect(m.sms).toContain("approved")
  })
})
