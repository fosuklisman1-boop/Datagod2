import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { PLATFORM_ENTRIES } from "./platform"
import { CATALOG } from "../index"
import { EXCLUDED } from "../excluded"
import { PENDING, PENDING_BUDGET } from "../pending"
import { ADMIN_PAGES, pageTitleFor } from "../pages"
import type { CatalogEntry, Risk } from "../types"

const key = (method: string, path: string) => `${method} ${path}`
const byKey = (k: string): CatalogEntry => PLATFORM_ENTRIES.find((e) => key(e.method, e.path) === k)!

const U1 = "11111111-1111-4111-8111-000000000001"
const U2 = "22222222-2222-4222-8222-000000000002"
const U3 = "33333333-3333-4333-8333-000000000003"
const K1 = "44444444-4444-4444-8444-000000000004"
const K2 = "55555555-5555-4555-8555-000000000005"
const R1 = "66666666-6666-4666-8666-000000000006"
const P1 = "77777777-7777-4777-8777-000000000007"
const T1 = "88888888-8888-4888-8888-000000000008"

const CATALOGUED = [
  "GET /api/admin/api-v2/approvals",
  "GET /api/admin/api-v2/approvals/history",
  "POST /api/admin/api-v2/approvals/:id",
  "GET /api/admin/api-v2/config",
  "PUT /api/admin/api-v2/config",
  "GET /api/admin/api-v2/grants",
  "DELETE /api/admin/api-v2/grants/:userId",
  "GET /api/admin/api-v2/keys",
  "PATCH /api/admin/api-v2/keys/:id",
  "GET /api/admin/api-v2/keys/:id/activity",
  "GET /api/admin/api-v2/logs",
  "GET /api/admin/api-v2/stats",
  "GET /api/admin/api-v2/stuck",
  "GET /api/admin/api-v2/announcements",
  "POST /api/admin/api-v2/announcements",
  "PUT /api/admin/api-v2/announcements/:id",
  "DELETE /api/admin/api-v2/announcements/:id",
  "GET /api/admin/api-v2/developers",
  "GET /api/admin/api-v2/developers/:userId",
  "POST /api/admin/api-v2/developers/:userId/pause",
  "GET /api/admin/api-v2/report",
  "GET /api/admin/api-v2/services",
  "PUT /api/admin/api-v2/services/:service",
  "GET /api/admin/api-v2/trend",
  "GET /api/admin/api-v2/money-settings",
  "GET /api/admin/phone-login",
  "GET /api/admin/api-v2/webhook-settings",
  "GET /api/admin/api-v2/developers/:userId/spend-cap",
  "GET /api/admin/api-v1/retirement",
  "PUT /api/admin/api-v1/retirement",
  "GET /api/admin/api-keys",
  "PATCH /api/admin/api-keys",
  "DELETE /api/admin/api-keys",
  "POST /api/admin/api-keys/global-kill",
  "GET /api/admin/api-logs",
  "GET /api/admin/leaderboard",
  "GET /api/admin/leaderboard/exclusions",
  "POST /api/admin/leaderboard/exclusions",
  "DELETE /api/admin/leaderboard/exclusions",
  "POST /api/admin/leaderboard/presets",
  "DELETE /api/admin/leaderboard/presets/:id",
  "POST /api/admin/leaderboard/prizes",
  "POST /api/admin/leaderboard/prizes/:id/cancel",
  "POST /api/admin/leaderboard/period",
  "POST /api/admin/leaderboard/config",
  "POST /api/admin/leaderboard/close",
  "POST /api/admin/leaderboard/deliver",
  "POST /api/admin/leaderboard/deliver/mark",
  "GET /api/admin/scheduled-tasks",
  "POST /api/admin/scheduled-tasks",
  "GET /api/admin/scheduled-tasks/:id",
  "PATCH /api/admin/scheduled-tasks/:id",
  "DELETE /api/admin/scheduled-tasks/:id",
  "GET /api/admin/security-alerts",
  "POST /api/admin/security-alerts",
  "GET /api/admin/ai-conversations",
  "GET /api/admin/ai-conversations/:id",
  "POST /api/admin/ai-conversations/:id/review",
  "GET /api/admin/dashboard-stats",
  "GET /api/admin/dashboard-analytics",
]

const EXCLUDED_HERE = ["POST /api/admin/api-v1/retirement/notify"]

describe("platform catalog coverage", () => {
  it("catalogues exactly the listed routes, registered in CATALOG, none pending or excluded", () => {
    expect(PLATFORM_ENTRIES.map((e) => key(e.method, e.path)).sort()).toEqual([...CATALOGUED].sort())
    expect(CATALOGUED.length).toBe(60)
    // Phone login: the AI may read the status, never switch the code check off (security control).
    expect(EXCLUDED.find((x) => key(x.method, x.path) === "POST /api/admin/phone-login")?.reason).toMatch(/security control/)
    expect(CATALOGUED).not.toContain("POST /api/admin/phone-login")
    // Release 5: the AI may read money protection, never change it (fraud controls).
    for (const k of ["PUT /api/admin/api-v2/money-settings", "PUT /api/admin/api-v2/developers/:userId/spend-cap"]) {
      const row = EXCLUDED.find((x) => key(x.method, x.path) === k)
      expect(row?.reason, k).toMatch(/fraud control/)
    }
    for (const k of CATALOGUED) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).toContain(k)
      expect(EXCLUDED.some((x) => key(x.method, x.path) === k), k).toBe(false)
    }
  })

  it("excluded rows are justified and out of PENDING and CATALOG", () => {
    expect(EXCLUDED_HERE.length).toBe(1)
    for (const k of EXCLUDED_HERE) {
      expect(PENDING, k).not.toContain(k)
      expect(CATALOG.map((e) => key(e.method, e.path)), k).not.toContain(k)
      const row = EXCLUDED.find((x) => key(x.method, x.path) === k)
      expect(row?.reason.length ?? 0, k).toBeGreaterThan(20)
    }
  })

  it("PENDING is empty and its budget is zero: every admin route is catalogued or excluded", () => {
    expect(PENDING).toEqual([])
    expect(PENDING_BUDGET).toBe(0)
  })

  it("ids are unique and area is platform", () => {
    const ids = PLATFORM_ENTRIES.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of PLATFORM_ENTRIES) expect(e.area).toBe("platform")
  })
})

