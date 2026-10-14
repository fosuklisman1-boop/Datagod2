import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    settings: {
      airtime_enabled_mtn: { enabled: true },
      airtime_fee_mtn_customer: { rate: 5 },
      airtime_fee_mtn_dealer: { rate: 3 },
      airtime_min_amount: { amount: 1 },
      airtime_max_amount: { amount: 500 },
    } as Record<string, any>,
    userRole: "user",
    recentOrder: null as any,
    deductError: null as null | string,
    deductResult: [{ new_balance: 88, old_balance: 100, new_total_spent: 12 }] as any,
    insertedOrder: { id: "order-1" } as any,
    insertError: null as any,
    cashbackReadError: false,
    calls: [] as Array<{ table: string; patch: any }>,
    orderInserts: [] as any[],
    txInserts: [] as any[],
    deductCalls: [] as any[],
    keysRead: [] as string[],
  }

  const fake = {
    from: (table: string) => {
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              single: () => (state.keysRead.push(key), Promise.resolve({ data: { value: state.settings[key] ?? null }, error: null })),
              maybeSingle: () => {
                if (key === "commission_cashback_config" && state.cashbackReadError) {
                  return Promise.resolve({ data: null, error: { message: "read failed" } })
                }
                const v = state.settings[key]
                return Promise.resolve({ data: v === undefined ? null : { value: v }, error: null })
              },
            }),
            in: (_col: string, keys: string[]) => Promise.resolve({
              data: keys.map((k) => ({ key: k, value: state.settings[k] ?? null })),
              error: null,
            }),
          }),
        }
      }
      if (table === "users") {
        return {
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { role: state.userRole }, error: null }) }) }),
        }
      }
      if (table === "airtime_orders") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  neq: () => ({
                    gte: () => ({ maybeSingle: () => Promise.resolve({ data: state.recentOrder, error: null }) }),
                  }),
                }),
              }),
            }),
          }),
          insert: (rows: any[]) => ({
            select: () => ({
              single: () => (state.orderInserts.push(rows[0]), Promise.resolve(
                state.insertError
                  ? { data: null, error: state.insertError }
                  : { data: state.insertedOrder, error: null }
              )),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        }
      }
      if (table === "wallets") {
        return {
          insert: () => Promise.resolve({ data: null, error: null }),
          update: (patch: any) => ({
            eq: () => {
              state.calls.push({ table: "wallets", patch })
              return Promise.resolve({ data: null, error: null })
            },
          }),
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        }
      }
      if (table === "transactions" || table === "notifications" || table === "user_shops") {
        return {
          insert: (rows: any[]) => {
            if (table === "transactions") state.txInserts.push(rows[0])
            return Promise.resolve({ data: null, error: null })
          },
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: (fn: string, args?: any) => {
      if (fn === "deduct_wallet") {
        state.deductCalls.push(args)
        return Promise.resolve(
          state.deductError
            ? { data: null, error: { message: state.deductError } }
            : { data: state.deductResult, error: null }
        )
      }
      return Promise.resolve({ data: null, error: null })
    },
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))

// purchaseAirtime calls triggerDigiwapyFulfillment as a same-module function
// reference, not through the module's export binding — self-mocking
// "@/lib/airtime-service" would NOT intercept that internal call. Mock its
// real dependencies (a genuine module boundary) instead.
vi.mock("@/lib/digiwapy-provider", () => ({
  isDigiWapyConfigured: vi.fn(() => true),
  isDigiWapyEnabledForNetwork: vi.fn(async () => true),
  sendAirtimeViaDigiwapy: vi.fn(async () => ({ success: true, digiwapyRef: "dgw-1" })),
}))
vi.mock("@/lib/sms-service", () => ({
  notifyAdmins: vi.fn(async () => {}),
  SMSTemplates: {
    adminAirtimeManualRequired: () => "msg",
    adminAirtimeDigiwapyFailed: () => "msg",
  },
}))
vi.mock("@/lib/email-service", () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  EmailTemplates: { airtimeAdminAlert: () => ({ subject: "s", html: "h" }) },
}))

