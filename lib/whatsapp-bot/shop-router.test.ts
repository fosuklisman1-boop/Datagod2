import { isShopWhatsAppNumber, shopWaRouter } from "@/lib/whatsapp-bot/shop-router"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"

// shopWaRouter (Phase 1: acknowledge-only stub) — the real shop-code -> menu
// state machine lands in a later phase. Here we only verify it sends the
// stub reply, and sends it FROM the shop number (3rd arg), not the main one.
vi.mock("@/lib/whatsapp-bot/send", () => ({
  sendWhatsAppText: vi.fn(),
}))

describe("shopWaRouter", () => {
  const SHOP_PNID = "SHOP_PNID_999"

  beforeEach(() => {
    vi.mocked(sendWhatsAppText).mockReset()
    vi.stubEnv("WHATSAPP_SHOP_PHONE_NUMBER_ID", SHOP_PNID)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("acknowledges with the stub message, sent from the shop phone_number_id", async () => {
    await shopWaRouter("233241234567", "hello", "wamid.IN1")

    expect(sendWhatsAppText).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppText).toHaveBeenCalledWith(
      "233241234567",
      expect.stringContaining("Shop bot coming soon"),
      SHOP_PNID
    )
  })

  it("acknowledges regardless of message text or a null inbound id", async () => {
    await shopWaRouter("233241234567", "whatever the customer typed", null)

    expect(sendWhatsAppText).toHaveBeenCalledTimes(1)
    expect(sendWhatsAppText).toHaveBeenCalledWith("233241234567", expect.any(String), SHOP_PNID)
  })
})

// isShopWhatsAppNumber — the pure predicate behind the webhook route's
// phone_number_id branch (app/api/whatsapp/webhook/route.ts). Extracted so the
// routing decision itself is unit-testable without standing up the rest of
// processInbound (Supabase, session state, the AI loop, etc. — see that
// file's task notes for why a full route-level test wasn't practical).
describe("isShopWhatsAppNumber", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("returns true when the receiving phone_number_id matches the configured shop number", () => {
    expect(isShopWhatsAppNumber("SHOP_123", "SHOP_123")).toBe(true)
  })

  it("returns false when the receiving phone_number_id is the main number (mismatch)", () => {
    expect(isShopWhatsAppNumber("MAIN_111", "SHOP_123")).toBe(false)
  })

  it("returns false when the shop number isn't configured (undefined) — default/today's behavior", () => {
    expect(isShopWhatsAppNumber("MAIN_111", undefined)).toBe(false)
  })

  it("returns false when the shop number is configured but the payload has no phone_number_id", () => {
    expect(isShopWhatsAppNumber(undefined, "SHOP_123")).toBe(false)
  })

  it("reads WHATSAPP_SHOP_PHONE_NUMBER_ID from the environment when no override is passed", () => {
    vi.stubEnv("WHATSAPP_SHOP_PHONE_NUMBER_ID", "SHOP_FROM_ENV")
    expect(isShopWhatsAppNumber("SHOP_FROM_ENV")).toBe(true)
    expect(isShopWhatsAppNumber("MAIN_111")).toBe(false)
  })

  it("returns false when WHATSAPP_SHOP_PHONE_NUMBER_ID is unset in the environment (the default today)", () => {
    vi.stubEnv("WHATSAPP_SHOP_PHONE_NUMBER_ID", undefined)
    expect(isShopWhatsAppNumber("MAIN_111")).toBe(false)
    expect(isShopWhatsAppNumber(undefined)).toBe(false)
  })
})
