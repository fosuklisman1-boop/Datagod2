import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
  geminiConfig: vi.fn(),
}))

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: h.anthropicCreate }
  },
}))
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: h.openaiCreate } }
  },
}))
vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel(cfg: unknown) {
      h.geminiConfig(cfg)
      return { generateContent: async () => ({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } }) }
    }
  },
}))

import { getProvider } from "./ai-providers"

const base = { model: "m", maxTokens: 10, tools: [], messages: [{ role: "user" as const, content: "hi" }] }
const SPLIT = { stable: "STABLE PART", volatile: "VOLATILE PART" }

beforeEach(() => {
  vi.clearAllMocks()
  h.anthropicCreate.mockResolvedValue({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
  h.openaiCreate.mockResolvedValue({ choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }] })
})

describe("system prompt shapes", () => {
  it("anthropic_two_system_blocks_cache_first", async () => {
    await getProvider("anthropic", "k").createMessage({ ...base, system: SPLIT })
    expect(h.anthropicCreate.mock.calls[0][0].system).toEqual([
      { type: "text", text: "STABLE PART", cache_control: { type: "ephemeral" } },
      { type: "text", text: "VOLATILE PART" },
    ])
  })

  it("anthropic_empty_volatile_sends_one_cached_block", async () => {
    await getProvider("anthropic", "k").createMessage({ ...base, system: { stable: "STABLE PART", volatile: "" } })
    expect(h.anthropicCreate.mock.calls[0][0].system).toEqual([
      { type: "text", text: "STABLE PART", cache_control: { type: "ephemeral" } },
    ])
  })

  it("openai_gemini_joined_stable_first", async () => {
    await getProvider("openai", "k").createMessage({ ...base, system: SPLIT })
    expect(h.openaiCreate.mock.calls[0][0].messages[0]).toEqual({ role: "system", content: "STABLE PART\n\nVOLATILE PART" })

    await getProvider("gemini", "k").createMessage({ ...base, system: SPLIT })
    expect(h.geminiConfig.mock.calls[0][0].systemInstruction).toBe("STABLE PART\n\nVOLATILE PART")
  })

  it("openai_gemini_empty_volatile_is_just_stable", async () => {
    await getProvider("openai", "k").createMessage({ ...base, system: { stable: "S", volatile: "" } })
    expect(h.openaiCreate.mock.calls[0][0].messages[0].content).toBe("S")
  })

  it("string_system_unchanged", async () => {
    await getProvider("anthropic", "k").createMessage({ ...base, system: "plain" })
    expect(h.anthropicCreate.mock.calls[0][0].system).toBe("plain")
    await getProvider("openai", "k").createMessage({ ...base, system: "plain" })
    expect(h.openaiCreate.mock.calls[0][0].messages[0]).toEqual({ role: "system", content: "plain" })
    await getProvider("gemini", "k").createMessage({ ...base, system: "plain" })
    expect(h.geminiConfig.mock.calls[0][0].systemInstruction).toBe("plain")
  })
})
