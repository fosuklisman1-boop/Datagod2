import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/roles/require-capability", () => ({ requireCapability: vi.fn().mockResolvedValue(null) }))

const KEY = "11111111-1111-4111-8111-111111111111"

// Stateful fake: orders are stored (with a unique idempotency_key index), wallet RPCs are recorded.
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, any[]>,
    orders: [] as any[],
    rpcs: [] as Array<{ name: string; args: any }>,
    calls: [] as string[],
    walletUpdates: [] as any[],
    insertError: null as any,
    orderLookups: 0,
    revertError: null as any,
  }
  function builder(table: string): any {
    const filters: Record<string, any> = {}
    let op = "select"
    let payload: any
    const run = () => {
      if (table === "orders" && op === "insert") {
        state.calls.push("orders.insert")
        if (state.insertError) return { data: null, error: state.insertError }
        const row = { id: `o-${state.orders.length + 1}`, ...payload[0] }
        if (row.idempotency_key && state.orders.some((o) => o.idempotency_key === row.idempotency_key)) {
          return { data: null, error: { code: "23505", message: "duplicate key" } }
        }
        state.orders.push(row)
        return { data: [row], error: null }
      }
      if (op === "insert" || op === "update") {
        state.calls.push(`${table}.${op}`)
        if (table === "wallets" && op === "update") state.walletUpdates.push(payload)
        return { data: null, error: null }
      }
      if (table === "orders") {
        state.orderLookups++
        const rows = state.orders.filter((o) => Object.entries(filters).every(([k, v]) => o[k] === v))
        return { data: rows[0] ?? null, error: null }
      }
      return { data: (state.tables[table] ?? [])[0] ?? null, error: null }
    }
    const b: any = new Proxy(function () {}, {
      get: (_t, p: string) => {
        if (p === "insert" || p === "update") return (v: any) => ((op = p), (payload = v), b)
        if (p === "eq") return (k: string, v: any) => ((filters[k] = v), b)
        if (p === "single" || p === "maybeSingle") return () => Promise.resolve(run())
        if (p === "then") {
          return (r: any, j: any) => {
            const res = run()
            // list-style reads resolve to arrays; inserts return rows already
            const out = op === "select" && !Array.isArray(res.data) ? { data: state.tables[table] ?? [], error: null } : res
            return Promise.resolve(out).then(r, j)
          }
        }
        return () => b
      },
    })
    return b
  }
  const client = {
    from: (t: string) => builder(t),
    rpc: async (name: string, args: any) => {
      state.rpcs.push({ name, args })
      if (name === "deduct_wallet") {
        return { data: [{ new_balance: 990, old_balance: 1000, new_total_spent: 10 }], error: null }
      }
      if (name === "revert_wallet_deduction") return { data: 1000, error: state.revertError }
      return { data: null, error: null }
    },
    auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "a@b.c" } }, error: null }) },
  }
  return { state, client }
})

vi.mock("@supabase/supabase-js", () => ({ createClient: () => db.client }))
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified: async () => ({ allowed: true }) }))
vi.mock("@/lib/notification-service", () => ({
  notificationTemplates: { paymentSuccess: () => ({ title: "t", message: "m", type: "x", reference_id: "r" }) },
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: vi.fn(async () => {}) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: vi.fn(async () => {}) }))
vi.mock("@/lib/customer-tracking-service", () => ({ customerTrackingService: {} }))
vi.mock("@/lib/blacklist", () => ({ isPhoneBlacklisted: async () => false }))
vi.mock("@/lib/mtn-fulfillment", () => ({
  isAutoFulfillmentEnabled: vi.fn(async () => false), createMTNOrder: vi.fn(), saveMTNTracking: vi.fn(), normalizePhoneNumber: (p: string) => p,
}))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: async () => ({ enabled: false, map: {} }) }))
vi.mock("@/lib/mtn-providers/customer-verification", () => ({
  isRecipientBlocked: async () => false, NOT_VERIFIED_CODE: "RECIPIENT_NOT_VERIFIED",
}))
vi.mock("@/lib/email-service", () => ({ sendEmail: vi.fn(async () => {}),EmailTemplates: { orderPaymentConfirmed: () => ({ subject: "s", html: "h" }) } }))

import { POST } from "./route"

