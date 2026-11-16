import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const store = vi.hoisted(() => ({ storeOutbound: vi.fn() }))
vi.mock("./store", () => ({ storeOutbound: store.storeOutbound }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))
const credits = vi.hoisted(() => ({ drawReserve: vi.fn(), undrawReserve: vi.fn(), chargeSingleReply: vi.fn(), refundSingleReply: vi.fn() }))
vi.mock("./shop/credits", async () => {
  const actual = await vi.importActual<typeof import("./shop/credits")>("./shop/credits")
  return {
    ...actual,
    drawReserve: credits.drawReserve,
    undrawReserve: credits.undrawReserve,
    chargeSingleReply: credits.chargeSingleReply,
    refundSingleReply: credits.refundSingleReply,
  }
})

import { sendReply } from "./send-reply"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"

const db = {} as SupabaseClient
const settings = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, ...over })
const base = { line: "main" as const, sender: "0200000101", body: "Send YES to confirm 1GB for GHS 5.00" }

beforeEach(() => {
  store.storeOutbound.mockReset()
  store.storeOutbound.mockResolvedValue(undefined)
  for (const f of Object.values(credits)) f.mockReset()
  credits.drawReserve.mockResolvedValue(false)
  credits.chargeSingleReply.mockResolvedValue(true)
  credits.refundSingleReply.mockResolvedValue(true)
  credits.undrawReserve.mockResolvedValue(true)
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

  it("picks the sender ID from the line: shop uses shopReplySenderId, main uses replySenderId, never crossed", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    const both = settings({ replySenderId: "MAINID", shopReplySenderId: "SHOPID" })
    await sendReply(db, { ...base, line: "shop", settings: both }, { send })
    expect(send.mock.calls[0][0].senderId).toBe("SHOPID")
    await sendReply(db, { ...base, line: "main", settings: both }, { send })
    expect(send.mock.calls[1][0].senderId).toBe("MAINID")
    // An empty shop value is undefined, even when the main one is set.
    await sendReply(db, { ...base, line: "shop", settings: settings({ replySenderId: "MAINID", shopReplySenderId: "" }) }, { send })
    expect(send.mock.calls[2][0].senderId).toBeUndefined()
    // An empty main value is undefined, even when the shop one is set.
    await sendReply(db, { ...base, line: "main", settings: settings({ replySenderId: "", shopReplySenderId: "SHOPID" }) }, { send })
    expect(send.mock.calls[3][0].senderId).toBeUndefined()
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

  it("the default payer is Datagod: no credit call is ever made", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    await sendReply(db, { ...base, settings: settings() }, { send })
    await sendReply(db, { ...base, settings: settings(), payer: { kind: "datagod" } }, { send })
    expect(credits.drawReserve).not.toHaveBeenCalled()
    expect(credits.chargeSingleReply).not.toHaveBeenCalled()
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound.mock.calls[1][1]).toEqual({ line: "main", sender: "0200000101", body: base.body })
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

describe("sendReply with a shop payer", () => {
  const shopBase = { ...base, line: "shop" as const }
  const payer = (over: Record<string, unknown> = {}) => ({ kind: "shop" as const, shopId: "shop-1", accountId: "acct-1", messageId: "msg-1", replyKey: "key1", ...over })
  const REF = "ttb:reply:key1"

  it("draws from the order's reserve first: no single debit, row stores shop_id and credits 1", async () => {
    credits.drawReserve.mockResolvedValue(true)
    const send = vi.fn().mockResolvedValue({ success: true })
    const r = await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
    expect(r).toEqual({ sent: true })
    expect(credits.drawReserve).toHaveBeenCalledWith(db, "msg-1", 1)
    expect(credits.chargeSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound).toHaveBeenCalledWith(db, { line: "shop", sender: "0200000101", body: base.body, shopId: "shop-1", credits: 1 })
  })

  it("with no reserve (draw false) or no message id it debits one credit under a unique reply ref", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
    expect(credits.chargeSingleReply).toHaveBeenCalledWith(db, { accountId: "acct-1", credits: 1, ref: REF })
    credits.chargeSingleReply.mockClear()
    credits.drawReserve.mockClear()
    await sendReply(db, { ...shopBase, settings: settings(), payer: payer({ messageId: null, replyKey: "key2" }) }, { send })
    expect(credits.drawReserve).not.toHaveBeenCalled()
    expect(credits.chargeSingleReply).toHaveBeenCalledWith(db, { accountId: "acct-1", credits: 1, ref: "ttb:reply:key2" })
    expect(store.storeOutbound.mock.calls[1][1]).toMatchObject({ shopId: "shop-1", credits: 1 })
  })

  it("a failed debit sends nothing, stores nothing, never falls back to Datagod paying", async () => {
    credits.chargeSingleReply.mockResolvedValue(false)
    const send = vi.fn().mockResolvedValue({ success: true })
    const r = await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
    expect(r).toEqual({ sent: false, skipped: "unpaid" })
    expect(send).not.toHaveBeenCalled()
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it("a throwing debit is also unpaid and sends nothing", async () => {
    credits.chargeSingleReply.mockRejectedValue(new Error("db"))
    const send = vi.fn().mockResolvedValue({ success: true })
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false, skipped: "unpaid" })
    expect(send).not.toHaveBeenCalled()
  })

  it("an unsafe reply key is unpaid and charges nothing", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer({ messageId: null, replyKey: "m1:release" }) }, { send })).toEqual({ sent: false, skipped: "unpaid" })
    expect(credits.chargeSingleReply).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("a refused body (two segments) is refused before any charge", async () => {
    const send = vi.fn()
    expect(await sendReply(db, { ...shopBase, body: "a".repeat(161), settings: settings(), payer: payer() }, { send })).toEqual({ sent: false })
    expect(credits.drawReserve).not.toHaveBeenCalled()
    expect(credits.chargeSingleReply).not.toHaveBeenCalled()
  })

  it("a definite provider refusal of a single-debit reply refunds with the SAME ref used for the debit, once, and the row records credits 0", async () => {
    const send = vi.fn().mockResolvedValue({ success: false, error: "nope" })
    const r = await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
    expect(r).toEqual({ sent: false })
    expect(credits.refundSingleReply).toHaveBeenCalledTimes(1)
    const debitRef = credits.chargeSingleReply.mock.calls[0][1].ref
    expect(credits.refundSingleReply).toHaveBeenCalledWith(db, { accountId: "acct-1", credits: 1, ref: debitRef })
    expect(store.storeOutbound.mock.calls[0][1]).toMatchObject({ shopId: "shop-1", credits: 0 })
  })

  it("a refused reply drawn from the reserve is undrawn (one credit back into the reserve); no single refund; row credits 0", async () => {
    credits.drawReserve.mockResolvedValue(true)
    const send = vi.fn().mockResolvedValue({ success: false })
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false })
    expect(credits.undrawReserve).toHaveBeenCalledTimes(1)
    expect(credits.undrawReserve).toHaveBeenCalledWith(db, "msg-1", 1)
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound.mock.calls[0][1]).toMatchObject({ shopId: "shop-1", credits: 0 })
  })

  it("a refused reserve reply whose undraw fails (reserve already released): fixed PII-free console.error, credits stay 1, no throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    credits.drawReserve.mockResolvedValue(true)
    credits.undrawReserve.mockResolvedValue(false)
    const send = vi.fn().mockResolvedValue({ success: false })
    await expect(sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).resolves.toEqual({ sent: false })
    expect(store.storeOutbound.mock.calls[0][1]).toMatchObject({ credits: 1 })
    expect(err).toHaveBeenCalledTimes(1)
    const text = JSON.stringify(err.mock.calls)
    for (const secret of ["0200000101", "YES", "msg-1", "acct-1", "shop-1", "key1"]) expect(text).not.toContain(secret)
    err.mockRestore()
  })

  it("an undraw that throws never throws out of sendReply", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    credits.drawReserve.mockResolvedValue(true)
    credits.undrawReserve.mockRejectedValue(new Error("db"))
    const send = vi.fn().mockResolvedValue({ success: false })
    await expect(sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).resolves.toEqual({ sent: false })
    err.mockRestore()
  })

  it("a provider throw on a reserve-drawn reply counts as sent: no undraw, credits 1", async () => {
    credits.drawReserve.mockResolvedValue(true)
    const send = vi.fn().mockRejectedValue(new Error("timeout"))
    await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
    expect(credits.undrawReserve).not.toHaveBeenCalled()
    expect(store.storeOutbound.mock.calls[0][1]).toMatchObject({ credits: 1 })
  })

  it("when the reserve is exhausted, the next replies of the same order each fall back to their own single debit", async () => {
    let left = 2
    credits.drawReserve.mockImplementation(async () => (left > 0 ? (left--, true) : false))
    const send = vi.fn().mockResolvedValue({ success: true })
    for (const k of ["a1", "a2", "a3", "a4"]) {
      expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer({ replyKey: k }) }, { send })).toEqual({ sent: true })
    }
    expect(credits.drawReserve).toHaveBeenCalledTimes(4)
    const refs = credits.chargeSingleReply.mock.calls.map((c) => c[1].ref)
    expect(refs).toEqual(["ttb:reply:a3", "ttb:reply:a4"])
    expect(store.storeOutbound.mock.calls.map((c) => c[1].credits)).toEqual([1, 1, 1, 1])
  })

  it("a transient drawReserve error falls through to a single debit (the unused reserve returns at release)", async () => {
    credits.drawReserve.mockRejectedValue(new Error("blip"))
    const send = vi.fn().mockResolvedValue({ success: true })
    // drawReserve itself never throws in production (false on error); a throw is treated as unpaid, never as free.
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false, skipped: "unpaid" })
    expect(send).not.toHaveBeenCalled()
  })

  it("a swallowed refund failure (false or throw) logs a fixed PII-free console.error", async () => {
    for (const fail of [() => credits.refundSingleReply.mockResolvedValue(false), () => credits.refundSingleReply.mockRejectedValue(new Error("db 0200000101"))]) {
      const err = vi.spyOn(console, "error").mockImplementation(() => {})
      fail()
      const send = vi.fn().mockResolvedValue({ success: false })
      await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })
      expect(err).toHaveBeenCalledTimes(1)
      const text = JSON.stringify(err.mock.calls)
      for (const secret of ["0200000101", "YES", "msg-1", "acct-1", "shop-1", "key1"]) expect(text).not.toContain(secret)
      err.mockRestore()
    }
  })

  it("a skipped send whose refund throws still resolves { sent:false, skipped:true } and stores nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    credits.refundSingleReply.mockRejectedValue(new Error("db"))
    const send = vi.fn().mockResolvedValue({ success: true, skipped: true })
    await expect(sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).resolves.toEqual({ sent: false, skipped: true })
    expect(store.storeOutbound).not.toHaveBeenCalled()
    err.mockRestore()
  })

  it("a provider throw counts as sent: nothing refunded, credit stays spent", async () => {
    const send = vi.fn().mockRejectedValue(new Error("timeout"))
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false })
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound.mock.calls[0][1]).toMatchObject({ shopId: "shop-1", credits: 1 })
  })

  it("a skipped send (SMS off) refunds a single debit and stores no row", async () => {
    const send = vi.fn().mockResolvedValue({ success: true, skipped: true })
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false, skipped: true })
    expect(credits.refundSingleReply).toHaveBeenCalledWith(db, { accountId: "acct-1", credits: 1, ref: REF })
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it("a skipped send with a reserve draw undraws it, makes no single refund and stores no row", async () => {
    credits.drawReserve.mockResolvedValue(true)
    const send = vi.fn().mockResolvedValue({ success: true, skipped: true })
    expect(await sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).toEqual({ sent: false, skipped: true })
    expect(credits.undrawReserve).toHaveBeenCalledWith(db, "msg-1", 1)
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound).not.toHaveBeenCalled()
  })

  it("a refund that itself throws never throws out of sendReply", async () => {
    credits.refundSingleReply.mockRejectedValue(new Error("db"))
    const send = vi.fn().mockResolvedValue({ success: false })
    await expect(sendReply(db, { ...shopBase, settings: settings(), payer: payer() }, { send })).resolves.toEqual({ sent: false })
  })

  it("the refund is only ever attempted with the ref that was debited, and a reserve ref is never used", async () => {
    const send = vi.fn().mockResolvedValue({ success: false })
    const messageId = "3f2b9c1e-1111-4222-8333-444455556666"
    await sendReply(db, { ...shopBase, settings: settings(), payer: payer({ messageId, replyKey: `${messageId}-1` }) }, { send })
    const debitRef = credits.chargeSingleReply.mock.calls[0][1].ref as string
    const refundRef = credits.refundSingleReply.mock.calls[0][1].ref as string
    expect(refundRef).toBe(debitRef)
    expect(debitRef).not.toBe(`ttb:${messageId}`)
    expect(debitRef.includes(`ttb:${messageId}`)).toBe(false)
  })

  it("sender id and one-segment rule are unchanged for a shop payer", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    await sendReply(db, { ...shopBase, settings: settings({ shopReplySenderId: "SHOPID" }), payer: payer() }, { send })
    expect(send.mock.calls[0][0]).toEqual({ phone: "0200000101", message: base.body, type: "text_to_buy_reply", senderId: "SHOPID", skipLogging: true })
  })
})
