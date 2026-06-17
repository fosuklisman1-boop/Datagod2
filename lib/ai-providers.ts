import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import { GoogleGenerativeAI, Content, Part } from "@google/generative-ai"
import { AIProviderConfig, DEFAULT_CONFIG, ProviderName, PROVIDER_MODELS } from "@/lib/ai-provider-config"

// Re-export so server-side callers can import from one place
export type { AIProviderConfig, ProviderName }
export { DEFAULT_CONFIG, PROVIDER_MODELS }

// ── Shared types ──────────────────────────────────────────────────────────────

// Minimal content-block shape we reconstruct for Anthropic-format history.
// We avoid using Anthropic.ContentBlock directly because newer SDK versions
// add required fields (citations, caller) that don't exist in synthesised blocks.
type AnthropicContentLike = { type: string; [key: string]: unknown }

export interface NormalizedResponse {
  text: string
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[]
  stopReason: "end_turn" | "tool_use"
  // Anthropic-format content blocks for pushing back to message history
  anthropicContent: AnthropicContentLike[]
}

export interface AIProvider {
  createMessage(params: {
    model: string
    maxTokens: number
    system: string
    tools: Anthropic.Tool[]
    messages: Anthropic.MessageParam[]
  }): Promise<NormalizedResponse>

  // One-shot image understanding (vision). Returns a plain-text description.
  // Kept separate from createMessage because the agentic loop's history
  // converters strip image blocks (the loop is a text-only, multi-provider
  // transport). Vision needs a direct, provider-native image request, so each
  // adapter formats the image the way its own API expects.
  describeImage(params: {
    model: string
    base64: string
    mediaType: string
    prompt: string
    maxTokens?: number
  }): Promise<string>
}

// ── Anthropic adapter ─────────────────────────────────────────────────────────

class AnthropicAdapter implements AIProvider {
  private client: Anthropic
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  async createMessage({ model, maxTokens, system, tools, messages }: Parameters<AIProvider["createMessage"]>[0]): Promise<NormalizedResponse> {
    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    })

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")

    const toolCalls = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map(b => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))

    return {
      text,
      toolCalls,
      stopReason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      anthropicContent: response.content as unknown as AnthropicContentLike[],
    }
  }

  async describeImage({ model, base64, mediaType, prompt, maxTokens = 250 }: Parameters<AIProvider["describeImage"]>[0]): Promise<string> {
    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: base64 } },
          { type: "text", text: prompt },
        ],
      }],
    })
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text)
      .join("")
  }
}

// ── OpenAI adapter ────────────────────────────────────────────────────────────

function toOpenAIMessages(messages: Anthropic.MessageParam[]): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content })
      } else {
        const toolResults = msg.content.filter(
          (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result"
        )
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            out.push({
              role: "tool",
              tool_call_id: tr.tool_use_id,
              content: typeof tr.content === "string"
                ? tr.content
                : Array.isArray(tr.content)
                  ? tr.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlockParam).text).join("")
                  : "",
            })
          }
        } else {
          const text = msg.content
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map(b => b.text)
            .join("")
          out.push({ role: "user", content: text })
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "assistant", content: msg.content })
      } else {
        const textBlocks = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text")
        const toolBlocks = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        const text = textBlocks.map(b => b.text).join("") || null
        const tool_calls = toolBlocks.map(b => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }))
        const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: text,
        }
        if (tool_calls.length > 0) assistantMsg.tool_calls = tool_calls
        out.push(assistantMsg)
      }
    }
  }

  return out
}

