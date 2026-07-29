import { shopWaRouter, isShopWhatsAppNumber } from "@/lib/whatsapp-bot/shop-router"
import { sendWhatsAppText } from "@/lib/whatsapp-bot/send"
import { logMessage } from "@/lib/whatsapp-bot/log-message"
import { resolveShopCode, fetchShopNetworks } from "@/lib/shop-commerce/shop-code"
import { fetchShopBundles, verifyBundlePrice, shopOwnerIsDealer } from "@/lib/shop-commerce/pricing"
import { createShopBundleOrder, createShopAirtimeOrder, createShopRcOrder } from "@/lib/shop-commerce/orders"
import { chargeMobileMoney, submitOtp } from "@/lib/paystack"
import { resolveEmail } from "@/lib/ussd/resolve-email"
import { getPrefixValidationConfig } from "@/lib/network-prefix-config"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import { isAirtimeEnabled, getAirtimeLimits, airtimeBaseFeeRate } from "@/lib/airtime-pricing"
import { isExamBoardEnabled, getAvailableCount, getMaxQuantity, calculateRCPrice, getRCBulkHint } from "@/lib/results-checker-service"
import { buildRcBoardOptions } from "@/lib/ussd/handlers/results-checker"

// shopWaRouter — the full purchase state machine for all three shop products
// (Data — Task 3.3, Airtime + Results Checker — Task 3.4). Every side-effecting
// collaborator is mocked at the module boundary; the REAL
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
  shopOwnerIsDealer: vi.fn(),
}))
vi.mock("@/lib/shop-commerce/orders", () => ({
  createShopBundleOrder: vi.fn(),
  createShopAirtimeOrder: vi.fn(),
  createShopRcOrder: vi.fn(),
}))
vi.mock("@/lib/paystack", () => ({
  chargeMobileMoney: vi.fn(),
  submitOtp: vi.fn(),
}))
vi.mock("@/lib/ussd/resolve-email", () => ({ resolveEmail: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn() }))
// Airtime: keep the pure helpers (detectAirtimeNetwork, airtimeNetworkKey,
// splitInclusive) real — they have no DB dependency and are deterministic — but
// mock the async admin-settings-backed ones so tests control enablement/limits/
// fee-rate without needing to model admin_settings in the fake Supabase client.
vi.mock("@/lib/airtime-pricing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/airtime-pricing")>("@/lib/airtime-pricing")
  return {
    ...actual,
    isAirtimeEnabled: vi.fn(),
    getAirtimeLimits: vi.fn(),
    airtimeBaseFeeRate: vi.fn(),
  }
})
vi.mock("@/lib/results-checker-service", () => ({
  isExamBoardEnabled: vi.fn(),
  getAvailableCount: vi.fn(),
  getMaxQuantity: vi.fn(),
  calculateRCPrice: vi.fn(),
  getRCBulkHint: vi.fn(),
}))
vi.mock("@/lib/ussd/handlers/results-checker", () => ({ buildRcBoardOptions: vi.fn() }))

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
      if (table === "ussd_shop_orders" || table === "airtime_orders" || table === "results_checker_orders") {
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
    vi.mocked(shopOwnerIsDealer).mockResolvedValue(false)
    // Airtime defaults — a healthy, enabled network with a 5% base fee and (via
    // the fake user_shops row below, which has no airtime_markup_* field) a 0%
    // shop markup, so totalFeeRate=5%/merchantCommissionRate=0% unless a test
    // overrides airtimeBaseFeeRate.
    vi.mocked(isAirtimeEnabled).mockResolvedValue(true)
    vi.mocked(getAirtimeLimits).mockResolvedValue({ min: 1, max: 500 })
    vi.mocked(airtimeBaseFeeRate).mockResolvedValue(5)
    // Results Checker defaults — board enabled, plenty of stock, no bulk hint.
    vi.mocked(isExamBoardEnabled).mockResolvedValue(true)
    vi.mocked(getAvailableCount).mockResolvedValue(30)
    vi.mocked(getMaxQuantity).mockResolvedValue(50)
    vi.mocked(getRCBulkHint).mockResolvedValue(null)

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

    // SELECT_PRODUCT: "2" (Airtime) starts the airtime flow; "0" backs out again.
    await shopWaRouter(phone, "2", "w1b")
    expect(lastReplyTo(phone)).toContain("Buy Airtime")
    await shopWaRouter(phone, "0", "w1c")
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

  // ── Order-status writes on every non-happy-path outcome (no cron covers
  //    ussd_shop_orders, so a row left at pending/pending never recovers) ────
  it("CONFIRM: a send_otp charge result writes payment_status: 'otp_required' on the order", async () => {
    const phone = "233241000070"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc50", shopId: "s50", shopName: "OTP Write Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p14", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order20" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order20" })

    await shopWaRouter(phone, "CODE1", "m1")
    await shopWaRouter(phone, "1", "m2")
    await shopWaRouter(phone, "1", "m3")
    await shopWaRouter(phone, "1", "m4")
    await shopWaRouter(phone, "0244111222", "m5")
    await shopWaRouter(phone, "0244333444", "m6")

    await shopWaRouter(phone, "1", "m7") // CONFIRM -> pay -> send_otp

    expect(fakeDb.orderUpdates).toContainEqual({
      table: "ussd_shop_orders",
      payload: expect.objectContaining({ payment_status: "otp_required" }),
      id: "order20",
    })
    expect(fakeDb.orderUpdates.some(u => u.payload.order_status === "failed")).toBe(false)
  })

  it("CONFIRM: chargeMobileMoney throwing marks the order failed (no charge.failed webhook will ever arrive to reconcile it)", async () => {
    const phone = "233241000071"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc51", shopId: "s51", shopName: "Throw Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p15", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order21" })
    vi.mocked(chargeMobileMoney).mockRejectedValue(new Error("Paystack charge failed (HTTP 400)"))

    await shopWaRouter(phone, "CODE1", "n1")
    await shopWaRouter(phone, "1", "n2")
    await shopWaRouter(phone, "1", "n3")
    await shopWaRouter(phone, "1", "n4")
    await shopWaRouter(phone, "0244111222", "n5")
    await shopWaRouter(phone, "0244333444", "n6")

    await shopWaRouter(phone, "1", "n7") // CONFIRM -> pay -> chargeMobileMoney throws

    expect(lastReplyTo(phone)).toContain("could not start the payment")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "ussd_shop_orders",
      payload: expect.objectContaining({ order_status: "failed", payment_status: "failed" }),
      id: "order21",
    })
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
    expect(lastReplyTo(phone)).toContain("Buy Airtime")
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
    // Only the send_otp -> otp_required write from CONFIRM happened — a
    // "pending" submitOtp result must never also write order_status: 'failed'.
    expect(fakeDb.orderUpdates).toEqual([
      { table: "ussd_shop_orders", payload: expect.objectContaining({ payment_status: "otp_required" }), id: "order11" },
    ])
    expect(fakeDb.orderUpdates.some(u => u.payload.order_status === "failed")).toBe(false)
  })

  it("SUBMIT_OTP: a 'failed' status from submitOtp (Paystack rejected the OTP) marks the order failed", async () => {
    const phone = "233241000067"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc47", shopId: "s47", shopName: "OTP Rejected Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p16", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order12" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order12" })
    vi.mocked(submitOtp).mockResolvedValue({ status: "failed", reference: "order12" })

    await shopWaRouter(phone, "CODE1", "o1")
    await shopWaRouter(phone, "1", "o2")
    await shopWaRouter(phone, "1", "o3")
    await shopWaRouter(phone, "1", "o4")
    await shopWaRouter(phone, "0244111222", "o5")
    await shopWaRouter(phone, "0244333444", "o6")
    await shopWaRouter(phone, "1", "o7")

    await shopWaRouter(phone, "000000", "o8") // wrong/expired OTP

    expect(submitOtp).toHaveBeenCalledWith("order12", "000000")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "ussd_shop_orders",
      payload: expect.objectContaining({ order_status: "failed", payment_status: "failed" }),
      id: "order12",
    })
  })

  it("SUBMIT_OTP: submitOtp throwing marks the order failed", async () => {
    const phone = "233241000068"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc48", shopId: "s48", shopName: "OTP Throw Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p17", size: "1GB", price: 5 }])
    vi.mocked(verifyBundlePrice).mockResolvedValue({ verifiedPrice: 5, profitAmount: 1, parentProfitAmount: 0 })
    vi.mocked(createShopBundleOrder).mockResolvedValue({ orderId: "order13" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "order13" })
    vi.mocked(submitOtp).mockRejectedValue(new Error("OTP submission failed (HTTP 400)"))

    await shopWaRouter(phone, "CODE1", "p1")
    await shopWaRouter(phone, "1", "p2")
    await shopWaRouter(phone, "1", "p3")
    await shopWaRouter(phone, "1", "p4")
    await shopWaRouter(phone, "0244111222", "p5")
    await shopWaRouter(phone, "0244333444", "p6")
    await shopWaRouter(phone, "1", "p7")

    await shopWaRouter(phone, "123456", "p8")

    expect(fakeDb.orderUpdates).toContainEqual({
      table: "ussd_shop_orders",
      payload: expect.objectContaining({ order_status: "failed", payment_status: "failed" }),
      id: "order13",
    })
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

  // ── Coverage gaps: previously-untested branches in this money-path file ────
  it("ENTER_RECIPIENT: rejects a recipient number whose prefix doesn't match the selected network when prefix validation is enabled", async () => {
    const phone = "233241000072"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc60", shopId: "s60", shopName: "Prefix Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p18", size: "1GB", price: 5 }])
    vi.mocked(getPrefixValidationConfig).mockResolvedValue({ enabled: true, map: DEFAULT_NETWORK_PREFIXES })

    await shopWaRouter(phone, "CODE1", "q1")
    await shopWaRouter(phone, "1", "q2") // SELECT_PRODUCT -> data
    await shopWaRouter(phone, "1", "q3") // SELECT_NETWORK -> MTN
    await shopWaRouter(phone, "1", "q4") // SELECT_BUNDLE -> 1GB -> ENTER_RECIPIENT

    // 020 is a Telecel prefix, not MTN — must be rejected for an MTN order.
    await shopWaRouter(phone, "0209999999", "q5")

    expect(lastReplyTo(phone)).toContain("looks like a Telecel number")
    expect(lastReplyTo(phone)).toContain("Enter recipient number")

    // Still stuck on ENTER_RECIPIENT — a correctly-prefixed MTN number now proceeds.
    await shopWaRouter(phone, "0244111222", "q6")
    expect(lastReplyTo(phone)).toContain("MoMo number")
  })

  it("ENTER_PAYMENT_PHONE: rejects a validly-formatted number with no known Paystack provider", async () => {
    const phone = "233241000073"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc61", shopId: "s61", shopName: "No Provider Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([{ id: "p19", size: "1GB", price: 5 }])

    await shopWaRouter(phone, "CODE1", "r1")
    await shopWaRouter(phone, "1", "r2")
    await shopWaRouter(phone, "1", "r3")
    await shopWaRouter(phone, "1", "r4")
    await shopWaRouter(phone, "0244111222", "r5") // ENTER_RECIPIENT -> ENTER_PAYMENT_PHONE

    // Valid Ghana-number shape (0 + 9 digits), but "023" isn't a recognised
    // MTN/Telecel/AirtelTigo MoMo prefix -> paystackProviderFromPhone -> null.
    await shopWaRouter(phone, "0230000000", "r6")

    expect(lastReplyTo(phone)).toContain("Payment isn't available for that number")
    expect(createShopBundleOrder).not.toHaveBeenCalled()

    // Still on ENTER_PAYMENT_PHONE — a number with a known provider now proceeds.
    await shopWaRouter(phone, "0244333444", "r7")
    expect(lastReplyTo(phone)).toContain("Pay now")
  })

  it("SELECT_BUNDLE: pages via 'More...' to the next page and selects a bundle shown only there", async () => {
    const phone = "233241000074"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc62", shopId: "s62", shopName: "Paged Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(fetchShopBundles).mockResolvedValue([
      { id: "b1", size: "500MB", price: 2 },
      { id: "b2", size: "1GB", price: 4 },
      { id: "b3", size: "2GB", price: 7 },
      { id: "b4", size: "3GB", price: 10 },
      { id: "b5", size: "4GB", price: 13 },
      { id: "b6", size: "5GB", price: 16 },   // page 2 (PAGE_SIZE=5)
      { id: "b7", size: "10GB", price: 30 },  // page 2
    ])

    await shopWaRouter(phone, "CODE1", "s1")
    await shopWaRouter(phone, "1", "s2") // SELECT_PRODUCT -> data
    await shopWaRouter(phone, "1", "s3") // SELECT_NETWORK -> MTN -> SELECT_BUNDLE page 1

    const page1 = lastReplyTo(phone)
    expect(page1).toContain("500MB")
    expect(page1).not.toContain("10GB")
    expect(page1).toContain("6. More...")

    await shopWaRouter(phone, "6", "s4") // -> page 2

    const page2 = lastReplyTo(phone)
    expect(page2).toContain("5GB")
    expect(page2).toContain("10GB")
    expect(page2).not.toContain("500MB")
    expect(page2).not.toContain("More...") // all 7 bundles are now shown

    await shopWaRouter(phone, "7", "s5") // select "10GB" (2nd item on page 2)

    expect(lastReplyTo(phone)).toContain("recipient")
  })

  // ── Airtime (Task 3.4) ───────────────────────────────────────────────────────
  it("walks code -> product -> airtime recipient (network auto-detected) -> amount -> payment phone -> confirm -> OTP", async () => {
    const phone = "233241000080"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc70", shopId: "s70", shopName: "Airtime Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "at1") // ENTER_CODE -> SELECT_PRODUCT
    await shopWaRouter(phone, "2", "at2") // SELECT_PRODUCT -> AIRTIME_ENTER_RECIPIENT
    expect(lastReplyTo(phone)).toContain("Buy Airtime")

    // ENTER_RECIPIENT: "024" prefix -> MTN auto-detected -> ENTER_AMOUNT
    await shopWaRouter(phone, "0244111222", "at3")
    expect(lastReplyTo(phone)).toContain("MTN Airtime")

    // ENTER_AMOUNT: GHS 20, 5% base fee, 0% shop markup (fake user_shops row has
    // no airtime_markup_mtn field) -> fee 0.95, toDeliver 19.05
    await shopWaRouter(phone, "20", "at4")
    expect(lastReplyTo(phone)).toContain("MoMo number")

    // ENTER_PAYMENT_PHONE -> CONFIRM
    await shopWaRouter(phone, "0244000222", "at5")
    expect(lastReplyTo(phone)).toContain("Pay now")
    expect(lastReplyTo(phone)).toContain("19.05")

    // CONFIRM -> "1": re-verify, create order, charge -> send_otp
    vi.mocked(createShopAirtimeOrder).mockResolvedValue({ orderId: "airtimeOrder1" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "airtimeOrder1" })

    await shopWaRouter(phone, "1", "at6")

    expect(createShopAirtimeOrder).toHaveBeenCalledWith(expect.objectContaining({
      network: "MTN",
      beneficiaryPhone: "0244111222",
      airtimeAmount: 19.05,
      feeAmount: 0.95,
      totalPaid: 20,
      shopId: "s70",
      merchantCommission: 0,
      dialingPhone: phone,
      channel: "whatsapp_shop",
      customerEmail: "cust@example.com",
    }))
    expect(chargeMobileMoney).toHaveBeenCalledWith(expect.objectContaining({
      email: "cust@example.com",
      amount: 20,
      phone: "0244000222",
      provider: "mtn",
      reference: "airtimeOrder1",
    }))
    expect(lastReplyTo(phone)).toContain("OTP")

    // SUBMIT_OTP -> one-shot, session ends
    vi.mocked(submitOtp).mockResolvedValue({ status: "pending", reference: "airtimeOrder1" })
    await shopWaRouter(phone, "123456", "at7")
    expect(submitOtp).toHaveBeenCalledWith("airtimeOrder1", "123456")

    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "whatever", "at8")
    expect(resolveShopCode).toHaveBeenCalledWith("whatever")
  })

  it("AIRTIME_ENTER_RECIPIENT: an unrecognised prefix falls back to manual network selection", async () => {
    const phone = "233241000081"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc71", shopId: "s71", shopName: "Fallback Airtime Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "af1")
    await shopWaRouter(phone, "2", "af2") // -> AIRTIME_ENTER_RECIPIENT

    // "023" isn't in the airtime prefix table -> manual network menu.
    await shopWaRouter(phone, "0230000000", "af3")
    expect(lastReplyTo(phone)).toContain("Select Network")

    await shopWaRouter(phone, "1", "af4") // -> MTN -> ENTER_AMOUNT
    expect(lastReplyTo(phone)).toContain("MTN Airtime")
  })

  it("AIRTIME_CONFIRM: a token balance that hit zero rejects and does not create an order or charge", async () => {
    const phone = "233241000082"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc72", shopId: "s72", shopName: "Broke Airtime Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])

    await shopWaRouter(phone, "CODE1", "ag1")
    await shopWaRouter(phone, "2", "ag2")
    await shopWaRouter(phone, "0244111222", "ag3")
    await shopWaRouter(phone, "20", "ag4")
    await shopWaRouter(phone, "0244000222", "ag5")

    fakeDb.tokenBalance = 0
    await shopWaRouter(phone, "1", "ag6")

    expect(createShopAirtimeOrder).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no sessions left")
  })

  it("AIRTIME_CONFIRM: chargeMobileMoney throwing marks the airtime order failed", async () => {
    const phone = "233241000083"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc73", shopId: "s73", shopName: "Throw Airtime Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(createShopAirtimeOrder).mockResolvedValue({ orderId: "airtimeOrder2" })
    vi.mocked(chargeMobileMoney).mockRejectedValue(new Error("Paystack charge failed (HTTP 400)"))

    await shopWaRouter(phone, "CODE1", "ah1")
    await shopWaRouter(phone, "2", "ah2")
    await shopWaRouter(phone, "0244111222", "ah3")
    await shopWaRouter(phone, "20", "ah4")
    await shopWaRouter(phone, "0244000222", "ah5")

    await shopWaRouter(phone, "1", "ah6")

    expect(lastReplyTo(phone)).toContain("could not start the payment")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "airtime_orders",
      payload: expect.objectContaining({ status: "failed", payment_status: "failed" }),
      id: "airtimeOrder2",
    })
  })

  // ── Results Checker (Task 3.4) ──────────────────────────────────────────────
  it("walks code -> product -> RC board -> qty -> payment phone -> confirm -> OTP", async () => {
    const phone = "233241000090"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc80", shopId: "s80", shopName: "RC Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(buildRcBoardOptions).mockResolvedValue(["WASSCE", "BECE"])
    vi.mocked(calculateRCPrice).mockResolvedValue({
      basePrice: 5, markupPerVoucher: 0, unitPrice: 5, totalPaid: 10, merchantCommission: 1, bulkApplied: false,
    })

    await shopWaRouter(phone, "CODE1", "rc1") // ENTER_CODE -> SELECT_PRODUCT
    await shopWaRouter(phone, "3", "rc2") // SELECT_PRODUCT -> RC_SELECT_BOARD
    expect(lastReplyTo(phone)).toContain("Select exam")

    await shopWaRouter(phone, "1", "rc3") // -> WASSCE -> RC_ENTER_QTY
    expect(lastReplyTo(phone)).toContain("How many vouchers?")

    await shopWaRouter(phone, "2", "rc4") // qty 2 -> RC_ENTER_PAYMENT_PHONE
    expect(lastReplyTo(phone)).toContain("MoMo number")

    await shopWaRouter(phone, "0244000222", "rc5") // -> RC_CONFIRM
    expect(lastReplyTo(phone)).toContain("Pay now")
    expect(lastReplyTo(phone)).toContain("WASSCE x 2")

    vi.mocked(createShopRcOrder).mockResolvedValue({ orderId: "rcOrder1" })
    vi.mocked(chargeMobileMoney).mockResolvedValue({ status: "send_otp", reference: "rcOrder1" })

    await shopWaRouter(phone, "1", "rc6") // CONFIRM -> pay -> send_otp

    expect(createShopRcOrder).toHaveBeenCalledWith(expect.objectContaining({
      examBoard: "WASSCE",
      quantity: 2,
      customerPhone: "0241000090",
      unitPrice: 5,
      totalPaid: 10,
      shopId: "s80",
      merchantCommission: 1,
      dialingPhone: phone,
      channel: "whatsapp_shop",
      customerEmail: "cust@example.com",
    }))
    expect(chargeMobileMoney).toHaveBeenCalledWith(expect.objectContaining({
      email: "cust@example.com",
      amount: 10,
      phone: "0244000222",
      provider: "mtn",
      reference: "rcOrder1",
    }))
    expect(lastReplyTo(phone)).toContain("OTP")

    vi.mocked(submitOtp).mockResolvedValue({ status: "pending", reference: "rcOrder1" })
    await shopWaRouter(phone, "123456", "rc7")
    expect(submitOtp).toHaveBeenCalledWith("rcOrder1", "123456")

    vi.mocked(resolveShopCode).mockClear()
    vi.mocked(resolveShopCode).mockResolvedValue(null)
    await shopWaRouter(phone, "whatever", "rc8")
    expect(resolveShopCode).toHaveBeenCalledWith("whatever")
  })

  it("RC_CONFIRM: a token balance that hit zero rejects and does not create an order or charge", async () => {
    const phone = "233241000091"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc81", shopId: "s81", shopName: "Broke RC Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(buildRcBoardOptions).mockResolvedValue(["WASSCE"])
    vi.mocked(calculateRCPrice).mockResolvedValue({
      basePrice: 5, markupPerVoucher: 0, unitPrice: 5, totalPaid: 5, merchantCommission: 0, bulkApplied: false,
    })

    await shopWaRouter(phone, "CODE1", "rd1")
    await shopWaRouter(phone, "3", "rd2")
    await shopWaRouter(phone, "1", "rd3")
    await shopWaRouter(phone, "1", "rd4")
    await shopWaRouter(phone, "0244000222", "rd5")

    fakeDb.tokenBalance = 0
    await shopWaRouter(phone, "1", "rd6")

    expect(createShopRcOrder).not.toHaveBeenCalled()
    expect(chargeMobileMoney).not.toHaveBeenCalled()
    expect(lastReplyTo(phone)).toContain("no sessions left")
  })

  it("RC_CONFIRM: chargeMobileMoney throwing marks the results-checker order failed", async () => {
    const phone = "233241000092"
    vi.mocked(resolveShopCode).mockResolvedValue({
      shopCodeId: "sc82", shopId: "s82", shopName: "Throw RC Shop", parentShopId: null,
      status: "active", tokenBalance: 5, whatsappActivated: true,
    })
    vi.mocked(fetchShopNetworks).mockResolvedValue(["MTN"])
    vi.mocked(buildRcBoardOptions).mockResolvedValue(["WASSCE"])
    vi.mocked(calculateRCPrice).mockResolvedValue({
      basePrice: 5, markupPerVoucher: 0, unitPrice: 5, totalPaid: 5, merchantCommission: 0, bulkApplied: false,
    })
    vi.mocked(createShopRcOrder).mockResolvedValue({ orderId: "rcOrder2" })
    vi.mocked(chargeMobileMoney).mockRejectedValue(new Error("Paystack charge failed (HTTP 400)"))

    await shopWaRouter(phone, "CODE1", "re1")
    await shopWaRouter(phone, "3", "re2")
    await shopWaRouter(phone, "1", "re3")
    await shopWaRouter(phone, "1", "re4")
    await shopWaRouter(phone, "0244000222", "re5")

    await shopWaRouter(phone, "1", "re6")

    expect(lastReplyTo(phone)).toContain("could not start the payment")
    expect(fakeDb.orderUpdates).toContainEqual({
      table: "results_checker_orders",
      payload: expect.objectContaining({ status: "failed", payment_status: "failed" }),
      id: "rcOrder2",
    })
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
