import { describe, it, expect } from "vitest"
import { GO_LIVE_STEPS } from "./go-live"
import { DOC_PAGES, STATIC_DOC_PAGES, docPath, sectionHref } from "./pages"
import { v2DocsRegistry } from "./registry"
import { SANDBOX_TEST_NUMBERS } from "../sandbox-outcomes"

describe("go-live steps", () => {
  it("are in the spec order with unique ids", () => {
    expect(GO_LIVE_STEPS.map((s) => s.id)).toEqual([
      "test-key",
      "sandbox-run",
      "failure-numbers",
      "verify-phone",
      "request-live-key",
      "message-admin",
      "wait-approval",
      "first-live-order",
      "poll-keep-old-key",
    ])
    expect(new Set(GO_LIVE_STEPS.map((s) => s.id)).size).toBe(GO_LIVE_STEPS.length)
  })

  it("only link to internal pages and real registry sections", () => {
    const ok = new Set<string>([
      "/dashboard/developer",
      ...DOC_PAGES.map((p) => docPath(p.slug)),
      ...STATIC_DOC_PAGES.map((p) => docPath(p.slug)),
      ...v2DocsRegistry.map((s) => sectionHref(s.id)),
    ])
    for (const step of GO_LIVE_STEPS) {
      expect(step.links.length).toBeGreaterThan(0)
      for (const l of step.links) expect(ok.has(l.href), `${step.id}: ${l.href}`).toBe(true)
    }
  })

  it("mentions only known sandbox numbers", () => {
    const known = new Set<string>([...SANDBOX_TEST_NUMBERS.fail, ...SANDBOX_TEST_NUMBERS.stuck])
    const text = GO_LIVE_STEPS.map((s) => s.body).join(" ")
    const found = text.match(/\b0\d{9}\b/g) ?? []
    expect(found.length).toBeGreaterThan(0)
    for (const n of found) expect(known.has(n), n).toBe(true)
  })

  it("states no approval time, price or SLA", () => {
    const text = GO_LIVE_STEPS.map((s) => `${s.title} ${s.body}`).join(" ")
    expect(text).not.toMatch(/minutes|hours|GHS|within/i)
  })

  it("describes the real approval flow", () => {
    const text = GO_LIVE_STEPS.map((s) => s.body).join(" ")
    expect(text).toMatch(/request code/)
    expect(text).toMatch(/Message admin on WhatsApp/)
    expect(text).toMatch(/keeps working until the new one is approved/)
  })
})
