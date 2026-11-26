import { describe, expect, it } from "vitest"
import { WEBHOOKS_PUBLISHED } from "./flags"
import { WEBHOOKS_SECTION, pollingNote } from "./webhooks-docs"
import { v2DocsRegistry } from "./registry"
import { changelogAt } from "./changelog"

const NOW = new Date("2026-11-26T12:00:00Z")
const text = (x: unknown) => JSON.stringify(x)

describe("webhooks docs flag", () => {
  it("ships switched off: no Webhooks section, the polling notes still say Datagod does not send webhooks, no changelog entry", () => {
    expect(WEBHOOKS_PUBLISHED).toBe(false)
    expect(v2DocsRegistry.some((s) => s.id === "webhooks")).toBe(false)
    expect(text(v2DocsRegistry)).toContain("Datagod does not send webhooks")
    expect(changelogAt(NOW).some((e) => /webhook/i.test(e.title))).toBe(false)
  })
  it("flag on: the polling note points at Webhooks; one changelog entry", () => {
    expect(pollingNote(true)).toMatch(/Webhooks/)
    expect(pollingNote(true)).not.toMatch(/does not send webhooks/)
    expect(pollingNote(false)).toMatch(/does not send webhooks/)
    expect(changelogAt(NOW, { webhooks: true }).filter((e) => /webhook/i.test(e.title))).toHaveLength(1)
  })
  it("the section states the contract a receiver needs", () => {
    const s = text(WEBHOOKS_SECTION)
    expect(WEBHOOKS_SECTION.id).toBe("webhooks")
    for (const must of ["order.updated", "webhook.test", "completed", "failed", "refunded", "Datagod-Signature", "t=", "v1=", "HMAC-SHA256",
      "raw body", "5 minutes", "Datagod-Event-Id", "1 minute, 5 minutes, 30 minutes, 2 hours, 8 hours and 24 hours", "2xx", "redirect", "10 seconds", "HTTPS"]) {
      expect(s, must).toContain(must)
    }
  })
})
