import { describe, it, expect } from "vitest"
import { createShopBundleOrder, createShopAirtimeOrder, createShopRcOrder } from "./orders"

// Fake Supabase client that captures the exact payload passed to `.insert(...)`
// so tests can assert the `channel` tag flows through correctly, plus the
// `.select("id").single()` chain the real handlers use. Mirrors the
// makeChain/fakeClient idiom from pricing.test.ts / shop-code.test.ts.
function makeInsertChain(result: { data: unknown; error?: unknown }, captured: { payload?: any }) {
  const chain: any = {
    insert: (payload: any) => {
      captured.payload = Array.isArray(payload) ? payload[0] : payload
      return chain
    },
    select: () => chain,
    single: () => Promise.resolve(result),
  }
  return chain
}

function fakeInsertClient(expectedTable: string, result: { data: unknown; error?: unknown }) {
  const captured: { payload?: any } = {}
  const client = {
    from: (table: string) => {
      if (table !== expectedTable) {
        throw new Error(`Unexpected table "${table}", expected "${expectedTable}"`)
      }
      return makeInsertChain(result, captured)
    },
  } as any
  return { client, captured }
}

describe("createShopBundleOrder", () => {
  const baseInput = {
    shopCodeId: "sc1",
    shopId: "s1",
    parentShopId: null,
    dialingPhone: "0241234567",
    recipientPhone: "0247654321",
    network: "MTN",
    paystackProvider: "mtn",
    bundleId: "b1",
    bundleSize: "2GB",
    verifiedPrice: 10,
    profitAmount: 2,
    parentProfitAmount: 0,
    chargeAmount: 10.3,
    shopName: "Test Shop",
    customerEmail: "cust@example.com",
    shopOwnerEmail: "owner@example.com",
  }

  it("tags the insert payload with channel: 'whatsapp_shop' and returns the new order id", async () => {
    const { client, captured } = fakeInsertClient("ussd_shop_orders", { data: { id: "order1" }, error: null })

    const result = await createShopBundleOrder({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ orderId: "order1" })
    expect(captured.payload).toMatchObject({
      shop_code_id: "sc1",
      shop_id: "s1",
      dialing_phone: "0241234567",
      recipient_phone: "0247654321",
      network: "MTN",
      paystack_provider: "mtn",
      package_id: "b1",
      package_size: "2GB",
      amount: 10.3,
      shop_price: 10,
      profit_amount: 2,
      parent_shop_id: null,
      parent_profit_amount: 0,
      shop_name: "Test Shop",
      customer_email: "cust@example.com",
      shop_owner_email: "owner@example.com",
      order_status: "pending",
      payment_status: "pending",
      channel: "whatsapp_shop",
    })
  })

  it("tags the insert payload with channel: 'ussd_shop'", async () => {
    const { client, captured } = fakeInsertClient("ussd_shop_orders", { data: { id: "order2" }, error: null })

    const result = await createShopBundleOrder({ ...baseInput, channel: "ussd_shop" }, client)

    expect(result).toEqual({ orderId: "order2" })
    expect(captured.payload.channel).toBe("ussd_shop")
  })

  it("returns { error } instead of throwing when the insert fails", async () => {
    const { client } = fakeInsertClient("ussd_shop_orders", { data: null, error: { message: "insert failed" } })

    const result = await createShopBundleOrder({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ error: "insert failed" })
  })
})

describe("createShopAirtimeOrder", () => {
  const baseInput = {
    referenceCode: "AT12345",
    network: "MTN",
    beneficiaryPhone: "0241234567",
    airtimeAmount: 9.5,
    feeAmount: 0.5,
    totalPaid: 10,
    shopId: "s1",
    merchantCommission: 0.3,
    dialingPhone: "0241234567",
  }

  it("tags the insert payload with channel: 'whatsapp_shop' and returns the new order id", async () => {
    const { client, captured } = fakeInsertClient("airtime_orders", { data: { id: "at1" }, error: null })

    const result = await createShopAirtimeOrder({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ orderId: "at1" })
    expect(captured.payload).toMatchObject({
      reference_code: "AT12345",
      network: "MTN",
      beneficiary_phone: "0241234567",
      airtime_amount: 9.5,
      fee_amount: 0.5,
      total_paid: 10,
      pay_separately: false,
      status: "pending_payment",
      payment_status: "pending_payment",
      user_id: null,
      shop_id: "s1",
      merchant_commission: 0.3,
      customer_name: "USSD Customer",
      customer_email: null,
      dialing_phone: "0241234567",
      channel: "whatsapp_shop",
    })
  })

  it("tags the insert payload with channel: 'ussd_shop'", async () => {
    const { client, captured } = fakeInsertClient("airtime_orders", { data: { id: "at2" }, error: null })

    const result = await createShopAirtimeOrder({ ...baseInput, channel: "ussd_shop" }, client)

    expect(result).toEqual({ orderId: "at2" })
    expect(captured.payload.channel).toBe("ussd_shop")
  })

  it("returns { error } instead of throwing when the insert fails", async () => {
    const { client } = fakeInsertClient("airtime_orders", { data: null, error: { message: "insert failed" } })

    const result = await createShopAirtimeOrder({ ...baseInput, channel: "ussd_shop" }, client)

    expect(result).toEqual({ error: "insert failed" })
  })
})

describe("createShopRcOrder", () => {
  const baseInput = {
    referenceCode: "RC12345",
    examBoard: "WASSCE",
    quantity: 2,
    customerPhone: "0241234567",
    unitPrice: 20,
    totalPaid: 40,
    shopId: "s1",
    merchantCommission: 2,
    dialingPhone: "0241234567",
  }

  it("tags the insert payload with channel: 'whatsapp_shop' and returns the new order id", async () => {
    const { client, captured } = fakeInsertClient("results_checker_orders", { data: { id: "rc1" }, error: null })

    const result = await createShopRcOrder({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ orderId: "rc1" })
    expect(captured.payload).toMatchObject({
      reference_code: "RC12345",
      exam_board: "WASSCE",
      quantity: 2,
      customer_name: "USSD Customer",
      customer_email: null,
      customer_phone: "0241234567",
      unit_price: 20,
      fee_amount: 0,
      total_paid: 40,
      shop_id: "s1",
      merchant_commission: 2,
      status: "pending_payment",
      payment_status: "pending_payment",
      dialing_phone: "0241234567",
      channel: "whatsapp_shop",
    })
  })

  it("tags the insert payload with channel: 'ussd_shop'", async () => {
    const { client, captured } = fakeInsertClient("results_checker_orders", { data: { id: "rc2" }, error: null })

    const result = await createShopRcOrder({ ...baseInput, channel: "ussd_shop" }, client)

    expect(result).toEqual({ orderId: "rc2" })
    expect(captured.payload.channel).toBe("ussd_shop")
  })

  it("returns { error } instead of throwing when the insert fails", async () => {
    const { client } = fakeInsertClient("results_checker_orders", { data: null, error: { message: "insert failed" } })

    const result = await createShopRcOrder({ ...baseInput, channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ error: "insert failed" })
  })
})