describe("platform catalog rules", () => {
  it("pages are exact ADMIN_PAGES paths with matching titles", () => {
    const paths = new Set(ADMIN_PAGES.map((p) => p.path))
    for (const e of PLATFORM_ENTRIES) {
      expect(paths.has(e.page), e.id).toBe(true)
      expect(e.pageTitle, e.id).toBe(pageTitleFor(e.page))
    }
  })

  it("every schema is strict and rejects an unknown key", () => {
    for (const e of PLATFORM_ENTRIES) {
      for (const schema of [e.query, e.body].filter(Boolean)) {
        const r = schema!.safeParse({ __unknown_key__: 1 })
        expect(r.success, e.id).toBe(false)
        if (!r.success) expect(r.error.issues.some((i) => i.code === "unrecognized_keys"), e.id).toBe(true)
      }
    }
  })

  it("lookups have resultKeep, writes are changes, changes have a card, every GET is a lookup", () => {
    for (const e of PLATFORM_ENTRIES) {
      if (e.kind === "lookup") {
        expect(e.method, e.id).toBe("GET")
        expect(e.resultKeep?.length, e.id).toBeGreaterThan(0)
      }
      if (e.method !== "GET") expect(e.kind, e.id).toBe("change")
      else expect(e.kind, e.id).toBe("lookup")
      if (e.kind === "change") expect(typeof e.card, e.id).toBe("function")
    }
  })

  it("lookups never keep key material, secrets, tokens, hashes, raw payloads or IP addresses", () => {
    const banned = new Set([
      "key", "key_hash", "key_prefix", "prefix", "api_key", "raw_key", "secret", "token", "password", "hash", "ip", "ip_address",
      "request_payload", "response_payload", "payload", "detail", "last_result_raw", "signed_url",
    ])
    for (const e of PLATFORM_ENTRIES) {
      for (const p of e.resultKeep ?? []) {
        const last = p.split(".").pop()!.replace(/\[\]$/, "")
        expect(banned.has(last), `${e.id}: ${p}`).toBe(false)
        expect(p, e.id).not.toMatch(/password|secret|token|key_hash|key_prefix|payload/i)
      }
    }
  })

  it("API key listings select identity, owner, status and dates only", () => {
    for (const k of ["GET /api/admin/api-keys", "GET /api/admin/api-v2/keys"]) {
      const keep = byKey(k).resultKeep!
      expect(keep.some((p) => /\.id$|^keys\[\]\.id$/.test(p)), k).toBe(true)
      expect(keep.some((p) => /name/.test(p)), k).toBe(true)
      expect(keep.some((p) => /created_at/.test(p)), k).toBe(true)
      expect(keep.join("|"), k).not.toMatch(/prefix|hash|secret/)
    }
    expect(byKey("GET /api/admin/api-logs").resultKeep!.join("|")).not.toMatch(/payload|prefix|ip/)
    expect(byKey("GET /api/admin/api-v2/logs").resultKeep!.join("|")).not.toMatch(/prefix|ip_address/)
  })

  it("risk tiers: key approve/revoke/rotate/delete, kill switch, config, retirement, scheduled tasks, closing a period and pausing are danger; prizes and deliveries are money", () => {
    const rank: Record<Risk, number> = { normal: 0, money: 1, danger: 2 }
    const danger = [
      "POST /api/admin/api-v2/approvals/:id", "PUT /api/admin/api-v2/config", "DELETE /api/admin/api-v2/grants/:userId", "PATCH /api/admin/api-v2/keys/:id",
      "POST /api/admin/api-v2/developers/:userId/pause", "PUT /api/admin/api-v2/services/:service", "DELETE /api/admin/api-v2/announcements/:id",
      "PUT /api/admin/api-v1/retirement", "PATCH /api/admin/api-keys", "DELETE /api/admin/api-keys", "POST /api/admin/api-keys/global-kill",
      "POST /api/admin/leaderboard/config", "POST /api/admin/leaderboard/close", "POST /api/admin/leaderboard/prizes/:id/cancel",
      "POST /api/admin/scheduled-tasks", "PATCH /api/admin/scheduled-tasks/:id", "DELETE /api/admin/scheduled-tasks/:id",
    ]
    const money = ["POST /api/admin/leaderboard/deliver", "POST /api/admin/leaderboard/prizes"]
    for (const k of danger) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.danger)
    for (const k of money) expect(rank[byKey(k).risk], k).toBeGreaterThanOrEqual(rank.money)
  })

  it("auth: scheduled tasks use their own bearer check (other); everything else verifyAdminAccess (admin)", () => {
    for (const e of PLATFORM_ENTRIES) expect(e.auth, e.id).toBe(e.path.startsWith("/api/admin/scheduled-tasks") ? "other" : "admin")
  })

  it("timeouts stay within 60 s; closing a period and delivering a prize are given the full minute", () => {
    for (const e of PLATFORM_ENTRIES) if (e.timeoutMs !== undefined) expect(e.timeoutMs, e.id).toBeLessThanOrEqual(60000)
    for (const k of ["POST /api/admin/leaderboard/close", "POST /api/admin/leaderboard/deliver", "POST /api/admin/api-keys/global-kill"]) {
      expect(byKey(k).timeoutMs, k).toBeGreaterThanOrEqual(30000)
    }
  })

  it("declares a param for every :name segment", () => {
    for (const e of PLATFORM_ENTRIES) {
      const inPath = e.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1)).sort()
      expect(Object.keys(e.params ?? {}).sort(), e.id).toEqual(inPath)
    }
  })

  it("no secret input fields exist here and none appears in a schema", () => {
    for (const e of PLATFORM_ENTRIES) {
      expect(e.secretFields, e.id).toBeUndefined()
      for (const schema of [e.query, e.body].filter(Boolean)) {
        // apiKeyId is a filter that names a key by its id; it carries no key material
        for (const k of Object.keys(schema!.shape).filter((x) => x !== "apiKeyId")) expect(k, e.id).not.toMatch(/secret|api_?key|token|password/i)
      }
    }
  })

  it("schemas mirror the handlers", () => {
    const decide = byKey("POST /api/admin/api-v2/approvals/:id").body!
    expect(decide.safeParse({ kind: "key", action: "approve" }).success).toBe(true)
    expect(decide.safeParse({ kind: "swap", action: "reject", reason: "Not enough history" }).success).toBe(true)
    expect(decide.safeParse({ kind: "access", action: "approve" }).success).toBe(true)
    expect(decide.safeParse({ kind: "other", action: "approve" }).success).toBe(false)
    expect(decide.safeParse({ kind: "key", action: "revoke" }).success).toBe(false)
    expect(decide.safeParse({ kind: "key", action: "reject", reason: "x".repeat(201) }).success).toBe(false)
    const cfg = byKey("PUT /api/admin/api-v2/config").body!
    expect(cfg.safeParse({ enabled: false }).success).toBe(true)
    expect(cfg.safeParse({ enabled: "no" }).success).toBe(false)
    expect(cfg.safeParse({ allowed_roles: ["dealer"] }).success).toBe(true)
    expect(cfg.safeParse({ allowed_roles: [1] }).success).toBe(false)
    expect(cfg.safeParse({ approval_whatsapp: null }).success).toBe(true)
    expect(cfg.safeParse({ approval_whatsapp: "0559919037" }).success).toBe(true)
    const keys = byKey("PATCH /api/admin/api-v2/keys/:id").body!
    for (const a of ["approve", "reject", "revoke", "set_limits", "reset_limits"]) expect(keys.safeParse({ action: a }).success, a).toBe(true)
    expect(keys.safeParse({ action: "rotate" }).success).toBe(false)
    expect(keys.safeParse({ action: "set_limits", limits: { purchase: 20, bulk: 5 } }).success).toBe(true)
    expect(keys.safeParse({ action: "set_limits", limits: { purchase: 0 } }).success).toBe(false)
    expect(keys.safeParse({ action: "set_limits", limits: { purchase: 10001 } }).success).toBe(false)
    expect(keys.safeParse({ action: "set_limits", limits: { turbo: 5 } }).success).toBe(false)
    expect(byKey("GET /api/admin/api-v2/keys").query!.safeParse({ status: "pending", type: "sms" }).success).toBe(true)
    expect(byKey("GET /api/admin/api-v2/keys").query!.safeParse({ status: "deleted" }).success).toBe(false)
    expect(byKey("GET /api/admin/api-v2/logs").query!.safeParse({ statusClass: "server_error", limit: 200, offset: 100000 }).success).toBe(true)
    expect(byKey("GET /api/admin/api-v2/logs").query!.safeParse({ limit: 201 }).success).toBe(false)
    expect(byKey("GET /api/admin/api-v2/logs").query!.safeParse({ keyId: "nope" }).success).toBe(false)
    expect(byKey("DELETE /api/admin/api-v2/grants/:userId").body!.safeParse({ reason: "no" }).success).toBe(false)
    expect(byKey("DELETE /api/admin/api-v2/grants/:userId").body!.safeParse({ reason: "No longer needed" }).success).toBe(true)
    const ret = byKey("PUT /api/admin/api-v1/retirement").body!
    const base = { sunset_at: "2026-11-30T00:00:00.000Z", exempt_user_ids: [U1], expected_updated_at: "2026-11-20T10:00:00.000Z" }
    expect(ret.safeParse(base).success).toBe(true)
    expect(ret.safeParse({ ...base, sunset_at: null }).success).toBe(true)
    expect(ret.safeParse({ ...base, sunset_at: "soon" }).success).toBe(false)
    expect(ret.safeParse({ ...base, exempt_user_ids: Array.from({ length: 51 }, () => U1) }).success).toBe(false)
    expect(ret.safeParse({ ...base, exempt_user_ids: ["x"] }).success).toBe(false)
    const { expected_updated_at: _e, ...noExpected } = base
    expect(ret.safeParse(noExpected).success).toBe(false)
    expect(byKey("PATCH /api/admin/api-keys").query!.safeParse({ id: K1 }).success).toBe(true)
    expect(byKey("PATCH /api/admin/api-keys").query!.safeParse({}).success).toBe(false)
    expect(byKey("PATCH /api/admin/api-keys").body!.safeParse({ is_active: false, rate_limit_per_min: 60 }).success).toBe(true)
    expect(byKey("PATCH /api/admin/api-keys").body!.safeParse({ rate_limit_per_min: 0 }).success).toBe(false)
    expect(byKey("PATCH /api/admin/api-keys").body!.safeParse({ rate_limit_per_min: 10001 }).success).toBe(false)
    expect(byKey("DELETE /api/admin/api-keys").query!.safeParse({ id: K1 }).success).toBe(true)
    expect(byKey("POST /api/admin/api-keys/global-kill").body).toBeUndefined()
    // the free-text search is dropped into a filter string by the handler: only plain characters may pass
    const logs = byKey("GET /api/admin/api-logs").query!
    expect(logs.safeParse({ search: "purchase" }).success).toBe(true)
    expect(logs.safeParse({ search: "x,user_id.eq.1" }).success).toBe(false)
    expect(logs.safeParse({ search: "a)b" }).success).toBe(false)
    expect(logs.safeParse({ statusFilter: "success", limit: 100, offset: 0 }).success).toBe(true)
    const kind = byKey("POST /api/admin/leaderboard/close").body!
    expect(kind.safeParse({ kind: "monthly", anchor: "2026-10-01", with_rewards: true }).success).toBe(true)
    expect(kind.safeParse({ kind: "yearly", anchor: "2025-01-01", with_rewards: true }).success).toBe(false)
    expect(kind.safeParse({ kind: "monthly", with_rewards: "yes" }).success).toBe(false)
    expect(kind.safeParse({ kind: "monthly" }).success).toBe(false)
    expect(byKey("POST /api/admin/leaderboard/config").body!.safeParse({ paused: true }).success).toBe(true)
    expect(byKey("POST /api/admin/leaderboard/config").body!.safeParse({ paused: "true" }).success).toBe(false)
    expect(byKey("POST /api/admin/leaderboard/period").body!.safeParse({ kind: "weekly", rewards_enabled: false }).success).toBe(true)
    expect(byKey("POST /api/admin/leaderboard/deliver").body!.safeParse({ result_id: R1, phone: "0241234567" }).success).toBe(true)
    expect(byKey("POST /api/admin/leaderboard/deliver").body!.safeParse({ result_id: "x" }).success).toBe(false)
    expect(byKey("POST /api/admin/leaderboard/deliver").body!.safeParse({ result_id: R1, phone: "1".repeat(21) }).success).toBe(false)
    expect(byKey("POST /api/admin/leaderboard/deliver/mark").body!.safeParse({ result_id: R1, note: "Gave a phone" }).success).toBe(true)
    const prize = byKey("POST /api/admin/leaderboard/prizes").body!
    expect(prize.safeParse({ kind: "monthly", board: "shop", rank: 1, prize: { prize_type: "wallet_topup", amount: 50 } }).success).toBe(true)
    expect(prize.safeParse({ kind: "monthly", board: "shop", rank: 4, prize: { prize_type: "manual", label: "Phone" } }).success).toBe(false)
    expect(prize.safeParse({ kind: "monthly", board: "arena", rank: 1, prize: { prize_type: "manual", label: "Phone" } }).success).toBe(false)
    expect(prize.safeParse({ kind: "monthly", board: "shop", rank: 1, prize: { prize_type: "cheque" } }).success).toBe(false)
    expect(byKey("POST /api/admin/leaderboard/presets").body!.safeParse({ name: "GHS 20 airtime", prize: { prize_type: "airtime", amount: 20, network: "MTN" } }).success).toBe(true)
    expect(byKey("POST /api/admin/leaderboard/exclusions").body!.safeParse({ email: "a@b.co", reason: "staff" }).success).toBe(true)
    expect(byKey("POST /api/admin/leaderboard/exclusions").body!.safeParse({ email: "nope" }).success).toBe(false)
    expect(byKey("DELETE /api/admin/leaderboard/exclusions").query!.safeParse({ userId: U1 }).success).toBe(true)
    const sch = byKey("POST /api/admin/scheduled-tasks").body!
    expect(sch.safeParse({ name: "Daily report", prompt: "Summarise yesterday", schedule_type: "daily", run_at_time: "09:00" }).success).toBe(true)
    expect(sch.safeParse({ name: "Weekly", prompt: "Do it", schedule_type: "weekly", run_at_time: "09:00", run_on_days: [1, 3] }).success).toBe(true)
    expect(sch.safeParse({ name: "Once", prompt: "Do it", schedule_type: "once", run_at_timestamp: "2026-12-01T09:00:00.000Z" }).success).toBe(true)
    expect(sch.safeParse({ name: "Hourly", prompt: "Do it", schedule_type: "hourly" }).success).toBe(true)
    expect(sch.safeParse({ name: "Bad", prompt: "Do it", schedule_type: "monthly" }).success).toBe(false)
    expect(sch.safeParse({ name: "Bad", prompt: "Do it", schedule_type: "daily", run_at_time: "25:00" }).success).toBe(false)
    expect(sch.safeParse({ name: "Bad", prompt: "Do it", schedule_type: "weekly", run_at_time: "09:00", run_on_days: [7] }).success).toBe(false)
    expect(sch.safeParse({ name: "Bad", prompt: "Do it", schedule_type: "hourly", notify_channels: ["fax"] }).success).toBe(false)
    expect(sch.safeParse({ name: "Bad", prompt: "", schedule_type: "hourly" }).success).toBe(false)
    expect(byKey("PATCH /api/admin/scheduled-tasks/:id").body!.safeParse({ is_active: false }).success).toBe(true)
    expect(byKey("PATCH /api/admin/scheduled-tasks/:id").body!.safeParse({ schedule_type: "daily" }).success).toBe(false)
    expect(byKey("GET /api/admin/scheduled-tasks").query!.safeParse({ scope: "own" }).success).toBe(true)
    expect(byKey("GET /api/admin/scheduled-tasks").query!.safeParse({ scope: "all" }).success).toBe(false)
    const sa = byKey("POST /api/admin/security-alerts").body!
    expect(sa.safeParse({ action: "acknowledge", id: U1 }).success).toBe(true)
    expect(sa.safeParse({ action: "acknowledge_all" }).success).toBe(true)
    expect(sa.safeParse({ action: "unblock_ip", id: U1 }).success).toBe(false)
    expect(byKey("GET /api/admin/security-alerts").query!.safeParse({ severity: "critical", unacked: "1", limit: 300 }).success).toBe(true)
    expect(byKey("GET /api/admin/security-alerts").query!.safeParse({ limit: 301 }).success).toBe(false)
    expect(byKey("GET /api/admin/ai-conversations").query!.safeParse({ context: "home", flagged: true, reviewed: false, from: "2026-11-01", page: 2 }).success).toBe(true)
    expect(byKey("GET /api/admin/ai-conversations").query!.safeParse({ context: "admin" }).success).toBe(false)
    expect(byKey("GET /api/admin/dashboard-stats").query!.safeParse({ range: "30d" }).success).toBe(true)
    expect(byKey("GET /api/admin/dashboard-stats").query!.safeParse({ range: "1y" }).success).toBe(false)
    expect(byKey("GET /api/admin/leaderboard").query!.safeParse({ kind: "yearly", anchor: "2026-01-01" }).success).toBe(true)
    expect(byKey("GET /api/admin/leaderboard").query!.safeParse({ kind: "hourly" }).success).toBe(false)
  })

  it("summaries name side effects of the GETs that leave none and the notice-style changes", () => {
    expect(byKey("POST /api/admin/api-keys/global-kill").summary.toLowerCase()).toMatch(/every|all/)
    expect(byKey("POST /api/admin/leaderboard/deliver").summary.toLowerCase()).toMatch(/prize/)
  })
})

