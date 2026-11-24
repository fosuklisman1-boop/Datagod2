import { describe, it, expect, vi } from "vitest"
import { shapeDeveloperList, shapeProfile, listDevelopers, getDeveloperProfile } from "./developers"
import { listServices } from "./services"
import { listAnnouncements } from "./announcements"
import { callRead, NOT_SET_UP } from "./read-common"
import { groupReport, shapeReportRows } from "./report"
import { shapeStats } from "@/lib/api-v2/admin-stats"

const UID = "11111111-1111-4111-8111-111111111111"

function rpcClient(data: unknown, error: unknown = null) {
  const rpc = vi.fn(async (..._a: unknown[]) => ({ data, error }))
  return { rpc, client: { rpc, from: () => { throw new Error("no from") } } as never }
}

function fromClient(res: { data: unknown; error: unknown }) {
  const calls: string[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: () => chain, order: () => chain, limit: () => chain, eq: () => chain, gte: () => chain, lt: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then: (a: any, b: any) => Promise.resolve(res).then(a, b),
  }
  return { calls, client: { rpc: async () => ({ data: null, error: null }), from: (t: string) => { calls.push(t); return chain } } as never }
}

describe("shapeDeveloperList", () => {
  it("missing optional fields do not throw; success rate null when requests 0", () => {
    const out = shapeDeveloperList({ total: 2, items: [{ user_id: UID }, { user_id: "u2", first_name: "Ama", last_name: "Mensah", requests: 10, ok: 9, failed: 1, spent: "12.5", orders: 3, keys_active: 1, paused: true, granted: true }, null, 5] })
    expect(out.total).toBe(2)
    expect(out.items[0]).toMatchObject({ userId: UID, name: null, requests: 0, successRate: null, paused: false, granted: false })
    expect(out.items[1]).toMatchObject({ name: "Ama Mensah", successRate: 90, spent: 12.5, paused: true, granted: true, keysActive: 1 })
    expect(out.items).toHaveLength(2)
    expect(shapeDeveloperList(null)).toEqual({ total: 0, items: [] })
  })
})

describe("shapeProfile", () => {
  it("recipient phone 0241234567 -> ******4567; no key hash or full phone anywhere in the shaped object (JSON.stringify scan)", () => {
    const p = shapeProfile({
      user: { id: UID, first_name: "Ama", last_name: null, email: "a@x.com", role: "dealer", is_suspended: false },
      totals: { requests: 5, ok: 5, failed: 0, spent: 10, orders: 2, pending: 0 },
      daily: [{ day: "2026-11-23", requests: 5, ok: 5, failed: 0, revenue: 10 }],
      keys: [{ id: "k1", key_type: "live", environment: "live", status: "active", name: "Main", key_prefix: "dg_live_ab", key_hash: "deadbeef", created_at: "2026-11-01", last_used_at: null, activity: {} }],
      orders: [{ reference: "R1", network: "MTN", volume_gb: 1, price: 5, status: "completed", created_at: "2026-11-23", recipient_phone: "0241234567" }],
      grant: null,
      pause: { paused_at: "2026-11-23", paused_by: "admin", reason: "Abuse" },
      audit: [{ action: "api_developer_pause", admin_id: "a", created_at: "2026-11-23", reason: "Abuse" }],
    })
    expect(p).not.toBeNull()
    expect(p!.orders[0].recipientPhone).toBe("******4567")
    const json = JSON.stringify(p)
    expect(json).not.toContain("0241234567")
    expect(json).not.toContain("deadbeef")
    expect(json).not.toContain("key_hash")
    expect(p!.user.name).toBe("Ama")
    expect(p!.pause).toMatchObject({ reason: "Abuse" })
  })
  it("short phones are fully masked; null/garbage profile -> null", () => {
    const p = shapeProfile({ user: { id: UID }, orders: [{ recipient_phone: "1234" }] })
    expect(p!.orders[0].recipientPhone).toBe("****")
    expect(shapeProfile(null)).toBeNull()
    expect(shapeProfile({})).toBeNull()
  })
})

describe("callRead", () => {
  it('rpc "function does not exist" (migration not applied) -> 500 "Not set up yet" with a clear message, not a stack', async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    for (const err of [{ code: "42883", message: "function public.api_v2_developers does not exist" }, { code: "PGRST202", message: "Could not find the function public.api_v2_developers" }]) {
      const { client } = rpcClient(null, err)
      const r = await callRead(client, "api_v2_developers", {})
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.result.status).toBe(500)
      expect(r.result.body).toEqual(NOT_SET_UP)
      expect(JSON.stringify(r.result.body)).not.toContain("public.api_v2")
    }
    const { client } = rpcClient(null, { code: "57014", message: "canceling statement due to statement timeout" })
    const r = await callRead(client, "api_v2_developers", {})
    if (r.ok) throw new Error("expected error")
    expect(r.result.status).toBe(500)
    expect(JSON.stringify(r.result.body)).not.toContain("statement")
    spy.mockRestore()
  })
})

