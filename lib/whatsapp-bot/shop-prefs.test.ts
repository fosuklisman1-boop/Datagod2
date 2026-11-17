import { describe, it, expect, vi, beforeEach } from "vitest"
import * as shopPrefs from "@/lib/whatsapp-bot/shop-prefs"
import { getShopPref, setShopPref } from "@/lib/whatsapp-bot/shop-prefs"

const fakeDb = vi.hoisted(() => ({
  rows: new Map<string, { shop_code_id: string; last_channel?: string }>(),
  tables: [] as string[],
  readError: false,
  writeError: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      fakeDb.tables.push(table)
      if (table !== "shop_customer_prefs") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_col: string, phone: string) => ({
            maybeSingle: () => Promise.resolve(
              fakeDb.readError
                ? { data: null, error: { message: "boom" } }
                : { data: fakeDb.rows.has(phone) ? { shop_code_id: fakeDb.rows.get(phone)!.shop_code_id } : null, error: null }
            ),
          }),
        }),
        upsert: (row: { phone: string; shop_code_id: string; last_channel: string }) => {
          if (fakeDb.writeError) return Promise.resolve({ error: { message: "boom" } })
          fakeDb.rows.set(row.phone, { shop_code_id: row.shop_code_id, last_channel: row.last_channel })
          return Promise.resolve({ error: null })
        },
      }
    },
  }),
}))

describe("shop-prefs (shared shop_customer_prefs)", () => {
  beforeEach(() => {
    fakeDb.rows.clear()
    fakeDb.tables.length = 0
    fakeDb.readError = false
    fakeDb.writeError = false
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("setShopPref writes the local phone with channel whatsapp", async () => {
    await setShopPref("233241234567", "shop-code-1")
    expect(fakeDb.rows.get("0241234567")).toEqual({ shop_code_id: "shop-code-1", last_channel: "whatsapp" })
    expect(fakeDb.tables).toEqual(["shop_customer_prefs"])
  })

  it("getShopPref reads by local phone", async () => {
    fakeDb.rows.set("0241234567", { shop_code_id: "shop-code-9" })
    expect(await getShopPref("233241234567")).toEqual({ shopCodeId: "shop-code-9" })
  })

  it("returns null when no pref exists", async () => {
    expect(await getShopPref("233241234567")).toBeNull()
  })

  it("getShopPref returns null on a read error", async () => {
    fakeDb.readError = true
    expect(await getShopPref("233241234567")).toBeNull()
  })

  it("setShopPref does not throw when the write fails", async () => {
    fakeDb.writeError = true
    await expect(setShopPref("233241234567", "shop-code-1")).resolves.toBeUndefined()
  })

  it("never deletes: clearShopPref is not exported", () => {
    expect((shopPrefs as Record<string, unknown>).clearShopPref).toBeUndefined()
  })
})
