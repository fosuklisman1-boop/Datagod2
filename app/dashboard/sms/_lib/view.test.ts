import { describe, it, expect } from "vitest"
import {
  addNumbers, costSummary, bestValueId, perSms, ledgerLabel, sendErrorMessage, logStatus, isInFlight,
  limitsLine, MOMO_PHONE, resolveTokens, splitNumbers, parseRows, contactName, senderSuggestions,
  MAX_RECIPIENTS, INSERT_CHIPS, HELD_SEND_MESSAGE, sendOutcomeMessage, partialStopReason, recipientErrorText,
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
  it("POLICY_REJECTED shows the server's customer-safe reason as-is", () => {
    expect(sendErrorMessage("POLICY_REJECTED", "You've reached 20 sends this hour. Try again within the hour."))
      .toBe("You've reached 20 sends this hour. Try again within the hour.")
    expect(sendErrorMessage("POLICY_REJECTED")).toBe("This send isn't allowed right now. Check your limits and message, then try again.")
    expect(sendErrorMessage("POLICY_REJECTED", "   ")).toBe("This send isn't allowed right now. Check your limits and message, then try again.")
  })
  it("SEND_IN_PROGRESS asks to retry in a few seconds", () => {
    expect(sendErrorMessage("SEND_IN_PROGRESS")).toBe("Another send from your account is still being processed. Please try again in a few seconds.")
  })
  it("held sends get the review message", () => {
    expect(HELD_SEND_MESSAGE).toBe("Sent for a quick review — you'll be notified")
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

import { RECORD_CHIPS, chipStatus, pageCount, formatCount, timeAgo, recipientStatus, toneBadgeClass } from "./view"

describe("records helpers", () => {
  it("maps chips to status values", () => {
    expect(RECORD_CHIPS.map((c) => c.label)).toEqual(["All", "Queued", "Processing", "Completed", "Partial", "Failed", "Held", "Scheduled"])
    expect(chipStatus("all")).toBe("")
    expect(chipStatus("processing")).toBe("sending")
    expect(chipStatus("completed")).toBe("sent")
    expect(chipStatus("held")).toBe("held")
    expect(chipStatus("bogus")).toBe("")
  })
  it("pageCount is at least 1", () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(25)).toBe(1)
    expect(pageCount(26)).toBe(2)
    expect(pageCount(NaN)).toBe(1)
  })
  it("formatCount", () => {
    expect(formatCount(12345)).toBe("12,345")
    expect(formatCount(undefined)).toBe("0")
  })
  it("timeAgo", () => {
    const now = Date.parse("2026-10-11T12:00:00Z")
    expect(timeAgo("2026-10-11T11:59:50Z", now)).toBe("just now")
    expect(timeAgo("2026-10-11T11:30:00Z", now)).toBe("30m ago")
    expect(timeAgo("2026-10-11T09:00:00Z", now)).toBe("3h ago")
    expect(timeAgo("2026-10-08T12:00:00Z", now)).toBe("3d ago")
    expect(timeAgo("garbage", now)).toBe("")
  })
  it("recipientStatus", () => {
    expect(recipientStatus({ status: "sent", delivery_status: "delivered" }).label).toBe("Delivered")
    expect(recipientStatus({ status: "failed", refunded: true }).label).toBe("Refunded")
    expect(recipientStatus({ status: "failed" }).tone).toBe("danger")
    expect(recipientStatus({ status: "sent", delivery_status: "pending" }).label).toBe("Sent")
    expect(recipientStatus({ status: "claimed" }).label).toBe("Sending")
    expect(recipientStatus({ status: "pending" }).label).toBe("Queued")
  })
  it("toneBadgeClass distinguishes tones", () => {
    expect(toneBadgeClass("success")).not.toBe(toneBadgeClass("danger"))
  })
})

describe("sendOutcomeMessage", () => {
  it("held AND partial shows both the review and the partial warning", () => {
    const r = sendOutcomeMessage({ held: true, partial: true, stoppedReason: "INSUFFICIENT_CREDITS", total: 500, batches: 1 })
    expect(r.tone).toBe("warning")
    expect(r.text).toBe("500 recipients sent for a quick review — you'll be notified. The rest were not sent: ran out of credits — top up and resend the rest.")
  })
  it("held only", () => {
    expect(sendOutcomeMessage({ held: true, partial: false, total: 1200 })).toEqual({ tone: "success", text: HELD_SEND_MESSAGE })
  })
  it("partial only", () => {
    expect(sendOutcomeMessage({ partial: true, stoppedReason: "SUSPENDED", total: 1000, batches: 2 }))
      .toEqual({ tone: "warning", text: "Sent 1,000 recipients in 2 batches, then the account was suspended mid-send." })
  })
  it("normal", () => {
    expect(sendOutcomeMessage({ total: 1, batches: 1, creditsReserved: 2 })).toEqual({ tone: "success", text: "Queued 1 recipient (2 credits)" })
  })
  it("partialStopReason maps known codes and falls back", () => {
    expect(partialStopReason("SMS_DISABLED")).toBe("SMS was paused by the platform — resend the rest later")
    expect(partialStopReason("NOT_ACTIVATED")).toBe("the account is no longer active")
    expect(partialStopReason("SEND_ERROR")).toBe("the rest could not be sent")
    expect(partialStopReason(undefined)).toBe("the rest could not be sent")
  })
})

describe("recipientErrorText", () => {
  it("maps internal codes to friendly text", () => {
    expect(recipientErrorText("held_rejected")).toBe("Not approved after review — credits refunded")
    expect(recipientErrorText("hubtel_unconfirmed")).toBe("Delivery could not be confirmed")
  })
  it("keeps ordinary provider errors and empties", () => {
    expect(recipientErrorText("Invalid destination number")).toBe("Invalid destination number")
    expect(recipientErrorText(null)).toBe("")
    expect(recipientErrorText(undefined)).toBe("")
  })
})
