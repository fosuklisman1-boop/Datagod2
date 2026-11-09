// Sub-agent requests: new requests are refused for sub-agent shops and for every shop while open join is on.
// Pending requests stay reviewable (see [id]/route.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type T = { data: unknown; error?: unknown }
  const state = { tables: {} as Record<string, T>, inserts: [] as any[] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
    from(table: string) {
      const r = () => ({ error: null, ...(state.tables[table] ?? { data: null }) })
      const b: any = {
        select: () => b, eq: () => b, is: () => b, or: () => b, in: () => b, order: () => b, limit: () => b,
        insert: (row: any) => { state.inserts.push({ table, row }); return Promise.resolve({ error: null }) },
        single: async () => r(),
        maybeSingle: async () => r(),
        then: (ok: any, ko: any) => Promise.resolve(r()).then(ok, ko),
      }
      return b
    },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/turnstile", () => ({
  isTurnstileEnabled: async () => false,
  verifyTurnstileToken: async () => ({ valid: true }),
  getRequestIp: () => "1.1.1.1",
}))

import { POST } from "./route"

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
process.env.SUPABASE_SERVICE_ROLE_KEY = "k"

const post = async () => {
  const res = await POST(
    new Request("http://x/api/shop/sub-agent-requests", {
      method: "POST",
      body: JSON.stringify({ shopSlug: "kofi", requesterName: "Ama", requesterPhone: "0241234567" }),
    }) as any
  )
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.state.inserts = []
  h.state.tables = {
    user_shops: { data: { id: "shop-1", is_active: true, parent_shop_id: null } },
    app_settings: { data: { sub_agent_open_join_enabled: false } },
    sub_agent_requests: { data: null },
  }
})

describe("POST /api/shop/sub-agent-requests", () => {
  it("accepts a request for a top-level shop while open join is off", async () => {
    const { status } = await post()
    expect(status).toBe(200)
    expect(h.state.inserts).toHaveLength(1)
  })

  it("refuses a sub-agent shop", async () => {
    h.state.tables.user_shops = { data: { id: "shop-2", is_active: true, parent_shop_id: "shop-1" } }
    const { status } = await post()
    expect(status).toBe(400)
    expect(h.state.inserts).toHaveLength(0)
  })

  it("refuses every shop while open join is on", async () => {
    h.state.tables.app_settings = { data: { sub_agent_open_join_enabled: true } }
    const { status, body } = await post()
    expect(status).toBe(403)
    expect(body.error).toMatch(/join/i)
    expect(h.state.inserts).toHaveLength(0)
  })
})
