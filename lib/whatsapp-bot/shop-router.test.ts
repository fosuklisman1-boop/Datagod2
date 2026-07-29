import { shopWaRouter, isShopWhatsAppNumber } from "@/lib/whatsapp-bot/shop-router"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"
import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { fetchShopBundles, verifyBundlePrice } from "@/lib/shop-commerce/pricing"
import { createShopBundleOrder } from "@/lib/shop-commerce/orders"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"

// shopWaRouter — the full Data-bundle purchase state machine (Task 3.3). Every
// side-effecting collaborator is mocked at the module boundary; the REAL
// lib/whatsapp-bot/shop-session.ts is used (its in-memory fallback, since
// Upstash isn't configured in the test env) so the tests exercise genuine
// session persistence/deletion across successive shopWaRouter calls — not a
// re-implementation of it.
vi.mock("@/lib/whatsapp-bot/send", () => ({ sendWhatsAppText: vi.fn() }))
vi.mock("@/lib/whatsapp-bot/log-message", () => ({ logMessage: vi.fn() }))
vi.mock("@/lib/shop-commerce/shop-code", () => ({
  resolveShopCode: vi.fn(),
  fetchShopNetworks: vi.fn(),
}))
vi.mock("@/lib/shop-commerce/pricing", () => ({
  fetchShopBundles: vi.fn(),
  verifyBundlePrice: vi.fn(),
}))
vi.mock("@/lib/shop-commerce/orders", () => ({ createShopBundleOrder: vi.fn() }))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(),
  submitOtp: vi.fn(),
}))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn() }))

// Backs the two ad-hoc reads shop-router.ts makes with its own Supabase client
// (shop owner email + Paystack fee %, see shop-router.ts's fetchShopOwnerEmail /
// fetchPaystackFeePercent) — no shop-commerce module owns these, so this is the
// only way to control them from a test.
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "app_settings") {
        return { select: () => ({ single: () => Promise.resolve({ data: { paystack_fee_percentage: 3 } }) }) }
      }
      if (table === "user_shops") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { user_id: "owner1", users: { email: "owner@example.com" } } }),
            }),
          }),
        }
      }
      throw new Error(`shop-router.test.ts fake supabase client: unexpected table "${table}"`)
    },
  }),
}))

const SHOP_PNID = "SHOP_PNID_999"

// Convenience: last WhatsApp reply text sent to `phone` (2nd arg of the last
// sendWhatsAppText call for that recipient).
function lastReplyTo(phone: string): string {
  const calls = vi.mocked(sendWhatsAppText).mock.calls.filter(c => c[0] === phone)
  const last = calls[calls.length - 1]
  return last?.[1] ?? ""
}