// ---- card tests with a tiny fake db ------------------------------------------------------------------------------

type Row = Record<string, unknown>

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  const make = (rows: Row[]) => {
    const filters: Array<(r: Row) => boolean> = []
    const b: any = {
      select() { return b },
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
      neq(c: string, v: unknown) { filters.push((r) => r[c] !== v); return b },
      is(c: string, v: unknown) { filters.push((r) => (r[c] ?? null) === v); return b },
      not(c: string, _op: string, v: unknown) { filters.push((r) => (r[c] ?? null) !== v); return b },
      in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return b },
      ilike(c: string, v: string) { const want = v.replace(/\\(.)/g, "$1").toLowerCase(); filters.push((r) => String(r[c] ?? "").toLowerCase() === want); return b },
      gte() { return b },
      order() { return b },
      limit() { return b },
      range() { return b },
      maybeSingle() { const d = rows.filter((r) => filters.every((f) => f(r))); return Promise.resolve({ data: d[0] ?? null, error: null }) },
      single() { return b.maybeSingle() },
      then(res: any, rej: any) {
        const d = rows.filter((r) => filters.every((f) => f(r)))
        return Promise.resolve({ data: d, count: d.length, error: null }).then(res, rej)
      },
    }
    return b
  }
  return { from(table: string) { return make(tables[table] ?? []) } } as unknown as SupabaseClient
}

