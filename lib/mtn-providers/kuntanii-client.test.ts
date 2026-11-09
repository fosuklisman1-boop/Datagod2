import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetPlanCache, createKuntaniiClient, getCachedPlans, type KuntaniiClient } from "./kuntanii-client"

type Call = { url: string; init: RequestInit }

function jsonRes(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function setup(responses: Array<Response | Error>) {
  const calls: Call[] = []
  let i = 0
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    const r = responses[Math.min(i++, responses.length - 1)]
    if (r instanceof Error) throw r
    return r.clone()
  })
  const sleep = vi.fn(async () => {})
  const client = createKuntaniiClient({
    fetchImpl: fetchImpl as unknown as typeof fetch,
    apiKey: "test_key",
    baseUrl: "https://kuntanii.com",
    sleep,
  })
  return { client, calls, sleep, fetchImpl }
}

const hdr = (c: Call, k: string) => (c.init.headers as Record<string, string>)[k]

beforeEach(() => __resetPlanCache())

describe("getPricing", () => {
  it("normal has no query string", async () => {
    const { client, calls } = setup([jsonRes(200, { deliveryMode: "normal", plans: [] })])
    const r = await client.getPricing("normal")
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/pricing")
    expect(calls[0].init.method).toBe("GET")
    expect(hdr(calls[0], "Authorization")).toBe("Bearer test_key")
  })
  it("instant adds deliveryMode=instant", async () => {
    const { client, calls } = setup([jsonRes(200, { deliveryMode: "instant", plans: [] })])
    await client.getPricing("instant")
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/pricing?deliveryMode=instant")
    expect(hdr(calls[0], "Authorization")).toBe("Bearer test_key")
  })
})

describe("placeOrder", () => {
  const input = { externalOrderId: "o1", phoneNumber: "0241234567", dataGb: 3, mode: "normal" as const }

  it("normal body has no deliveryMode and carries idempotency header", async () => {
    const { client, calls } = setup([jsonRes(201, { externalOrderId: "o1" })])
    const r = await client.placeOrder(input)
    expect(r.ok).toBe(true)
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/orders")
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.body).toBe('{"externalOrderId":"o1","items":[{"phoneNumber":"0241234567","dataGb":3}]}')
    expect(hdr(calls[0], "X-Kuntanii-Idempotency-Key")).toBe("o1")
    expect(hdr(calls[0], "Content-Type")).toBe("application/json")
  })

  it("instant body includes deliveryMode", async () => {
    const { client, calls } = setup([jsonRes(201, {})])
    await client.placeOrder({ ...input, mode: "instant" })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      externalOrderId: "o1",
      deliveryMode: "instant",
      items: [{ phoneNumber: "0241234567", dataGb: 3 }],
    })
  })

  it("retries once on 503 with identical body/headers", async () => {
    const { client, calls, sleep } = setup([jsonRes(503, { message: "down" }), jsonRes(201, { externalOrderId: "o1" })])
    const r = await client.placeOrder(input)
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(calls[1].init.body).toBe(calls[0].init.body)
    expect(calls[1].init.headers).toEqual(calls[0].init.headers)
  })

  it("retries once on network error then returns network:true", async () => {
    const { client, calls, sleep } = setup([new Error("boom"), new Error("boom2")])
    const r = await client.placeOrder(input)
    expect(calls).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(2000)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.network).toBe(true)
      expect(r.status).toBe(0)
    }
  })

  it("does not retry on 422", async () => {
    const { client, calls, sleep } = setup([jsonRes(422, { code: "NO_ELIGIBLE_RECIPIENTS", message: "x", rejectedRecipients: [] })])
    const r = await client.placeOrder(input)
    expect(calls).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("NO_ELIGIBLE_RECIPIENTS")
      expect((r.body as any).rejectedRecipients).toEqual([])
    }
  })

  it("200 idempotent reply is ok", async () => {
    const { client } = setup([jsonRes(200, { idempotent: true, externalOrderId: "o1" })])
    const r = await client.placeOrder(input)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.idempotent).toBe(true)
  })

  it("success:false body is an error", async () => {
    const { client } = setup([jsonRes(200, { success: false, code: "CONFLICT", message: "m" })])
    const r = await client.placeOrder(input)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("CONFLICT")
  })
})

