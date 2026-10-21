// Webhook wiring of the no-session bot OTP fallback (Plan 4 Task 6, item A2), for BOTH WhatsApp bots:
// - main number, NO bot session, OTP-shaped text: waMainBotOtpFallback first; its reply is sent and the AI is skipped;
//   null => the AI runs exactly as before.
// - shop number: shopBotOtpFallback first; its reply is sent on the SHOP number and the shop router is skipped;
//   null => the shop router (and its AI escape) runs exactly as before.
// - a main-number chat WITH a session never consults the fallback (waRouter as before).
// The fallbacks' own logic (OTP shape, pointer per sender + key space, session handling) is tested in
// lib/whatsapp-bot/bots.test.ts and shop-bots.test.ts; here everything below the route is faked.
import { describe, it, expect, vi, beforeEach } from "vitest"
import crypto from "crypto"

const h = vi.hoisted(() => {
  const chain: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null })
      if (prop === "then") return (ok: (v: unknown) => unknown) => ok({ data: [], error: null })
      return () => chain
    },
  })
  return {
    pending: [] as Promise<unknown>[],
    db: { from: () => chain, storage: { from: () => chain } },
    getWaSession: vi.fn(async (_p: string): Promise<any> => null),
    waRouter: vi.fn(async (): Promise<string> => "ROUTER-REPLY"),
    shopWaRouter: vi.fn(async (): Promise<string> => "SHOP-ROUTER-REPLY"),
    handleShopWithAI: vi.fn(async (): Promise<string | null> => "SHOP-AI"),
    sendWhatsAppText: vi.fn(async (..._a: unknown[]) => "wamid-out"),
    logMessage: vi.fn(async (..._a: unknown[]) => ({
      humanTakeover: false, takenOverAt: null, takenOverBy: null, conversationCreatedAt: null, duplicate: false,
    })),
    runAgenticLoop: vi.fn(async () => ({ text: "AI-REPLY", toolsUsed: [] as string[] })),
    mainFallback: vi.fn(async (_s: string, _t: string): Promise<string | null> => null),
    shopFallback: vi.fn(async (_s: string, _t: string): Promise<string | null> => null),
  }
})

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<unknown>) => { h.pending.push(fn()) },
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.db }))
vi.mock("@/lib/whatsapp-bot/session", () => ({ getWaSession: h.getWaSession, setWaSession: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/router", () => ({ waRouter: h.waRouter }))
vi.mock("@/lib/whatsapp-bot/admin-router", () => ({
  isResultsCheckAdmin: async () => false, adminRcRouter: vi.fn(), adminComplaintRouter: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/send", () => ({
  sendWhatsAppText: h.sendWhatsAppText, markWaMessageRead: vi.fn(), sendWaTyping: vi.fn(), downloadWaMedia: vi.fn(),
  formatForWhatsApp: (s: string) => s,
}))
vi.mock("@/lib/whatsapp-bot/shop-router", () => ({
  shopWaRouter: h.shopWaRouter, isShopWhatsAppNumber: (id?: string) => id === "SHOP-NUMBER-ID",
}))
vi.mock("@/lib/whatsapp-bot/shop-ai", () => ({ handleShopWithAI: h.handleShopWithAI }))
vi.mock("@/lib/whatsapp-bot/log-message", () => ({ logMessage: h.logMessage }))
vi.mock("@/lib/whatsapp-bot/notify-admins", () => ({
  maybeNotifyAdmins: vi.fn(async () => {}), isHumanRequest: () => false, flagAndNotifyHumanRequest: vi.fn(),
}))
vi.mock("@/lib/whatsapp-bot/rate-limit", () => ({ allowInbound: async () => true }))
vi.mock("@/lib/whatsapp-bot/pending-complaint", () => ({ getPendingComplaint: async () => null, clearPendingComplaint: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/account-link", () => ({ resolveLinkedUserId: async () => null, unlinkWhatsApp: vi.fn() }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-providers", () => ({ resolveProviderForContext: () => ({ provider: "p", model: "m" }), DEFAULT_CONFIG: {} }))
vi.mock("@/lib/ai-vision", () => ({ describeImage: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/bot-flows", () => ({ waMainBotOtpFallback: h.mainFallback }))
vi.mock("@/lib/whatsapp-bot/shop-bot-flows", () => ({ shopBotOtpFallback: h.shopFallback }))

import { POST } from "./route"

const FROM = "233244123456"
const SECRET = "test-app-secret"

async function inbound(text: string, phoneNumberId = "MAIN-NUMBER-ID"): Promise<void> {
  const body = JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      contacts: [{ wa_id: FROM, profile: { name: "Kofi" } }],
      messages: [{ from: FROM, id: `wamid-${Math.random()}`, type: "text", text: { body: text } }],
    } }] }],
  })
  const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("hex")
  const req = new Request("https://x.test/api/whatsapp/webhook", {
    method: "POST", body, headers: { "x-hub-signature-256": sig, "content-type": "application/json" },
  })
  const res = await POST(req as any)
  expect(res.status).toBe(200)
  await Promise.all(h.pending.splice(0))
}

const sentTexts = () => h.sendWhatsAppText.mock.calls.map((c) => c[1])

beforeEach(() => {
  process.env.WHATSAPP_APP_SECRET = SECRET
  process.env.WHATSAPP_SHOP_PHONE_NUMBER_ID = "SHOP-NUMBER-ID"
  for (const f of Object.values(h)) if (typeof f === "function" && "mockClear" in f) (f as any).mockClear()
  h.getWaSession.mockImplementation(async () => null)
  h.mainFallback.mockImplementation(async () => null)
  h.shopFallback.mockImplementation(async () => null)
})

describe("main number: no-session OTP fallback", () => {
  it("no session + the fallback answers: its reply is sent, logged, and the AI never runs", async () => {
    h.mainFallback.mockResolvedValueOnce("APPROVE-TEXT")
    await inbound("123456")
    expect(h.mainFallback).toHaveBeenCalledWith(FROM, "123456")
    expect(sentTexts()).toEqual(["APPROVE-TEXT"])
    expect(h.logMessage).toHaveBeenCalledWith(FROM, "outbound", "APPROVE-TEXT", "wamid-out")
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.waRouter).not.toHaveBeenCalled()
  })

  it("no session + no pointer (null): the AI runs exactly as before", async () => {
    await inbound("123456")
    expect(h.mainFallback).toHaveBeenCalledTimes(1)
    expect(h.runAgenticLoop).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toEqual(["AI-REPLY"])
  })

  it("an active bot session never consults the fallback (waRouter as before)", async () => {
    h.getWaSession.mockImplementation(async () => ({ step: "MAIN", dialingPhone: "0244123456" }))
    await inbound("123456")
    expect(h.mainFallback).not.toHaveBeenCalled()
    expect(h.waRouter).toHaveBeenCalledWith(FROM, "123456")
    expect(sentTexts()).toEqual(["ROUTER-REPLY"])
  })

  it("free text with no session: the fallback declines (null) and the AI answers", async () => {
    await inbound("hello there")
    expect(h.runAgenticLoop).toHaveBeenCalledTimes(1)
    expect(sentTexts()).toEqual(["AI-REPLY"])
  })
})