describe("listDevelopers / getDeveloperProfile", () => {
  it("q longer than 60 characters is truncated; page negative -> 0; 25 per page", async () => {
    const { client, rpc } = rpcClient({ total: 0, items: [] })
    await listDevelopers(client, { q: "x".repeat(80), page: -3, now: new Date("2026-11-24T00:00:00Z") })
    const args = rpc.mock.calls[0][1] as Record<string, unknown>
    expect(rpc.mock.calls[0][0]).toBe("api_v2_developers")
    expect((args.p_search as string).length).toBe(60)
    expect(args.p_offset).toBe(0)
    expect(args.p_limit).toBe(25)
    await listDevelopers(client, { q: "  ", page: 2, now: new Date() })
    expect((rpc.mock.calls[1][1] as Record<string, unknown>).p_search).toBeNull()
    expect((rpc.mock.calls[1][1] as Record<string, unknown>).p_offset).toBe(50)
  })
  it("profile: bad uuid -> 400 with no rpc; unknown user (SQL null) -> 404", async () => {
    const { client, rpc } = rpcClient(null)
    expect((await getDeveloperProfile(client, "nope", new Date())).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
    expect((await getDeveloperProfile(client, UID, new Date())).status).toBe(404)
  })
})

describe("listServices", () => {
  it("returns 7 services even when a controls row is missing (defaults to not paused, flagged)", async () => {
    const { client } = fromClient({ data: [{ service: "data", paused: true, message: "Back at 3", updated_at: "2026-11-23", updated_by: "a" }, { service: "bogus", paused: true }], error: null })
    const r = await listServices(client)
    expect(r.status).toBe(200)
    const items = (r.body as { services: { id: string; paused: boolean; missing: boolean; message: string | null }[] }).services
    expect(items).toHaveLength(7)
    expect(items.find((s) => s.id === "data")).toMatchObject({ paused: true, missing: false, message: "Back at 3" })
    expect(items.find((s) => s.id === "sms")).toMatchObject({ paused: false, missing: true })
    expect(items.some((s) => s.id === "bogus")).toBe(false)
  })
  it("table missing -> Not set up yet", async () => {
    const { client } = fromClient({ data: null, error: { code: "42P01", message: 'relation "api_v2_service_controls" does not exist' } })
    const r = await listServices(client)
    expect(r.status).toBe(500)
    expect(r.body).toEqual(NOT_SET_UP)
  })
})

describe("listAnnouncements (admin)", () => {
  it("lists every announcement with its state relative to now", async () => {
    const { client } = fromClient({
      data: [
        { id: "a", title: "Now", body: "b", severity: "info", starts_at: "2026-11-23T00:00:00Z", ends_at: "2026-11-25T00:00:00Z", created_at: "x", updated_at: "x" },
        { id: "b", title: "Later", body: "b", severity: "warning", starts_at: "2026-12-01T00:00:00Z", ends_at: "2026-12-02T00:00:00Z" },
        { id: "c", title: "Done", body: "b", severity: "critical", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-02T00:00:00Z" },
      ],
      error: null,
    })
    const r = await listAnnouncements(client, new Date("2026-11-24T00:00:00Z"))
    const items = (r.body as { announcements: { id: string; state: string }[] }).announcements
    expect(items.map((a) => [a.id, a.state])).toEqual([["a", "active"], ["b", "scheduled"], ["c", "ended"]])
  })
})

describe("money cross-check", () => {
  it("the report's revenue total equals the stats revenue for the same orders (shared money rule)", () => {
    // The same three counted orders (status not failed/refunded, v2 key) as both RPCs would see them.
    const orders = [{ price: 12.5, network: "MTN" }, { price: 7.25, network: "Telecel" }, { price: 30, network: "MTN" }]
    const statsRevenue = orders.reduce((s, o) => s + o.price, 0)
    const stats = shapeStats({ revenue: statsRevenue, revenue_lifetime: statsRevenue }, null)
    const report = shapeReportRows([
      { month: "2026-11", user_id: "u1", developer: "A", product: "MTN", orders: 2, revenue: 42.5, costed_orders: 0, costed_revenue: 0, cost_total: 0 },
      { month: "2026-11", user_id: "u1", developer: "A", product: "Telecel", orders: 1, revenue: 7.25, costed_orders: 0, costed_revenue: 0, cost_total: 0 },
    ])
    const total = groupReport(report.rows, "month").reduce((s, g) => s + g.revenue, 0)
    expect(total).toBe(stats.revenue24h)
  })
})
