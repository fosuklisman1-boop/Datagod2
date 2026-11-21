import { describe, it, expect } from "vitest"
import { widgetVisible, isAssistantOffResponse, ASSISTANT_OFF_MESSAGE } from "./widget-visibility"

const all = { admins: true, signedIn: true, shopVisitors: true, publicVisitors: true }

describe("widget_visible_per_audience", () => {
  it("shows while loading and when on", () => {
    expect(widgetVisible("home", null)).toBe(true)
    expect(widgetVisible("admin", all)).toBe(true)
  })
  it("maps each widget to its audience", () => {
    expect(widgetVisible("home", { ...all, publicVisitors: false })).toBe(false)
    expect(widgetVisible("storefront", { ...all, shopVisitors: false })).toBe(false)
    expect(widgetVisible("dashboard", { ...all, signedIn: false })).toBe(false)
    expect(widgetVisible("admin", { ...all, admins: false })).toBe(false)
    expect(widgetVisible("home", { ...all, admins: false })).toBe(true)
  })
})

describe("assistant_off_message", () => {
  const mk = (status: number, body: unknown) => ({ status, clone: () => ({ json: async () => body }) })
  it("detects 403 assistant_off only", async () => {
    expect(await isAssistantOffResponse(mk(403, { error: "assistant_off" }))).toBe(true)
    expect(await isAssistantOffResponse(mk(403, { error: "other" }))).toBe(false)
    expect(await isAssistantOffResponse(mk(500, { error: "assistant_off" }))).toBe(false)
    expect(await isAssistantOffResponse({ status: 403, clone: () => ({ json: async () => { throw new Error("x") } }) })).toBe(false)
  })
  it("has the copy", () => expect(ASSISTANT_OFF_MESSAGE).toBe("The assistant is switched off right now."))
})
