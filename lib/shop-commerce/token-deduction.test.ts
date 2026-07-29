import { describe, it, expect } from "vitest"
import { deductTokenIfWhatsappShopOrder } from "./token-deduction"

// Fake Supabase client for the ussd_shop_codes lookup (shop_id -> shop_code_id)
// plus the deduct_ussd_shop_token RPC. Mirrors the makeChain/fakeClient idiom
// used elsewhere in lib/shop-commerce/*.test.ts.
function makeClient(opts: {
  shopCodeByShopId?: Record<string, string | null>
  shopCodeLookupError?: string
  rpcError?: string
} = {}) {
  const calls: { op: string; table?: string; args?: any }[] = []

  const client = {
    from: (table: string) => {
      if (table !== "ussd_shop_codes") throw new Error(`Unexpected table: ${table}`)
      return {
        select: (cols: string) => ({
          eq: (col: string, val: string) => ({
            maybeSingle: () => {
              calls.push({ op: "select", table, args: { cols, col, val } })
              if (opts.shopCodeLookupError) {
                return Promise.resolve({ data: null, error: { message: opts.shopCodeLookupError } })
              }
              const id = opts.shopCodeByShopId?.[val]
              if (id === undefined) return Promise.resolve({ data: null, error: null })
              return Promise.resolve({ data: id ? { id } : null, error: null })
            },
          }),
        }),
      }
    },
    rpc: (fn: string, args: any) => {
      calls.push({ op: "rpc", args: { fn, ...args } })
      if (opts.rpcError) return Promise.resolve({ data: null, error: { message: opts.rpcError } })
      return Promise.resolve({ data: true, error: null })
    },
  } as any

  return { client, calls }
}

describe("deductTokenIfWhatsappShopOrder", () => {
  it("does nothing for a ussd_shop order (USSD already deducted at session entry)", async () => {
    const { client, calls } = makeClient()

    const result = await deductTokenIfWhatsappShopOrder({ channel: "ussd_shop", shop_code_id: "sc1" }, client)

    expect(result).toEqual({ deducted: false, reason: "not_whatsapp_shop" })
    expect(calls).toHaveLength(0)
  })

  it("does nothing for an order with no channel set (legacy/other flows)", async () => {
    const { client, calls } = makeClient()

    const result = await deductTokenIfWhatsappShopOrder({ shop_code_id: "sc1" }, client)

    expect(result).toEqual({ deducted: false, reason: "not_whatsapp_shop" })
    expect(calls).toHaveLength(0)
  })

  it("deducts exactly one token via shop_code_id when present directly (ussd_shop_orders shape)", async () => {
    const { client, calls } = makeClient()

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop", shop_code_id: "sc1" }, client)

    expect(result).toEqual({ deducted: true })
    expect(calls).toEqual([{ op: "rpc", args: { fn: "deduct_ussd_shop_token", p_shop_code_id: "sc1" } }])
  })

  it("resolves shop_code_id via shop_id when the order has no shop_code_id column (airtime_orders/results_checker_orders shape)", async () => {
    const { client, calls } = makeClient({ shopCodeByShopId: { s1: "sc1" } })

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop", shop_id: "s1" }, client)

    expect(result).toEqual({ deducted: true })
    expect(calls.find(c => c.op === "rpc")).toMatchObject({ args: { fn: "deduct_ussd_shop_token", p_shop_code_id: "sc1" } })
  })

  it("prefers shop_code_id over shop_id when both are present", async () => {
    const { client, calls } = makeClient({ shopCodeByShopId: { s1: "sc-wrong" } })

    const result = await deductTokenIfWhatsappShopOrder(
      { channel: "whatsapp_shop", shop_code_id: "sc1", shop_id: "s1" },
      client
    )

    expect(result).toEqual({ deducted: true })
    // No ussd_shop_codes lookup at all — shop_code_id short-circuits it.
    expect(calls).toEqual([{ op: "rpc", args: { fn: "deduct_ussd_shop_token", p_shop_code_id: "sc1" } }])
  })

  it("fails gracefully with neither shop_code_id nor shop_id, without calling the RPC", async () => {
    const { client, calls } = makeClient()

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop" }, client)

    expect(result).toEqual({ deducted: false, reason: "missing_shop_reference" })
    expect(calls).toHaveLength(0)
  })

  it("reports shop_code_lookup_failed when the shop_id has no matching ussd_shop_codes row", async () => {
    const { client, calls } = makeClient({ shopCodeByShopId: { s1: null } })

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop", shop_id: "s1" }, client)

    expect(result).toMatchObject({ deducted: false, reason: "shop_code_lookup_failed" })
    expect(calls.some(c => c.op === "rpc")).toBe(false)
  })

  it("reports shop_code_lookup_failed when the ussd_shop_codes query itself errors", async () => {
    const { client } = makeClient({ shopCodeLookupError: "connection reset" })

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop", shop_id: "s1" }, client)

    expect(result).toEqual({ deducted: false, reason: "shop_code_lookup_failed", error: "connection reset" })
  })

  it("surfaces an rpc_error without throwing when the deduct RPC fails", async () => {
    const { client } = makeClient({ rpcError: "db down" })

    const result = await deductTokenIfWhatsappShopOrder({ channel: "whatsapp_shop", shop_code_id: "sc1" }, client)

    expect(result).toEqual({ deducted: false, reason: "rpc_error", error: "db down" })
  })
})
