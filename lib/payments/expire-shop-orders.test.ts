import { describe, expect, it, vi } from "vitest"
import { expireStaleShopOrders } from "./expire-shop-orders"

type Row = Record<string, any>

const inSizes: number[] = []

function fakeDb(t: { shop_orders: Row[]; wallet_payments?: Row[]; hubtel_payments?: Row[] }, opts: { hubtelError?: boolean } = {}) {
  const tables: Record<string, Row[]> = { wallet_payments: [], hubtel_payments: [], ...t }
  const db: any = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = []
      let patch: Row | null = null
      let window: [number, number] | null = null
      const q: any = {
        select: () => q, order: () => q, limit: () => q,
        range: (a: number, b: number) => ((window = [a, b + 1]), q),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        lt: (c: string, v: string) => (filters.push((r) => r[c] < v), q),
        in: (c: string, vs: unknown[]) => { inSizes.push(vs.length); filters.push((r) => vs.includes(r[c])); return q },
        update: (p: Row) => ((patch = p), q),
        then: (ok: any, ko: any) => {
          if (table === "hubtel_payments" && opts.hubtelError) return Promise.resolve({ data: null, error: { code: "XX", message: "down" } }).then(ok, ko)
          const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
          if (patch) {
            // Like the state-machine trigger: one refused row aborts the whole statement.
            if (hit.some((r) => r.order_status !== "pending")) {
              return Promise.resolve({ data: null, error: { code: "23514", message: "Invalid transition" } }).then(ok, ko)
            }
            for (const r of hit) Object.assign(r, patch)
          }
          return Promise.resolve({ data: window ? hit.slice(...window) : hit, error: null }).then(ok, ko)
        },
      }
      return q
    },
  }
  return db
}

const CUTOFF = "2026-11-06T10:00:00.000Z"
const old = (id: string, o: Row = {}) => ({ id, payment_status: "pending", order_status: "pending", created_at: "2026-11-06T09:00:00.000Z", ...o })

describe("expireStaleShopOrders", () => {
  it("expires an old unpaid order, as before", async () => {
    const shop_orders = [old("a")]
    const n = await expireStaleShopOrders(fakeDb({ shop_orders }), CUTOFF)
    expect(n).toBe(1)
    expect(shop_orders[0]).toMatchObject({ order_status: "expired", payment_status: "expired" })
  })

  // Production has 194 completed/pending rows. The trigger refuses them, and that aborted every expiry run since launch.
  it.each(["completed", "processing", "blacklisted"])("a %s order with payment pending doesn't stop the run, and is left alone", async (status) => {
    const shop_orders = [old("stuck", { order_status: status }), old("a")]
    expect(await expireStaleShopOrders(fakeDb({ shop_orders }), CUTOFF)).toBe(1)
    expect(shop_orders[0]).toMatchObject({ order_status: status, payment_status: "pending" })
    expect(shop_orders[1].order_status).toBe("expired")
  })

  it("works through a backlog in lists short enough for a URL, capped per run", async () => {
    inSizes.length = 0
    const shop_orders = Array.from({ length: 1100 }, (_, i) => old(`o${i}`))
    const n = await expireStaleShopOrders(fakeDb({ shop_orders }), CUTOFF)
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(200)
    expect(n).toBe(1000)
    expect(shop_orders.filter((o) => o.order_status === "pending")).toHaveLength(100)
  })

  it("leaves newer and paid orders alone", async () => {
    const shop_orders = [old("a", { created_at: "2026-11-06T11:00:00.000Z" }), old("b", { payment_status: "completed" })]
    expect(await expireStaleShopOrders(fakeDb({ shop_orders }), CUTOFF)).toBe(0)
    expect(shop_orders[0].order_status).toBe("pending")
    expect(shop_orders[1].order_status).toBe("pending")
  })

  it.each(["pending", "confirming", "paid", "needs_review"])("skips an order with a %s Hubtel attempt", async (status) => {
    const shop_orders = [old("a"), old("b")]
    const db = fakeDb({
      shop_orders,
      wallet_payments: [{ order_id: "a", reference: "WALLET-A" }],
      hubtel_payments: [{ reference: "f".repeat(32), internal_reference: "WALLET-A", status, amount_pesewas: 100, created_at: "2026-11-06T09:00:00Z" }],
    })
    expect(await expireStaleShopOrders(db, CUTOFF)).toBe(1)
    expect(shop_orders[0].order_status).toBe("pending")
    expect(shop_orders[1].order_status).toBe("expired")
  })

  it("a failed Hubtel attempt does not hold the order open", async () => {
    const shop_orders = [old("a")]
    const db = fakeDb({
      shop_orders,
      wallet_payments: [{ order_id: "a", reference: "WALLET-A" }],
      hubtel_payments: [{ reference: "f".repeat(32), internal_reference: "WALLET-A", status: "failed", amount_pesewas: 100, created_at: "2026-11-06T09:00:00Z" }],
    })
    expect(await expireStaleShopOrders(db, CUTOFF)).toBe(1)
  })

  it("expires nothing when the Hubtel lookup fails: the next run tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const shop_orders = [old("a")]
    expect(await expireStaleShopOrders(fakeDb({ shop_orders }, { hubtelError: true }), CUTOFF)).toBe(0)
    expect(shop_orders[0].order_status).toBe("pending")
  })
})
