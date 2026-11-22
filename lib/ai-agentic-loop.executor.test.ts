import { describe, expect, it, vi } from "vitest"

const real = vi.hoisted(() => ({ fn: vi.fn(async () => ({ from: "real" })) }))
vi.mock("@/lib/ai-tools", async (orig) => {
  const actual = await orig<typeof import("@/lib/ai-tools")>()
  return { ...actual, executeToolCall: real.fn }
})

import { runAgenticLoop } from "@/lib/ai-agentic-loop"

function scripted() {
  let n = 0
  return {
    createMessage: vi.fn(async () => {
      n++
      if (n === 1) return { text: "", stopReason: "tool_use", toolCalls: [{ id: "t", name: "get_knowledge_base", input: { q: 1 } }], anthropicContent: [] }
      return { text: "done", stopReason: "end_turn", toolCalls: [], anthropicContent: [] }
    }),
  } as any
}
const base = { model: "m", system: "s", context: "home" as const, messages: [], toolCtx: { userRole: "guest", baseUrl: "http://x" } }

describe("runAgenticLoop executor seam", () => {
  it("uses the real executeToolCall when no executor is injected", async () => {
    real.fn.mockClear()
    await runAgenticLoop({ ...base, provider: scripted() })
    expect(real.fn).toHaveBeenCalledTimes(1)
  })

  it("uses an injected executor instead of the real one", async () => {
    real.fn.mockClear()
    const executeTool = vi.fn(async () => ({ from: "stub" }))
    const r = await runAgenticLoop({ ...base, provider: scripted(), executeTool })
    expect(executeTool).toHaveBeenCalledWith("get_knowledge_base", { q: 1 }, expect.objectContaining({ context: "home" }))
    expect(real.fn).not.toHaveBeenCalled()
    expect(r.toolsUsed).toEqual(["get_knowledge_base"])
  })
})
