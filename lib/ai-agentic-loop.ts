import Anthropic from "@anthropic-ai/sdk"
import { AIProvider } from "@/lib/ai-providers"
import { aiTools, executeToolCall } from "@/lib/ai-tools"
import type { AIChatContext } from "@/lib/ai-tools"

export interface AgenticToolCtx {
  userId?: string
  jwtToken?: string
  userRole: string
  shopId?: string
  shopSlug?: string
  baseUrl: string
}

export interface RunAgenticLoopParams {
  provider: AIProvider
  model: string
  system: string
  context: AIChatContext
  messages: Anthropic.MessageParam[]
  toolCtx: AgenticToolCtx
  maxIterations?: number
  /** Called for each SSE-style event (text, tool_call, action_buttons, etc.) — omit for silent/cron runs */
  onEvent?: (event: Record<string, unknown>) => void
}

export interface AgenticLoopResult {
  text: string
  toolsUsed: string[]
}

/**
 * Shared agentic loop used by both the SSE chat route and the cron execution engine.
 * The chat route passes onEvent to stream events; the cron engine omits it for silent execution.
 */
export async function runAgenticLoop({
  provider,
  model,
  system,
  context,
  messages,
  toolCtx,
  maxIterations = 10,
  onEvent,
}: RunAgenticLoopParams): Promise<AgenticLoopResult> {
  const emit = onEvent ?? (() => {})
  const tools = aiTools(context)
  const currentMessages: Anthropic.MessageParam[] = [...messages]
  const toolsUsed: string[] = []
  let finalText = ""

  let keepRunning = true
  let iterations = 0

  while (keepRunning && iterations < maxIterations) {
    iterations++

    const response = await provider.createMessage({
      model,
      maxTokens: 600,
      system,
      tools,
      messages: currentMessages,
    })

    if (response.text) {
      finalText = response.text
      emit({ type: "text", content: response.text })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    currentMessages.push({ role: "assistant", content: response.anthropicContent as any })

    if (response.stopReason === "tool_use" && response.toolCalls.length > 0) {
      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const tc of response.toolCalls) {
        toolsUsed.push(tc.name)
        emit({ type: "tool_call", tool: tc.name })

        const result = await executeToolCall(tc.name, tc.input, toolCtx)

        if (tc.name === "prepare_checkout") {
          emit({ type: "checkout_prefill", data: result })
        }

        if (tc.name === "show_action_buttons") {
          const r = result as Record<string, unknown>
          emit({ type: "action_buttons", buttons: r.buttons ?? [] })
        }

        const resultStr = JSON.stringify(result)
        const truncated = resultStr.length > 3000 ? resultStr.slice(0, 3000) + "…[truncated]" : resultStr
        toolResults.push({
          type: "tool_result",
          tool_use_id: tc.id,
          content: `<data>\n${truncated}\n</data>`,
        })
      }

      currentMessages.push({ role: "user", content: toolResults })
    } else {
      keepRunning = false
    }
  }

  emit({ type: "done" })
  return { text: finalText, toolsUsed }
}
