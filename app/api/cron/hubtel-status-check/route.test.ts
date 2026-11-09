// app/api/cron/hubtel-status-check/route.test.ts
import { describe, it, expect, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  orderHandlerArgs: [] as any[],
  statusCheckArgs: null as any,
  possiblyPaidAlerts: { kind: "possiblyPaid" },
  orderHandlers: { kind: "orderHandlers" },
  sweep: vi.fn(async (..._a: any[]): Promise<any> => ({ found: 0, fulfilled: 0, review: 0 })),
}))

vi.mock("next/server", async importOriginal => ({ ...(await importOriginal<typeof import("next/server")>()), after: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))
vi.mock("@/lib/ussd-hubtel/tx-store", () => ({ createSupabaseTxStore: () => ({}) }))
vi.mock("@/lib/ussd-hubtel/order-handlers", () => ({
  createOrderHandlers: (...a: any[]) => { h.orderHandlerArgs = a; return h.orderHandlers },
  createFailHandlers: () => ({}),
  createPaidReviewHandlers: () => ({}),
  createPossiblyPaidAlerts: () => h.possiblyPaidAlerts,
}))
vi.mock("@/lib/ussd-hubtel/status-check", () => ({ runStatusChecks: async (a: any) => { h.statusCheckArgs = a; return { checked: 0 } } }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ checkTransactionStatus: vi.fn() }))
vi.mock("@/lib/ussd-hubtel/callback-log", () => ({
  withStatusCheckLogging: () => Object.assign(vi.fn(), { flush: async () => {} }),
}))
vi.mock("@/lib/ussd-hubtel/wallet-pay", () => ({ sweepWalletPayments: h.sweep }))

import { after } from "next/server"
import { urgentAlert } from "@/lib/ussd-hubtel/special-payment"
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

describe("GET /api/cron/hubtel-status-check: wallet payment sweep", () => {
  it("runs the sweep with the order handlers, the urgent alert and the status checks' deadline, and reports it", async () => {
    h.sweep.mockClear()
    h.sweep.mockResolvedValueOnce({ found: 2, fulfilled: 1, review: 1 })
    h.statusCheckArgs = null
    const res = await GET(new NextRequest("http://localhost/api/cron/hubtel-status-check"))
    expect(res.status).toBe(200)
    expect(h.sweep).toHaveBeenCalledTimes(1)
    const [, handlers, alert, , deadlineMs] = h.sweep.mock.calls[0]
    expect(handlers).toBe(h.orderHandlers)
    expect(alert).toBe(urgentAlert)
    expect(deadlineMs).toBe(h.statusCheckArgs.deadlineMs)
    expect(await res.json()).toMatchObject({ checked: 0, walletSweep: { found: 2, fulfilled: 1, review: 1 } })
  })

  it("a sweep failure does not stop the status checks", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    h.sweep.mockRejectedValueOnce(new Error("sweep broke"))
    h.statusCheckArgs = null
    const res = await GET(new NextRequest("http://localhost/api/cron/hubtel-status-check"))
    expect(res.status).toBe(200)
    expect(h.statusCheckArgs).not.toBeNull()
    expect(await res.json()).toMatchObject({ checked: 0, walletSweep: null })
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
