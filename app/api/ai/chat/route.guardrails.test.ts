import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  runAgenticLoop: vi.fn(),
  terminalDraftsSince: vi.fn(),
  suspended: false,
  providerCalls: 0,
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => {
      const row = table === "users" ? { first_name: "A", last_name: "B", phone_number: "0240000000", role: "dealer", is_suspended: h.suspended } : null
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
vi.mock("@/lib/ai-drafts/repo", () => ({ terminalDraftsSince: h.terminalDraftsSince }))

import { POST } from "./route"

const CK = "11111111-1111-4111-8111-111111111111"
const REAL_ID = "33333333-3333-4333-8333-333333333333"

async function post(body: Record<string, unknown>) {
  const req = new NextRequest("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ context: "dashboard", ...body }),
  })
  const res = await POST(req)
  const text = await res.text()
  const call = h.runAgenticLoop.mock.calls.at(-1)?.[0] as { messages: Array<{ role: string; content: string }> } | undefined
  return { text, call }
}

beforeEach(() => {
  vi.resetAllMocks()
  h.suspended = false
  h.providerCalls = 0
  h.runAgenticLoop.mockResolvedValue({ text: "", toolsUsed: [] })
  h.terminalDraftsSince.mockResolvedValue([])
})

describe("suspension", () => {
  it("suspended_user_gets_fixed_message_no_model_call", async () => {
    h.suspended = true
    const { text } = await post({ messages: [{ role: "user", content: "hi" }], conversationKey: CK })
    const events = text.split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")))
    expect(events).toEqual([
      { type: "text", content: "Your account is suspended. Please contact support." },
      { type: "done" },
    ])
    expect(h.runAgenticLoop).not.toHaveBeenCalled()
    expect(h.providerCalls).toBe(0)
    expect(h.terminalDraftsSince).not.toHaveBeenCalled()
  })

  it("an active user proceeds to the loop", async () => {
    const { call } = await post({ messages: [{ role: "user", content: "hi" }] })
    expect(call).toBeDefined()
  })
})

describe("history", () => {
  it("history_normalised_before_provider", async () => {
    const { call } = await post({
      messages: [
        { role: "assistant", content: "stale greeting" },
        { role: "user", content: "a" },
        { role: "user", content: "b" },
        { role: "assistant", content: "   " },
        { role: "assistant", content: "reply" },
        { role: "user", content: "latest" },
        { role: "assistant", content: "dangling" },
      ],
    })
    expect(call!.messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "latest" },
    ])
  })

  it("card results still land on the LAST user message after normalisation", async () => {
    h.terminalDraftsSince.mockResolvedValue([{ id: REAL_ID, status: "failed", outcome: { code: "insufficient_balance" } }])
    const { call } = await post({ conversationKey: CK, messages: [{ role: "user", content: "x" }, { role: "user", content: "what happened?" }] })
    expect(call!.messages).toHaveLength(1)
    expect(call!.messages[0].content).toContain(`[card ${REAL_ID}: failed; insufficient_balance]`)
    expect(call!.messages[0].content).toMatch(/x\n\nwhat happened\?$/)
  })
})
