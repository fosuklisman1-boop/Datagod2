import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const store = vi.hoisted(() => ({ storeOutbound: vi.fn() }))
vi.mock("./store", () => ({ storeOutbound: store.storeOutbound }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))
const credits = vi.hoisted(() => ({ drawReserve: vi.fn(), undrawReserve: vi.fn(), chargeSingleReply: vi.fn(), refundSingleReply: vi.fn() }))
vi.mock("./shop/credits", async () => {
  const actual = await vi.importActual<typeof import("./shop/credits")>("./shop/credits")
  return { ...actual, ...credits }
})

import { sendReply } from "./send-reply"
import { TTB_DEFAULTS } from "./settings"

const db = {} as SupabaseClient
const settings = { ...TTB_DEFAULTS }
const SENDER = "0200000907"
const BODY = "Private order text 1GB GHS 5.00"
const base = { line: "main" as const, sender: SENDER, body: BODY, settings }
const payer = { kind: "shop" as const, shopId: "shop-secret-id", accountId: "acct-secret-id", messageId: "msg-secret-id", replyKey: "key-secret" }

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  store.storeOutbound.mockReset().mockResolvedValue(undefined)
  for (const f of Object.values(credits)) f.mockReset()
  credits.drawReserve.mockResolvedValue(false)
  credits.chargeSingleReply.mockResolvedValue(true)
  credits.refundSingleReply.mockResolvedValue(true)
  credits.undrawReserve.mockResolvedValue(true)
})
afterEach(() => vi.restoreAllMocks())

const line = (token: string) => [`text-to-buy: reply not sent (${token})`]

describe("sendReply logs why a reply was not sent (fixed tokens only)", () => {
  it("blank body", async () => {
    expect(await sendReply(db, { ...base, body: "   " }, { send: vi.fn() })).toEqual({ sent: false })
    expect(warn.mock.calls).toEqual([line("blank")])
  })

  it("non-GSM-7 body", async () => {
    expect(await sendReply(db, { ...base, body: "Hello \u{1F600}" }, { send: vi.fn() })).toEqual({ sent: false })
    expect(warn.mock.calls).toEqual([line("not_gsm7")])
  })

  it("over one segment", async () => {
    expect(await sendReply(db, { ...base, body: "a".repeat(161) }, { send: vi.fn() })).toEqual({ sent: false })
    expect(warn.mock.calls).toEqual([line("too_long")])
  })

  it("skipped send", async () => {
    const send = vi.fn().mockResolvedValue({ success: true, skipped: true })
    expect(await sendReply(db, base, { send })).toEqual({ sent: false, skipped: true })
    expect(warn.mock.calls).toEqual([line("skipped")])
  })

  it("unpaid shop reply", async () => {
    credits.chargeSingleReply.mockResolvedValue(false)
    const send = vi.fn()
    expect(await sendReply(db, { ...base, line: "shop", payer }, { send })).toEqual({ sent: false, skipped: "unpaid" })
    expect(send).not.toHaveBeenCalled()
    expect(warn.mock.calls).toEqual([line("unpaid")])
  })

  it("a definite refusal and a throwing send", async () => {
    expect(await sendReply(db, base, { send: vi.fn().mockResolvedValue({ success: false }) })).toEqual({ sent: false })
    expect(warn.mock.calls).toEqual([line("send_failed")])
    warn.mockClear()
    expect(await sendReply(db, base, { send: vi.fn().mockRejectedValue(new Error(`boom ${SENDER} ${BODY}`)) })).toEqual({ sent: false })
    expect(warn.mock.calls).toEqual([line("send_failed")])
  })

  it("a successful send logs nothing", async () => {
    expect(await sendReply(db, base, { send: vi.fn().mockResolvedValue({ success: true }) })).toEqual({ sent: true })
    expect(warn).not.toHaveBeenCalled()
  })

  it("no log line ever contains the body, the number or an id", async () => {
    credits.chargeSingleReply.mockResolvedValue(false)
    await sendReply(db, { ...base, line: "shop", payer }, { send: vi.fn() })
    await sendReply(db, base, { send: vi.fn().mockResolvedValue({ success: false }) })
    const out = JSON.stringify(warn.mock.calls)
    for (const s of [SENDER, BODY, "secret"]) expect(out).not.toContain(s)
  })
})
