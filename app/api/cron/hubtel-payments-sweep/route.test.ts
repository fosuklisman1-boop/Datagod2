// app/api/cron/hubtel-payments-sweep/route.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  client: { tag: "db" } as any,
  list: vi.fn(),
  confirm: vi.fn(),
  alert: vi.fn(),
  after: [] as (() => Promise<void>)[],
}))
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => { h.after.push(fn) },
}))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => h.client }))
vi.mock("@/lib/hubtel-pay/confirm", () => ({ confirmHubtelPayment: (...a: any[]) => h.confirm(...a) }))
vi.mock("@/lib/hubtel-pay/sweep", async (orig) => {
  const actual = await orig<typeof import("@/lib/hubtel-pay/sweep")>()
  return {
    ...actual,
    listDueHubtelPayments: (...a: any[]) => h.list(...a),
    sendSweepAlert: (...a: any[]) => h.alert(...a),
  }
})

import * as route from "./route"
const { GET } = route

const URL_ = "https://www.datagod.store/api/cron/hubtel-payments-sweep"
const req = (auth?: string) => new NextRequest(URL_, { headers: auth ? { authorization: auth } : {} })
const REF = (n: number) => n.toString(16).padStart(32, "0")
const drainAfter = async () => { for (const fn of h.after.splice(0)) await fn() }
const logged = (spy: any) => spy.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n")

beforeEach(() => {
  h.list.mockReset(); h.confirm.mockReset(); h.alert.mockReset(); h.after = []
  h.alert.mockResolvedValue(undefined)
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
    expect(route.maxDuration).toBe(180)
  })

  it("no / wrong auth → 401, nothing queued and nothing is read", async () => {
    for (const a of [undefined, "Bearer nope"]) {
      const res = await GET(req(a))
      expect(res.status).toBe(401)
    }
    expect(h.after).toHaveLength(0)
    expect(h.list).not.toHaveBeenCalled()
    expect(h.confirm).not.toHaveBeenCalled()
  })

  it("authorised → 202 straight away; the work runs after the response", async () => {
    h.list.mockResolvedValue([])
    const res = await GET(req("Bearer cron-secret-test"))
    expect(res.status).toBe(202)
    expect(h.after).toHaveLength(1)
    expect(h.list).not.toHaveBeenCalled()
    await drainAfter()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.alert).not.toHaveBeenCalled()
  })

  it("authorised → confirms every due row with the service client, logs the counts and alerts on the error", async () => {
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
    expect(res.status).toBe(202)
    await drainAfter()
    expect(h.list.mock.calls[0][0]).toBe(h.client)
    expect(h.list.mock.calls[0][1]).toBeInstanceOf(Date)
    expect(h.confirm.mock.calls.map((c) => c[0])).toEqual([REF(1), REF(2), REF(3)])
    const line = logged(console.log).split("\n").find((l: string) => l.startsWith("[HUBTEL-PAYMENTS-SWEEP] run: "))
    expect(JSON.parse(line.slice("[HUBTEL-PAYMENTS-SWEEP] run: ".length))).toEqual({
      processed: 3,
      skipped: 0,
      outcomes: { fulfilled: 1, failed: 0, pending: 1, needs_review: 0, ignored: 0, check_error: 0, error: 1 },
    })
    expect(h.alert).toHaveBeenCalledTimes(1)
    expect(h.alert.mock.calls[0][0]).toBe(h.client)
  })

  it("the row query failing → still 202; logged, one alert, nothing confirmed", async () => {
    h.list.mockRejectedValue(new Error("hubtel_payments sweep query failed: timeout"))
    const res = await GET(req("Bearer cron-secret-test"))
    expect(res.status).toBe(202)
    await drainAfter()
    expect(h.confirm).not.toHaveBeenCalled()
    expect(h.alert).toHaveBeenCalledTimes(1)
    expect(logged(console.error)).toContain("timeout")
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
