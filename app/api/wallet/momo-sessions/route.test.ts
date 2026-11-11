import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"

type Op = { method: string; args: unknown[] }
type Call = { table: string; ops: Op[] }
let calls: Call[] = []
let handler: (c: Call) => { data?: unknown; error?: unknown; count?: number | null }
const getUser = vi.fn()

function chain(table: string) {
  const call: Call = { table, ops: [] }
  calls.push(call)
  const run = () => Promise.resolve(handler(call))
  const proxy: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "gte", "lte", "order", "limit", "insert", "update", "maybeSingle", "single"]) {
    proxy[m] = (...args: unknown[]) => {
      call.ops.push({ method: m, args })
      return proxy
    }
  }
  proxy.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej)
  return proxy
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (t: string) => chain(t), auth: { getUser: (...a: unknown[]) => getUser(...a) } },
}))
const settingsMock = vi.fn()
const verifiedMock = vi.fn()
vi.mock("@/lib/momo-claim/settings", () => ({
  loadMomoClaimSettings: (...a: unknown[]) => settingsMock(...a),
  isStrictlyPhoneVerified: (...a: unknown[]) => verifiedMock(...a),
}))
const limitMock = vi.fn()
vi.mock("@/lib/rate-limiter", () => ({ applyRateLimit: (...a: unknown[]) => limitMock(...a) }))
const codeMock = vi.fn()
vi.mock("@/lib/momo-claim/codes", () => ({ generateClaimCode: (...a: unknown[]) => codeMock(...a) }))

import { GET, POST, DELETE } from "./route"

const URL_ = "http://localhost/api/wallet/momo-sessions"
const NOW = new Date("2026-11-11T12:00:00.000Z")
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

const SETTINGS = {
  enabled: true,
  accounts: [{ network: "MTN", number: "0240000000" }],
  accountName: "Datagod Ltd",
  feeCustomerPercent: 2,
  feeDealerPercent: 1,
  minNetPesewas: 500,
  maxSentPesewas: 200000,
}

const req = (method: string, body?: unknown, url = URL_, token: string | null = "tok") =>
  new NextRequest(url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

type World = {
  role?: string
  wallet?: boolean
  recentCount?: number
  open?: { id: string; status: string; created_at: string; expires_at: string }[]
  insertErrors?: unknown[]
  listRows?: unknown[]
  cancelRows?: unknown[]
}
function setWorld(w: World = {}) {
  const insertErrors = [...(w.insertErrors ?? [])]
  handler = (c) => {
    const has = (m: string) => c.ops.some((o) => o.method === m)
    if (c.table === "users") return { data: { role: w.role ?? "user" } }
    if (c.table === "wallets") return { data: w.wallet === false ? null : { user_id: "u1" } }
    if (c.table === "wallet_topup_sessions") {
      if (has("insert")) {
        const err = insertErrors.shift()
        if (err) return { data: null, error: err }
        const row = c.ops.find((o) => o.method === "insert")!.args[0] as Record<string, unknown>
        return { data: { id: "s1", ...row }, error: null }
      }
      if (has("update")) return { data: w.cancelRows ?? [], error: null }
      const sel = c.ops.find((o) => o.method === "select")!
      if ((sel.args[1] as { head?: boolean } | undefined)?.head) return { count: w.recentCount ?? 0, error: null }
      if (has("gt")) return { data: w.open ?? [], error: null }
      return { data: w.listRows ?? [], error: null }
    }
    return { data: null }
  }
}

let errSpy: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  calls = []
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  getUser.mockResolvedValue({ data: { user: { id: "u1" } }, error: null })
  settingsMock.mockResolvedValue({ ...SETTINGS })
  verifiedMock.mockResolvedValue(true)
  limitMock.mockResolvedValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 })
  codeMock.mockReturnValue("ABC2345")
  setWorld()
  errSpy = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  for (const s of errSpy) {
    const dump = JSON.stringify(s.mock.calls)
    expect(dump).not.toContain("ABC2345")
    s.mockRestore()
  }
  vi.useRealTimers()
})

const sessionInserts = () => calls.filter((c) => c.table === "wallet_topup_sessions" && c.ops.some((o) => o.method === "insert"))

describe("auth and config", () => {
  it("401s without a bearer token or with a bad one, on every method", async () => {
    for (const fn of [GET, POST, DELETE]) {
      expect((await fn(req("X", {}, URL_, null))).status).toBe(401)
    }
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "bad" } })
    expect((await POST(req("POST", { amount: 10 }))).status).toBe(401)
    expect(sessionInserts()).toHaveLength(0)
  })

  it("503s when the service role key is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await GET(req("GET"))).status).toBe(503)
    expect((await POST(req("POST", { amount: 10 }))).status).toBe(503)
    expect((await DELETE(req("DELETE", undefined, `${URL_}?id=x`))).status).toBe(503)
  })
})

