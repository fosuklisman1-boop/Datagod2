// Guard: every dashboard session route is either gated by a capability or explicitly ungated with a reason.
import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { GATED_ROUTES, UNGATED_SESSION_ROUTES } from "./capability-routes"

const HELPER_GATES: Record<string, { cap: string; file: string }> = {
  "@/lib/sms/tenant-auth": { cap: "shop.sms", file: "lib/sms/tenant-auth.ts" },
}
const API =path.join(process.cwd(), "app", "api")
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
    // Any session-auth entry point: direct getUser, and the shared helpers routes authenticate through.
    return /\.getUser\(|\bauthenticate\(|\bresolveAccount\(|\bauthUserId\(|\bgetSessionUser\(/.test(s)
  })

  it("detects helper-authenticated routes (tenant SMS, text-orders)", () => {
    const keys = session.map(rel)
    expect(keys).toContain("sms/contacts")
    expect(keys).toContain("user/text-orders")
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
      // A route may gate through a shared helper that itself calls requireCapability with the same capability.
      const helper = Object.entries(HELPER_GATES).find(([imp]) => s.includes(`"${imp}"`) && s.includes("resolveAccount("))
      const helperOk = !!helper && helper[1].cap === cap &&
        (() => { const h = fs.readFileSync(path.join(process.cwd(), helper[1].file), "utf8"); return h.includes("requireCapability(") && h.includes(`"${cap}"`) })()
      if (!((s.includes("requireCapability(") && s.includes(`"${cap}"`)) || helperOk)) bad.push(k)
    }
    expect(bad).toEqual([])
  })

  it("every map key exists on disk and ungated reasons are non-empty", () => {
    for (const k of [...Object.keys(GATED_ROUTES), ...Object.keys(UNGATED_SESSION_ROUTES)])
      expect(fs.existsSync(path.join(API, k, "route.ts")), k).toBe(true)
    for (const [k, r] of Object.entries(UNGATED_SESSION_ROUTES)) expect(r.trim().length, k).toBeGreaterThan(5)
  })
})
