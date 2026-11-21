import { describe, it, expect, vi } from "vitest"

const tools = vi.hoisted(() => ({ executeToolCall: vi.fn() }))
vi.mock("@/lib/ai-tools", () => ({ aiTools: () => [], executeToolCall: tools.executeToolCall }))

import { runAgenticLoop } from "@/lib/ai-agentic-loop"

function providerCalling(name: string) {
  let n = 0
  return {
    createMessage: vi.fn(async () => {
      n++
      return n === 1
        ? { text: "", stopReason: "tool_use", toolCalls: [{ id: "tc1", name, input: {} }], anthropicContent: [] }
        : { text: "Tap Confirm on the card.", stopReason: "end_turn", toolCalls: [], anthropicContent: [] }
    }),
  } as any
}

const run = (name: string) => {
  const events: Array<Record<string, unknown>> = []
  return runAgenticLoop({
    provider: providerCalling(name), model: "m", system: "s", context: "dashboard", messages: [],
    toolCtx: { userRole: "user", baseUrl: "http://x" }, onEvent: e => events.push(e),
  }).then(() => events)
}

describe("loop_emits_draft_card", () => {
  it("emits draft_card with the draft fields when a prepare_* result has a draft_id", async () => {
    tools.executeToolCall.mockResolvedValueOnce({
      draft_id: "d1", display: { title: "Confirm data order" }, expires_at: "2026-11-21T10:00:00Z", warnings: ["duplicate_recent"],
    })
    const events = await run("prepare_wallet_order")
    expect(events.find(e => e.type === "draft_card")).toEqual({
      type: "draft_card", draft_id: "d1", display: { title: "Confirm data order" }, expires_at: "2026-11-21T10:00:00Z", warnings: ["duplicate_recent"],
    })
  })

  it("emits nothing for a refusal", async () => {
    tools.executeToolCall.mockResolvedValueOnce({ refused: true, code: "insufficient_balance", message: "no" })
    const events = await run("prepare_wallet_order")
    expect(events.some(e => e.type === "draft_card")).toBe(false)
  })

  it("does not emit for a non-prepare tool even if its result carries a draft_id", async () => {
    tools.executeToolCall.mockResolvedValueOnce({ draft_id: "x", display: {} })
    const events = await run("get_wallet_balance")
    expect(events.some(e => e.type === "draft_card")).toBe(false)
  })
})
