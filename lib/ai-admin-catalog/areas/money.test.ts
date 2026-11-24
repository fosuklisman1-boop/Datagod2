import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"

// The refund cards read the order the same way the route does. Here that loader is canned: ORDERS by id, and a throw
// for the "broken" client.
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-000000000001"
const WALLET_ORDER_ID = "dddddddd-dddd-4ddd-8ddd-000000000002"
const BILL_ORDER_ID = "dddddddd-dddd-4ddd-8ddd-000000000003"
const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"
const ADMIN = "11111111-1111-4111-8111-111111111111"
const R1 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001"
const R2 = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002"
const W1 = "cccccccc-cccc-4ccc-8ccc-000000000001"
const W2 = "cccccccc-cccc-4ccc-8ccc-000000000002"
const PLAN = "eeeeeeee-eeee-4eee-8eee-000000000001"
const SESSION = "ffffffff-ffff-4fff-8fff-000000000001"

const baseOrder = {
  table: "shop_orders",
  id: ORDER_ID,
  orderStatus: "pending",
  paymentStatus: "completed",
  shopId: "s1",
  shopName: "Kofi Shop",
  packageLabel: "5GB",
  network: "MTN",
  recipientPhone: "0200000009",
  createdAt: "2026-11-20T10:00:00Z",
  paid: 20,
  gatewayFee: 0.4,
  payment: { gateway: "paystack", reference: "PSK_123", payerPhone: "0241234567", walletUserId: U1 },
  owners: [{ shopId: "s1", ownerUserId: U2, credited: 3, pending: 0, availableBalance: 10, walletBalance: 0 }],
  evidence: { hasActiveRefund: false, dispatchOutcome: null, dispatchAttempts: null, trackingStatuses: [], externalOrderId: null },
}

vi.mock("@/lib/refunds/orders", () => ({
  loadRefundableOrders: async (db: { __broken?: boolean }, refs: { table: string; id: string }[]) => {
    if (db.__broken) throw new Error("db down")
    const r = refs[0]
    if (r.id === ORDER_ID) return [baseOrder]
    if (r.id === WALLET_ORDER_ID) {
      return [{ ...baseOrder, id: WALLET_ORDER_ID, table: "orders", buyerUserId: U1, payment: { gateway: "wallet", reference: null, payerPhone: null, walletUserId: U1 }, owners: [] }]
    }
    if (r.id === BILL_ORDER_ID) {
      return [
        {
          ...baseOrder,
          id: BILL_ORDER_ID,
          table: "hubtel_bill_orders",
          orderStatus: "failed",
          paymentStatus: "paid",
          owners: [],
          payment: { gateway: "paystack", reference: "PSK_BILL", payerPhone: "0551112222", walletUserId: null },
          evidence: { ...baseOrder.evidence, commission: { storefront: true, status: "failed", paymentStatus: "paid", hubtelClientReference: null, notes: null, updatedAt: "2026-11-20T10:00:00Z", ledger: [] } },
        },
      ]
    }
    return []
  },
}))

