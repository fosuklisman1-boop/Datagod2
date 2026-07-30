import { describe, it, expect, vi, beforeEach } from "vitest"
import { getShopPref, setShopPref, clearShopPref } from "@/lib/whatsapp-bot/shop-prefs"

const fakeDb = vi.hoisted(() => ({
  rows: new Map<string, { shop_code_id: string; last_used_at: string }>(),
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      if (table !== "wa_shop_customer_prefs") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, phone: string) => ({
            maybeSingle: () => Promise.resolve({
              data: fakeDb.rows.has(phone) ? { shop_code_id: fakeDb.rows.get(phone)!.shop_code_id } : null,
            }),
          }),
        }),
        upsert: (row: { phone: string; shop_code_id: string; last_used_at: string }) => {
          fakeDb.rows.set(row.phone, { shop_code_id: row.shop_code_id, last_used_at: row.last_used_at })
          return Promise.resolve({ error: null })
        },
        delete: () => ({
          eq: (_col: string, phone: string) => {
            fakeDb.rows.delete(phone)
            return Promise.resolve({ error: null })
          },
        }),
      }
    },
  }),
}))

describe("shop-prefs", () => {
  beforeEach(() => { fakeDb.rows.clear() })

  it("returns null when no pref exists", async () => {
    expect(await getShopPref("233559919037")).toBeNull()
  })

  it("round-trips a set pref", async () => {
    await setShopPref("233559919037", "shop-code-1")
    expect(await getShopPref("233559919037")).toEqual({ shopCodeId: "shop-code-1" })
  })

  it("overwrites an existing pref on re-set", async () => {
    await setShopPref("233559919037", "shop-code-1")
    await setShopPref("233559919037", "shop-code-2")
    expect(await getShopPref("233559919037")).toEqual({ shopCodeId: "shop-code-2" })
  })

  it("clears a pref", async () => {
    await setShopPref("233559919037", "shop-code-1")
    await clearShopPref("233559919037")
    expect(await getShopPref("233559919037")).toBeNull()
  })
})
