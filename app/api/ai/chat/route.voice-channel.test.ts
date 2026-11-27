import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { toolsFor } from "@/lib/ai-tool-registry"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  role: "dealer",
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      const row = table === "users" ? { first_name: "A", last_name: "B", phone_number: "0240000000", role: h.role, is_suspended: false } : null
      const b: any = {
        select: () => b, eq: () => b, is: () => b, limit: () => b, or: () => b,
        single: async () => ({ data: row, error: null }),
        maybeSingle: async () => ({ data: row, error: null }),
        then: (res: any, rej: any) => Promise.resolve({ data: row, error: null }).then(res, rej),
      }
      return b
    },
  }),
}))
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/ai-providers", () => ({
  DEFAULT_CONFIG: {},
  resolveProviderForContext: () => ({ provider: { createMessage: () => {} }, model: "m", providerName: "p" }),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-console/transcripts", () => ({ recordTurn: vi.fn() }))
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: async () => [] }))

import { POST } from "./route"

async function post(body: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], ...body }),
  })
  const res = await POST(req)
  await res.text()
  return h.runAgenticLoop.mock.calls.at(-1)?.[0] as { toolFilter?: (t: Array<{ name: string }>) => Array<{ name: string }>; context: string } | undefined
}

beforeEach(() => {
  vi.resetAllMocks()
  h.role = "dealer"
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
})

describe("channel: voice on /api/ai/chat", () => {
  it("dashboard voice: acting tools are not offered, prepare_* tools are", async () => {
    const call = await post({ context: "dashboard", channel: "voice" })
    expect(call?.toolFilter).toBeTypeOf("function")
    const offered = call!.toolFilter!(toolsFor("dashboard")).map((t) => t.name)
    expect(offered).not.toContain("manage_my_ussd_shop")
    expect(offered).not.toContain("schedule_task")
    expect(offered).toContain("prepare_wallet_order")
  })

  it("admin voice: no update_order_status / manual_fulfill_order / manage_blacklist, in either catalog mode", async () => {
    h.role = "admin"
    const call = await post({ context: "admin", channel: "voice" })
    expect(call?.toolFilter).toBeTypeOf("function")
    for (const catalog of [false, true]) {
      const offered = call!.toolFilter!(toolsFor("admin", undefined, catalog)).map((t) => t.name)
      for (const n of ["update_order_status", "manual_fulfill_order", "manage_blacklist", "bulk_blacklist", "retry_failed_order", "manage_shop"]) {
        expect(offered, `${catalog}: ${n}`).not.toContain(n)
      }
      expect(offered).toContain("prepare_wallet_adjustment")
    }
  })

  it("text chat (no channel) is unchanged: no filter, every tool still offered", async () => {
    const call = await post({ context: "dashboard" })
    expect(call?.toolFilter).toBeUndefined()
  })

  it("an unknown channel value is treated as text", async () => {
    for (const channel of ["text", "VOICE", "admin", 1, null, { a: 1 }]) {
      const call = await post({ context: "dashboard", channel })
      expect(call?.toolFilter, String(channel)).toBeUndefined()
    }
  })
})
