import { describe, it, expect } from "vitest"
import { apiAccessFlow } from "./api-access"
import { FLOWS } from "../registry"
import type { Outcome } from "../types"

const WARN = "If this wasn't you, change your password and contact support."

describe("apiAccessFlow.adminAlert", () => {
  it("names the code, deep-links to the approvals tab and escapes the requester", () => {
    const a = apiAccessFlow.adminAlert({ kind: "key", code: "API-7K3Q9M", keyType: "standard", who: "<img src=x>" })
    expect(a.subject).toContain("API-7K3Q9M")
    expect(a.url).toBe("/admin/api-keys?tab=approvals")
    expect(a.html).not.toContain("<img src=x>")
    expect(a.html).toContain("&lt;img src=x&gt;")
  })
  it("says what kind of request it is", () => {
    expect(apiAccessFlow.adminAlert({ kind: "access", code: "API-M4T8WX" }).subject).toMatch(/access/i)
    expect(apiAccessFlow.adminAlert({ kind: "swap", code: "API-Q2N7RB", keyType: "commission" }).subject).toMatch(/replacement/i)
  })
})

describe("apiAccessFlow.userMessage", () => {
  it("requested: email + in-app only, with the hijack warning", () => {
    for (const kind of ["key", "swap", "access"] as const) {
      const m = apiAccessFlow.userMessage("requested", { kind, code: "API-7K3Q9M" })!
      expect(m.sms).toBeUndefined()
      expect(m.push).toBeUndefined()
      expect(m.inApp).toBeDefined()
      expect(m.inApp!.message).toContain(WARN)
      expect(m.emailHtml).toContain(WARN.replace("'", "&#39;"))
    }
  })
  it("approved and rejected: email + sms + push + in-app, and the sms never carries a key", () => {
    for (const o of ["approved", "rejected"] as const) {
      for (const kind of ["key", "swap", "access"] as const) {
        const m = apiAccessFlow.userMessage(o, { kind, code: "API-7K3Q9M", keyType: "standard", reason: "Not enough history" })!
        expect(m.sms).toBeTruthy()
        expect(m.sms).not.toContain("dg2_")
        expect(m.push).toBeDefined()
        expect(m.inApp).toBeDefined()
      }
    }
  })
  it("rejected: the reason is shown and escaped in html", () => {
    const m = apiAccessFlow.userMessage("rejected", { kind: "key", code: "API-7K3Q9M", reason: "<b>no</b> & more" })!
    expect(m.emailHtml).toContain("&lt;b&gt;no&lt;/b&gt; &amp; more")
    expect(m.emailHtml).not.toContain("<b>no</b>")
    expect(m.inApp!.message).toContain("<b>no</b> & more")
  })
  it("approved swap: says the old key has stopped working", () => {
    const m = apiAccessFlow.userMessage("approved", { kind: "swap", code: "API-Q2N7RB", keyType: "standard" })!
    expect(m.sms).toMatch(/old key has stopped working/i)
    expect(m.inApp!.message).toMatch(/old key has stopped working/i)
  })
  it("removed: email + in-app only", () => {
    const m = apiAccessFlow.userMessage("removed", { kind: "access" })!
    expect(m.sms).toBeUndefined()
    expect(m.push).toBeUndefined()
    expect(m.inApp).toBeDefined()
  })
  it("completed and resolved send nothing", () => {
    expect(apiAccessFlow.userMessage("completed", { kind: "key" })).toBeNull()
    expect(apiAccessFlow.userMessage("resolved", { kind: "key" })).toBeNull()
  })
})

describe("registry", () => {
  it("api_access is registered", () => expect(FLOWS.api_access).toBe(apiAccessFlow))
  it("every other flow returns null for requested and removed", () => {
    const sample: Record<string, any> = {
      withdrawal: { withdrawalId: "w", amount: 1 }, afa: { orderCode: "o", fullName: "n" },
      results_check: { requestId: "r", examBoard: "WAEC", indexNumber: "1" }, shop: { shopId: "s", shopName: "S" },
      sender_id: { senderIdId: "i", senderId: "X" }, complaint: { complaintId: "c" },
      momo_claim: { kind: "credited" }, text_to_buy: { kind: "setting_changed", keys: [] },
    }
    for (const [id, def] of Object.entries(FLOWS)) {
      if (id === "api_access") continue
      for (const o of ["requested", "removed"] as Outcome[]) expect(def.userMessage(o, sample[id]), `${id}/${o}`).toBeNull()
    }
  })
})
