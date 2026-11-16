import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

function findRoutes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return findRoutes(p)
    return name === "route.ts" ? [p] : []
  })
}

const files = findRoutes(join(process.cwd(), "app", "api", "v1"))

describe("every v1 route is gated by withV1Retirement", () => {
  it("finds all 13 route files", () => {
    expect(files).toHaveLength(13)
  })
  for (const f of files) {
    it(`gates ${f.split("v1")[1]}`, () => {
      const src = readFileSync(f, "utf8")
      expect(src).toMatch(/import\s*\{[^}]*withV1Retirement[^}]*\}\s*from\s*"@\/lib\/api-v1\/with-retirement"/)
      expect(src).not.toMatch(/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/)
      const exports = [...src.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*([^\n]*)/g)]
      expect(exports.length).toBeGreaterThan(0)
      for (const m of exports) expect(m[2]).toMatch(/^withV1Retirement\(/)
    })
  }
})
