import { describe, it, expect, vi } from "vitest"

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        limit: () => ({
          single: async () => ({
            data: { support_email: "a@b.c", support_phone: "0500000000", support_whatsapp: "233500000000" },
            error: null,
          }),
        }),
      }),
    }),
  }),
}))

import { GET } from "./route"

describe("GET /api/support-config", () => {
  it("returns support contact details with a short CDN cache", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=30, stale-while-revalidate=60")
    const body = await res.json()
    expect(body.email).toBe("a@b.c")
    expect(body.whatsapp).toBe("https://wa.me/233500000000")
  })
})
