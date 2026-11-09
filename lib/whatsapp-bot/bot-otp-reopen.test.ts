// A commission bot's Hubtel start runs after the reply. When Hubtel refuses and the fallback Paystack charge answers
// send_otp, the reply has already closed the chat, so the chat is reopened on SUBMIT_OTP (botOtp) under the sender and
// the sender is told to reply with the code. Each bot uses its own session store and its own WhatsApp number.
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  main: new Map<string, any>(),
  shop: new Map<string, any>(),
  texts: [] as any[][],
  otpHandled: [] as any[][],
}))

vi.mock("@supabase/supabase-js", async () => (await import("@/lib/ussd/gateway-test-kit")).supabaseMock())
vi.mock("./session", () => ({
  getWaSession: async (id: string) => h.main.get(id) ?? null,
  setWaSession: async (id: string, s: any) => { h.main.set(id, JSON.parse(JSON.stringify(s))) },
  deleteWaSession: async (id: string) => { h.main.delete(id) },
  extendWaSession: async () => {},
}))
vi.mock("./shop-session", () => ({
  getSession: async (id: string) => h.shop.get(id) ?? null,
  setSession: async (id: string, s: any) => { h.shop.set(id, JSON.parse(JSON.stringify(s))) },
  deleteSession: async (id: string) => { h.shop.delete(id) },
}))
vi.mock("./send", () => ({ sendWhatsAppText: vi.fn(async (...a: any[]) => { h.texts.push(a); return "wamid" }) }))

import { getBotMomoRuntime } from "@/lib/bot-commission/momo"

const SENDER = "233241234567"
const LOCAL = "0241234567"

beforeEach(() => {
  h.main.clear()
  h.shop.clear()
  h.texts = []
  process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID = "shop-number-id"
})

describe("the live reopenOtpChat", () => {
  it("main bot: SUBMIT_OTP with botOtp under the sender's chat key, and the follow-up on the main number", async () => {
    await getBotMomoRuntime().reopenOtpChat!("whatsapp", LOCAL)
    expect(h.main.get(SENDER)).toEqual({ step: "SUBMIT_OTP", dialingPhone: LOCAL, botOtp: true })
    expect(h.shop.size).toBe(0)
    expect(h.texts).toHaveLength(1)
    expect(h.texts[0][0]).toBe(SENDER)
    expect(h.texts[0][1]).toMatch(/one-time code/)
    expect(h.texts[0][1]).toMatch(/0\. Cancel/)
    expect(h.texts[0][2]).toBeUndefined()
    expect(h.texts[0][1]).not.toMatch(/hubtel|paystack/i)
  })

  it("shop bot: keeps the resolved shop, drops the flow fields, and sends from the shop number", async () => {
    h.shop.set(SENDER, { step: "SELECT_PRODUCT", shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi Data", npNetwork: "MTN" })
    await getBotMomoRuntime().reopenOtpChat!("whatsapp_shop", LOCAL)
    const s = h.shop.get(SENDER)
    expect(s).toMatchObject({ step: "SUBMIT_OTP", botOtp: true, shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi Data" })
    expect(s.npNetwork).toBeUndefined()
    expect(h.main.size).toBe(0)
    expect(h.texts[0][0]).toBe(SENDER)
    expect(h.texts[0][2]).toBe("shop-number-id")
    expect(h.texts[0][1]).not.toMatch(/hubtel|paystack/i)
  })

  it("shop bot with no session left (or the AI step): still reopens on SUBMIT_OTP", async () => {
    await getBotMomoRuntime().reopenOtpChat!("whatsapp_shop", LOCAL)
    expect(h.shop.get(SENDER)).toEqual({ step: "SUBMIT_OTP", botOtp: true })
    h.shop.set(SENDER, { step: "AI_CONVERSATION" })
    await getBotMomoRuntime().reopenOtpChat!("whatsapp_shop", LOCAL)
    expect(h.shop.get(SENDER)).toEqual({ step: "SUBMIT_OTP", botOtp: true })
  })
})
