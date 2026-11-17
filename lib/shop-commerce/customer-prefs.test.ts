import { describe, expect, it, vi } from "vitest"
import {
  CustomerPrefsError,
  getCustomerShopCodeId,
  isShopMemoryEnabled,
  lastBoughtShopCodeId,
  rememberCustomerShop,
  rememberedShopForUssd,
  resolveShopCodeById,
  shortShopName,
  toLocalPhone,
} from "./customer-prefs"

type Res = { data?: unknown; error?: { message: string } | null; upsertError?: { message: string } }

// Scripted fake of the slice of supabase-js used here: each table answers every chain with its scripted result,
// and every from() call plus the upsert payload is recorded.
function fakeDb(script: Record<string, Res>) {
  const froms: string[] = []
  const upserts: { table: string; row: unknown; opts: unknown }[] = []
  const eqs: { table: string; col: string; val: unknown }[] = []
  const db = {
    from(table: string) {
      froms.push(table)
      const res = (): Res => script[table] ?? { data: null, error: null }
      const b: any = {
        select: () => b,
        eq: (col: string, val: unknown) => (eqs.push({ table, col, val }), b),
        in: () => b,
        order: () => b,
        limit: () => b,
        maybeSingle: () => Promise.resolve({ data: res().data ?? null, error: res().error ?? null }),
        upsert: (row: unknown, opts: unknown) => (upserts.push({ table, row, opts }), Promise.resolve({ data: null, error: res().upsertError ?? res().error ?? null })),
        then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve({ data: res().data ?? null, error: res().error ?? null }).then(ok, bad),
      }
      return b
    },
  }
  return { db: db as never, froms, upserts, eqs }
}

const CODE = "11111111-1111-4111-8111-111111111111"
const prefRow = (status: string, shop: Record<string, unknown>) => ({
  shop_code_id: CODE,
  ussd_shop_codes: { status, user_shops: { shop_name: "Kofi Data", ussd_display_name: null, is_active: true, is_blocked: false, ...shop } },
})
const activeResolved = { shopCodeId: CODE, shopId: "s1", shopName: "Kofi Data", parentShopId: null, status: "active", tokenBalance: 0, whatsappActivated: false }

describe("toLocalPhone", () => {
  it("normalises +233, 233 and 0 forms to local", () => {
    expect(toLocalPhone("+233241234567")).toBe("0241234567")
    expect(toLocalPhone("233241234567")).toBe("0241234567")
    expect(toLocalPhone("0241234567")).toBe("0241234567")
  })
  it("rejects junk", () => {
    expect(toLocalPhone("24123")).toBeNull()
    expect(toLocalPhone("")).toBeNull()
    expect(toLocalPhone("+447911123456")).toBeNull()
  })
})

describe("shortShopName sanitising", () => {
  it("newline becomes a space", () => expect(shortShopName("Kofi\nData")).toBe("Kofi Data"))
  it("emoji name", () => expect(shortShopName("Kofi \u{1F600} Data")).toBe("Kofi Data"))
  it("25-char name with an emoji at position 19 never splits a surrogate pair", () => {
    const n = "A".repeat(18) + "\u{1F600}" + "B".repeat(6)
    const out = shortShopName(n)
    expect(out).toBe("A".repeat(18) + " B")
    expect(/^[\x20-\x7E]+$/.test(out)).toBe(true)
  })
  it("all-emoji falls back to Shop", () => expect(shortShopName("\u{1F600}\u{1F600}")).toBe("Shop"))
})

describe("shortShopName", () => {
  it("cuts at 20 characters with no ellipsis", () => {
    expect(shortShopName("A".repeat(30))).toBe("A".repeat(20))
  })
  it("trims first", () => {
    expect(shortShopName("   Kofi   ")).toBe("Kofi")
    expect(shortShopName(" " + "B".repeat(25))).toBe("B".repeat(20))
  })
  it("leaves short names unchanged", () => {
    expect(shortShopName("Kofi Data")).toBe("Kofi Data")
  })
})

