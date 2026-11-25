import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { MESSAGING_ENTRIES } from "./messaging"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import type { CatalogEntry, Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`
const byKey = (k: string): CatalogEntry => MESSAGING_ENTRIES.find((e) => key(e.method, e.path) === k)!

const U1 = "11111111-1111-4111-8111-000000000001"
const U2 = "22222222-2222-4222-8222-000000000002"
const U3 = "33333333-3333-4333-8333-000000000003"

const CATALOGUED = [
  "GET /api/admin/sms-groups",
  "GET /api/admin/sms-groups/:id",
  "POST /api/admin/sms-groups",
  "PATCH /api/admin/sms-groups/:id",
  "DELETE /api/admin/sms-groups/:id",
  "POST /api/admin/sms-contacts",
  "PATCH /api/admin/sms-contacts/:id",
  "DELETE /api/admin/sms-contacts/:id",
  "GET /api/admin/sms-templates",
  "POST /api/admin/sms-templates",
  "PATCH /api/admin/sms-templates/:id",
  "DELETE /api/admin/sms-templates/:id",
  "GET /api/admin/sms-opt-outs",
  "POST /api/admin/sms-opt-outs",
  "DELETE /api/admin/sms-opt-outs",
  "GET /api/admin/sms-sender-ids",
  "POST /api/admin/sms-sender-ids",
  "POST /api/admin/sms-sender-ids/approve",
  "POST /api/admin/sms-sender-ids/reject",
  "POST /api/admin/sms-sender-ids/fetch-status",
  "POST /api/admin/sms-sender-ids/poll",
  "POST /api/admin/sms-sender-ids/push",
  "GET /api/admin/sms-settings",
  "PATCH /api/admin/sms-settings",
  "GET /api/admin/sms/bundles",
  "POST /api/admin/sms/bundles",
  "PATCH /api/admin/sms/bundles",
  "DELETE /api/admin/sms/bundles",
  "POST /api/admin/sms/allocate",
  "GET /api/admin/sms-supply",
  "GET /api/admin/shop-sms",
  "PATCH /api/admin/shop-sms",
  "POST /api/admin/shop-sms",
  "GET /api/admin/sms-platform/overview",
  "GET /api/admin/sms-platform/accounts",
  "PATCH /api/admin/sms-platform/accounts/:id",
  "GET /api/admin/sms-platform/business-reviews",
  "POST /api/admin/sms-platform/business-reviews/:id",
  "GET /api/admin/sms-platform/flags",
  "POST /api/admin/sms-platform/flags/:id",
  "GET /api/admin/sms-platform/hubtel-balance",
  "GET /api/admin/sms-platform/messages",
  "GET /api/admin/sms-platform/sender-ids",
  "POST /api/admin/sms-platform/sender-ids/:id",
  "GET /api/admin/sms-platform/settings",
  "PATCH /api/admin/sms-platform/settings",
  "GET /api/admin/sms-health",
  "GET /api/admin/broadcast/shop-buyers",
  "POST /api/admin/broadcast",
  "POST /api/admin/broadcast/retry",
  "POST /api/admin/notify",
  "GET /api/admin/test-email",
  "POST /api/admin/test-email",
  "GET /api/admin/support/counts",
  "GET /api/admin/support/threads",
  "GET /api/admin/support/threads/:id",
  "POST /api/admin/support/threads/:id",
  "GET /api/admin/complaints",
  "POST /api/admin/complaints/resolve",
  "GET /api/admin/whatsapp-inbox",
  "GET /api/admin/whatsapp-inbox/unread-count",
  "GET /api/admin/whatsapp-inbox/:phone",
  "POST /api/admin/whatsapp-inbox/send",
  "POST /api/admin/whatsapp-inbox/takeover",
  "POST /api/admin/whatsapp-inbox/bulk",
  "POST /api/admin/whatsapp-inbox/resolve-complaint",
  "GET /api/admin/whatsapp/cashback-visibility",
  "POST /api/admin/whatsapp/cashback-visibility",
]

const EXCLUDED_HERE = [
  "GET /api/admin/broadcast/recipients",
  "POST /api/admin/sms-platform/flags/held/:id",
  "GET /api/admin/sms-platform/business-reviews/:id",
  "POST /api/admin/whatsapp-inbox/typing",
  "POST /api/admin/whatsapp-inbox/send-media",
  "POST /api/admin/complaints/evidence-urls",
]

// GETs that only leave a read marker (opened-by-admin tick, admin presence, an audit-free "read" flag) and are kept as lookups
// on purpose: an admin has to be able to read these chats. Nothing else in this group may write from a GET.
const READ_MARKER_GETS = ["GET /api/admin/support/threads", "GET /api/admin/support/threads/:id", "GET /api/admin/whatsapp-inbox/:phone"]

describe("messaging catalog coverage", () => {
  it("catalogues exactly the listed routes, registered in CATALOG, none pending or excluded", () => {
    expect(MESSAGING_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    expect(CATALOGUED.length).toBe(68)
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
      expect(EXCLUDED.some((x) => key(x.method, x.path) === k), k).toBe(false)
    }
  })

  it("excluded rows are justified and out of PENDING and CATALOG", () => {
    expect(EXCLUDED_HERE.length).toBe(6)
    for (const k of EXCLUDED_HERE) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).not.toContain(k)
      const row = EXCLUDED.find((x) => key(x.method, x.path) === k)
      expect(row?.reason.length ?? 0, k).toBeGreaterThan(20)
    }
  })

  it("leaves no messaging-area route in PENDING", () => {
    const area = /^(DELETE|GET|PATCH|POST|PUT) \/api\/admin\/(sms|sms-platform|sms-sender-ids|sms-templates|sms-groups|sms-contacts|sms-settings|sms-supply|sms-health|sms-opt-outs|shop-sms|broadcast|notify|whatsapp|whatsapp-inbox|support|complaints|test-email)(\/|$)/
    expect(PENDING.filter((k) => area.test(k))).toEqual([])
  })

  it("ids are unique and area is messaging", () => {
    const ids = MESSAGING_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of MESSAGING_ENTRIES) expect(e.area).toBe("messaging")
  })
})

describe("messaging catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of MESSAGING_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of MESSAGING_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card, every GET is a lookup (read markers named)", () => {
    for (const e of MESSAGING_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      else expect(e.kind, e.id).toBe("lookup")
      if (e.kind === "change") expect(typeof e.card, e.id).toBe("function")
    }
    for (const k of READ_MARKER_GETS) expect(byKey(k).summary.toLowerCase(), k).toMatch(/mark|read|present|delivered/)
  })

  it("lookups never keep secrets, keys, tokens, raw payloads, signed links or tool context", () => {
    for (const e of MESSAGING_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        expect(p, e.id).not.toMatch(/password|token|secret|hash|api_?key|payload|signed|attachment|evidence_paths|tool_context|meta_message_id|(^|[._\]])(raw|html)($|[._])/i)
      }
    }
  })

  it("risk tiers: sends to many, switches, approvals and moderation are danger; prices and credits are money", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const danger = [
      "POST /api/admin/broadcast", "POST /api/admin/broadcast/retry",
      "POST /api/admin/sms-sender-ids/approve", "POST /api/admin/sms-sender-ids/reject", "POST /api/admin/sms-platform/sender-ids/:id",
      "POST /api/admin/sms-platform/business-reviews/:id", "PATCH /api/admin/sms-platform/settings", "PATCH /api/admin/sms-platform/accounts/:id",
      "POST /api/admin/sms-platform/flags/:id", "PATCH /api/admin/sms-settings", "PATCH /api/admin/shop-sms", "POST /api/admin/shop-sms",
      "DELETE /api/admin/sms-groups/:id", "DELETE /api/admin/sms-opt-outs", "POST /api/admin/whatsapp-inbox/bulk", "POST /api/admin/whatsapp/cashback-visibility",
    ]
    const money = ["POST /api/admin/sms/allocate", "POST /api/admin/sms/bundles", "PATCH /api/admin/sms/bundles", "DELETE /api/admin/sms/bundles"]
    for (const k of danger) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.danger)
    for (const k of money) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.money)
  })

  it("auth: support and complaints routes use requireSupportAdmin; the rest verifyAdminAccess or the sms admin guard (admin)", () => {
    for (const e of MESSAGING_ENTRIES) {
      const support = e.path.startsWith("/api/admin/support/") || e.path.startsWith("/api/admin/complaints")
      expect(e.auth, e.id).toBe(support ? "support_admin" : "admin")
    }
  })

  it("timeouts stay within 60 s and provider-calling or sending routes are given time", () => {
    for (const e of MESSAGING_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
    for (const k of [
      "POST /api/admin/broadcast", "POST /api/admin/broadcast/retry", "POST /api/admin/notify", "POST /api/admin/sms-sender-ids/poll",
      "POST /api/admin/sms-sender-ids/push", "POST /api/admin/sms-sender-ids/fetch-status", "POST /api/admin/whatsapp-inbox/bulk",
    ]) expect(byKey(k).timeoutMs, k).toBeGreaterThanOrEqual(30000)
  })

  it("declares a param for every :name segment", () => {
    for (const e of MESSAGING_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("no secret input fields exist here and none appears in a schema (no provider credential is taken by any route)", () => {
    for (const e of MESSAGING_ENTRIES) {
      expect(e.secretFields, e.id).toBeUndefined()
      for (const schema of [e.query, e.body].filter(Boolean)) {
        for (const k of Object.keys(schema!.shape)) expect(k, e.id).not.toMatch(/secret|api_?key|token|password/i)
      }
    }
  })

  it("schemas mirror the handlers", () => {
    const bc = byKey("POST /api/admin/broadcast").body!
    const base = { action: "init", channels: ["sms"], message: "Hello", recipients: { type: "roles", roles: ["dealer"] } }
    expect(bc.safeParse(base).success).toBe(true)
    expect(bc.safeParse({ ...base, action: "legacy" }).success).toBe(false)
    expect(bc.safeParse({ ...base, channels: [] }).success).toBe(false)
    expect(bc.safeParse({ ...base, channels: ["fax"] }).success).toBe(false)
    expect(bc.safeParse({ ...base, message: "" }).success).toBe(false)
    expect(bc.safeParse({ ...base, message: "x".repeat(5001) }).success).toBe(false)
    expect(bc.safeParse({ ...base, subject: "x".repeat(201) }).success).toBe(false)
    expect(bc.safeParse({ ...base, smsProvider: "twilio" }).success).toBe(false)
    expect(bc.safeParse({ ...base, recipients: { type: "roles", roles: [] } }).success).toBe(false)
    expect(bc.safeParse({ ...base, recipients: { type: "everyone" } }).success).toBe(false)
    expect(bc.safeParse({ ...base, recipients: { type: "shop_owners" } }).success).toBe(true)
    expect(bc.safeParse({ ...base, recipients: { type: "group", groupId: U1 } }).success).toBe(true)
    expect(bc.safeParse({ ...base, recipients: { type: "shop_buyers", shopIds: "all", sinceDays: 90 } }).success).toBe(true)
    expect(bc.safeParse({ ...base, recipients: { type: "shop_buyers", shopIds: "all", sinceDays: 7 } }).success).toBe(false)
    expect(bc.safeParse({ ...base, recipients: { type: "shop_buyers", shopIds: [], sinceDays: 30 } }).success).toBe(false)
    expect(bc.safeParse({ ...base, recipients: { type: "specific", users: [{ phone: "0241234567" }] } }).success).toBe(true)
    expect(bc.safeParse({ ...base, recipients: { type: "specific", users: [] } }).success).toBe(false)
    for (const t of ["all_users", "all_dealers", "all_admins"]) expect(byKey("POST /api/admin/notify").body!.safeParse({ target: t, channels: ["push"], title: "T", body: "B" }).success, t).toBe(false)
    expect(byKey("POST /api/admin/notify").body!.safeParse({ target: "specific_user", title: "T", body: "B" }).success).toBe(false)
    expect(byKey("POST /api/admin/notify").summary).toMatch(/use Broadcast \(queued and logged\)/)
    expect(byKey("POST /api/admin/notify").body!.safeParse({ target: "everyone", title: "T", body: "B" }).success).toBe(false)
    expect(byKey("POST /api/admin/notify").body!.safeParse({ target: "specific_user", user_id: U1, title: "T", body: "B" }).success).toBe(true)
    expect(byKey("POST /api/admin/notify").body!.safeParse({ target: "specific_user", user_id: "abc", title: "T", body: "B" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms/allocate").body!.safeParse({ accountId: U1, units: 100, requestId: U2 }).success).toBe(true)
    expect(byKey("POST /api/admin/sms/allocate").body!.safeParse({ accountId: U1, units: 0 }).success).toBe(false)
    expect(byKey("POST /api/admin/sms/allocate").body!.safeParse({ accountId: U1, units: 1.5 }).success).toBe(false)
    expect(byKey("POST /api/admin/sms/allocate").body!.safeParse({ accountId: U1, units: 1_000_001 }).success).toBe(false)
    expect(byKey("POST /api/admin/sms/bundles").body!.safeParse({ name: "Starter", units: 100, price_ghs: 4 }).success).toBe(true)
    expect(byKey("POST /api/admin/sms/bundles").body!.safeParse({ name: "Starter", units: 100, price_ghs: 0 }).success).toBe(false)
    expect(byKey("POST /api/admin/sms/bundles").body!.safeParse({ name: "Starter", units: 100, price_ghs: 4, mode: "x" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms/bundles").body!.safeParse({ id: U1, active: false }).success).toBe(true)
    expect(byKey("DELETE /api/admin/sms/bundles").query!.safeParse({ id: U1 }).success).toBe(true)
    expect(byKey("DELETE /api/admin/sms/bundles").query!.safeParse({}).success).toBe(false)
    expect(byKey("POST /api/admin/sms-sender-ids/approve").body!.safeParse({ id: U1, provider: "both" }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-sender-ids/approve").body!.safeParse({ id: U1, provider: "twilio" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-sender-ids/push").body!.safeParse({ id: U1, provider: "both" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-sender-ids").body!.safeParse({ sender_id: "DATAGOD" }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-sender-ids").body!.safeParse({ sender_id: "TOOLONGSENDERID" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms-settings").body!.safeParse({ primary: "hubtel", fallbacks: ["moolre"] }).success).toBe(true)
    expect(byKey("PATCH /api/admin/sms-settings").body!.safeParse({ primary: "twilio" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms-settings").body!.safeParse({ categoryProviders: { otp: "hubtel" } }).success).toBe(true)
    expect(byKey("PATCH /api/admin/sms-settings").body!.safeParse({ categoryProviders: { nonsense: "hubtel" } }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms-platform/settings").body!.safeParse({ section: "switch", values: { featureEnabled: false } }).success).toBe(true)
    expect(byKey("PATCH /api/admin/sms-platform/settings").body!.safeParse({ section: "sms_policy_enforced", values: {} }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms-platform/accounts/:id").body!.safeParse({ api_rate_limit_override: null }).success).toBe(true)
    expect(byKey("PATCH /api/admin/sms-platform/accounts/:id").body!.safeParse({ api_rate_limit_override: 0 }).success).toBe(false)
    expect(byKey("PATCH /api/admin/sms-platform/accounts/:id").body!.safeParse({ mode: "vip" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-platform/business-reviews/:id").body!.safeParse({ action: "approve" }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-platform/business-reviews/:id").body!.safeParse({ action: "delete" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-platform/flags/:id").body!.safeParse({ source: "flag", action: "dismiss" }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-platform/flags/:id").body!.safeParse({ source: "other", action: "dismiss" }).success).toBe(false)
    expect(byKey("POST /api/admin/support/threads/:id").body!.safeParse({ action: "reply", message: "Hi" }).success).toBe(true)
    expect(byKey("POST /api/admin/support/threads/:id").body!.safeParse({ action: "reply", message: "   " }).success).toBe(false)
    expect(byKey("POST /api/admin/support/threads/:id").body!.safeParse({ action: "close", note: "Done" }).success).toBe(true)
    expect(byKey("POST /api/admin/support/threads/:id").body!.safeParse({ action: "read" }).success).toBe(true)
    expect(byKey("POST /api/admin/support/threads/:id").body!.safeParse({ action: "nuke" }).success).toBe(false)
    expect(byKey("POST /api/admin/complaints/resolve").body!.safeParse({ id: U1, status: "resolved", resolution_notes: "ok" }).success).toBe(true)
    expect(byKey("POST /api/admin/complaints/resolve").body!.safeParse({ id: U1, status: "closed", resolution_notes: "ok" }).success).toBe(false)
    expect(byKey("POST /api/admin/whatsapp-inbox/send").body!.safeParse({ phone: "233241234567", message: "Hi" }).success).toBe(true)
    expect(byKey("POST /api/admin/whatsapp-inbox/send").body!.safeParse({ phone: "233241234567", message: "x".repeat(4001) }).success).toBe(false)
    expect(byKey("POST /api/admin/whatsapp-inbox/takeover").body!.safeParse({ phone: "233241234567", action: "pause" }).success).toBe(false)
    expect(byKey("POST /api/admin/whatsapp-inbox/bulk").body!.safeParse({ action: "mark_all_read" }).success).toBe(true)
    expect(byKey("POST /api/admin/whatsapp-inbox/bulk").body!.safeParse({ action: "delete_all" }).success).toBe(false)
    expect(byKey("POST /api/admin/test-email").body!.safeParse({ to: "a@b.co" }).success).toBe(true)
    expect(byKey("POST /api/admin/test-email").body!.safeParse({ to: "nope" }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-templates").body!.safeParse({ name: "Promo", body: "x".repeat(1000) }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-templates").body!.safeParse({ name: "Promo", body: "x".repeat(1001) }).success).toBe(false)
    expect(byKey("POST /api/admin/sms-contacts").body!.safeParse({ group_id: U1, phone_number: "0241234567" }).success).toBe(true)
    expect(byKey("POST /api/admin/sms-contacts").body!.safeParse({ group_id: U1, rows: [{ phone_number: "0241234567" }] }).success).toBe(true)
    expect(byKey("POST /api/admin/whatsapp/cashback-visibility").body!.safeParse({ payBills: true }).success).toBe(true)
    expect(byKey("POST /api/admin/whatsapp/cashback-visibility").body!.safeParse({ payBills: "yes" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/shop-sms").body!.safeParse({ sms_feature_enabled: false }).success).toBe(true)
    expect(byKey("PATCH /api/admin/shop-sms").body!.safeParse({ sms_activation_fee: -1 }).success).toBe(false)
    expect(byKey("POST /api/admin/shop-sms").body!.safeParse({ action: "set_suspended", accountId: U1, suspended: true }).success).toBe(true)
    expect(byKey("POST /api/admin/shop-sms").body!.safeParse({ action: "wipe" }).success).toBe(false)
  })
})

// ---- card tests with a tiny fake db ------------------------------------------------------------------------------

type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[]>, rpcs: Record<string, Row[]> = {}): SupabaseClient {
  const make = (rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = []
    let from = 0
    let to = Infinity
    const b: any = {
      select() { return b },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b },
      not(c: string, _op: string, v: unknown) { filters.push((r) => (r[c] ?? null) !== v); return b },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
      gte() { return b },
      order() { return b },
      limit() { return b },
      range(f: number, t: number) { from = f; to = t; return b },
      maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
      single() { return b.maybeSingle() },
      then(res: any, rej: any) {
        const d = rows.filter((r) => filters.every((f) => f(r)))
        return Promise.resolve({ data: d.slice(from, to === Infinity ? undefined : to + 1), count: d.length, error: null }).then(res, rej)
      },
    }
    return b
  }
  return {
    from(table: string) { return make(tables[table] ?? []) },
    rpc(fn: string) { return make(rpcs[fn] ?? []) },
  } as unknown as SupabaseClient
}

const brokenDb = { from() { throw new Error("db down") }, rpc() { throw new Error("db down") } } as unknown as SupabaseClient

const tables: Record<string, Row[]> = {
  users: [
    { id: U1, email: "ama@example.com", phone_number: "0241112222", first_name: "Ama", last_name: "Mensah", role: "dealer" },
    { id: U2, email: "kofi@example.com", phone_number: "0243334444", first_name: "Kofi", last_name: "Boateng", role: "dealer" },
    { id: U3, email: null, phone_number: null, first_name: "Esi", last_name: "Owusu", role: "user" },
  ],
  user_shops: [
    { id: "s1", user_id: U1, users: { id: U1, email: "ama@example.com", phone_number: "0241112222", first_name: "Ama" } },
    { id: "s2", user_id: U1, users: { id: U1, email: "ama@example.com", phone_number: "0241112222", first_name: "Ama" } },
    { id: "s3", user_id: U2, users: { id: U2, email: "kofi@example.com", phone_number: "0243334444", first_name: "Kofi" } },
  ],
  sms_groups: [{ id: U1, name: "VIPs", description: "Top buyers", sms_account_id: null }],
  sms_contacts: [
    { id: U2, group_id: U1, phone_number: "0241234567", first_name: "Yaw", last_name: "Asare", opted_out: false, sms_groups: { sms_account_id: null } },
    { id: U3, group_id: U1, phone_number: "0201112222", first_name: "Abena", last_name: null, opted_out: true, sms_groups: { sms_account_id: null } },
    { id: "c4", group_id: U1, phone_number: "0241234567", first_name: "Dup", last_name: null, opted_out: false, sms_groups: { sms_account_id: null } },
  ],
  sms_templates: [{ id: U1, name: "Promo", body: "Old promo text" }],
  sms_bundles: [{ id: U1, name: "Starter", units: 100, price_ghs: 4, active: true, mode: "platform", owner_type_scope: "all", sort_order: 0 }],
  sms_accounts: [{ id: U1, user_id: U2, mode: "platform", status: "active", unit_balance: 250, review_hold: false, api_rate_limit_override: null, default_sender_id: null }],
  sms_sender_ids: [
    { id: U1, sender_id: "ACMEBIZ", local_status: "pending", mnotify_local_status: "pending", sms_account_id: U1 },
    { id: U2, sender_id: "DATAGOD", local_status: "pending", mnotify_local_status: "pending", sms_account_id: null },
  ],
  sms_business_profiles: [{ id: U1, sms_account_id: U1, business_name: "Acme Ltd", status: "submitted" }],
  admin_settings: [
    { key: "sms_primary_provider", value: "moolre" },
    { key: "sms_fallback_providers", value: ["mnotify"] },
    { key: "whatsapp_cashback_visibility", value: { networkPlans: true, payBills: false, cashbackAirtime: false } },
  ],
  tenant_global_settings: [
    { key: "sms_feature_enabled", value: true },
    { key: "sms_activation_fee", value: { amount: 5 } },
    { key: "sms_price_per_credit", value: { amount: 0.04 } },
    { key: "sms_welcome_bonus_credits", value: { units: 10 } },
  ],
  broadcast_logs: [{ id: U1, channels: ["sms", "email"], subject: "Promo", message: "Big sale today only", status: "completed", target_type: "roles" }],
  broadcast_recipients: [
    { id: "r1", broadcast_id: U1, status: "failed" },
    { id: "r2", broadcast_id: U1, status: "failed" },
    { id: "r3", broadcast_id: U1, status: "sent" },
  ],
  support_threads: [{ id: U1, user_id: U2, subject: "Where is my data", status: "open", handler: "ai" }],
  complaints: [{ id: U1, user_id: U2, title: "Wrong network", status: "pending", description: "I was charged twice" }],
  whatsapp_conversations: [{ phone_number: "233241234567", wa_profile_name: "Yaw", human_takeover: false, latest_inbound_at: new Date(Date.now() - 3600_000).toISOString(), wants_human: true }],
  whatsapp_complaints: [
    { id: "w1", phone_number: "233241234567", status: "open" },
    { id: "w2", phone_number: "233241234567", status: "claimed" },
    { id: "w3", phone_number: "233200000000", status: "open" },
  ],
}
const db = fakeDb(tables, {})
const ctx = { db, adminId: U3 }
const text = (c: { summary: string; lines: { label: string; value: string }[] }) => [c.summary, ...c.lines.map((l) => `${l.label}: ${l.value}`)].join("\n")

async function card(k: string, input: Parameters<NonNullable<CatalogEntry["card"]>>[0], useCtx = ctx) {
  const e = byKey(k)
  const c = await e.card!(input, useCtx)
  expect(c.summary.length, k).toBeGreaterThan(0)
  expect(c.lines.length, k).toBeGreaterThanOrEqual(1)
  return text(c)
}

describe("messaging cards", () => {
  it("every change card still answers when the database is down", async () => {
    const inputs: Record<string, any> = {
      "POST /api/admin/broadcast": { body: { action: "init", channels: ["sms"], message: "Hi all", recipients: { type: "roles", roles: ["dealer"] } } },
      "POST /api/admin/notify": { body: { target: "all_users", channels: ["sms"], title: "Hi", body: "There" } },
      "POST /api/admin/whatsapp-inbox/send": { body: { phone: "233241234567", message: "Hello" } },
      "PATCH /api/admin/sms-platform/settings": { body: { section: "switch", values: { featureEnabled: false } } },
      "POST /api/admin/support/threads/:id": { params: { id: U1 }, body: { action: "reply", message: "Hello" } },
    }
    for (const e of MESSAGING_ENTRIES.filter((x) => x.kind === "change")) {
      const input = inputs[key(e.method, e.path)] ?? { params: Object.fromEntries(Object.keys(e.params ?? {}).map((p) => [p, U1])), body: {}, query: {} }
      const c = await e.card!(input, { db: brokenDb, adminId: U3 })
      expect(c.lines.length, e.id).toBeGreaterThanOrEqual(1)
    }
  })

  it("broadcast to roles shows the channels, subject, the FULL message, the audience, the same count the handler enqueues and the queueing", async () => {
    const msg = "Big sale today: buy 5GB and get 1GB free, ends midnight! Visit datagod.store/sale"
    const t = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["sms", "email"], subject: "Flash sale", message: msg, recipients: { type: "roles", roles: ["dealer"] } } })
    expect(t).toContain(msg)
    expect(t).toContain("Flash sale")
    expect(t).toContain("SMS")
    expect(t).toMatch(/email/i)
    expect(t).toContain("dealer")
    expect(t).toMatch(/Recipients: 2\b/)
    expect(t).toMatch(/queue/i)
    expect(t).toMatch(/first 30|30 recipients/i)
    expect(t).toMatch(/SMS parts|parts per/i)
  })

  it("broadcast to shop owners counts each owner once (the handler's own de-duplication)", async () => {
    const t = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["push"], subject: "Hi", message: "Update", recipients: { type: "shop_owners" } } })
    expect(t).toMatch(/Recipients: 2\b/)
    expect(t).toMatch(/shop owner/i)
  })

  it("broadcast to a group counts what the sender resolves (invalid, opted-out and duplicate numbers dropped) and names merge fields", async () => {
    const t = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["sms"], message: "Hi [FirstName]", recipients: { type: "group", groupId: U1 } } })
    expect(t).toContain("VIPs")
    expect(t).toMatch(/Recipients: 1\b/)
    expect(t).toMatch(/opted out/i)
    expect(t).toMatch(/\[FirstName\]/)
    const off = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["sms"], message: "Hi [FirstName]", mergeFields: false, recipients: { type: "group", groupId: U1 } } })
    expect(off).toMatch(/not (be )?(filled|personali)/i)
  })

  it("broadcast to specific people lists them in full and counts the de-duplicated list", async () => {
    const t = await card("POST /api/admin/broadcast", {
      body: { action: "init", channels: ["sms"], message: "Hello there", recipients: { type: "specific", users: [{ phone: "0241234567", name: "Yaw" }, { phone: "0241234567" }, { email: "x@y.co" }] } },
    })
    expect(t).toContain("0241234567")
    expect(t).toContain("x@y.co")
    expect(t).toMatch(/Recipients: 2\b/)
  })

  it("broadcast always says to check history before sending again", async () => {
    const t = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["sms"], message: "Hi", recipients: { type: "roles", roles: ["dealer"] } } })
    expect(t).toContain("If the result can't be confirmed, check Broadcast history before sending again")
  })

  it("reply cards show the text as the handler trims it, and the support reply states the script-pattern refusal", async () => {
    const wa = await card("POST /api/admin/whatsapp-inbox/send", { body: { phone: "233241234567", message: "   padded hello   " } })
    expect(wa).toContain("Message (sent exactly like this): padded hello\n")
    const sup = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply", message: "  trimmed reply  " } })
    expect(sup).toContain("Reply (sent exactly like this): trimmed reply\n")
    const bad = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply", message: "click javascript:alert(1)" } })
    expect(bad).toMatch(/not allowed.*refused|refused.*not allowed/i)
    const ok = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply", message: "we only do this once" } })
    expect(ok).not.toMatch(/not allowed/i)
  })

  it("broadcast says when it cannot send (a bad action or missing subject) instead of promising", async () => {
    const t = await card("POST /api/admin/broadcast", { body: { action: "init", channels: ["email"], message: "No subject", recipients: { type: "roles", roles: ["dealer"] } } })
    expect(t).toMatch(/subject.*(required|refused)/i)
  })

  it("broadcast retry names the message, channels, and the count of failed recipients it will re-send", async () => {
    const t = await card("POST /api/admin/broadcast/retry", { body: { broadcastId: U1 } })
    expect(t).toContain("Big sale today only")
    expect(t).toMatch(/Failed recipients to re-send: 2\b/)
    expect(t).toMatch(/SMS/)
    expect(t).toMatch(/first 30|30 recipients/i)
  })

  it("notify shows the exact SMS text (title: body cut at 160), the push, the email subject/body and the audience count", async () => {
    const long = "B".repeat(200)
    const t = await card("POST /api/admin/notify", { body: { target: "all_dealers", channels: ["sms", "push", "email"], title: "Maintenance", body: long, email_html: "<p>Custom <b>html</b></p>" } })
    expect(t).toContain(`Maintenance: ${"B".repeat(160 - "Maintenance: ".length)}`)
    expect(t).toMatch(/cut off at 160/)
    expect(t).toContain("Maintenance")
    expect(t).toContain(long)
    expect(t).toContain("<p>Custom <b>html</b></p>")
    expect(t).toMatch(/Recipients: 2\b/)
    expect(t).toMatch(/dealer/)
  })

  it("notify to one person shows who (name and full contact) and a user that does not exist", async () => {
    const t = await card("POST /api/admin/notify", { body: { target: "specific_user", user_id: U1, channels: ["sms"], title: "Hi", body: "Your order is ready" } })
    expect(t).toContain("Ama Mensah")
    expect(t).toContain("0241112222")
    expect(t).toContain("Hi: Your order is ready")
    expect(t).toMatch(/Recipients: 1\b/)
    const none = await card("POST /api/admin/notify", { body: { target: "specific_user", user_id: "99999999-9999-4999-8999-999999999999", channels: ["push"], title: "T", body: "B" } })
    expect(none).toMatch(/no user|No user|nobody|0 recipients|Recipients: 0\b/i)
  })

  it("notify asks for a user id when the target is one person", async () => {
    const t = await card("POST /api/admin/notify", { body: { target: "specific_user", channels: ["push"], title: "T", body: "B" } })
    expect(t).toMatch(/user_id|user id/i)
  })

  it("whatsapp send shows the full number, the full text, the 24-hour warning state and the side effects", async () => {
    const t = await card("POST /api/admin/whatsapp-inbox/send", { body: { phone: "+233 24 123 4567", message: "Your refund has been processed." } })
    expect(t).toContain("233241234567")
    expect(t).toContain("Your refund has been processed.")
    expect(t).toMatch(/WhatsApp/)
    expect(t).toMatch(/wants? (a )?human|waiting/i)
    const stale = await card("POST /api/admin/whatsapp-inbox/send", { body: { phone: "233209999999", message: "Hello" } })
    expect(stale).toMatch(/24 hours|silently/i)
  })

  it("whatsapp takeover names the handoff message the customer gets and that the bot is muted and its session cleared", async () => {
    const take = await card("POST /api/admin/whatsapp-inbox/takeover", { body: { phone: "233241234567", action: "take" } })
    expect(take).toContain("You're now chatting with a member of our team.")
    expect(take).toMatch(/bot/i)
    expect(take).toMatch(/session|half-finished|flow/i)
    const rel = await card("POST /api/admin/whatsapp-inbox/takeover", { body: { phone: "233241234567", action: "release" } })
    expect(rel).toMatch(/bot.*resume|resume/i)
    expect(rel).not.toContain("You're now chatting")
  })

  it("whatsapp bulk and resolve-complaint use the handler's own filters for their counts", async () => {
    const resolveAll = await card("POST /api/admin/whatsapp-inbox/bulk", { body: { action: "resolve_complaints" } })
    expect(resolveAll).toMatch(/open complaints?: 2\b/i)
    expect(resolveAll).toContain("Bulk-resolved from the WhatsApp inbox")
    const wants = await card("POST /api/admin/whatsapp-inbox/bulk", { body: { action: "clear_wants_human" } })
    expect(wants).toMatch(/: 1\b/)
    const one = await card("POST /api/admin/whatsapp-inbox/resolve-complaint", { body: { phone: "233241234567", note: "Sorted on call" } })
    expect(one).toMatch(/open complaints?: 1\b/i)
    expect(one).toContain("Sorted on call")
    expect(one).toMatch(/email|SMS/i)
    const dflt = await card("POST /api/admin/whatsapp-inbox/resolve-complaint", { body: { phone: "233241234567" } })
    expect(dflt).toContain("Resolved from the WhatsApp inbox")
  })

  it("support reply shows the full reply, the customer, and the notices; close shows the note; a closed thread is refused", async () => {
    const t = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply", message: "We have credited your account." } })
    expect(t).toContain("We have credited your account.")
    expect(t).toContain("Where is my data")
    expect(t).toMatch(/Kofi Boateng/)
    expect(t).toMatch(/push|notice/i)
    const closed = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "close", note: "All done, thanks" } })
    expect(closed).toContain("All done, thanks")
    expect(closed).toMatch(/closed|close/i)
    const fake = fakeDb({ ...tables, support_threads: [{ id: U1, user_id: U2, subject: "S", status: "closed", handler: "human" }] })
    const refused = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply", message: "x" } }, { db: fake, adminId: U3 })
    expect(refused).toMatch(/closed.*refused|refused.*closed|already closed/i)
    const noMsg = await card("POST /api/admin/support/threads/:id", { params: { id: U1 }, body: { action: "reply" } })
    expect(noMsg).toMatch(/needs a message/i)
  })

  it("complaint resolve shows the status, the notes in full and that the customer is notified", async () => {
    const t = await card("POST /api/admin/complaints/resolve", { body: { id: U1, status: "rejected", resolution_notes: "No evidence of double charge" } })
    expect(t).toContain("Wrong network")
    expect(t).toContain("rejected")
    expect(t).toContain("No evidence of double charge")
    expect(t).toMatch(/notif|email|SMS/i)
  })

  it("test email shows the full recipient, subject and the fixed body", async () => {
    const t = await card("POST /api/admin/test-email", { body: { to: "someone@example.org" } })
    expect(t).toContain("someone@example.org")
    expect(t).toContain("Test Email from DataGod")
    expect(t).toMatch(/This is a test email to verify your email configuration/)
  })

  it("sender-ID approve and reject name the account, the sender, the provider override and the owner notice", async () => {
    const t = await card("POST /api/admin/sms-sender-ids/approve", { body: { id: U1, provider: "moolre" } })
    expect(t).toContain("ACMEBIZ")
    expect(t).toMatch(/customer|owner|account/i)
    expect(t).toMatch(/notif/i)
    const glob = await card("POST /api/admin/sms-sender-ids/approve", { body: { id: U2, provider: "both" } })
    expect(glob).toContain("DATAGOD")
    expect(glob).toMatch(/Moolre and mNotify|both/i)
    const rej = await card("POST /api/admin/sms-sender-ids/reject", { body: { id: U1, provider: "both", reason: "Looks like a bank name" } })
    expect(rej).toContain("Looks like a bank name")
    const noReason = await card("POST /api/admin/sms-sender-ids/reject", { body: { id: U1, provider: "both" } })
    expect(noReason).toContain("Rejected by admin")
    const plat = await card("POST /api/admin/sms-platform/sender-ids/:id", { params: { id: U1 }, body: { action: "revoke", reason: "Abuse" } })
    expect(plat).toContain("ACMEBIZ")
    expect(plat).toContain("Abuse")
  })

  it("business review approve names the business and the switch to Business mode; reject needs a long enough reason", async () => {
    const a = await card("POST /api/admin/sms-platform/business-reviews/:id", { params: { id: U1 }, body: { action: "approve" } })
    expect(a).toContain("Acme Ltd")
    expect(a).toMatch(/Business mode/)
    expect(a).toMatch(/notif/i)
    const r = await card("POST /api/admin/sms-platform/business-reviews/:id", { params: { id: U1 }, body: { action: "reject", reason: "abc" } })
    expect(r).toMatch(/5 characters|refused/i)
    const r2 = await card("POST /api/admin/sms-platform/business-reviews/:id", { params: { id: U1 }, body: { action: "reject", reason: "Documents unreadable" } })
    expect(r2).toContain("Documents unreadable")
  })

  it("credit allocation shows the account owner, the current balance, the units and warns when there is no request id", async () => {
    const t = await card("POST /api/admin/sms/allocate", { body: { accountId: U1, units: 500 } })
    expect(t).toContain("Kofi Boateng")
    expect(t).toMatch(/250/)
    expect(t).toMatch(/500/)
    expect(t).toMatch(/request id/i)
    expect(t).toMatch(/pending|solvency|backed/i)
    const withId = await card("POST /api/admin/sms/allocate", { body: { accountId: U1, units: 500, requestId: U2 } })
    expect(withId).toContain(U2)
  })

  it("bundle cards show old -> new prices in GHS", async () => {
    const t = await card("PATCH /api/admin/sms/bundles", { body: { id: U1, price_ghs: 6.5, active: false } })
    expect(t).toContain("Starter")
    expect(t).toContain("GHS 4.00 -> GHS 6.50")
    expect(t).toMatch(/Active: yes -> no|active.*->.*(no|off)/i)
    const c = await card("POST /api/admin/sms/bundles", { body: { name: "Mega", units: 5000, price_ghs: 120 } })
    expect(c).toContain("Mega")
    expect(c).toContain("GHS 120.00")
    expect(c).toContain("5,000")
    const d = await card("DELETE /api/admin/sms/bundles", { query: { id: U1 } })
    expect(d).toContain("Starter")
    expect(d).toMatch(/48 hours/)
  })

  it("provider routing shows old -> new for each field sent and that all SMS follows it", async () => {
    const t = await card("PATCH /api/admin/sms-settings", { body: { primary: "hubtel", fallbacks: ["moolre", "mnotify"], categoryProviders: { otp: "hubtel" } } })
    expect(t).toContain("moolre -> hubtel")
    expect(t).toContain("mnotify -> moolre, mnotify")
    expect(t).toMatch(/otp/i)
    expect(t).toMatch(/Hubtel balance|balance/i)
  })

  it("platform settings show the section, the full new values and the stored old values", async () => {
    const sw = await card("PATCH /api/admin/sms-platform/settings", { body: { section: "switch", values: { featureEnabled: false } } })
    expect(sw).toMatch(/switch/i)
    expect(sw).toMatch(/featureEnabled: false/)
    expect(sw).toMatch(/sms_feature_enabled/)
    expect(sw).toMatch(/true/)
    const kw = await card("PATCH /api/admin/sms-platform/settings", { body: { section: "platform_keywords", values: { blockedKeywords: ["scam", "lottery", "free-money"] } } })
    expect(kw).toContain("scam")
    expect(kw).toContain("free-money")
    const bad = await card("PATCH /api/admin/sms-platform/settings", { body: { section: "pricing", values: { activationFee: 5 } } })
    expect(bad).toMatch(/welcomeBonusCredits|refused|required/i)
  })

  it("shop-sms settings show old -> new and moderation shows the account and the action", async () => {
    const t = await card("PATCH /api/admin/shop-sms", { body: { sms_activation_fee: 8, sms_feature_enabled: false } })
    expect(t).toMatch(/\{"amount":5\}|5/)
    expect(t).toContain("8")
    expect(t).toMatch(/feature/i)
    const s = await card("POST /api/admin/shop-sms", { body: { action: "set_suspended", accountId: U1, suspended: true } })
    expect(s).toContain("Kofi Boateng")
    expect(s).toMatch(/suspend/i)
  })

  it("account control shows the account, old -> new for mode, review hold and rate limit, and that mode change pauses or unpauses sender IDs", async () => {
    const t = await card("PATCH /api/admin/sms-platform/accounts/:id", { params: { id: U1 }, body: { mode: "business", review_hold: true, api_rate_limit_override: 50 } })
    expect(t).toContain("Kofi Boateng")
    expect(t).toMatch(/platform -> business/)
    expect(t).toMatch(/pause|unpause/i)
    expect(t).toMatch(/50/)
    expect(t).toMatch(/hold/i)
  })

  it("flag action says suspend stops the SMS account", async () => {
    const t = await card("POST /api/admin/sms-platform/flags/:id", { params: { id: U1 }, body: { source: "flag", action: "suspend" } })
    expect(t).toMatch(/suspend/i)
    expect(t).toMatch(/SMS account/i)
  })

  it("address-book cards show the group, the numbers in full, and counts the handler would use", async () => {
    const g = await card("DELETE /api/admin/sms-groups/:id", { params: { id: U1 } })
    expect(g).toContain("VIPs")
    expect(g).toMatch(/3 contacts|Contacts deleted with it: 3/)
    const c = await card("POST /api/admin/sms-contacts", { body: { group_id: U1, phone_number: "0241234567", first_name: "New", last_name: "Person" } })
    expect(c).toContain("VIPs")
    expect(c).toContain("0241234567")
    expect(c).toContain("New Person")
    const bulk = await card("POST /api/admin/sms-contacts", { body: { group_id: U1, rows: [{ phone_number: "0241112222" }, { phone_number: "0241112222" }, { phone_number: "12" }] } })
    expect(bulk).toMatch(/Rows sent: 3\b/)
    expect(bulk).toContain("0241112222")
    const tpl = await card("PATCH /api/admin/sms-templates/:id", { params: { id: U1 }, body: { body: "Brand new promo wording" } })
    expect(tpl).toContain("Old promo text")
    expect(tpl).toContain("Brand new promo wording")
  })

  it("opt-out cards normalise the numbers like the handler and name the effect on marketing SMS", async () => {
    const add = await card("POST /api/admin/sms-opt-outs", { body: { phones: "0241234567, +233 20 111 2222; 123", reason: "asked to stop" } })
    expect(add).toContain("0241234567")
    expect(add).toContain("0201112222")
    expect(add).toMatch(/Numbers added: 2\b/)
    expect(add).toMatch(/Not valid: 1\b|invalid/i)
    expect(add).toContain("asked to stop")
    const del = await card("DELETE /api/admin/sms-opt-outs", { body: { phones: ["0241234567"] } })
    expect(del).toContain("0241234567")
    expect(del).toMatch(/marketing/i)
  })

  it("cashback switches show old -> new and that the bots start or stop offering it", async () => {
    const t = await card("POST /api/admin/whatsapp/cashback-visibility", { body: { payBills: true } })
    expect(t).toMatch(/payBills.*off -> on|payBills: OFF -> ON/i)
    expect(t).toMatch(/WhatsApp/)
  })

  it("provider sender-ID calls say they contact the provider", async () => {
    const t = await card("POST /api/admin/sms-sender-ids/push", { body: { id: U2, provider: "mnotify" } })
    expect(t).toContain("DATAGOD")
    expect(t).toMatch(/mNotify/)
    expect(t).toMatch(/register|registration/i)
    const poll = await card("POST /api/admin/sms-sender-ids/poll", { body: {} })
    expect(poll).toMatch(/Moolre|mNotify|provider/)
  })

  it("no card ever echoes a secret-looking field from rows it reads", async () => {
    const dirty = fakeDb({ ...tables, sms_sender_ids: [{ id: U1, sender_id: "X", local_status: "pending", sms_account_id: null, api_key: "SECRET-KEY-123" }] })
    const t = await card("POST /api/admin/sms-sender-ids/approve", { body: { id: U1, provider: "both" } }, { db: dirty, adminId: U3 })
    expect(t).not.toContain("SECRET-KEY-123")
  })
})
