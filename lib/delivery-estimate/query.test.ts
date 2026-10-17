import { describe, it, expect, beforeEach } from "vitest"
import { channelForNetwork, clearConfirmCache, clearPublicCache, getCachedChannelEstimate, getDeliveryEstimates, getPublicDeliveryEstimates, pickC, pickP } from "./query"

const t = (m: number) => new Date(Date.UTC(2026, 9, 17, 12, m)).toISOString()

describe("pickC", () => {
  it("is the most recently PLACED completed order, not the one that finished last", () => {
    const straggler = { createdAt: t(0), completedAt: t(50) } // placed long ago, resolved late
    const recent = { createdAt: t(40), completedAt: t(42) }
    expect(pickC([straggler, null, recent])).toBe(recent)
    expect(pickC([null, null])).toBeNull()
  })
})

describe("pickP", () => {
  const c = { createdAt: t(10), completedAt: t(30) }
  it("is the oldest open order placed at or after C was placed (anchored to placement, not completion)", () => {
    const sibling = { createdAt: t(11) } // placed before C finished: must still count
    const later = { createdAt: t(35) }
    expect(pickP(c, [later, sibling])).toBe(sibling)
    expect(pickP(c, [{ createdAt: t(10) }])).toEqual({ createdAt: t(10) })
  })
  it("ignores real backlog placed before C", () => {
    expect(pickP(c, [{ createdAt: t(5) }, null])).toBeNull()
  })
})

describe("channelForNetwork", () => {
  it("maps stored spellings to channels and leaves bare AT out", () => {
    expect(channelForNetwork("MTN")).toBe("mtn")
    expect(channelForNetwork("AT-iShare")).toBe("at_ishare")
    expect(channelForNetwork("at - bigtime")).toBe("at_bigtime")
    expect(channelForNetwork("AirtelTigo")).toBeNull()
  })
})

// Minimal PostgREST stand-in: records each query and resolves from `answer(table, filters)`.
function fakeDb(answer: (table: string, f: Record<string, unknown>) => unknown, opts: { overrides?: unknown[]; overridesError?: string; failTable?: string } = {}) {
  const calls: Array<{ table: string; f: Record<string, unknown> }> = []
  const db = {
    from(table: string) {
      const f: Record<string, unknown> = {}
      if (table === "delivery_channel_overrides") {
        return { select: async () => (opts.overridesError ? { data: null, error: { message: opts.overridesError } } : { data: opts.overrides ?? [], error: null }) }
      }
      const q: any = {
        select: (cols: string) => { f.select = cols; return q },
        eq: (k: string, v: unknown) => { f[`eq:${k}`] = v; return q },
        in: (k: string, v: unknown) => { f[`in:${k}`] = v; return q },
        ilike: (k: string, v: unknown) => { f[`ilike:${k}`] = v; return q },
        or: (v: string) => { f.or = v; return q },
        gte: (k: string, v: unknown) => { f[`gte:${k}`] = v; return q },
        order: (k: string, o: { ascending: boolean }) => { f.order = `${k}:${o.ascending ? "asc" : "desc"}`; return q },
        limit: () => q,
        maybeSingle: async () => {
          calls.push({ table, f })
          if (table === opts.failTable) return { data: null, error: { message: "boom" } }
          return { data: answer(table, f) ?? null, error: null }
        },
      }
      return q
    },
  }
  return { db: db as any, calls }
}

