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

// Backs every ad-hoc read/write shop-router.ts makes with its own Supabase client
// (shop owner email, Paystack fee %, the CONFIRM-time token-balance recheck, the
// data-whitelist setting/RPC, and the SUBMIT_OTP-cancel order-failure update) — no
// shop-commerce module owns these, so this is the only way to control them from a
// test. Declared via vi.hoisted so the mutable state is initialised before the
// hoisted vi.mock factory below (which runs at import time) can reference it.
const fakeDb = vi.hoisted(() => ({
  feePercent: 3,
  ownerEmail: "owner@example.com" as string | null,
  tokenBalance: 5 as number | null,
  whitelistEnabled: false,
  hasCompletedPurchase: true,
  orderUpdates: [] as Array<{ table: string; payload: Record<string, unknown>; id: unknown }>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table === "app_settings") {
        return { select: () => ({ single: () => Promise.resolve({ data: { paystack_fee_percentage: fakeDb.feePercent } }) }) }
      }
      if (table === "user_shops") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: fakeDb.ownerEmail ? { user_id: "owner1", users: { email: fakeDb.ownerEmail } } : null,
              }),
            }),
          }),
        }
      }
      if (table === "ussd_shop_codes") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: fakeDb.tokenBalance === null ? null : { token_balance: fakeDb.tokenBalance },
              }),
            }),
          }),
        }
      }
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: { value: { enabled: fakeDb.whitelistEnabled } } }),
            }),
          }),
        }
      }
      if (table === "ussd_shop_orders") {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, id: unknown) => {
              fakeDb.orderUpdates.push({ table, payload, id })
              return Promise.resolve({ data: null, error: null })
            },
          }),
        }
      }
      throw new Error(`shop-router.test.ts fake supabase client: unexpected table "${table}"`)
    },
    rpc: (fnName: string) => {
      if (fnName === "has_completed_purchase") {
        return Promise.resolve({ data: fakeDb.hasCompletedPurchase, error: null })
      }
      throw new Error(`shop-router.test.ts fake supabase client: unexpected rpc "${fnName}"`)
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

    // Reset the fake Supabase backing store (not a vi.fn(), so resetAllMocks
    // doesn't touch it) — token balance defaults to a healthy 5, whitelist off.
    fakeDb.feePercent = 3
    fakeDb.ownerEmail = "owner@example.com"
    fakeDb.tokenBalance = 5
    fakeDb.whitelistEnabled = false
    fakeDb.hasCompletedPurchase = true
    fakeDb.orderUpdates = []
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

  // ── CONFIRM-time token recheck (anti-race, shop-revenue safety) ────────────
  it("CONFIRM: a token balance that hit zero since ENTER_CODE rejects and doesn't charge or create an order", async () => {
    const phone = "233241000060"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc40", shopId: "s40", shopName: "Race Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p10", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })

    await shopWaRouter(phone, "CODE1", "f1")
    await shopWaRouter(phone, "1", "f2")
    await shopWaRouter(phone, "1", "f3")
    await shopWaRouter(phone, "1", "f4")
    await shopWaRouter(phone, "0244111222", "f5")
    await shopWaRouter(phone, "0244333444", "f6")

    // The shop's shared token pool got spent to 0 elsewhere while this
    // WhatsApp session sat idle (its 30-min TTL leaves room for that).
    fakeDb.tokenBalance = 0

    await shopWaRouter(phone, "1", "f7")

    expect(verifyBundlePrice).not.toHaveBeenCalled()
    expect(createShopBundleOrder).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no sessions left")

    // Session torn down — the next message is a fresh code attempt.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "anything", "f8")
    expect(resolveShopCode).toHaveBeenCalledWith("anything")
  })

  it("CONFIRM: a healthy token balance (>0) does not block the charge", async () => {
    const phone = "233241000064"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc44", shopId: "s44", shopName: "Healthy Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p12", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order10" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order10" })
    fakeDb.tokenBalance = 1 // still >0

    await shopWaRouter(phone, "CODE1", "j1")
    await shopWaRouter(phone, "1", "j2")
    await shopWaRouter(phone, "1", "j3")
    await shopWaRouter(phone, "1", "j4")
    await shopWaRouter(phone, "0244111222", "j5")
    await shopWaRouter(phone, "0244333444", "j6")
    await shopWaRouter(phone, "1", "j7")

    expect(createShopBundleOrder).toHaveBeenCalled()
    expect(chargeMobileMoney).toHaveBeenCalled()
  })

  // ── Data-whitelist gate ──────────────────────────────────────────────────────
  it("SELECT_PRODUCT: the whitelist gate hides Data Bundle and blocks buying data when the customer hasn't purchased before", async () => {
    const phone = "233241000061"
    fakeDb.whitelistEnabled = true
    fakeDb.hasCompletedPurchase = false

    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc41", shopId: "s41", shopName: "Whitelist Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "g1")
    expect(lastReplyTo(phone)).not.toContain("Data Bundle")
    expect(lastReplyTo(phone)).toContain("1. Airtime")

    // Menu is renumbered (no Data option) — "1" now means Airtime, never Data.
    await shopWaRouter(phone, "1", "g2")
    expect(fetchShopBundles).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("Coming soon")
  })

  it("SELECT_PRODUCT: shows Data Bundle normally when the whitelist is enabled but the customer HAS purchased before", async () => {
    const phone = "233241000065"
    fakeDb.whitelistEnabled = true
    fakeDb.hasCompletedPurchase = true

    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc45", shopId: "s45", shopName: "Returning Customer Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "k1")
    expect(lastReplyTo(phone)).toContain("Data Bundle")
  })

  it("SELECT_NETWORK: re-checks the whitelist right before fetching bundles, even if it passed at code entry", async () => {
    const phone = "233241000062"
    fakeDb.whitelistEnabled = false // not blocked at code entry
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc42", shopId: "s42", shopName: "Flip Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "h1") // SELECT_PRODUCT — Data option shown
    expect(lastReplyTo(phone)).toContain("Data Bundle")

    await shopWaRouter(phone, "1", "h2") // -> data -> SELECT_NETWORK

    // ...but blocked by the time they actually pick a network (e.g. an admin
    // flipped the setting, or their purchase-history check now fails).
    fakeDb.whitelistEnabled = true
    fakeDb.hasCompletedPurchase = false

    await shopWaRouter(phone, "1", "h3") // SELECT_NETWORK -> MTN

    expect(fetchShopBundles).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("Data bundles not available")
  })

  // ── SUBMIT_OTP cancel must not leave the order stuck pending ────────────────
  it("SUBMIT_OTP: cancelling ('0') marks the order failed instead of leaving it stuck pending/pending", async () => {
    const phone = "233241000063"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc43", shopId: "s43", shopName: "OTP Cancel Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p11", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order9" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order9" })

    await shopWaRouter(phone, "CODE1", "i1")
    await shopWaRouter(phone, "1", "i2")
    await shopWaRouter(phone, "1", "i3")
    await shopWaRouter(phone, "1", "i4")
    await shopWaRouter(phone, "0244111222", "i5")
    await shopWaRouter(phone, "0244333444", "i6")
    await shopWaRouter(phone, "1", "i7") // CONFIRM -> pay -> send_otp

    expect(lastReplyTo(phone)).toContain("OTP")

    await shopWaRouter(phone, "0", "i8") // SUBMIT_OTP -> cancel

    expect(submitOtp).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("cancelled")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "ussd_shop_orders",
      payload: expect.objectContaining({ order_status: "failed", payment_status: "failed" }),
      id: "order9",
    })

    // Session ended — next message is a fresh code attempt.
    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "anything", "i9")
    expect(resolveShopCode).toHaveBeenCalledWith("anything")
  })

  it("SUBMIT_OTP: submitting an actual OTP code does not touch the order-failure path", async () => {
    const phone = "233241000066"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc46", shopId: "s46", shopName: "OTP Success Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p13", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order11" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order11" })
    vi.mocked(submitOtp).mockResolvedValue({ status: "pending", reference: "order11" })

    await shopWaRouter(phone, "CODE1", "l1")
    await shopWaRouter(phone, "1", "l2")
    await shopWaRouter(phone, "1", "l3")
    await shopWaRouter(phone, "1", "l4")
    await shopWaRouter(phone, "0244111222", "l5")
    await shopWaRouter(phone, "0244333444", "l6")
    await shopWaRouter(phone, "1", "l7")

    await shopWaRouter(phone, "123456", "l8")

    expect(submitOtp).toHaveBeenCalledWith("order11", "123456")
    expect(fakeDb.orderUpdates).toEqual([])
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
