import { describe, it, expect, vi } from "vitest"

const row = { signups_enabled: false, ordering_enabled: true }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ is: () => ({ single: async () => ({ data: row, error: null }) }) }) }),
  },
}))

import { GET } from "./route"

describe("GET /api/settings/public", () => {
  it("returns the curated toggles with a short CDN cache so polling doesn't hit a function every time", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60")
    const body = await res.json()
    expect(body.signups_enabled).toBe(false)
    expect(body.ordering_enabled).toBe(true)
  })
})
