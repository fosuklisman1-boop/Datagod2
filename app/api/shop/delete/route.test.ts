import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  joinedVia: null as string | null,
  roleUpdates: [] as { payload: any; filters: [string, any][] }[],
  metaUpdates: [] as any[],
  shopDeleted: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      admin: {
        updateUserById: async (id: string, p: any) => {
          h.metaUpdates.push({ id, p })
          return { error: null }
        },
      },
    },
    from: (t: string) => {
      if (t === "user_shops") {
        return {
          select: (cols: string) => ({
            eq: () => ({
              maybeSingle: async () => ({
                data:
                  cols === "joined_via"
                    ? { joined_via: h.joinedVia }
                    : { id: "shop-1", user_id: "user-1", shop_name: "Kofi" },
                error: null,
              }),
            }),
          }),
          delete: () => ({
            eq: () => ({
              eq: async () => {
                h.shopDeleted = true
                return { error: null }
              },
            }),
          }),
        }
      }
      if (t === "shop_available_balance") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }
      }
      if (t === "withdrawal_requests") {
        return { select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }
      }
      if (t === "users") {
        return {
          update: (payload: any) => {
            const rec = { payload, filters: [] as [string, any][] }
            h.roleUpdates.push(rec)
            const chain: any = {
              eq: (c: string, v: any) => {
                rec.filters.push([c, v])
                return chain
              },
              then: (res: any) => res({ error: null }),
            }
            return chain
          },
        }
      }
      throw new Error(`Unexpected table ${t}`)
    },
  }),
}))

import { POST } from "./route"

const call = () =>
  POST(
    new NextRequest("https://x.test/api/shop/delete", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ shopId: "shop-1", confirmName: "Kofi" }),
    }),
  )

beforeEach(() => {
  h.joinedVia = null
  h.roleUpdates = []
  h.metaUpdates = []
  h.shopDeleted = false
})

describe("POST /api/shop/delete - storefront joiner role reset", () => {
  it("resets a storefront joiner to user, conditionally on role=sub_agent, and updates auth metadata", async () => {
    h.joinedVia = "storefront"
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.shopDeleted).toBe(true)
    expect(h.roleUpdates).toHaveLength(1)
    expect(h.roleUpdates[0].payload).toMatchObject({ role: "user" })
    expect(h.roleUpdates[0].filters).toEqual(expect.arrayContaining([["id", "user-1"], ["role", "sub_agent"]]))
    expect(h.metaUpdates).toEqual([{ id: "user-1", p: { user_metadata: { role: "user" } } }])
  })

  it("leaves an invited sub-agent's role alone", async () => {
    h.joinedVia = "invite"
    const res = await call()
    expect(res.status).toBe(200)
    expect(h.shopDeleted).toBe(true)
    expect(h.roleUpdates).toHaveLength(0)
    expect(h.metaUpdates).toHaveLength(0)
  })

  it("leaves a shop with no joined_via alone", async () => {
    h.joinedVia = null
    await call()
    expect(h.roleUpdates).toHaveLength(0)
  })
})
