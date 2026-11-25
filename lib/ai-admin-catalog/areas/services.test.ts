import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { SERVICES_ENTRIES } from "./services"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import type { CatalogEntry, Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`
const byKey = (k: string): CatalogEntry => SERVICES_ENTRIES.find((e) => key(e.method, e.path) === k)!

const U1 = "11111111-1111-4111-8111-000000000001"
const U2 = "22222222-2222-4222-8222-000000000002"

const CATALOGUED = [
  "DELETE /api/admin/packages/delete",
  "DELETE /api/admin/ussd-shops/:id",
  "GET /api/admin/airtime/batches",
  "GET /api/admin/airtime/digiwapy-balance",
  "GET /api/admin/airtime/list",
  "GET /api/admin/airtime/settings",
  "GET /api/admin/hubtel-cs/config",
  "GET /api/admin/hubtel-cs/transactions",
  "GET /api/admin/packages/network-stock",
  "GET /api/admin/results-check-requests",
  "GET /api/admin/results-check-requests/admin-phones",
  "GET /api/admin/results-check-settings",
  "GET /api/admin/results-checker/inventory",
  "GET /api/admin/results-checker/list",
  "GET /api/admin/results-checker/settings",
  "GET /api/admin/shops",
  "GET /api/admin/shops/:shopId",
  "GET /api/admin/standard-bundles/config",
  "GET /api/admin/standard-bundles/orders",
  "GET /api/admin/text-to-buy",
  "GET /api/admin/text-to-buy/messages",
  "GET /api/admin/ussd-hubtel/callback-logs",
  "GET /api/admin/ussd-hubtel/callback-logs/:id",
  "GET /api/admin/ussd-hubtel/config",
  "GET /api/admin/ussd-hubtel/sessions",
  "GET /api/admin/ussd-hubtel/transactions",
  "GET /api/admin/ussd-shops",
  "GET /api/admin/ussd-shops/:id",
  "GET /api/admin/ussd/service-visibility",
  "GET /api/admin/utility-bills/config",
  "GET /api/admin/utility-bills/orders",
  "PATCH /api/admin/results-check-requests",
  "PATCH /api/admin/results-checker/inventory",
  "POST /api/admin/airtime/action",
  "POST /api/admin/airtime/auto-fulfill",
  "POST /api/admin/airtime/bulk-update-status",
  "POST /api/admin/airtime/hubtel-send",
  "POST /api/admin/airtime/sync-digiwapy",
  "POST /api/admin/hubtel-cs/check-status",
  "POST /api/admin/hubtel-cs/config",
  "POST /api/admin/hubtel-cs/refund",
  "POST /api/admin/hubtel-cs/resolve",
  "POST /api/admin/hubtel-cs/retry",
  "POST /api/admin/hubtel-cs/test-purchase",
  "POST /api/admin/packages",
  "POST /api/admin/packages/bulk-update-price",
  "POST /api/admin/packages/network-stock",
  "POST /api/admin/packages/toggle-availability",
  "POST /api/admin/results-checker/action",
  "POST /api/admin/shops/:shopId/balance-adjustment",
  "POST /api/admin/shops/approve",
  "POST /api/admin/shops/block",
  "POST /api/admin/shops/reject",
  "POST /api/admin/standard-bundles/config",
  "POST /api/admin/standard-bundles/dispatch",
  "POST /api/admin/standard-bundles/refund",
  "POST /api/admin/standard-bundles/resend",
  "POST /api/admin/standard-bundles/retry",
  "POST /api/admin/text-to-buy",
  "POST /api/admin/text-to-buy/try",
  "POST /api/admin/ussd-hubtel/config",
  "POST /api/admin/ussd-hubtel/resolve",
  "POST /api/admin/ussd-hubtel/retry-callback",
  "POST /api/admin/ussd-shops",
  "POST /api/admin/ussd-shops/:id/activate",
  "POST /api/admin/ussd-shops/:id/whatsapp-activate",
  "POST /api/admin/ussd-shops/:id/whatsapp-deactivate",
  "POST /api/admin/ussd/service-visibility",
  "POST /api/admin/utility-bills/config",
  "POST /api/admin/utility-bills/dispatch",
  "POST /api/admin/utility-bills/refund",
  "POST /api/admin/utility-bills/retry",
  "PUT /api/admin/airtime/settings",
  "PUT /api/admin/results-check-requests/admin-phones",
  "PUT /api/admin/results-check-settings",
  "PUT /api/admin/results-checker/settings",
  "PUT /api/admin/text-to-buy",
  "PUT /api/admin/ussd-shops/:id",
]

const EXCLUDED_HERE = ["GET /api/admin/packages", "GET /api/admin/airtime/digiwapy-debug", "GET /api/admin/ussd-hubtel/sessions/:sessionId"]

describe("services catalog coverage", () => {
  it("catalogues exactly the listed routes, registered in CATALOG, none pending or excluded", () => {
    expect(SERVICES_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    expect(CATALOGUED.length).toBe(78)
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
      expect(EXCLUDED.some((x) => key(x.method, x.path) === k), k).toBe(false)
    }
  })

  it("excluded rows are justified and out of PENDING and CATALOG", () => {
    for (const k of EXCLUDED_HERE) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).not.toContain(k)
      const row = EXCLUDED.find((x) => key(x.method, x.path) === k)
      expect(row?.reason.length ?? 0, k).toBeGreaterThan(20)
    }
  })

  it("leaves no services-area route in PENDING", () => {
    const area = /^(DELETE|GET|PATCH|POST|PUT) \/api\/admin\/(shops|ussd-shops|ussd|ussd-hubtel|text-to-buy|packages|standard-bundles|results-checker|results-check-requests|results-check-settings|utility-bills|airtime|hubtel-cs)(\/|$)/
    expect(PENDING.filter((k) => area.test(k))).toEqual([])
  })

  it("ids are unique and area is services", () => {
    const ids = SERVICES_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of SERVICES_ENTRIES) expect(e.area).toBe("services")
  })
})

describe("services catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of SERVICES_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of SERVICES_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card, every GET is a lookup", () => {
    for (const e of SERVICES_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      else expect(e.kind, e.id).toBe("lookup")
      if (e.kind === "change") expect(typeof e.card, e.id).toBe("function")
    }
  })

  it("lookups never keep secrets, tokens, keys, PINs, serials, message text or raw payloads", () => {
    for (const e of SERVICES_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/password|token|secret|hash|api_?key|payload|pin\b|serial|voucher_code|(^|[._\]])(raw|body|text)($|[._])/i)
      }
    }
    const inv = byKey("GET /api/admin/results-checker/inventory").resultKeep!.join(" ")
    expect(inv).not.toMatch(/pin|serial|code/i)
  })

  it("risk tiers: prices, purchases, refunds and fee grants are money; shop, ussd code, switches and numbers are danger", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const money = [
      "POST /api/admin/shops/:shopId/balance-adjustment", "POST /api/admin/packages", "DELETE /api/admin/packages/delete", "POST /api/admin/packages/bulk-update-price",
      "POST /api/admin/packages/toggle-availability", "POST /api/admin/ussd-shops/:id/activate", "POST /api/admin/ussd-shops/:id/whatsapp-activate",
      "POST /api/admin/ussd-shops/:id/whatsapp-deactivate", "POST /api/admin/standard-bundles/dispatch", "POST /api/admin/standard-bundles/retry",
      "POST /api/admin/standard-bundles/resend", "POST /api/admin/standard-bundles/refund", "POST /api/admin/utility-bills/dispatch", "POST /api/admin/utility-bills/retry",
      "POST /api/admin/utility-bills/refund", "POST /api/admin/hubtel-cs/check-status", "POST /api/admin/hubtel-cs/refund", "POST /api/admin/hubtel-cs/resolve",
      "POST /api/admin/hubtel-cs/retry", "POST /api/admin/hubtel-cs/test-purchase", "POST /api/admin/airtime/action", "POST /api/admin/airtime/bulk-update-status",
      "POST /api/admin/airtime/auto-fulfill", "POST /api/admin/airtime/hubtel-send", "POST /api/admin/airtime/sync-digiwapy", "PUT /api/admin/airtime/settings",
      "POST /api/admin/results-checker/action", "PUT /api/admin/results-checker/settings", "PATCH /api/admin/results-checker/inventory", "PUT /api/admin/results-check-settings",
      "POST /api/admin/ussd-hubtel/resolve", "POST /api/admin/ussd-hubtel/retry-callback",
    ]
    const danger = [
      "POST /api/admin/shops/approve", "POST /api/admin/shops/reject", "POST /api/admin/shops/block", "POST /api/admin/ussd-shops", "PUT /api/admin/ussd-shops/:id",
      "DELETE /api/admin/ussd-shops/:id", "POST /api/admin/ussd/service-visibility", "POST /api/admin/ussd-hubtel/config", "PUT /api/admin/text-to-buy", "POST /api/admin/text-to-buy",
      "POST /api/admin/packages/network-stock", "POST /api/admin/standard-bundles/config", "POST /api/admin/utility-bills/config", "POST /api/admin/hubtel-cs/config",
      "PUT /api/admin/results-check-requests/admin-phones",
    ]
    for (const k of money) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.money)
    for (const k of danger) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.danger)
  })

  it("auth: the ussd-shops routes do their own bearer check (other); everything else uses verifyAdminAccess", () => {
    for (const e of SERVICES_ENTRIES) expect(e.auth, e.id).toBe(e.path.startsWith("/api/admin/ussd-shops") ? "other" : "admin")
  })

  it("timeouts stay within 60 s and provider-calling routes are given time", () => {
    for (const e of SERVICES_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
    for (const k of ["POST /api/admin/hubtel-cs/retry", "POST /api/admin/hubtel-cs/test-purchase", "POST /api/admin/airtime/hubtel-send", "POST /api/admin/utility-bills/dispatch", "POST /api/admin/standard-bundles/dispatch", "POST /api/admin/packages/bulk-update-price"]) {
      expect(byKey(k).timeoutMs, k).toBeGreaterThanOrEqual(30000)
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of SERVICES_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("no secret input fields are needed here and none appears in a schema", () => {
    for (const e of SERVICES_ENTRIES) {
      expect(e.secretFields, e.id).toBeUndefined()
      for (const schema of [e.query, e.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, e.id).not.toMatch(/secret|api_?key|token|password/i)
      }
    }
  })

  it("schemas mirror the handlers", () => {
    const pkg = byKey("POST /api/admin/packages").body!
    expect(pkg.safeParse({ packageData: { name: "1GB", network: "MTN", size: "1GB", price: 5 } }).success).toBe(true)
    expect(pkg.safeParse({ packageData: { network: "Vodafone" } }).success).toBe(false)
    expect(pkg.safeParse({ packageData: { price: -1 } }).success).toBe(false)
    expect(pkg.safeParse({ packageData: { is_available: true } }).success).toBe(false)
    expect(byKey("POST /api/admin/packages/bulk-update-price").body!.safeParse({ packageIds: [U1], updates: { price: { mode: "per_gb", value: 4.5 } } }).success).toBe(true)
    expect(byKey("POST /api/admin/packages/bulk-update-price").body!.safeParse({ packageIds: [], updates: {} }).success).toBe(false)
    expect(byKey("POST /api/admin/hubtel-cs/test-purchase").body!.safeParse({ confirm: true, serviceKey: "airtime_mtn", amount: 1, destination: "0241234567" }).success).toBe(true)
    expect(byKey("POST /api/admin/hubtel-cs/test-purchase").body!.safeParse({ confirm: true, serviceKey: "airtime_mtn", amount: 6, destination: "0241234567" }).success).toBe(false)
    expect(byKey("POST /api/admin/hubtel-cs/test-purchase").body!.safeParse({ confirm: false, serviceKey: "airtime_mtn", amount: 1, destination: "0241234567" }).success).toBe(false)
    expect(byKey("POST /api/admin/hubtel-cs/resolve").body!.safeParse({ ref: "ab-12", outcome: "failed", note: "checked" }).success).toBe(true)
    expect(byKey("POST /api/admin/hubtel-cs/resolve").body!.safeParse({ ref: "ab 12", outcome: "failed", note: "checked" }).success).toBe(false)
    expect(byKey("POST /api/admin/ussd-hubtel/resolve").body!.safeParse({ sessionId: "s1", outcome: "fulfilled", note: "abc" }).success).toBe(false)
    expect(byKey("POST /api/admin/ussd-hubtel/config").body!.safeParse({ brandName: "Café" }).success).toBe(false)
    expect(byKey("POST /api/admin/ussd-hubtel/config").body!.safeParse({ line: "main", walletPayment: true }).success).toBe(true)
    expect(byKey("PUT /api/admin/airtime/settings").body!.safeParse({ settings: { airtime_provider_mtn: { provider: "hubtel" } } }).success).toBe(true)
    expect(byKey("PUT /api/admin/airtime/settings").body!.safeParse({ settings: { airtime_provider_mtn: { provider: "evil" } } }).success).toBe(false)
    expect(byKey("PUT /api/admin/airtime/settings").body!.safeParse({ settings: { some_other_key: { x: 1 } } }).success).toBe(false)
    expect(byKey("PUT /api/admin/results-checker/settings").body!.safeParse({ settings: { results_checker_price_wassce: { price: 20 } } }).success).toBe(true)
    expect(byKey("POST /api/admin/results-checker/action").body!.safeParse({ orderId: U1, action: "deliver" }).success).toBe(true)
    expect(byKey("POST /api/admin/results-checker/action").body!.safeParse({ orderId: U1, action: "pin" }).success).toBe(false)
    expect(byKey("POST /api/admin/shops/:shopId/balance-adjustment").body!.safeParse({ amount: 0, type: "credit" }).success).toBe(false)
    expect(byKey("POST /api/admin/standard-bundles/config").body!.safeParse({ networks: { MTN: { enabled: true, hiddenCategories: [], referenceNumber: "233246912184" } } }).success).toBe(true)
    expect(byKey("POST /api/admin/standard-bundles/config").body!.safeParse({ networks: { MTN: { enabled: true, hiddenCategories: [], referenceNumber: "0246912184" } } }).success).toBe(false)
    expect(byKey("POST /api/admin/utility-bills/config").body!.safeParse({ billers: { ecg: { enabled: true, min: 5, max: 500 } } }).success).toBe(true)
    expect(byKey("POST /api/admin/utility-bills/config").body!.safeParse({ billers: { water2: { enabled: true, min: 5, max: 500 } } }).success).toBe(false)
    expect(byKey("PUT /api/admin/text-to-buy").body!.safeParse({ promptsPerHour: 99 }).success).toBe(false)
    expect(byKey("PUT /api/admin/text-to-buy").body!.safeParse({ promptsPerHour: 5, confirm: true }).success).toBe(true)
    expect(byKey("POST /api/admin/shops/block").body!.safeParse({ shopId: U1, action: "block", reason: "fraud" }).success).toBe(true)
    expect(byKey("POST /api/admin/shops/block").body!.safeParse({ shopId: U1, action: "freeze" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/results-check-requests").body!.safeParse({ id: U1, media_url: "http://x.test/a.png" }).success).toBe(false)
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
        is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
        maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
        then(res: any, rej: any) {
          const d = rows.filter((r) => filters.every((f) => f(r)))
          return Promise.resolve({ data: d, count: d.length, error: null }).then(res, rej)
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const brokenDb = { from() { throw new Error("db down") } } as unknown as SupabaseClient

const tables: Record<string, Row[]> = {
  user_shops: [{ id: U1, shop_name: "Kofi Data", shop_slug: "kofi", is_active: true, is_blocked: false, user_id: U2 }],
  shop_available_balance: [{ shop_id: U1, available_balance: 50 }],
  ussd_shop_codes: [{ id: U1, code: "4321", status: "active", activation_fee_paid: false, whatsapp_activated: false, shop_id: U1 }],
  packages: [
    { id: U1, name: "1GB", network: "MTN", size: "1GB", price: 5, dealer_price: 4, active: true, is_available: true },
    { id: U2, name: "2GB", network: "MTN", size: "2GB", price: 10, dealer_price: 8, active: true, is_available: true },
  ],
  package_costs: [{ package_id: U1, cost_price: 3.5 }],
  hubtel_bill_orders: [{ id: U1, reference_code: "BILL-1", biller: "ecg", account_number: "0123456789", phone: "0241234567", amount: 120, paid_amount: 121, status: "failed", payment_status: "paid", user_id: U2 }],
  hubtel_data_orders: [{ id: U1, reference_code: "DATA-1", network: "MTN", bundle_display: "1GB", beneficiary_phone: "0241112222", amount: 6, paid_amount: 6, status: "pending", payment_status: "paid", user_id: U2 }],
  airtime_orders: [{ id: U1, reference_code: "AIR-1", network: "MTN", beneficiary_phone: "0243334444", airtime_amount: 10, total_paid: 10.5, status: "pending", payment_status: "completed", user_id: U2 }],
  hubtel_cs_transactions: [{ client_reference: "ref-1", service_key: "airtime_mtn", destination: "0245556666", amount: 7, state: "failed" }],
  results_checker_orders: [{ id: U1, reference_code: "RC-1", exam_board: "WASSCE", status: "pending", payment_status: "completed", total_paid: 25, user_id: U2 }],
  admin_settings: [{ key: "results_check_settings", value: { enabled: true, fee: 2 } }],
}
const db = fakeDb(tables)
const ctx = { db, adminId: U2 }
const text = (c: { summary: string; lines: { label: string; value: string }[] }) => [c.summary, ...c.lines.map((l) => `${l.label}: ${l.value}`)].join("\n")

async function card(k: string, input: Parameters<NonNullable<CatalogEntry["card"]>>[0], useCtx = ctx) {
  const e = byKey(k)
  const c = await e.card!(input, useCtx)
  expect(c.summary.length, k).toBeGreaterThan(0)
  expect(c.lines.length, k).toBeGreaterThanOrEqual(1)
  return text(c)
}

describe("services cards", () => {
  it("every change card still answers when the database is down", async () => {
    const inputs: Record<string, any> = {
      "POST /api/admin/shops/:shopId/balance-adjustment": { params: { shopId: U1 }, body: { amount: 5, type: "credit" } },
      "POST /api/admin/packages/bulk-update-price": { body: { packageIds: [U1], updates: { price: { mode: "percentage", value: 10 } } } },
      "POST /api/admin/airtime/bulk-update-status": { body: { orderIds: [U1], status: "completed" } },
    }
    for (const e of SERVICES_ENTRIES.filter((x) => x.kind === "change")) {
      const input = inputs[key(e.method, e.path)] ?? { params: Object.fromEntries(Object.keys(e.params ?? {}).map((p) => [p, U1])), body: {} }
      const c = await e.card!(input, { db: brokenDb, adminId: U2 })
      expect(c.lines.length, e.id).toBeGreaterThanOrEqual(1)
    }
  })

  it("shop balance adjustment shows shop, amount, direction and the new balance", async () => {
    const t = await card("POST /api/admin/shops/:shopId/balance-adjustment", { params: { shopId: U1 }, body: { amount: 20, type: "debit" } })
    expect(t).toContain("Kofi Data")
    expect(t).toContain("DEBIT")
    expect(t).toContain("GHS 20.00")
    expect(t).toContain("GHS 50.00 -> GHS 30.00")
    expect(t).toContain("below zero")
  })

  it("shop block says what is sent and that a reason is needed; reject says it switches off an active shop", async () => {
    const t = await card("POST /api/admin/shops/block", { body: { shopId: U1, action: "block" } })
    expect(t).toContain("required to block")
    expect(t).toContain("SMS")
    const r = await card("POST /api/admin/shops/reject", { body: { shopId: U1 } })
    expect(r).toContain("even if it is live")
    expect(r).toContain("SMS")
  })

  it("ussd activation says the fee is marked paid without payment and who is emailed", async () => {
    const t = await card("POST /api/admin/ussd-shops/:id/activate", { params: { id: U1 } })
    expect(t).toContain("without any payment")
    expect(t).toContain("4321")
    expect(t).toContain("email")
  })

  it("package price edit shows old -> new price and the new supplier cost, and a bare isUpdate is called a create", async () => {
    const t = await card("POST /api/admin/packages", { body: { packageData: { price: 6.5, cost_price: 4 }, packageId: U1, isUpdate: true } })
    expect(t).toContain("price: GHS 5.00 -> GHS 6.50")
    expect(t).toContain("GHS 3.50 -> GHS 4.00")
    const c = await card("POST /api/admin/packages", { body: { packageData: { name: "9GB", network: "MTN", size: "9GB", price: 40 }, isUpdate: true } })
    expect(c).toContain("CREATES A NEW package")
  })

  it("bulk price card lists every package old -> new price", async () => {
    const t = await card("POST /api/admin/packages/bulk-update-price", { body: { packageIds: [U1, U2], updates: { price: { mode: "percentage", value: 10 } } } })
    expect(t).toContain("GHS 5.00 -> GHS 5.50")
    expect(t).toContain("GHS 10.00 -> GHS 11.00")
  })

  it("purchase cards show the full recipient, meter or account and the amount", async () => {
    const bill = await card("POST /api/admin/utility-bills/dispatch", { body: { orderId: U1 } })
    expect(bill).toContain("0123456789")
    expect(bill).toContain("GHS 120.00")
    const retry = await card("POST /api/admin/utility-bills/retry", { body: { orderId: U1 } })
    expect(retry).toContain("0123456789")
    const bundle = await card("POST /api/admin/standard-bundles/retry", { body: { orderId: U1 } })
    expect(bundle).toContain("0241112222")
    expect(bundle).toContain("1GB")
    const air = await card("POST /api/admin/airtime/hubtel-send", { body: { orderId: U1 } })
    expect(air).toContain("0243334444")
    expect(air).toContain("GHS 10.00")
    const cs = await card("POST /api/admin/hubtel-cs/retry", { body: { ref: "ref-1" } })
    expect(cs).toContain("0245556666")
    expect(cs).toContain("GHS 7.00")
    const test = await card("POST /api/admin/hubtel-cs/test-purchase", { body: { confirm: true, serviceKey: "bill_ecg", amount: 2, destination: "0123456789" } })
    expect(test).toContain("0123456789")
    expect(test).toContain("REAL purchase")
  })

  it("refund cards state the amount and where it goes", async () => {
    const b = await card("POST /api/admin/utility-bills/refund", { body: { orderId: U1, note: "never sent", force: true } })
    expect(b).toContain("GHS 121.00")
    expect(b).toContain("FORCE")
    const d = await card("POST /api/admin/standard-bundles/refund", { body: { orderId: U1, note: "never sent" } })
    expect(d).toContain("GHS 6.00")
    expect(d).toContain("wallet")
    const c = await card("POST /api/admin/hubtel-cs/refund", { body: { ref: "ref-1" } })
    expect(c).toContain("GHS 7.00")
  })

  it("airtime action names the refund, the commission and the customer notices", async () => {
    const t = await card("POST /api/admin/airtime/action", { body: { orderId: U1, action: "failed" } })
    expect(t).toContain("refunded their full payment")
    expect(t).toContain("commission")
    const ok = await card("POST /api/admin/airtime/action", { body: { orderId: U1, action: "completed" } })
    expect(ok).toContain("SMS")
    expect(ok).toContain("Nothing is sent to the network")
  })

  it("results checker deliver names the order and board, never a PIN or serial", async () => {
    const t = await card("POST /api/admin/results-checker/action", { body: { orderId: U1, action: "deliver" } })
    expect(t).toContain("RC-1")
    expect(t).toContain("WASSCE")
    expect(t).toMatch(/PINs are not shown/)
    expect(t).not.toMatch(/serial:|pin:/i)
    const f = await card("POST /api/admin/results-checker/action", { body: { orderId: U1, action: "refund" } })
    expect(f).toContain("GHS 25.00")
  })

  it("settings cards show old -> new", async () => {
    const t = await card("PUT /api/admin/results-check-settings", { body: { fee: 3.5 } })
    expect(t).toContain("GHS 2.00 -> GHS 3.50")
    const none = await card("PUT /api/admin/results-check-settings", { body: {} })
    expect(none).toContain("Nothing to change")
  })

  it("text-to-buy card refuses silently-missing confirm and shows numbers in full", async () => {
    const t = await card("PUT /api/admin/text-to-buy", { body: { mainEnabled: true, mainNumber: "0241234567" } })
    expect(t).toContain("0241234567")
    expect(t).toContain("needs confirm to be true")
    const a = await card("POST /api/admin/text-to-buy", { body: { action: "block", sender: "0249998888" } })
    expect(a).toContain("0249998888")
  })

  it("admin phones card shows the full new numbers", async () => {
    const t = await card("PUT /api/admin/results-check-requests/admin-phones", { body: { phones: ["0241230000", "0542221111"] } })
    expect(t).toContain("0241230000, 0542221111")
  })

  it("no card ever echoes a PIN-like field from rows it reads", async () => {
    const withPins = fakeDb({ results_checker_orders: [{ ...tables.results_checker_orders[0], pin: "SECRETPIN99", serial_number: "SER123" }] })
    const t = await card("POST /api/admin/results-checker/action", { body: { orderId: U1, action: "deliver" } }, { db: withPins, adminId: U2 })
    expect(t).not.toContain("SECRETPIN99")
    expect(t).not.toContain("SER123")
  })
})

describe("services cards name the values the request will send", () => {
  const rich = fakeDb({
    ...tables,
    ussd_shop_orders: [{ id: U1, shop_code_id: U1, order_status: "pending" }, { id: U2, shop_code_id: U1, order_status: "processing" }],
    results_check_requests: [{ id: U1, exam_board: "WASSCE", index_number: "1234567890", status: "pending", channel: "web", payment_status: "paid" }],
    admin_settings: [
      { key: "results_check_settings", value: { enabled: true, fee: 2 } },
      { key: "ttb_main_enabled", value: { value: true } },
      { key: "ttb_shop_enabled", value: { value: false } },
      { key: "standard_bundles_config", value: { enabled: false, networks: { MTN: { enabled: false } }, special: { enabled: false, unitAmount: 3 } } },
      { key: "utility_bills_config", value: { enabled: false, autoFulfil: true, billers: { ecg: { enabled: false, min: 5, max: 10000 } } } },
      { key: "hubtel_cs_config", value: { enabled: false, mode: "relay", services: { airtime_mtn: true } } },
    ],
  })
  const rctx = { db: rich, adminId: U2 }
  const run = (k: string, input: any) => card(k, input, rctx)

  it("shops.approve names the shop", async () => {
    const t = await run("POST /api/admin/shops/approve", { body: { shopId: U1 } })
    expect(t).toContain("Kofi Data")
    expect(t).toContain("11111111")
  })

  it("ussd shop create / update / delete show the code and shop", async () => {
    const c = await run("POST /api/admin/ussd-shops", { body: { shop_id: U1, code: "7777" } })
    expect(c).toContain("Kofi Data")
    expect(c).toContain("7777")
    const u = await run("PUT /api/admin/ussd-shops/:id", { params: { id: U1 }, body: { code: "9999", status: "suspended" } })
    expect(u).toContain("4321 -> 9999")
    expect(u).toContain("active -> suspended")
    const d = await run("DELETE /api/admin/ussd-shops/:id", { params: { id: U1 } })
    expect(d).toContain("4321")
    expect(d).toContain("Orders still pending or processing: 2")
  })

  it("airtime bulk and auto cards list each order's number and amount", async () => {
    const bulk = await run("POST /api/admin/airtime/bulk-update-status", { body: { orderIds: [U1], status: "failed" } })
    expect(bulk).toContain("AIR-1")
    expect(bulk).toContain("0243334444")
    expect(bulk).toContain("GHS 10.00")
    expect(bulk).toContain("FAILED")
    const auto = await run("POST /api/admin/airtime/auto-fulfill", { body: { orderIds: [U1] } })
    expect(auto).toContain("0243334444")
    expect(auto).toContain("GHS 10.00")
  })

  it("config cards show old -> new for the keys sent", async () => {
    const sb = await run("POST /api/admin/standard-bundles/config", {
      body: { enabled: true, networks: { MTN: { enabled: true, hiddenCategories: ["Video"], referenceNumber: "233246912184" } }, special: { enabled: true, multiples: [3, 5], unitAmount: 4, unitValue: "RACT_X", ussdEnabled: false } },
    })
    expect(sb).toContain("OFF -> ON")
    expect(sb).toContain("233246912184")
    expect(sb).toContain("Video")
    expect(sb).toContain("GHS 3.00 -> GHS 4.00")
    expect(sb).toContain("RACT_X")
    const ub = await run("POST /api/admin/utility-bills/config", { body: { enabled: true, billers: { ecg: { enabled: true, min: 10, max: 500 } } } })
    expect(ub).toContain("OFF -> ON")
    expect(ub).toContain("ecg")
    expect(ub).toContain("GHS 5.00 to GHS 10000.00 -> GHS 10.00 to GHS 500.00")
    const cs = await run("POST /api/admin/hubtel-cs/config", { body: { enabled: true, mode: "direct", lowBalanceThreshold: 250, services: { airtime_mtn: false } } })
    expect(cs).toContain("OFF -> ON")
    expect(cs).toContain("relay -> direct")
    expect(cs).toContain("GHS 250.00")
    expect(cs).toContain("Service airtime_mtn: ON -> OFF")
  })

  it("text-to-buy asks for confirm only when a switch really changes", async () => {
    const same = await run("PUT /api/admin/text-to-buy", { body: { mainEnabled: true } })
    expect(same).not.toContain("needs confirm")
    const turnsOn = await run("PUT /api/admin/text-to-buy", { body: { shopEnabled: true } })
    expect(turnsOn).toContain("needs confirm to be true")
    const confirmed = await run("PUT /api/admin/text-to-buy", { body: { shopEnabled: true, confirm: true } })
    expect(confirmed).not.toContain("Refused")
    const tr = await run("POST /api/admin/text-to-buy/try", { body: { line: "shop", sender: "0241230000", text: "mtn 1gb 0241112222" } })
    expect(tr).toContain("0241230000")
    expect(tr).toContain("mtn 1gb 0241112222")
  })

  it("results check request update shows status, result text and the paid delivery", async () => {
    const e = byKey("PATCH /api/admin/results-check-requests")
    expect(e.risk).toBe("money")
    const t = await run("PATCH /api/admin/results-check-requests", { body: { id: U1, status: "completed", result_data: "Maths A1", deliver: true } })
    expect(t).toContain("1234567890")
    expect(t).toContain("pending -> completed")
    expect(t).toContain("Maths A1")
    expect(t).toContain("PAID results")
  })

  it("bulk price refuses a per-GB price of zero or less", () => {
    const b = byKey("POST /api/admin/packages/bulk-update-price").body!
    expect(b.safeParse({ packageIds: [U1], updates: { price: { mode: "per_gb", value: 0 } } }).success).toBe(false)
    expect(b.safeParse({ packageIds: [U1], updates: { dealer_price: { mode: "per_gb", value: -2 } } }).success).toBe(false)
    expect(b.safeParse({ packageIds: [U1], updates: { price: { mode: "percentage", value: -10 } } }).success).toBe(true)
  })
})
