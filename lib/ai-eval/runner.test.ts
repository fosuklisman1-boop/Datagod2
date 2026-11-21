import { describe, expect, it, vi } from "vitest"
import scenarios from "@/scripts/ai-eval/scenarios.json"
import { runScenario, runScenarios, formatReport, type Scenario } from "@/lib/ai-eval/runner"
import { checkExpectation } from "@/lib/ai-eval/assert"
import { aiTools } from "@/lib/ai-tools"

const all = scenarios as unknown as Scenario[]
const byId = (id: string) => all.find((s) => s.id === id)!

/** A fake provider that replays scripted responses and records what it was sent. */
function fake(script: Array<{ text?: string; tool?: { name: string; input?: Record<string, unknown> } }>) {
  let i = 0
  const requests: Array<{ system: unknown; tools: { name: string }[]; messages: any[] }> = []
  return {
    requests,
    provider: {
      createMessage: vi.fn(async (req: any) => {
        requests.push({ ...req, messages: [...req.messages] })
        const step = script[Math.min(i++, script.length - 1)]
        if (step.tool) {
          return { text: step.text ?? "", stopReason: "tool_use", toolCalls: [{ id: `t${i}`, name: step.tool.name, input: step.tool.input ?? {} }], anthropicContent: [] }
        }
        return { text: step.text ?? "", stopReason: "end_turn", toolCalls: [], anthropicContent: [] }
      }),
      describeImage: vi.fn(async () => ""),
    } as any,
  }
}

describe("scenarios.json", () => {
  it("has 10-14 well-formed scenarios with unique ids", () => {
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all.length).toBeLessThanOrEqual(14)
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length)
    for (const s of all) {
      expect(["home", "storefront", "dashboard", "admin"]).toContain(s.context)
      expect(s.expect.length).toBeGreaterThan(0)
      const turns = Array.isArray(s.userText) ? s.userText : [s.userText]
      expect(turns.length % 2).toBe(1) // starts and ends with a user message
    }
  })

  it("every stub and tool expectation names a real tool offered somewhere", () => {
    const known = new Set(["home", "storefront", "dashboard", "admin"].flatMap((c) => aiTools(c as any).map((t) => t.name)))
    for (const s of all) {
      for (const name of Object.keys(s.stubs ?? {})) expect(known.has(name), `${s.id}: stub ${name}`).toBe(true)
      for (const e of s.expect) if ("tool" in e) expect(known.has(e.tool), `${s.id}: ${e.tool}`).toBe(true)
    }
  })

  it("static offered-tool expectations hold for the real tool lists", () => {
    for (const s of all) {
      const flags = s.storefrontServices
        ? { sellsData: s.storefrontServices.includes("data_bundles"), sellsAirtime: s.storefrontServices.includes("airtime"), sellsResultsChecker: s.storefrontServices.includes("results_checker") }
        : undefined
      const offeredTools = aiTools(s.context, flags).map((t) => t.name)
      for (const e of s.expect) {
        if (e.type === "toolOffered" || e.type === "toolNotOffered") {
          expect(checkExpectation(e, { replyText: "", toolCalls: [], offeredTools }).ok, `${s.id}: ${e.type} ${e.tool}`).toBe(true)
        }
      }
    }
  })
})

describe("runScenario (fake provider, stubbed tools)", () => {
  it("passes a buy scenario when the model prepares a card and does not claim success", async () => {
    const f = fake([
      { tool: { name: "prepare_wallet_order", input: { network: "MTN", size: "5GB", phone: "0240000002" } } },
      { text: "I have prepared the order. Please tap Confirm on the card." },
    ])
    const o = await runScenario(byId("dash-buy-request-prepares-card"), { provider: f.provider, model: "fake" })
    expect(o.failures).toEqual([])
    expect(o.pass).toBe(true)
    expect(o.modelCalls).toBe(2)
    // The tool result handed back to the model is the scenario stub, wrapped in the data fence.
    const toolResult = f.requests[1].messages.at(-1).content[0].content as string
    expect(toolResult).toContain("MTN 5GB to 0240000002")
    expect(toolResult.startsWith("<data>")).toBe(true)
    // The real system prompt and the real context tool list were used.
    expect(typeof f.requests[0].system).toBe("object")
    expect(f.requests[0].tools.map((t) => t.name)).toContain("prepare_wallet_order")
  })

  it("fails when the model claims the order was placed", async () => {
    const f = fake([{ text: "Done! Your order has been placed successfully." }])
    const o = await runScenario(byId("dash-buy-request-prepares-card"), { provider: f.provider, model: "fake" })
    expect(o.pass).toBe(false)
    expect(o.failures.join(" ")).toMatch(/prepare_wallet_order/)
    expect(o.failures.join(" ")).toMatch(/claims success/)
  })

  it("returns not-stubbed for an unstubbed tool and refuses a tool that is not offered", async () => {
    const f = fake([
      { tool: { name: "prepare_wallet_adjustment", input: {} } },
      { tool: { name: "get_wallet_transactions", input: {} } },
      { text: "I cannot do that." },
    ])
    const o = await runScenario(byId("dash-dealer-adjust-other-wallet-refused"), { provider: f.provider, model: "fake" })
    const second = f.requests[1].messages.at(-1).content[0].content as string
    expect(second).toContain("tool_not_available")
    const third = f.requests[2].messages.at(-1).content[0].content as string
    expect(third).toContain("not stubbed")
    expect(o.pass).toBe(false) // it called prepare_wallet_adjustment, which must be a failure
  })

  it("passes the prompt-injection scenario for a model that ignores the injected text", async () => {
    const f = fake([{ tool: { name: "get_order_history" } }, { text: "Your last order is still pending." }])
    const o = await runScenario(byId("dash-injection-in-tool-result"), { provider: f.provider, model: "fake" })
    expect(o.pass).toBe(true)
  })

  it("runs a list, reports totals and the cost note", async () => {
    const f = fake([{ text: "Delivery usually takes 5 to 30 minutes." }])
    const outcomes = await runScenarios([byId("home-delivery-time-from-knowledge")], { provider: f.provider, model: "fake" })
    expect(outcomes[0].pass).toBe(true)
    const report = formatReport(outcomes)
    expect(report).toContain("PASS  home-delivery-time-from-knowledge")
    expect(report).toContain("1/1 passed")
    expect(report).toMatch(/called the model 1 times/)
    // knowledge was injected into the system prompt
    expect(JSON.stringify(f.requests[0].system)).toContain("5 to 30 minutes")
  })
})
