import { describe, it, expect } from "vitest"
import { createSubAgentShop, makeShopSlug, ensureWallet } from "./create-shop"

type Call = { table: string; op: string; payload?: any }

function fakeDb(opts: { insertError?: { code: string } | null; existingShop?: any } = {}) {
  const calls: Call[] = []
  const db: any = {
    from(table: string) {
      const ctx: any = { table, op: "", payload: undefined, filters: [] as any[] }
      const chain: any = {
        insert(payload: any) { ctx.op = "insert"; ctx.payload = payload; calls.push({ table, op: "insert", payload }); return chain },
        select() {
          if (!ctx.op) ctx.op = "select"
          return chain
        },
        eq(col: string, val: any) { ctx.filters.push([col, val]); return chain },
        async single() {
          if (table === "user_shops" && ctx.op === "insert") {
            if (opts.insertError) return { data: null, error: opts.insertError }
            return { data: { id: "new-shop", shop_slug: ctx.payload.shop_slug }, error: null }
          }
          return { data: null, error: null }
        },
        async maybeSingle() {
          calls.push({ table, op: "select-existing" })
          return { data: opts.existingShop ?? null, error: null }
        },
        then(resolve: any) {
          if (table === "shop_packages" && ctx.op === "select") {
            return resolve({ data: [{ package_id: "p1" }, { package_id: "p1" }, { package_id: "p2" }], error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return chain
    },
  }
  return { db, calls }
}

const base = {
  userId: "u1",
  parent: { id: "parent", shop_name: "Parent", tier_level: 1 },
  shopName: "Kofi Data",
  shopSlug: "kofi-data",
  dealerRatesEnabled: true,
}

describe("createSubAgentShop", () => {
  it("storefront: closed shop, joined_via set, no shop_packages writes", async () => {
    const { db, calls } = fakeDb()
    const r = await createSubAgentShop(db, { ...base, via: "storefront" })
    expect(r).toEqual({ shopId: "new-shop", slug: "kofi-data", created: true })
    const ins = calls.find(c => c.table === "user_shops" && c.op === "insert")!
    expect(ins.payload).toMatchObject({
      user_id: "u1", parent_shop_id: "parent", tier_level: 2,
      is_active: false, joined_via: "storefront", dealer_rates_enabled: true,
    })
    expect(calls.some(c => c.table === "shop_packages")).toBe(false)
  })

  it("invite: active shop, joined_via null, copies parent packages once each", async () => {
    const { db, calls } = fakeDb()
    const r = await createSubAgentShop(db, { ...base, via: "invite", dealerRatesEnabled: false })
    expect(r.created).toBe(true)
    const ins = calls.find(c => c.table === "user_shops" && c.op === "insert")!
    expect(ins.payload).toMatchObject({ is_active: true, joined_via: null, dealer_rates_enabled: false })
    const pk = calls.find(c => c.table === "shop_packages" && c.op === "insert")!
    expect(pk.payload).toEqual([
      { shop_id: "new-shop", package_id: "p1", profit_margin: 0, is_available: true },
      { shop_id: "new-shop", package_id: "p2", profit_margin: 0, is_available: true },
    ])
  })

  it("duplicate user_id returns the existing shop, created false, nothing else written", async () => {
    const { db, calls } = fakeDb({
      insertError: { code: "23505" },
      existingShop: { id: "old-shop", shop_slug: "old-slug" },
    })
    const r = await createSubAgentShop(db, { ...base, via: "invite" })
    expect(r).toEqual({ shopId: "old-shop", slug: "old-slug", created: false })
    expect(calls.filter(c => c.op === "insert").length).toBe(1)
    expect(calls.some(c => c.table === "shop_packages")).toBe(false)
  })

  it("slug collision (23505 but user has no shop) throws", async () => {
    const { db } = fakeDb({ insertError: { code: "23505" }, existingShop: null })
    await expect(createSubAgentShop(db, { ...base, via: "storefront" })).rejects.toThrow(/slug/i)
  })

  it("other insert errors throw", async () => {
    const { db } = fakeDb({ insertError: { code: "XX000" } })
    await expect(createSubAgentShop(db, { ...base, via: "storefront" })).rejects.toBeTruthy()
  })
})

function walletDb(error: any) {
  const inserts: any[] = []
  const db: any = {
    from: (t: string) => ({
      insert: async (p: any) => { inserts.push({ t, p }); return { error } },
    }),
  }
  return { db, inserts }
}

describe("ensureWallet", () => {
  it("inserts a zero-balance wallet", async () => {
    const { db, inserts } = walletDb(null)
    await ensureWallet(db, "u1")
    expect(inserts[0].t).toBe("wallets")
    expect(inserts[0].p).toMatchObject({ user_id: "u1", balance: 0, total_credited: 0, total_spent: 0 })
  })
  it("treats a unique violation as success (wallet exists)", async () => {
    const { db } = walletDb({ code: "23505", message: "dup" })
    await expect(ensureWallet(db, "u1")).resolves.toBeUndefined()
  })
  it("throws on other errors", async () => {
    const { db } = walletDb({ code: "XX000", message: "boom" })
    await expect(ensureWallet(db, "u1")).rejects.toBeTruthy()
  })
})

describe("makeShopSlug", () => {
  it("slugifies the name and adds a 4-char suffix", () => {
    expect(makeShopSlug("Kofi's Data Hub!")).toMatch(/^kofi-s-data-hub-[a-z0-9]{4}$/)
  })
  it("falls back for empty names", () => {
    expect(makeShopSlug("!!!")).toMatch(/^shop-[a-z0-9]{4}$/)
  })
})
