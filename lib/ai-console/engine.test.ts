import { describe, it, expect } from "vitest"
import { globalEngine, applyEngine, parseTab, changedSettings, hasEmptyModel, type ConsoleForm } from "./engine"

const base = (over: Partial<ConsoleForm> = {}): ConsoleForm => ({
  assistant_name: "DATAGOD AI", tone: "default",
  audiences: { admins: true, signedIn: true, shopVisitors: true, publicVisitors: true },
  max_tool_steps: null,
  storefront_provider: "anthropic", storefront_model: "claude-haiku-4-5-20251001",
  dashboard_provider: "anthropic", dashboard_model: "claude-haiku-4-5-20251001",
  admin_provider: "anthropic", admin_model: "claude-haiku-4-5-20251001",
  whatsapp_provider: "openai", whatsapp_model: "gpt-4o-mini",
  keys: { anthropic: "", openai: "", gemini: "", deepseek: "", groq: "" },
  ...over,
})

describe("globalEngine", () => {
  it("returns the shared engine of storefront/dashboard/admin (WhatsApp ignored)", () => {
    expect(globalEngine(base())).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" })
  })
  it("is null (Mixed) when they differ", () => {
    expect(globalEngine(base({ admin_model: "claude-opus-4-7" }))).toBeNull()
    expect(globalEngine(base({ dashboard_provider: "openai" }))).toBeNull()
  })
})

describe("applyEngine", () => {
  it("sets storefront+dashboard+admin only, never WhatsApp", () => {
    const f = applyEngine(base(), "gemini", "gemini-2.5-pro")
    expect(f.storefront_provider).toBe("gemini")
    expect(f.dashboard_model).toBe("gemini-2.5-pro")
    expect(f.admin_provider).toBe("gemini")
    expect(f.whatsapp_provider).toBe("openai")
    expect(f.whatsapp_model).toBe("gpt-4o-mini")
  })
})

describe("changedSettings", () => {
  it("is empty when nothing changed", () => expect(changedSettings(base(), base())).toEqual({}))
  it("includes only changed fields", () => {
    expect(changedSettings(base(), base({ tone: "fun", assistant_name: "Kofi" }))).toEqual({ tone: "fun", assistant_name: "Kofi" })
  })
  it("compares audiences by value", () => {
    const a = { admins: true, signedIn: false, shopVisitors: true, publicVisitors: true }
    expect(changedSettings(base(), base({ audiences: a }))).toEqual({ audiences: a })
    expect(changedSettings(base(), base({ audiences: { ...base().audiences } }))).toEqual({})
  })
  it("sends max_tool_steps null to reset", () => {
    expect(changedSettings(base({ max_tool_steps: 8 }), base({ max_tool_steps: null }))).toEqual({ max_tool_steps: null })
  })
  it("sends non-empty trimmed keys as *_api_key_new and ignores blank ones", () => {
    const e = base({ keys: { anthropic: "  sk-ant-x  ", openai: "   ", gemini: "", deepseek: "", groq: "" } })
    expect(changedSettings(base(), e)).toEqual({ anthropic_api_key_new: "sk-ant-x" })
  })
  it("sends provider/model changes", () => {
    expect(changedSettings(base(), applyEngine(base(), "openai", "gpt-4o"))).toEqual({
      storefront_provider: "openai", storefront_model: "gpt-4o",
      dashboard_provider: "openai", dashboard_model: "gpt-4o",
      admin_provider: "openai", admin_model: "gpt-4o",
    })
  })
})

describe("parseTab", () => {
  it("accepts the four tabs", () => {
    for (const t of ["settings", "knowledge", "conversations", "flags"]) expect(parseTab(t)).toBe(t)
  })
  it("defaults to settings", () => {
    expect(parseTab(undefined)).toBe("settings")
    expect(parseTab("nope")).toBe("settings")
    expect(parseTab(["knowledge", "x"])).toBe("knowledge")
  })
})

describe("model id guard and name trim", () => {
  it("empty_other_model_not_saved: blank model ids are never sent and are flagged invalid", () => {
    const e = applyEngine(base(), "openai", "   ")
    expect(changedSettings(base(), e)).toEqual({})
    expect(hasEmptyModel(e)).toBe(true)
    expect(hasEmptyModel(base())).toBe(false)
  })
  it("trims assistant_name and model ids before sending", () => {
    expect(changedSettings(base(), base({ assistant_name: "  Kofi  " }))).toEqual({ assistant_name: "Kofi" })
    expect(changedSettings(base(), applyEngine(base(), "openai", " gpt-4o "))).toMatchObject({ admin_model: "gpt-4o" })
  })
})
