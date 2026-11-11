import { describe, it, expect, vi, beforeEach } from "vitest"
import { momoClaimFlow } from "./momo-claim"

const { alertAdminsOfRequest } = vi.hoisted(() => ({ alertAdminsOfRequest: vi.fn() }))
vi.mock("../index", () => ({ alertAdminsOfRequest }))

import { notifyMomoAdmins } from "../momo-claim"

const FULL_TXID = "88776655443322"

describe("momo_claim admin alert", () => {
  it("credited: subject/title, amount in GHS, last 4 only, deep link", () => {
    const a = momoClaimFlow.adminAlert({ kind: "credited", amountPesewas: 12550, txidLast4: "3322" })
    expect(a.subject).toBe("MoMo claim credited")
    expect(a.pushTitle).toBe("MoMo claim credited")
    expect(a.pushBody).toContain("GHS 125.50")
    expect(a.pushBody).toContain("3322")
    expect(a.html).toContain("GHS 125.50")
    expect(a.url).toBe("/admin/momo-claims")
  })

  it("never includes more than 4 txid digits, names, phones or raw SMS", () => {
    const ctx: any = {
      kind: "flagged", amountPesewas: 500, txidLast4: "3322", reasons: ["first_claim"],
      txid: FULL_TXID, payerName: "KOFI MENSAH", phone: "0241112222", rawSms: "You have received GHS 5.00 from KOFI MENSAH",
    }
    const a = momoClaimFlow.adminAlert(ctx)
    const all = JSON.stringify(a)
    expect(all).not.toContain(FULL_TXID)
    expect(all).not.toContain("KOFI")
    expect(all).not.toContain("0241112222")
    expect(all).not.toContain("received")
    expect(all).toContain("3322")
  })

  it("flagged: reasons in plain words", () => {
    const a = momoClaimFlow.adminAlert({
      kind: "flagged", amountPesewas: 100,
      reasons: ["first_claim", "amount_mismatch", "txid_regression", "balance_repeat", "above_max", "above_review_threshold", "daily_cap", "too_many_attempts"],
    })
    expect(a.subject).toBe("MoMo claim needs review")
    for (const w of ["first claim", "amount mismatch", "old transaction ID", "repeated balance", "above maximum", "large amount", "daily cap reached", "too many wrong attempts"]) {
      expect(a.html).toContain(w)
      expect(a.pushBody).toContain(w)
    }
    expect(a.html).not.toContain("first_claim")
  })

  it("unparsed and reconciliation_missing subjects", () => {
    expect(momoClaimFlow.adminAlert({ kind: "unparsed" }).subject).toBe("Unreadable MoMo SMS")
    expect(momoClaimFlow.adminAlert({ kind: "reconciliation_missing" }).pushTitle).toBe("Claimed payments missing from MoMo statement")
  })

  it("escapes unknown reasons and handles missing fields without undefined/null/NaN", () => {
    const a = momoClaimFlow.adminAlert({ kind: "flagged", reasons: ["<script>x</script>"] })
    expect(a.html).not.toContain("<script>")
    const b = momoClaimFlow.adminAlert({ kind: "credited" })
    expect(JSON.stringify(b)).not.toMatch(/undefined|null|NaN/)
  })

  it("has no user-outcome message", () => {
    for (const o of ["approved", "rejected", "completed", "resolved"] as const) {
      expect(momoClaimFlow.userMessage(o, { kind: "credited" })).toBeNull()
    }
  })
})

describe("notifyMomoAdmins", () => {
  beforeEach(() => {
    alertAdminsOfRequest.mockReset()
  })

  it("sends through the central notifier with the momo_claim flow", async () => {
    alertAdminsOfRequest.mockResolvedValue([])
    const alert = { kind: "credited" as const, amountPesewas: 100, txidLast4: "3322" }
    await expect(notifyMomoAdmins(alert)).resolves.toBeUndefined()
    expect(alertAdminsOfRequest).toHaveBeenCalledWith("momo_claim", alert)
  })

  it("never throws when the notifier rejects", async () => {
    alertAdminsOfRequest.mockRejectedValue(new Error("push down"))
    await expect(notifyMomoAdmins({ kind: "unparsed" })).resolves.toBeUndefined()
  })

  it("never throws when the notifier throws synchronously", async () => {
    alertAdminsOfRequest.mockImplementation(() => { throw new Error("boom") })
    await expect(notifyMomoAdmins({ kind: "unparsed" })).resolves.toBeUndefined()
  })
})
