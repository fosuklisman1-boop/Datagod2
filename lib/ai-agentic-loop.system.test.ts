import { describe, expect, it, vi } from "vitest"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"

describe("agentic loop system prompt passthrough", () => {
  const provider = () => ({
    createMessage: vi.fn(async () => ({ text: "ok", stopReason: "end_turn", toolCalls: [], anthropicContent: [] })),
  })
  const base = { model: "m", context: "home" as const, messages: [], toolCtx: { userRole: "guest", baseUrl: "http://x" } }

  it("passes a stable/volatile object through untouched", async () => {
    const p = provider()
    const system = { stable: "S", volatile: "V" }
    await runAgenticLoop({ ...base, provider: p as never, system })
    expect((p.createMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ system })
  })

  it("passes a string through untouched", async () => {
    const p = provider()
    await runAgenticLoop({ ...base, provider: p as never, system: "plain" })
    expect((p.createMessage.mock.calls[0] as unknown[])[0]).toMatchObject({ system: "plain" })
  })
})