describe("error parsing", () => {
  it("non-JSON body yields error with HTTP status in message", async () => {
    const { client } = setup([new Response("<html>bad gateway</html>", { status: 502 })])
    const r = await client.getOrder("o1")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBeUndefined()
      expect(r.message).toContain("502")
    }
  })
  it("404 is an ordinary result", async () => {
    const { client, sleep } = setup([jsonRes(404, { code: "NOT_FOUND", message: "nope" })])
    const r = await client.getOrder("o1")
    expect(r).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND", message: "nope" })
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe("other endpoints", () => {
  it("getOrder encodes the id and does not retry", async () => {
    const { client, calls } = setup([jsonRes(200, {}), jsonRes(200, {})])
    await client.getOrder("a/b c")
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/orders/a%2Fb%20c")
    const s = setup([jsonRes(503, {})])
    await s.client.getOrder("o1")
    expect(s.calls).toHaveLength(1)
  })
  it("reportNotReceived POSTs", async () => {
    const { client, calls } = setup([jsonRes(201, { reportReference: "NR-1" })])
    const body = { phoneNumber: "0241234567", dataGb: 3, reasonCode: "x" }
    await client.reportNotReceived("o1", body)
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/orders/o1/not-received")
    expect(calls[0].init.method).toBe("POST")
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body)
  })
  it("getNotReceivedStatus uses reportReference query", async () => {
    const { client, calls } = setup([jsonRes(200, { status: "open" })])
    await client.getNotReceivedStatus("o1", "NR-1")
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/orders/o1/not-received?reportReference=NR-1")
    expect(calls[0].init.method).toBe("GET")
  })
  it("verifyBeneficiaries sends phoneNumbers", async () => {
    const { client, calls } = setup([jsonRes(200, { results: [] })])
    await client.verifyBeneficiaries(["0241234567"])
    expect(calls[0].url).toBe("https://kuntanii.com/api/integrations/beneficiaries/verify")
    expect(calls[0].init.body).toBe('{"phoneNumbers":["0241234567"]}')
  })
})

describe("getCachedPlans", () => {
  const plan = { planCode: 4, displayName: "1GB", bundleSizeMb: 1024, unitPriceGhs: 3.85 }
  const fake = (results: any[]) => {
    const getPricing = vi.fn(async () => results.shift())
    return { client: { getPricing } as unknown as KuntaniiClient, getPricing }
  }
  it("caches within 5 minutes, refetches after", async () => {
    const ok = { ok: true, status: 200, data: { deliveryMode: "normal", plans: [plan] } }
    const { client, getPricing } = fake([ok, ok])
    expect(await getCachedPlans(client, "normal", 1000)).toEqual([plan])
    expect(await getCachedPlans(client, "normal", 1000 + 299_000)).toEqual([plan])
    expect(getPricing).toHaveBeenCalledTimes(1)
    await getCachedPlans(client, "normal", 1000 + 300_001)
    expect(getPricing).toHaveBeenCalledTimes(2)
  })
  it("returns null on failure and does not poison cache", async () => {
    const bad = { ok: false, status: 500, message: "x" }
    const ok = { ok: true, status: 200, data: { deliveryMode: "normal", plans: [plan] } }
    const { client, getPricing } = fake([bad, ok])
    expect(await getCachedPlans(client, "normal", 1)).toBeNull()
    expect(await getCachedPlans(client, "normal", 2)).toEqual([plan])
    expect(getPricing).toHaveBeenCalledTimes(2)
  })
  it("caches per mode", async () => {
    const ok = { ok: true, status: 200, data: { deliveryMode: "normal", plans: [plan] } }
    const { client, getPricing } = fake([ok, ok])
    await getCachedPlans(client, "normal", 1)
    await getCachedPlans(client, "instant", 1)
    expect(getPricing).toHaveBeenCalledTimes(2)
  })
})
