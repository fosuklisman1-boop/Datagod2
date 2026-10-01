import { describe, it, expect } from "vitest"
import { resolveShopCode, getCanonicalShopName } from "./shop-code"

// Fake Supabase client injected directly into resolveShopCode (no @supabase/supabase-js
// mocking needed — the function accepts an optional client param for exactly this reason).
// Mirrors the makeChain/fakeClient idiom from lib/shop-commerce/pricing.test.ts.
function makeChain(result: { data: unknown; error?: unknown }) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  }
  return chain
}

function fakeClient(tables: Record<string, { data: unknown; error?: unknown }>) {
  return {
    from: (table: string) => makeChain(tables[table] ?? { data: null, error: null }),
  } as any
}

describe("resolveShopCode", () => {
  it("returns null when the code is not found", async () => {
    const client = fakeClient({
      ussd_shop_codes: { data: null },
    })

    const result = await resolveShopCode("NOPE", client)
    expect(result).toBeNull()
  })

  it("resolves a known active code with tokens to the full shape, with whatsappActivated false when the column is false", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc1", shop_id: "s1", status: "active", token_balance: 5, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "Test Shop", parent_shop_id: null },
      },
    })

    const result = await resolveShopCode("ABC123", client)

    expect(result).toEqual({
      shopCodeId: "sc1",
      shopId: "s1",
      shopName: "Test Shop",
      parentShopId: null,
      status: "active",
      tokenBalance: 5,
      whatsappActivated: false,
    })
  })

  it("resolves a known active code with tokens to the full shape, with whatsappActivated true when the column is true", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc4", shop_id: "s4", status: "active", token_balance: 2, whatsapp_activated: true },
      },
      user_shops: {
        data: { shop_name: "Activated Shop", parent_shop_id: null },
      },
    })

    const result = await resolveShopCode("ACT123", client)

    expect(result).toEqual({
      shopCodeId: "sc4",
      shopId: "s4",
      shopName: "Activated Shop",
      parentShopId: null,
      status: "active",
      tokenBalance: 2,
      whatsappActivated: true,
    })
  })

  it("resolves a sub-agent shop's parentShopId from user_shops", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc2", shop_id: "s2", status: "active", token_balance: 3, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "Sub Shop", parent_shop_id: "parent1" },
      },
    })

    const result = await resolveShopCode("SUB456", client)
    expect(result?.parentShopId).toBe("parent1")
  })

  it("still resolves an inactive code — status gating is the caller's job, not this function's", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc3", shop_id: "s3", status: "suspended", token_balance: 0, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "Suspended Shop", parent_shop_id: null },
      },
    })

    const result = await resolveShopCode("OLD789", client)

    expect(result).toEqual({
      shopCodeId: "sc3",
      shopId: "s3",
      shopName: "Suspended Shop",
      parentShopId: null,
      status: "suspended",
      tokenBalance: 0,
      whatsappActivated: false,
    })
  })

  it("prefers ussd_display_name over shop_name when it is set", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc5", shop_id: "s5", status: "active", token_balance: 1, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "MTN Data Direct", parent_shop_id: null, ussd_display_name: "Kwame Mobile" },
      },
    })

    const result = await resolveShopCode("DISP01", client)
    expect(result?.shopName).toBe("Kwame Mobile")
  })

  it("falls back to shop_name when ussd_display_name is null", async () => {
    const client = fakeClient({
      ussd_shop_codes: {
        data: { id: "sc6", shop_id: "s6", status: "active", token_balance: 1, whatsapp_activated: false },
      },
      user_shops: {
        data: { shop_name: "Test Shop", parent_shop_id: null, ussd_display_name: null },
      },
    })

    const result = await resolveShopCode("DISP02", client)
    expect(result?.shopName).toBe("Test Shop")
  })

  it("trims the input code before looking it up", async () => {
    const eqCalls: unknown[][] = []
    const client = {
      from: (table: string) => {
        if (table === "ussd_shop_codes") {
          return {
            select: () => ({
              eq: (...args: unknown[]) => {
                eqCalls.push(args)
                return { maybeSingle: () => Promise.resolve({ data: null }) }
              },
            }),
          }
        }
        return makeChain({ data: null })
      },
    } as any

    await resolveShopCode("  ABC123  ", client)
    expect(eqCalls).toEqual([["code", "ABC123"]])
  })
})

describe("getCanonicalShopName", () => {
  it("returns the real shop_name for the given shop id, ignoring ussd_display_name", async () => {
    const client = fakeClient({
      user_shops: { data: { shop_name: "MTN Data Direct" } },
    })

    const result = await getCanonicalShopName("s5", client)
    expect(result).toBe("MTN Data Direct")
  })

  it("falls back to 'Shop' when the row isn't found", async () => {
    const client = fakeClient({
      user_shops: { data: null },
    })

    const result = await getCanonicalShopName("missing", client)
    expect(result).toBe("Shop")
  })
})
