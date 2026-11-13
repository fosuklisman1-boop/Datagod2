import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const store = vi.hoisted(() => ({ storeOutbound: vi.fn() }))
vi.mock("./store", () => ({ storeOutbound: store.storeOutbound }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))

import { sendReply } from "./send-reply"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"

const db = {} as SupabaseClient
const settings = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, ...over })
const base = { line: "main" as const, sender: "0200000101", body: "Send YES to confirm 1GB for GHS 5.00" }

beforeEach(() => {
  store.storeOutbound.mockReset()
  store.storeOutbound.mockResolvedValue(undefined)
})

describe("sendReply", () => {
  it("sends once with the text_to_buy_reply type and skipLogging, then stores the outbound row", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    const r = await sendReply(db, { ...base, settings: settings(), orderLinkId: "link-1" }, { send })
    expect(r).toEqual({ sent: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      phone: "0200000101",
      message: base.body,
      type: "text_to_buy_reply",
      senderId: undefined,
      skipLogging: true,
    })
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
    expect(store.storeOutbound).toHaveBeenCalledWith(db, { line: "main", sender: "0200000101", body: base.body, orderLinkId: "link-1" })
  })

  it("passes an empty replySenderId as undefined and a set one through", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    await sendReply(db, { ...base, settings: settings({ replySenderId: "" }) }, { send })
    expect(send.mock.calls[0][0].senderId).toBeUndefined()
    await sendReply(db, { ...base, settings: settings({ replySenderId: "DATAGOD" }) }, { send })
    expect(send.mock.calls[1][0].senderId).toBe("DATAGOD")
  })

  it("refuses a two-segment body: nothing sent, nothing stored", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    const r = await sendReply(db, { ...base, body: "a".repeat(161), settings: settings() }, { send })
    expect(r).toEqual({ sent: false })
    expect(send).not.toHaveBeenCalled()
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it("accepts exactly 160 GSM-7 characters", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    expect(await sendReply(db, { ...base, body: "a".repeat(160), settings: settings() }, { send })).toEqual({ sent: true })
  })

  it("refuses a unicode body even when short (70 chars per segment)", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    const r = await sendReply(db, { ...base, body: "Your order — ok", settings: settings() }, { send })
    expect(r).toEqual({ sent: false })
    expect(send).not.toHaveBeenCalled()
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it.each([["empty", ""], ["whitespace", "   "], ["newlines", "\n \t"], ["non-string", undefined as unknown as string], ["number", 5 as unknown as string]])(
    "refuses a %s body: nothing sent, nothing stored",
    async (_n, body) => {
      const send = vi.fn().mockResolvedValue({ success: true })
      const r = await sendReply(db, { ...base, body, settings: settings() }, { send })
      expect(r).toEqual({ sent: false })
      expect(send).not.toHaveBeenCalled()
      expect(store.storeOutbound).not.toHaveBeenCalled()
    },
  )

  it("a skipped send (SMS switched off) is not sent and is not stored", async () => {
    const send = vi.fn().mockResolvedValue({ success: true, skipped: true })
    const r = await sendReply(db, { ...base, settings: settings() }, { send })
    expect(r).toEqual({ sent: false, skipped: true })
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it("send rejecting does not throw; returns sent:false and records the out row", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"))
    const r = await sendReply(db, { ...base, settings: settings() }, { send })
    expect(r).toEqual({ sent: false })
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
  })

  it("a { success: false } result returns sent:false and records the out row", async () => {
    const send = vi.fn().mockResolvedValue({ success: false, error: "nope" })
    const r = await sendReply(db, { ...base, settings: settings() }, { send })
    expect(r).toEqual({ sent: false })
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
  })

  it("a failure while storing the out row never throws", async () => {
    store.storeOutbound.mockRejectedValue(new Error("db"))
    const send = vi.fn().mockResolvedValue({ success: true })
    await expect(sendReply(db, { ...base, settings: settings() }, { send })).resolves.toEqual({ sent: true })
  })

  it("never logs the body or the phone", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")]
    await sendReply(db, { ...base, settings: settings() }, { send: vi.fn().mockRejectedValue(new Error("boom")) })
    for (const s of spies) {
      const text = JSON.stringify(s.mock.calls)
      expect(text).not.toContain("0200000101")
      expect(text).not.toContain("YES")
      s.mockRestore()
    }
  })
})
