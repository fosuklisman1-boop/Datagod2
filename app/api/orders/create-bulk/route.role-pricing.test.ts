import { describe, it, expect, vi, beforeEach } from "vitest"

// A tiny table-serving fake. Writes are recorded; the wallet RPC returns no rows so the route stops with a
// 402 after computing the total, which is read from the RPC arguments.
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
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: db.client }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: async () => false }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn(), createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  verifyRecipientsForOrder: async () => ({ verdicts: new Map(), blocking: false, blocked: [] }),
  NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))

import { POST } from "./route"
import { MSG_PRICES_UNAVAILABLE } from "@/lib/pricing/package-price"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
  { id: "r-sub", slug: "sub_agent", rank: null, is_system: true, archived_at: null },
  { id: "r-admin", slug: "admin", rank: null, is_system: true, archived_at: null },
]
const DEALER_PRICES = [
  { role_id: "r-dealer", package_id: "p1", price: 8 },
  { role_id: "r-dealer", package_id: "p2", price: 16 },
]

function setup(opts: { role: string; mode?: string; custom?: Array<{ package_id: string; price: number }>; rolePrices?: any[] }) {
  db.state.tables = {
    users: [{ role: opts.role, pricing_mode: opts.mode ?? null }],
    packages: [
      { id: "p1", network: "Telecel", size: "1", price: 10, dealer_price: 8 },
      { id: "p2", network: "Telecel", size: "2", price: 20, dealer_price: 16 },
    ],
    roles: ROLES,
    role_package_prices: opts.rolePrices ?? DEALER_PRICES,
    user_package_prices: opts.custom ?? [],
  }
}

async function bulk() {
  const mk = (phone: string, volume_gb: number) => ({ phone_number: phone, volume_gb, network: "Telecel", price: 1 })
  const req = new Request("http://x/api/orders/create-bulk", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({
      network: "Telecel",
      orders: [mk("0204123456", 1), mk("0204123457", 1), mk("0204123458", 2)],
    }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

const charged = () => db.state.rpcs.find((r) => r.name === "deduct_wallet")?.args.p_amount

beforeEach(() => {
  db.state.failTable = null
  db.state.ops = []
  db.state.reads = {}
  db.state.rpcs = []
})

describe("POST /api/orders/create-bulk: role pricing", () => {
  it("(a) a dealer is charged dealer prices (8 + 8 + 16)", async () => {
    setup({ role: "dealer" })
    await bulk()
    expect(charged()).toBe(32)
  })

  it("(b) an admin is priced as a normal user (10 + 10 + 20)", async () => {
    setup({ role: "admin" })
    await bulk()
    expect(charged()).toBe(40)
  })

  it("(c) a user on custom pricing is charged the custom price where set (p1 custom 6, p2 role)", async () => {
    setup({ role: "user", mode: "custom", custom: [{ package_id: "p1", price: 6 }] })
    await bulk()
    expect(charged()).toBe(6 + 6 + 20)
  })

  it("(d) a failed roles read refuses with 503 before anything is debited or inserted", async () => {
    setup({ role: "dealer" })
    db.state.failTable = "roles"
    const r = await bulk()
    expect(r.status).toBe(503)
    expect(r.body.error).toBe(MSG_PRICES_UNAVAILABLE)
    expect(db.state.rpcs).toEqual([])
    expect(db.state.ops).toEqual([])
  })

  it("(e) 3 rows over 2 packages load role prices exactly once", async () => {
    setup({ role: "dealer" })
    await bulk()
    expect(db.state.reads.role_package_prices).toBe(1)
    expect(db.state.reads.roles).toBe(1)
  })

  it("(f) a role price row for the user role makes a user pay it (the route reads the resolver)", async () => {
    setup({
      role: "user",
      rolePrices: [{ role_id: "r-user", package_id: "p1", price: 5.5 }, { role_id: "r-user", package_id: "p2", price: 11 }],
    })
    await bulk()
    expect(charged()).toBe(5.5 + 5.5 + 11)
  })
})
