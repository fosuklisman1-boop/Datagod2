// Admin console read routes: non-admins get the auth response; the CRON_SECRET path (admin, no user id) may read;
// the report sets no-store and, for csv, an attachment; files export only handlers.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const UID = "11111111-1111-4111-8111-111111111111"
const h = vi.hoisted(() => ({
  admin: true,
  adminId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | undefined,
  rpcData: {} as Record<string, unknown>,
  rpcError: null as unknown,
  fromRows: {} as Record<string, unknown[]>,
  rpc: vi.fn(),
}))

vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: async () =>
    h.admin
      ? { isAdmin: true, userId: h.adminId, errorResponse: null }
      : { isAdmin: false, errorResponse: NextResponse.json({ error: "Forbidden" }, { status: 403 }) },
}))
vi.mock("@/lib/api-v2/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-v2/store")>("@/lib/api-v2/store")
  return {
    ...actual,
    getAdminClient: () => ({
      rpc: async (fn: string, args: unknown) => {
        h.rpc(fn, args)
        return { data: h.rpcData[fn] ?? null, error: h.rpcError }
      },
      from: (table: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chain: any = {
          select: () => chain, order: () => chain, limit: () => chain, eq: () => chain, gte: () => chain, lt: () => chain,
          maybeSingle: async () => ({ data: (h.fromRows[table] ?? [])[0] ?? null, error: null }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          then: (a: any, b: any) => Promise.resolve({ data: h.fromRows[table] ?? [], error: null }).then(a, b),
        }
        return chain
      },
    }),
  }
})

import { GET as devList } from "./developers/route"
import { GET as devProfile } from "./developers/[userId]/route"
import { GET as servicesList } from "./services/route"
import { GET as annList } from "./announcements/route"
import { GET as trend } from "./trend/route"
import { GET as report } from "./report/route"
import { GET as devSpend } from "./developers/[userId]/spend-cap/route"
import { GET as moneyGet } from "./money-settings/route"

const req = (url = "http://x/") => ({ url, nextUrl: new URL(url), headers: new Headers() }) as never
const ctx = (p: Record<string, string>): never => ({ params: Promise.resolve(p) }) as never

beforeEach(() => {
  h.admin = true
  h.adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  h.rpcData = {
    api_v2_developers: { total: 1, items: [{ user_id: UID, first_name: "Ama" }] },
    api_v2_developer_profile: { user: { id: UID }, orders: [{ recipient_phone: "0241234567" }] },
    api_v2_overview_trend: [{ day: "2026-11-23", requests: 5, ok: 5, failed: 0, revenue: 10 }],
    api_v2_business_report: [
      { month: "2026-11", user_id: UID, developer: "=HYPERLINK(1)", email: null, product: "MTN", orders: 2, revenue: 20, costed_orders: 2, costed_revenue: 20, cost_total: 15 },
    ],
  }
  h.rpcError = null
  h.fromRows = { api_v2_idempotency: [{ kind: "airtime", created_at: "2026-11-02T10:00:00Z" }, { kind: "airtime", created_at: "2026-11-03T10:00:00Z" }, { kind: "bill", created_at: "2026-10-05T10:00:00Z" }] }
  h.rpc.mockReset()
})

const all: [string, () => Promise<Response | null | undefined>][] = [
  ["developers", () => devList(req("http://x/?q=ama"))],
  ["profile", () => devProfile(req(), ctx({ userId: UID }))],
  ["services", () => servicesList(req())],
  ["announcements", () => annList(req())],
  ["trend", () => trend(req())],
  ["report", () => report(req())],
  ["developer spend", () => devSpend(req(), ctx({ userId: UID }))],
  ["money settings", () => moneyGet(req())],
]

describe("console read routes", () => {
  it("all console reads reject non-admin", async () => {
    h.admin = false
    for (const [, call] of all) expect((await call())!.status).toBe(403)
    expect(h.rpc).not.toHaveBeenCalled()
  })
  it("CRON path (admin, no user id) may read", async () => {
    h.adminId = undefined
    for (const [name, call] of all) expect([name, (await call())!.status]).toEqual([name, 200])
  })
  it("developers route: q longer than 60 characters is truncated; page negative -> 0", async () => {
    await devList(req(`http://x/?q=${"y".repeat(90)}&page=-4`))
    const args = h.rpc.mock.calls[0][1] as Record<string, unknown>
    expect((args.p_search as string).length).toBe(60)
    expect(args.p_offset).toBe(0)
  })
  it("profile masks phones", async () => {
    const body = await (await devProfile(req(), ctx({ userId: UID })))!.json()
    expect(JSON.stringify(body)).not.toContain("0241234567")
    expect(body.profile.orders[0].recipientPhone).toBe("******4567")
  })
  it("trend: days is a closed set (7, 30, 90; default 30)", async () => {
    await trend(req("http://x/?days=9999"))
    const since = Date.parse((h.rpc.mock.calls[0][1] as { p_since: string }).p_since)
    expect(Math.round((Date.now() - since) / 86400_000)).toBe(30)
    await trend(req("http://x/?days=90"))
    const since90 = Date.parse((h.rpc.mock.calls[1][1] as { p_since: string }).p_since)
    expect(Math.round((Date.now() - since90) / 86400_000)).toBe(90)
  })
  it("report: JSON with groups, other products counted not valued, and no-store", async () => {
    const res = (await report(req("http://x/?from=2026-10-01&to=2026-11-30&by=product")))!
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.json()
    expect(body.groups[0]).toMatchObject({ key: "MTN", revenue: 20, profit: { kind: "full", profit: 5 } })
    expect(body.other).toEqual([
      { month: "2026-10", product: "Utility bills", orders: 1 },
      { month: "2026-11", product: "Airtime", orders: 2 },
    ])
    expect(body.otherRevenue).toBe("not tracked")
  })
  it("report route sets no-store and attachment for csv, with the formula guard", async () => {
    const res = (await report(req("http://x/?format=csv")))!
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-type")).toContain("text/csv")
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="api-report-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"$/)
    const text = await res.text()
    expect(text).toContain("'=HYPERLINK(1)")
  })
  it("report: 20001 rows -> 400 Narrow the range; bad range -> 400", async () => {
    h.rpcData.api_v2_business_report = Array.from({ length: 20001 }, () => (h.rpcData.api_v2_business_report as unknown[])[0])
    const res = (await report(req("http://x/?format=csv")))!
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Narrow the range/)
    expect((await report(req("http://x/?from=2020-01-01&to=2026-01-01")))!.status).toBe(400)
  })
  it('rpc "function does not exist" -> 500 Not set up yet', async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    h.rpcError = { code: "42883", message: "function public.api_v2_developers(...) does not exist" }
    const res = (await devList(req()))!
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe("not_set_up")
    spy.mockRestore()
  })
  it("route.ts files export only handlers/config", () => {
    const files = ["developers/route.ts", "developers/[userId]/route.ts", "services/route.ts", "announcements/route.ts", "trend/route.ts", "report/route.ts"]
    for (const f of files) {
      const src = readFileSync(join(__dirname, f), "utf8")
      const exported = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)].map((m) => m[1])
      for (const name of exported) expect(["GET", "POST", "PUT", "DELETE", "dynamic"]).toContain(name)
    }
  })
})
