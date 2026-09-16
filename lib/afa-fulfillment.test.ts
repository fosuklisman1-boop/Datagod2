import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  const state = {
    priceRow: { price: "50.00" } as { price: string } | null,
    deductError: null as null | string,
    deductResult: [{ new_balance: 40, old_balance: 90, new_total_spent: 50 }] as any,
    insertedOrder: { id: "afa-1", order_code: "AFA-1234567" } as any,
    insertError: null as any,
    autoFulfillEnabled: false,
    calls: [] as Array<{ table: string; patch: any }>,
  }
  const fake = {
    from: (table: string) => {
      if (table === "afa_registration_prices") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: state.priceRow, error: null }) }) }) }) }
      }
      if (table === "afa_orders") {
        return {
          insert: () => ({ select: () => ({ single: () => Promise.resolve(state.insertError ? { data: null, error: state.insertError } : { data: state.insertedOrder, error: null }) }) }),
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
        }
      }
      if (table === "transactions") {
        return { insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }
      }
      if (table === "admin_settings") {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { value: { enabled: state.autoFulfillEnabled } }, error: null }) }) }) }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
    rpc: () => Promise.resolve(
      state.deductError
        ? { data: null, error: { message: state.deductError } }
        : state.deductResult.length === 0
          ? { data: [], error: null }
          : { data: state.deductResult, error: null }
    ),
  }
  return { state, fake }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.fake }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}), SMSTemplates: { afaRegistration: () => "msg" } }))

import { submitAfaOrder } from "./afa-fulfillment"

beforeEach(() => {
  h.state.priceRow = { price: "50.00" }
  h.state.deductError = null
  h.state.deductResult = [{ new_balance: 40, old_balance: 90, new_total_spent: 50 }]
  h.state.insertedOrder = { id: "afa-1", order_code: "AFA-1234567" }
  h.state.insertError = null
  h.state.autoFulfillEnabled = false
  h.state.calls = []
})

describe("submitAfaOrder", () => {
  const baseParams = {
    userId: "user-1", fullName: "Jane Doe", phoneNumber: "0541234567",
    ghCardNumber: "GHA-123456789-0", location: "Accra", region: "Greater Accra",
  }

  it("creates the order using the server-side price, not a client-supplied amount", async () => {
    const result = await submitAfaOrder(baseParams)
    expect(result.order.id).toBe("afa-1")
  })

  it("throws PRICE_UNAVAILABLE when no active price row exists", async () => {
    h.state.priceRow = null
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "PRICE_UNAVAILABLE" })
  })

  it("throws INSUFFICIENT_BALANCE when deduct_wallet returns no rows", async () => {
    h.state.deductResult = []
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE" })
  })

  it("throws PAYMENT_FAILED when the deduct_wallet RPC errors", async () => {
    h.state.deductError = "connection reset"
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "PAYMENT_FAILED" })
  })

  it("throws ORDER_CREATE_FAILED and refunds the wallet to its pre-deduction balance when the order insert fails", async () => {
    h.state.insertError = { message: "insert failed" }
    await expect(submitAfaOrder(baseParams)).rejects.toMatchObject({ code: "ORDER_CREATE_FAILED" })

    const refundCall = h.state.calls.find((c) => c.table === "wallets")
    expect(refundCall).toBeDefined()
    expect(refundCall!.patch.balance).toBe(90) // deductResult[0].old_balance
  })
})