const brokenDb = { from() { throw new Error("db down") }, rpc() { throw new Error("db down") } } as unknown as SupabaseClient

const SECRET_HASH = "HASHVALUE-should-never-show"
const SECRET_PREFIX = "dg_live_PREFIX1234"

const tables: Record<string, Row[]> = {
  users: [
    { id: U1, email: "ama@example.com", phone_number: "0241112222", first_name: "Ama", last_name: "Mensah", role: "dealer", is_suspended: false },
    { id: U2, email: "kofi@example.com", phone_number: "0243334444", first_name: "Kofi", last_name: "Boateng", role: "dealer", is_suspended: true },
    { id: U3, email: "esi@example.com", phone_number: null, first_name: "Esi", last_name: "Owusu", role: "admin", is_suspended: false },
  ],
  api_v2_keys: [
    { id: K1, user_id: U1, key_type: "standard", environment: "live", status: "pending", name: "Shop integration", request_code: "REQ-1234", key_prefix: SECRET_PREFIX, key_hash: SECRET_HASH },
    { id: K2, user_id: U1, key_type: "sms", environment: "live", status: "active", name: "SMS key", request_code: "REQ-5555", key_prefix: SECRET_PREFIX, key_hash: SECRET_HASH },
    { id: "k3", user_id: U2, key_type: "standard", environment: "test", status: "active", name: "t", request_code: "REQ-9", key_prefix: SECRET_PREFIX, key_hash: SECRET_HASH },
  ],
  api_v2_access_requests: [{ id: R1, user_id: U2, request_code: "ACC-777", status: "pending" }],
  api_v2_config: [
    { id: true, enabled: true, allowed_roles: ["dealer", "sub_agent"], v1_sunset_at: "2026-11-30T00:00:00.000Z", v1_exempt_user_ids: [U2], updated_at: "2026-11-20T10:00:00.000Z" },
  ],
  user_api_keys: [
    { id: K1, user_id: U1, name: "Old v1 key", is_active: true, rate_limit_per_min: 60, key_hash: SECRET_HASH, key_prefix: SECRET_PREFIX },
    { id: K2, user_id: U2, name: "Second v1", is_active: true, rate_limit_per_min: 30, key_hash: SECRET_HASH, key_prefix: SECRET_PREFIX },
    { id: "k9", user_id: U2, name: "Dead", is_active: false, rate_limit_per_min: 30, key_hash: SECRET_HASH, key_prefix: SECRET_PREFIX },
  ],
  leaderboard_periods: [{ id: P1, kind: "monthly", starts_on: "2026-10-01", ends_on: "2026-10-31", rewards_enabled: true, status: "open" }],
  leaderboard_prizes: [
    { id: "p1", period_id: P1, board: "shop", rank: 1, prize_type: "wallet_topup", label: "GH₵50 Cash", amount: 50, status: "active" },
    { id: "p2", period_id: P1, board: "shop", rank: 1, prize_type: "airtime", label: "CANCELLED-LABEL", amount: 5, status: "cancelled" },
    { id: T1, period_id: P1, board: "dashboard", rank: 2, prize_type: "data_bundle", label: "MTN 10GB", amount: null, status: "active" },
  ],
  leaderboard_prize_presets: [{ id: P1, name: "Cash 20", prize_type: "wallet_topup", label: "GH₵20 Cash", amount: 20 }],
  leaderboard_exclusions: [{ user_id: U2, reason: "staff" }],
  leaderboard_results: [
    { id: R1, user_id: U1, board: "shop", rank: 1, display_name: "Am*", prize: { id: "p1", label: "GH₵50 Cash", prize_type: "wallet_topup", amount: 50, network: null, duration_days: null, status: "active" } },
    { id: K2, user_id: U1, board: "dashboard", rank: 2, display_name: "Am*", prize: { id: T1, label: "MTN 10GB", prize_type: "data_bundle", amount: null, network: "MTN", duration_days: null, status: "active" } },
    { id: K1, user_id: U1, board: "dashboard", rank: 3, display_name: "Am*", prize: null },
  ],
  leaderboard_deliveries: [{ result_id: K1, status: "delivered" }],
  packages: [{ id: P1, network: "MTN", size: "10" }],
  ai_scheduled_tasks: [
    { id: T1, name: "Morning float check", prompt: "Check the float balance and tell me if it is under GHS 500", context: "admin", user_id: U3, schedule_type: "daily", run_at_time: "09:00", run_on_days: null, run_at_timestamp: null, notify_channels: ["push", "sms"], is_active: true, standing_order: null },
    { id: R1, name: "Standing airtime", prompt: "Buy airtime", context: "admin", user_id: U3, schedule_type: "weekly", run_at_time: "08:00", run_on_days: [1], run_at_timestamp: null, notify_channels: ["push"], is_active: false, standing_order: { kind: "airtime" } },
  ],
  security_alerts: [
    { id: U1, severity: "critical", category: "balance", title: "Large manual credit", acknowledged_at: null, created_at: "2026-11-23T10:00:00Z", actor: "esi@example.com", ip: "203.0.113.9" },
    { id: U2, severity: "high", category: "login", title: "Many failed logins", acknowledged_at: null, created_at: "2026-11-23T11:00:00Z", actor: null, ip: null },
    { id: U3, severity: "info", category: "signup", title: "New admin", acknowledged_at: "2026-11-22T00:00:00Z", created_at: "2026-11-22T00:00:00Z", actor: null, ip: null },
    { id: "a4", severity: "critical", category: "money", title: "Odd withdrawal", acknowledged_at: null, created_at: "2026-11-23T12:00:00Z", actor: null, ip: null },
  ],
  ai_conversations: [{ id: U1, context: "storefront", user_id: null, shop_id: U2, flagged: true, flag_reasons: ["handoff"], reviewed_at: null, message_count: 6 }],
}
const db = fakeDb(tables)
const ctx = { db, adminId: U3 }
const text = (c: { summary: string; lines: { label: string; value: string }[] }) => [c.summary, ...c.lines.map((l) => `${l.label}: ${l.value}`)].join("\n")

