import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/roles/require-capability", () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))

// A tiny table-serving fake. Writes are recorded; the wallet RPC returns no rows so the route stops with a
// 402 that echoes the price it would have charged (`required`), which is what these tests assert on.
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    failTable: null as string | null,
    ops: [] as string[],
    reads: {} as Record<string, number>,
    rpcs: [] as Array<{ name: string; args: any }>,
  }
  function builder(table: string): any {
    const rows = () => state.tables[table] ?? []
    const failed = () => state.failTable === table
    const b: any = new Proxy(function () {}, {
      get: (_t, p: string) => {
        if (p === "select") return () => ((state.reads[table] = (state.reads[table] ?? 0) + 1), b)
        if (["insert", "update", "upsert", "delete"].includes(p)) return () => (state.ops.push(`${table}.${p}`), b)
        if (p === "single" || p === "maybeSingle")
          return () => Promise.resolve(failed() ? { data: null, error: { message: "boom" } } : { data: rows()[0] ?? null, error: null })
        if (p === "then")
          return (r: any, j: any) =>
            Promise.resolve(failed() ? { data: null, error: { message: "boom" } } : { data: rows(), error: null }).then(r, j)
        return () => b
      },
    })
    return b
  }
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => (state.rpcs.push({ name, args }), { data: null, error: null }),
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.c" } }, error: null }) },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/notification-service", () => ({ notificationTemplates: {} }))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn() }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn() }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: async () => false }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn(), createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  isRecipientBlocked: async () => false, NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]

function setup(opts: { role: string; mode?: string; custom?: Array<{ package_id: string; price: number }>; rolePrices?: any[] }) {
  db.state.tables = {
    users: [{ role: opts.role, pricing_mode: opts.mode ?? null }],
    wallets: [{ balance: 1000, total_spent: 0 }],
    packages: [{ id: "p1", size: "2", price: 10, dealer_price: 8, is_available: true }],
    roles: ROLES,
    role_package_prices: opts.rolePrices ?? [{ role_id: "r-dealer", package_id: "p1", price: 8 }],
    user_package_prices: opts.custom ?? [],
  }
}

async function buy() {
  const req = new Request("http://x/api/orders/purchase", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ packageId: "p1", network: "Telecel", size: "2", price: 1, phoneNumber: "0204123456" }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  db.state.failTable = null
  db.state.ops = []
  db.state.reads = {}
  db.state.rpcs = []
})

describe("POST /api/orders/purchase: role pricing", () => {
  it("(a) a dealer is charged the dealer price", async () => {
    setup({ role: "dealer" })
    const r = await buy()
    expect(r.status).toBe(402)
    expect(r.body.required).toBe(8)
    expect(db.state.rpcs[0].args.p_amount).toBe(8)
  })

  it("(b) an admin is priced as a normal user (public price)", async () => {
    setup({ role: "admin" })
    const r = await buy()
    expect(r.body.required).toBe(10)
  })

  it("(c) a user on custom pricing is charged the custom price", async () => {
    setup({ role: "user", mode: "custom", custom: [{ package_id: "p1", price: 6.25 }] })
    const r = await buy()
    expect(r.body.required).toBe(6.25)
  })

  it("(d) a failed roles read refuses with 503 before anything is debited or inserted", async () => {
    setup({ role: "dealer" })
    db.state.failTable = "roles"
    const r = await buy()
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(MSG_PRICES_UNAVAILABLE)
    expect(db.state.rpcs).toEqual([])
    expect(db.state.ops).toEqual([])
  })

  it("(g) a sub_agent (off-ladder) pays the public price even when dealer rows exist", async () => {
    setup({ role: "sub_agent" })
    const r = await buy()
    expect(r.body.required).toBe(10)
  })

  it("(h) a role-price 503 logs the error class name only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    setup({ role: "dealer" })
    db.state.failTable = "roles"
    const r = await buy()
    expect(r.status).toBe(503)
    expect(spy).toHaveBeenCalledWith("[purchase] role prices unavailable:", "RoleReadError")
    expect(JSON.stringify(spy.mock.calls)).not.toContain("boom")
    spy.mockRestore()
  })

  it("(f) a role price row for the user role makes a user pay it (the route reads the resolver)", async () => {
    setup({ role: "user", rolePrices: [{ role_id: "r-user", package_id: "p1", price: 5.5 }] })
    const r = await buy()
    expect(r.body.required).toBe(5.5)
  })
})
