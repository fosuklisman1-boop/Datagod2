import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

const getUser = vi.fn()
const rpc = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: (...a: unknown[]) => rpc(...a),
    auth: { getUser: (...a: unknown[]) => getUser(...a) },
  },
}))
const settingsMock = vi.fn()
vi.mock("@/lib/momo-claim/settings", () => ({
  loadMomoClaimSettings: (...a: unknown[]) => settingsMock(...a),
}))
const limitMock = vi.fn()
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: unknown[]) => limitMock(...a) }))

import { POST } from "./route"

const URL_ = "http://localhost/api/wallet/momo-claim"
const UID = "11111111-1111-4111-8111-111111111111"
const SID = "22222222-2222-4222-8222-222222222222"
const TX = "12345678901"

const MSG = {
  credited: "Payment found. Your wallet has been credited.",
  under_review: "We found your payment. It is being checked and will be credited shortly.",
  already_credited: "This payment has already been credited to your wallet.",
  not_matched: "We couldn't match this Transaction ID to your payment. Check the ID and try again.",
  no_session: "Start a payment first, then enter your Transaction ID.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  daily_limit: "Too many attempts today. Please contact support.",
}

const req = (body?: unknown, token: string | null = "tok") =>
  new NextRequest(URL_, {
    method: "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const ORIG_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

beforeEach(() => {
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "svc"
  getUser.mockResolvedValue({ data: { user: { id: UID } }, error: null })
  settingsMock.mockResolvedValue({ enabled: true })
  limitMock.mockResolvedValue({ allowed: true })
  rpc.mockResolvedValue({ data: "credited", error: null })
})
afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
  else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIG_KEY
})

describe("POST /api/wallet/momo-claim", () => {
  it("401 without bearer token or with a bad token", async () => {
    expect((await POST(req({ transactionId: TX }, null))).status).toBe(401)
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "x" } })
    expect((await POST(req({ transactionId: TX }))).status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("503 when the service key is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await POST(req({ transactionId: TX }))).status).toBe(503)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("403 feature_off when disabled", async () => {
    settingsMock.mockResolvedValue({ enabled: false })
    const res = await POST(req({ transactionId: TX }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "feature_off" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("429 rate_limited when the limiter denies, keyed per user, 3 per 30s", async () => {
    limitMock.mockResolvedValue({ allowed: false })
    const res = await POST(req({ transactionId: TX }))
    expect(res.status).toBe(429)
    expect((await res.json()).result).toBe("rate_limited")
    expect(limitMock.mock.calls[0].slice(2)).toEqual([3, 30_000, UID])
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(["1234567", "1234567890123456", "12ab5678", "", "   ", "1234 5678"])(
    "bad transactionId %j -> not_matched without calling the RPC",
    async (tx) => {
      const res = await POST(req({ transactionId: tx }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ result: "not_matched", message: MSG.not_matched })
      expect(rpc).not.toHaveBeenCalled()
    },
  )

  it("non-string transactionId or invalid JSON -> not_matched without RPC", async () => {
    for (const body of [{ transactionId: 12345678 }, {}, null]) {
      const res = await POST(req(body))
      expect((await res.json()).result).toBe("not_matched")
    }
    const bad = new NextRequest(URL_, {
      method: "POST",
      headers: { authorization: "Bearer tok" },
      body: "{not json",
    })
    expect((await (await POST(bad)).json()).result).toBe("not_matched")
    expect(rpc).not.toHaveBeenCalled()
  })

  it("trims the id and passes only user, txid and session to the RPC; amount/userId ignored", async () => {
    await POST(req({ transactionId: `  ${TX} `, sessionId: SID, amount: 999, userId: "attacker", p_user: "attacker" }))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("claim_momo_via_session", {
      p_user: UID,
      p_txid: TX,
      p_session_id: SID,
    })
  })

  it("non-UUID or missing sessionId -> null", async () => {
    await POST(req({ transactionId: TX, sessionId: "not-a-uuid" }))
    await POST(req({ transactionId: TX }))
    await POST(req({ transactionId: TX, sessionId: 5 }))
    for (const c of rpc.mock.calls) expect(c[1].p_session_id).toBeNull()
  })

  it.each(Object.keys(MSG))("maps RPC result %s to fixed copy with 200", async (r) => {
    rpc.mockResolvedValue({ data: r, error: null })
    const res = await POST(req({ transactionId: TX }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: r, message: (MSG as Record<string, string>)[r] })
  })

  it("unknown RPC result -> not_matched", async () => {
    rpc.mockResolvedValue({ data: "weird", error: null })
    expect(await (await POST(req({ transactionId: TX }))).json()).toEqual({
      result: "not_matched",
      message: MSG.not_matched,
    })
  })

  it("RPC error or exception -> 200 not_matched, no leak, no sensitive logging", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "NO_WALLET for 1111 " + TX } })
    let res = await POST(req({ transactionId: TX, sessionId: SID }))
    expect(res.status).toBe(200)
    let text = JSON.stringify(await res.json())
    expect(text).toBe(JSON.stringify({ result: "not_matched", message: MSG.not_matched }))
    rpc.mockRejectedValueOnce(new Error("network " + TX))
    res = await POST(req({ transactionId: TX, sessionId: SID }))
    expect(res.status).toBe(200)
    text = JSON.stringify(await res.json())
    expect(text).not.toContain("network")
    const logged = JSON.stringify(spy.mock.calls)
    for (const secret of [TX, SID, UID, "NO_WALLET", "network"]) expect(logged).not.toContain(secret)
    spy.mockRestore()
  })

  it("limiter degraded:true still relies on the RPC's DB limits (4th call -> rate_limited)", async () => {
    limitMock.mockResolvedValue({ allowed: true, degraded: true })
    let n = 0
    rpc.mockImplementation(async () => ({ data: ++n > 3 ? "rate_limited" : "not_matched", error: null }))
    const results: string[] = []
    for (let i = 0; i < 4; i++) results.push((await (await POST(req({ transactionId: TX }))).json()).result)
    expect(results).toEqual(["not_matched", "not_matched", "not_matched", "rate_limited"])
    expect(rpc).toHaveBeenCalledTimes(4)
  })
})
