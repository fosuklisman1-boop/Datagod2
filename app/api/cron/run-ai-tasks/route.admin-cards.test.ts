import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, any>

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  runLoop: vi.fn(),
  push: vi.fn(),
  sms: vi.fn(),
  fetch: vi.fn(),
  configFail: null as null | "error" | "throw",
}))

function makeDb() {
  return {
    from(table: string) {
      if (!h.tables[table]) h.tables[table] = []
      const rows = h.tables[table]
      const filters: Array<(r: Row) => boolean> = []
      let op: "select" | "update" = "select"
      let patch: Row = {}
      const run = () => {
        const matched = rows.filter((r) => filters.every((f) => f(r)))
        if (op === "update") matched.forEach((r) => Object.assign(r, patch))
        return { data: matched.map((r) => ({ ...r })), error: null as any }
      }
      const b: any = {
        update(p: Row) { op = "update"; patch = p; return b },
        select() { return b },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return b },
        lte(c: string, v: string) { filters.push((r) => r[c] <= v); return b },
        maybeSingle() {
          if (table === "admin_settings" && h.configFail === "error") return Promise.resolve({ data: null, error: { message: "boom" } })
          if (table === "admin_settings" && h.configFail === "throw") return Promise.reject(new Error("boom"))
          const x = run(); return Promise.resolve({ data: x.data[0] ?? null, error: null }) },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej) },
      }
      return b
    },
  }
}

vi.mock("@supabase/supabase-js", () => ({ createClient: () => makeDb() }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: (...a: unknown[]) => h.runLoop(...a) }))
vi.mock("@/lib/ai-providers", () => ({
  DEFAULT_CONFIG: {},
  resolveProviderForContext: () => ({ provider: "p", model: "m" }),
}))
vi.mock("@/lib/push-service", () => ({ sendPushToUser: (...a: unknown[]) => h.push(...a) }))
vi.mock("@/lib/sms-service", () => ({ sendSMS: (...a: unknown[]) => h.sms(...a) }))
vi.mock("@/lib/email-service", () => ({ sendEmail: vi.fn() }))
vi.mock("@/lib/ai-drafts/standing-order", () => ({ runStandingOrder: vi.fn() }))

import { GET } from "./route"
import { aiTools } from "@/lib/ai-tools"
import { adminBackgroundTools } from "@/lib/ai-scheduled/tools"
import { TOOL_REGISTRY } from "@/lib/ai-tool-registry"

const ADMIN = "22222222-2222-4222-8222-222222222222"
const past = () => new Date(Date.now() - 60_000).toISOString()
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name)
const CARD_TITLE = "Action needs your confirmation"

function seed(role: "admin" | "user", taskOver: Row = {}) {
  h.tables = {
    users: [{ id: ADMIN, role, email: "a@example.com", phone_number: "0241234567" }],
    admin_settings: [],
    ai_drafts: [],
    ai_scheduled_tasks: [
      {
        id: "t1", name: "Morning withdrawals", prompt: "Approve pending withdrawals", context: "admin",
        user_id: ADMIN, user_role: "admin", schedule_type: "daily", run_at_time: "08:00", run_on_days: null, run_at_timestamp: null,
        notify_channels: ["push"], next_run_at: past(), is_active: true, consecutive_skips: 0,
        standing_order: null, approved_draft_id: null, ...taskOver,
      },
    ],
  }
}

const req = () => ({ headers: new Headers() }) as any

function draftRow(key: unknown, over: Row = {}): Row {
  return { id: `d-${Math.random().toString(16).slice(2)}`, user_id: ADMIN, conversation_key: key, status: "pending", display: { title: "Confirm withdrawal" }, ...over }
}

beforeEach(() => {
  h.configFail = null
  h.runLoop.mockReset()
  h.push.mockReset()
  h.sms.mockReset()
  h.fetch.mockReset()
  vi.stubGlobal("fetch", h.fetch)
  h.runLoop.mockResolvedValue({ text: "done", toolsUsed: [] })
  process.env.CRON_SECRET = "cron-secret"
})

