import { describe, it, expect } from "vitest"
import { makeFakeDb, type FakeCall } from "@/app/api/support/_fake-db"
import { clampDays, loadAdminThreadList, loadSupportOrders } from "./support-admin-data"

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

describe("clampDays", () => {
  it("defaults to 30 and clamps to 1..90", () => {
    expect(clampDays(null)).toBe(30)
    expect(clampDays("abc")).toBe(30)
    expect(clampDays("500")).toBe(90)
    expect(clampDays("0")).toBe(1)
    expect(clampDays("-5")).toBe(1)
    expect(clampDays("7")).toBe(7)
  })
})

describe("loadSupportOrders", () => {
  it("returns an empty map and runs no query for threads without orders", async () => {
    const { db, calls } = makeFakeDb(() => ({ data: [] }))
    const out = await loadSupportOrders(db as any, [{ id: uuid(1), order_id: null, shop_order_id: null }])
    expect(out.size).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it("maps orders and shop orders and resolves the supplier", async () => {
    const { db } = makeFakeDb((c) => {
      if (c.table === "orders")
        return { data: [{ id: "o1", network: "MTN", size: 2, price: 10, status: "completed", phone_number: "0241234567", order_code: "R1", created_at: "2026-11-01T00:00:00Z" }] }
      if (c.table === "shop_orders")
        return { data: [{ id: "s1", shop_id: "sh1", customer_phone: "0241234568", network: "MTN", volume_gb: 1, total_price: 5, order_status: "pending", reference_code: "R2", fulfillment_method: "manual", created_at: "2026-11-01T00:00:00Z" }] }
      if (c.table === "user_shops") return { data: [{ id: "sh1", shop_name: "Kofi Data" }] }
      if (c.table === "mtn_fulfillment_tracking")
        return { data: [{ provider: "nonexistent-provider", created_at: "2026-11-01T00:00:00Z", order_id: "o1", shop_order_id: null }] }
      return undefined
    })
    const out = await loadSupportOrders(db as any, [
      { id: "t1", order_id: "o1", shop_order_id: null },
      { id: "t2", order_id: null, shop_order_id: "s1" },
    ])
    expect(out.get("t1")?.order.reference).toBe("R1")
    expect(out.get("t1")?.supplier).toBeNull() // unknown provider is ignored, orders row has no fulfillment method
    expect(out.get("t2")?.order.shop_name).toBe("Kofi Data")
    expect(out.get("t2")?.supplier).toEqual({ kind: "manual" })
  })

  it("chunks every .in() at 200 ids for 450 threads", async () => {
    const threads = Array.from({ length: 450 }, (_, i) => ({ id: `t${i}`, order_id: uuid(i + 1), shop_order_id: null }))
    const { db, calls } = makeFakeDb((c) => {
      if (c.table !== "orders") return { data: [] }
      const ids = c.filters.find(([k]) => k === "id:in")![1] as string[]
      return { data: ids.map((id) => ({ id, status: "completed" })) }
    })
    await loadSupportOrders(db as any, threads)
    const sizes: number[] = []
    for (const c of calls) {
      for (const [k, v] of c.filters) {
        if (k.endsWith(":in")) sizes.push((v as unknown[]).length)
        if (k === "or") sizes.push(((v as string).match(/-4000-8000-/g) ?? []).length)
      }
    }
    expect(sizes.length).toBeGreaterThanOrEqual(3 + 3) // orders x3, tracking x3
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200)
    expect(calls.filter((c) => c.table === "orders")).toHaveLength(3)
  })

  it("issues at most four queries when everything fits one chunk", async () => {
    const { db, calls } = makeFakeDb((c) => (c.table === "shop_orders" ? { data: [{ id: "s1", shop_id: "sh1" }] } : { data: [] }))
    await loadSupportOrders(db as any, [
      { id: "t1", order_id: "o1", shop_order_id: null },
      { id: "t2", order_id: null, shop_order_id: "s1" },
    ])
    expect(calls).toHaveLength(4)
  })
})

describe("loadAdminThreadList", () => {
  const NOW = new Date("2026-11-12T12:00:00Z")
  const thread = (id: string, over: Record<string, unknown> = {}) => ({
    id, user_id: "u1", order_id: null, shop_order_id: null, subject: "s", status: "open",
    last_message_at: "2026-11-12T10:00:00Z", ...over,
  })

  function setup(threads: unknown[], messages: unknown[] = []) {
    let threadCall: FakeCall | undefined
    const fake = makeFakeDb((c) => {
      if (c.table === "support_threads") { threadCall = c; return { data: threads } }
      if (c.table === "users") return { data: [{ id: "u1", first_name: "A", last_name: "B", email: "a@b.c", phone_number: "0241234567" }] }
      if (c.table === "support_messages") return { data: messages }
      return { data: [] }
    })
    return { ...fake, getThreadCall: () => threadCall! }
  }

  it("status=all uses the open-or-recent filter", async () => {
    const s = setup([thread("t1")])
    await loadAdminThreadList(s.db as any, { status: "all", days: 7, now: NOW })
    const since = new Date(NOW.getTime() - 7 * 86_400_000).toISOString()
    expect(s.getThreadCall().filters).toContainEqual(["or", `status.eq.open,last_message_at.gte.${since}`])
    expect(s.getThreadCall().limitN).toBe(300)
  })

  it("status=open ignores the window; status=closed applies it", async () => {
    const open = setup([])
    await loadAdminThreadList(open.db as any, { status: "open", days: 7, now: NOW })
    expect(open.getThreadCall().filters).toEqual([["status", "open"]])
    const closed = setup([])
    await loadAdminThreadList(closed.db as any, { status: "closed", days: 7, now: NOW })
    expect(closed.getThreadCall().filters.map(([k]) => k)).toEqual(["status", "last_message_at:gte"])
  })

  it("attaches user, preview and an unread count of user messages only", async () => {
    const long = "x".repeat(500)
    const s = setup(
      [thread("t1")],
      [
        { thread_id: "t1", sender_role: "user", body: long, created_at: "3", read_by_admin_at: null },
        { thread_id: "t1", sender_role: "user", body: "old unread", created_at: "2", read_by_admin_at: null },
        { thread_id: "t1", sender_role: "user", body: "read", created_at: "1", read_by_admin_at: "2026-11-12T00:00:00Z" },
        { thread_id: "t1", sender_role: "admin", body: "reply", created_at: "0", read_by_admin_at: null },
      ],
    )
    const [row] = await loadAdminThreadList(s.db as any, { status: "open", days: 30, now: NOW })
    expect(row.unread_count).toBe(2)
    expect(row.last_message?.body).toHaveLength(140)
    expect(row.last_message?.sender_role).toBe("user")
    expect(row.user.first_name).toBe("A")
    expect(row.order).toBeNull()
  })

  it("gives threads with no messages a null last_message and zero unread", async () => {
    const s = setup([thread("t1")])
    const [row] = await loadAdminThreadList(s.db as any, { status: "open", days: 30, now: NOW })
    expect(row.last_message).toBeNull()
    expect(row.unread_count).toBe(0)
  })

  it("chunks the message query at 200 thread ids", async () => {
    const threads = Array.from({ length: 300 }, (_, i) => thread(`t${i}`))
    const s = setup(threads)
    await loadAdminThreadList(s.db as any, { status: "open", days: 30, now: NOW })
    const msgCalls = s.calls.filter((c) => c.table === "support_messages")
    expect(msgCalls).toHaveLength(2)
    for (const c of msgCalls) expect((c.filters.find(([k]) => k === "thread_id:in")![1] as unknown[]).length).toBeLessThanOrEqual(200)
  })
})
