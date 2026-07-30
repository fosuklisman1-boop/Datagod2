import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: vi.fn() }))
vi.mock("@/lib/ai-providers", () => ({
  resolveProviderForContext: () => ({ provider: {}, model: "claude-haiku-4-5-20251001", providerName: "anthropic" }),
  DEFAULT_CONFIG: {},
}))
vi.mock("@/lib/whatsapp-bot/shop-prefs", () => ({ getShopPref: vi.fn() }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({ resolveShopCode: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/shop-session", () => ({ getSession: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/log-message", () => ({ logMessage: vi.fn() }))

const fakeMessages: Array<{ direction: string; message: string }> = []
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "whatsapp_messages") {
        return {
          select: () => ({
            eq: () => ({
              in: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: fakeMessages }),
                }),
              }),
            }),
          }),
        }
      }
      if (table === "admin_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) }
      }
      // handleShopWithAI re-resolves a known shopCodeId's code string here before
      // calling resolveShopCode (which takes a code, not an id) — mirrors
      // lib/ai-tools.ts's currentShopForPhone helper, which does the exact same
      // lookup for the same reason.
      if (table === "ussd_shop_codes") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { code: "AB12CD" } }) }) }) }
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))

import { handleShopWithAI } from "@/lib/whatsapp-bot/shop-ai"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { getShopPref } from "@/lib/whatsapp-bot/shop-prefs"
import { resolveShopCode } from "@/lib/shop-commerce/shop-code"
import { getSession as getShopSession } from "@/lib/whatsapp-bot/shop-session"

describe("handleShopWithAI", () => {
  beforeEach(() => {
    vi.mocked(getShopPref).mockReset()
    vi.mocked(resolveShopCode).mockReset()
    vi.mocked(getShopSession).mockReset()
    vi.mocked(runAgenticLoop).mockReset()
    fakeMessages.length = 0
  })

  it("greets with an enter-code prompt when no shop is known", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Hi! What's your shop code?", toolsUsed: [] })

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.1")

    expect(reply).toBe("Hi! What's your shop code?")
    const call = vi.mocked(runAgenticLoop).mock.calls[0][0]
    expect(call.system).not.toContain("Kofi's Data Hub")
  })

  it("includes the shop name in the system prompt for a known shop", async () => {
    vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Welcome back!", toolsUsed: [] })

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.2")

    expect(reply).toBe("Welcome back!")
    const call = vi.mocked(runAgenticLoop).mock.calls[0][0]
    expect(call.system).toContain("Kofi's Data Hub")
    expect(call.context).toBe("whatsapp_shop")
  })

  it("returns the staged confirm screen verbatim when place_shop_order just staged one", async () => {
    vi.mocked(getShopPref).mockResolvedValue({ shopCodeId: "code-1" })
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "code-1", shopId: "shop-1", shopName: "Kofi's Data Hub",
      parentShopId: null, status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(runAgenticLoop).mockResolvedValue({ text: "Sure, staging that.", toolsUsed: ["place_shop_order"] })
    vi.mocked(getShopSession).mockResolvedValue({
      step: "CONFIRM", shopName: "Kofi's Data Hub", network: "MTN", bundleSize: "5GB",
      bundlePrice: 25, recipientPhone: "0244123456", paymentPhone: "0244123456",
    } as never)

    const reply = await handleShopWithAI("233559919037", "yes 5gb mtn to 0244123456 pay from same number", "wamid.3")

    expect(reply).toContain("5GB MTN")
    expect(reply).toContain("1. Pay now")
  })

  it("falls back to a safe message when runAgenticLoop throws", async () => {
    vi.mocked(getShopPref).mockResolvedValue(null)
    vi.mocked(runAgenticLoop).mockRejectedValue(new Error("provider down"))

    const reply = await handleShopWithAI("233559919037", "hi", "wamid.4")

    expect(reply).toContain("trouble")
  })
})
