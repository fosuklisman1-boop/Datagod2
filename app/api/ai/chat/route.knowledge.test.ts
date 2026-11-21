import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { resetKnowledgeCache } from "@/lib/ai-prompts/knowledge"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  providerCalls: 0,
  authed: true,
  role: "user" as string,
  kb: {} as Record<string, Array<{ category: string; question: string; answer: string }>>,
  kbLabels: [] as string[],
  kbThrow: false,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => (h.authed ? { data: { user: { id: "user-1" } }, error: null } : { data: { user: null }, error: { message: "bad" } }) },
    from: (table: string) => {
      if (table === "ai_knowledge") {
        if (h.kbThrow) throw new Error("kb down")
        let label = ""
        const kb: any = {
          select: () => kb, eq: () => kb,
          contains: (_c: string, v: string[]) => { label = v[0]; h.kbLabels.push(label); return kb },
          then: (res: any, rej: any) => Promise.resolve({ data: h.kb[label] ?? [], error: null }).then(res, rej),
        }
        return kb
      }
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
  resolveProviderForContext: () => ({ provider: { createMessage: () => { h.providerCalls++ } }, model: "m", providerName: "p" }),
}))
vi.mock("@/lib/custom-domain-lookup", () => ({ resolveCustomDomain: async () => null }))
vi.mock("@/lib/ai-agentic-loop", () => ({ runAgenticLoop: h.runAgenticLoop }))
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: async () => [] }))

import { POST } from "./route"

const KB = (answer: string) => [{ category: "Refunds", question: "How?", answer }]

async function post(context: unknown, auth = true) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (auth) headers.authorization = "Bearer tok"
  const res = await POST(new NextRequest("http://localhost/api/ai/chat", {
    method: "POST", headers,
    body: JSON.stringify({ context, messages: [{ role: "user", content: "hi" }] }),
  }))
  const text = await res.text()
  const call = h.runAgenticLoop.mock.calls.at(-1)?.[0] as { system: { stable: string; volatile: string } | string } | undefined
  return { res, text, call }
}
const stableOf = (c: any) => (typeof c.system === "string" ? c.system : c.system.stable)

beforeEach(() => {
  vi.resetAllMocks()
  resetKnowledgeCache()
  h.providerCalls = 0
  h.authed = true
  h.role = "user"
  h.kbLabels = []
  h.kbThrow = false
  h.kb = { admin: KB("ADMIN-SECRET"), dashboard: KB("DASH-ONLY"), storefront: KB("PUBLIC-FAQ") }
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
})

describe("chat route knowledge wiring", () => {
  it("unknown_context_400_no_provider_call", async () => {
    for (const c of ["x", "", undefined, 5, null]) {
      const { res } = await post(c, false)
      expect(res.status).toBe(400)
    }
    const { res, text } = await post("x", false)
    expect(res.status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: "Invalid context" })
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.providerCalls).toBe(0)
    expect(h.kbLabels).toEqual([])
  })

  it("whatsapp contexts keep their dedicated 400", async () => {
    const { res, text } = await post("whatsapp")
    expect(res.status).toBe(400)
    expect(text).toContain("WhatsApp AI context")
  })

  // Replaces unauth_dashboard_gets_storefront_knowledge_label: unauthenticated dashboard is now refused outright (R7).
  it("unauth_dashboard_401_no_provider_call", async () => {
    for (const auth of [false]) {
      const { res, text } = await post("dashboard", auth)
      expect(res.status).toBe(401)
      expect(JSON.parse(text)).toEqual({ error: "Unauthorized" })
    }
    h.authed = false
    const bad = await post("dashboard", true) // bearer present but invalid
    expect(bad.res.status).toBe(401)
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.providerCalls).toBe(0)
    expect(h.kbLabels).toEqual([])
  })

  it("authed_dashboard_still_works", async () => {
    const { res, call } = await post("dashboard", true)
    expect(res.status).toBe(200)
    expect(h.runAgenticLoop).toHaveBeenCalledTimes(1)
    expect(stableOf(call)).toContain("DASH-ONLY")
  })

  it("verified dashboard user gets the dashboard label", async () => {
    const { call } = await post("dashboard", true)
    expect(h.kbLabels).toEqual(["dashboard"])
    expect(stableOf(call)).toContain("DASH-ONLY")
  })

  it("admin_knowledge_only_for_verified_admin", async () => {
    const guest = await post("admin", false)
    expect(guest.res.status).toBe(403)
    h.role = "user"
    const plain = await post("admin", true)
    expect(plain.res.status).toBe(403)
    expect(h.kbLabels).not.toContain("admin")
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    h.role = "admin"
    const { call } = await post("admin", true)
    expect(h.kbLabels).toEqual(["admin"])
    expect(stableOf(call)).toContain("ADMIN-SECRET")
  })

  it("knowledge_in_stable_not_volatile_at_route", async () => {
    const { call } = await post("home", false)
    const sys = (call as any).system
    expect(sys.stable).toContain("PUBLIC-FAQ")
    expect(sys.volatile).not.toContain("PUBLIC-FAQ")
    expect(sys.volatile).not.toContain("Knowledge base")
  })

  it("knowledge_read_throw_chat_still_works", async () => {
    h.kbThrow = true
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const { res, call } = await post("home", false)
    expect(res.status).toBe(200)
    expect(h.runAgenticLoop).toHaveBeenCalledTimes(1)
    expect(stableOf(call)).not.toContain("Knowledge base")
  })
})