async function card(k: string, input: Parameters<NonNullable<CatalogEntry["card"]>>[0], useCtx = ctx) {
  const e = byKey(k)
  const c = await e.card!(input, useCtx)
  expect(c.summary.length, k).toBeGreaterThan(0)
  expect(c.lines.length, k).toBeGreaterThanOrEqual(1)
  return text(c)
}

describe("platform cards", () => {
  it("every change card still answers when the database is down", async () => {
    const inputs: Record<string, any> = {
      "POST /api/admin/api-v2/approvals/:id": { params: { id: K1 }, body: { kind: "key", action: "approve" } },
      "PATCH /api/admin/api-v2/keys/:id": { params: { id: K1 }, body: { action: "revoke" } },
      "PUT /api/admin/api-v2/config": { body: { enabled: false } },
      "DELETE /api/admin/api-v2/grants/:userId": { params: { userId: U1 }, body: { reason: "No longer needed" } },
      "PUT /api/admin/api-v1/retirement": { body: { sunset_at: null, exempt_user_ids: [], expected_updated_at: "2026-11-20T10:00:00.000Z" } },
      "PATCH /api/admin/api-keys": { query: { id: K1 }, body: { is_active: false } },
      "DELETE /api/admin/api-keys": { query: { id: K1 } },
      "POST /api/admin/leaderboard/exclusions": { body: { email: "ama@example.com" } },
      "DELETE /api/admin/leaderboard/exclusions": { query: { userId: U1 } },
      "POST /api/admin/leaderboard/prizes": { body: { kind: "monthly", anchor: "2026-10-01", board: "shop", rank: 1, prize: { prize_type: "wallet_topup", amount: 50 } } },
      "POST /api/admin/leaderboard/period": { body: { kind: "monthly", anchor: "2026-10-01", rewards_enabled: false } },
      "POST /api/admin/leaderboard/close": { body: { kind: "monthly", anchor: "2026-10-01", with_rewards: true } },
      "POST /api/admin/leaderboard/deliver": { body: { result_id: R1 } },
      "POST /api/admin/leaderboard/deliver/mark": { body: { result_id: R1 } },
      "POST /api/admin/leaderboard/config": { body: { paused: true } },
      "POST /api/admin/leaderboard/presets": { body: { name: "X", prize: { prize_type: "manual", label: "Phone" } } },
      "POST /api/admin/scheduled-tasks": { body: { name: "Daily", prompt: "Do it", schedule_type: "daily", run_at_time: "09:00" } },
      "POST /api/admin/security-alerts": { body: { action: "acknowledge_all" } },
    }
    for (const e of PLATFORM_ENTRIES.filter((x) => x.kind === "change")) {
      const input = inputs[key(e.method, e.path)] ?? { params: Object.fromEntries(Object.keys(e.params ?? {}).map((p) => [p, U1])), body: {}, query: {} }
      const c = await e.card!(input, { db: brokenDb, adminId: U3 })
      expect(c.lines.length, e.id).toBeGreaterThanOrEqual(1)
    }
  })

  it("approving a live key names the developer, the key and every effect, and never shows key material", async () => {
    const t = await card("POST /api/admin/api-v2/approvals/:id", { params: { id: K1 }, body: { kind: "key", action: "approve" } })
    expect(t).toContain("Ama Mensah")
    expect(t).toContain("REQ-1234")
    expect(t).toContain("Shop integration")
    expect(t).toMatch(/active/i)
    expect(t).toMatch(/told|notified/i)
    expect(t).not.toContain(SECRET_HASH)
    expect(t).not.toContain(SECRET_PREFIX)
  })

  it("rejecting shows the full reason the developer is sent, and a suspended owner is flagged on an approval", async () => {
    const t = await card("POST /api/admin/api-v2/approvals/:id", { params: { id: R1 }, body: { kind: "access", action: "reject", reason: "Account is under review" } })
    expect(t).toContain("Account is under review")
    expect(t).toContain("Kofi Boateng")
    expect(t).toMatch(/ACC-777/)
    const a = await card("POST /api/admin/api-v2/approvals/:id", { params: { id: R1 }, body: { kind: "access", action: "approve" } })
    expect(a).toMatch(/suspended/i)
    const noReason = await card("POST /api/admin/api-v2/approvals/:id", { params: { id: K1 }, body: { kind: "key", action: "reject" } })
    expect(noReason).toMatch(/reason/i)
    expect(noReason).toMatch(/refused|needs/i)
  })

  it("key patch: revoke says immediate and permanent; limits show the full new values; reset says defaults; reject needs a reason", async () => {
    const rev = await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K2 }, body: { action: "revoke" } })
    expect(rev).toContain("SMS key")
    expect(rev).toContain("Ama Mensah")
    expect(rev).toMatch(/immediately/i)
    expect(rev).toMatch(/cannot be (undone|reactivated|re-activated)/i)
    const lim = await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K2 }, body: { action: "set_limits", limits: { purchase: 20, bulk: 5 } } })
    expect(lim).toMatch(/purchase[^\n]*20/)
    expect(lim).toMatch(/bulk[^\n]*5/)
    const missing = await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K2 }, body: { action: "set_limits" } })
    expect(missing).toMatch(/limits/i)
    expect(missing).toMatch(/refused|needs/i)
    const reset = await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K2 }, body: { action: "reset_limits" } })
    expect(reset).toMatch(/default/i)
    const rej = await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K1 }, body: { action: "reject", reason: "Duplicate request" } })
    expect(rej).toContain("Duplicate request")
  })

  it("api-v2 config shows the old and the FULL new values, the switch effect and the contact number in full", async () => {
    const off = await card("PUT /api/admin/api-v2/config", { body: { enabled: false } })
    expect(off).toMatch(/ON -> OFF/)
    expect(off).toMatch(/refused/i)
    const roles = await card("PUT /api/admin/api-v2/config", { body: { allowed_roles: ["dealer", "agent", "vip"] } })
    expect(roles).toContain("dealer, sub_agent")
    expect(roles).toContain("dealer, agent, vip")
    const wa = await card("PUT /api/admin/api-v2/config", { body: { approval_whatsapp: "0559919037" } })
    expect(wa).toContain("0559919037")
    const clear = await card("PUT /api/admin/api-v2/config", { body: { approval_whatsapp: null } })
    expect(clear).toMatch(/cleared|support number/i)
    const none = await card("PUT /api/admin/api-v2/config", { body: {} })
    expect(none).toMatch(/nothing to (update|change)|refused/i)
  })

  it("removing a grant shows the person, the reason, that keys are not revoked and that they are told", async () => {
    const t = await card("DELETE /api/admin/api-v2/grants/:userId", { params: { userId: U1 }, body: { reason: "Moved to the main API" } })
    expect(t).toContain("Ama Mensah")
    expect(t).toContain("Moved to the main API")
    expect(t).toMatch(/not revoked/i)
    expect(t).toMatch(/told|notified/i)
  })

  it("api-v1 retirement shows old and new dates in full, the exempt list by name, the replace-all effect and a stale form", async () => {
    const t = await card("PUT /api/admin/api-v1/retirement", { body: { sunset_at: "2026-12-15T00:00:00.000Z", exempt_user_ids: [U1], expected_updated_at: "2026-11-20T10:00:00.000Z" } })
    expect(t).toContain("2026-11-30T00:00:00.000Z")
    expect(t).toContain("2026-12-15T00:00:00.000Z")
    expect(t).toContain("Ama Mensah")
    expect(t).toMatch(/replace/i)
    expect(t).toMatch(/Kofi Boateng/)
    const stale = await card("PUT /api/admin/api-v1/retirement", { body: { sunset_at: "2026-12-15T00:00:00.000Z", exempt_user_ids: [], expected_updated_at: "2026-11-01T00:00:00.000Z" } })
    expect(stale).toMatch(/changed since|refused/i)
    const past = await card("PUT /api/admin/api-v1/retirement", { body: { sunset_at: "2020-01-01T00:00:00.000Z", exempt_user_ids: [], expected_updated_at: "2026-11-20T10:00:00.000Z" } })
    expect(past).toMatch(/already passed|immediately/i)
    const off = await card("PUT /api/admin/api-v1/retirement", { body: { sunset_at: null, exempt_user_ids: [], expected_updated_at: "2026-11-20T10:00:00.000Z" } })
    expect(off).toMatch(/no (retirement )?date|stays on|cleared/i)
  })

  it("v1 key patch and delete name the key and its owner, show new values and never reveal key material", async () => {
    const p = await card("PATCH /api/admin/api-keys", { query: { id: K1 }, body: { is_active: false, rate_limit_per_min: 120 } })
    expect(p).toContain("Old v1 key")
    expect(p).toContain("Ama Mensah")
    expect(p).toMatch(/active.*->.*disabled|disabled/i)
    expect(p).toContain("120")
    expect(p).not.toContain(SECRET_HASH)
    expect(p).not.toContain(SECRET_PREFIX)
    const d = await card("DELETE /api/admin/api-keys", { query: { id: K1 } })
    expect(d).toContain("Old v1 key")
    expect(d).toMatch(/permanent/i)
    expect(d).not.toContain(SECRET_HASH)
    expect(d).not.toContain(SECRET_PREFIX)
  })

  it("global kill counts what it will switch off, with the same filters as the handler", async () => {
    const t = await card("POST /api/admin/api-keys/global-kill", { body: undefined })
    expect(t).toMatch(/2[^\n]*(v1|old)[^\n]*key|(v1|old)[^\n]*2/i)
    expect(t).toMatch(/3[^\n]*(v2|new)|(v2|new)[^\n]*3/i)
    expect(t).toMatch(/v2 API[^\n]*(off|ON -> OFF)/i)
    expect(t).toMatch(/every|all/i)
    expect(t).toMatch(/audit|recorded|logged/i)
  })

  it("leaderboard: setting a prize shows the replaced active prize and the full new one; cancelled ones are not counted as current", async () => {
    const t = await card("POST /api/admin/leaderboard/prizes", { body: { kind: "monthly", anchor: "2026-10-15", board: "shop", rank: 1, prize: { prize_type: "wallet_topup", amount: 75 } } })
    expect(t).toContain("GH₵50 Cash")
    expect(t).toMatch(/GHS 75\.00/)
    expect(t).toMatch(/shop/i)
    expect(t).toMatch(/replace/i)
    expect(t).not.toContain("CANCELLED-LABEL")
    const bundle = await card("POST /api/admin/leaderboard/prizes", { body: { kind: "monthly", anchor: "2026-10-15", board: "dashboard", rank: 3, prize: { prize_type: "data_bundle", package_id: P1 } } })
    expect(bundle).toContain("MTN 10GB")
    const none = await card("POST /api/admin/leaderboard/prizes", { body: { kind: "monthly", anchor: "2026-10-15", board: "dashboard", rank: 1, prize: { prize_type: "manual", label: "A phone" } } })
    expect(none).toContain("A phone")
    expect(none).toMatch(/no (active )?prize/i)
  })

  it("leaderboard: closing a period states every side effect and cancelling a prize names it", async () => {
    const t = await card("POST /api/admin/leaderboard/close", { body: { kind: "monthly", anchor: "2026-10-15", with_rewards: true } })
    expect(t).toMatch(/October 2026|2026-10-01/)
    expect(t).toMatch(/refresh/i)
    expect(t).toMatch(/top 30/i)
    expect(t).toMatch(/notification/i)
    expect(t).toMatch(/cannot be (undone|reopened)|permanent|locked/i)
    expect(t).toMatch(/no money|not paid|deliver/i)
    const none = await card("POST /api/admin/leaderboard/close", { body: { kind: "monthly", anchor: "2026-10-15", with_rewards: false } })
    expect(none).toMatch(/no prizes|without/i)
    const c = await card("POST /api/admin/leaderboard/prizes/:id/cancel", { params: { id: T1 }, body: undefined })
    expect(c).toContain("MTN 10GB")
    expect(c).toMatch(/never|cannot be reassigned/i)
  })

  it("leaderboard: delivering a cash prize names the winner, the amount and the wallet credit; a data prize shows the full phone and the supplier send", async () => {
    const cash = await card("POST /api/admin/leaderboard/deliver", { body: { result_id: R1 } })
    expect(cash).toContain("Ama Mensah")
    expect(cash).toMatch(/GHS 50\.00/)
    expect(cash).toMatch(/wallet/i)
    expect(cash).toMatch(/told|notified|notification/i)
    const data = await card("POST /api/admin/leaderboard/deliver", { body: { result_id: K2, phone: "0241234567" } })
    expect(data).toContain("MTN 10GB")
    expect(data).toContain("0241234567")
    expect(data).toMatch(/supplier/i)
    expect(data).toMatch(/GHS 0/)
    const done = await card("POST /api/admin/leaderboard/deliver", { body: { result_id: K1 } })
    expect(done).toMatch(/no prize/i)
    const delivered = fakeDb({ ...tables, leaderboard_results: [{ ...tables.leaderboard_results[2], prize: { id: "p9", label: "Cash", prize_type: "wallet_topup", amount: 5, status: "active" } }] })
    const again = await card("POST /api/admin/leaderboard/deliver", { body: { result_id: K1 } }, { db: delivered, adminId: U3 })
    expect(again).toMatch(/already (been )?delivered/i)
  })

  it("leaderboard: marking delivered says nothing is sent; exclusions resolve the email to the account and show it in full", async () => {
    const m = await card("POST /api/admin/leaderboard/deliver/mark", { body: { result_id: R1, note: "Gave a phone in person" } })
    expect(m).toContain("Gave a phone in person")
    expect(m).toMatch(/nothing is sent|not sent|no prize is sent/i)
    const e = await card("POST /api/admin/leaderboard/exclusions", { body: { email: "AMA@example.com", reason: "staff account" } })
    expect(e).toContain("Ama Mensah")
    expect(e).toContain(U1)
    expect(e).toContain("ama@example.com")
    expect(e).toContain("staff account")
    expect(e).toMatch(/every leaderboard/i)
    const missing = await card("POST /api/admin/leaderboard/exclusions", { body: { email: "ghost@example.com" } })
    expect(missing).toMatch(/no user|refused/i)
    const back = await card("DELETE /api/admin/leaderboard/exclusions", { query: { userId: U2 } })
    expect(back).toContain("Kofi Boateng")
    expect(back).toContain("staff")
  })

  it("leaderboard: pausing, toggling prizes and presets are described in full", async () => {
    const p = await card("POST /api/admin/leaderboard/config", { body: { paused: true } })
    expect(p).toMatch(/every user|everyone/i)
    expect(p).toMatch(/maintenance/i)
    const r = await card("POST /api/admin/leaderboard/period", { body: { kind: "monthly", anchor: "2026-10-15", rewards_enabled: false } })
    expect(r).toMatch(/true|ON/)
    expect(r).toMatch(/false|OFF/)
    const pr = await card("POST /api/admin/leaderboard/presets", { body: { name: "Big cash", prize: { prize_type: "airtime", amount: 20, network: "MTN" } } })
    expect(pr).toContain("Big cash")
    expect(pr).toMatch(/GHS 20\.00/)
    expect(pr).toContain("MTN")
    const d = await card("DELETE /api/admin/leaderboard/presets/:id", { params: { id: P1 } })
    expect(d).toContain("Cash 20")
    expect(d).toMatch(/already set|unaffected|not affected/i)
  })

  it("scheduled task create shows the full prompt, when it runs, who it runs as and where it reports", async () => {
    const prompt = "Check the float balance and if it is under GHS 500 send the finance team an SMS"
    const t = await card("POST /api/admin/scheduled-tasks", { body: { name: "Float watch", prompt, schedule_type: "daily", run_at_time: "09:00", notify_channels: ["push", "sms"] } })
    expect(t).toContain("Float watch")
    expect(t).toContain(prompt)
    expect(t).toMatch(/every day at 09:00 UTC/i)
    expect(t).toMatch(/Esi Owusu/)
    expect(t).toMatch(/push, sms/)
    expect(t).toMatch(/without (anyone|you)|unattended|on its own/i)
    const weekly = await card("POST /api/admin/scheduled-tasks", { body: { name: "W", prompt: "x", schedule_type: "weekly", run_at_time: "08:30", run_on_days: [1, 5] } })
    expect(weekly).toMatch(/Monday/)
    expect(weekly).toMatch(/Friday/)
    expect(weekly).toMatch(/08:30 UTC/)
    const missing = await card("POST /api/admin/scheduled-tasks", { body: { name: "W", prompt: "x", schedule_type: "daily" } })
    expect(missing).toMatch(/run_at_time|time of day/i)
    expect(missing).toMatch(/refused/i)
  })

  it("scheduled task pause, edit and delete name the task and what it does; standing orders cannot be edited", async () => {
    const pause = await card("PATCH /api/admin/scheduled-tasks/:id", { params: { id: T1 }, body: { is_active: false } })
    expect(pause).toContain("Morning float check")
    expect(pause).toMatch(/stop|pause/i)
    expect(pause).toContain("Check the float balance")
    const edit = await card("PATCH /api/admin/scheduled-tasks/:id", { params: { id: T1 }, body: { prompt: "Send everyone a text" } })
    expect(edit).toContain("Send everyone a text")
    expect(edit).toContain("Check the float balance")
    const standing = await card("PATCH /api/admin/scheduled-tasks/:id", { params: { id: R1 }, body: { prompt: "Buy more" } })
    expect(standing).toMatch(/standing order/i)
    expect(standing).toMatch(/refused|cannot be edited|can't be edited/i)
    const resume = await card("PATCH /api/admin/scheduled-tasks/:id", { params: { id: R1 }, body: { is_active: true } })
    expect(resume).toMatch(/next/i)
    const del = await card("DELETE /api/admin/scheduled-tasks/:id", { params: { id: T1 } })
    expect(del).toContain("Morning float check")
    expect(del).toMatch(/every day at 09:00 UTC/i)
    expect(del).toMatch(/permanent|cannot be undone/i)
  })

  it("security alerts: acknowledging one names it; acknowledging all counts them by severity with the handler's filter", async () => {
    const one = await card("POST /api/admin/security-alerts", { body: { action: "acknowledge", id: U1 } })
    expect(one).toContain("Large manual credit")
    expect(one).toMatch(/critical/i)
    const all = await card("POST /api/admin/security-alerts", { body: { action: "acknowledge_all" } })
    expect(all).toMatch(/3/)
    expect(all).toMatch(/2 critical/i)
    expect(all).toMatch(/1 high/i)
    expect(all).toMatch(/hid|handled|no longer shown|marked/i)
    const noId = await card("POST /api/admin/security-alerts", { body: { action: "acknowledge" } })
    expect(noId).toMatch(/id/i)
    expect(noId).toMatch(/refused|needs/i)
  })

  it("ai conversation review names the conversation and says it is idempotent", async () => {
    const t = await card("POST /api/admin/ai-conversations/:id/review", { params: { id: U1 }, body: undefined })
    expect(t).toMatch(/Shop visitor/)
    expect(t).toMatch(/flagged/i)
    expect(t).toMatch(/handoff|Asked for a human/i)
    const done = fakeDb({ ai_conversations: [{ ...tables.ai_conversations[0], reviewed_at: "2026-11-22T00:00:00Z" }] })
    const again = await card("POST /api/admin/ai-conversations/:id/review", { params: { id: U1 }, body: undefined }, { db: done, adminId: U3 })
    expect(again).toMatch(/already reviewed/i)
  })

  it("no card ever carries a hash, prefix or secret value from the rows it reads", async () => {
    const all = [
      await card("PATCH /api/admin/api-v2/keys/:id", { params: { id: K1 }, body: { action: "revoke" } }),
      await card("PATCH /api/admin/api-keys", { query: { id: K2 }, body: { is_active: true } }),
      await card("DELETE /api/admin/api-keys", { query: { id: K2 } }),
      await card("POST /api/admin/api-keys/global-kill", { body: undefined }),
    ].join("\n")
    expect(all).not.toContain(SECRET_HASH)
    expect(all).not.toContain(SECRET_PREFIX)
  })
})

