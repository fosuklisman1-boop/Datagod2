import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  resolveProvider: vi.fn(),
  rateLimit: vi.fn(),
  tables: [] as string[],
  config: {} as Record<string, unknown>,
  role: "dealer",
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      h.tables.push(table)
      const row = table === "admin_settings"
        ? { value: h.config }
        : table === "users" ? { first_name: "A", last_name: "B", phone_number: "0240000000", role: h.role, is_suspended: false } : null
      const b: any = {
        select: () => b, eq: () => b, is: () => b, limit: () => b, or: () => b, order: () => b, in: () => b,
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: row, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: row ? [row] : [], error: null }).then(res, rej),
      }
      return b
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: unknown[]) => h.rateLimit(...a) }))
vi.mock("@/lib/ai-providers", () => ({
  DEFAULT_CONFIG: {},
  resolveProviderForContext: (...a: unknown[]) => h.resolveProvider(...a),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: async () => [] }))

import { POST } from "./route"
import { resetAIConfigCache } from "@/lib/ai-console/load-config"

async function post(context: string, auth = true) {
  const req = new NextRequest("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { ...(auth ? { authorization: "Bearer tok" } : {}), "content-type": "application/json" },
    body: JSON.stringify({ context, messages: [{ role: "user", content: "hi" }] }),
  })
  const res = await POST(req)
  return { res, text: await res.text() }
}

const off = (k: string) => ({ audiences: { admins: true, signedIn: true, shopVisitors: true, publicVisitors: true, [k]: false } })

beforeEach(() => {
  vi.resetAllMocks()
  resetAIConfigCache()
  h.tables = []
  h.config = {}
  h.role = "dealer"
  h.rateLimit.mockResolvedValue({ allowed: true })
  h.resolveProvider.mockReturnValue({ provider: {}, model: "m", providerName: "p" })
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
})

describe("audience_off_403_no_provider", () => {
  it.each([
    ["home", "publicVisitors", false],
    ["storefront", "shopVisitors", false],
    ["storefront", "shopVisitors", true], // signed-in user on a storefront still counts as a shop visitor
    ["dashboard", "signedIn", true],
  ])("%s with %s off -> 403 assistant_off before rate limit, provider, knowledge, tools (auth=%s)", async (context, key, auth) => {
    h.config = off(key)
    const { res, text } = await post(context, auth)
    expect(res.status).toBe(403)
    expect(JSON.parse(text)).toEqual({ error: "assistant_off" })
    expect(h.rateLimit).not.toHaveBeenCalled()
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.tables).not.toContain("ai_knowledge")
  })

  it("body is { error: 'assistant_off' }", async () => {
    h.config = off("publicVisitors")
    const { text } = await post("home", false)
    expect(JSON.parse(text)).toEqual({ error: "assistant_off" })
  })

  it("other audiences are unaffected", async () => {
    h.config = off("publicVisitors")
    const { res } = await post("dashboard")
    expect(res.status).toBe(200)
    expect(h.runAgenticLoop).toHaveBeenCalled()
  })

  it("auth checks still run first: dashboard without a token stays 401 even when signedIn is off", async () => {
    h.config = off("signedIn")
    expect((await post("dashboard", false)).res.status).toBe(401)
  })
})

describe("admin_audience_off", () => {
  it("admin gets 403 assistant_off when admins is off; non-admins still get the admin-access 403 first", async () => {
    h.config = off("admins")
    h.role = "admin"
    const a = await post("admin")
    expect(a.res.status).toBe(403)
    expect(JSON.parse(a.text)).toEqual({ error: "assistant_off" })
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.rateLimit).not.toHaveBeenCalled()

    h.role = "dealer"
    const b = await post("admin")
    expect(b.res.status).toBe(403)
    expect(JSON.parse(b.text)).toEqual({ error: "Admin access required" })
  })
})

describe("max steps and prompt wiring", () => {
  it("maxIterations follows the setting, else today's defaults", async () => {
    await post("dashboard")
    expect(h.runAgenticLoop.mock.calls.at(-1)![0].maxIterations).toBe(10)
    h.role = "admin"
    await post("admin")
    expect(h.runAgenticLoop.mock.calls.at(-1)![0].maxIterations).toBe(20)
    resetAIConfigCache()
    h.config = { max_tool_steps: 6 }
    await post("admin")
    expect(h.runAgenticLoop.mock.calls.at(-1)![0].maxIterations).toBe(6)
  })

  it("custom name and tone reach the stable prompt", async () => {
    h.config = { assistant_name: "Kofi Bot", tone: "friendly" }
    await post("dashboard")
    const sys = h.runAgenticLoop.mock.calls.at(-1)![0].system as { stable: string }
    expect(sys.stable).toContain("Your name is Kofi Bot.")
    expect(sys.stable).toContain("TONE:")
  })
})