describe("GET", () => {
  it("returns only {enabled:false} when the feature is off", async () => {
    settingsMock.mockResolvedValue({ ...SETTINGS, enabled: false })
    const res = await GET(req("GET"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })

  it("returns settings, role fee, GHS limits and mapped sessions with lazy expiry", async () => {
    setWorld({
      role: "dealer",
      listRows: [
        { id: "a", code: "ABC2345", amount: 10, fee: 0.1, net_amount: 9.9, status: "pending", created_at: ago(1000), expires_at: ahead(1000) },
        { id: "b", code: "DEF2345", amount: 5, fee: 0.05, net_amount: 4.95, status: "pending", created_at: ago(7200000), expires_at: ago(3600000) },
        { id: "c", code: "GHJ2345", amount: 5, fee: 0, net_amount: 5, status: "claimed", created_at: ago(9000000), expires_at: ago(5000000), user_id: "u1" },
      ],
    })
    const res = await GET(req("GET"))
    const j = await res.json()
    expect(j.enabled).toBe(true)
    expect(j.accounts).toEqual(SETTINGS.accounts)
    expect(j.accountName).toBe("Datagod Ltd")
    expect(j.feePercent).toBe(1)
    expect(j.minNet).toBe(5)
    expect(j.maxSent).toBe(2000)
    expect(j.sessions.map((s: { status: string }) => s.status)).toEqual(["pending", "expired", "claimed"])
    expect(j.sessions[0]).toEqual({
      id: "a", code: "ABC2345", amount: 10, fee: 0.1, netAmount: 9.9, status: "pending",
      createdAt: ago(1000), expiresAt: ahead(1000),
    })
    expect(JSON.stringify(j)).not.toContain("user_id")
    const q = calls.find((c) => c.table === "wallet_topup_sessions")!
    expect(q.ops).toContainEqual({ method: "eq", args: ["user_id", "u1"] })
    expect(q.ops.find((o) => o.method === "gte")!.args).toEqual(["created_at", ago(24 * 3600 * 1000)])
    expect(q.ops).toContainEqual({ method: "order", args: ["created_at", { ascending: false }] })
  })

  it("uses the customer fee for non-dealers", async () => {
    const j = await (await GET(req("GET"))).json()
    expect(j.feePercent).toBe(2)
  })
})

describe("POST", () => {
  const post = (amount: unknown) => POST(req("POST", { amount }))

  it("403 feature_off before anything else", async () => {
    settingsMock.mockResolvedValue({ ...SETTINGS, enabled: false })
    const res = await post(10)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("feature_off")
    expect(limitMock).not.toHaveBeenCalled()
  })

  it("429 when the limiter denies, using 5/min per user", async () => {
    limitMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: Date.now() + 1000 })
    const res = await post(10)
    expect(res.status).toBe(429)
    expect(limitMock.mock.calls[0][2]).toBe(5)
    expect(limitMock.mock.calls[0][3]).toBe(60_000)
    expect(limitMock.mock.calls[0][4]).toBe("u1")
    expect(sessionInserts()).toHaveLength(0)
  })

  it("429 from the DB-backed cap when the limiter fails open", async () => {
    limitMock.mockResolvedValue({ allowed: true, remaining: 5, resetAt: 0, degraded: true })
    setWorld({ recentCount: 5 })
    const res = await post(10)
    expect(res.status).toBe(429)
    expect(sessionInserts()).toHaveLength(0)
    const head = calls.find((c) => c.ops.some((o) => o.method === "select" && (o.args[1] as { head?: boolean })?.head))!
    expect(head.ops.find((o) => o.method === "gte")!.args).toEqual(["created_at", ago(60_000)])
  })

  it("403 phone_not_verified", async () => {
    verifiedMock.mockResolvedValue(false)
    const res = await post(10)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("phone_not_verified")
  })

  it("403 no_wallet", async () => {
    setWorld({ wallet: false })
    const res = await post(10)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("no_wallet")
  })

  it.each([
    [0, "invalid"], [-5, "invalid"], ["10", "invalid"], [null, "invalid"], [NaN, "invalid"],
    [10.123, "invalid"], [undefined, "invalid"], [5, "below_min"], [2000.01, "above_max"],
  ])("400 for amount %s -> %s", async (amount, code) => {
    const res = await post(amount)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(code)
    expect(sessionInserts()).toHaveLength(0)
  })

  it("400 invalid on a missing or malformed body", async () => {
    const bad = new NextRequest(URL_, { method: "POST", headers: { authorization: "Bearer tok" }, body: "{nope" })
    expect((await POST(bad)).status).toBe(400)
  })

  it("409 too_many_open with nextSlotFreeAt on the 6th open session", async () => {
    const open = [1, 2, 3, 4, 5].map((i) => ({
      id: `s${i}`, status: "pending", created_at: ago(i * 1000), expires_at: ahead(i * 60000),
    }))
    setWorld({ open })
    const res = await post(10)
    expect(res.status).toBe(409)
    const j = await res.json()
    expect(j.error).toBe("too_many_open")
    expect(j.nextSlotFreeAt).toBe(ahead(60000))
    expect(sessionInserts()).toHaveLength(0)
  })

  it("201 stores the code, 60 min expiry and customer fee (rounded up) in GHS", async () => {
    const res = await post(10.01)
    expect(res.status).toBe(201)
    const ins = sessionInserts()[0].ops.find((o) => o.method === "insert")!.args[0] as Record<string, unknown>
    expect(ins).toEqual({
      user_id: "u1", code: "ABC2345", amount: 10.01, fee: 0.21, net_amount: 9.8,
      status: "pending", expires_at: ahead(60 * 60000),
    })
    const j = await res.json()
    expect(j.session.code).toBe("ABC2345")
    expect(j.session.amount).toBe(10.01)
    expect(j.session.netAmount).toBe(9.8)
    expect(j.session.expiresAt).toBe(ahead(60 * 60000))
    expect(j.session.status).toBe("pending")
  })

  it("uses the dealer fee for dealers and ignores fee fields in the body", async () => {
    setWorld({ role: "dealer" })
    const res = await POST(req("POST", { amount: 100, fee: 0, net_amount: 100, feePercent: 0 }))
    expect(res.status).toBe(201)
    const ins = sessionInserts()[0].ops.find((o) => o.method === "insert")!.args[0] as Record<string, unknown>
    expect(ins.fee).toBe(1)
    expect(ins.net_amount).toBe(99)
  })

  it("retries a unique-code conflict with a new code, then succeeds", async () => {
    setWorld({ insertErrors: [{ code: "23505" }, { code: "23505" }] })
    codeMock.mockReturnValueOnce("AAA2222").mockReturnValueOnce("BBB3333").mockReturnValueOnce("CCC4444")
    const res = await post(10)
    expect(res.status).toBe(201)
    expect(sessionInserts()).toHaveLength(3)
    expect((await res.json()).session.code).toBe("CCC4444")
  })

  it("503s after 5 conflicting attempts", async () => {
    setWorld({ insertErrors: [1, 2, 3, 4, 5, 6].map(() => ({ code: "23505" })) })
    const res = await post(10)
    expect(res.status).toBe(503)
    expect(sessionInserts()).toHaveLength(5)
  })

  it("does not retry other insert errors", async () => {
    setWorld({ insertErrors: [{ code: "XX000" }] })
    const res = await post(10)
    expect(res.status).toBe(500)
    expect(sessionInserts()).toHaveLength(1)
  })
})

