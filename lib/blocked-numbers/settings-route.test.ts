import { describe, it, expect, vi, beforeEach } from "vitest"

const upsert = vi.fn(async () => ({ error: null }))
let readResult: { data: unknown; error: unknown } = { data: null, error: null }

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: vi.fn(async () => ({ isAdmin: true, userId: "admin-1" })),
}))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => readResult }) }),
      upsert,
    }),
  },
}))

import { GET, POST } from "@/app/api/admin/settings/blocked-numbers/route"

const post = (body: string) => POST(new Request("http://x/api", { method: "POST", body }) as never)

describe("blocked-numbers settings route", () => {
  beforeEach(() => {
    upsert.mockClear()
    readResult = { data: null, error: null }
  })

  it("POST does not write when the stored read fails", async () => {
    readResult = { data: null, error: new Error("db") }
    const res = await post(JSON.stringify({ enabled: true }))
    expect(res.status).toBe(500)
    expect(upsert).not.toHaveBeenCalled()
  })

  it("GET returns 500 when the read fails", async () => {
    readResult = { data: null, error: new Error("db") }
    const res = await GET(new Request("http://x/api") as never)
    expect(res.status).toBe(500)
  })

  it("POST merges omitted fields with stored values", async () => {
    readResult = { data: { value: { retention_days: 90 } }, error: null }
    const res = await post(JSON.stringify({ enabled: true }))
    expect(res.status).toBe(200)
    const saved = (upsert.mock.calls[0] as unknown as [{ value: Record<string, unknown> }])[0].value
    expect(saved).toMatchObject({ enabled: true, retention_days: 90 })
  })

  it("malformed JSON returns 400", async () => {
    const res = await post("{not json")
    expect(res.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
  })
})
