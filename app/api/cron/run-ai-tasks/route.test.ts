import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, any>

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  runStanding: vi.fn(),
  runLoop: vi.fn(),
  push: vi.fn(),
  sms: vi.fn(),
  usersReadFails: false,
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
          if (table === "users" && h.usersReadFails) return Promise.resolve({ data: null, error: { message: "boom" } })
          const x = run()
          return Promise.resolve({ data: x.data[0] ?? null, error: null })
        },
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
vi.mock("@/lib/ai-drafts/standing-order", () => ({ runStandingOrder: (...a: unknown[]) => h.runStanding(...a) }))

import { GET } from "./route"
import { aiTools } from "@/lib/ai-tools"

const USER = "11111111-1111-4111-8111-111111111111"
const past = () => new Date(Date.now() - 60_000).toISOString()

function seed(taskOver: Row = {}) {
  h.tables = {
    users: [{ id: USER, role: "user", email: "u@example.com", phone_number: "0241234567" }],
    admin_settings: [],
    ai_scheduled_tasks: [
      {
        id: "t1", name: "Data order: MTN 5GB → 024***4567", prompt: "Standing data order (runs without AI)", context: "dashboard",
        user_id: USER, user_role: "user", schedule_type: "daily", run_at_time: "08:00", run_on_days: null, run_at_timestamp: null,
        notify_channels: ["push"], next_run_at: past(), is_active: true, consecutive_skips: 0,
        standing_order: { package_id: "p", network: "MTN", size: "5GB", recipient: "0241234567", max_price_ghs: 20 },
        approved_draft_id: "d1", ...taskOver,
      },
    ],
  }
}

const req = () => ({ headers: new Headers() }) as any

beforeEach(() => {
  h.runStanding.mockReset()
  h.runLoop.mockReset()
  h.push.mockReset()
  h.sms.mockReset()
  h.usersReadFails = false
  h.runLoop.mockResolvedValue({ text: "done", toolsUsed: [] })
  process.env.CRON_SECRET = "cron-secret"
})

describe("run-ai-tasks standing orders", () => {
  it("skip_sends_push_not_sms", async () => {
    seed()
    h.runStanding.mockResolvedValue({ result: "skipped", reason: "above_cap" })
    await GET(req())
    expect(h.runLoop).not.toHaveBeenCalled()
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(h.sms).not.toHaveBeenCalled()
    const t = h.tables.ai_scheduled_tasks[0]
    expect(t.consecutive_skips).toBe(1)
    expect(t.is_active).toBe(true)
    expect(new Date(t.next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it("third_skip_pauses_task", async () => {
    seed({ consecutive_skips: 2 })
    h.runStanding.mockResolvedValue({ result: "skipped", reason: "insufficient_balance" })
    await GET(req())
    const t = h.tables.ai_scheduled_tasks[0]
    expect(t.consecutive_skips).toBe(3)
    expect(t.is_active).toBe(false)
    expect(h.push).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(h.push.mock.calls[0])).toMatch(/paused/i)
    expect(h.sms).not.toHaveBeenCalled()
  })

  it("buy-right and phone pauses use their own push text and never SMS", async () => {
    seed()
    h.runStanding.mockResolvedValue({ result: "paused", reason: "no_buy_right" })
    await GET(req())
    expect(JSON.stringify(h.push.mock.calls[0])).toContain("paused: your account can no longer buy data")
    expect(h.tables.ai_scheduled_tasks[0].is_active).toBe(false)

    h.push.mockReset()
    seed()
    h.runStanding.mockResolvedValue({ result: "paused", reason: "phone_unverified" })
    await GET(req())
    expect(JSON.stringify(h.push.mock.calls[0])).toContain("paused: please verify your phone number")
    expect(h.sms).not.toHaveBeenCalled()
  })

  it("ordered resets skips and notifies with the order code", async () => {
    seed({ consecutive_skips: 2 })
    h.runStanding.mockResolvedValue({ result: "ordered", orderCode: "ORD-77" })
    await GET(req())
    const t = h.tables.ai_scheduled_tasks[0]
    expect(t.consecutive_skips).toBe(0)
    expect(t.last_success).toBe(true)
    expect(JSON.stringify(h.push.mock.calls[0])).toContain("ORD-77")
    expect(h.sms).not.toHaveBeenCalled()
  })

  it("a safety pause deactivates, notifies by push, and never calls the model", async () => {
    seed()
    h.runStanding.mockResolvedValue({ result: "paused", reason: "safety_check" })
    await GET(req())
    expect(h.tables.ai_scheduled_tasks[0].is_active).toBe(false)
    expect(JSON.stringify(h.push.mock.calls[0])).toContain("paused for a safety check")
    expect(h.runLoop).not.toHaveBeenCalled()
  })

  it("a purchase failure takes the failure path (SMS added) and is not retried", async () => {
    seed()
    h.runStanding.mockResolvedValue({ result: "failed", reason: "http_500" })
    await GET(req())
    expect(h.runStanding).toHaveBeenCalledTimes(1)
    expect(h.tables.ai_scheduled_tasks[0].last_success).toBe(false)
    expect(h.sms).toHaveBeenCalledTimes(1)
  })

  it("passes the scheduled slot (next_run_at) to runStandingOrder", async () => {
    const slot = past()
    seed({ next_run_at: slot })
    h.runStanding.mockResolvedValue({ result: "ordered", orderCode: "X" })
    await GET(req())
    expect(h.runStanding.mock.calls[0][1].next_run_at).toBe(slot)
    expect(h.runStanding.mock.calls[0][2]).toMatchObject({ cronSecret: "cron-secret" })
  })

  it("cron_dashboard_toolset_has_no_prepare_wallet_order", async () => {
    seed({ standing_order: null, approved_draft_id: null, prompt: "Summarise my week" })
    await GET(req())
    expect(h.runLoop).toHaveBeenCalledTimes(1)
    const params = h.runLoop.mock.calls[0][0]
    expect(typeof params.toolFilter).toBe("function")
    const names = params.toolFilter(aiTools("dashboard")).map((t: { name: string }) => t.name)
    expect(names.some((n: string) => n.startsWith("prepare_"))).toBe(false)
    expect(names).not.toContain("prepare_wallet_order")
    expect(names).toContain("notify_self")
  })
})

describe("run-ai-tasks account gate", () => {
  const plainTask = { standing_order: null, approved_draft_id: null, prompt: "Summarise my week" }

  function expectSkipped() {
    expect(h.runLoop).not.toHaveBeenCalled()
    expect(h.push).not.toHaveBeenCalled()
    expect(h.sms).not.toHaveBeenCalled()
    const t = h.tables.ai_scheduled_tasks[0]
    expect(t.last_result).toBe("Task skipped: account suspended")
    expect(t.last_success).toBe(false)
    expect(new Date(t.next_run_at).getTime()).toBeGreaterThan(Date.now()) // advanced, no spin
  }

  it("cron_skips_task_for_suspended_user", async () => {
    seed(plainTask)
    h.tables.users[0].is_suspended = true
    await GET(req())
    expectSkipped()
  })

  it("cron_skips_task_for_missing_user_row", async () => {
    seed(plainTask)
    h.tables.users = []
    await GET(req())
    expectSkipped()
  })

  it("cron_skips_task_when_user_read_fails", async () => {
    seed(plainTask)
    h.usersReadFails = true
    await GET(req())
    expectSkipped()
  })

  it("an active user's task still runs", async () => {
    seed(plainTask)
    await GET(req())
    expect(h.runLoop).toHaveBeenCalledTimes(1)
  })
})