describe("api v2 admin console entries (merged from main)", () => {
  const ann = { title: "Planned maintenance", body: "We pause purchases at 02:00. See https://status.example/x", severity: "warning", startsAt: "2026-12-01T01:00:00.000Z", endsAt: "2026-12-01T03:00:00.000Z" }

  it("schemas mirror the handlers and reject unknown keys", () => {
    const create = byKey("POST /api/admin/api-v2/announcements").body!
    expect(create.safeParse(ann).success).toBe(true)
    expect(create.safeParse({ ...ann, severity: "urgent" }).success).toBe(false)
    expect(create.safeParse({ ...ann, title: "x".repeat(81) }).success).toBe(false)
    expect(create.safeParse({ ...ann, body: "x".repeat(1001) }).success).toBe(false)
    expect(create.safeParse({ ...ann, startsAt: "tomorrow" }).success).toBe(false)
    expect(byKey("POST /api/admin/api-v2/developers/:userId/pause").body!.safeParse({ paused: true, reason: "Abuse" }).success).toBe(true)
    expect(byKey("POST /api/admin/api-v2/developers/:userId/pause").body!.safeParse({ paused: "yes" }).success).toBe(false)
    expect(byKey("PUT /api/admin/api-v2/services/:service").body!.safeParse({ paused: true, message: null }).success).toBe(true)
    expect(byKey("GET /api/admin/api-v2/trend").query!.safeParse({ days: 90 }).success).toBe(true)
    expect(byKey("GET /api/admin/api-v2/trend").query!.safeParse({ days: 14 }).success).toBe(false)
    expect(byKey("GET /api/admin/api-v2/report").query!.safeParse({ format: "csv" }).success).toBe(false)
    expect(byKey("GET /api/admin/api-v2/report").query!.safeParse({ from: "2026-11-01", to: "2026-11-30", by: "month" }).success).toBe(true)
  })

  it("the report lookup keeps no cost or profit figures", () => {
    expect(byKey("GET /api/admin/api-v2/report").resultKeep!.join("|")).not.toMatch(/cost|profit/i)
    expect(byKey("GET /api/admin/api-v2/developers/:userId").resultKeep!.join("|")).not.toMatch(/prefix|phone/i)
  })

  it("an announcement card shows the FULL text, severity and dates, and refuses an end before the start", async () => {
    const t = await card("POST /api/admin/api-v2/announcements", { body: ann })
    expect(t).toContain(ann.body)
    expect(t).toContain("warning")
    expect(t).toContain(ann.endsAt)
    expect(t).toMatch(/audit trail/i)
    const bad = await card("POST /api/admin/api-v2/announcements", { body: { ...ann, endsAt: ann.startsAt } })
    expect(bad).toMatch(/Problem: The end is not after the start/)
  })

  it("pausing a developer names who, the reason and every effect; a missing reason is flagged", async () => {
    const t = await card("POST /api/admin/api-v2/developers/:userId/pause", { params: { userId: U1 }, body: { paused: true, reason: "Chargeback abuse" } })
    expect(t).toContain("Ama Mensah")
    expect(t).toContain("Chargeback abuse")
    expect(t).toMatch(/refused/i)
    expect(t).toMatch(/not sent a message/i)
    const none = await card("POST /api/admin/api-v2/developers/:userId/pause", { params: { userId: U1 }, body: { paused: true } })
    expect(none).toMatch(/reason of 3 to 200/)
  })

  it("pausing a service says it hits every developer and shows the message in full", async () => {
    const t = await card("PUT /api/admin/api-v2/services/:service", { params: { service: "data" }, body: { paused: true, message: "Back at 10:00" } })
    expect(t).toContain("Data and wallet")
    expect(t).toContain("Back at 10:00")
    expect(t).toMatch(/EVERY developer/)
    const unknown = await card("PUT /api/admin/api-v2/services/:service", { params: { service: "nope" }, body: { paused: true } })
    expect(unknown).toMatch(/No such API service/)
  })

  it("deleting an announcement shows the text being removed and says it cannot be restored", async () => {
    const d = fakeDb({ api_v2_announcements: [{ id: U1, title: "Old notice", body: "Old body text", severity: "info", starts_at: "a", ends_at: "b" }] })
    const t = await card("DELETE /api/admin/api-v2/announcements/:id", { params: { id: U1 } }, { db: d, adminId: U3 })
    expect(t).toContain("Old body text")
    expect(t).toMatch(/cannot be restored/)
  })
})