const OTHER = "11111111-2222-4333-8444-555555555555"

describe("DELETE", () => {
  it("404 when the conditional update touches no row (someone else's or not pending)", async () => {
    setWorld({ cancelRows: [] })
    const res = await DELETE(req("DELETE", undefined, `${URL_}?id=${OTHER}`))
    expect(res.status).toBe(404)
    const upd = calls.find((c) => c.ops.some((o) => o.method === "update"))!
    expect(upd.ops).toContainEqual({ method: "eq", args: ["id", OTHER] })
    expect(upd.ops).toContainEqual({ method: "eq", args: ["user_id", "u1"] })
    expect(upd.ops).toContainEqual({ method: "eq", args: ["status", "pending"] })
    expect(upd.ops.find((o) => o.method === "update")!.args[0]).toEqual({ status: "cancelled" })
  })

  it("200 when one row is cancelled", async () => {
    setWorld({ cancelRows: [{ id: "mine" }] })
    const res = await DELETE(req("DELETE", undefined, `${URL_}?id=${OTHER}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("404 for a non-uuid id without touching the DB", async () => {
    const res = await DELETE(req("DELETE", undefined, `${URL_}?id=nope`))
    expect(res.status).toBe(404)
    expect(calls.some((c) => c.ops.some((o) => o.method === "update"))).toBe(false)
  })

  it("400 when id is missing", async () => {
    expect((await DELETE(req("DELETE"))).status).toBe(400)
  })
})