vi.mock("@/lib/airtime-hubtel", () => ({
  fulfillAirtimeViaHubtel: vi.fn(async () => true),
}))
vi.mock("@/lib/hubtel-cs/runtime", () => ({
  getHubtelCsRuntime: () => ({
    client: { purchase: vi.fn() },
    store: { getByRef: vi.fn() },
    onTransition: vi.fn(),
  }),
}))

import { purchaseAirtime } from "./airtime-service"
import { isDigiWapyConfigured, sendAirtimeViaDigiwapy } from "@/lib/digiwapy-provider"
import { airtimeEnabledKey, airtimeFeeKey, legacyAirtimePrice } from "@/lib/airtime-fee"
import { fulfillAirtimeViaHubtel } from "@/lib/airtime-hubtel"

const CASHBACK_CFG = {
  enabled: true,
  surfaces: { dashboard: true, bots: false, storefront: false, api: false },
  rates: { "airtime_mtn:hubtel": 3.96, "airtime_mtn:digiwapy": 3.96 },
  shares: {
    airtime: { customer: 25, dealer: 50, storefrontCustomer: 0, storefrontShop: 0 },
    bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
    bills: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
  },
}

const buy = (extra: Record<string, unknown> = {}) =>
  purchaseAirtime({
    userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard",
    ...extra,
  } as any)

// Legacy row for GHS 10 MTN, customer, fee 5% inclusive: fee = 10*5/105 = 0.48, recipient 9.52.
const LEGACY_ROW = {
  user_id: "user-1",
  reference_code: expect.any(String),
  network: "MTN",
  beneficiary_phone: "0541234567",
  airtime_amount: 9.52,
  fee_amount: 0.48,
  total_paid: 10,
  pay_separately: false,
  status: "pending",
  payment_status: "completed",
  shop_id: null,
  merchant_commission: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.cashbackReadError = false
  h.state.orderInserts = []
  h.state.txInserts = []
  h.state.deductCalls = []
  h.state.keysRead = []
  vi.mocked(isDigiWapyConfigured).mockReturnValue(true)
  h.state.settings = {
    airtime_enabled_mtn: { enabled: true },
    airtime_fee_mtn_customer: { rate: 5 },
    airtime_fee_mtn_dealer: { rate: 3 },
    airtime_min_amount: { amount: 1 },
    airtime_max_amount: { amount: 500 },
  }
  h.state.userRole = "user"
  h.state.recentOrder = null
  h.state.deductError = null
  h.state.deductResult = [{ new_balance: 88, old_balance: 100, new_total_spent: 12 }]
  h.state.insertedOrder = { id: "order-1" }
  h.state.insertError = null
  h.state.calls = []
})

describe("purchaseAirtime", () => {
  it("creates an order and returns the reference + new balance", async () => {
    const result = await purchaseAirtime({
      userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard",
    })
    expect(result.order.id).toBe("order-1")
    expect(result.newBalance).toBe(88)
  })

  it("throws NETWORK_DISABLED when the network is disabled", async () => {
    h.state.settings.airtime_enabled_mtn = { enabled: false }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "NETWORK_DISABLED" })
  })

  it("throws INSUFFICIENT_BALANCE when deduct_wallet returns no rows", async () => {
    h.state.deductResult = []
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" })
  })

  it("throws DUPLICATE_REQUEST when an identical order was placed in the last 30s", async () => {
    h.state.recentOrder = { id: "prev", reference_code: "AT-XXX-YYY" }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" })
  })

  it("throws PAYMENT_FAILED when the deduct_wallet RPC errors", async () => {
    h.state.deductError = "connection reset"
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "PAYMENT_FAILED" })
  })

  it("throws ORDER_CREATE_FAILED and refunds the wallet to its pre-deduction balance when the order insert fails", async () => {
    h.state.insertError = { message: "insert failed" }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "ORDER_CREATE_FAILED" })

    const refundCall = h.state.calls.find((c) => c.table === "wallets")
    expect(refundCall).toBeDefined()
    expect(refundCall!.patch.balance).toBe(100) // deductResult[0].old_balance
  })

  it("throws NETWORK_MISMATCH when the phone doesn't match the claimed network", async () => {
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0201234567", airtimeAmount: 10, channel: "dashboard" })
    ).rejects.toMatchObject({ code: "NETWORK_MISMATCH" })
  })

  it("skips the prefix check when the admin has disabled it", async () => {
    h.state.settings.network_prefix_validation_enabled = { enabled: false }
    const result = await purchaseAirtime({
      userId: "user-1", network: "MTN", beneficiaryPhone: "0201234567", airtimeAmount: 10, channel: "dashboard",
    })
    expect(result.order.id).toBe("order-1")
  })
})

