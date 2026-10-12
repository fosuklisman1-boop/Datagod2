// lib/ussd-hubtel/billing-guard.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { dbShopBillingGuard } from "./billing-guard"

/** Fake of the two calls the guard makes: insert (PK on session_id+shop_code_id) and delete().eq().eq(). */
function fakeDb(opts: { insertError?: { code?: string; message: string }; insertThrows?: boolean } = {}) {
  const rows = new Set<string>()
  const deletes: Array<Record<string, string>> = []
  const client = {
    from: (table: string) => {
      expect(table).toBe("hubtel_shop_billing_claims")
      return {
        insert: async (row: { session_id: string; shop_code_id: string }) => {
          if (opts.insertThrows) throw new Error("network down")
          if (opts.insertError) return { error: opts.insertError }
          const k = `${row.session_id}:${row.shop_code_id}`
          if (rows.has(k)) return { error: { code: "23505", message: "duplicate key" } }
          rows.add(k)
          return { error: null }
        },
        delete: () => {
          const filter: Record<string, string> = {}
          const chain = {
            eq: (col: string, val: string) => {
              filter[col] = val
              if (Object.keys(filter).length === 2) {
                deletes.push({ ...filter })
                rows.delete(`${filter.session_id}:${filter.shop_code_id}`)
                return Promise.resolve({ error: null })
              }
              return chain
            },
          }
          return chain
        },
      }
    },
  }
  return { client: client as unknown as SupabaseClient, rows, deletes }
}

describe("dbShopBillingGuard", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}) })

  it("first claim per (session, code) is 'claimed', a repeat is 'already'", async () => {
    const { client } = fakeDb()
    const g = dbShopBillingGuard(client)
    expect(await g.claim("S1", "c1")).toBe("claimed")
    expect(await g.claim("S1", "c1")).toBe("already")
    expect(await g.claim("S1", "c2")).toBe("claimed")
    expect(await g.claim("S2", "c1")).toBe("claimed")
  })
  it("release frees the pair so a later attempt can claim again", async () => {
    const { client, deletes } = fakeDb()
    const g = dbShopBillingGuard(client)
    await g.claim("S1", "c1")
    await g.release("S1", "c1")
    expect(deletes).toEqual([{ session_id: "S1", shop_code_id: "c1" }])
    expect(await g.claim("S1", "c1")).toBe("claimed")
  })
  it("any other DB error (e.g. table missing) is 'error': never deduct unguarded", async () => {
    const { client } = fakeDb({ insertError: { code: "42P01", message: "relation does not exist" } })
    expect(await dbShopBillingGuard(client).claim("S1", "c1")).toBe("error")
  })
  it("a thrown insert is 'error'", async () => {
    const { client } = fakeDb({ insertThrows: true })
    expect(await dbShopBillingGuard(client).claim("S1", "c1")).toBe("error")
  })
})
