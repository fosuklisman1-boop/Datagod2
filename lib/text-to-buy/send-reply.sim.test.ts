import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

const store = vi.hoisted(() => ({ storeOutbound: vi.fn(), countOutbound: vi.fn() }))
vi.mock("./store", () => ({ storeOutbound: store.storeOutbound, countOutbound: store.countOutbound }))
const sms = vi.hoisted(() => ({ sendSMS: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: sms.sendSMS }))
const phone = vi.hoisted(() => ({ sendViaPhone: vi.fn() }))
vi.mock("./phone-sms/client", () => ({ sendViaPhone: phone.sendViaPhone }))
const credits = vi.hoisted(() => ({ drawReserve: vi.fn(), undrawReserve: vi.fn(), chargeSingleReply: vi.fn(), refundSingleReply: vi.fn() }))
vi.mock("./shop/credits", async () => {
  const actual = await vi.importActual<typeof import("./shop/credits")>("./shop/credits")
  return { ...actual, ...credits }
})

import { sendReply } from "./send-reply"
import { TTB_DEFAULTS, type TtbSettings } from "./settings"

// The router counts recent out rows straight from the db: a chain that answers 0.
const countChain: Record<string, unknown> = {}
countChain.select = () => countChain
countChain.eq = () => countChain
countChain.gte = () => countChain
countChain.then = (ok: (r: { count: number; error: null }) => unknown) => Promise.resolve({ count: 0, error: null }).then(ok)
const db = { from: () => countChain } as unknown as SupabaseClient
const sim = (over: Partial<TtbSettings> = {}): TtbSettings => ({ ...TTB_DEFAULTS, replyTransportMain: "sim", replyTransportShop: "sim", ...over })
const base = { line: "main" as const, sender: "0200000101", body: "Send YES to confirm 1GB for GHS 5.00" }
const shopPayer = { kind: "shop" as const, shopId: "s1", accountId: "a1", messageId: null, replyKey: "msg1-1" }

beforeEach(() => {
  process.env.SMS_ENABLED = "true"
  process.env.SMS_PHONE_URL = "https://relay.example.test/sms"
  process.env.SMS_PHONE_SM4_KEY = "00112233445566778899aabbccddeeff"
  vi.spyOn(console, "warn").mockImplementation(() => {})
  store.storeOutbound.mockReset().mockResolvedValue(undefined)
  store.countOutbound.mockReset().mockResolvedValue(0)
  sms.sendSMS.mockReset().mockResolvedValue({ success: true })
  phone.sendViaPhone.mockReset()
  for (const f of Object.values(credits)) f.mockReset()
  credits.drawReserve.mockResolvedValue(false)
  credits.chargeSingleReply.mockResolvedValue(true)
  credits.refundSingleReply.mockResolvedValue(true)
  credits.undrawReserve.mockResolvedValue(true)
})
afterEach(() => {
  delete process.env.SMS_ENABLED
  delete process.env.SMS_PHONE_URL
  delete process.env.SMS_PHONE_SM4_KEY
  vi.restoreAllMocks()
})

describe("sendReply default transport (router)", () => {
  it("hubtel (default settings) goes through sendSMS and never touches the phone", async () => {
    const r = await sendReply(db, { ...base, settings: { ...TTB_DEFAULTS } })
    expect(r).toEqual({ sent: true })
    expect(sms.sendSMS).toHaveBeenCalledTimes(1)
    expect(phone.sendViaPhone).not.toHaveBeenCalled()
  })

  it("sim: the phone carries it, Hubtel is not used, the shop is charged once and one out row is stored", async () => {
    phone.sendViaPhone.mockResolvedValue({ kind: "sent" })
    const r = await sendReply(db, { ...base, settings: sim(), payer: shopPayer })
    expect(r).toEqual({ sent: true })
    expect(phone.sendViaPhone).toHaveBeenCalledTimes(1)
    expect(sms.sendSMS).not.toHaveBeenCalled()
    expect(credits.chargeSingleReply).toHaveBeenCalledTimes(1)
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
  })

  it("sim: a refusal falls back to Hubtel and the shop is still charged exactly once", async () => {
    phone.sendViaPhone.mockResolvedValue({ kind: "refused" })
    const r = await sendReply(db, { ...base, settings: sim(), payer: shopPayer })
    expect(r).toEqual({ sent: true })
    expect(sms.sendSMS).toHaveBeenCalledTimes(1)
    expect(credits.chargeSingleReply).toHaveBeenCalledTimes(1)
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
  })

  it("sim: an ambiguous result falls back to Hubtel too: exactly one Hubtel call, one charge, one out row", async () => {
    phone.sendViaPhone.mockResolvedValue({ kind: "ambiguous", detail: "timeout" })
    const r = await sendReply(db, { ...base, settings: sim(), payer: shopPayer })
    expect(r).toEqual({ sent: true })
    expect(sms.sendSMS).toHaveBeenCalledTimes(1)
    expect(credits.chargeSingleReply).toHaveBeenCalledTimes(1)
    expect(credits.refundSingleReply).not.toHaveBeenCalled()
    expect(store.storeOutbound).toHaveBeenCalledTimes(1)
  })

  it("an explicit deps.send still wins over the router", async () => {
    const send = vi.fn().mockResolvedValue({ success: true })
    await sendReply(db, { ...base, settings: sim() }, { send })
    expect(send).toHaveBeenCalledTimes(1)
    expect(phone.sendViaPhone).not.toHaveBeenCalled()
  })
})
