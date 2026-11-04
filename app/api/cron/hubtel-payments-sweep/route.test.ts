// app/api/cron/hubtel-payments-sweep/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  client: { tag: "db" } as any,
  list: vi.fn(),
  confirm: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (...a: any[]) => h.confirm(...a) }))
vi.mock("@/lib/hubtel-pay/sweep", async (orig) => {
  const actual = await orig<typeof import("@/lib/hubtel-pay/sweep")>()
  return { ...actual, listDueHubtelPayments: (...a: any[]) => h.list(...a) }
})

import * as route from "./route"
const { GET } = route

const URL_ = "https://www.datagod.store/api/cron/hubtel-payments-sweep"
const req = (auth?: string) => new NextRequest(URL_, { headers: auth ? { authorization: auth } : {} })
const REF = (n: number) => n.toString(16).padStart(32, "0")

beforeEach(() => {
  h.list.mockReset(); h.confirm.mockReset()
  process.env.CRON_SECRET = "cron-secret-test"
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks(); delete process.env.CRON_SECRET })

describe("hubtel-payments-sweep cron", () => {
  it("exports only GET plus the Next config consts", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "dynamic", "maxDuration"])
    expect(route.dynamic).toBe("force-dynamic")
    expect(route.maxDuration).toBe(120)
  })

  it("no / wrong auth → 401 and nothing is read", async () => {
    for (const a of [undefined, "Bearer nope"]) {
      const res = await GET(req(a))
      expect(res.status).toBe(401)
    }
    expect(h.list).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("authorised → confirms every due row with the service client and returns counts", async () => {
    h.list.mockResolvedValue([
      { reference: REF(1), status: "pending", created_at: "2026-11-04T09:00:00.000Z" },
      { reference: REF(2), status: "confirming", created_at: "2026-11-04T09:01:00.000Z" },
      { reference: REF(3), status: "pending", created_at: "2026-11-04T09:02:00.000Z" },
    ])
    h.confirm.mockImplementation(async (r: string) => {
      if (r === REF(2)) throw new Error("boom")
      return r === REF(1) ? "fulfilled" : "pending"
    })
    const res = await GET(req("Bearer cron-secret-test"))
    expect(res.status).toBe(200)
    expect(h.list.mock.calls[0][0]).toBe(h.client)
    expect(h.list.mock.calls[0][1]).toBeInstanceOf(Date)
    expect(h.confirm.mock.calls.map((c) => c[0])).toEqual([REF(1), REF(2), REF(3)])
    expect(await res.json()).toEqual({
      processed: 3,
      skipped: 0,
      outcomes: { fulfilled: 1, failed: 0, pending: 1, needs_review: 0, ignored: 0, error: 1 },
    })
  })

  it("the row query failing → 500, nothing confirmed", async () => {
    h.list.mockRejectedValue(new Error("hubtel_payments sweep query failed: timeout"))
    const res = await GET(req("Bearer cron-secret-test"))
    expect(res.status).toBe(500)
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("is listed in crons.json every 5 minutes as a fulfillment-class (batch C) job", async () => {
    const cfg = JSON.parse(readFileSync(join(process.cwd(), "lib/cron-migration/crons.json"), "utf8"))
    const entries = cfg.crons.filter((c: any) => c.path === "/api/cron/hubtel-payments-sweep")
    expect(entries).toEqual([{ path: "/api/cron/hubtel-payments-sweep", schedule: "*/5 * * * *" }])
    const { buildJobSpecs } = await import("@/lib/cron-migration/jobs")
    const [spec] = buildJobSpecs(entries, "https://www.datagod.store")
    expect(spec).toMatchObject({ batch: "C", fulfillment: true })
  })
})
