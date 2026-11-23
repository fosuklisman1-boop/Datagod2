import { describe, expect, it } from "vitest"
import { CHANGELOG } from "./changelog"
import { V2_BASE_URL, v2DocsRegistry } from "./registry"

const ISO = /^\d{4}-\d{2}-\d{2}$/

describe("CHANGELOG", () => {
  it("uses ISO dates, newest first, with no released entry in the future", () => {
    const today = new Date().toISOString().slice(0, 10)
    for (const e of CHANGELOG) expect(e.date).toMatch(ISO)
    for (let i = 1; i < CHANGELOG.length; i++) expect(CHANGELOG[i - 1].date > CHANGELOG[i].date).toBe(true)
    for (const e of CHANGELOG.filter((x) => x.status === "released")) expect(e.date <= today).toBe(true)
  })

  it("has at most one scheduled entry and it is the 2026-11-30 sunset", () => {
    const scheduled = CHANGELOG.filter((e) => e.status === "scheduled")
    expect(scheduled.length).toBeLessThanOrEqual(1)
    for (const e of scheduled) expect(e.date).toBe("2026-11-30")
  })

  it("gives every entry a source, a title and items", () => {
    for (const e of CHANGELOG) {
      expect(e.source.trim().length).toBeGreaterThan(0)
      expect(e.title.trim().length).toBeGreaterThan(0)
      expect(e.items.length).toBeGreaterThan(0)
      for (const i of e.items) expect(i.trim().length).toBeGreaterThan(0)
    }
  })

  it("mentions only endpoint paths that exist in the registry", () => {
    const paths = v2DocsRegistry.flatMap((s) => s.endpoints.map((e) => e.path))
    const text = CHANGELOG.flatMap((e) => [e.title, ...e.items]).join("\n")
    for (const prefix of ["/airtime", "/bundles", "/resultschecker", "/afa", "/sms"]) {
      if (new RegExp(`${prefix}(?![a-z])`).test(text)) expect(paths.some((p) => p.startsWith(prefix)), prefix).toBe(true)
    }
    for (const m of text.matchAll(/\b(?:GET|POST) (\/[A-Za-z0-9/_{}-]+)/g)) {
      expect(paths, m[1]).toContain(m[1])
    }
  })

  it("states the base URL exactly", () => {
    expect(CHANGELOG.some((e) => e.items.some((i) => i.includes(V2_BASE_URL)))).toBe(true)
  })
})
