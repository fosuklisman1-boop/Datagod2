import { describe, it, expect, vi, beforeEach } from "vitest"

// A tiny table-serving fake. The order RPC fails with "Insufficient balance" so the route stops after pricing;
// the price it would have charged is read from the RPC arguments.
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    failTable: null as string | null,
    ops: [] as string[],
    rpcs: [] as Array<{ name: string; args: any }>,
    role: "dealer",
  }
  function builder(table: string): any {
    const rows = () => state.tables[table] ?? []
    const failed = () => state.failTable === table
    const b: any = new Proxy(function () {}, {
      get: (_t, p: string) => {
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
    rpc: async (name: string, args: any) => (
      state.rpcs.push({ name, args }), { data: { success: false, error: "Insufficient balance" }, error: null }
    ),
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }))
vi.mock("@/lib/api-auth", () => ({
  authenticateApiKey: async () => ({ id: "user-1", role: db.state.role, api_key_id: "k1", rate_limit_per_min: 60, environment: "live" }),
  logApiRequest: async () => {},
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p, isAutoFulfillmentEnabled: vi.fn(),
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/sandbox", () => ({ placeSandboxOrder: vi.fn(), getSandboxOrder: vi.fn() }))

import { POST } from "./route"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]

function setup(opts: { role: string; mode?: string; custom?: Array<{ package_id: string; price: number }>; rolePrices?: any[] }) {
  db.state.role = opts.role
  db.state.tables = {
    users: [{ role: opts.role, pricing_mode: opts.mode ?? null }],
    packages: [{ id: "p1", price: 10, dealer_price: 8 }],
    roles: ROLES,
    role_package_prices: opts.rolePrices ?? [{ role_id: "r-dealer", package_id: "p1", price: 8 }],
    user_package_prices: opts.custom ?? [],
  }
}

async function order() {
  const req = new Request("http://x/api/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ network: "Telecel", volume_gb: 1, recipient: "0204123456", reference: "ref-123" }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

const charged = () => db.state.rpcs.find((r) => r.name === "place_api_order")?.args.p_price

beforeEach(() => {
  db.state.failTable = null
  db.state.ops = []
  db.state.rpcs = []
})

describe("POST /api/v1/orders: role pricing", () => {
  it("(a) a dealer is charged the dealer price", async () => {
    setup({ role: "dealer" })
    await order()
    expect(charged()).toBe(8)
  })

  it("(b) an admin is priced as a normal user (public price)", async () => {
    setup({ role: "admin" })
    await order()
    expect(charged()).toBe(10)
  })

  it("(c) a user on custom pricing is charged the custom price", async () => {
    setup({ role: "user", mode: "custom", custom: [{ package_id: "p1", price: 6.25 }] })
    await order()
    expect(charged()).toBe(6.25)
  })

  it("(d) a failed roles read refuses with 503 before anything is placed", async () => {
    setup({ role: "dealer" })
    db.state.failTable = "roles"
    const r = await order()
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(MSG_PRICES_UNAVAILABLE)
    expect(db.state.rpcs).toEqual([])
    expect(db.state.ops).toEqual([])
  })

  it("(f) a role price row for the user role makes a user pay it (the route reads the resolver)", async () => {
    setup({ role: "user", rolePrices: [{ role_id: "r-user", package_id: "p1", price: 5.5 }] })
    await order()
    expect(charged()).toBe(5.5)
  })
})
