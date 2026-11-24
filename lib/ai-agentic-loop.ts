import Anthropic from "@anthropic-ai/sdk"
import type { AIProvider, SystemPrompt } from "@/lib/ai-providers"
import { MAX_TOOL_RESULT_CHARS } from "@/lib/ai-tool-result-limit"
import { aiTools, executeToolCall } from "@/lib/ai-tools"
import type { AIChatContext, StorefrontServiceFlags, ToolContext } from "@/lib/ai-tools"

export { MAX_TOOL_RESULT_CHARS }

export interface AgenticToolCtx {
  userId?: string
  jwtToken?: string
  userRole: string
  shopId?: string
  shopSlug?: string
  baseUrl: string
  // WhatsApp only: authoritative sender number (233…) so phone-keyed tools
  // (file_complaint, request_human_handoff, start_ordering_bot) don't depend on
  // the model passing the number in the right format.
  phone?: string
  /** Chat session uuid (dashboard + admin): drafts in the same session supersede each other. */
  conversationKey?: string
  /** Set by background (cron) runs: drafts live 12 h. */
  background?: boolean
  /** Dashboard chat: the verified user owns a shop (server-derived); scopes get_knowledge_base site articles. */
  isShopOwner?: boolean
}

export interface RunAgenticLoopParams {
  provider: AIProvider
  model: string
  system: SystemPrompt
  context: AIChatContext
  messages: Anthropic.MessageParam[]
  toolCtx: AgenticToolCtx
  /** context === "storefront" only: which services this shop/domain actually sells, gating the tool list to match. */
  storefrontServices?: StorefrontServiceFlags
  /** Admin context only: the admin catalog switch (default off = today's tool list). */
  adminCatalog?: boolean
  maxIterations?: number
  maxTokens?: number
  /** Called for each SSE-style event (text, tool_call, action_buttons, etc.) — omit for silent/cron runs */
  onEvent?: (event: Record<string, unknown>) => void
  /** Narrows the tool list the model sees (cron runs drop every prepare_* tool). A call to a dropped tool is refused. */
  toolFilter?: (tools: Anthropic.Tool[]) => Anthropic.Tool[]
  /** Test/eval seam: replaces tool execution (the eval harness stubs results). Omitted in production = real executeToolCall. */
  executeTool?: (name: string, input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
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
  storefrontServices,
  adminCatalog,
  maxIterations = 10,
  maxTokens = 1500,
  onEvent,
  toolFilter,
  executeTool = executeToolCall,
}: RunAgenticLoopParams): Promise<AgenticLoopResult> {
  const emit = onEvent ?? (() => {})
  const allTools = aiTools(context, storefrontServices, adminCatalog)
  const tools = toolFilter ? toolFilter(allTools) : allTools
  const allowedNames = new Set(tools.map((t) => t.name))
  const currentMessages: Anthropic.MessageParam[] = [...messages]
  const toolsUsed: string[] = []
  let finalText = ""

  let keepRunning = true
  let iterations = 0

  while (keepRunning && iterations < maxIterations) {
    iterations++

    const response = await provider.createMessage({
      model,
      maxTokens,
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

        // A filtered run never executes a tool it was not offered (a model can name one anyway).
        const result = toolFilter && !allowedNames.has(tc.name)
          ? { error: "This tool is not available in this run." }
          : await executeTool(tc.name, tc.input, { ...toolCtx, context, storefrontServices, ...(adminCatalog ? { adminCatalog: true } : {}) })

        if (tc.name === "prepare_checkout") {
          emit({ type: "checkout_prefill", data: result })
        }

        if (tc.name === "show_action_buttons") {
          const r = result as Record<string, unknown>
          emit({ type: "action_buttons", buttons: r.buttons ?? [] })
        }

        // A prepare_* tool that created a draft: the widget renders a confirm card from this event.
        if (tc.name.startsWith("prepare_")) {
          const r = result as Record<string, unknown> | null
          if (r && typeof r.draft_id === "string") {
            emit({ type: "draft_card", draft_id: r.draft_id, display: r.display, expires_at: r.expires_at, warnings: r.warnings ?? [] })
          }
        }

        // Fence hardening: neutralise any <data ...> / </data> tag in the tool output BEFORE truncating, so a
        // result can neither close the fence early nor leave a half-formed tag at the cut. Bounded: attributes are
        // at most 200 non-newline chars, and end-of-string only terminates a SHORT unterminated tag, so a stray
        // "<data-x" can never swallow real data up to the end. A tag with no bounded end is replaced on its own.
        const resultStr = (JSON.stringify(result) ?? "null").replace(/<\s*(\/?)\s*data\b(?:[^>\n]{0,200}>|[^>\n]{0,200}$)?/gi, (_m, slash: string) => (slash ? "[/data]" : "[data]"))
        const truncated = resultStr.length > MAX_TOOL_RESULT_CHARS ? resultStr.slice(0, MAX_TOOL_RESULT_CHARS) + "…[truncated]" : resultStr
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
