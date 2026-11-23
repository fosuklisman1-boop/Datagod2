import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  config: {} as Record<string, unknown>,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      const row = table === "admin_settings"
        ? { value: h.config }
        : table === "users" ? { first_name: "A", last_name: "B", phone_number: "0240000000", role: "admin", is_suspended: false } : null
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
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/ai-providers", () => ({
  DEFAULT_CONFIG: {},
  resolveProviderForContext: () => ({ provider: {}, model: "m", providerName: "p" }),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: async () => [] }))

import { POST } from "./route"
import { resetAIConfigCache } from "@/lib/ai-console/load-config"

async function post(context: string) {
  const req = new NextRequest("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ context, messages: [{ role: "user", content: "hi" }] }),
  })
  await (await POST(req)).text()
}

beforeEach(() => {
  vi.resetAllMocks()
  resetAIConfigCache()
  h.config = {}
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
})

describe("admin catalog switch in the chat route", () => {
  it("off by default: no switch to the loop and no catalog block in the prompt", async () => {
    await post("admin")
    const p = h.runAgenticLoop.mock.calls.at(-1)![0]
    expect(p.adminCatalog).toBe(false)
    expect(p.system.stable).not.toContain("ADMIN CATALOG")
  })

  it("on: the loop gets the switch and the stable prompt ends with the catalog block", async () => {
    h.config = { admin_catalog_enabled: true }
    await post("admin")
    const p = h.runAgenticLoop.mock.calls.at(-1)![0]
    expect(p.adminCatalog).toBe(true)
    expect(p.system.stable).toContain("Only prepare a change the admin asked for in their own message.")
    expect(p.system.stable.indexOf("ADMIN CATALOG")).toBeGreaterThan(p.system.stable.indexOf("CONFIRM CARDS"))
  })

  it("on: other contexts are untouched", async () => {
    h.config = { admin_catalog_enabled: true }
    await post("dashboard")
    const p = h.runAgenticLoop.mock.calls.at(-1)![0]
    expect(p.adminCatalog).toBe(false)
    expect(p.system.stable).not.toContain("ADMIN CATALOG")
  })
})