describe("shopWaRouter", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubEnv("WHATSAPP_SHOP_PHONE_NUMBER_ID", SHOP_PNID)
    vi.mocked(sendWhatsAppText).mockResolvedValue("wamid.OUT")
    vi.mocked(logMessage).mockResolvedValue({
      conversationId: "conv1", humanTakeover: false, takenOverAt: null, takenOverBy: null, conversationCreatedAt: null,
    })
    // Sane defaults so steps that don't specifically test these don't crash on
    // an unmocked destructure/undefined.
    vi.mocked(getPrefixValidationConfig).mockResolvedValue({
      enabled: false,
      map: { MTN: [], TELECEL: [], AT: [] },
    })
    vi.mocked(resolveEmail).mockResolvedValue("cust@example.com")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // ── Activation gate ─────────────────────────────────────────────────────────
  it("rejects a resolved shop code that isn't WhatsApp-activated, and creates no session", async () => {
    const phone = "233241000010"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc1", shopId: "s1", shopName: "Test Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: false,
    })

    await shopWaRouter(phone, "CODE123", "wamid.IN1")

    expect(lastReplyTo(phone)).toContain("isn't set up for WhatsApp yet")
    expect(fetchShopNetworks).not.toHaveBeenCalled()

    // No session was persisted — the next message re-resolves as a fresh code
    // attempt rather than being treated as a SELECT_PRODUCT menu choice.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "1", "wamid.IN2")
    expect(resolveShopCode).toHaveBeenCalledWith("1")
    expect(lastReplyTo(phone)).toContain("Invalid shop code")
  })

  it("rejects an unresolvable shop code and creates no session", async () => {
    const phone = "233241000011"
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    await shopWaRouter(phone, "NOPE", "wamid.IN1")

    expect(lastReplyTo(phone)).toContain("Invalid shop code")
    expect(fetchShopNetworks).not.toHaveBeenCalled()
  })

  it("rejects a shop code with no sessions left (tokenBalance <= 0)", async () => {
    const phone = "233241000012"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc2", shopId: "s2", shopName: "Broke Shop", parentShopId: null,
      status: "active", tokenBalance: 0, whatsappActivated: true,
    })

    await shopWaRouter(phone, "CODE999", "wamid.IN1")

    expect(lastReplyTo(phone)).toContain("no sessions left")
  })

  // ── Full state machine (happy path) ─────────────────────────────────────────
  it("walks code -> product -> network -> bundle -> recipient -> payment phone -> confirm -> OTP", async () => {
    const phone = "233241000020"

    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc10", shopId: "s10", shopName: "Kofi Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["Telecel", "MTN"])

    // ENTER_CODE (no session) -> SELECT_PRODUCT
    await shopWaRouter(phone, "CODE123", "w1")
    expect(lastReplyTo(phone)).toContain("What to buy?")

    // SELECT_PRODUCT: "2"/"3" (Airtime/RC) are Task 3.4 — stay put
    await shopWaRouter(phone, "2", "w1b")
    expect(lastReplyTo(phone)).toContain("Coming soon")
    expect(lastReplyTo(phone)).toContain("What to buy?")

    // SELECT_PRODUCT -> "1" (Data) -> SELECT_NETWORK
    await shopWaRouter(phone, "1", "w2")
    expect(lastReplyTo(phone)).toContain("Select Network")
    expect(lastReplyTo(phone)).toContain("MTN") // sortNetworks puts MTN first

    // SELECT_NETWORK -> "1" (MTN) -> SELECT_BUNDLE
    vi.mocked(fetchShopBundles).mockResolvedValue([
      { id: "p1", size: "1GB", price: 5 },
      { id: "p2", size: "2GB", price: 9 },
    ])
    await shopWaRouter(phone, "1", "w3")
    expect(fetchShopBundles).toHaveBeenCalledWith("s10", "MTN", undefined)
    expect(lastReplyTo(phone)).toContain("Select Bundle")
    expect(lastReplyTo(phone)).toContain("1GB")

    // SELECT_BUNDLE -> "1" (1GB) -> ENTER_RECIPIENT
    await shopWaRouter(phone, "1", "w4")
    expect(lastReplyTo(phone)).toContain("recipient")

    // ENTER_RECIPIENT -> valid Ghana number -> ENTER_PAYMENT_PHONE
    await shopWaRouter(phone, "0244000111", "w5")
    expect(lastReplyTo(phone)).toContain("MoMo number")

    // ENTER_PAYMENT_PHONE: invalid number stays on this step
    await shopWaRouter(phone, "12345", "w5b")
    expect(lastReplyTo(phone)).toContain("Invalid number")

    // ENTER_PAYMENT_PHONE -> valid MTN number -> CONFIRM
    await shopWaRouter(phone, "0244000222", "w6")
    expect(lastReplyTo(phone)).toContain("Pay now")
    expect(lastReplyTo(phone)).toContain("0244000222") // confirm screen shows the payment number

    // CONFIRM -> "1": verify price, create order, charge -> send_otp
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order1" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order1" })

    await shopWaRouter(phone, "1", "w7")

    expect(verifyBundlePrice).toHaveBeenCalledWith("s10", "p1", undefined)
    expect(createShopBundleOrder).toHaveBeenCalledWith(expect.objectContaining({
      shopCodeId: "sc10",
      shopId: "s10",
      parentShopId: null,
      dialingPhone: phone,
      recipientPhone: "0244000111",
      network: "MTN",
      paystackProvider: "mtn",
      bundleId: "p1",
      bundleSize: "1GB",
      verifiedPrice: 5,
      profitAmount: 1,
      parentProfitAmount: 0,
      chargeAmount: 5.15, // verifiedPrice 5 + 3% Paystack fee (0.15)
      shopName: "Kofi Shop",
      customerEmail: "cust@example.com",
      shopOwnerEmail: "owner@example.com",
      channel: "whatsapp_shop",
    }))
    expect(chargeMobileMoney).toHaveBeenCalledWith(expect.objectContaining({
      email: "cust@example.com",
      amount: 5.15,
      phone: "0244000222",
      provider: "mtn",
      reference: "order1",
    }))
    expect(lastReplyTo(phone)).toContain("OTP")

    // SUBMIT_OTP -> code submitted, session ends (one-shot)
    vi.mocked(submitOtp).mockResolvedValue({ status: "pending", reference: "order1" })
    await shopWaRouter(phone, "123456", "w8")
    expect(submitOtp).toHaveBeenCalledWith("order1", "123456")
    expect(lastReplyTo(phone)).toContain("authorization")

    // Session is gone — the next message is treated as a fresh code attempt.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "whatever", "w9")
    expect(resolveShopCode).toHaveBeenCalledWith("whatever")
  })

  it("CONFIRM: a charge that doesn't need an OTP sends the payment-sent message and ends the session", async () => {
    const phone = "233241000021"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc11", shopId: "s11", shopName: "No-OTP Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p5", size: "500MB", price: 3 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 3, profitAmount: 0.5, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order2" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "pay_offline", reference: "order2" })

    await shopWaRouter(phone, "CODE1", "a1")
    await shopWaRouter(phone, "1", "a2")   // SELECT_PRODUCT -> data
    await shopWaRouter(phone, "1", "a3")   // SELECT_NETWORK -> MTN
    await shopWaRouter(phone, "1", "a4")   // SELECT_BUNDLE -> 500MB
    await shopWaRouter(phone, "0244555666", "a5") // ENTER_RECIPIENT
    await shopWaRouter(phone, "0244777888", "a6") // ENTER_PAYMENT_PHONE -> CONFIRM
    await shopWaRouter(phone, "1", "a7")   // CONFIRM -> pay

    expect(lastReplyTo(phone)).toContain("MoMo prompt sent")
    expect(submitOtp).not.toHaveBeenCalled()

    // Session ended — next message re-resolves as a code attempt.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "x", "a8")
    expect(resolveShopCode).toHaveBeenCalledWith("x")
  })

  it("CONFIRM: replying '2' cancels without creating an order or charging", async () => {
    const phone = "233241000022"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc12", shopId: "s12", shopName: "Cancel Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p6", size: "1GB", price: 5 }])

    await shopWaRouter(phone, "CODE1", "b1")
    await shopWaRouter(phone, "1", "b2")
    await shopWaRouter(phone, "1", "b3")
    await shopWaRouter(phone, "1", "b4")
    await shopWaRouter(phone, "0244555666", "b5")
    await shopWaRouter(phone, "0244777888", "b6")

    await shopWaRouter(phone, "2", "b7")

    expect(createShopBundleOrder).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("cancelled")
  })

  // ── Price re-verification (anti-tampering) ──────────────────────────────────
  it("CONFIRM: a price mismatch from verifyBundlePrice cancels the order and restarts (no stale-price charge)", async () => {
    const phone = "233241000030"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc20", shopId: "s20", shopName: "Ama Shop", parentShopId: null,
      status: "active", tokenBalance: 3, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p9", size: "3GB", price: 12 }])

    await shopWaRouter(phone, "CODE999", "c1")
    await shopWaRouter(phone, "1", "c2")   // SELECT_PRODUCT -> data
    await shopWaRouter(phone, "1", "c3")   // SELECT_NETWORK -> MTN
    await shopWaRouter(phone, "1", "c4")   // SELECT_BUNDLE -> 3GB @ 12
    await shopWaRouter(phone, "0244111222", "c5") // ENTER_RECIPIENT
    await shopWaRouter(phone, "0244333444", "c6") // ENTER_PAYMENT_PHONE -> CONFIRM

    // Server-side price has moved since the bundle was selected.
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 15, profitAmount: 1, parentProfitAmount: 0 })

    await shopWaRouter(phone, "1", "c7")

    expect(createShopBundleOrder).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("price has changed")
    expect(lastReplyTo(phone)).toContain("GHS 15.00")

    // Session was torn down (restart) — the next message is a fresh code attempt.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "anything", "c8")
    expect(resolveShopCode).toHaveBeenCalledWith("anything")
  })

  it("CONFIRM: a package that's gone (verifyBundlePrice -> null) cancels and restarts", async () => {
    const phone = "233241000031"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc21", shopId: "s21", shopName: "Gone Shop", parentShopId: null,
      status: "active", tokenBalance: 3, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p7", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue(null)

    await shopWaRouter(phone, "CODE1", "d1")
    await shopWaRouter(phone, "1", "d2")
    await shopWaRouter(phone, "1", "d3")
    await shopWaRouter(phone, "1", "d4")
    await shopWaRouter(phone, "0244111222", "d5")
    await shopWaRouter(phone, "0244333444", "d6")

    await shopWaRouter(phone, "1", "d7")

    expect(createShopBundleOrder).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no longer available")
  })

  // ── Money-safety: payment phone is always asked, never assumed ─────────────
  it("never uses the WhatsApp sender's own number as the payment phone without it being explicitly entered", async () => {
    const phone = "233241000040" // the WhatsApp sender's own number
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc30", shopId: "s30", shopName: "Safety Shop", parentShopId: null,
      status: "active", tokenBalance: 3, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p8", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order5" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order5" })

    const explicitPaymentPhone = "0209999999" // deliberately a DIFFERENT number/network than `phone`

    await shopWaRouter(phone, "CODE1", "e1")
    await shopWaRouter(phone, "1", "e2")
    await shopWaRouter(phone, "1", "e3")
    await shopWaRouter(phone, "1", "e4")
    await shopWaRouter(phone, "0244111222", "e5") // recipient
    await shopWaRouter(phone, explicitPaymentPhone, "e6") // explicit MoMo number
    await shopWaRouter(phone, "1", "e7") // confirm/pay

    expect(chargeMobileMoney).toHaveBeenCalledWith(expect.objectContaining({ phone: explicitPaymentPhone }))
    expect(chargeMobileMoney).not.toHaveBeenCalledWith(expect.objectContaining({ phone }))
    expect(createShopBundleOrder).toHaveBeenCalledWith(expect.objectContaining({
      dialingPhone: phone, // the WA sender is recorded as who dialed in...
    }))
  })

  // ── Inbox visibility ─────────────────────────────────────────────────────────
  it("logs both the inbound and outbound message for admin inbox visibility", async () => {
    const phone = "233241000050"
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    await shopWaRouter(phone, "SOME_CODE", "wamid.IN")

    expect(logMessage).toHaveBeenCalledWith(phone, "inbound", "SOME_CODE", "wamid.IN")
    expect(logMessage).toHaveBeenCalledWith(phone, "outbound", expect.any(String), "wamid.OUT")
  })

  it("sends replies from the shop phone_number_id, not the main number", async () => {
    const phone = "233241000051"
    vi.mocked(resolveShopCode).mockResolvedValue(null)

    await shopWaRouter(phone, "SOME_CODE", "wamid.IN")

    expect(sendWhatsAppText).toHaveBeenCalledWith(phone, expect.any(String), SHOP_PNID)
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