class OpenAIAdapter implements AIProvider {
  private client: OpenAI
  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  async createMessage({ model, maxTokens, system, tools, messages }: Parameters<AIProvider["createMessage"]>[0]): Promise<NormalizedResponse> {
    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map(t => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        parameters: t.input_schema as Record<string, unknown>,
      },
    }))

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: system },
      ...toOpenAIMessages(messages),
    ]

    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      messages: openaiMessages,
    })

    const choice = response.choices[0]
    const text = choice.message.content ?? ""
    const rawToolCalls = choice.message.tool_calls ?? []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolCalls = rawToolCalls.map((tc: any) => ({
      id: tc.id as string,
      name: tc.function?.name as string ?? "",
      input: (() => { try { return JSON.parse(tc.function?.arguments ?? "{}") } catch { return {} } })() as Record<string, unknown>,
    }))

    // Reconstruct Anthropic-format content for history
    const anthropicContent: AnthropicContentLike[] = []
    if (text) anthropicContent.push({ type: "text", text })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const tc of rawToolCalls as any[]) {
      anthropicContent.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function?.name ?? "",
        input: (() => { try { return JSON.parse(tc.function?.arguments ?? "{}") } catch { return {} } })(),
      })
    }
    if (anthropicContent.length === 0) anthropicContent.push({ type: "text", text: "" })

    return {
      text,
      toolCalls,
      stopReason: choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
      anthropicContent,
    }
  }

  async describeImage({ model, base64, mediaType, prompt, maxTokens = 250 }: Parameters<AIProvider["describeImage"]>[0]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mediaType};base64,${base64}` } },
        ],
      }],
    })
    return response.choices[0]?.message?.content ?? ""
  }
}

// ── Gemini adapter ────────────────────────────────────────────────────────────

function findToolName(messages: Anthropic.MessageParam[], toolUseId: string): string {
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id === toolUseId) return block.name
      }
    }
  }
  return "unknown_tool"
}

function toGeminiContents(messages: Anthropic.MessageParam[]): Content[] {
  const out: Content[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", parts: [{ text: msg.content }] })
      } else {
        const toolResults = msg.content.filter(
          (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result"
        )
        if (toolResults.length > 0) {
          const parts: Part[] = toolResults.map(tr => ({
            functionResponse: {
              name: findToolName(messages, tr.tool_use_id),
              response: {
                content: typeof tr.content === "string"
                  ? tr.content
                  : Array.isArray(tr.content)
                    ? tr.content.filter(b => b.type === "text").map(b => (b as Anthropic.TextBlockParam).text).join("")
                    : "",
              },
            },
          }))
          out.push({ role: "user", parts })
        } else {
          const text = msg.content
            .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
            .map(b => b.text)
            .join("")
          out.push({ role: "user", parts: [{ text }] })
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        out.push({ role: "model", parts: [{ text: msg.content }] })
      } else {
        const parts: Part[] = []
        for (const block of msg.content) {
          if (block.type === "text" && block.text) parts.push({ text: block.text })
          if (block.type === "tool_use") {
            parts.push({ functionCall: { name: block.name, args: block.input as Record<string, unknown> } })
          }
        }
        if (parts.length > 0) out.push({ role: "model", parts })
      }
    }
  }

  return out
}

class GeminiAdapter implements AIProvider {
  private client: GoogleGenerativeAI
  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey)
  }

  async createMessage({ model, maxTokens, system, tools, messages }: Parameters<AIProvider["createMessage"]>[0]): Promise<NormalizedResponse> {
    const genModel = this.client.getGenerativeModel({
      model,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: maxTokens },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools.length > 0 ? [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description ?? "", parameters: t.input_schema as any })) }] as any : undefined,
      toolConfig: tools.length > 0
        ? { functionCallingConfig: { mode: "AUTO" as unknown as import("@google/generative-ai").FunctionCallingMode } }
        : undefined,
    })

    const contents = toGeminiContents(messages)
    const response = await genModel.generateContent({ contents })

    const candidate = response.response.candidates?.[0]
    const parts = candidate?.content?.parts ?? []

    let text = ""
    const toolCalls: { id: string; name: string; input: Record<string, unknown> }[] = []
    const anthropicContent: AnthropicContentLike[] = []

    for (const part of parts) {
      if (part.text) {
        text += part.text
        anthropicContent.push({ type: "text", text: part.text })
      }
      if (part.functionCall) {
        const id = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const input = ((part.functionCall as unknown as Record<string, unknown>).args ?? {}) as Record<string, unknown>
        toolCalls.push({ id, name: part.functionCall.name, input })
        anthropicContent.push({ type: "tool_use", id, name: part.functionCall.name, input })
      }
    }

    if (anthropicContent.length === 0) anthropicContent.push({ type: "text", text: "" })

    return {
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      anthropicContent,
    }
  }

  async describeImage({ model, base64, mediaType, prompt, maxTokens = 250 }: Parameters<AIProvider["describeImage"]>[0]): Promise<string> {
    const genModel = this.client.getGenerativeModel({
      model,
      generationConfig: { maxOutputTokens: maxTokens },
    })
    const response = await genModel.generateContent({
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { inlineData: { mimeType: mediaType, data: base64 } },
        ],
      }],
    })
    return response.response.text() ?? ""
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function getProvider(name: ProviderName, apiKey: string): AIProvider {
  switch (name) {
    case "openai":    return new OpenAIAdapter(apiKey)
    case "gemini":    return new GeminiAdapter(apiKey)
    case "deepseek":  return new OpenAIAdapter(apiKey, "https://api.deepseek.com")
    case "groq":      return new OpenAIAdapter(apiKey, "https://api.groq.com/openai/v1")
    default:          return new AnthropicAdapter(apiKey)
  }
}

export function resolveProviderForContext(
  context: "storefront" | "dashboard" | "admin" | "home" | "whatsapp",
  config: AIProviderConfig
): { provider: AIProvider; model: string; providerName: ProviderName } {
  const fallbackKey = process.env.ANTHROPIC_API_KEY ?? ""

  const providerName: ProviderName =
    context === "storefront" || context === "home" ? (config.storefront_provider ?? "anthropic")
    : context === "dashboard" ? (config.dashboard_provider ?? "anthropic")
    : context === "whatsapp" ? (config.whatsapp_provider ?? config.dashboard_provider ?? "anthropic")
    : (config.admin_provider ?? "anthropic")

  const model: string =
    context === "storefront" || context === "home" ? (config.storefront_model ?? DEFAULT_CONFIG.storefront_model!)
    : context === "dashboard" ? (config.dashboard_model ?? DEFAULT_CONFIG.dashboard_model!)
    : context === "whatsapp" ? (config.whatsapp_model ?? config.dashboard_model ?? DEFAULT_CONFIG.whatsapp_model!)
    : (config.admin_model ?? DEFAULT_CONFIG.admin_model!)

  const apiKey: string =
    providerName === "openai"    ? (config.openai_api_key    || "")
    : providerName === "gemini"  ? (config.gemini_api_key    || "")
    : providerName === "deepseek"? (config.deepseek_api_key  || "")
    : providerName === "groq"    ? (config.groq_api_key      || "")
    : (config.anthropic_api_key || fallbackKey)

  // Fallback to Anthropic env key if the chosen provider has no key configured
  if (!apiKey) {
    return {
      provider: new AnthropicAdapter(fallbackKey),
      model: (DEFAULT_CONFIG as Record<string, string>)[`${context}_model`] ?? "claude-haiku-4-5-20251001",
      providerName: "anthropic",
    }
  }

  return { provider: getProvider(providerName, apiKey), model, providerName }
}
