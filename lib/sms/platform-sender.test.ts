import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ settings: vi.fn() }))
vi.mock("./platform-settings", () => ({ loadSmsSettings: h.settings }))
vi.mock("@/lib/sms-service", () => ({ platformSenderName: () => "ENVNAME" }))

import { resolvePlatformSender } from "./platform-sender"

beforeEach(() => { h.settings.mockReset() })

describe("resolvePlatformSender", () => {
  it("uses the configured default when set and in the list", async () => {
    h.settings.mockResolvedValue({ platformSenders: ["ABC", "KINGS"], platformDefaultSender: "KINGS" })
    expect(await resolvePlatformSender()).toBe("KINGS")
  })
  it("falls back to the env name when no default is set", async () => {
    h.settings.mockResolvedValue({ platformSenders: ["ABC"], platformDefaultSender: null })
    expect(await resolvePlatformSender()).toBe("ENVNAME")
  })
  it("falls back when the default is no longer in the list", async () => {
    h.settings.mockResolvedValue({ platformSenders: ["ABC"], platformDefaultSender: "OLD" })
    expect(await resolvePlatformSender()).toBe("ENVNAME")
  })
  it("matches case-insensitively and returns the list's spelling", async () => {
    h.settings.mockResolvedValue({ platformSenders: ["KINGS"], platformDefaultSender: "kings" })
    expect(await resolvePlatformSender()).toBe("KINGS")
  })
  it("never throws: settings failure falls back to the env name", async () => {
    h.settings.mockImplementation(async () => { throw new Error("boom") })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await resolvePlatformSender()).toBe("ENVNAME")
    spy.mockRestore()
  })
})
