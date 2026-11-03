import { describe, it, expect, vi, afterEach } from "vitest"
import {
  phoneKey, localPhone, shopSubdomainLink, renderShopTokens, hasShopTokens, parseSinceDays, sinceIso,
  loadShopBuyerAudience, loadShopBuyerCounts,
} from "./shop-buyers"

describe("phoneKey", () => {
  it("normalises every Ghana format to the last 9 digits", () => {
    for (const p of ["0241234567", "233241234567", "+233 24 123 4567", "024-123-4567"]) expect(phoneKey(p)).toBe("241234567")
    expect(phoneKey("0201234567")).toBe("201234567")
  })
  it("rejects non-mobile and short numbers", () => {
    for (const p of ["", null, undefined, "12345", "0301234567", "abc"]) expect(phoneKey(p as string)).toBeNull()
  })
  it("localPhone restores the 0 form", () => expect(localPhone("241234567")).toBe("0241234567"))
})

describe("shopSubdomainLink", () => {
  afterEach(() => vi.unstubAllEnvs())
  it("uses the datagod.store root by default", () => {
    vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "")
    expect(shopSubdomainLink("kofidata")).toBe("https://kofidata.datagod.store")
  })
  it("follows NEXT_PUBLIC_ROOT_DOMAIN", () => {
    vi.stubEnv("NEXT_PUBLIC_ROOT_DOMAIN", "Example.com")
    expect(shopSubdomainLink("kofidata")).toBe("https://kofidata.example.com")
  })
})

describe("renderShopTokens", () => {
  it("fills every token, repeatedly, and leaves other text alone", () => {
    const out = renderShopTokens("Hi! Buy at [ShopName]: [ShopLink] ([ShopName]) for [Phone]", {
      shopName: "Kofi Data", shopLink: "https://kofidata.datagod.store", phone: "0241234567",
    })
    expect(out).toBe("Hi! Buy at Kofi Data: https://kofidata.datagod.store (Kofi Data) for 0241234567")
  })
  it("never interprets $ patterns in a shop name", () => {
    expect(renderShopTokens("[ShopName]!", { shopName: "A$&B$`", shopLink: "x", phone: "y" })).toBe("A$&B$`!")
  })
  it("fills [ShopCode], and leaves it empty when the shop has no active code", () => {
    const msg = "Dial *920*44# then enter [ShopCode] to buy from [ShopName]"
    expect(renderShopTokens(msg, { shopName: "Kofi Data", shopLink: "x", phone: "y", shopCode: "1234" }))
      .toBe("Dial *920*44# then enter 1234 to buy from Kofi Data")
    expect(renderShopTokens("[ShopCode]!", { shopName: "a", shopLink: "b", phone: "c", shopCode: null })).toBe("!")
  })
  it("hasShopTokens", () => {
    expect(hasShopTokens("visit [ShopLink]")).toBe(true)
    expect(hasShopTokens("enter [ShopCode]")).toBe(true)
    expect(hasShopTokens("plain")).toBe(false)
  })
})

describe("parseSinceDays / sinceIso", () => {
  it("accepts all-time and the offered windows only", () => {
    expect(parseSinceDays(undefined)).toBeNull()
    expect(parseSinceDays("all")).toBeNull()
    expect(parseSinceDays("90")).toBe(90)
    expect(parseSinceDays(30)).toBe(30)
    expect(parseSinceDays(7)).toBe("invalid")
    expect(parseSinceDays("x")).toBe("invalid")
  })
  it("sinceIso", () => {
    expect(sinceIso(null)).toBeNull()
    expect(sinceIso(30, Date.parse("2026-11-02T00:00:00Z"))).toBe("2026-10-03T00:00:00.000Z")
  })
})

// Fake client: rpc(...).range(from,to) slices a canned result; from("user_shops" | "ussd_shop_codes") answers .in().
type CodeRow = { shop_id: string; code: string; status: string }
function fakeClient(
  rpcRows: Record<string, unknown[]>,
  shops: Array<{ id: string; shop_name: string; subdomain: string }>,
  codes: CodeRow[] = [],
) {
  const rpcCalls: Array<{ fn: string; args: unknown; from: number; to: number }> = []
  return {
    rpcCalls,
    rpc: (fn: string, args: unknown) => ({
      range: async (from: number, to: number) => {
        rpcCalls.push({ fn, args, from, to })
        return { data: (rpcRows[fn] ?? []).slice(from, to + 1), error: null }
      },
    }),
    from: (table: string) => ({
      select: () => ({
        in: async (_c: string, ids: string[]) => ({
          data: table === "ussd_shop_codes" ? codes.filter((k) => ids.includes(k.shop_id)) : shops.filter((s) => ids.includes(s.id)),
          error: null,
        }),
      }),
    }),
  }
}

describe("readers", () => {
  const shops = [
    { id: "a", shop_name: "Alpha", subdomain: "alpha" },
    { id: "b", shop_name: "Beta", subdomain: "beta" },
  ]

  it("pages the audience past PostgREST's 1000-row cap and joins shop details", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => ({ phone_key: String(240000000 + i), shop_id: i % 2 ? "a" : "b" }))
    const c = fakeClient({ shop_buyer_audience: rows }, shops)
    const out = await loadShopBuyerAudience(c as never, { shopIds: ["a", "b"], sinceDays: 90 })
    expect(out).toHaveLength(2345)
    expect(c.rpcCalls.map((x) => x.from)).toEqual([0, 1000, 2000])
    expect(out[1]).toEqual({ phone: "0240000001", shop: { id: "a", name: "Alpha", subdomain: "alpha", link: "https://alpha.datagod.store", code: null } })
    expect(c.rpcCalls[0].args).toMatchObject({ p_shop_ids: ["a", "b"] })
    expect((c.rpcCalls[0].args as { p_since: string }).p_since).toMatch(/^\d{4}-/)
  })

  it("attaches each shop's USSD code only while it is active", async () => {
    const rows = [{ phone_key: "241111111", shop_id: "a" }, { phone_key: "242222222", shop_id: "b" }]
    const c = fakeClient({ shop_buyer_audience: rows }, shops, [
      { shop_id: "a", code: "1234", status: "active" },
      { shop_id: "b", code: "5678", status: "suspended" },
    ])
    const out = await loadShopBuyerAudience(c as never, { shopIds: "all", sinceDays: null })
    expect(out.map((r) => r.shop.code)).toEqual(["1234", null])
  })

  it('"all" shops sends a null filter', async () => {
    const c = fakeClient({ shop_buyer_audience: [] }, shops)
    await loadShopBuyerAudience(c as never, { shopIds: "all", sinceDays: null })
    expect(c.rpcCalls[0].args).toEqual({ p_since: null, p_shop_ids: null })
  })

  it("counts are sorted biggest first with a total", async () => {
    const c = fakeClient({ shop_buyer_counts: [{ shop_id: "a", buyers: "3" }, { shop_id: "b", buyers: 7 }] }, shops)
    const out = await loadShopBuyerCounts(c as never, null)
    expect(out.total).toBe(10)
    expect(out.shops.map((s) => [s.name, s.buyers, s.link])).toEqual([
      ["Beta", 7, "https://beta.datagod.store"],
      ["Alpha", 3, "https://alpha.datagod.store"],
    ])
  })
})