const ROLES = [
  { id: "r-user", slug: "user", rank: 0, is_system: true, archived_at: null },
  { id: "r-dealer", slug: "dealer", rank: 10, is_system: true, archived_at: null },
]

async function buy(extra: Record<string, unknown> = {}) {
  const req = new Request("http://x/api/orders/purchase", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({
      packageId: "p1", network: "Vodafone", size: "2", price: 1, phoneNumber: "0204123456", sendSmsConfirmation: false, ...extra,
    }),
  })
  const res = await POST(req as any)
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  db.state.tables = {
    users: [{ role: "user", pricing_mode: null }],
    wallets: [{ balance: 1000, total_spent: 0 }],
    packages: [{ id: "p1", size: "2", price: 10, dealer_price: 8, is_available: true }],
    roles: ROLES,
    role_package_prices: [],
    user_package_prices: [],
  }
  db.state.orders = []
  db.state.rpcs = []
  db.state.calls = []
  db.state.walletUpdates = []
  db.state.insertError = null
  db.state.orderLookups = 0
  db.state.revertError = null
})

const deducts = () => db.state.rpcs.filter((r) => r.name === "deduct_wallet")
const reverts = () => db.state.rpcs.filter((r) => r.name === "revert_wallet_deduction")

describe("POST /api/orders/purchase: idempotency key", () => {
  it("same_key_twice_one_debit", async () => {
    const first = await buy({ idempotencyKey: KEY })
    expect(first.status).toBe(200)
    expect(first.body.alreadyPlaced).toBeUndefined()
    const txBefore = db.state.calls.filter((c) => c === "transactions.insert").length
    const notifBefore = db.state.calls.filter((c) => c === "notifications.insert").length

    const second = await buy({ idempotencyKey: KEY })
    expect(second.status).toBe(200)
    expect(second.body.alreadyPlaced).toBe(true)
    expect(second.body.order.order_code).toBe(first.body.order.order_code)
    expect(deducts()).toHaveLength(1)
    expect(db.state.orders).toHaveLength(1)
    expect(db.state.calls.filter((c) => c === "transactions.insert")).toHaveLength(txBefore)
    expect(db.state.calls.filter((c) => c === "notifications.insert")).toHaveLength(notifBefore)
  })

  it("no_key_unchanged", async () => {
    const r = await buy()
    expect(r.status).toBe(200)
    expect(r.body.alreadyPlaced).toBeUndefined()
    expect(db.state.orderLookups).toBe(0)
    expect(deducts()).toHaveLength(1)
    expect(db.state.orders[0]).not.toHaveProperty("idempotency_key")
  })

  it("invalid_key_400", async () => {
    const r = await buy({ idempotencyKey: "not-a-uuid" })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe("Invalid idempotencyKey")
    expect(db.state.rpcs).toEqual([])
  })

  it("insert_failure_reverts_atomically", async () => {
    db.state.insertError = { code: "XX000", message: "boom" }
    const r = await buy({ idempotencyKey: KEY })
    expect(r.status).toBe(500)
    expect(reverts()).toEqual([{ name: "revert_wallet_deduction", args: { p_user_id: "user-1", p_amount: 10 } }])
    expect(db.state.walletUpdates).toEqual([])
  })

  it("insert_failure_without_key_also_reverts_atomically_and_logs_revert_failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    db.state.insertError = { code: "XX000", message: "boom" }
    db.state.revertError = { message: "rpc down" }
    const r = await buy()
    expect(r.status).toBe(500)
    expect(reverts()).toHaveLength(1)
    expect(db.state.walletUpdates).toEqual([])
    spy.mockRestore()
  })

  it("key_owned_by_other_user_409", async () => {
    // The unique index fires at insert (the owner-scoped pre-check found nothing for this user).
    db.state.orders = [{ id: "o-x", user_id: "someone-else", idempotency_key: KEY, order_code: "ORD-1" }]
    const r = await buy({ idempotencyKey: KEY })
    expect(r.status).toBe(409)
    expect(r.body).toEqual({ error: "Duplicate request" })
    // charge was taken then reverted atomically; nothing revealed about the other order
    expect(reverts()).toEqual([{ name: "revert_wallet_deduction", args: { p_user_id: "user-1", p_amount: 10 } }])
    expect(JSON.stringify(r.body)).not.toContain("ORD-1")
    expect(db.state.orders).toHaveLength(1)
  })
})