describe("purchaseAirtime — network settings keys", () => {
  const settingKeys = () => h.state.keysRead.filter((k) => k.startsWith("airtime_enabled_") || k.startsWith("airtime_fee_"))

  it("MTN reads exactly the keys it always has (customer + dealer)", async () => {
    await buy()
    expect(settingKeys()).toEqual(["airtime_enabled_mtn", "airtime_fee_mtn_customer"])
    h.state.keysRead = []; h.state.userRole = "dealer"
    await buy({ beneficiaryPhone: "0551234567" })
    expect(settingKeys()).toEqual(["airtime_enabled_mtn", "airtime_fee_mtn_dealer"])
    expect(h.state.orderInserts.map((o) => o.network)).toEqual(["MTN", "MTN"])
  })

  it("Telecel reads exactly the keys it always has and is stored as Telecel", async () => {
    h.state.settings.network_prefix_validation_enabled = { enabled: false }
    await buy({ network: "Telecel", beneficiaryPhone: "0201234567" })
    expect(settingKeys()).toEqual(["airtime_enabled_telecel", "airtime_fee_telecel_customer"])
    h.state.keysRead = []; h.state.userRole = "sub_agent"
    await buy({ network: "Telecel", beneficiaryPhone: "0501234567" })
    expect(settingKeys()).toEqual(["airtime_enabled_telecel", "airtime_fee_telecel_dealer"])
    expect(h.state.orderInserts.map((o) => o.network)).toEqual(["Telecel", "Telecel"])
  })

  for (const spelling of ["AT", "AirtelTigo"]) {
    it(`${spelling} reads the at keys, never airteltigo, and is stored as "AT"`, async () => {
      h.state.settings.airtime_enabled_at = { enabled: true }
      h.state.settings.airtime_fee_at_customer = { rate: 10 }
      await buy({ network: spelling, beneficiaryPhone: "0271234567", paySeparately: true })
      expect(settingKeys()).toEqual(["airtime_enabled_at", "airtime_fee_at_customer"])
      expect(h.state.keysRead.some((k) => k.includes("airteltigo"))).toBe(false)
      // 10% fee from airtime_fee_at_customer: 10 + 1.00
      expect(h.state.orderInserts[0]).toMatchObject({ network: "AT", airtime_amount: 10, fee_amount: 1, total_paid: 11 })
      expect(h.state.deductCalls[0].p_amount).toBe(11)
    })

    it(`${spelling} is blocked by airtime_enabled_at = false`, async () => {
      h.state.settings.airtime_enabled_at = { enabled: false }
      await expect(buy({ network: spelling, beneficiaryPhone: "0271234567" })).rejects.toMatchObject({ code: "NETWORK_DISABLED" })
    })
  }

  it("AT: the dashboard page's fee key + maths match the server's charge (both fee modes, both tiers)", async () => {
    h.state.settings.airtime_fee_at_customer = { rate: 7 }
    h.state.settings.airtime_fee_at_dealer = { rate: 2.5 }
    for (const role of ["user", "dealer"]) {
      for (const paySeparately of [true, false]) {
        h.state.userRole = role
        h.state.orderInserts = []; h.state.deductCalls = []
        // What app/dashboard/airtime/page.tsx computes: same key helper (with the "AT" it sends), same maths.
        const pageKey = airtimeFeeKey("AT", role === "dealer" ? "dealer" : "customer")
        const page = legacyAirtimePrice(13, h.state.settings[pageKey].rate, paySeparately)
        // Sending the page's price as expectedPay must not 409.
        await buy({ network: "AT", beneficiaryPhone: "0271234567", airtimeAmount: 13, paySeparately, expectedPay: page.total })
        expect(h.state.deductCalls[0].p_amount).toBe(page.total)
        expect(h.state.orderInserts[0]).toMatchObject({ airtime_amount: page.toRecipient, fee_amount: page.fee, total_paid: page.total })
      }
    }
    expect(airtimeEnabledKey("AT")).toBe("airtime_enabled_at")
  })
})

