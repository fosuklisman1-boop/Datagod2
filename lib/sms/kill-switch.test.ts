import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ enabled: true, throws: false }))
vi.mock("./platform-settings", () => ({
  loadSmsSettings: () => (h.throws ? Promise.reject(new Error("db down")) : Promise.resolve({ featureEnabled: h.enabled })),
}))

import { isSmsEnabled, SMS_DISABLED_MESSAGE } from "./kill-switch"

beforeEach(() => { h.enabled = true; h.throws = false })

describe("isSmsEnabled", () => {
  it("is true when the setting is on", async () => expect(await isSmsEnabled()).toBe(true))
  it("is false when the setting is off", async () => { h.enabled = false; expect(await isSmsEnabled()).toBe(false) })
  it("fails OPEN when settings cannot be loaded", async () => { h.throws = true; expect(await isSmsEnabled()).toBe(true) })
  it("exposes the customer-facing message", () => expect(SMS_DISABLED_MESSAGE).toBe("SMS is temporarily unavailable. Please try again later."))
})
