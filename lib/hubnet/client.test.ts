import { describe, it, expect, vi, afterEach } from "vitest"
import { createHubnetClient, hubnetWebhookUrl, isHubnetConfigured } from "./client"

type Call = { url: string; init: RequestInit }

function fakeFetch(reply: (url: string) => { status?: number; body?: unknown; text?: string } | Error) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init: init ?? {} })
    const r = reply(String(url))
    if (r instanceof Error) throw r
    const text = r.text ?? JSON.stringify(r.body ?? {})
    return new Response(text, { status: r.status ?? 200 })
  })
  return { fn: fn as unknown as typeof fetch, calls }
}

const KEY = "k"
const baseEnv = { HUBNET_API_KEY: KEY } as unknown as NodeJS.ProcessEnv

function headersOf(c: Call): Record<string, string> {
  const h = c.init.headers as Record<string, string>
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
}

afterEach(() => vi.restoreAllMocks())

describe("hubnet client", () => {
  it("sends token header, never authorization, on every request", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { data: { wallet_balance: 1, status: "verified" }, status: "success" } }))
    const c = createHubnetClient({ fetch: fn, env: baseEnv })
    await c.placeData("mtn", { phone: "0241234567", volumeMb: 1000, reference: "DGabc" })
    await c.placeAirtime({ phone: "0241234567", amountGhs: 10, reference: "DAabc" })
    await c.getStatus("DGabc")
    await c.listRefunds()
    await c.getBalance()
    await c.verifyMtn("0241234567")
    expect(calls).toHaveLength(6)
    for (const call of calls) {
      const h = headersOf(call)
      expect(h.token).toBe("Bearer k")
      expect(h.authorization).toBeUndefined()
    }
    expect(headersOf(calls[0])["content-type"]).toBe("application/json")
  })

  it("uses /live by default and /test when HUBNET_MODE=test", async () => {
    const a = fakeFetch(() => ({ body: {} }))
    await createHubnetClient({ fetch: a.fn, env: baseEnv }).getBalance()
    expect(a.calls[0].url).toBe("https://hubnet.app/live/api/context/business/transaction/check_balance")
    const b = fakeFetch(() => ({ body: {} }))
    await createHubnetClient({ fetch: b.fn, env: { ...baseEnv, HUBNET_MODE: "test" } as any }).getBalance()
    expect(b.calls[0].url).toContain("/test/api/context/business/transaction/")
  })

  it("placeData posts the right endpoint and body, webhook only when token set", async () => {
    const a = fakeFetch(() => ({ body: { event: "charge.success" } }))
    const r = await createHubnetClient({ fetch: a.fn, env: baseEnv }).placeData("big-time", {
      phone: "0241234567",
      volumeMb: 2000,
      reference: "DGref1",
    })
    expect(r.ok).toBe(true)
    expect(a.calls[0].url).toMatch(/\/live\/api\/context\/business\/transaction\/big-time-new-transaction$/)
    expect(a.calls[0].init.method).toBe("POST")
    expect(JSON.parse(String(a.calls[0].init.body))).toEqual({ phone: "0241234567", volume: "2000", reference: "DGref1" })

    const b = fakeFetch(() => ({ body: {} }))
    const env = { ...baseEnv, HUBNET_WEBHOOK_TOKEN: "t o/k" } as any
    await createHubnetClient({ fetch: b.fn, env }).placeData("mtn", { phone: "0241234567", volumeMb: 1000, reference: "DGref2" })
    expect(JSON.parse(String(b.calls[0].init.body)).webhook).toBe(
      "https://www.datagod.store/api/webhooks/mtn/hubnet?t=t%20o%2Fk"
    )
    expect(hubnetWebhookUrl(env)).toContain("?t=t%20o%2Fk")
    expect(hubnetWebhookUrl(baseEnv)).toBeUndefined()
  })

  it("placeAirtime sends volume as a 2dp string", async () => {
    const a = fakeFetch(() => ({ body: {} }))
    await createHubnetClient({ fetch: a.fn, env: baseEnv }).placeAirtime({ phone: "0241234567", amountGhs: 10, reference: "DAx" })
    expect(a.calls[0].url).toMatch(/\/airtime-new-transaction$/)
    expect(JSON.parse(String(a.calls[0].init.body)).volume).toBe("10.00")
  })

  it("place call throw becomes an unknown outcome", async () => {
    const a = fakeFetch(() => new Error("boom"))
    const r = await createHubnetClient({ fetch: a.fn, env: baseEnv }).placeData("mtn", { phone: "0241234567", volumeMb: 1000, reference: "DGz" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.error_type).toBe("OUTCOME_UNKNOWN")
  })

  it("getStatus encodes the reference; throw or junk => unknown", async () => {
    const a = fakeFetch(() => ({ body: { status: "success", data: { status: "delivered" } } }))
    const r = await createHubnetClient({ fetch: a.fn, env: baseEnv }).getStatus("a b&c")
    expect(a.calls[0].url).toContain("/check-transaction-status?reference=a%20b%26c")
    expect(a.calls[0].init.method).toBe("GET")
    expect(r.kind).toBe("found")
    const t = fakeFetch(() => new Error("net"))
    expect(await createHubnetClient({ fetch: t.fn, env: baseEnv }).getStatus("x")).toEqual({ kind: "unknown" })
    const j = fakeFetch(() => ({ text: "<html>" }))
    expect(await createHubnetClient({ fetch: j.fn, env: baseEnv }).getStatus("x")).toEqual({ kind: "unknown" })
  })

  it("listRefunds normalizes on 2xx, null otherwise", async () => {
    const a = fakeFetch(() => ({ body: { data: [{ reference: "DGr", amount: 3 }] } }))
    expect(await createHubnetClient({ fetch: a.fn, env: baseEnv }).listRefunds()).toEqual([{ reference: "DGr", amount: 3 }])
    const b = fakeFetch(() => ({ status: 500, body: {} }))
    expect(await createHubnetClient({ fetch: b.fn, env: baseEnv }).listRefunds()).toBeNull()
    const c = fakeFetch(() => new Error("x"))
    expect(await createHubnetClient({ fetch: c.fn, env: baseEnv }).listRefunds()).toBeNull()
  })

  it("getBalance and verifyMtn parse data, null on error", async () => {
    const a = fakeFetch((u) =>
      u.includes("check_balance") ? { body: { data: { wallet_balance: 120.5 } } } : { body: { data: { status: "queued" } } }
    )
    const c = createHubnetClient({ fetch: a.fn, env: baseEnv })
    expect(await c.getBalance()).toBe(120.5)
    expect(await c.verifyMtn("0241234567")).toBe("queued")
    expect(a.calls[1].url).toContain("/mtn-verification?number=0241234567")
    const b = fakeFetch(() => ({ status: 500, body: {} }))
    const d = createHubnetClient({ fetch: b.fn, env: baseEnv })
    expect(await d.getBalance()).toBeNull()
    expect(await d.verifyMtn("0241234567")).toBeNull()
    const e = fakeFetch(() => new Error("x"))
    expect(await createHubnetClient({ fetch: e.fn, env: baseEnv }).getBalance()).toBeNull()
  })

  it("isHubnetConfigured reflects the key", () => {
    expect(isHubnetConfigured(baseEnv)).toBe(true)
    expect(isHubnetConfigured({} as any)).toBe(false)
  })

  it("never logs the key, token or a full phone", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
    const env = { HUBNET_API_KEY: "SECRETKEY", HUBNET_WEBHOOK_TOKEN: "SECRETTOKEN" } as any
    const bad = fakeFetch(() => new Error("fail"))
    const c = createHubnetClient({ fetch: bad.fn, env })
    await c.placeData("mtn", { phone: "0241234567", volumeMb: 1000, reference: "DGq" })
    await c.placeAirtime({ phone: "0241234567", amountGhs: 5, reference: "DAq" })
    await c.getStatus("DGq")
    await c.listRefunds()
    await c.getBalance()
    await c.verifyMtn("0241234567")
    const out = JSON.stringify(spies.flatMap((s) => s.mock.calls))
    expect(out).not.toContain("SECRETKEY")
    expect(out).not.toContain("SECRETTOKEN")
    expect(out).not.toContain("0241234567")
  })
})
