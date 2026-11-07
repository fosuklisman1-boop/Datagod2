// app/api/cron/hubtel-status-check/route.test.ts
import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ orderHandlerArgs: [] as any[], statusCheckArgs: null as any, possiblyPaidAlerts: { kind: "possiblyPaid" } }))

vi.mock("next/server", async importOriginal => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@/lib/ussd-hubtel/tx-store", () => ({ createSupabaseTxStore: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/order-handlers", () => ({
  createOrderHandlers: (...a: any[]) => { h.orderHandlerArgs = a; return {} },
  createFailHandlers: () => ({}),
  createPaidReviewHandlers: () => ({}),
  createPossiblyPaidAlerts: () => h.possiblyPaidAlerts,
}))
vi.mock("@/lib/ussd-hubtel/status-check", () => ({ runStatusChecks: async (a: any) => { h.statusCheckArgs = a; return { checked: 0 } } }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ checkTransactionStatus: vi.fn() }))
vi.mock("@/lib/ussd-hubtel/callback-log", () => ({
  withStatusCheckLogging: () => Object.assign(vi.fn(), { flush: async () => {} }),
}))

import { after } from "next/server"
import { GET, maxDuration } from "./route"

describe("GET /api/cron/hubtel-status-check: Special group dispatch wiring", () => {
  it("handlers defer a group's sends with after(); the route allows the 240s dispatch budget", async () => {
    const res = await GET(new NextRequest("http://localhost/api/cron/hubtel-status-check"))
    expect(res.status).toBe(200)
    expect(h.orderHandlerArgs[1]).toEqual({ defer: after })
    expect(maxDuration).toBe(300)
  })

  it("passes the possibly-paid alerts to runStatusChecks: without them a swept Special group with no paid_at raises nothing", async () => {
    h.statusCheckArgs = null
    await GET(new NextRequest("http://localhost/api/cron/hubtel-status-check"))
    expect(h.statusCheckArgs.possiblyPaidAlerts).toBe(h.possiblyPaidAlerts)
  })
})
