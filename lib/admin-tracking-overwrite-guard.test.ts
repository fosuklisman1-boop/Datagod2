// Admin status edits mirror the chosen status onto mtn_fulfillment_tracking rows. Those rows include
// FAILED_INIT_<ts> placeholders: synthetic logs of a provider call that failed before an order existed.
// The status-sync crons deliberately skip FAILED_INIT rows, so overwriting one with "processing" leaves it
// stuck forever (64 Sykes rows stuck since 2026-10-22/23 after admin bulk updates). Every tracking update
// in these admin routes must exclude placeholder rows.
import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"

const FILES = [
  "app/api/admin/orders/bulk-update-status/route.ts",
  "app/api/admin/shop-orders/update-status/route.ts",
]
const GUARD = '.not("mtn_order_id", "like", "FAILED_INIT_%")'

/** Each `.from("mtn_fulfillment_tracking")` chain that contains `.update(`, cut at the next blank line or statement start. */
function trackingUpdateStatements(src: string): string[] {
  const out: string[] = []
  let i = src.indexOf('.from("mtn_fulfillment_tracking")')
  while (i !== -1) {
    const stmt = src.slice(i, i + 700)
    const end = stmt.search(/\n\s*\n|\n\s*(if|const|let|console|return|try|\})\b/)
    const body = end === -1 ? stmt : stmt.slice(0, end)
    if (body.includes(".update(")) out.push(body)
    i = src.indexOf('.from("mtn_fulfillment_tracking")', i + 1)
  }
  return out
}

describe("admin status edits never rewrite FAILED_INIT placeholder tracking rows", () => {
  for (const f of FILES) {
    it(`${f}: every tracking update excludes FAILED_INIT_ rows`, () => {
      const src = readFileSync(join(process.cwd(), f), "utf8")
      const stmts = trackingUpdateStatements(src)
      expect(stmts.length).toBeGreaterThan(0)
      for (const s of stmts) expect(s, s.slice(0, 200)).toContain(GUARD)
    })
  }

  it("bulk-update-status covers all five order kinds", () => {
    const src = readFileSync(join(process.cwd(), FILES[0]), "utf8")
    expect(trackingUpdateStatements(src)).toHaveLength(5)
  })
})
