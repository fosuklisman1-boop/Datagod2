import type Anthropic from "@anthropic-ai/sdk"
import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { aiTools, type StorefrontServiceFlags } from "@/lib/ai-tools"
import type { AIProvider, SystemPrompt } from "@/lib/ai-providers"
import { buildAdminPrompt, buildDashboardPrompt, buildHomePrompt, buildStorefrontPrompt } from "@/lib/ai-prompts"
import { renderKnowledge, type KnowledgeEntry } from "@/lib/ai-prompts/knowledge"
import { checkExpectation, type Expectation, type EvalResult } from "@/lib/ai-eval/assert"

export interface Scenario {
  id: string
  context: "home" | "storefront" | "dashboard" | "admin"
  /** dashboard: dealer|user; admin: admin; home/storefront: guest */
  role: string
  /** One user message, or alternating user/assistant messages starting with user and ending with user. */
  userText: string | string[]
  /** Tool name -> fixed JSON returned instead of really running the tool. */
  stubs?: Record<string, unknown>
  /** Storefront only: the services this shop sells. Omitted = everything. */
  storefrontServices?: ("data_bundles" | "airtime" | "results_checker")[]
  /** Fixed knowledge-base entries injected into the prompt. */
  knowledge?: KnowledgeEntry[]
  expect: Expectation[]
}

export interface ScenarioOutcome {
  id: string
  pass: boolean
  failures: string[]
  modelCalls: number
  reply: string
}

const NONCE = "EVALNONCE0001"

/** Fixed fake user data: never real people, never from a database. */
export function buildScenarioSystem(s: Scenario): SystemPrompt {
  const knowledge = s.knowledge ? renderKnowledge(s.knowledge) : ""
  const common = { ussdDialCode: "*000*1#", knowledge }
  if (s.context === "home") {
    return buildHomePrompt({ ...common, guestPurchaseUrl: "/buy", channelNote: "" })
  }
  if (s.context === "storefront") {
    return buildStorefrontPrompt({ ...common, shopName: "Eval Data Hub", storefrontServices: s.storefrontServices ?? null, shopUssdCode: null })
  }
  if (s.context === "dashboard") {
    return buildDashboardPrompt({ ...common, channelNote: "", firstName: "Ama", lastName: "Mensah", role: s.role, phone: "0240000001", balance: "GHS 50.00", today: "2026-01-02", cardNonce: NONCE })
  }
  return buildAdminPrompt({ ...common, firstName: "Kojo", lastName: "Boateng", today: "2026-01-02", cardNonce: NONCE })
}

function storefrontFlags(s: Scenario): StorefrontServiceFlags | undefined {
  if (s.context !== "storefront" || !s.storefrontServices) return undefined
  return {
    sellsData: s.storefrontServices.includes("data_bundles"),
    sellsAirtime: s.storefrontServices.includes("airtime"),
    sellsResultsChecker: s.storefrontServices.includes("results_checker"),
  }
}

function toMessages(userText: string | string[]): Anthropic.MessageParam[] {
  const turns = Array.isArray(userText) ? userText : [userText]
  return turns.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }) as Anthropic.MessageParam)
}

export async function runScenario(s: Scenario, opts: { provider: AIProvider; model: string }): Promise<ScenarioOutcome> {
  const stubs = s.stubs ?? {}
  const flags = storefrontFlags(s)
  const offeredTools = aiTools(s.context, flags).map((t) => t.name)
  const toolCalls: EvalResult["toolCalls"] = []
  let modelCalls = 0
  const provider: AIProvider = {
    createMessage: async (p) => { modelCalls++; return opts.provider.createMessage(p) },
    describeImage: (p) => opts.provider.describeImage(p),
  }

  const loop = await runAgenticLoop({
    provider,
    model: opts.model,
    system: buildScenarioSystem(s),
    context: s.context,
    storefrontServices: flags,
    messages: toMessages(s.userText),
    toolCtx: { userRole: s.role, baseUrl: "http://eval.invalid", userId: "eval-user", phone: "0240000001", conversationKey: "eval-session" },
    maxIterations: 6,
    // Stubbed execution: a tool the scenario did not stub, or one not offered here, never touches anything real.
    executeTool: async (name, input) => {
      toolCalls.push({ name, input })
      if (!offeredTools.includes(name)) return { error: "tool_not_available" }
      return Object.prototype.hasOwnProperty.call(stubs, name) ? stubs[name] : { error: "not stubbed" }
    },
  })

  const result: EvalResult = { replyText: loop.text, toolCalls, offeredTools }
  const failures = s.expect.map((e) => checkExpectation(e, result)).filter((o) => !o.ok).map((o) => o.detail)
  return { id: s.id, pass: failures.length === 0, failures, modelCalls, reply: loop.text }
}

export async function runScenarios(scenarios: Scenario[], opts: { provider: AIProvider; model: string }): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = []
  for (const s of scenarios) outcomes.push(await runScenario(s, opts))
  return outcomes
}

export function formatReport(outcomes: ScenarioOutcome[]): string {
  const lines = outcomes.map((o) => `${o.pass ? "PASS" : "FAIL"}  ${o.id}${o.pass ? "" : "\n        - " + o.failures.join("\n        - ")}`)
  const passed = outcomes.filter((o) => o.pass).length
  const calls = outcomes.reduce((n, o) => n + o.modelCalls, 0)
  lines.push("", `${passed}/${outcomes.length} passed, ${outcomes.length - passed} failed.`, `Cost note: this run called the model ${calls} times.`)
  return lines.join("\n")
}
