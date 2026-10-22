import { describe, it, expect } from "vitest"
import { v2DocsRegistry } from "./registry"
import type { V2ErrorStatus } from "../envelope"

const VALID_STATUS: V2ErrorStatus[] = [400, 401, 402, 403, 404, 409, 429, 500, 502, 503]
const endpoints = v2DocsRegistry.flatMap((s) => s.endpoints)

describe("v2DocsRegistry", () => {
  it("has unique section ids", () => {
    const ids = v2DocsRegistry.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has unique endpoint ids", () => {
    const ids = endpoints.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("documents every endpoint fully", () => {
    for (const e of endpoints) {
      expect(e.summary.length).toBeGreaterThan(0)
      expect(e.rateLimit.length).toBeGreaterThan(0)
      expect(Object.keys(e.successExample).length).toBeGreaterThan(0)
      expect(e.path.startsWith("/")).toBe(true)
      expect(["standard", "commission", "sms"]).toContain(e.keyType)
      for (const err of e.errors) expect(VALID_STATUS).toContain(err.status as V2ErrorStatus)
    }
  })

  it("contains the two live endpoints", () => {
    const sigs = endpoints.map((e) => `${e.method} ${e.path}`)
    expect(sigs).toContain("GET /account/role")
    expect(sigs).toContain("GET /wallet/balance")
  })

  it("has real prose in the Start sections", () => {
    const start = v2DocsRegistry.filter((s) => s.group === "start")
    const ids = start.map((s) => s.id)
    for (const id of ["overview", "authentication", "key-types", "response-format", "errors-and-limits", "idempotency", "sandbox"]) {
      expect(ids).toContain(id)
    }
    for (const s of start) {
      expect(s.endpoints).toEqual([])
      expect((s.intro ?? "").length).toBeGreaterThan(40)
      if (s.steps) {
        expect(s.steps.length).toBeGreaterThan(0)
        s.steps.forEach((x) => expect(x.length).toBeGreaterThan(0))
      }
      if (s.callouts) {
        expect(s.callouts.length).toBeGreaterThan(0)
        s.callouts.forEach((c) => expect(c.body.length).toBeGreaterThan(0))
      }
    }
    const auth = start.find((s) => s.id === "authentication")!
    expect(auth.steps?.length).toBeGreaterThan(0)
    expect(auth.callouts?.some((c) => c.tone === "warning")).toBe(true)
    expect(auth.steps?.[auth.steps.length - 1]).toMatch(/approval/i)
  })
})
