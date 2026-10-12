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

describe.each(Object.keys(FLOWS) as FlowId[])("escaping %s", (flow) => {
  it("renders hostile values as escaped text in the emails", () => {
    const def = FLOWS[flow]
    const ctx = ctxFor[flow]
    const htmls = [def.adminAlert(ctx).html, ...SUPPORTED[flow].map((o) => def.userMessage(o, ctx)!.emailHtml)]
    expect(htmls.some((h) => h.includes("&lt;script&gt;"))).toBe(true)
    for (const h of htmls) expect(h).not.toContain("<script>")
  })
})

describe("withdrawal never prints unmasked payout numbers", () => {
  const PHONE = "0241112222"
  const ACCT = "123456789012"
  for (const number of [PHONE, ACCT]) {
    it(`masks ${number} everywhere`, () => {
      const ctx = { withdrawalId: "w1", amount: 50, shopName: "Kofi", method: "Mobile Money", phone: number, reason: "No", remainingBalance: "5.00" }
      const texts: string[] = [JSON.stringify(FLOWS.withdrawal.adminAlert(ctx))]
      for (const o of ["approved", "rejected", "completed"] as Outcome[]) texts.push(JSON.stringify(FLOWS.withdrawal.userMessage(o, ctx)))
      for (const t of texts) expect(t).not.toContain(number)
      expect(texts.join("")).toContain(number.slice(0, 3) + "*")
    })
  }
})

describe("partial contexts never leak undefined/null/NaN", () => {
  const bad = /undefined|null|NaN/
  const check = (flow: FlowId, ctx: any) => {
    const def = FLOWS[flow]
    const a = def.adminAlert(ctx)
    expect(a.html + a.subject + a.pushBody).not.toMatch(bad)
    for (const o of SUPPORTED[flow]) {
      const m = def.userMessage(o, ctx)!
      expect(m.sms + m.emailHtml + m.emailSubject + JSON.stringify(m.push ?? {}) + JSON.stringify(m.inApp ?? {})).not.toMatch(bad)
    }
  }
  const base = { withdrawalId: "w1", amount: 5 }
  it.each([
    ["phone only", { phone: "0241112222" }],
    ["method only", { method: "Mobile Money" }],
    ["reason only", { reason: "Because" }],
    ["remainingBalance only", { remainingBalance: "1.00" }],
  ])("withdrawal %s", (_n, extra) => check("withdrawal", { ...base, ...extra }))
  it("results_check whatsapp without shopName", () =>
    check("results_check", { requestId: "r", examBoard: "WASSCE", indexNumber: "123", channel: "whatsapp" }))
  it("shop without reason", () => check("shop", { shopId: "s", shopName: "Kofi Data" }))
})

describe("withdrawal money guard", () => {
  it.each([NaN, Infinity, undefined as any])("non-finite amount %s prints GHS 0.00", (amount) => {
    const m = FLOWS.withdrawal.userMessage("approved", { withdrawalId: "w", amount })!
    expect(m.sms).toContain("GHS 0.00")
    expect(m.sms).not.toMatch(/NaN|Infinity|undefined/)
  })
})

describe("results_check completed wording by channel", () => {
  const base = { requestId: "r", examBoard: "WASSCE", indexNumber: "123" }
  const sms = (channel?: string | null) => FLOWS.results_check.userMessage("completed", { ...base, channel })!
  it("whatsapp and whatsapp_shop point to WhatsApp", () => {
    for (const ch of ["whatsapp", "whatsapp_shop"]) {
      expect(sms(ch).sms).toBe("Your WASSCE results check (index 123) has been completed. Check your WhatsApp for the result.")
      expect(sms(ch).emailHtml).toContain("Check your WhatsApp for the result.")
    }
  })
  it("web points to the dashboard", () => {
    expect(sms("web").sms).toContain("Check your dashboard for the result.")
    expect(sms("web").emailHtml).toContain("Check your dashboard for the result.")
  })
  it("other or missing channel omits the sentence and claims no delivery", () => {
    for (const ch of ["ussd", null, undefined]) {
      expect(sms(ch).sms).toBe("Your WASSCE results check (index 123) has been completed.")
      expect(sms(ch).emailHtml).not.toMatch(/Check your|sent the result/)
    }
  })
})
