import { afterEach, describe, expect, it, vi } from "vitest"
import { TOOL_REGISTRY, isToolAllowed, toolsFor, type ToolCtx } from "@/lib/ai-tool-registry"
import { executeToolCall, type ToolContext } from "@/lib/ai-tools"
import { adminBackgroundTools, withoutPrepareTools } from "@/lib/ai-scheduled/tools"

const ALL_CONTEXTS: ToolCtx[] = ["home", "storefront", "dashboard", "admin", "whatsapp", "whatsapp_shop"]
const names = (tools: { name: string }[]) => tools.map((t) => t.name)

describe("tool registry invariants", () => {
  it("names_unique", () => {
    const all = TOOL_REGISTRY.map((e) => e.tool.name)
    expect(new Set(all).size).toBe(all.length)
  })

  it("every_tool_has_a_context", () => {
    for (const e of TOOL_REGISTRY) expect(e.contexts.length, e.tool.name).toBeGreaterThan(0)
  })

  it("admin_only_only_in_admin", () => {
    for (const e of TOOL_REGISTRY.filter((x) => x.adminOnly)) expect(e.contexts, e.tool.name).toEqual(["admin"])
  })

  it("forbidden_names_absent", () => {
    const forbidden = ["place_wallet_order", "adjust_wallet_balance", "manage_withdrawal", "suspend_user", "update_user_role", "bulk_update_order_status"]
    const all = new Set(TOOL_REGISTRY.map((e) => e.tool.name))
    for (const f of forbidden) expect(all.has(f), f).toBe(false)
  })

  it("no_money_tool_in_customer_web_contexts", () => {
    for (const e of TOOL_REGISTRY) {
      if (e.acts !== "money") continue
      for (const c of ["dashboard", "storefront", "home"] as const) expect(e.contexts, `${e.tool.name} in ${c}`).not.toContain(c)
    }
  })

  it("prepare_tools_are_draft_and_draft_tools_are_never_money", () => {
    for (const e of TOOL_REGISTRY.filter((x) => x.tool.name.startsWith("prepare_"))) expect(e.acts, e.tool.name).toBe("draft")
  })

  it("visible_equals_callable_per_context", () => {
    for (const c of ALL_CONTEXTS) {
      const visible = new Set(names(toolsFor(c)))
      const callable = new Set(TOOL_REGISTRY.filter((e) => isToolAllowed(e.tool.name, c)).map((e) => e.tool.name))
      expect([...visible].sort(), c).toEqual([...callable].sort())
    }
  })

  it("an unknown tool is allowed nowhere", () => {
    for (const c of ALL_CONTEXTS) expect(isToolAllowed("definitely_not_a_tool", c)).toBe(false)
  })
})

describe("background filters derive from the registry", () => {
  it("every background-denied tool is dropped from both filters, nothing else is", () => {
    const denied = TOOL_REGISTRY.filter((e) => e.background === "deny").map((e) => e.tool.name)
    expect(denied).toContain("prepare_wallet_order")
    const admin = toolsFor("admin")
    expect(names(adminBackgroundTools(admin))).toEqual(names(admin).filter((n) => !denied.includes(n)))
    const dash = toolsFor("dashboard")
    expect(names(withoutPrepareTools(dash))).toEqual(names(dash).filter((n) => !n.startsWith("prepare_") && !denied.includes(n)))
  })
})

describe("executeToolCall is scoped to the request context", () => {
  afterEach(() => vi.unstubAllGlobals())
  const base: ToolContext = { baseUrl: "http://x", userId: "u1", jwtToken: "t", userRole: "admin", context: "dashboard" }

  it("execute_refuses_tool_outside_context", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    // Even an admin-role caller: a dashboard-context request has no get_all_orders.
    const r = await executeToolCall("get_all_orders", {}, base)
    expect(r).toEqual({ error: "tool_not_available" })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith("[AI-TOOLS] tool_not_available tool=get_all_orders context=dashboard")
    warn.mockRestore()
  })

  it("refuses an unregistered tool name in every context", async () => {
    for (const c of ALL_CONTEXTS) {
      expect(await executeToolCall("get_platform_stats", {}, { ...base, context: c })).toEqual({ error: "tool_not_available" })
    }
  })

  it("a registered tool for the context still runs", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ orders: [] }) }))
    vi.stubGlobal("fetch", fetchSpy)
    const r = await executeToolCall("update_order_status", { order_id: "o1", status: "completed" }, { ...base, context: "admin" })
    expect(r).toEqual({ success: true })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("an admin-only tool is still refused for a non-admin role in the admin context", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const r = await executeToolCall("update_order_status", { order_id: "o1", status: "completed" }, { ...base, context: "admin", userRole: "user" })
    expect(r).toEqual({ error: "Not authorized" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
