import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

// The docs registry (browser components) imports values from endpoints/data.ts, so the request-path guard must stay
// free of server-only modules: no service-role store, no node:crypto, no Supabase client.
describe("spend-guard is browser-safe", () => {
  it("spend-guard.ts imports only access constants and types", () => {
    const src = readFileSync("lib/api-v2/spend-guard.ts", "utf8")
    const imports = [...src.matchAll(/^import\s+(type\s+)?[^"]*"([^"]+)"/gm)].map((m) => ({ typeOnly: !!m[1], from: m[2] }))
    for (const i of imports) {
      if (!i.typeOnly) expect(["./access"]).toContain(i.from)
    }
    expect(src).not.toMatch(/node:crypto|supabase|\.\/store/)
  })
  it("endpoints/data.ts never imports the server spend module or node:crypto", () => {
    const src = readFileSync("lib/api-v2/endpoints/data.ts", "utf8")
    expect(src).not.toMatch(/from "\.\.\/spend"/)
    expect(src).not.toMatch(/node:crypto/)
  })
})
