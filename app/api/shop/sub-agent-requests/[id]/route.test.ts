// PATCH: approving is refused for an owner who is a sub-agent, whatever the open-join switch says. Pending requests
// can still be approved or rejected while the switch is on.
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => {
  type T = { data: unknown; error?: unknown }
  const state = { tables: {} as Record<string, T>, inserts: [] as any[], updates: [] as any[] }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } }, error: null }) },
    from(table: string) {
      const r = () => ({ error: null, ...(state.tables[table] ?? { data: null }) })
      const b: any = {
        select: () => b, eq: () => b, is: () => b, or: () => b, in: () => b, order: () => b, limit: () => b,
        insert: (row: any) => { state.inserts.push({ table, row }); return b },
        update: (row: any) => { state.updates.push({ table, row }); return b },
        single: async () => (table === "shop_invites" && state.inserts.length ? { data: { id: "inv-1" }, error: null } : r()),
        maybeSingle: async () => r(),
        then: (ok: any, ko: any) => Promise.resolve(r()).then(ok, ko),
      }
      return b
    },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/sms-service", () => ({
  sendSMS: async () => ({ success: true }),
  SMSTemplates: { subAgentInvitation: () => "msg" },
}))

import { PATCH } from "./route"

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://x"
process.env.SUPABASE_SERVICE_ROLE_KEY = "k"

const patch = async (action: string) => {
  const res = await PATCH(
    new Request("http://x/api/shop/sub-agent-requests/r1", {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ action }),
    }) as any,
    { params: Promise.resolve({ id: "r1" }) }
  )
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.state.inserts = []
  h.state.updates = []
  h.state.tables = {
    user_shops: { data: { id: "shop-1", shop_name: "Kofi", is_active: true, parent_shop_id: null } },
    users: { data: { role: "user" } },
    app_settings: { data: { sub_agent_open_join_enabled: false } },
    sub_agent_requests: { data: { id: "r1", status: "pending", requester_phone: "0241234567", requester_email: null } },
    shop_invites: { data: null },
  }
})

describe("PATCH /api/shop/sub-agent-requests/[id]", () => {
  it("approves a pending request for a top-level owner", async () => {
    const { status, body } = await patch("approve")
    expect(status).toBe(200)
    expect(body.status).toBe("approved")
  })

  it("refuses approve for an owner whose role is sub_agent, with the switch off", async () => {
    h.state.tables.users = { data: { role: "sub_agent" } }
    const { status } = await patch("approve")
    expect(status).toBe(403)
    expect(h.state.inserts.filter((i) => i.table === "shop_invites")).toHaveLength(0)
  })

  it("refuses approve for an owner whose role is sub_agent, with the switch on", async () => {
    h.state.tables.users = { data: { role: "sub_agent" } }
    h.state.tables.app_settings = { data: { sub_agent_open_join_enabled: true } }
    const { status } = await patch("approve")
    expect(status).toBe(403)
  })

  it("refuses approve for a shop that has a parent", async () => {
    h.state.tables.user_shops = { data: { id: "shop-2", shop_name: "Kofi", is_active: true, parent_shop_id: "shop-1" } }
    const { status } = await patch("approve")
    expect(status).toBe(403)
  })

  it("still approves a pending request with the switch on", async () => {
    h.state.tables.app_settings = { data: { sub_agent_open_join_enabled: true } }
    const { status, body } = await patch("approve")
    expect(status).toBe(200)
    expect(body.status).toBe("approved")
  })

  it("still rejects a pending request with the switch on", async () => {
    h.state.tables.app_settings = { data: { sub_agent_open_join_enabled: true } }
    const { status, body } = await patch("reject")
    expect(status).toBe(200)
    expect(body.status).toBe("rejected")
  })
})
