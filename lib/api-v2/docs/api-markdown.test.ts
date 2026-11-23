import { describe, it, expect } from "vitest"
import { buildApiMarkdown } from "./api-markdown"
import { V2_BASE_URL, v2DocsRegistry } from "./registry"

const md = buildApiMarkdown(v2DocsRegistry, V2_BASE_URL)

describe("buildApiMarkdown", () => {
  it("starts with the title and names the base URL", () => {
    expect(md.startsWith("# Datagod Developer API (v2)")).toBe(true)
    expect(md).toContain(V2_BASE_URL)
  })

  it("has one heading per endpoint", () => {
    for (const e of v2DocsRegistry.flatMap((s) => s.endpoints)) expect(md).toContain(`### ${e.method} ${e.path}`)
    expect(md).toContain("### POST /data/purchase")
  })

  it("has the params table and every error message of /data/purchase", () => {
    const ep = v2DocsRegistry.flatMap((s) => s.endpoints).find((e) => e.path === "/data/purchase")!
    expect(md).toMatch(/\| reference \|/)
    for (const err of ep.errors) expect(md).toContain(err.message)
  })

  it("includes the testing failure numbers and section intros", () => {
    expect(md).toContain("0240000404")
    expect(md).toContain("0240000202")
    for (const id of ["overview", "authentication", "idempotency"]) {
      const s = v2DocsRegistry.find((x) => x.id === id)!
      expect(md).toContain(s.intro!)
    }
  })

  it("has no undefined or [object Object]", () => {
    expect(md).not.toContain("undefined")
    expect(md).not.toContain("[object Object]")
  })
})