describe("shop number: no-session OTP fallback", () => {
  it("the fallback answers: its reply goes out on the SHOP number; the shop router never runs", async () => {
    h.shopFallback.mockResolvedValueOnce("APPROVE-TEXT")
    await inbound("123456", "SHOP-NUMBER-ID")
    expect(h.shopFallback).toHaveBeenCalledWith(FROM, "123456")
    expect(h.sendWhatsAppText).toHaveBeenCalledWith(FROM, "APPROVE-TEXT", "SHOP-NUMBER-ID")
    expect(h.logMessage).toHaveBeenCalledWith(FROM, "outbound", "APPROVE-TEXT", "wamid-out")
    expect(h.shopWaRouter).not.toHaveBeenCalled()
    expect(h.mainFallback).not.toHaveBeenCalled()
  })

  it("null: the shop router runs exactly as before (and its AI escape on '')", async () => {
    await inbound("1234", "SHOP-NUMBER-ID")
    expect(h.shopWaRouter).toHaveBeenCalledTimes(1)
    expect(h.sendWhatsAppText).not.toHaveBeenCalled() // the shop router sends its own reply
    h.shopWaRouter.mockResolvedValueOnce("")
    await inbound("what do you sell?", "SHOP-NUMBER-ID")
    expect(h.handleShopWithAI).toHaveBeenCalledTimes(1)
    expect(h.sendWhatsAppText).toHaveBeenCalledWith(FROM, "SHOP-AI", "SHOP-NUMBER-ID")
    expect(h.mainFallback).not.toHaveBeenCalled()
  })
})
