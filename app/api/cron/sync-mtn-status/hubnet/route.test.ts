import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const pending: Promise<unknown>[] = []
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => { pending.push(fn()) },
}))
vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: () => ({ authorized: true }) }))

const chain: any = {}
for (const m of ["select", "eq", "in", "not", "gte", "order", "limit", "like", "update"]) chain[m] = () => chain
chain.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej)
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from: () => chain }) }))

const order: string[] = []
const configured = vi.fn(() => true)
const sweep = vi.fn(async () => { order.push("sweep"); return { seen: 0 } })
const unknown = vi.fn(async () => { order.push("unknown"); return { checked: 0, found: 0 } })
const airtime = vi.fn(async () => { order.push("airtime"); return { checked: 0, updated: 0 } })
vi.mock("@/lib/hubnet/client", () => ({ createHubnetClient: () => ({}), isHubnetConfigured: () => configured() }))
vi.mock("@/lib/hubnet/refund-sweep", () => ({ sweepHubnetRefunds: (...a: any[]) => (sweep as any)(...a) }))
vi.mock("@/lib/hubnet/unknown-attempts", () => ({ checkHubnetUnknownAttempts: (...a: any[]) => (unknown as any)(...a) }))
vi.mock("@/lib/airtime-hubnet", () => ({ syncHubnetAirtime: (...a: any[]) => (airtime as any)(...a) }))
vi.mock("@/lib/hubnet/sync", () => ({ applyHubnetStatusChange: vi.fn() }))
vi.mock("@/lib/mtn-fulfillment", () => ({ checkMTNOrderStatus: vi.fn() }))
vi.mock("@/lib/mtn-reversal", () => ({
  fetchReversalCandidates: async () => [], isReversal: () => false, flagReversal: vi.fn(), REVERSAL_WINDOW_MS: 1,
}))
vi.mock("@/lib/sms/notify", () => ({ notifyAdminsThrottled: vi.fn() }))

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co"
process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder"

import { NextRequest } from "next/server"

async function run() {
  const { GET } = await import("./route")
  await GET(new NextRequest("https://x.test/api/cron/sync-mtn-status/hubnet"))
  await Promise.all(pending.splice(0))
}

beforeEach(() => {
  vi.clearAllMocks()
  order.length = 0
  configured.mockReturnValue(true)
  vi.useFakeTimers({ toFake: ["Date"] })
})
afterEach(() => vi.useRealTimers())

describe("hubnet cron route", () => {
  it("only exports GET (plus route config)", async () => {
    const mod = await import("./route")
    expect(Object.keys(mod).filter((k) => !["maxDuration", "dynamic", "runtime"].includes(k))).toEqual(["GET"])
  })

  it("runs the refund sweep FIRST at :x0 even when later phases are slow", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 10, 58)))
    unknown.mockImplementationOnce(async () => {
      order.push("unknown")
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 13, 5))) // slow phase crosses the minute
      return { checked: 0, found: 0 }
    })
    await run()
    expect(sweep).toHaveBeenCalledTimes(1)
    expect(order[0]).toBe("sweep")
  })

  it("does not sweep at :x3", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 13, 0)))
    await run()
    expect(sweep).not.toHaveBeenCalled()
    expect(unknown).toHaveBeenCalledTimes(1)
  })

  it("is not due when the run starts at :x9 even if it ends at :x0", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 9, 59)))
    unknown.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 10, 30)))
      return { checked: 0, found: 0 }
    })
    await run()
    expect(sweep).not.toHaveBeenCalled()
  })

  it("skips watcher, airtime sync and sweep when Hubnet is not configured", async () => {
    configured.mockReturnValue(false)
    vi.setSystemTime(new Date(Date.UTC(2026, 10, 21, 12, 10, 0)))
    await run()
    expect(sweep).not.toHaveBeenCalled()
    expect(unknown).not.toHaveBeenCalled()
    expect(airtime).not.toHaveBeenCalled()
  })
})