describe("getCustomerShopCodeId", () => {
  it("returns the remembered id, null when none, throws on error", async () => {
    expect(await getCustomerShopCodeId(fakeDb({ shop_customer_prefs: { data: { shop_code_id: CODE } } }).db, "+233241234567")).toBe(CODE)
    expect(await getCustomerShopCodeId(fakeDb({}).db, "0241234567")).toBeNull()
    await expect(getCustomerShopCodeId(fakeDb({ shop_customer_prefs: { error: { message: "boom" } } }).db, "0241234567")).rejects.toBeInstanceOf(CustomerPrefsError)
  })
})

describe("rememberCustomerShop", () => {
  it("upserts local phone + channel on phone", async () => {
    const f = fakeDb({})
    await rememberCustomerShop(f.db, "+233241234567", CODE, "ussd_uzo")
    expect(f.upserts).toHaveLength(1)
    expect(f.upserts[0].table).toBe("shop_customer_prefs")
    expect(f.upserts[0].row).toMatchObject({ phone: "0241234567", shop_code_id: CODE, last_channel: "ussd_uzo" })
    expect(typeof (f.upserts[0].row as any).last_used_at).toBe("string")
    expect(f.upserts[0].opts).toEqual({ onConflict: "phone" })
  })
  it("does nothing for a phone that will not normalise", async () => {
    const f = fakeDb({})
    await rememberCustomerShop(f.db, "123", CODE, "sms")
    expect(f.froms).toHaveLength(0)
  })
  it("throws CustomerPrefsError on a DB error without echoing the message", async () => {
    const f = fakeDb({ shop_customer_prefs: { error: { message: "secret 0241234567" } } })
    const e = await rememberCustomerShop(f.db, "0241234567", CODE, "sms").catch((x) => x)
    expect(e).toBeInstanceOf(CustomerPrefsError)
    expect(String(e.message)).not.toContain("0241234567")
  })
})

describe("lastBoughtShopCodeId", () => {
  it("returns the newest bought code, skipping failed/refunded rows", async () => {
    const f = fakeDb({
      ussd_shop_orders: {
        data: [
          { shop_code_id: "x", order_status: "refunded", payment_status: "completed" },
          { shop_code_id: CODE, order_status: "completed", payment_status: "completed" },
        ],
      },
    })
    expect(await lastBoughtShopCodeId(f.db, "0241234567")).toBe(CODE)
  })
  it("is null for none and throws CustomerPrefsError on error", async () => {
    expect(await lastBoughtShopCodeId(fakeDb({ ussd_shop_orders: { data: [] } }).db, "0241234567")).toBeNull()
    await expect(lastBoughtShopCodeId(fakeDb({ ussd_shop_orders: { error: { message: "x" } } }).db, "0241234567")).rejects.toBeInstanceOf(CustomerPrefsError)
  })
})

