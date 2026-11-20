// Guard: the supplier cost (public.package_costs / cost_price) is admin-only. Nothing outside the admin routes, admin pages
// and the admin-only helpers listed below may mention it, so it cannot leak into a public or dealer-facing response.
import { describe, it, expect, beforeAll } from "vitest"
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

type Scanned = { rel: string; text: string }

// The three rules as pure functions over an in-memory file list, so they can also be proven against a fixture.
const outsideAdmin = (files: Scanned[]) =>
  files
    .filter((f) => !f.rel.startsWith("app/api/admin/") && !f.rel.startsWith("app/admin/"))
    .filter((f) => !isTest(f.rel) && !ALLOW.has(f.rel))
    .filter((f) => PATTERN.test(f.text))
    .map((f) => f.rel)
const publicRoutes = (files: Scanned[]) =>
  files
    .filter((f) => f.rel.startsWith("app/api/") && !f.rel.startsWith("app/api/admin/"))
    .filter((f) => PATTERN.test(f.text))
    .map((f) => f.rel)
const adminRouteHits = (files: Scanned[]) =>
  files
    .filter((f) => f.rel.startsWith("app/api/admin/") && !isTest(f.rel))
    .filter((f) => PATTERN.test(f.text))
    .map((f) => f.rel)
    .sort()

const TEST_TIMEOUT = 30_000

describe("package cost stays admin-only", () => {
  // The tree is walked and every file read exactly once; each test then filters the cached list.
  let files: Scanned[] = []
  beforeAll(() => {
    const scanRoots = ["app", "lib", "components", "hooks"].map((d) => join(ROOT, d)).filter((d) => {
      try { return statSync(d).isDirectory() } catch { return false }
    })
    files = scanRoots
      .flatMap((d) => walk(d))
      .map((abs) => ({ rel: relative(ROOT, abs).split(sep).join("/"), text: readFileSync(abs, "utf8") }))
  }, 60_000)

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(100)
  }, TEST_TIMEOUT)

  it("no file outside app/api/admin and app/admin mentions package_costs or cost_price", () => {
    expect(outsideAdmin(files)).toEqual([])
  }, TEST_TIMEOUT)

  it("no public route (app/api outside app/api/admin) mentions it, tests included", () => {
    expect(publicRoutes(files)).toEqual([])
  }, TEST_TIMEOUT)

  it("the only app/api/admin routes touching it are the packages and role price routes", () => {
    expect(adminRouteHits(files)).toEqual(["app/api/admin/packages/route.ts", "app/api/admin/roles/[id]/prices/route.ts"])
  }, TEST_TIMEOUT)

  it("the rules still catch a real violation (fixture)", () => {
    const fixture: Scanned[] = [
      { rel: "lib/pricing/leak.ts", text: "select('id, cost_price')" },
      { rel: "app/api/user/packages/route.ts", text: "from('package_costs')" },
      { rel: "app/api/admin/other/route.ts", text: "cost_price" },
      { rel: "lib/ok.ts", text: "nothing here" },
    ]
    expect(outsideAdmin(fixture)).toEqual(["lib/pricing/leak.ts", "app/api/user/packages/route.ts"])
    expect(publicRoutes(fixture)).toEqual(["app/api/user/packages/route.ts"])
    expect(adminRouteHits(fixture)).toEqual(["app/api/admin/other/route.ts"])
  }, TEST_TIMEOUT)
})
