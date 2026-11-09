import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ run: vi.fn(), after: [] as (() => Promise<void>)[] }))

vi.mock("next/server", async (orig) => {
  const real: any = await orig()
  return { ...real, after: (fn: () => Promise<void>) => { h.after.push(fn) } }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ tag: "db" }) }))
vi.mock("@/lib/sub-agents/price-reminders", () => ({
  runPriceReminders: (...a: unknown[]) => h.run(...a),
  defaultPriceReminderDeps: () => ({ tag: "deps" }),
}))

import * as route from "./route"

const req = (auth?: string) =>
  new NextRequest("https://x/api/cron/sub-agent-price-reminders", auth ? { headers: { authorization: auth } } : undefined)

const OLD = process.env.CRON_SECRET
beforeEach(() => {
  process.env.CRON_SECRET = "test-secret"
  h.run.mockReset()
  h.run.mockResolvedValue({ scanned: 0, sent: 0, skipped_no_catalog: 0, claimed_elsewhere: 0, read_errors: 0 })
  h.after = []
})
afterEach(() => {
  process.env.CRON_SECRET = OLD
})

describe("sub-agent-price-reminders cron", () => {
  it("401 without the secret, and does no work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const res = await route.GET(req())
    expect(res.status).toBe(401)
    const wrong = await route.GET(req("Bearer nope"))
    expect(wrong.status).toBe(401)
    expect(h.after).toHaveLength(0)
    expect(h.run).not.toHaveBeenCalled()
  })

  it("accepts with the secret and runs the job in the background", async () => {
    const res = await route.GET(req("Bearer test-secret"))
    expect(res.status).toBe(202)
    expect(h.after).toHaveLength(1)
    await h.after[0]()
    expect(h.run).toHaveBeenCalledTimes(1)
    expect(h.run.mock.calls[0][0]).toEqual({ tag: "db" })
    expect(h.run.mock.calls[0][1]).toBeInstanceOf(Date)
  })

  it("exports only HTTP handlers and route config", () => {
    const allowed = new Set(["GET", "POST", "dynamic", "maxDuration", "runtime", "revalidate", "fetchCache", "preferredRegion"])
    for (const k of Object.keys(route)) expect(allowed.has(k)).toBe(true)
  })
})
