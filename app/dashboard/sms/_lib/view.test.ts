import { describe, it, expect } from "vitest"
import {
  addNumbers, costSummary, bestValueId, perSms, ledgerLabel, sendErrorMessage, logStatus, isInFlight,
  limitsLine, MOMO_PHONE, resolveTokens, splitNumbers, parseRows, contactName, senderSuggestions,
  MAX_RECIPIENTS, INSERT_CHIPS,
} from "./view"

describe("addNumbers", () => {
  it("dedupes against existing and within input", () => {
    expect(addNumbers(["0244000001"], "0244000001, 0244000002 0244000002")).toEqual({
      list: ["0244000001", "0244000002"], added: 1, capped: false,
    })
  })
  it("respects the cap and reports capped", () => {
    const r = addNumbers(["a"], "b c d", 3)
    expect(r.list).toEqual(["a", "b", "c"])
    expect(r.added).toBe(2)
    expect(r.capped).toBe(true)
  })
  it("does not flag capped for duplicates at the cap", () => {
    expect(addNumbers(["a", "b"], "a", 2).capped).toBe(false)
  })
})

describe("costSummary", () => {
  it("computes shortfall", () => {
    expect(costSummary(3, 2, 5)).toEqual({ total: 6, short: 1, overBudget: true })
  })
  it("is not over budget when balance covers it", () => {
    expect(costSummary(3, 2, 6)).toEqual({ total: 6, short: 0, overBudget: false })
  })
})

describe("bundles", () => {
  it("perSms guards zero units", () => {
    expect(perSms(10, 0)).toBe(0)
    expect(perSms(10, 100)).toBeCloseTo(0.1)
  })
  it("bestValueId picks the lowest per-SMS price", () => {
    expect(bestValueId([
      { id: "a", price_ghs: 10, units: 100 },
      { id: "b", price_ghs: 40, units: 500 },
    ])).toBe("b")
  })
  it("bestValueId is null for a single bundle", () => {
    expect(bestValueId([{ id: "a", price_ghs: 10, units: 100 }])).toBeNull()
  })
})

describe("ledgerLabel", () => {
  it("labels campaign sends", () => {
    expect(ledgerLabel("campaign_send", 12)).toBe("SMS campaign #12")
    expect(ledgerLabel("campaign_send", null)).toBe("SMS campaign")
  })
  it("labels refunds, purchases and fallbacks", () => {
    expect(ledgerLabel("campaign_refund", 3)).toBe("Refund — campaign #3")
    expect(ledgerLabel("campaign_refund", null)).toBe("Refund — failed delivery")
    expect(ledgerLabel("bundle_wallet", null)).toBe("Credits purchased")
    expect(ledgerLabel("welcome_bonus", null)).toBe("Welcome bonus")
    expect(ledgerLabel("admin_alloc", null)).toBe("Credits added by support")
    expect(ledgerLabel("weird", null)).toBe("Credit adjustment")
  })
})

describe("sendErrorMessage", () => {
  it("includes the block reason", () => {
    expect(sendErrorMessage("BLOCKED", "phishing link")).toBe("Message blocked: phishing link")
    expect(sendErrorMessage("BLOCKED")).toBe("This message was blocked by our content rules.")
  })
  it("formats the recipient cap", () => {
    expect(sendErrorMessage("TOO_MANY_RECIPIENTS")).toContain("5,000")
  })
  it("falls back", () => {
    expect(sendErrorMessage("X", undefined, "fb")).toBe("fb")
    expect(sendErrorMessage("X")).toBe("X")
    expect(sendErrorMessage(undefined)).toBe("Something went wrong")
  })
})

describe("logStatus", () => {
  it("maps held and unknown statuses", () => {
    expect(logStatus("held").label).toBe("Under review")
    expect(logStatus("sent").tone).toBe("success")
    expect(logStatus("zzz")).toEqual({ label: "zzz", tone: "muted" })
  })
  it("isInFlight", () => {
    expect(isInFlight("queued")).toBe(true)
    expect(isInFlight("held")).toBe(false)
  })
})

describe("limitsLine / MOMO_PHONE", () => {
  it("formats limits", () => {
    expect(limitsLine({ perSend: 1000, perHour: 2000, perDay: 1000000 }))
      .toBe("1,000 recipients/send · 2,000 sends/hour · 1,000,000 recipients/day")
  })
  it("validates momo numbers", () => {
    expect(MOMO_PHONE.test("0244123456")).toBe(true)
    expect(MOMO_PHONE.test("244123456")).toBe(true)
    expect(MOMO_PHONE.test("12345")).toBe(false)
  })
})

describe("ported helpers", () => {
  const tokens = { shop_name: "Kofi", shop_link: "", shop_phone: "024", shop_whatsapp: "" }
  it("resolveTokens keeps literal token when empty and returns msg for null tokens", () => {
    expect(resolveTokens("Hi {shop_name} {shop_link}", tokens)).toBe("Hi Kofi {shop_link}")
    expect(resolveTokens("Hi {shop_name}", null)).toBe("Hi {shop_name}")
  })
  it("resolveTokens does not splice $ patterns", () => {
    expect(resolveTokens("{shop_name}", { ...tokens, shop_name: "A$&B" })).toBe("A$&B")
  })
  it("splitNumbers", () => {
    expect(splitNumbers("a, b\nc")).toEqual(["a", "b", "c"])
  })
  it("parseRows skips a header row and blanks names", () => {
    expect(parseRows("phone,first,last\n0244000001,Ama,\n0244000002")).toEqual([
      { phone_number: "0244000001", first_name: "Ama", last_name: undefined },
      { phone_number: "0244000002", first_name: undefined, last_name: undefined },
    ])
  })
  it("contactName", () => {
    const base = { id: "1", group_id: "g", phone_number: "1", opted_out: false, verify_status: "unverified" as const, verified_at: null, created_at: "" }
    expect(contactName({ ...base, first_name: "A", last_name: "B", verified_name: "V" })).toBe("A B")
    expect(contactName({ ...base, first_name: null, last_name: null, verified_name: "V" })).toBe("V")
    expect(contactName({ ...base, first_name: null, last_name: null, verified_name: null })).toBe("—")
  })
  it("senderSuggestions", () => {
    const s = senderSuggestions("Kofi's Data Hub")
    expect(s[0]).toBe("KOFISDATAHUB".slice(0, 11))
    expect(s[0].length).toBeLessThanOrEqual(11)
    expect(senderSuggestions("  !! ")).toEqual([])
  })
  it("constants", () => {
    expect(MAX_RECIPIENTS).toBe(5000)
    expect(INSERT_CHIPS).toHaveLength(6)
  })
})
