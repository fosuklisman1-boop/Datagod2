import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

// UNKNOWN_ tracking rows are stored with status "abandoned". No status poller or
// retry path may ever select that status or an UNKNOWN_ id, or an order whose
// provider outcome is unknown could be polled into failure and resent.
const root = join(__dirname, "..", "..")
const cronDir = join(root, "app", "api", "cron", "sync-mtn-status")

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...routeFiles(p))
    else if (name === "route.ts") out.push(p)
  }
  return out
}

describe("status pollers never pick up UNKNOWN_ / abandoned rows", () => {
  it("no sync-mtn-status route selects status 'abandoned'", () => {
    for (const f of routeFiles(cronDir)) {
      const src = readFileSync(f, "utf8")
      const lists = src.match(/\.in\("status",\s*\[[^\]]*\]/g) ?? []
      for (const l of lists) expect(l, f).not.toContain("abandoned")
    }
  })

  it("the main sync route also excludes UNKNOWN_% ids", () => {
    const src = readFileSync(join(cronDir, "route.ts"), "utf8")
    expect(src).toContain('.not("mtn_order_id", "like", "UNKNOWN_%")')
  })

  it("the retry claim only pulls failed/retrying/error rows", () => {
    const src = readFileSync(join(root, "lib", "mtn-fulfillment.ts"), "utf8")
    expect(src).toContain('.in("status", ["failed", "retrying", "error"]) // Only pull from retryable statuses')
  })
})