import { MONEY_ENTRIES } from "./money"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import { resolveRequest } from "../resolve"
import type { Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`

const CATALOGUED = [
  "DELETE /api/admin/subscription-plans",
  "GET /api/admin/cashback/config",
  "GET /api/admin/cashback/report",
  "GET /api/admin/momo-claims",
  "GET /api/admin/momo-claims/reconcile",
  "GET /api/admin/momo-claims/sessions",
  "GET /api/admin/profits-history",
  "GET /api/admin/refunds/:id/gateway-status",
  "GET /api/admin/refunds/history",
  "GET /api/admin/refunds/pending",
  "GET /api/admin/refunds/wallet-attention",
  "GET /api/admin/sub-agent-profits",
  "GET /api/admin/sub-agent-profits/:shopId",
  "GET /api/admin/subscription-plans",
  "GET /api/admin/subscriptions",
  "GET /api/admin/withdrawals/moolre-balance",
  "GET /api/admin/withdrawals/paystack-balance",
  "PATCH /api/admin/momo-claims",
  "PATCH /api/admin/momo-claims/sessions",
  "POST /api/admin/cashback/config",
  "POST /api/admin/momo-claims",
  "POST /api/admin/refunds",
  "POST /api/admin/refunds/:id/cancel",
  "POST /api/admin/refunds/:id/hubtel-never-paid",
  "POST /api/admin/refunds/:id/otp",
  "POST /api/admin/refunds/:id/reconcile",
  "POST /api/admin/refunds/:id/retry",
  "POST /api/admin/refunds/manual",
  "POST /api/admin/refunds/preview",
  "POST /api/admin/subscription-plans",
  "POST /api/admin/withdrawals/approve",
  "POST /api/admin/withdrawals/complete",
  "POST /api/admin/withdrawals/recalibrate",
  "POST /api/admin/withdrawals/reject",
  "POST /api/admin/withdrawals/reset-processing",
  "POST /api/admin/withdrawals/submit-transfer-otp",
  "POST /api/admin/withdrawals/validate-name",
]

const EXCLUDED_ROUTES: Array<[string, RegExp]> = [
  ["POST /api/admin/withdrawals/bulk-approve", /300 s/],
  ["GET /api/admin/withdrawals/list", /bare JSON array/],
  ["POST /api/admin/momo-claims/reconcile", /CSV/],
  ["GET /api/admin/sync-shop-balances", /every shop/],
]

const byKey = (k: string) => MONEY_ENTRIES.find((e) => key(e.method, e.path) === k)!

describe("money catalog coverage", () => {
  it("catalogues exactly the listed routes and registers them in CATALOG", () => {
    expect(MONEY_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
    }
  })

  it("moves the excluded routes out of PENDING with a specific reason", () => {
    for (const [k, why] of EXCLUDED_ROUTES) {
      expect(PENDING, k).not.toContain(k)
      const row = EXCLUDED.find((e) => key(e.method, e.path) === k)
      expect(row, k).toBeTruthy()
      expect(row!.reason, k).toMatch(why)
    }
  })

  it("leaves no money-area route in PENDING", () => {
    const area = /^(DELETE|GET|PATCH|POST|PUT) \/api\/admin\/(refunds|withdrawals|cashback|sub-agent-profits|profits-history|momo-claims|subscriptions|subscription-plans|sync-shop-balances)(\/|$)/
    expect(PENDING.filter((k) => area.test(k))).toEqual([])
  })

  it("ids are unique and area is money", () => {
    const ids = MONEY_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of MONEY_ENTRIES) expect(e.area).toBe("money")
  })
})

describe("money catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of MONEY_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of MONEY_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of MONEY_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card or typed tool", () => {
    for (const e of MONEY_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      if (e.kind === "change") expect(Boolean(e.card || e.typedCard), e.id).toBe(true)
    }
  })

  it("lookups never keep secrets, codes, tokens, emails or phone numbers of customers", () => {
    for (const e of MONEY_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/password|token|secret|hash|api_?key|payload|email|(^|[.\]])code$|owner_phone|customer_phone|(^|[._\]])raw($|[._])/i)
      }
    }
  })

  it("side-effect GETs are changes (they call a provider or gateway)", () => {
    for (const k of [
      "GET /api/admin/refunds/:id/gateway-status",
      "GET /api/admin/withdrawals/moolre-balance",
      "GET /api/admin/withdrawals/paystack-balance",
    ]) {
      expect(byKey(k).kind, k).toBe("change")
    }
    // sync-shop-balances (a GET that writes) is excluded, not catalogued.
    expect(MONEY_ENTRIES.some((e) => e.path.includes("sync-shop-balances"))).toBe(false)
  })

  it("every change that moves money is at least money; the table's minimum", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const moneyKeys = CATALOGUED.filter(
      (k) =>
        !k.startsWith("GET ") &&
        !["POST /api/admin/refunds/preview", "POST /api/admin/withdrawals/validate-name"].includes(k),
    )
    for (const k of moneyKeys) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.money)
    // These only ask a provider or the database; nothing is paid or saved.
    expect(byKey("POST /api/admin/refunds/preview").risk).toBe("normal")
  })

  it("withdrawal approve, reject and complete use the typed tool with exactly the body it posts", () => {
    for (const k of ["POST /api/admin/withdrawals/approve", "POST /api/admin/withdrawals/reject", "POST /api/admin/withdrawals/complete"]) {
      const e = byKey(k)
      expect(e.typedCard, k).toBe("prepare_withdrawal_action")
      expect(e.card, k).toBeUndefined()
    }
    // lib/ai-drafts/execute.ts posts {withdrawalId} and, on reject only, {reason}.
    expect(Object.keys(byKey("POST /api/admin/withdrawals/approve").body!.shape)).toEqual(["withdrawalId"])
    expect(Object.keys(byKey("POST /api/admin/withdrawals/complete").body!.shape)).toEqual(["withdrawalId"])
    expect(Object.keys(byKey("POST /api/admin/withdrawals/reject").body!.shape).sort()).toEqual(["reason", "withdrawalId"])
    // Not offered: the handler's manual and provider switches (the typed tool never sends them).
    expect(byKey("POST /api/admin/withdrawals/approve").body!.safeParse({ withdrawalId: W1, provider: "paystack" }).success).toBe(false)
    expect(byKey("POST /api/admin/withdrawals/approve").body!.safeParse({ withdrawalId: W1, manual: true }).success).toBe(false)
  })

  it("the two payout codes are secure-box fields and never part of any schema", () => {
    for (const k of ["POST /api/admin/refunds/:id/otp", "POST /api/admin/withdrawals/submit-transfer-otp"]) {
      const e = byKey(k)
      expect(e.secretFields?.map((s) => s.name), k).toEqual(["otp"])
      expect(Object.keys(e.body!.shape), k).not.toContain("otp")
      const params = e.params ? { id: R1 } : undefined
      const viaModel = resolveRequest(e, { params, body: { withdrawalId: W1, otp: "123456" } })
      expect(viaModel.ok, k).toBe(false)
      expect(e.body!.safeParse({ withdrawalId: W1, otp: "123456" }).success, k).toBe(false)
    }
    for (const x of MONEY_ENTRIES) {
      if (x.secretFields) continue
      for (const schema of [x.query, x.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, x.id).not.toMatch(/secret|api_?key|token|password|otp/i)
      }
    }
  })

  it("auth matches each handler", () => {
    const other = new Set([
      "GET /api/admin/sub-agent-profits",
      "GET /api/admin/sub-agent-profits/:shopId",
      "GET /api/admin/subscriptions",
      "GET /api/admin/subscription-plans",
      "POST /api/admin/subscription-plans",
      "DELETE /api/admin/subscription-plans",
    ])
    for (const e of MONEY_ENTRIES) expect(e.auth, e.id).toBe(other.has(key(e.method, e.path)) ? "other" : "admin")
  })

  it("timeouts stay within 60 s", () => {
    for (const e of MONEY_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
  })

  it("keeps the slow or private query switches out of the schemas", () => {
    expect(byKey("GET /api/admin/profits-history").query!.safeParse({ search: "x" }).success).toBe(false)
    expect(byKey("GET /api/admin/momo-claims").query!.safeParse({ raw: "123456789" }).success).toBe(false)
    expect(byKey("GET /api/admin/momo-claims/sessions").resultKeep).not.toContain("sessions[].code")
  })

  it("refund schemas match the handler: gateway ids, positive amounts, no manual retry", () => {
    const exec = byKey("POST /api/admin/refunds").body!
    const ok = { table: "shop_orders", orderId: ORDER_ID, gateway: "moolre", amount: 10 }
    expect(exec.safeParse(ok).success).toBe(true)
    expect(exec.safeParse({ ...ok, gateway: "bitcoin" }).success).toBe(false)
    expect(exec.safeParse({ ...ok, amount: 0 }).success).toBe(false)
    expect(exec.safeParse({ ...ok, amount: -5 }).success).toBe(false)
    expect(exec.safeParse({ ...ok, table: "users" }).success).toBe(false)
    const retry = byKey("POST /api/admin/refunds/:id/retry").body!
    expect(retry.safeParse({ gateway: "manual" }).success).toBe(false)
    const manual = byKey("POST /api/admin/refunds/manual").body!
    expect(manual.safeParse({ table: "shop_orders", orderId: ORDER_ID, note: "paid" }).success).toBe(false)
    expect(manual.safeParse({ table: "airtime_orders", orderId: ORDER_ID, note: "paid by MoMo" }).success).toBe(true)
    expect(byKey("POST /api/admin/refunds/:id/hubtel-never-paid").body!.safeParse({ confirm: false }).success).toBe(false)
  })

  it("cashback and subscription plan schemas mirror the handlers", () => {
    const cb = byKey("POST /api/admin/cashback/config").body!
    expect(cb.safeParse({ rates: { "airtime_mtn:hubtel": 2.5 } }).success).toBe(true)
    expect(cb.safeParse({ rates: { "nonsense": 2.5 } }).success).toBe(false)
    expect(cb.safeParse({ rates: { "airtime_mtn:hubtel": 25 } }).success).toBe(false)
    expect(cb.safeParse({ shares: { airtime: { customer: 1, dealer: 1, storefrontCustomer: 1 } } }).success).toBe(false) // groups sent whole
    const plan = byKey("POST /api/admin/subscription-plans").body!
    expect(plan.safeParse({ name: "Gold", price: 0, duration_days: 30 }).success).toBe(false) // the route rejects a zero price
    expect(plan.safeParse({ name: "Gold", price: 25, duration_days: 30 }).success).toBe(true)
    expect(byKey("DELETE /api/admin/subscription-plans").query!.safeParse({ id: PLAN }).success).toBe(true)
    const momo = byKey("POST /api/admin/momo-claims").body!
    const settings = {
      enabled: true, accounts: [{ network: "MTN", number: "0241234567" }], accountName: "Datagod", feeCustomerPercent: 1, feeDealerPercent: 0.5,
      minNet: 1, maxSent: 100, senderAllowlist: ["MobileMoney"], regressionThreshold: 1000, reviewThreshold: 50, dailyCap: 300,
    }
    expect(momo.safeParse(settings).success).toBe(true)
    expect(momo.safeParse({ ...settings, accounts: [{ network: "MTN", number: "233241234567" }] }).success).toBe(false)
    const { dailyCap: _omit, ...partial } = settings
    expect(momo.safeParse(partial).success).toBe(false) // a whole-form save
  })
})

// ---- card tests with a tiny fake db ----------------------------------------------------------------------------

type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  return {
    from(table: string) {
      const rows = tables[table] ?? []
      const filters: Array<(r: Row) => boolean> = []
      const b: any = {
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        limit() { return b },
        order() { return b },
        maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
        single() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: d.length ? null : { message: "none" } }) },
        then(res: any, rej: any) {
          const d = rows.filter((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: d, count: d.length, error: null }).then(res, rej)
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const brokenDb = { __broken: true, from() { throw new Error("db down") } } as unknown as SupabaseClient

const momoSettingRows = [
  { key: "momo_claim_enabled", value: { value: true } },
  { key: "momo_payment_accounts", value: { value: [{ network: "MTN", number: "0501112222" }] } },
  { key: "momo_account_name", value: { value: "Datagod Old" } },
  { key: "momo_claim_fee_customer", value: { value: 2 } },
  { key: "momo_claim_fee_dealer", value: { value: 1 } },
  { key: "momo_min_claimable", value: { value: 10 } },
  { key: "momo_max_claimable", value: { value: 2000 } },
  { key: "momo_sms_sender_allowlist", value: { value: ["MobileMoney"] } },
  { key: "momo_txid_regression_threshold", value: { value: 1000000 } },
  { key: "momo_auto_claim_review_threshold", value: { value: 500 } },
  { key: "momo_auto_claim_daily_cap", value: { value: 3000 } },
  { key: "momo_first_claim_review", value: { value: true } },
]

const cashbackStored = {
  enabled: false,
  surfaces: { dashboard: true, bots: false, storefront: false, api: false },
  rates: { "airtime_mtn:hubtel": 2 },
  shares: {
    airtime: { customer: 30, dealer: 40, storefrontCustomer: 30, storefrontShop: 30 },
    bundles: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
    bills: { customer: 0, dealer: 0, storefrontCustomer: 0, storefrontShop: 0 },
    overrides: {},
  },
}

const tables: Record<string, Row[]> = {
  users: [
    { id: U1, first_name: "Ama", last_name: "Mensah", phone_number: "0241234567", email: "leak@example.com", role: "user" },
    { id: U2, first_name: "Kofi", last_name: "Boateng", phone_number: "0551234567", email: "kofi@example.com", role: "dealer" },
  ],
  order_refunds: [
    { id: R1, order_table: "shop_orders", order_id: ORDER_ID, gateway: "paystack_payout", amount: 18, status: "awaiting_otp", destination_phone: "0241234567", prev_status: "pending", gateway_ref: "TRF_x" },
    { id: R2, order_table: "shop_orders", order_id: ORDER_ID, gateway: "moolre", amount: 15, status: "failed", destination_phone: "0241234567", prev_status: "pending" },
  ],
  withdrawal_requests: [
    { id: W1, shop_id: "s1", amount: 100, fee_amount: 1, net_amount: 99, status: "awaiting_transfer_otp", withdrawal_method: "momo", payout_provider: "paystack", account_details: { phone: "0551112222", network: "MTN", account_name: "Kofi B" } },
    { id: W2, shop_id: "s1", amount: 50, fee_amount: 0, net_amount: 50, status: "completed", withdrawal_method: "momo", account_details: { phone: "0551112222", network: "MTN" } },
  ],
  user_shops: [{ id: "s1", shop_name: "Kofi Shop", user_id: U2 }],
  admin_settings: [...momoSettingRows, { key: "commission_cashback_config", value: cashbackStored }],
  momo_transactions: [
    { transaction_id: "123456789012", status: "flagged", amount: 50, network: "MTN", session_id: SESSION, flag_reasons: ["first_claim"] },
    { transaction_id: "999999999999", status: "unparsed", amount: null, network: "MTN", session_id: null, flag_reasons: [] },
  ],
  wallet_topup_sessions: [{ id: SESSION, user_id: U1, amount: 50, fee: 1, net_amount: 49, status: "pending", expires_at: "2026-11-30T00:00:00Z" }],
  subscription_plans: [{ id: PLAN, name: "Gold", price: 20, duration_days: 30, is_active: false, description: "old" }],
  user_subscriptions: [{ id: "u-s1", plan_id: PLAN }, { id: "u-s2", plan_id: PLAN }],
}

const CARD_INPUTS: Record<string, { params?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown> }> = {
  "DELETE /api/admin/subscription-plans": { query: { id: PLAN } },
  "GET /api/admin/refunds/:id/gateway-status": { params: { id: R1 } },
  "GET /api/admin/withdrawals/moolre-balance": {},
  "GET /api/admin/withdrawals/paystack-balance": {},
  "PATCH /api/admin/momo-claims": { body: { action: "credit", transactionId: "123456789012", reason: "verified with statement" } },
  "PATCH /api/admin/momo-claims/sessions": { body: { action: "force_expire", id: SESSION } },
  "POST /api/admin/cashback/config": { body: { rates: { "airtime_mtn:hubtel": 3 }, enabled: true } },
  "POST /api/admin/momo-claims": {
    body: {
      enabled: true, accounts: [{ network: "MTN", number: "0209998888" }], accountName: "Datagod New", feeCustomerPercent: 3, feeDealerPercent: 1,
      minNet: 10, maxSent: 2000, senderAllowlist: ["MobileMoney"], regressionThreshold: 1000000, reviewThreshold: 500, dailyCap: 3000,
    },
  },
  "POST /api/admin/refunds": { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "moolre", amount: 18.5 } },
  "POST /api/admin/refunds/:id/cancel": { params: { id: R1 } },
  "POST /api/admin/refunds/:id/hubtel-never-paid": { params: { id: R1 }, body: { confirm: true } },
  "POST /api/admin/refunds/:id/otp": { params: { id: R1 }, body: {} },
  "POST /api/admin/refunds/:id/reconcile": { params: { id: R1 } },
  "POST /api/admin/refunds/:id/retry": { params: { id: R2 }, body: {} },
  "POST /api/admin/refunds/manual": { body: { table: "hubtel_bill_orders", orderId: BILL_ORDER_ID, note: "Sent GHS 20 by MoMo myself" } },
  "POST /api/admin/refunds/preview": { body: { table: "shop_orders", orderId: ORDER_ID } },
  "POST /api/admin/subscription-plans": { body: { id: PLAN, name: "Gold", price: 25, duration_days: 30 } },
  "POST /api/admin/withdrawals/recalibrate": {},
  "POST /api/admin/withdrawals/reset-processing": { body: { withdrawalId: W1 } },
  "POST /api/admin/withdrawals/submit-transfer-otp": { body: { withdrawalId: W1 } },
  "POST /api/admin/withdrawals/validate-name": { body: { withdrawalId: W1 } },
}

describe("money change cards", () => {
  const changes = MONEY_ENTRIES.filter((e) => e.kind === "change" && !e.typedCard)

  it("has a sample input for every card entry", () => {
    for (const e of changes) expect(CARD_INPUTS[key(e.method, e.path)], e.id).toBeTruthy()
  })

  it("every sample input is valid for the entry's own schema", () => {
    for (const e of changes) {
      const inp = CARD_INPUTS[key(e.method, e.path)]
      if (e.body) expect(e.body.safeParse(inp.body ?? {}).success, e.id).toBe(true)
      if (e.query) expect(e.query.safeParse(inp.query ?? {}).success, e.id).toBe(true)
    }
  })

  for (const e of changes) {
    const inp = CARD_INPUTS[key(e.method, e.path)] ?? {}
    it(`${e.id}: summary and at least one line, never echoes a code`, async () => {
      const c = await e.card!({ ...inp, body: { ...(inp.body ?? {}), otp: undefined } }, { db: fakeDb(tables), adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
      expect(JSON.stringify(c)).not.toContain("SECRET123")
    })
    it(`${e.id}: still returns a card when the database fails`, async () => {
      const c = await e.card!(inp, { db: brokenDb, adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
    })
  }

  const run = (k: string, input: any, db: SupabaseClient = fakeDb(tables)) => byKey(k).card!(input, { db, adminId: ADMIN })
  const text = async (k: string, input: any, db?: SupabaseClient) => JSON.stringify(await run(k, input, db))

  it("refund by MoMo payout shows whose money, the amount, the FULL destination number, the status change and the profit clawback", async () => {
    const c = await text("POST /api/admin/refunds", CARD_INPUTS["POST /api/admin/refunds"])
    expect(c).toContain("GHS 18.50")
    expect(c).toContain("GHS 20.00") // what the customer paid
    expect(c).toContain("0241234567") // full, not masked
    expect(c).toContain(ORDER_ID)
    expect(c).toContain("PSK_123")
    expect(c).toMatch(/Moolre/)
    expect(c).toMatch(/not taken from your request/)
    expect(c).toMatch(/Now \\"pending\\"/)
    expect(c).toMatch(/becomes \\"refunded\\"/)
    expect(c).toMatch(/Takes back GHS 3\.00/)
    expect(c).toMatch(/SMS/)
    expect(c).toMatch(/cannot be pulled back/)
  })

  it("refund to the wallet names the account that is credited; paystack names the reversal; manual says no money is sent", async () => {
    const w = await text("POST /api/admin/refunds", { body: { table: "orders", orderId: WALLET_ORDER_ID, gateway: "wallet", amount: 20 } })
    expect(w).toContain("Ama Mensah")
    expect(w).toContain(U1)
    expect(w).toMatch(/added to the Datagod wallet/)
    expect(w).toMatch(/in-app notice/)
    const p = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "paystack", amount: 20 } })
    expect(p).toMatch(/reversed by Paystack/)
    const m = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "manual", amount: 10, manualReference: "MOMO-77" } })
    expect(m).toMatch(/NO money is sent by the system/)
    expect(m).toContain("MOMO-77")
    const h = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "hubtel", amount: 10 } })
    expect(h).toMatch(/no Hubtel checkout payment/)
    const cw = await text("POST /api/admin/refunds", { body: { table: "hubtel_bill_orders", orderId: BILL_ORDER_ID, gateway: "wallet", amount: 20 } })
    expect(cw).toMatch(/have no wallet/)
    expect(byKey("POST /api/admin/withdrawals/approve").summary).toMatch(/default route/)
    const o = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "paystack_payout", amount: 10 } })
    expect(o).toMatch(/one-time code/)
  })

  it("refund card flags an amount above what was paid, a MoMo payout on a wallet-paid order and an unreadable order", async () => {
    const over = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: ORDER_ID, gateway: "moolre", amount: 25 } })
    expect(over).toMatch(/cannot exceed/)
    expect(over).toMatch(/refused/)
    const walletPay = await text("POST /api/admin/refunds", { body: { table: "orders", orderId: WALLET_ORDER_ID, gateway: "moolre", amount: 5 } })
    expect(walletPay).toMatch(/paid from a wallet/)
    const gone = await text("POST /api/admin/refunds", { body: { table: "shop_orders", orderId: "dddddddd-dddd-4ddd-8ddd-0000000000ff", gateway: "moolre", amount: 5 } })
    expect(gone).toMatch(/could not be read/)
    expect(gone).toContain("GHS 5.00")
  })

  it("manual commission refund shows the full paid amount, the paying number, the order status change and the note", async () => {
    const c = await text("POST /api/admin/refunds/manual", CARD_INPUTS["POST /api/admin/refunds/manual"])
    expect(c).toContain("GHS 20.00")
    expect(c).toContain("0551112222")
    expect(c).toMatch(/NO money is sent by the system/)
    expect(c).toContain("Sent GHS 20 by MoMo myself")
    expect(c).toMatch(/becomes \\"refunded\\"/)
  })

  it("retry shows the old refund, that it is a new payout, the number, and refuses a refund that is not failed", async () => {
    const c = await text("POST /api/admin/refunds/:id/retry", { params: { id: R2 }, body: {} })
    expect(c).toMatch(/NEW refund/)
    expect(c).toContain("GHS 15.00")
    expect(c).toContain("0241234567")
    const notFailed = await text("POST /api/admin/refunds/:id/retry", { params: { id: R1 }, body: { amount: 10 } })
    expect(notFailed).toMatch(/Only failed refunds can be retried/)
    expect(notFailed).toContain("GHS 10.00")
  })

  it("the refund code card shows the payout number and amount but not the code, and says it cannot be pulled back", async () => {
    const c = await text("POST /api/admin/refunds/:id/otp", { params: { id: R1 }, body: {} })
    expect(c).toContain("0241234567")
    expect(c).toContain("GHS 18.00")
    expect(c).toMatch(/secure box/)
    expect(c).toMatch(/cannot be pulled back/)
    const wrong = await text("POST /api/admin/refunds/:id/otp", { params: { id: R2 }, body: {} })
    expect(wrong).toMatch(/not waiting for a code/)
  })

  it("cancel and reconcile say what happens to the order, the shop profit and the customer", async () => {
    const cancel = await text("POST /api/admin/refunds/:id/cancel", { params: { id: R1 } })
    expect(cancel).toMatch(/restored/)
    expect(cancel).toMatch(/earlier status \(\\"pending\\"\)/) // the earlier order status
    const rec = await text("POST /api/admin/refunds/:id/reconcile", { params: { id: R1 } })
    expect(rec).toMatch(/refund SMS/)
    expect(rec).toMatch(/restored/)
    const never = await text("POST /api/admin/refunds/:id/hubtel-never-paid", { params: { id: R1 }, body: { confirm: true } })
    expect(never).toMatch(/not a Hubtel payout/)
    expect(never).toMatch(/TWICE/)
  })

  it("withdrawal cards show the FULL payout number, the amount, and the side effects", async () => {
    const otp = await text("POST /api/admin/withdrawals/submit-transfer-otp", { body: { withdrawalId: W1 } })
    expect(otp).toContain("0551112222")
    expect(otp).toContain("GHS 100.00")
    expect(otp).toContain("GHS 99.00")
    expect(otp).toContain("Kofi Shop")
    expect(otp).toMatch(/secure box/)
    expect(otp).toMatch(/shop owner is told/)
    const reset = await text("POST /api/admin/withdrawals/reset-processing", { body: { withdrawalId: W1 } })
    expect(reset).toContain("0551112222")
    expect(reset).toMatch(/TWICE/)
    expect(reset).toMatch(/not told/)
    const wrongState = await text("POST /api/admin/withdrawals/reset-processing", { body: { withdrawalId: W2 } })
    expect(wrongState).toMatch(/Only processing or awaiting-code/)
    const v = await text("POST /api/admin/withdrawals/validate-name", { body: { withdrawalId: W1 } })
    expect(v).toContain("0551112222")
    expect(v).toMatch(/Nothing is paid or changed/)
  })

  it("recalibrate counts the shops and says no money is sent", async () => {
    const c = await text("POST /api/admin/withdrawals/recalibrate", {})
    expect(c).toMatch(/Shops checked/)
    expect(c).toMatch(/No money is sent/)
  })

  it("cashback card shows old and new values, the effect and the audit record, and refuses an invalid patch", async () => {
    const c = await text("POST /api/admin/cashback/config", CARD_INPUTS["POST /api/admin/cashback/config"])
    expect(c).toContain("rates.airtime_mtn:hubtel")
    expect(c).toContain("2 -> 3")
    expect(c).toContain("off -> on")
    expect(c).toMatch(/new orders/)
    expect(c).toMatch(/audit log/)
    const bad = await text("POST /api/admin/cashback/config", {
      body: { shares: { airtime: { customer: 1, dealer: 1, storefrontCustomer: 80, storefrontShop: 40 } } },
    })
    expect(bad).toMatch(/must not exceed 100/)
    expect(bad).toMatch(/refused/)
    const same = await text("POST /api/admin/cashback/config", { body: { enabled: false } })
    expect(same).toMatch(/Nothing would change/)
  })

  it("momo settings card shows the FULL new payment account and old to new values, and the refusal rules", async () => {
    const c = await text("POST /api/admin/momo-claims", CARD_INPUTS["POST /api/admin/momo-claims"])
    expect(c).toContain("MTN 0501112222 -> MTN 0209998888")
    expect(c).toContain("2% -> 3%")
    expect(c).toContain("Datagod Old -> Datagod New")
    expect(c).toMatch(/customers are told to send money to/)
    const noMtn = await text("POST /api/admin/momo-claims", {
      body: { ...CARD_INPUTS["POST /api/admin/momo-claims"].body, accounts: [{ network: "Telecel", number: "0509998888" }] },
    })
    expect(noMtn).toMatch(/without an MTN payment account/)
    const lowMax = await text("POST /api/admin/momo-claims", { body: { ...CARD_INPUTS["POST /api/admin/momo-claims"].body, minNet: 100, maxSent: 50 } })
    expect(lowMax).toMatch(/below the smallest/)
    const unread = await text("POST /api/admin/momo-claims", CARD_INPUTS["POST /api/admin/momo-claims"], brokenDb)
    expect(unread).toMatch(/could not be read/)
  })

  it("momo credit names the customer, the amount, the fee note, the admin alert and refuses without a reason", async () => {
    const c = await text("PATCH /api/admin/momo-claims", CARD_INPUTS["PATCH /api/admin/momo-claims"])
    expect(c).toContain("Ama Mensah")
    expect(c).toContain(U1)
    expect(c).toContain("GHS 50.00")
    expect(c).toContain("GHS 49.00 is added") // the stored session quote, exactly as the RPC uses it
    expect(c).toMatch(/admins get an alert/)
    const act = byKey("PATCH /api/admin/momo-claims").body!
    expect(act.safeParse({ action: "credit", transactionId: "123456789012", reason: "x", amount: 10 }).success).toBe(false)
    expect(act.safeParse({ action: "assign", transactionId: "1", reason: "x", targetUserId: U2, amount: 10.005 }).success).toBe(false)
    expect(act.safeParse({ action: "assign", transactionId: "1", reason: "x", targetUserId: U2, amount: 10.5 }).success).toBe(true)
    const noQuote = await text("PATCH /api/admin/momo-claims", { body: { action: "assign", transactionId: "123456789012", targetUserId: U2, reason: "moved" } })
    expect(noQuote).toMatch(/claim fee/)
    expect(noQuote).toMatch(/1%/)
    expect(noQuote).toMatch(/exact net is worked out/)
    expect(noQuote).not.toMatch(/GHS 49\.00 is added/)
    const noReason = await text("PATCH /api/admin/momo-claims", { body: { action: "credit", transactionId: "123456789012" } })
    expect(noReason).toMatch(/reason is required/)
    const assign = await text("PATCH /api/admin/momo-claims", { body: { action: "assign", transactionId: "999999999999", targetUserId: U2, amount: 40, reason: "unreadable SMS" } })
    expect(assign).toContain("Kofi Boateng")
    expect(assign).toContain("GHS 40.00")
    expect(assign).toMatch(/1%/) // dealer fee
    const noAmount = await text("PATCH /api/admin/momo-claims", { body: { action: "assign", transactionId: "999999999999", targetUserId: U2, reason: "unreadable SMS" } })
    expect(noAmount).toMatch(/none given: the request is refused/)
    const void_ = await text("PATCH /api/admin/momo-claims", { body: { action: "void", transactionId: "123456789012" } })
    expect(void_).toMatch(/Only pending or unreadable/)
  })

  it("force-expire names the customer and amount and says no money moves", async () => {
    const c = await text("PATCH /api/admin/momo-claims/sessions", CARD_INPUTS["PATCH /api/admin/momo-claims/sessions"])
    expect(c).toContain("Ama Mensah")
    expect(c).toContain("GHS 50.00")
    expect(c).toMatch(/No money moves/)
  })

  it("plan save shows the FULL new price against the old, the on-sale default and what existing subscriptions keep", async () => {
    const c = await text("POST /api/admin/subscription-plans", CARD_INPUTS["POST /api/admin/subscription-plans"])
    expect(c).toContain("GHS 20.00 -> GHS 25.00")
    expect(c).toContain("no -> yes")
    expect(c).toMatch(/is_active was left out/)
    expect(c).toMatch(/already bought keep/)
    const created = await text("POST /api/admin/subscription-plans", { body: { name: "Silver", price: 9.5, duration_days: 7 } })
    expect(created).toMatch(/NEW plan/)
    expect(created).toContain("GHS 9.50")
  })

  it("plan delete counts the subscriptions on it", async () => {
    const c = await text("DELETE /api/admin/subscription-plans", CARD_INPUTS["DELETE /api/admin/subscription-plans"])
    expect(c).toContain("Gold")
    expect(c).toMatch(/Subscriptions on it/)
    expect(c).toContain("2")
    expect(c).toMatch(/likely to refuse/)
  })
})
