import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { SETTINGS_ENTRIES } from "./settings"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import { resolveRequest } from "../resolve"
import type { Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`

const D1 = "dddddddd-dddd-4ddd-8ddd-000000000001"
const K1 = "eeeeeeee-eeee-4eee-8eee-000000000001"
const SHOP = "ffffffff-ffff-4fff-8fff-000000000001"
const REF = "0123456789abcdef0123456789abcdef"

const CATALOGUED = [
  "DELETE /api/admin/ai-knowledge",
  "DELETE /api/admin/custom-domains",
  "DELETE /api/admin/settings/ussd-whitelist/numbers",
  "GET /api/admin/ai-knowledge",
  "GET /api/admin/christmas-theme",
  "GET /api/admin/custom-domains",
  "GET /api/admin/delivery-channels",
  "GET /api/admin/gateway",
  "GET /api/admin/gateway/hubtel-payments",
  "GET /api/admin/rate-limits",
  "GET /api/admin/settings",
  "GET /api/admin/settings/afa-auto-fulfillment",
  "GET /api/admin/settings/afa-provider",
  "GET /api/admin/settings/auto-fulfillment",
  "GET /api/admin/settings/balance-threshold",
  "GET /api/admin/settings/blocked-numbers",
  "GET /api/admin/settings/customer-verification",
  "GET /api/admin/settings/google-review-url",
  "GET /api/admin/settings/mtn-auto-fulfillment",
  "GET /api/admin/settings/mtn-disabled-providers",
  "GET /api/admin/settings/mtn-provider",
  "GET /api/admin/settings/mtn-registration-gate",
  "GET /api/admin/settings/mtn-retry-sequence",
  "GET /api/admin/settings/network-prefix-validation",
  "GET /api/admin/settings/network-prefixes",
  "GET /api/admin/settings/network-provider",
  "GET /api/admin/settings/public-ussd-codes",
  "GET /api/admin/settings/storefront-direct-charge",
  "GET /api/admin/settings/storefront-otp",
  "GET /api/admin/settings/strict-supplier-verify",
  "GET /api/admin/settings/turnstile",
  "GET /api/admin/settings/ussd-shop-memory",
  "GET /api/admin/settings/ussd-whitelist",
  "GET /api/admin/settings/ussd-whitelist/numbers",
  "GET /api/admin/settings/wallet-direct-charge",
  "GET /api/admin/settings/wallet-otp",
  "PATCH /api/admin/ai-knowledge",
  "PATCH /api/admin/custom-domains",
  "POST /api/admin/ai-knowledge",
  "POST /api/admin/custom-domains",
  "POST /api/admin/delivery-channels",
  "POST /api/admin/gateway/hubtel-payments",
  "POST /api/admin/rate-limits/reset",
  "POST /api/admin/settings/afa-auto-fulfillment",
  "POST /api/admin/settings/afa-provider",
  "POST /api/admin/settings/auto-fulfillment",
  "POST /api/admin/settings/balance-threshold",
  "POST /api/admin/settings/blocked-numbers",
  "POST /api/admin/settings/customer-verification",
  "POST /api/admin/settings/google-review-url",
  "POST /api/admin/settings/mtn-auto-fulfillment",
  "POST /api/admin/settings/mtn-disabled-providers",
  "POST /api/admin/settings/mtn-provider",
  "POST /api/admin/settings/mtn-registration-gate",
  "POST /api/admin/settings/mtn-retry-sequence",
  "POST /api/admin/settings/network-prefix-validation",
  "POST /api/admin/settings/network-prefixes",
  "POST /api/admin/settings/network-provider",
  "POST /api/admin/settings/public-ussd-codes",
  "POST /api/admin/settings/storefront-direct-charge",
  "POST /api/admin/settings/storefront-otp",
  "POST /api/admin/settings/turnstile",
  "POST /api/admin/settings/ussd-shop-memory",
  "POST /api/admin/settings/ussd-whitelist",
  "POST /api/admin/settings/ussd-whitelist/numbers",
  "POST /api/admin/settings/wallet-direct-charge",
  "POST /api/admin/settings/wallet-otp",
  "POST /api/admin/support-settings",
  "PUT /api/admin/ai-config",
  "PUT /api/admin/christmas-theme",
  "PUT /api/admin/gateway",
  "PUT /api/admin/settings",
  "PUT /api/admin/settings/strict-supplier-verify",
]

const byKey = (k: string) => SETTINGS_ENTRIES.find((e) => key(e.method, e.path) === k)!

describe("settings catalog coverage", () => {
  it("catalogues exactly the listed routes and registers them in CATALOG", () => {
    expect(SETTINGS_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    expect(CATALOGUED.length).toBe(73)
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
      expect(EXCLUDED.some((x) => key(x.method, x.path) === k), k).toBe(false)
    }
  })

  it("leaves no settings-area route in PENDING", () => {
    const area = /^(DELETE|GET|PATCH|POST|PUT) \/api\/admin\/(settings|gateway|delivery-channels|christmas-theme|custom-domains|support-settings|rate-limits|ai-config|ai-knowledge)(\/|$)/
    expect(PENDING.filter((k) => area.test(k))).toEqual([])
  })

  it("ids are unique and area is settings", () => {
    const ids = SETTINGS_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of SETTINGS_ENTRIES) expect(e.area).toBe("settings")
  })
})

describe("settings catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of SETTINGS_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of SETTINGS_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card", () => {
    for (const e of SETTINGS_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      if (e.kind === "change") expect(typeof e.card, e.id).toBe("function")
    }
  })

  it("lookups never keep secrets, tokens, keys or raw payloads", () => {
    for (const e of SETTINGS_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/password|token|secret|hash|api_?key|payload|(^|[._\]])raw($|[._])/i)
      }
    }
  })

  it("GETs that save a default row when none exists are changes", () => {
    for (const k of [
      "GET /api/admin/settings",
      "GET /api/admin/settings/afa-auto-fulfillment",
      "GET /api/admin/settings/mtn-auto-fulfillment",
      "GET /api/admin/settings/mtn-registration-gate",
      "GET /api/admin/settings/network-prefix-validation",
    ]) {
      expect(byKey(k).kind, k).toBe("change")
    }
    // These only read.
    expect(byKey("GET /api/admin/settings/turnstile").kind).toBe("lookup")
    expect(byKey("GET /api/admin/gateway").kind).toBe("lookup")
  })

  it("global switches, provider choices, gates, gateway and rate limits are danger; fees and prices are money", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const danger = [
      "PUT /api/admin/settings",
      "PUT /api/admin/gateway",
      "PUT /api/admin/settings/strict-supplier-verify",
      "POST /api/admin/settings/afa-auto-fulfillment",
      "POST /api/admin/settings/afa-provider",
      "POST /api/admin/settings/auto-fulfillment",
      "POST /api/admin/settings/mtn-auto-fulfillment",
      "POST /api/admin/settings/mtn-registration-gate",
      "POST /api/admin/settings/mtn-provider",
      "POST /api/admin/settings/mtn-disabled-providers",
      "POST /api/admin/settings/mtn-retry-sequence",
      "POST /api/admin/settings/network-provider",
      "POST /api/admin/settings/network-prefix-validation",
      "POST /api/admin/settings/network-prefixes",
      "POST /api/admin/settings/customer-verification",
      "POST /api/admin/settings/blocked-numbers",
      "POST /api/admin/settings/turnstile",
      "POST /api/admin/settings/storefront-otp",
      "POST /api/admin/settings/wallet-otp",
      "POST /api/admin/settings/storefront-direct-charge",
      "POST /api/admin/settings/wallet-direct-charge",
      "POST /api/admin/settings/ussd-shop-memory",
      "POST /api/admin/settings/ussd-whitelist",
      "POST /api/admin/rate-limits/reset",
      "POST /api/admin/delivery-channels",
      "POST /api/admin/support-settings",
      "PUT /api/admin/ai-config",
      "POST /api/admin/custom-domains",
      "PATCH /api/admin/custom-domains",
      "DELETE /api/admin/custom-domains",
      "POST /api/admin/ai-knowledge",
      "PATCH /api/admin/ai-knowledge",
    ]
    for (const k of danger) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.danger)
    expect(rank[byKey("POST /api/admin/gateway/hubtel-payments").risk]).toBeGreaterThanOrEqual(rank.money)
  })

  it("auth matches each handler", () => {
    const other = new Set(["GET /api/admin/settings/auto-fulfillment", "GET /api/admin/christmas-theme"])
    for (const e of SETTINGS_ENTRIES) expect(e.auth, e.id).toBe(other.has(key(e.method, e.path)) ? "other" : "admin")
  })

  it("timeouts stay within 60 s and the Hubtel payment actions are given time", () => {
    for (const e of SETTINGS_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
    expect(byKey("POST /api/admin/gateway/hubtel-payments").timeoutMs).toBe(60000)
  })

  it("declares a param for every :name segment", () => {
    for (const e of SETTINGS_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("ai-config: the five provider keys are secure-box fields and never part of the schema", () => {
    const e = byKey("PUT /api/admin/ai-config")
    expect(e.secretFields?.map((s) => s.name).sort()).toEqual([
      "anthropic_api_key_new",
      "deepseek_api_key_new",
      "gemini_api_key_new",
      "groq_api_key_new",
      "openai_api_key_new",
    ])
    for (const s of e.secretFields!) {
      expect(s.min).toBe(16)
      expect(s.max).toBe(300)
      expect(s.label).toMatch(/ API key$/)
      expect(Object.keys(e.body!.shape)).not.toContain(s.name)
    }
    const viaModel = resolveRequest(e, { body: { anthropic_api_key_new: "x".repeat(40) } })
    expect(viaModel.ok).toBe(false)
    if (!viaModel.ok) expect(viaModel.code).toBe("secret_in_input")
    expect(e.body!.safeParse({ assistant_name: "Helper Bot", tone: "friendly", max_tool_steps: 10 }).success).toBe(true)
    expect(e.body!.safeParse({ tone: "rude" }).success).toBe(false)
    expect(e.body!.safeParse({ max_tool_steps: 2 }).success).toBe(false)
    expect(e.body!.safeParse({ admin_provider: "openai", admin_model: "gpt-4o" }).success).toBe(true)
    expect(e.body!.safeParse({ admin_provider: "skynet" }).success).toBe(false)
    expect(e.body!.safeParse({ admin_catalog_enabled: false }).success).toBe(true)
  })

  it("no other settings schema carries a key, secret, token or password field", () => {
    for (const x of SETTINGS_ENTRIES) {
      if (x.secretFields) continue
      for (const schema of [x.query, x.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, x.id).not.toMatch(/secret|api_?key|token|password|otp$/i)
      }
    }
  })

  it("site settings schema mirrors the handler: bounds, roles, no legal terms, no unknown keys", () => {
    const b = byKey("PUT /api/admin/settings").body!
    expect(b.safeParse({ ordering_enabled: false }).success).toBe(true)
    expect(b.safeParse({ paystack_fee_percentage: 101 }).success).toBe(false)
    expect(b.safeParse({ withdrawal_fee_minimum: -1 }).success).toBe(false)
    expect(b.safeParse({ supplier_cost_per_gb_mtn: -3 }).success).toBe(false)
    expect(b.safeParse({ signup_default_role: "admin" }).success).toBe(false)
    expect(b.safeParse({ signup_default_role: "dealer" }).success).toBe(true)
    expect(b.safeParse({ join_community_link: "javascript:alert(1)" }).success).toBe(false)
    expect(b.safeParse({ join_community_link: "https://chat.example.com/x" }).success).toBe(true)
    expect(b.safeParse({ join_group_link: "" }).success).toBe(true)
    expect(b.safeParse({ whatsapp_bot_number: "0241234567" }).success).toBe(true)
    expect(b.safeParse({ whatsapp_bot_number: "12" }).success).toBe(false)
    expect(b.safeParse({ terms_content: "x" }).success).toBe(false) // legal text cannot be shown in full on a card: use the page
    expect(b.safeParse({ ussd_price_tier: "dealer" }).success).toBe(true)
    expect(b.safeParse({ ussd_price_tier: "free" }).success).toBe(false)
  })

  it("provider and switch schemas mirror the handlers", () => {
    expect(byKey("POST /api/admin/settings/mtn-provider").body!.safeParse({ provider: "hubnet" }).success).toBe(true)
    expect(byKey("POST /api/admin/settings/mtn-provider").body!.safeParse({ provider: "spfastit" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/network-provider").body!.safeParse({ network: "telecel", provider: "spfastit_telecel" }).success).toBe(true)
    expect(byKey("POST /api/admin/settings/afa-provider").body!.safeParse({ provider: "apexprime" }).success).toBe(true)
    expect(byKey("POST /api/admin/settings/afa-provider").body!.safeParse({ provider: "codecraft" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/turnstile").body!.safeParse({ enabled: "yes" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/turnstile").body!.safeParse({}).success).toBe(false)
    expect(byKey("POST /api/admin/settings/network-prefixes").body!.safeParse({ network: "MTN", prefix: "058", action: "add" }).success).toBe(true)
    expect(byKey("POST /api/admin/settings/network-prefixes").body!.safeParse({ network: "MTN", prefix: "18", action: "add" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/public-ussd-codes").body!.safeParse({ main: "*920#" }).success).toBe(true)
    expect(byKey("POST /api/admin/settings/public-ussd-codes").body!.safeParse({ main: "tel:123" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/google-review-url").body!.safeParse({ url: "https://evil.example.com/x" }).success).toBe(false)
    expect(byKey("POST /api/admin/settings/google-review-url").body!.safeParse({ url: "https://g.page/r/abc" }).success).toBe(true)
  })

  it("mtn disabled providers cannot switch every provider off", () => {
    const b = byKey("POST /api/admin/settings/mtn-disabled-providers").body!
    expect(b.safeParse({ disabled: ["bisdel"] }).success).toBe(true)
    expect(b.safeParse({ disabled: ["sykes", "datakazina", "xpress", "eazyghdata", "bisdel", "codecraft", "agentportalgh", "apexprime", "bundleportal", "kuntanii", "hubnet"] }).success).toBe(false)
  })

  it("custom domain and support schemas keep customer-facing values safe", () => {
    const create = byKey("POST /api/admin/custom-domains").body!
    const ok = { domain: "shop.example.com", site_name: "My Shop", services: ["airtime"] }
    expect(create.safeParse(ok).success).toBe(true)
    expect(create.safeParse({ ...ok, services: [] }).success).toBe(false)
    expect(create.safeParse({ ...ok, services: ["crypto"] }).success).toBe(false)
    expect(create.safeParse({ ...ok, logo_url: "javascript:alert(1)" }).success).toBe(false)
    expect(create.safeParse({ ...ok, logo_url: "https://cdn.example.com/l.png" }).success).toBe(true)
    expect(create.safeParse({ ...ok, domain: "nodots" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/custom-domains").body!.safeParse({ id: D1, site_name: "X", linked_shop_id: SHOP }).success).toBe(true)
    expect(byKey("DELETE /api/admin/custom-domains").query!.safeParse({ id: D1 }).success).toBe(true)
    const sup = byKey("POST /api/admin/support-settings").body!
    expect(sup.safeParse({}).success).toBe(false) // the WhatsApp number is required
    expect(sup.safeParse({ support_whatsapp: "233241234567" }).success).toBe(true)
    expect(sup.safeParse({ support_whatsapp: "233241234567", guest_purchase_url: "javascript:alert(1)" }).success).toBe(false)
  })

  it("rate-limit reset, hubtel payments and delivery channel schemas mirror the handlers", () => {
    const reset = byKey("POST /api/admin/rate-limits/reset").body!
    expect(reset.safeParse({ endpoint: "/api/x", identifier: "1.2.3.4" }).success).toBe(true)
    expect(reset.safeParse({ endpoint: "/api/x" }).success).toBe(false)
    const h = byKey("POST /api/admin/gateway/hubtel-payments").body!
    expect(h.safeParse({ action: "fulfil", reference: REF }).success).toBe(true)
    expect(h.safeParse({ action: "fulfil", reference: "abc" }).success).toBe(false)
    expect(h.safeParse({ action: "refund", reference: REF }).success).toBe(false)
    expect(h.safeParse({ action: "refunded_manually", reference: REF, admin_reference: "MP1234567", note: "paid back" }).success).toBe(true)
    expect(h.safeParse({ action: "refunded_manually", reference: REF, admin_reference: "x", note: "paid back" }).success).toBe(false)
    const d = byKey("POST /api/admin/delivery-channels").body!
    expect(d.safeParse({ channel: "mtn", down: true, reason: "supplier outage" }).success).toBe(true)
    expect(d.safeParse({ channel: "voice", down: true }).success).toBe(false)
  })

  it("gateway config schema requires every surface and refuses non-direct modes on direct-only surfaces", () => {
    const b = byKey("PUT /api/admin/gateway").body!
    expect(b.safeParse({ config: GATEWAY_NEW }).success).toBe(true)
    expect(b.safeParse({ config: { ...GATEWAY_NEW, hubtelFeePercent: 120 } }).success).toBe(false)
    const missing = { ...GATEWAY_NEW, surfaces: { ...GATEWAY_NEW.surfaces } } as { surfaces: Record<string, unknown> }
    delete missing.surfaces.sms
    expect(b.safeParse({ config: missing }).success).toBe(false)
    expect(b.safeParse({ config: { ...GATEWAY_NEW, surfaces: { ...GATEWAY_NEW.surfaces, ussd: { gateway: "paystack", mode: "checkout", feeBearer: "customer" } } } }).success).toBe(false)
  })

  it("ussd whitelist numbers are bounded", () => {
    const b = byKey("POST /api/admin/settings/ussd-whitelist/numbers").body!
    expect(b.safeParse({ numbers: ["0241234567"] }).success).toBe(true)
    expect(b.safeParse({ numbers: [] }).success).toBe(false)
    expect(b.safeParse({ numbers: Array(501).fill("0241234567") }).success).toBe(false)
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

const GATEWAY_OLD = {
  version: 1,
  surfaces: {
    wallet_topup: { gateway: "paystack", mode: "checkout", feeBearer: "customer" },
    storefront: { gateway: "paystack", mode: "checkout", feeBearer: "customer" },
    dashboard_direct: { gateway: "paystack", mode: "checkout", feeBearer: "customer" },
    sms: { gateway: "paystack", mode: "checkout", feeBearer: "customer" },
    ussd: { gateway: "paystack", mode: "direct", feeBearer: "customer" },
    whatsapp: { gateway: "paystack", mode: "direct", feeBearer: "customer" },
    sms_order: { gateway: "paystack", mode: "direct", feeBearer: "customer" },
  },
  hubtelFeePercent: 1.5,
}

const GATEWAY_NEW = {
  version: 1,
  surfaces: {
    ...GATEWAY_OLD.surfaces,
    storefront: { gateway: "hubtel", mode: "direct", feeBearer: "merchant" },
  },
  hubtelFeePercent: 2,
}

const SECRET_SENTINEL = "sk-ant-SECRETSECRETSECRET1234"

const tables: Record<string, Row[]> = {
  admin_settings: [
    { key: "afa_auto_fulfillment_enabled", value: { enabled: false } },
    { key: "mtn_auto_fulfillment_enabled", value: { enabled: true } },
    { key: "auto_fulfillment_enabled", value: { enabled: true, networks: ["AT - iShare", "Telecel"] } },
    { key: "turnstile_enabled", value: { enabled: true } },
    { key: "storefront_otp_required", value: { enabled: false } },
    { key: "mtn_provider_selection", value: { provider: "sykes" } },
    { key: "mtn_disabled_providers", value: { providers: ["bisdel"] } },
    { key: "mtn_retry_sequence", value: { enabled: false, providers: ["xpress"] } },
    { key: "telecel_provider_selection", value: { provider: "codecraft" } },
    { key: "afa_provider_selection", value: { provider: "sykes" } },
    { key: "network_prefix_map", value: { MTN: ["24", "25"], TELECEL: ["20"], AT: ["26"] } },
    { key: "customer_verification_settings", value: { enabled: false, providers: [], block_unverified: false } },
    { key: "blocked_numbers_settings", value: { enabled: false, customer_sms_enabled: false, retention_days: 30, spike_threshold_per_hour: 25, daily_sms_ceiling: 300 } },
    { key: "payment_gateway_config", value: GATEWAY_OLD },
    { key: "mtn_strict_supplier_verification", value: { enabled: false } },
    { key: "ussd_data_whitelist_enabled", value: { enabled: true } },
    {
      key: "ai_provider_config",
      value: { anthropic_api_key: SECRET_SENTINEL, admin_provider: "anthropic", admin_model: "claude-haiku-4-5-20251001", assistant_name: "Old Bot", tone: "default", admin_catalog_enabled: true },
    },
  ],
  app_settings: [
    {
      key: null, ordering_enabled: true, signups_enabled: true, paystack_fee_percentage: 3, withdrawal_fee_percentage: 1, price_adjustment_mtn: 0,
      announcement_enabled: false, announcement_title: "", join_community_link: "https://old.example.com/join", whatsapp_bot_number: "233200000000",
      signup_default_role: "user", ussd_price_tier: "regular", christmas_theme_enabled: false, ussd_shop_dial_code: "*426*203#",
    },
    { key: "mtn_balance_alert_threshold", value: "500" },
    { key: "google_review_url", value: JSON.stringify({ url: "https://g.page/r/old" }) },
    { key: "public_ussd_codes", value: JSON.stringify({ main: "*920#" }) },
  ],
  support_settings: [{ id: 1, support_whatsapp: "233201111111", support_email: "old@datagod.store", support_phone: "0201111111", guest_purchase_url: "/guest-buy", guest_purchase_button_text: "Buy as Guest" }],
  custom_domains: [{ id: D1, domain: "shop.example.com", services: ["airtime"], site_name: "Old Shop", logo_url: null, primary_color: null, is_active: true, linked_shop_id: null, hidden_pages: [], wildcard_shops_enabled: false }],
  user_shops: [{ id: SHOP, shop_name: "Kofi Shop", subdomain: "kofi", is_active: true, is_blocked: false }],
  rate_limit_blocks: [
    { id: 1, endpoint: "/api/login", identifier: "1.2.3.4" },
    { id: 2, endpoint: "/api/login", identifier: "1.2.3.4" },
  ],
  ai_knowledge: [{ id: K1, category: "faq", question: "How do I pay?", answer: "Use MoMo.", contexts: ["storefront"], is_active: true }],
  hubtel_payments: [{ reference: REF, surface: "storefront", amount_pesewas: 2050, status: "needs_review", internal_reference: "WP-1" }],
  delivery_channel_overrides: [{ channel: "mtn", is_manually_down: false, reason: null }],
  ussd_whitelist: [{ phone_number: "0241234567" }],
}

const db = fakeDb(tables)

const CARD_INPUTS: Record<string, { params?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown> }> = {
  "GET /api/admin/settings": {},
  "GET /api/admin/settings/afa-auto-fulfillment": {},
  "GET /api/admin/settings/mtn-auto-fulfillment": {},
  "GET /api/admin/settings/mtn-registration-gate": {},
  "GET /api/admin/settings/network-prefix-validation": {},
  "PUT /api/admin/settings": { body: { ordering_enabled: false, paystack_fee_percentage: 2.5, join_community_link: "https://new.example.com/join", whatsapp_bot_number: "0241234567" } },
  "POST /api/admin/settings/afa-auto-fulfillment": { body: { enabled: true } },
  "POST /api/admin/settings/afa-provider": { body: { provider: "apexprime" } },
  "POST /api/admin/settings/auto-fulfillment": { body: { enabled: false } },
  "POST /api/admin/settings/balance-threshold": { body: { threshold: 800 } },
  "POST /api/admin/settings/blocked-numbers": { body: { enabled: true, daily_sms_ceiling: 100 } },
  "POST /api/admin/settings/customer-verification": { body: { enabled: true, providers: ["xpress", "hubnet"], block_unverified: true } },
  "POST /api/admin/settings/google-review-url": { body: { url: "https://g.page/r/new" } },
  "POST /api/admin/settings/mtn-auto-fulfillment": { body: { enabled: false } },
  "POST /api/admin/settings/mtn-disabled-providers": { body: { disabled: ["bisdel", "sykes"] } },
  "POST /api/admin/settings/mtn-provider": { body: { provider: "hubnet" } },
  "POST /api/admin/settings/mtn-registration-gate": { body: { enabled: true } },
  "POST /api/admin/settings/mtn-retry-sequence": { body: { enabled: true, providers: ["xpress", "codecraft"] } },
  "POST /api/admin/settings/network-prefix-validation": { body: { enabled: false } },
  "POST /api/admin/settings/network-prefixes": { body: { network: "MTN", prefix: "058", action: "add" } },
  "POST /api/admin/settings/network-provider": { body: { network: "telecel", provider: "xpress" } },
  "POST /api/admin/settings/public-ussd-codes": { body: { main: "*920*5#" } },
  "POST /api/admin/settings/storefront-direct-charge": { body: { enabled: true } },
  "POST /api/admin/settings/storefront-otp": { body: { enabled: true } },
  "PUT /api/admin/settings/strict-supplier-verify": { body: { enabled: true } },
  "POST /api/admin/settings/turnstile": { body: { enabled: false } },
  "POST /api/admin/settings/ussd-shop-memory": { body: { enabled: true } },
  "POST /api/admin/settings/ussd-whitelist": { body: { enabled: true } },
  "POST /api/admin/settings/ussd-whitelist/numbers": { body: { numbers: ["0551234567", "+233 24 111 2222", "bad"] } },
  "DELETE /api/admin/settings/ussd-whitelist/numbers": { body: { phone_number: "0241234567" } },
  "POST /api/admin/settings/wallet-direct-charge": { body: { enabled: true } },
  "POST /api/admin/settings/wallet-otp": { body: { enabled: true } },
  "PUT /api/admin/gateway": { body: { config: GATEWAY_NEW } },
  "POST /api/admin/gateway/hubtel-payments": { body: { action: "fulfil", reference: REF } },
  "POST /api/admin/delivery-channels": { body: { channel: "mtn", down: true, reason: "supplier outage" } },
  "PUT /api/admin/christmas-theme": { body: { christmas_theme_enabled: true } },
  "POST /api/admin/custom-domains": { body: { domain: "new.example.com", site_name: "New Shop", services: ["airtime", "data_bundles"], linked_shop_id: SHOP } },
  "PATCH /api/admin/custom-domains": { body: { id: D1, site_name: "Renamed", is_active: false } },
  "DELETE /api/admin/custom-domains": { query: { id: D1 } },
  "POST /api/admin/support-settings": { body: { support_whatsapp: "233209998888", support_email: "help@datagod.store" } },
  "POST /api/admin/rate-limits/reset": { body: { endpoint: "/api/login", identifier: "1.2.3.4" } },
  "PUT /api/admin/ai-config": { body: { assistant_name: "New Bot", admin_catalog_enabled: false, admin_provider: "openai", admin_model: "gpt-4o" } },
  "POST /api/admin/ai-knowledge": { body: { category: "payments", question: "Where do I pay?", answer: "Only inside the app." } },
  "PATCH /api/admin/ai-knowledge": { body: { id: K1, answer: "Use MoMo or the wallet." } },
  "DELETE /api/admin/ai-knowledge": { query: { id: K1 } },
}

async function text(k: string, input = CARD_INPUTS[k], client: SupabaseClient = db): Promise<string> {
  const e = byKey(k)
  const c = await e.card!(input ?? {}, { db: client, adminId: "11111111-1111-4111-8111-111111111111" })
  return [c.summary, ...c.lines.map((l) => `${l.label}: ${l.value}`)].join("\n")
}

describe("settings cards", () => {
  it("every change entry has a card input, returns a summary and lines, and survives a broken database", async () => {
    const changes = SETTINGS_ENTRIES.filter((e) => e.kind === "change")
    expect(changes.length).toBeGreaterThan(40)
    for (const e of changes) {
      const k = key(e.method, e.path)
      expect(CARD_INPUTS[k], k).toBeTruthy()
      const ok = await e.card!(CARD_INPUTS[k], { db, adminId: "a" })
      expect(ok.summary.length, k).toBeGreaterThan(5)
      expect(ok.lines.length, k).toBeGreaterThanOrEqual(1)
      const bad = await e.card!(CARD_INPUTS[k], { db: brokenDb, adminId: "a" })
      expect(bad.lines.length, k).toBeGreaterThanOrEqual(1)
    }
  })

  it("no card ever contains a stored or typed secret", async () => {
    for (const e of SETTINGS_ENTRIES.filter((x) => x.kind === "change")) {
      const k = key(e.method, e.path)
      expect(await text(k), k).not.toContain("SECRETSECRET")
    }
  })

  it("switch cards show the current state, the new state and what changes for customers", async () => {
    const t = await text("POST /api/admin/settings/turnstile")
    expect(t).toMatch(/Now: ON/)
    expect(t).toMatch(/After this: OFF/)
    expect(t).toMatch(/bot check/i)
    const auto = await text("POST /api/admin/settings/mtn-auto-fulfillment")
    expect(auto).toMatch(/Now: ON/)
    expect(auto).toMatch(/After this: OFF/)
    expect(auto).toMatch(/wait/i)
    const same = await text("POST /api/admin/settings/storefront-otp", { body: { enabled: false } })
    expect(same).toMatch(/already OFF/i)
    const unread = await text("POST /api/admin/settings/turnstile", undefined, brokenDb)
    expect(unread).toMatch(/could not be read/)
    const seed = await text("GET /api/admin/settings/mtn-auto-fulfillment")
    expect(seed).toMatch(/saves the default/i)
  })

  it("site settings card shows old -> new for every field sent and the global effects", async () => {
    const t = await text("PUT /api/admin/settings")
    expect(t).toContain("Ordering: ON -> OFF")
    expect(t).toMatch(/cannot place orders|no one can order/i)
    expect(t).toContain("3% -> 2.5%")
    expect(t).toContain("https://old.example.com/join -> https://new.example.com/join")
    expect(t).toContain("233241234567") // the stored (normalised) bot number, in full
    expect(t).not.toMatch(/Signups/)
    const roles = await text("PUT /api/admin/settings", { body: { signup_default_role: "dealer", signups_enabled: false } })
    expect(roles).toMatch(/every new signup/i)
    expect(roles).toMatch(/Signups: ON -> OFF/)
    const price = await text("PUT /api/admin/settings", { body: { price_adjustment_mtn: 0.5 } })
    expect(price).toContain("0% -> 0.5%")
    expect(price).toMatch(/public price pages/i)
  })

  it("provider cards show old and new and the order effect", async () => {
    const p = await text("POST /api/admin/settings/mtn-provider")
    expect(p).toContain("sykes -> hubnet")
    expect(p).toMatch(/new MTN orders/i)
    const d = await text("POST /api/admin/settings/mtn-disabled-providers")
    expect(d).toMatch(/Newly deactivated: sykes/)
    expect(d).toMatch(/Reactivated: none/)
    const r = await text("POST /api/admin/settings/mtn-retry-sequence")
    expect(r).toMatch(/OFF -> ON/)
    expect(r).toContain("xpress, codecraft")
    const n = await text("POST /api/admin/settings/network-provider")
    expect(n).toContain("codecraft -> xpress")
    expect(n).toMatch(/Telecel/)
  })

  it("prefix cards say who owns a prefix and refuse the impossible", async () => {
    const add = await text("POST /api/admin/settings/network-prefixes")
    expect(add).toMatch(/058/)
    expect(add).toMatch(/audit/i)
    const owned = await text("POST /api/admin/settings/network-prefixes", { body: { network: "TELECEL", prefix: "24", action: "add" } })
    expect(owned).toMatch(/already assigned to MTN/)
    const last = await text("POST /api/admin/settings/network-prefixes", { body: { network: "TELECEL", prefix: "20", action: "remove" } })
    expect(last).toMatch(/last TELECEL prefix/i)
    const missing = await text("POST /api/admin/settings/network-prefixes", { body: { network: "AT", prefix: "57", action: "remove" } })
    expect(missing).toMatch(/not assigned/)
  })

  it("direct-charge cards say which payment surfaces change", async () => {
    const s = await text("POST /api/admin/settings/storefront-direct-charge")
    expect(s).toMatch(/storefront/i)
    expect(s).toMatch(/checkout -> direct/)
    const w = await text("POST /api/admin/settings/wallet-direct-charge")
    expect(w).toMatch(/wallet top-up/i)
    expect(w).toMatch(/dashboard/i)
    expect(w).toMatch(/SMS/)
  })

  it("gateway card lists only changed surfaces with old -> new, and names Hubtel", async () => {
    const t = await text("PUT /api/admin/gateway")
    expect(t).toContain("paystack -> hubtel")
    expect(t).toContain("checkout -> direct")
    expect(t).toContain("customer -> merchant")
    expect(t).toContain("1.5% -> 2%")
    expect(t).not.toMatch(/Wallet top-up:/)
    expect(t).toMatch(/Hubtel is not set up on the server/i)
  })

  it("hubtel payment card names the payment and every effect of each action", async () => {
    const f = await text("POST /api/admin/gateway/hubtel-payments")
    expect(f).toContain("GHS 20.50")
    expect(f).toContain("needs_review")
    expect(f).toMatch(/delivered|credited/i)
    const m = await text("POST /api/admin/gateway/hubtel-payments", { body: { action: "refunded_manually", reference: REF, admin_reference: "MP12345678", note: "paid back by MoMo" } })
    expect(m).toContain("MP12345678")
    expect(m).toContain("paid back by MoMo")
    expect(m).toMatch(/No money moves/)
    const x = await text("POST /api/admin/gateway/hubtel-payments", { body: { action: "mark_failed", reference: REF } })
    expect(x).toMatch(/order itself is not changed/i)
    const r = await text("POST /api/admin/gateway/hubtel-payments", { body: { action: "recheck", reference: REF } })
    expect(r).toMatch(/Writes nothing|nothing is changed/i)
  })

  it("ai-config card shows old -> new for settings, names each key as replaced, and warns about admin access", async () => {
    const t = await text("PUT /api/admin/ai-config")
    expect(t).toContain("Old Bot -> New Bot")
    expect(t).toContain("Admin catalog access: ON -> OFF")
    expect(t).toMatch(/loses|lose/i)
    expect(t).toMatch(/admin pages/i)
    expect(t).toContain("anthropic -> openai")
    expect(t).toContain("claude-haiku-4-5-20251001 -> gpt-4o")
    for (const p of ["Anthropic", "OpenAI", "Gemini", "DeepSeek", "Groq"]) expect(t).toContain(`${p} API key: will be replaced`)
    expect(t).not.toContain(SECRET_SENTINEL)
    const on = await text("PUT /api/admin/ai-config", { body: { admin_catalog_enabled: true } })
    expect(on).not.toMatch(/loses/i)
  })

  it("domain, support and delivery cards show full new values", async () => {
    const c = await text("POST /api/admin/custom-domains")
    expect(c).toContain("new.example.com")
    expect(c).toContain("New Shop")
    expect(c).toContain("Kofi Shop")
    expect(c).toMatch(/kofi/)
    const p = await text("PATCH /api/admin/custom-domains")
    expect(p).toContain("Old Shop -> Renamed")
    expect(p).toContain("active -> not active")
    const del = await text("DELETE /api/admin/custom-domains")
    expect(del).toContain("shop.example.com")
    expect(del).toMatch(/stops working|no longer/i)
    const s = await text("POST /api/admin/support-settings")
    expect(s).toContain("233201111111 -> 233209998888")
    expect(s).toContain("old@datagod.store -> help@datagod.store")
    const dc = await text("POST /api/admin/delivery-channels")
    expect(dc).toContain("supplier outage")
    expect(dc).toMatch(/frozen/i)
  })

  it("rate limit reset counts the same rows the handler deletes", async () => {
    const t = await text("POST /api/admin/rate-limits/reset")
    expect(t).toContain("/api/login")
    expect(t).toContain("1.2.3.4")
    expect(t).toMatch(/2 logged block/)
  })

  it("knowledge cards show the full new text and the old entry", async () => {
    const c = await text("POST /api/admin/ai-knowledge")
    expect(c).toContain("Where do I pay?")
    expect(c).toContain("Only inside the app.")
    expect(c).toMatch(/customers|assistants/i)
    const p = await text("PATCH /api/admin/ai-knowledge")
    expect(p).toContain("Use MoMo. -> Use MoMo or the wallet.")
    const d = await text("DELETE /api/admin/ai-knowledge")
    expect(d).toContain("How do I pay?")
  })

  it("whitelist number cards show every normalised number and what was dropped", async () => {
    const add = await text("POST /api/admin/settings/ussd-whitelist/numbers")
    expect(add).toContain("0551234567")
    expect(add).toContain("0241112222")
    expect(add).toMatch(/1 .*ignored|dropped/i)
    const del = await text("DELETE /api/admin/settings/ussd-whitelist/numbers")
    expect(del).toContain("0241234567")
    expect(del).toMatch(/blocked from USSD/i)
  })

  it("fees and the others read old values from the database", async () => {
    expect(await text("POST /api/admin/settings/balance-threshold")).toContain("GHS 500 -> GHS 800")
    expect(await text("POST /api/admin/settings/blocked-numbers")).toMatch(/OFF -> ON/)
    expect(await text("POST /api/admin/settings/google-review-url")).toContain("https://g.page/r/old -> https://g.page/r/new")
    expect(await text("POST /api/admin/settings/public-ussd-codes")).toContain("*920# -> *920*5#")
    expect(await text("PUT /api/admin/christmas-theme")).toMatch(/OFF -> ON/)
    expect(await text("POST /api/admin/settings/customer-verification")).toContain("xpress, hubnet")
    const strict = await text("PUT /api/admin/settings/strict-supplier-verify")
    expect(strict).toMatch(/Now: OFF/)
    expect(strict).toMatch(/After this: ON/)
  })
})