describe("run-ai-tasks admin cards", () => {
  it("admin_task_creates_12h_draft_and_push", async () => {
    seed("admin")
    h.runLoop.mockImplementation(async (p: any) => {
      expect(p.toolCtx.background).toBe(true)
      h.tables.ai_drafts.push(draftRow(p.toolCtx.conversationKey, { id: "draft-1", display: { title: "Confirm approve withdrawals", count: 3, total_ghs: 450 } }))
      return { text: "Prepared one card.", toolsUsed: ["prepare_withdrawal_action"] }
    })
    await GET(req())
    const confirmPush = h.push.mock.calls.find((c) => c[1].title === CARD_TITLE)
    expect(confirmPush).toBeTruthy()
    expect(confirmPush![0]).toBe(ADMIN)
    expect(confirmPush![1].body).toContain("Confirm approve withdrawals")
    expect(confirmPush![1].body.length).toBeLessThanOrEqual(120)
    expect(confirmPush![1].data).toEqual({ url: "/admin?draft=draft-1" })
    expect(h.tables.ai_scheduled_tasks[0].last_result).toContain("1 card(s) waiting for your confirmation")
  })

  it("sends one push per draft and ignores other conversations and non-pending drafts", async () => {
    seed("admin")
    h.runLoop.mockImplementation(async (p: any) => {
      const k = p.toolCtx.conversationKey
      h.tables.ai_drafts.push(draftRow(k, { id: "a" }), draftRow(k, { id: "b" }), draftRow(k, { id: "old", status: "superseded" }), draftRow("other-key", { id: "x" }))
      return { text: "ok", toolsUsed: [] }
    })
    await GET(req())
    const urls = h.push.mock.calls.filter((c) => c[1].title === CARD_TITLE).map((c) => c[1].data.url).sort()
    expect(urls).toEqual(["/admin?draft=a", "/admin?draft=b"])
  })

  it("no cards means no confirmation push", async () => {
    seed("admin")
    await GET(req())
    expect(h.push.mock.calls.some((c) => c[1].title === CARD_TITLE)).toBe(false)
  })

  it("admin_background_toolset_pinned", async () => {
    seed("admin")
    await GET(req())
    expect(h.fetch).not.toHaveBeenCalled()
    const p = h.runLoop.mock.calls[0][0]
    // The cron hands the loop the real admin-background filter.
    expect(p.toolFilter).toBe(adminBackgroundTools)
    const list = names(adminBackgroundTools(aiTools("admin")))
    for (const n of ["place_wallet_order", "adjust_wallet_balance", "manage_withdrawal", "suspend_user", "update_user_role", "bulk_update_order_status", "prepare_wallet_order"]) {
      expect(list).not.toContain(n)
    }
    for (const n of ["prepare_wallet_adjustment", "prepare_withdrawal_action", "prepare_user_suspension", "prepare_role_change", "prepare_bulk_status_update"]) {
      expect(list).toContain(n)
    }
  })

  it("admin_task_toolset_excludes_prepare_wallet_order", async () => {
    seed("admin")
    await GET(req())
    const p = h.runLoop.mock.calls[0][0]
    const list = names(p.toolFilter(aiTools("admin")))
    expect(list).not.toContain("prepare_wallet_order")
    for (const n of ["prepare_wallet_adjustment", "prepare_withdrawal_action", "prepare_user_suspension", "prepare_role_change", "prepare_bulk_status_update"]) {
      expect(list).toContain(n)
    }
    expect(list.length).toBeGreaterThan(10)
  })

  it("admin_task_conversation_key_fresh_per_run", async () => {
    seed("admin")
    await GET(req())
    h.tables.ai_scheduled_tasks[0].next_run_at = past()
    await GET(req())
    const [k1, k2] = h.runLoop.mock.calls.map((c) => c[0].toolCtx.conversationKey)
    expect(k1).toMatch(/^[0-9a-f-]{36}$/)
    expect(k2).toMatch(/^[0-9a-f-]{36}$/)
    expect(k1).not.toBe(k2)
  })

  it("admin prompt says nobody is watching", async () => {
    seed("admin")
    await GET(req())
    const sys = h.runLoop.mock.calls[0][0].system as string
    expect(sys).toContain("You are running in the background with nobody watching. You cannot adjust wallets, act on withdrawals, change roles, suspend users, bulk-change order statuses or place data orders")
    expect(sys).not.toContain("You cannot perform actions")
  })

  it("switch ON: admin background run is told the catalog is on, so no ops/money/account tool is offered or runnable", async () => {
    seed("admin")
    h.tables.admin_settings = [{ key: "ai_provider_config", value: { admin_catalog_enabled: true } }]
    await GET(req())
    const p = h.runLoop.mock.calls[0][0]
    expect(p.adminCatalog).toBe(true)
    const acting = TOOL_REGISTRY.filter((e) => e.acts === "ops" || e.acts === "money" || e.acts === "account").map((e) => e.tool.name)
    const list = names(p.toolFilter(aiTools("admin", undefined, p.adminCatalog)))
    for (const n of acting) expect(list).not.toContain(n)
    for (const n of ["prepare_withdrawal_action", "prepare_wallet_adjustment", "get_all_orders"]) expect(list).toContain(n)
  })

  for (const mode of ["error", "throw"] as const) {
    it(`config read ${mode}: admin task is skipped untouched (fail closed), no tool runs, next tick retries`, async () => {
      seed("admin")
      h.configFail = mode
      const before = { ...h.tables.ai_scheduled_tasks[0] }
      await GET(req())
      expect(h.runLoop).not.toHaveBeenCalled()
      expect(h.fetch).not.toHaveBeenCalled()
      expect(h.tables.ai_scheduled_tasks[0]).toEqual(before) // not stamped, not rescheduled
    })

    it(`config read ${mode}: non-admin task runs exactly as before`, async () => {
      seed("user", { context: "dashboard", user_role: "user" })
      h.configFail = mode
      await GET(req())
      expect(h.runLoop).toHaveBeenCalledTimes(1)
      expect(h.runLoop.mock.calls[0][0].context).toBe("dashboard")
    })
  }

  it("switch OFF: admin background run is unchanged (no adminCatalog flag)", async () => {
    seed("admin")
    await GET(req())
    expect(h.runLoop.mock.calls[0][0].adminCatalog).toBeUndefined()
  })

  it("non_admin_task_gets_no_admin_tools", async () => {
    seed("user")
    await GET(req())
    const p = h.runLoop.mock.calls[0][0]
    expect(p.context).toBe("dashboard")
    expect(p.toolCtx.background).toBeUndefined()
    const list = names(p.toolFilter(aiTools("dashboard")))
    expect(list.some((n) => n.startsWith("prepare_"))).toBe(false)
    expect(h.push.mock.calls.some((c) => c[1].title === CARD_TITLE)).toBe(false)
  })
})
