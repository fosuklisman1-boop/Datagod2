// Guard: every dashboard session route is either gated by a capability or explicitly ungated with a reason.
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { GATED_ROUTES, UNGATED_SESSION_ROUTES } from "./capability-routes"

const API = path.join(process.cwd(), "app", "api")
const EXCLUDED = ["admin", "v1", "v2", "cron", "webhook", "webhooks", "public"]

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name === "route.ts") out.push(p)
  }
  return out
}
const rel = (f: string) => path.relative(API, path.dirname(f)).split(path.sep).join("/")
const routes = walk(API).filter((f) => !EXCLUDED.includes(rel(f).split("/")[0]))

describe("capability route guard", () => {
  const session = routes.filter((f) => {
    const s = fs.readFileSync(f, "utf8")
    return s.includes("auth.getUser(") || s.includes("authenticate(request")
  })

  it("finds session routes", () => expect(session.length).toBeGreaterThan(20))

  it("every session route is in exactly one map", () => {
    const bad: string[] = []
    for (const f of session) {
      const k = rel(f)
      const n = (k in GATED_ROUTES ? 1 : 0) + (k in UNGATED_SESSION_ROUTES ? 1 : 0)
      if (n !== 1) bad.push(`${k} (in ${n} maps)`)
    }
    expect(bad).toEqual([])
  })

  it("gated files call requireCapability with their capability", () => {
    const bad: string[] = []
    for (const [k, cap] of Object.entries(GATED_ROUTES)) {
      const f = path.join(API, k, "route.ts")
      if (!fs.existsSync(f)) { bad.push(`${k} missing`); continue }
      const s = fs.readFileSync(f, "utf8")
      if (!s.includes("requireCapability(") || !s.includes(`"${cap}"`)) bad.push(k)
    }
    expect(bad).toEqual([])
  })

  it("every map key exists on disk and ungated reasons are non-empty", () => {
    for (const k of [...Object.keys(GATED_ROUTES), ...Object.keys(UNGATED_SESSION_ROUTES)])
      expect(fs.existsSync(path.join(API, k, "route.ts")), k).toBe(true)
    for (const [k, r] of Object.entries(UNGATED_SESSION_ROUTES)) expect(r.trim().length, k).toBeGreaterThan(5)
  })
})