describe("getDeliveryEstimates", () => {
  const NOW = t(60)

  it("finds C and P per channel across tables and computes the estimate", async () => {
    const { db, calls } = fakeDb((table, f) => {
      const mtn = f["ilike:network"] === "mtn"
      if (!mtn) return null
      if (f["eq:status"] === "completed" || f["eq:order_status"] === "completed") {
        return table === "orders" ? { created_at: t(20), updated_at: t(28) } : table === "ussd_orders" ? { created_at: t(30), updated_at: t(36) } : null
      }
      return table === "shop_orders" ? { created_at: t(31) } : null
    })
    const rows = await getDeliveryEstimates(db, NOW)
    const mtn = rows.find(r => r.channel === "mtn")!
    // C is the ussd_orders row (placed latest); P is the open shop order placed after it.
    expect(mtn.lastOrder).toEqual({ createdAt: t(30), completedAt: t(36) })
    expect(mtn.openSince).toBe(t(31))
    expect(mtn.state).toBe("live")
    expect(rows.find(r => r.channel === "telecel")!.state).toBe("no_data")
    // P lookups are anchored to C's created_at and only count paid, in-flight rows.
    const pShop = calls.find(c => c.table === "shop_orders" && c.f["in:order_status"] && c.f["ilike:network"] === "mtn")!
    expect(pShop.f).toMatchObject({ "gte:created_at": t(30), "in:order_status": ["pending", "processing"], "eq:payment_status": "completed", order: "created_at:asc" })
  })

  it("utility reads the bill orders table (paid only) and no network filter", async () => {
    const { db, calls } = fakeDb(table => (table === "hubtel_bill_orders" ? { created_at: t(50), updated_at: t(51) } : null))
    const rows = await getDeliveryEstimates(db, NOW)
    expect(rows.find(r => r.channel === "utility")).toMatchObject({ state: "live", label: "Utility Bills" })
    const bill = calls.filter(c => c.table === "hubtel_bill_orders")
    expect(bill.every(c => c.f["eq:payment_status"] === "paid" && !c.f["ilike:network"] && !c.f.or)).toBe(true)
  })

  it("standard bundles read hubtel_data_orders (paid only) with no network filter", async () => {
    const { db, calls } = fakeDb(table => (table === "hubtel_data_orders" ? { created_at: t(55), updated_at: t(56) } : null))
    const rows = await getDeliveryEstimates(db, NOW)
    expect(rows.find(r => r.channel === "standard")).toMatchObject({ state: "live", label: "Standard Bundles" })
    const sb = calls.filter(c => c.table === "hubtel_data_orders")
    expect(sb.length).toBe(2)
    expect(sb.every(c => c.f["eq:payment_status"] === "paid" && !c.f["ilike:network"] && !c.f.or)).toBe(true)
  })

  it("matches every AT-iShare spelling", async () => {
    const { db, calls } = fakeDb(() => null)
    await getDeliveryEstimates(db, NOW)
    expect(calls.some(c => c.f.or === "network.ilike.at - ishare,network.ilike.ishare,network.ilike.at-ishare")).toBe(true)
  })

  it("a channel marked down is not queried and shows its frozen numbers", async () => {
    const frozen = { lastOrder: { createdAt: t(1), completedAt: t(3) }, lastOrderSeconds: 120, currentSeconds: 300 }
    const { db, calls } = fakeDb(() => null, { overrides: [{ channel: "mtn", is_manually_down: true, reason: "Supplier issue", since: t(40), frozen }] })
    const rows = await getDeliveryEstimates(db, NOW)
    expect(rows.find(r => r.channel === "mtn")).toMatchObject({ state: "down", currentSeconds: 300, strength: { percent: 0 }, headline: null })
    expect(calls.some(c => c.f["ilike:network"] === "mtn")).toBe(false)
  })

  it("a missing overrides table reads as nothing overridden", async () => {
    const { db } = fakeDb(() => null, { overridesError: "relation does not exist" })
    expect((await getDeliveryEstimates(db, NOW)).every(r => r.state === "no_data")).toBe(true)
  })
})

describe("getCachedChannelEstimate", () => {
  beforeEach(() => clearConfirmCache())
  const ms = Date.parse(t(60))

  it("caches per channel for a few minutes", async () => {
    const { db, calls } = fakeDb(table => (table === "orders" ? { created_at: t(50), updated_at: t(52) } : null))
    await getCachedChannelEstimate(db, "mtn", ms)
    const n = calls.length
    await getCachedChannelEstimate(db, "mtn", ms + 60_000)
    expect(calls.length).toBe(n)
    await getCachedChannelEstimate(db, "mtn", ms + 4 * 60_000)
    expect(calls.length).toBeGreaterThan(n)
  })

  it("never throws: a failing lookup is null", async () => {
    const { db } = fakeDb(() => null, { failTable: "orders" })
    expect(await getCachedChannelEstimate(db, "mtn", ms)).toBeNull()
  })
})

describe("getPublicDeliveryEstimates", () => {
  beforeEach(() => clearPublicCache())
  const ms = Date.parse(t(60))

  it("shares one computation between visitors for a few seconds", async () => {
    const { db, calls } = fakeDb(table => (table === "orders" ? { created_at: t(50), updated_at: t(52) } : null))
    const [a, b] = await Promise.all([getPublicDeliveryEstimates(db, ms), getPublicDeliveryEstimates(db, ms + 1000)])
    expect(a).toBe(b)
    const n = calls.length
    await getPublicDeliveryEstimates(db, ms + 10_000)
    expect(calls.length).toBe(n)
    await getPublicDeliveryEstimates(db, ms + 16_000)
    expect(calls.length).toBeGreaterThan(n)
  })

  it("does not cache a failure", async () => {
    const bad = fakeDb(() => null, { failTable: "orders" })
    await expect(getPublicDeliveryEstimates(bad.db, ms)).rejects.toThrow()
    const good = fakeDb(() => null)
    await expect(getPublicDeliveryEstimates(good.db, ms + 1000)).resolves.toHaveLength(6)
  })
})
