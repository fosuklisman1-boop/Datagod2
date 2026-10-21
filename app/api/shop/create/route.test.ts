import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

let inserted: Record<string, unknown> | null = null
let updates: Record<string, unknown>[] = []
let uploadCalls: string[] = []
let uploadError: unknown = null

vi.mock("@/lib/admin-actions", () => ({ alertAdminsOfRequest: vi.fn(async () => {}) }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({
      insert: ([row]: Record<string, unknown>[]) => {
        inserted = row
        return { select: () => ({ single: async () => ({ data: { id: "shop-new", is_active: false, shop_name: row.shop_name, ...row }, error: null }) }) }
      },
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: "shop-new", is_active: false, ...(inserted ?? {}), ...payload }, error: null }) }) }) }
      },
    }),
    storage: {
      from: () => ({
        upload: async (path: string) => {
          uploadCalls.push(path)
          return { data: {}, error: uploadError }
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }),
      }),
    },
  }),
}))

import { POST } from "./route"

const call = (extra: Record<string, unknown>) =>
  POST(
    new NextRequest("https://x.test/api/shop/create", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ shop_name: "Kofi Data", shop_slug: "kofi-data-abc", ...extra }),
    }),
  )

describe("POST /api/shop/create - logo", () => {
  beforeEach(() => {
    inserted = null
    updates = []
    uploadCalls = []
    uploadError = null
  })

  it("never inserts an embedded image: creates the shop, uploads the logo, then saves only its URL", async () => {
    const res = await call({ logo_url: `data:image/png;base64,${PNG_B64}` })
    expect(res.status).toBe(200)
    expect(inserted?.logo_url).toBeNull()
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0]).toMatch(/^shop-logos\/shop-new\/\d+\.png$/)
    expect(updates).toHaveLength(1)
    expect(updates[0].logo_url).toBe(`https://cdn.example/${uploadCalls[0]}`)
    const body = await res.json()
    expect(body.shop.logo_url).toBe(`https://cdn.example/${uploadCalls[0]}`)
  })

  it("rejects an invalid embedded logo before creating anything", async () => {
    const res = await call({ logo_url: "data:text/html;base64,PHNjcmlwdD4=" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/JPG, PNG or WebP/)
    expect(inserted).toBeNull()
  })

  it("still creates the shop (without a logo) if the storage upload fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    uploadError = { message: "bucket exploded" }
    const res = await call({ logo_url: `data:image/png;base64,${PNG_B64}` })
    expect(res.status).toBe(200)
    expect(inserted?.logo_url).toBeNull()
    expect(updates).toHaveLength(0)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.logoWarning).toMatch(/logo/i)
    err.mockRestore()
  })

  it("keeps a normal URL logo as is, with no upload", async () => {
    const res = await call({ logo_url: "https://cdn.example.com/a.png" })
    expect(res.status).toBe(200)
    expect(inserted?.logo_url).toBe("https://cdn.example.com/a.png")
    expect(uploadCalls).toHaveLength(0)
  })

  it("creates a shop with no logo as before", async () => {
    const res = await call({})
    expect(res.status).toBe(200)
    expect(inserted?.logo_url).toBeNull()
    expect(uploadCalls).toHaveLength(0)
  })
})
