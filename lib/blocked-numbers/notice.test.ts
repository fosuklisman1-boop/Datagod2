import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
const getSettings = vi.fn()
vi.mock("./settings", async (orig) => ({ ...(await orig<typeof import("./settings")>()), getBlockedNumbersSettings: (...a: unknown[]) => getSettings(...a) }))

import { DEFAULT_BLOCKED_SETTINGS } from "./settings"
import {
  noticeModeFrom, getNoticeMode, webCustomerNotice, dealerNotice, botPrompt, hubtelNote, ttbNotice, aiToolNotice,
  type NoticeMode,
} from "./notice"
import { NOT_VERIFIED_MESSAGE, RECIPIENT_BLOCKED_PROMPT } from "@/lib/mtn-providers/customer-verification"
import { RECIPIENT_BLOCKED_NOTE } from "@/lib/ussd-hubtel/confirm-note"
import { calculateSegments } from "@/lib/sms/segments"

const MODES: NoticeMode[] = ["off", "saved", "saved_sms"]
const s = (enabled: boolean, sms: boolean) => ({ ...DEFAULT_BLOCKED_SETTINGS, enabled, customer_sms_enabled: sms })

describe("noticeModeFrom", () => {
  it("maps the two switches", () => {
    expect(noticeModeFrom(s(false, false))).toBe("off")
    expect(noticeModeFrom(s(false, true))).toBe("off")
    expect(noticeModeFrom(s(true, false))).toBe("saved")
    expect(noticeModeFrom(s(true, true))).toBe("saved_sms")
  })
})

describe("getNoticeMode", () => {
  beforeEach(() => { getSettings.mockReset() })
  it("reads settings", async () => {
    getSettings.mockResolvedValue(s(true, true))
    expect(await getNoticeMode()).toBe("saved_sms")
  })
  it("any failure is off", async () => {
    getSettings.mockImplementation(() => { throw new Error("boom") })
    expect(await getNoticeMode()).toBe("off")
  })
})

describe("builders", () => {
  it("webCustomerNotice", () => {
    expect(webCustomerNotice("off")).toBe(NOT_VERIFIED_MESSAGE)
    expect(webCustomerNotice("saved_sms")).toBe("This MTN number isn't ready for data yet, so it can't be ordered now. We've saved it and will send an SMS to that number when it's ready. You can use a different number now.")
    expect(webCustomerNotice("saved")).toBe("This MTN number isn't ready for data yet, so it can't be ordered now. We've saved it and check it every day. Please try again later or use a different number.")
  })
  it("dealerNotice", () => {
    expect(dealerNotice("off")).toBe(NOT_VERIFIED_MESSAGE)
    const t = "This MTN number isn't ready for data yet, so it can't be ordered now. We've saved it to Blocked Numbers on your dashboard and will notify you when it's ready."
    expect(dealerNotice("saved")).toBe(t)
    expect(dealerNotice("saved_sms")).toBe(t)
  })
  it("botPrompt", () => {
    expect(botPrompt("off")).toBe(RECIPIENT_BLOCKED_PROMPT)
    expect(botPrompt("saved_sms")).toBe("MTN number not ready for data yet.\nSaved: we'll SMS you when ready.\nEnter a different number:\n\n0. Back")
    expect(botPrompt("saved")).toBe("MTN number not ready for data yet.\nSaved: try again later.\nEnter a different number:\n\n0. Back")
  })
  it("hubtelNote", () => {
    expect(hubtelNote("off")).toBe(RECIPIENT_BLOCKED_NOTE)
    expect(hubtelNote("saved_sms")).toBe("MTN number not ready for data yet. Saved: we'll SMS you when ready.")
    expect(hubtelNote("saved")).toBe("MTN number not ready for data yet. Saved: try again later.")
  })
  it("ttbNotice", () => {
    expect(ttbNotice("off")).toBe("That MTN number is not ready for data yet. Try a different number.")
    expect(ttbNotice("saved_sms")).toBe("That MTN number is not ready for data yet. We saved it and will text you when it's ready.")
    expect(ttbNotice("saved")).toBe("That MTN number is not ready for data yet. We saved it. Try again later.")
  })
  it("aiToolNotice", () => {
    const base = `${NOT_VERIFIED_MESSAGE} Ask the customer for a different recipient number.`
    expect(aiToolNotice("off")).toBe(base)
    expect(aiToolNotice("saved_sms")).toBe(`${base} Tell the customer we've saved the number and will text them when it's ready.`)
    expect(aiToolNotice("saved")).toBe(`${base} Tell the customer we've saved the number and they can try again later.`)
  })
  it("screens fit 160 chars and TTB is one segment", () => {
    for (const m of MODES) {
      expect(botPrompt(m).length).toBeLessThanOrEqual(160)
      expect(`${hubtelNote(m)}\n`.length).toBeLessThanOrEqual(160)
      const r = calculateSegments(ttbNotice(m))
      expect(r.encoding).toBe("gsm7")
      expect(r.segments).toBe(1)
    }
  })
})
