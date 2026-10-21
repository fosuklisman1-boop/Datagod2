import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

let row: { logo_url: string | null } | null = null
let lookup: { filter?: string; active?: unknown } = {}

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        or: (filter: string) => {
          lookup.filter = filter
          return {
            eq: (_col: string, v: unknown) => {
              lookup.active = v
              return { single: async () => ({ data: row, error: row ? null : { code: "PGRST116" } }) }
            },
          }
        },
      }),
    }),
  },
}))

import { GET } from "./route"

const call = (slug: string) =>
  GET(new NextRequest(`https://x.test/api/shop-logo/${slug}`), { params: Promise.resolve({ slug }) })

describe("GET /api/shop-logo/[slug]", () => {
  beforeEach(() => {
    row = null
    lookup = {}
  })

  it("serves an embedded png logo as an image, cached at the CDN and sandboxed", async () => {
    row = { logo_url: `data:image/png;base64,${PNG_B64}` }
    const res = await call("my-shop")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("cache-control")).toContain("s-maxage=86400")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-security-policy")).toContain("sandbox")
    const body = Buffer.from(await res.arrayBuffer())
    expect(body.equals(Buffer.from(PNG_B64, "base64"))).toBe(true)
  })

  it("only looks up active shops, by the sanitised handle filter", async () => {
    row = { logo_url: `data:image/png;base64,${PNG_B64}` }
    await call("my-shop")
    expect(lookup.active).toBe(true)
    expect(lookup.filter).toContain("my-shop")
  })

  it("404s when the shop does not exist or is inactive", async () => {
    row = null
    const res = await call("nope")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toContain("s-maxage=60")
  })

  it("404s when the shop has no logo", async () => {
    row = { logo_url: null }
    expect((await call("s")).status).toBe(404)
  })

  it("404s for a normal URL logo (the page links those directly; no redirect through us)", async () => {
    row = { logo_url: "https://cdn.example.com/a.png" }
    const res = await call("s")
    expect(res.status).toBe(404)
    expect(res.headers.get("location")).toBeNull()
  })

  it("404s for svg and other non-raster data URIs", async () => {
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")
    row = { logo_url: `data:image/svg+xml;base64,${svg}` }
    expect((await call("s")).status).toBe(404)
    row = { logo_url: `data:text/html;base64,${PNG_B64}` }
    expect((await call("s")).status).toBe(404)
  })
})
