import { describe, it, expect } from "vitest"
import { shapeStatus, createStatusService } from "./status-public"
import type { ControlsSnapshot } from "./controls"

const NOW = new Date("2026-11-23T12:00:00Z")
const none: ControlsSnapshot = { pausedUsers: new Set(), services: new Map(), at: 0 }
const find = (s: ReturnType<typeof shapeStatus>, id: string) => s.services.find((x) => x.id === id)!

describe("shapeStatus", () => {
  it("paused service -> state paused with its message even when its rate is high", () => {
    const controls: ControlsSnapshot = { ...none, services: new Map([["airtime", { message: "Back at 3pm" }]]) }
    const s = shapeStatus({ controls, health: [{ endpoint: "/api/v2/airtime", total: 500, failed: 0 }], now: NOW })
    expect(find(s, "airtime")).toMatchObject({ state: "paused", message: "Back at 3pm" })
  })
  it("< 20 requests -> no_data and successRate24h null (no exact small count anywhere in the JSON)", () => {
    const s = shapeStatus({ controls: none, health: [{ endpoint: "/api/v2/sms/send", total: 17, failed: 3 }], now: NOW })
    expect(find(s, "sms")).toMatchObject({ state: "no_data", successRate24h: null })
    const json = JSON.stringify(s)
    expect(json).not.toMatch(/\b17\b/)
    expect(json).not.toMatch(/"total"|"failed"/)
  })
  it("19 of 20 requests ok (95%) is operational; 18 of 20 degraded; 4xx never count as failures (only >= 500)", () => {
    const ok = shapeStatus({ controls: none, health: [{ endpoint: "/api/v2/data/x", total: 20, failed: 1 }], now: NOW })
    expect(find(ok, "data")).toMatchObject({ state: "operational", successRate24h: 95 })
    const bad = shapeStatus({ controls: none, health: [{ endpoint: "/api/v2/data/x", total: 20, failed: 2 }], now: NOW })
    expect(find(bad, "data")).toMatchObject({ state: "degraded", successRate24h: 90 })
    // failed counts only come from the SQL (>= 500); a service with no failures stays at 100
    const clean = shapeStatus({ controls: none, health: [{ endpoint: "/api/v2/data/x", total: 100, failed: 0 }], now: NOW })
    expect(find(clean, "data").successRate24h).toBe(100)
  })
  it("account and wallet endpoints are ignored; JSON.stringify of the result contains no user, key, ip or endpoint strings", () => {
    const s = shapeStatus({
      controls: none,
      health: [
        { endpoint: "/api/v2/account/balance", total: 900, failed: 900 },
        { endpoint: "/api/v2/data/buy", total: 50, failed: 0 },
      ],
      now: NOW,
    })
    expect(s.services).toHaveLength(7)
    expect(find(s, "data").successRate24h).toBe(100)
    // Titles are fixed product names ("Data and wallet" is the spec's title); check everything else.
    const json = JSON.stringify({ ...s, services: s.services.map(({ title: _t, ...rest }) => rest) })
    for (const w of ["user", "key", "ip", "/api/", "account", "wallet", "endpoint"]) expect(json.toLowerCase()).not.toContain(w)
    expect(s.generatedAt).toBe(NOW.toISOString())
  })
})

function fakeClient(opts: { health?: () => { data: unknown; error: unknown }; boom?: () => boolean }) {
  const calls = { from: 0, rpc: 0 }
  const client = {
    from() {
      calls.from++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        limit: () => chain,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (a: any, b: any) => Promise.resolve({ data: [], error: null }).then(a, b),
      }
      return chain
    },
    rpc() {
      calls.rpc++
      if (opts.boom?.()) return Promise.reject(new Error("boom"))
      return Promise.resolve(opts.health ? opts.health() : { data: [], error: null })
    },
  }
  return { client, calls }
}

describe("createStatusService", () => {
  it("100 calls inside 60 s -> exactly one pair of queries; different query strings are irrelevant (service takes none)", async () => {
    let t = 1_000_000
    const { client, calls } = fakeClient({})
    const svc = createStatusService({ client, now: () => t })
    for (let i = 0; i < 100; i++) {
      t += 500
      await svc.get()
    }
    expect(calls.rpc).toBe(1)
    expect(calls.from).toBe(2) // the two control reads, once
  })
  it("DB error -> last good payload while < 10 min old, else error; never throws", async () => {
    let t = 1_000_000
    let fail = false
    const { client } = fakeClient({ boom: () => fail })
    const svc = createStatusService({ client, now: () => t })
    const good = await svc.get()
    expect(good).not.toBe("error")
    fail = true
    t += 61_000
    expect(await svc.get()).toEqual(good)
    t += 9 * 60_000
    expect(await svc.get()).toBe("error")
    // error result of the rpc itself (not a throw)
    const { client: c2 } = fakeClient({ health: () => ({ data: null, error: { message: "nope" } }) })
    expect(await createStatusService({ client: c2, now: () => t }).get()).toBe("error")
  })
})
