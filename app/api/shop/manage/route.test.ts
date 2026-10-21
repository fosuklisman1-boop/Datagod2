import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

let lastUpdate: Record<string, unknown> | null = null
let uploadCalls: { path: string; contentType: string }[] = []
let uploadError: unknown = null

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "shop-1", user_id: "user-1" }, error: null }) }) }),
      update: (payload: Record<string, unknown>) => {
        lastUpdate = payload
        return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: "shop-1", ...payload }, error: null }) }) }) }
      },
    }),
    storage: {
      from: () => ({
        upload: async (path: string, _bytes: Buffer, opts: { contentType: string }) => {
          uploadCalls.push({ path, contentType: opts.contentType })
          return { data: {}, error: uploadError }
        },
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }),
      }),
    },
  }),
}))

import { POST } from "./route"

const call = (updates: Record<string, unknown>) =>
  POST(
    new NextRequest("https://x.test/api/shop/manage", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: JSON.stringify({ action: "update_shop", shopId: "shop-1", updates }),
    }),
  )

describe("POST /api/shop/manage update_shop - logo", () => {
  beforeEach(() => {
    lastUpdate = null
    uploadCalls = []
    uploadError = null
  })

  it("moves an embedded logo into storage and saves only the short URL", async () => {
    const res = await call({ logo_url: `data:image/png;base64,${PNG_B64}`, description: "hi" })
    expect(res.status).toBe(200)
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0].path).toMatch(/^shop-logos\/shop-1\/\d+\.png$/)
    expect(String(lastUpdate?.logo_url)).toBe(`https://cdn.example/${uploadCalls[0].path}`)
    expect(String(lastUpdate?.logo_url)).not.toContain("data:")
    expect(lastUpdate?.description).toBe("hi")
  })

  it("passes a normal URL logo through untouched, with no upload", async () => {
    const res = await call({ logo_url: "https://cdn.example.com/a.png" })
    expect(res.status).toBe(200)
    expect(uploadCalls).toHaveLength(0)
    expect(lastUpdate?.logo_url).toBe("https://cdn.example.com/a.png")
  })

  it("clears the logo when null is sent", async () => {
    const res = await call({ logo_url: null })
    expect(res.status).toBe(200)
    expect(lastUpdate?.logo_url).toBeNull()
  })

  it("rejects a non-image embedded logo with 400 and writes nothing", async () => {
    const res = await call({ logo_url: "data:text/html;base64,PHNjcmlwdD4=" })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/JPG, PNG or WebP/)
    expect(lastUpdate).toBeNull()
    expect(uploadCalls).toHaveLength(0)
  })

  it("rejects an oversized embedded logo with 400", async () => {
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024 + 1)]).toString("base64")
    const res = await call({ logo_url: `data:image/jpeg;base64,${big}` })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/2 MB/)
    expect(lastUpdate).toBeNull()
  })

  it("fails the update (500) rather than saving the embedded image when storage fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    uploadError = { message: "bucket exploded" }
    const res = await call({ logo_url: `data:image/png;base64,${PNG_B64}` })
    expect(res.status).toBe(500)
    expect(lastUpdate).toBeNull()
    err.mockRestore()
  })
})