describe("resolveShopCodeById", () => {
  it("maps id to code to the lookup", async () => {
    const lookup = vi.fn(async () => activeResolved)
    const f = fakeDb({ ussd_shop_codes: { data: { code: "KOFI" } } })
    expect(await resolveShopCodeById(f.db, CODE, lookup)).toBe(activeResolved)
    expect(lookup).toHaveBeenCalledWith("KOFI")
  })
  it("is null when the id is gone or errors", async () => {
    const lookup = vi.fn()
    expect(await resolveShopCodeById(fakeDb({}).db, CODE, lookup)).toBeNull()
    expect(await resolveShopCodeById(fakeDb({ ussd_shop_codes: { error: { message: "x" } } }).db, CODE, lookup)).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("rememberedShopForUssd", () => {
  it("(a) active pref gives the shop with exactly one from()", async () => {
    const f = fakeDb({ shop_customer_prefs: { data: prefRow("active", { ussd_display_name: "Kofi Express" }) } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toEqual({ shopCodeId: CODE, shopName: "Kofi Express" })
    expect(f.froms).toEqual(["shop_customer_prefs"])
  })
  it("(a) falls back to shop_name when there is no display name", async () => {
    const f = fakeDb({ shop_customer_prefs: { data: prefRow("active", {}) } })
    expect((await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel"))?.shopName).toBe("Kofi Data")
  })
  it("(b) a blocked shop gives null and the last purchase is not checked", async () => {
    const f = fakeDb({ shop_customer_prefs: { data: prefRow("active", { is_blocked: true }) } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toBeNull()
    expect(f.froms).not.toContain("ussd_shop_orders")
  })
  it("(b) an inactive shop gives null", async () => {
    const f = fakeDb({ shop_customer_prefs: { data: prefRow("active", { is_active: false }) } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toBeNull()
  })
  it("(c) a suspended code gives null", async () => {
    const f = fakeDb({ shop_customer_prefs: { data: prefRow("suspended", {}) } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toBeNull()
    expect(f.froms).not.toContain("ussd_shop_orders")
  })
  it("(d) no pref but an active last purchase gives that shop and seeds the pref once", async () => {
    const f = fakeDb({
      ussd_shop_orders: { data: [{ shop_code_id: CODE, order_status: "completed", payment_status: "completed" }] },
      ussd_shop_codes: { data: { code: "KOFI" } },
    })
    const lookup = vi.fn(async () => activeResolved)
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_uzo", lookup)).toEqual({ shopCodeId: CODE, shopName: "Kofi Data" })
    expect(f.upserts).toHaveLength(1)
    expect(f.upserts[0].row).toMatchObject({ phone: "0241234567", shop_code_id: CODE, last_channel: "ussd_uzo" })
  })
  it("(d) a failed seed does not lose the answer", async () => {
    const f = fakeDb({
      ussd_shop_orders: { data: [{ shop_code_id: CODE, order_status: "completed", payment_status: "completed" }] },
      ussd_shop_codes: { data: { code: "KOFI" } },
    })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const g = fakeDb({
      ussd_shop_orders: { data: [{ shop_code_id: CODE, order_status: "completed", payment_status: "completed" }] },
      ussd_shop_codes: { data: { code: "KOFI" } },
      shop_customer_prefs: { upsertError: { message: "nope 0241234567" } },
    })
    expect(await rememberedShopForUssd(g.db, "0241234567", "ussd_uzo", async () => activeResolved)).toEqual({ shopCodeId: CODE, shopName: "Kofi Data" })
    expect(JSON.stringify(spy.mock.calls)).not.toContain("0241234567")
    spy.mockRestore()
  })
  it("(d) a last purchase that resolves inactive gives null and seeds nothing", async () => {
    const f = fakeDb({
      ussd_shop_orders: { data: [{ shop_code_id: CODE, order_status: "completed", payment_status: "completed" }] },
      ussd_shop_codes: { data: { code: "KOFI" } },
    })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_uzo", async () => ({ ...activeResolved, status: "suspended" }))).toBeNull()
    expect(f.upserts).toHaveLength(0)
  })
  it("(e) no pref and no purchase gives null", async () => {
    const f = fakeDb({ ussd_shop_orders: { data: [] } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toBeNull()
  })
  it("(f) a DB error gives null without throwing or logging the phone", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const f = fakeDb({ shop_customer_prefs: { error: { message: "down 0241234567" } } })
    expect(await rememberedShopForUssd(f.db, "0241234567", "ussd_hubtel")).toBeNull()
    expect(JSON.stringify(spy.mock.calls)).not.toContain("0241234567")
    spy.mockRestore()
  })
  it("an unusable phone gives null with no queries", async () => {
    const f = fakeDb({})
    expect(await rememberedShopForUssd(f.db, "abc", "ussd_hubtel")).toBeNull()
    expect(f.froms).toHaveLength(0)
  })
})

describe("isShopMemoryEnabled", () => {
  it("true only for {enabled:true}", async () => {
    expect(await isShopMemoryEnabled(fakeDb({ admin_settings: { data: { value: { enabled: true } } } }).db)).toBe(true)
  })
  it("false for a missing row, a string true, or a read error", async () => {
    expect(await isShopMemoryEnabled(fakeDb({}).db)).toBe(false)
    expect(await isShopMemoryEnabled(fakeDb({ admin_settings: { data: { value: { enabled: "true" } } } }).db)).toBe(false)
    expect(await isShopMemoryEnabled(fakeDb({ admin_settings: { error: { message: "x" } } }).db)).toBe(false)
  })
  it("reads the ussd_shop_memory_enabled key", async () => {
    const f = fakeDb({ admin_settings: { data: { value: { enabled: true } } } })
    await isShopMemoryEnabled(f.db)
    expect(f.eqs).toContainEqual({ table: "admin_settings", col: "key", val: "ussd_shop_memory_enabled" })
  })
})
