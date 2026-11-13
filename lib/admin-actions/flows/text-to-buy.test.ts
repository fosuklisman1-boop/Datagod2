import { describe, it, expect, vi, beforeEach } from "vitest"
import { textToBuyFlow } from "./text-to-buy"

const { alertAdminsOfRequest } = vi.hoisted(() => ({ alertAdminsOfRequest: vi.fn() }))
vi.mock("../index", () => ({ alertAdminsOfRequest }))

import { notifyTextToBuyAdmins } from "../text-to-buy"

describe("text_to_buy admin alert", () => {
  it("names the changed settings in plain words, with a deep link", () => {
    const a = textToBuyFlow.adminAlert({ kind: "setting_changed", keys: ["ttb_main_enabled", "ttb_stale_minutes"] })
    expect(a.subject).toBe("Text-to-Buy setting changed")
    expect(a.pushBody).toBe("Changed: main enabled, stale minutes")
    expect(a.html).toContain("main enabled, stale minutes")
    expect(a.url).toBe("/admin/text-to-buy")
  })
  it("never carries values or numbers that a caller passes in by mistake", () => {
    const ctx: any = { kind: "setting_changed", keys: ["ttb_main_number"], value: "0200000101", mainNumber: "0200000101" }
    const all = JSON.stringify(textToBuyFlow.adminAlert(ctx))
    expect(all).not.toContain("0200000101")
  })
  it("escapes odd keys and survives a missing list without undefined/null/NaN", () => {
    expect(textToBuyFlow.adminAlert({ kind: "setting_changed", keys: ["<script>x</script>"] }).html).not.toContain("<script>")
    expect(JSON.stringify(textToBuyFlow.adminAlert({ kind: "setting_changed" } as any))).not.toMatch(/undefined|null|NaN/)
  })
  it("has no user-outcome message", () => {
    for (const o of ["approved", "rejected", "completed", "resolved"] as const) {
      expect(textToBuyFlow.userMessage(o, { kind: "setting_changed", keys: [] })).toBeNull()
    }
  })
})

describe("notifyTextToBuyAdmins", () => {
  beforeEach(() => {
    alertAdminsOfRequest.mockReset()
  })
  it("sends through the central notifier with the text_to_buy flow", async () => {
    alertAdminsOfRequest.mockResolvedValue([])
    const alert = { kind: "setting_changed" as const, keys: ["ttb_main_enabled"] }
    await expect(notifyTextToBuyAdmins(alert)).resolves.toBeUndefined()
    expect(alertAdminsOfRequest).toHaveBeenCalledWith("text_to_buy", alert)
  })
  it("never throws when the notifier rejects", async () => {
    alertAdminsOfRequest.mockRejectedValue(new Error("down"))
    await expect(notifyTextToBuyAdmins({ kind: "setting_changed", keys: [] })).resolves.toBeUndefined()
  })
  it("never throws when the notifier throws synchronously", async () => {
    alertAdminsOfRequest.mockImplementation(() => { throw new Error("boom") })
    await expect(notifyTextToBuyAdmins({ kind: "setting_changed", keys: [] })).resolves.toBeUndefined()
  })
})
