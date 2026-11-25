import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { FULFILLMENT_ENTRIES } from "./fulfillment"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import type { Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`

const CATALOGUED = [
  "DELETE /api/admin/blacklist",
  "DELETE /api/admin/fulfillment/logs",
  "DELETE /api/admin/fulfillment/mtn-logs",
  "GET /api/admin/agentportalgh",
  "GET /api/admin/apexprime",
  "GET /api/admin/auto-fulfil",
  "GET /api/admin/blacklist",
  "GET /api/admin/blocked-numbers",
  "GET /api/admin/bundleportal",
  "GET /api/admin/datakazina",
  "GET /api/admin/fulfillment/bisdel-products",
  "GET /api/admin/fulfillment/eazyghdata-packages",
  "GET /api/admin/fulfillment/logs",
  "GET /api/admin/fulfillment/manual-fulfill",
  "GET /api/admin/fulfillment/mtn-balance",
  "GET /api/admin/fulfillment/mtn-logs",
  "GET /api/admin/fulfillment/queue-status",
  "GET /api/admin/fulfillment/retry-blacklisted",
  "GET /api/admin/hubnet",
  "GET /api/admin/kuntanii",
  "GET /api/admin/mtn-registration/list",
  "GET /api/admin/phone-verifications/reset",
  "GET /api/admin/phone-verify/session/:id",
  "GET /api/admin/phone-verify/whitelist-availability",
  "POST /api/admin/agentportalgh",
  "POST /api/admin/apexprime",
  "POST /api/admin/blacklist",
  "POST /api/admin/blacklist/bulk",
  "POST /api/admin/blocked-numbers/update",
  "POST /api/admin/bundleportal",
  "POST /api/admin/datakazina",
  "POST /api/admin/fulfillment/approval-preview",
  "POST /api/admin/fulfillment/bisdel-products",
  "POST /api/admin/fulfillment/eazyghdata-packages",
  "POST /api/admin/fulfillment/enqueue",
  "POST /api/admin/fulfillment/manual-fulfill",
  "POST /api/admin/fulfillment/retry-blacklisted",
  "POST /api/admin/fulfillment/sync-codecraft",
  "POST /api/admin/fulfillment/sync-status",
  "POST /api/admin/fulfillment/verify-whitelist",
  "POST /api/admin/kuntanii",
  "POST /api/admin/mtn-registration/mark-registered",
  "POST /api/admin/mtn-registration/release-held",
  "POST /api/admin/phone-verifications/reset",
  "POST /api/admin/phone-verify/process",
  "PUT /api/admin/agentportalgh",
  "PUT /api/admin/auto-fulfil",
  "PUT /api/admin/fulfillment/bisdel-products",
]

const EXCLUDED_ROUTES: Array<[string, RegExp]> = [
  ["POST /api/admin/afa-fulfillment", /use the page/],
  ["GET /api/admin/afa-registrations", /one auth lookup per row.*use the page/],
  ["POST /api/admin/blocked-numbers/check-all", /use the page/],
  ["POST /api/admin/blocked-numbers/recheck", /use the page/],
  ["POST /api/admin/fulfillment/bulk-manual-fulfill", /use the page/],
  ["POST /api/admin/mtn-whitelist/batch-verify", /use the page/],
  ["GET /api/admin/phone-verify/sessions", /array/],
]

const byKey = (k: string) => FULFILLMENT_ENTRIES.find((e) => key(e.method, e.path) === k)!

describe("fulfillment catalog coverage", () => {
  it("catalogues exactly the listed routes and registers them in CATALOG", () => {
    expect(FULFILLMENT_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
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

  it("ids are unique and area is fulfillment", () => {
    const ids = FULFILLMENT_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of FULFILLMENT_ENTRIES) expect(e.area).toBe("fulfillment")
  })
})

describe("fulfillment catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of FULFILLMENT_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of FULFILLMENT_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of FULFILLMENT_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("lookups have resultKeep, writes are changes", () => {
    for (const e of FULFILLMENT_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
    }
  })

  it("GETs that call a supplier or write are changes", () => {
    for (const k of [
      "GET /api/admin/fulfillment/mtn-balance",
      "GET /api/admin/hubnet",
      "GET /api/admin/apexprime",
      "GET /api/admin/bundleportal",
      "GET /api/admin/agentportalgh",
    ]) {
      expect(byKey(k).kind, k).toBe("change")
    }
  })

  it("lookups never keep contact details, secrets or raw payloads", () => {
    for (const e of FULFILLMENT_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        // The blacklist list is a list of phone numbers by design; everything else must stay phone-free.
        if (e.id === "blacklist.list" && p === "data[].phone_number") continue
        expect(p, e.id).not.toMatch(/phone|email|token|secret|password|api_key|payload|webhook/i)
      }
    }
  })

  it("no body or query field is a key or secret, and none needs the secure box", () => {
    for (const e of FULFILLMENT_ENTRIES) {
      expect(e.secretFields ?? [], e.id).toEqual([])
      for (const schema of [e.query, e.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, e.id).not.toMatch(/secret|api_?key|token|password/i)
      }
    }
  })

  it("keeps secret-bearing provider actions out of the schemas", () => {
    // Bundle Portal register-webhook returns a one-time webhook secret; AgentPortalGH can regenerate one.
    expect(byKey("POST /api/admin/bundleportal").body!.safeParse({ action: "register-webhook", webhookUrl: "https://x.test" }).success).toBe(false)
    expect(byKey("PUT /api/admin/agentportalgh").body!.safeParse({ url: "https://x.test/h", enabled: true, regenerate_secret: true }).success).toBe(false)
    expect(byKey("GET /api/admin/agentportalgh").query!.safeParse({ action: "webhook-config" }).success).toBe(false)
    expect(byKey("GET /api/admin/agentportalgh").query!.safeParse({ action: "balance" }).success).toBe(true)
  })

  it("agentportalgh webhook url is limited to our own webhook route", () => {
    const body = byKey("PUT /api/admin/agentportalgh").body!
    const ok = (url: string) => body.safeParse({ url, enabled: true }).success
    expect(ok("https://www.datagod.store/api/webhooks/mtn/agentportalgh")).toBe(true)
    expect(ok("https://datagod.store/api/webhooks/mtn/agentportalgh")).toBe(true)
    expect(ok("https://evil.example/api/webhooks/mtn/agentportalgh")).toBe(false)
    expect(ok("http://www.datagod.store/api/webhooks/mtn/agentportalgh")).toBe(false)
    expect(ok("https://www.datagod.store/api/webhooks/mtn/agentportalgh?x=1")).toBe(false)
    expect(ok("https://www.datagod.store/api/webhooks/mtn/xpress")).toBe(false)
    expect(ok("https://www.datagod.store.evil.example/api/webhooks/mtn/agentportalgh")).toBe(false)
  })

  it("webhook-resend id is a plain token or positive number", () => {
    const body = byKey("POST /api/admin/agentportalgh").body!
    const ok = (id: unknown) => body.safeParse({ id }).success
    expect(ok("abc_12-3")).toBe(true)
    expect(ok(42)).toBe(true)
    expect(ok("../wallet/topup")).toBe(false)
    expect(ok("a?b=1")).toBe(false)
    expect(ok(-1)).toBe(false)
    expect(ok(1.5)).toBe(false)
  })

  it("kuntanii lookup requires the tracking id", () => {
    const q = byKey("GET /api/admin/kuntanii").query!
    expect(q.safeParse({ action: "disputes" }).success).toBe(false)
    expect(q.safeParse({ action: "disputes", trackingId: U1 }).success).toBe(true)
  })

  it("sync-status cannot start the bulk sync from the assistant", () => {
    const body = byKey("POST /api/admin/fulfillment/sync-status").body!
    expect(body.safeParse({ sync_all_pending: true }).success).toBe(false)
  })

  it("risk tiers are at least the table's", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const min: Record<string, Risk> = {
      "POST /api/admin/fulfillment/manual-fulfill": "money",
      "POST /api/admin/fulfillment/enqueue": "money",
      "POST /api/admin/fulfillment/retry-blacklisted": "money",
      "POST /api/admin/fulfillment/sync-status": "money",
      "POST /api/admin/fulfillment/sync-codecraft": "money",
      "POST /api/admin/mtn-registration/mark-registered": "money",
      "POST /api/admin/mtn-registration/release-held": "money",
      "DELETE /api/admin/blacklist": "money",
      "POST /api/admin/agentportalgh": "money",
      "PUT /api/admin/auto-fulfil": "danger",
      "PUT /api/admin/fulfillment/bisdel-products": "danger",
      "POST /api/admin/apexprime": "danger",
      "POST /api/admin/bundleportal": "danger",
      "POST /api/admin/datakazina": "danger",
      "POST /api/admin/kuntanii": "danger",
      "PUT /api/admin/agentportalgh": "danger",
      "DELETE /api/admin/fulfillment/logs": "danger",
      "DELETE /api/admin/fulfillment/mtn-logs": "danger",
      "POST /api/admin/phone-verifications/reset": "danger",
    }
    for (const [k, r] of Object.entries(min)) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank[r])
  })

  it("auth is admin for every route", () => {
    for (const e of FULFILLMENT_ENTRIES) expect(e.auth, e.id).toBe("admin")
  })

  it("supplier-calling routes have a capped timeout", () => {
    for (const k of [
      "POST /api/admin/fulfillment/manual-fulfill",
      "POST /api/admin/fulfillment/sync-status",
      "POST /api/admin/fulfillment/sync-codecraft",
      "GET /api/admin/fulfillment/mtn-balance",
      "POST /api/admin/phone-verify/process",
      "POST /api/admin/fulfillment/bisdel-products",
      "POST /api/admin/fulfillment/eazyghdata-packages",
    ]) {
      const t = byKey(k).timeoutMs
      expect(t, k).toBeGreaterThan(15000)
      expect(t, k).toBeLessThanOrEqual(60000)
    }
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
        like(c: string, pat: string) {
          const prefix = pat.replace(/%$/, "")
          filters.push((r) => String(r[c] ?? "").startsWith(prefix))
          return b
        },
        lt(c: string, v: string) { filters.push((r) => String(r[c]) < v); return b },
        gte(c: string, v: string) { filters.push((r) => String(r[c]) >= v); return b },
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

const brokenDb = { from() { throw new Error("db down") } } as unknown as SupabaseClient

const U1 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001"
const U2 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002"
const U3 = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003"
const ADMIN = "11111111-1111-4111-8111-111111111111"

const tables = {
  shop_orders: [
    { id: U1, network: "MTN", volume_gb: 2, order_status: "pending", payment_status: "pending", customer_phone: "0241234567", customer_email: "leak@example.com", api_key: "SECRET123", queue: "blacklisted" },
    { id: U2, network: "MTN", volume_gb: 1, order_status: "reversed", payment_status: "completed", customer_phone: "0241234567", customer_email: "leak@example.com", api_key: "SECRET123", queue: "default" },
  ],
  orders: [{ id: U3, network: "MTN", size: 5, status: "pending", phone_number: "0241234567", queue: "blacklisted" }],
  mtn_fulfillment_tracking: [
    { id: U1, status: "failed", mtn_order_id: "FAILED_INIT_1", provider: "xpress", network: "MTN", size_gb: 2, recipient_phone: "0241234567" },
    { id: U2, status: "error", mtn_order_id: "FAILED_INIT_2", provider: "xpress", network: "MTN", size_gb: 1, recipient_phone: "0241234567" },
    { id: U3, status: "completed", mtn_order_id: "12345", provider: "xpress", network: "MTN", size_gb: 1, recipient_phone: "0241234567" },
  ],
  fulfillment_logs: [
    { id: U1, status: "failed", network: "AT - iShare", order_id: U2, phone_number: "0241234567" },
    { id: U2, status: "failed", network: "Telecel", order_id: U3, phone_number: "0241234567" },
    { id: U3, status: "success", network: "Telecel", order_id: U1, phone_number: "0241234567" },
  ],
  mtn_registration_batches: [{ id: U1, status: "submitted", number_count: 3, batch_time: "2026-11-01T00:00:00Z" }],
  mtn_number_registry: [
    { id: "1", phone: "0241111111", status: "submitted", submitted_batch: U1, whitelist_status: "allowed" },
    { id: "2", phone: "0242222222", status: "submitted", submitted_batch: U1, whitelist_status: "allowed" },
    { id: "3", phone: "0243333333", status: "registered", submitted_batch: U1, whitelist_status: "allowed" },
  ],
  api_orders: [],
  ussd_orders: [{ id: "u1", order_status: "held_registration" }],
  ussd_shop_orders: [],
  blocked: [],
  mtn_blocked_numbers: [{ id: U1, phone: "0241234567", status: "blocked", notes: null }],
  phone_otp_verifications: [
    { id: "1", used: true, phone: "0241234567" },
    { id: "2", used: true, phone: "0241234568" },
    { id: "3", used: false, phone: "0241234569" },
  ],
  phone_verification_sessions: [{ id: U1, file_name: "numbers.csv", check_type: "mtn_whitelist", total_count: 10, verified_count: 4, status: "processing" }],
  admin_settings: [
    { key: "auto_fulfil_pending", value: { enabled: false, minAgeMinutes: 10, maxAgeDays: 7, perRun: 20, networks: ["MTN"], rules: {} } },
    { key: "apexprime_mtn_fulfillment_path", value: { path: "groupshare" } },
    { key: "datakazina_mtn_route", value: { route: "mtn" } },
    { key: "bundleportal_mtn_route", value: { route: "mtn" } },
    { key: "kuntanii_delivery_mode", value: { mode: "normal" } },
    { key: "bisdel_category", value: { category: "MTN Data" } },
  ],
  fulfillment_queue: [{ id: "q1", source: "auto", status: "pending" }, { id: "q2", source: "manual", status: "pending" }],
  blacklisted_phone_numbers: [{ id: "b1", phone_number: "0241234567", reason: "fraud" }],
}

const CARD_INPUTS: Record<string, { params?: any; query?: any; body?: any }> = {
  "DELETE /api/admin/blacklist": { query: { phone: "0241234567" } },
  "DELETE /api/admin/fulfillment/logs": { query: { bulk: "failed" } },
  "DELETE /api/admin/fulfillment/mtn-logs": { query: { bulk: "failed_init" } },
  "GET /api/admin/agentportalgh": { query: { action: "balance" } },
  "GET /api/admin/apexprime": { query: { action: "balance" } },
  "GET /api/admin/bundleportal": { query: { action: "balance" } },
  "GET /api/admin/fulfillment/mtn-balance": {},
  "GET /api/admin/hubnet": { query: { action: "balance" } },
  "POST /api/admin/agentportalgh": { query: { action: "topup" }, body: { amount: 50, phone: "0241234567", network: "mtn" } },
  "POST /api/admin/apexprime": { body: { action: "set-fulfillment-path", network: "MTN", path: "store" } },
  "POST /api/admin/blacklist": { body: { phone_number: "0241234567 0551234567", reason: "fraud" } },
  "POST /api/admin/blacklist/bulk": { body: { phones: ["0241234567", "0551234567"] } },
  "POST /api/admin/blocked-numbers/update": { body: { id: U1, action: "handle", note: "customer informed" } },
  "POST /api/admin/bundleportal": { body: { action: "set-mtn-route", route: "mtn_2" } },
  "POST /api/admin/datakazina": { body: { action: "set-mtn-route", route: "mtn_express" } },
  "POST /api/admin/fulfillment/approval-preview": { body: { orders: [{ id: U1, type: "shop" }], supplier: "xpress" } },
  "POST /api/admin/fulfillment/bisdel-products": {},
  "POST /api/admin/fulfillment/eazyghdata-packages": {},
  "POST /api/admin/fulfillment/enqueue": { body: { orders: [{ id: U1, type: "shop" }, { id: U2, type: "shop" }, { id: U3, type: "bulk" }], provider: "xpress" } },
  "POST /api/admin/fulfillment/manual-fulfill": { body: { shop_order_id: U1, order_type: "shop", provider: "xpress" } },
  "POST /api/admin/fulfillment/retry-blacklisted": { body: { order_id: U1, order_type: "shop" } },
  "POST /api/admin/fulfillment/sync-codecraft": {},
  "POST /api/admin/fulfillment/sync-status": { body: { tracking_id: U1 } },
  "POST /api/admin/fulfillment/verify-whitelist": { body: { phone: "0241234567" } },
  "POST /api/admin/kuntanii": { body: { action: "set-delivery-mode", mode: "instant" } },
  "POST /api/admin/mtn-registration/mark-registered": { body: { batchId: U1 } },
  "POST /api/admin/mtn-registration/release-held": {},
  "POST /api/admin/phone-verifications/reset": { body: { all: true } },
  "POST /api/admin/phone-verify/process": { body: { sessionId: U1 } },
  "PUT /api/admin/agentportalgh": { query: { action: "webhook-config" }, body: { url: "https://www.datagod.store/api/webhooks/mtn/agentportalgh", enabled: true } },
  "PUT /api/admin/auto-fulfil": {
    body: {
      enabled: true,
      toggle: true,
      minAgeMinutes: 10,
      maxAgeDays: 7,
      perRun: 20,
      networks: ["MTN"],
      rules: Object.fromEntries(
        ["rate_limited", "out_of_balance", "supplier_unavailable", "not_enabled", "no_bundle", "wrong_number", "rejected"].map((b) => [
          b,
          { retry: true, waitMinutes: 30, maxTries: 3 },
        ]),
      ),
    },
  },
  "PUT /api/admin/fulfillment/bisdel-products": { body: { category: "MTN Data" } },
}

describe("fulfillment change cards", () => {
  const changes = FULFILLMENT_ENTRIES.filter((e) => e.kind === "change" && !e.typedCard)

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
    it(`${e.id}: summary and at least one line, no secrets or full contact details`, async () => {
      const c = await e.card!(inp, { db: fakeDb(tables), adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
      const text = JSON.stringify(c)
      expect(text).not.toContain("SECRET123")
      expect(text).not.toContain("leak@example.com")
      expect(text).not.toContain("0241234567")
      expect(text).not.toContain("0551234567")
    })
    it(`${e.id}: still returns a card when the database fails`, async () => {
      const c = await e.card!(inp, { db: brokenDb, adminId: ADMIN })
      expect(c.summary.length).toBeGreaterThan(0)
      expect(c.lines.length).toBeGreaterThanOrEqual(1)
    })
  }

  const run = (k: string, input: any, db: SupabaseClient = fakeDb(tables)) => byKey(k).card!(input, { db, adminId: ADMIN })

  it("manual fulfil names the supplier send, the pin, and warns when payment is not confirmed", async () => {
    const c = JSON.stringify(await run("POST /api/admin/fulfillment/manual-fulfill", CARD_INPUTS["POST /api/admin/fulfillment/manual-fulfill"]))
    expect(c).toMatch(/supplier/i)
    expect(c).toMatch(/xpress/i)
    expect(c).toMatch(/backup/i)
    expect(c).toMatch(/payment/i)
    expect(c).toMatch(/not (been )?confirm/i)
    expect(c).toContain("024 *** 4567")
    const paid = JSON.stringify(await run("POST /api/admin/fulfillment/manual-fulfill", { body: { shop_order_id: U2, order_type: "shop" } }))
    expect(paid).not.toMatch(/not (been )?confirm/i)
  })

  it("blacklist removal counts the same orders the handler resets, and names the fulfilment and SMS", async () => {
    const db = fakeDb({
      blacklisted_phone_numbers: [{ id: "b1", phone_number: "0241234567" }],
      shop_orders: [
        { id: "1", customer_phone: "0241234567", order_status: "blacklisted", payment_status: "completed" },
        { id: "2", customer_phone: "0241234567", order_status: "blacklisted", payment_status: "pending" },
        { id: "3", customer_phone: "0241234567", order_status: "pending", payment_status: "completed" },
      ],
      orders: [{ id: "4", phone_number: "0241234567", status: "blacklisted", payment_status: "completed" }],
    })
    const c = await run("DELETE /api/admin/blacklist", { query: { phone: "0241234567" } }, db)
    const lines = Object.fromEntries(c.lines.map((l) => [l.label, l.value]))
    expect(lines["Shop orders reset to pending"]).toBe("2")
    expect(lines["Wallet orders reset to pending"]).toBe("1")
    expect(lines["Sent to supplier"]).toMatch(/2/)
    expect(JSON.stringify(c)).toMatch(/SMS/)
  })

  it("auto-fulfil says enabling starts automatic supplier sends, and warns about the toggle flag", async () => {
    const e = byKey("PUT /api/admin/auto-fulfil")
    const on = JSON.stringify(await e.card!(CARD_INPUTS["PUT /api/admin/auto-fulfil"], { db: fakeDb(tables), adminId: ADMIN }))
    expect(on).toMatch(/supplier/i)
    expect(on).toMatch(/automatic/i)
    const noToggle = JSON.stringify(
      await e.card!({ body: { ...CARD_INPUTS["PUT /api/admin/auto-fulfil"].body, toggle: undefined } }, { db: fakeDb(tables), adminId: ADMIN }),
    )
    expect(noToggle).toMatch(/toggle/i)
    const off = JSON.stringify(
      await e.card!({ body: { ...CARD_INPUTS["PUT /api/admin/auto-fulfil"].body, enabled: false, toggle: true } }, { db: fakeDb(tables), adminId: ADMIN }),
    )
    expect(off).toMatch(/cancel/i)
    expect(off).toContain("1") // one waiting automatic row in the fake queue (source auto, status pending)
  })

  it("mark-registered counts the submitted numbers and names the held-order release", async () => {
    const c = await run("POST /api/admin/mtn-registration/mark-registered", { body: { batchId: U1 } })
    const lines = Object.fromEntries(c.lines.map((l) => [l.label, l.value]))
    expect(lines["Numbers to mark registered"]).toBe("2")
    expect(JSON.stringify(c)).toMatch(/held orders/i)
    expect(JSON.stringify(c)).toMatch(/supplier/i)
  })

  it("release-held counts held orders across the order tables", async () => {
    const c = await run("POST /api/admin/mtn-registration/release-held", {})
    expect(JSON.stringify(c)).toMatch(/\b1\b/)
    expect(JSON.stringify(c)).toMatch(/supplier/i)
  })

  it("mtn-logs delete counts with the handler's own filter", async () => {
    const failed = await run("DELETE /api/admin/fulfillment/mtn-logs", { query: { bulk: "failed" } })
    expect(failed.lines.find((l) => l.label === "Log rows to delete")?.value).toBe("2")
    const init = await run("DELETE /api/admin/fulfillment/mtn-logs", { query: { bulk: "failed_init" } })
    expect(init.lines.find((l) => l.label === "Log rows to delete")?.value).toBe("2")
  })

  it("fulfilment-log delete counts failed rows in bulk and says it cannot be undone", async () => {
    const c = await run("DELETE /api/admin/fulfillment/logs", { query: { bulk: "failed" } })
    expect(c.lines.find((l) => l.label === "Log rows to delete")?.value).toBe("2")
    expect(JSON.stringify(c)).toMatch(/cannot be undone/i)
  })

  it("enqueue names the queue, the supplier, the drain and the risky rules", async () => {
    const c = await run("POST /api/admin/fulfillment/enqueue", CARD_INPUTS["POST /api/admin/fulfillment/enqueue"])
    const text = JSON.stringify(c)
    expect(text).toMatch(/xpress/i)
    expect(text).toMatch(/every minute|each minute|within a minute/i)
    expect(text).toMatch(/supplier/i)
    expect(text).toMatch(/reversed/i)
    const risky = JSON.stringify(
      await run("POST /api/admin/fulfillment/enqueue", { body: { orders: [{ id: U2, type: "shop" }], riskyAck: { count: 1 } } }),
    )
    expect(risky).toMatch(/refused|rejected/i)
  })

  it("blocked-number handle without a note is flagged as refused", async () => {
    const c = JSON.stringify(await run("POST /api/admin/blocked-numbers/update", { body: { id: U1, action: "handle" } }))
    expect(c).toMatch(/note is required/i)
    const reopen = JSON.stringify(await run("POST /api/admin/blocked-numbers/update", { body: { id: U1, action: "reopen" } }))
    expect(reopen).toMatch(/re-?check/i)
  })

  it("phone-verification reset shows the live count and the all-versus-used difference", async () => {
    const used = await run("POST /api/admin/phone-verifications/reset", { body: {} })
    expect(used.lines.find((l) => l.label === "Records to delete")?.value).toBe("2")
    const all = await run("POST /api/admin/phone-verifications/reset", { body: { all: true } })
    expect(all.lines.find((l) => l.label === "Records to delete")?.value).toBe("3")
  })

  it("provider pins show the current value and the new one", async () => {
    const apex = JSON.stringify(await run("POST /api/admin/apexprime", CARD_INPUTS["POST /api/admin/apexprime"]))
    expect(apex).toMatch(/groupshare/)
    expect(apex).toMatch(/store/)
    const dk = JSON.stringify(await run("POST /api/admin/datakazina", CARD_INPUTS["POST /api/admin/datakazina"]))
    expect(dk).toMatch(/mtn_express|express/i)
    const bp = JSON.stringify(await run("POST /api/admin/bundleportal", CARD_INPUTS["POST /api/admin/bundleportal"]))
    expect(bp).toMatch(/mtn_2/)
    const kn = JSON.stringify(await run("POST /api/admin/kuntanii", CARD_INPUTS["POST /api/admin/kuntanii"]))
    expect(kn).toMatch(/normal/)
    expect(kn).toMatch(/instant/)
  })

  it("agentportalgh top-up masks the paying phone and says it is a MoMo prompt", async () => {
    const c = JSON.stringify(await run("POST /api/admin/agentportalgh", CARD_INPUTS["POST /api/admin/agentportalgh"]))
    expect(c).toContain("GHS 50.00")
    expect(c).toContain("024 *** 4567")
    expect(c).toMatch(/MoMo/)
  })

  it("webhook card shows the full address", async () => {
    const c = JSON.stringify(await run("PUT /api/admin/agentportalgh", CARD_INPUTS["PUT /api/admin/agentportalgh"]))
    expect(c).toContain("https://www.datagod.store/api/webhooks/mtn/agentportalgh")
  })

  it("kuntanii report card names the later refund reversal", async () => {
    const c = JSON.stringify(await run("POST /api/admin/kuntanii", { body: { action: "report-not-received", trackingId: U1 } }))
    expect(c).toMatch(/reverses this order/i)
    expect(c).toMatch(/completed Kuntanii orders/)
  })

  it("manual fulfil for a USSD order does not claim the shop-order refusals", async () => {
    const c = JSON.stringify(await run("POST /api/admin/fulfillment/manual-fulfill", { body: { shop_order_id: U1, order_type: "ussd" } }))
    expect(c).toMatch(/USSD fulfilment path/)
    expect(c).not.toMatch(/blacklisted, or its network/)
  })

  it("sync-status says a direct lookup reads only and a tracking sync can update the order", async () => {
    const direct = JSON.stringify(await run("POST /api/admin/fulfillment/sync-status", { body: { mtn_order_id: "12345" } }))
    expect(direct).toMatch(/read only|nothing is changed/i)
    const track = JSON.stringify(await run("POST /api/admin/fulfillment/sync-status", { body: { tracking_id: U1 } }))
    expect(track).toMatch(/notif|status/i)
  })
})
