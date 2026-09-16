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
    calls: [] as Array<{ table: string; patch: any }>,
  }

  const fake = {
    from: (table: string) => {
      if (table === "admin_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              single: () => Promise.resolve({ data: { value: state.settings[key] ?? null }, error: null }),
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
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve(
                state.insertError
                  ? { data: null, error: state.insertError }
                  : { data: state.insertedOrder, error: null }
              ),
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
          insert: () => Promise.resolve({ data: null, error: null }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: (fn: string) => {
      if (fn === "deduct_wallet") {
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

import { purchaseAirtime } from "./airtime-service"

beforeEach(() => {
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
      userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10,
    })
    expect(result.order.id).toBe("order-1")
    expect(result.newBalance).toBe(88)
  })

  it("throws NETWORK_DISABLED when the network is disabled", async () => {
    h.state.settings.airtime_enabled_mtn = { enabled: false }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "NETWORK_DISABLED" })
  })

  it("throws INSUFFICIENT_BALANCE when deduct_wallet returns no rows", async () => {
    h.state.deductResult = []
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" })
  })

  it("throws DUPLICATE_REQUEST when an identical order was placed in the last 30s", async () => {
    h.state.recentOrder = { id: "prev", reference_code: "AT-XXX-YYY" }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "DUPLICATE_REQUEST" })
  })

  it("throws PAYMENT_FAILED when the deduct_wallet RPC errors", async () => {
    h.state.deductError = "connection reset"
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "PAYMENT_FAILED" })
  })

  it("throws ORDER_CREATE_FAILED and refunds the wallet to its pre-deduction balance when the order insert fails", async () => {
    h.state.insertError = { message: "insert failed" }
    await expect(
      purchaseAirtime({ userId: "user-1", network: "MTN", beneficiaryPhone: "0541234567", airtimeAmount: 10 })
    ).rejects.toMatchObject({ code: "ORDER_CREATE_FAILED" })

    const refundCall = h.state.calls.find((c) => c.table === "wallets")
    expect(refundCall).toBeDefined()
    expect(refundCall!.patch.balance).toBe(100) // deductResult[0].old_balance
  })
})
