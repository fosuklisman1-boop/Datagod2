import { afterEach, describe, expect, it, vi } from "vitest"

const wa = vi.hoisted(() => ({ flag: vi.fn(async () => undefined) }))
vi.mock("@/lib/whatsapp-bot/notify-admins", () => ({ flagAndNotifyHumanRequest: wa.flag }))

import { runAgenticLoop } from "@/lib/ai-agentic-loop"
import { adminBackgroundTools, withoutPrepareTools } from "@/lib/ai-scheduled/tools"
import type { AIChatContext } from "@/lib/ai-tools"

/** A provider that calls `name` once, then ends; returns the tool_result text the loop fed back. */
function harness(name: string) {
  let n = 0
  const seen: string[] = []
  const provider = {
    createMessage: vi.fn(async (req: { messages: Array<{ role: string; content: unknown }> }) => {
      n++
      if (n === 1) return { text: "", stopReason: "tool_use", toolCalls: [{ id: "tc1", name, input: {} }], anthropicContent: [] }
      const last = req.messages.at(-1)!.content as Array<{ content: string }>
      seen.push(last[0].content)
      return { text: "ok", stopReason: "end_turn", toolCalls: [], anthropicContent: [] }
    }),
  } as any
  return { provider, seen }
}

const run = async (context: AIChatContext, tool: string, extra: Record<string, unknown> = {}, toolCtx: Record<string, unknown> = {}) => {
  const h = harness(tool)
  await runAgenticLoop({
    provider: h.provider, model: "m", system: "s", context, messages: [],
    toolCtx: { userRole: "guest", baseUrl: "http://x", ...toolCtx } as any, ...extra,
  })
  return h.seen[0]
}

describe("agentic loop passes its context to tool execution", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("WhatsApp: a whatsapp-registered tool executes", async () => {
    const out = await run("whatsapp", "request_human_handoff", {}, { phone: "233240000001" })
    expect(out).toContain('"success":true')
    expect(wa.flag).toHaveBeenCalledWith("233240000001")
  })

  it("WhatsApp: an admin tool is refused as tool_not_available, handler never runs", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const out = await run("whatsapp", "get_all_orders", {}, { userRole: "admin", jwtToken: "t" })
    expect(out).toContain("tool_not_available")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("cron admin run: an admin tool kept by adminBackgroundTools executes", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ settings: { ordering_enabled: true } }) }))
    vi.stubGlobal("fetch", fetchSpy)
    const out = await run("admin", "toggle_ordering", { toolFilter: adminBackgroundTools }, { userRole: "admin", jwtToken: "cron", background: true })
    expect(out).toContain('"success":true')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("cron admin run, catalog switch ON: an acting ops tool is refused and never runs", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    for (const tool of ["toggle_ordering", "update_order_status", "send_notification", "manage_blacklist"]) {
      const out = await run("admin", tool, { toolFilter: adminBackgroundTools, adminCatalog: true }, { userRole: "admin", jwtToken: "cron", background: true })
      expect(out).toContain("not available")
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("cron admin run, catalog switch ON: even without the filter the allow-check refuses an acting tool", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const out = await run("admin", "toggle_ordering", { adminCatalog: true }, { userRole: "admin", jwtToken: "cron", background: true })
    expect(out).toContain("tool_not_available")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("cron dashboard run: prepare_wallet_order stays refused by the background filter", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const out = await run("dashboard", "prepare_wallet_order", { toolFilter: withoutPrepareTools }, { userRole: "dealer", userId: "u1" })
    expect(out).toContain("not available")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
