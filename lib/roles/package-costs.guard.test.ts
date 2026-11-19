// Guard: the supplier cost (public.package_costs / cost_price) is admin-only. Nothing outside the admin routes, admin pages
// and the admin-only helpers listed below may mention it, so it cannot leak into a public or dealer-facing response.
import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "fs"
import { join, relative, sep } from "path"

const ROOT = process.cwd()
const PATTERN = /package_costs|cost_price/

// Files allowed to mention the cost, as root-relative posix paths. Keep this list short and admin-only.
const ALLOW = new Set<string>([
  "lib/admin-service.ts", // client helper used only by admin pages (calls /api/admin/packages)
  "lib/package-cost-form.ts", // pure helper for the admin packages form
  "lib/roles/package-costs.guard.test.ts",
  "lib/roles/migration-0187.test.ts",
  "lib/roles/migration-0187-run.ts",
])
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".superpowers", ".claude", "migrations", "docs", "mobile"])
const isTest = (p: string) => /\.test\.tsx?$/.test(p)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(full)
  }
  return out
}

describe("package cost stays admin-only", () => {
  const scanRoots = ["app", "lib", "components", "hooks"].map((d) => join(ROOT, d)).filter((d) => {
    try { return statSync(d).isDirectory() } catch { return false }
  })
  const files = scanRoots.flatMap((d) => walk(d)).map((f) => ({ abs: f, rel: relative(ROOT, f).split(sep).join("/") }))

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it("no file outside app/api/admin and app/admin mentions package_costs or cost_price", () => {
    const offenders = files
      .filter((f) => !f.rel.startsWith("app/api/admin/") && !f.rel.startsWith("app/admin/"))
      .filter((f) => !isTest(f.rel) && !ALLOW.has(f.rel))
      .filter((f) => PATTERN.test(readFileSync(f.abs, "utf8")))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it("no public route (app/api outside app/api/admin) mentions it, tests included", () => {
    const offenders = files
      .filter((f) => f.rel.startsWith("app/api/") && !f.rel.startsWith("app/api/admin/"))
      .filter((f) => PATTERN.test(readFileSync(f.abs, "utf8")))
      .map((f) => f.rel)
    expect(offenders).toEqual([])
  })

  it("the only app/api/admin routes touching it are the packages and role price routes", () => {
    const hits = files
      .filter((f) => f.rel.startsWith("app/api/admin/") && !isTest(f.rel))
      .filter((f) => PATTERN.test(readFileSync(f.abs, "utf8")))
      .map((f) => f.rel)
      .sort()
    expect(hits).toEqual(["app/api/admin/packages/route.ts", "app/api/admin/roles/[id]/prices/route.ts"])
  })
})