describe("purchaseAirtime — instant cashback", () => {
  it("applied (customer): debits payAmount 9.91, order airtime_amount 10, fee 0, snapshot columns set, Hubtel gets face 10", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.settings.airtime_provider_mtn = { provider: "hubtel" }

    const result = await buy({ paySeparately: true })

    expect(h.state.deductCalls).toEqual([{ p_user_id: "user-1", p_amount: 9.91 }])
    expect(h.state.orderInserts).toHaveLength(1)
    expect(h.state.orderInserts[0]).toMatchObject({
      airtime_amount: 10,
      fee_amount: 0,
      total_paid: 9.91,
      pay_separately: false,
      cashback_amount: 0.09,
      shop_share_amount: 0,
      cashback_rate: 3.96,
      cashback_share: 25,
      cashback_provider: "hubtel",
      expected_commission: 0.396,
    })
    expect(h.state.txInserts[0]).toMatchObject({
      amount: 9.91,
      description: "Airtime: MTN GHS 10 to 0541234567 (cashback GHS 0.09)",
    })
    expect(result.order).toMatchObject({ airtime_amount: 10, fee_amount: 0, total_paid: 9.91 })
    expect(fulfillAirtimeViaHubtel).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fulfillAirtimeViaHubtel).mock.calls[0][0]).toMatchObject({ airtime_amount: 10 })
  })

  it("applied (dealer): debits payAmount 9.81; Digiwapy fulfilment receives amount 10", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.userRole = "dealer"

    await buy()

    expect(h.state.deductCalls).toEqual([{ p_user_id: "user-1", p_amount: 9.81 }])
    expect(h.state.orderInserts[0]).toMatchObject({
      airtime_amount: 10, fee_amount: 0, total_paid: 9.81,
      cashback_amount: 0.19, cashback_share: 50, cashback_provider: "digiwapy",
    })
    expect(sendAirtimeViaDigiwapy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendAirtimeViaDigiwapy).mock.calls[0][0]).toMatchObject({ amount: 10 })
  })

  it("applied (sub_agent counts as dealer tier)", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.userRole = "sub_agent"
    await buy()
    expect(h.state.deductCalls[0].p_amount).toBe(9.81)
  })

  it("expectedPay matching the quote proceeds", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    await buy({ expectedPay: 9.91 })
    expect(h.state.deductCalls[0].p_amount).toBe(9.91)
  })

  it("PRICE_CHANGED when expectedPay differs: no debit, no insert, carries the quote (thrown before the duplicate check)", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.recentOrder = { id: "prev", reference_code: "AT-XXX-YYY" }

    await expect(buy({ expectedPay: 10 })).rejects.toMatchObject({
      code: "PRICE_CHANGED",
      quote: { faceAmount: 10, payAmount: 9.91, customerCashback: 0.09 },
    })
    expect(h.state.deductCalls).toHaveLength(0)
    expect(h.state.orderInserts).toHaveLength(0)
  })

  it("provider manual ⇒ legacy fee path", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.settings.airtime_provider_mtn = { provider: "manual" }
    await buy()
    expect(h.state.orderInserts[0]).toEqual(LEGACY_ROW)
    expect(h.state.deductCalls[0].p_amount).toBe(10)
  })

  it("shopId set ⇒ legacy path even with the dashboard switch on", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    await buy({ shopId: "shop-1" })
    expect(h.state.orderInserts[0]).toEqual({ ...LEGACY_ROW, shop_id: "shop-1" })
    expect(h.state.orderInserts[0]).not.toHaveProperty("cashback_amount")
  })

  it("channel api with api switch off ⇒ legacy path identical to before", async () => {
    await buy({ channel: "api" })
    const before = { order: h.state.orderInserts[0], debit: h.state.deductCalls[0], tx: h.state.txInserts[0] }

    h.state.orderInserts = []; h.state.deductCalls = []; h.state.txInserts = []
    h.state.settings.commission_cashback_config = CASHBACK_CFG // dashboard on, api off
    await buy({ channel: "api" })

    expect(h.state.orderInserts[0]).toEqual(LEGACY_ROW)
    expect(h.state.orderInserts[0]).toEqual({ ...before.order, reference_code: expect.any(String) })
    expect(h.state.deductCalls[0]).toEqual(before.debit)
    expect(h.state.txInserts[0]).toEqual({ ...before.tx, created_at: expect.any(String) })
    expect(h.state.txInserts[0].description).toBe("Airtime: MTN GHS 9.52 to 0541234567")
  })

  it("config read throws ⇒ legacy path", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.cashbackReadError = true
    await buy()
    expect(h.state.orderInserts[0]).toEqual(LEGACY_ROW)
    expect(h.state.deductCalls[0].p_amount).toBe(10)
  })

  it("applied price shown, then switch turned off ⇒ PRICE_CHANGED with the legacy quote, no debit, no insert", async () => {
    // No cashback config (switch off): legacy total is 10, client expected the cashback price 9.91.
    await expect(buy({ expectedPay: 9.91 })).rejects.toMatchObject({
      code: "PRICE_CHANGED",
      quote: { faceAmount: 10, payAmount: 10, customerCashback: 0 },
    })
    expect(h.state.deductCalls).toHaveLength(0)
    expect(h.state.orderInserts).toHaveLength(0)
  })

  it("legacy path with matching expectedPay proceeds unchanged", async () => {
    await buy({ expectedPay: 10 })
    expect(h.state.orderInserts[0]).toEqual(LEGACY_ROW)
  })

  it("hubtel provider with face above Hubtel's max (101) ⇒ legacy path, no cashback", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.settings.airtime_provider_mtn = { provider: "hubtel" }
    await buy({ airtimeAmount: 101 })
    // 5% inclusive fee: 101*5/105 = 4.81, recipient 96.19
    expect(h.state.orderInserts[0]).toEqual({ ...LEGACY_ROW, airtime_amount: 96.19, fee_amount: 4.81, total_paid: 101 })
    expect(h.state.deductCalls[0].p_amount).toBe(101)
  })

  it("hubtel provider with face at Hubtel's max (100) still gets cashback", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.settings.airtime_provider_mtn = { provider: "hubtel" }
    await buy({ airtimeAmount: 100 })
    // 10000 * 3.96 * 25 / 10000 = 99 pesewas
    expect(h.state.deductCalls[0].p_amount).toBe(99.01)
    expect(h.state.orderInserts[0]).toMatchObject({ airtime_amount: 100, cashback_amount: 0.99 })
  })

  it("AirtelTigo resolves to the airtime_at rate key", async () => {
    h.state.settings.network_prefix_validation_enabled = { enabled: false }
    h.state.settings.commission_cashback_config = {
      ...CASHBACK_CFG,
      rates: { "airtime_at:digiwapy": 3.96 }, // no MTN rate: only the AT key can apply
    }
    await buy({ network: "AirtelTigo", beneficiaryPhone: "0271234567" })
    expect(h.state.deductCalls[0].p_amount).toBe(9.91)
    expect(h.state.orderInserts[0]).toMatchObject({ network: "AT", airtime_amount: 10, cashback_provider: "digiwapy" })
  })

  it("digiwapy resolved but not configured (no env) ⇒ legacy path, no cashback", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.settings.airtime_provider_mtn = { provider: "digiwapy" }
    vi.mocked(isDigiWapyConfigured).mockReturnValue(false)
    await buy()
    expect(h.state.orderInserts[0]).toEqual(LEGACY_ROW)
    expect(h.state.deductCalls[0].p_amount).toBe(10)
  })

  it("PRICE_CHANGED quote carries the legacy breakdown (recipient + fee) behind payAmount", async () => {
    // Client showed 10.40 (a stale 4% fee); the server's 5% gives 10.50.
    await expect(buy({ expectedPay: 10.4, paySeparately: true })).rejects.toMatchObject({
      code: "PRICE_CHANGED",
      quote: { faceAmount: 10, payAmount: 10.5, customerCashback: 0, airtimeAmount: 10, feeAmount: 0.5, feeRate: 5 },
    })
  })

  it("applied path INSUFFICIENT_BALANCE reports required = payAmount", async () => {
    h.state.settings.commission_cashback_config = CASHBACK_CFG
    h.state.deductResult = []
    await expect(buy()).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", required: 9.91 })
  })
})
