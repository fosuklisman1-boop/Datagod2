import { describe, it, expect } from "vitest"
import { aggregateForScope, type AttemptRow, type NumberRow } from "./user-view"

const nums = (m: Record<string, string>) =>
  new Map<string, NumberRow>(Object.entries(m).map(([phone, status]) => [phone, { status }]))

describe("aggregateForScope", () => {
  it("counts only the attempts passed in (one shop view of a shared number)", () => {
    const shopA: AttemptRow[] = [
      { phone: "0241111111", surface: "storefront", product: "MTN 1GB", created_at: "2026-11-10T10:00:00Z" },
      { phone: "0241111111", surface: "ussd_hubtel_shop", product: "MTN 2GB", created_at: "2026-11-12T10:00:00Z" },
    ]
    const rows = aggregateForScope(shopA, nums({ "0241111111": "blocked" }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      phone: "0241111111",
      firstTried: "2026-11-10T10:00:00Z",
      lastTried: "2026-11-12T10:00:00Z",
      attempts: 2,
      status: "waiting",
    })
    expect([...rows[0].products].sort()).toEqual(["MTN 1GB", "MTN 2GB"])
    expect([...rows[0].surfaces].sort()).toEqual(["storefront", "ussd_hubtel_shop"])
  })

  it("maps statuses and sorts by lastTried desc", () => {
    const a = (phone: string, at: string): AttemptRow => ({ phone, surface: "dashboard", product: null, created_at: at })
    const rows = aggregateForScope(
      [a("0201", "2026-11-01T00:00:00Z"), a("0202", "2026-11-05T00:00:00Z"), a("0203", "2026-11-03T00:00:00Z"), a("0204", "2026-11-04T00:00:00Z")],
      nums({ "0201": "blocked", "0202": "allowed", "0203": "expired", "0204": "handled" })
    )
    expect(rows.map((r) => [r.phone, r.status])).toEqual([
      ["0202", "ready"],
      ["0204", "expired"],
      ["0203", "expired"],
      ["0201", "waiting"],
    ])
  })

  it("omits null products and defaults a missing number row to waiting", () => {
    const rows = aggregateForScope(
      [{ phone: "0205", surface: "api_v1", product: null, created_at: "2026-11-01T00:00:00Z" }],
      new Map()
    )
    expect(rows[0].products).toEqual([])
    expect(rows[0].status).toBe("waiting")
  })
})
