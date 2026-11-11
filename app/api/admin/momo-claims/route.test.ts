import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

type Op = { method: string; args: unknown[] }
type Call = { table: string; ops: Op[] }
let calls: Call[] = []
let handler: (c: Call) => { data?: unknown; error?: unknown; count?: number | null }
const rpcMock = vi.fn()

function chain(table: string) {
  const call: Call = { table, ops: [] }
  calls.push(call)
  const run = () => Promise.resolve(handler(call))
  const proxy: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in", "gte", "lte", "ilike", "or", "order", "limit", "update", "upsert", "insert", "maybeSingle", "single"]) {
    proxy[m] = (...args: unknown[]) => {
      call.ops.push({ method: m, args })
      return proxy
    }
  }
  proxy.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej)
  return proxy
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (t: string) => chain(t), rpc: (...a: unknown[]) => rpcMock(...a) },
}))
const authMock = vi.fn()
vi.mock("@/lib/admin-auth", () => ({ verifyAdminAccess: (...a: unknown[]) => authMock(...a) }))
const settingsMock = vi.fn()
vi.mock("@/lib/momo-claim/settings", () => ({ loadMomoClaimSettings: (...a: unknown[]) => settingsMock(...a) }))

import { GET, POST, PATCH } from "./route"

const URL_ = "http://localhost/api/admin/momo-claims"
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "11111111-2222-4333-8444-555555555555"
const TX = "12345678901"

const req = (method: string, body?: unknown, url = URL_) =>
  new NextRequest(url, {
    method,
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const SETTINGS = {
  enabled: true,
  accounts: [{ network: "MTN", number: "0240000000" }],
  accountName: "Datagod Ltd",
  feeCustomerPercent: 2,
  feeDealerPercent: 1,
  minNetPesewas: 500,
  maxSentPesewas: 200000,
  senderAllowlist: ["MobileMoney"],
  regressionThreshold: 1000000,
  reviewThresholdPesewas: 50000,
  dailyCapPesewas: 300000,
  source: "db",
}

type World = {
  txRows?: unknown[]
  counts?: Record<string, number>
  countError?: boolean
  rawRow?: unknown
  updateRows?: unknown[]
  txSession?: { session_id: string | null } | null
  session?: { user_id: string } | null
  userExists?: boolean
  upsertError?: unknown
}
function setWorld(w: World = {}) {
  handler = (c) => {
    const has = (m: string) => c.ops.some((o) => o.method === m)
    const eqVal = (k: string) => c.ops.find((o) => o.method === "eq" && o.args[0] === k)?.args[1]
    if (c.table === "momo_transactions") {
      if (has("update")) return { data: w.updateRows ?? [], error: null }
      const sel = c.ops.find((o) => o.method === "select")
      if ((sel?.args[1] as { head?: boolean } | undefined)?.head) {
        if (w.countError && eqVal("status") === "voided") return { count: null, error: { code: "XX000", message: "secret" } }
        return { count: w.counts?.[String(eqVal("status"))] ?? 0, error: null }
      }
      if (has("maybeSingle")) {
        const cols = String(sel?.args[0] ?? "")
        if (cols.includes("raw_sms")) return { data: w.rawRow ?? null, error: null }
        return { data: w.txSession === undefined ? { session_id: "s1" } : w.txSession, error: null }
      }
      return { data: w.txRows ?? [], error: null }
    }
    if (c.table === "wallet_topup_sessions") return { data: w.session === undefined ? { user_id: USER } : w.session, error: null }
    if (c.table === "users") return { data: w.userExists === false ? null : { id: USER }, error: null }
    if (c.table === "admin_settings") return { data: null, error: w.upsertError ?? null }
    return { data: null }
  }
}

let spies: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  calls = []
  vi.clearAllMocks()
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-placeholder"
  authMock.mockResolvedValue({ isAdmin: true, userId: ADMIN })
  settingsMock.mockResolvedValue({ ...SETTINGS })
  rpcMock.mockImplementation(async (fn: string) =>
    fn === "momo_suspicious_claimers" ? { data: [], error: null } : { data: "credited", error: null },
  )
  setWorld()
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
})
afterEach(() => {
  for (const s of spies) {
    const dump = JSON.stringify(s.mock.calls)
    expect(dump).not.toContain(TX)
    expect(dump).not.toContain(USER)
    s.mockRestore()
  }
})

const updates = () => calls.filter((c) => c.ops.some((o) => o.method === "update"))

describe("auth", () => {
  it("returns the auth errorResponse as-is on every method", async () => {
    authMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Admin access required" }, { status: 403 }) })
    for (const fn of [GET, POST, PATCH]) {
      const res = await fn(req("X", {}))
      expect(res.status).toBe(403)
    }
    expect(calls).toHaveLength(0)
    authMock.mockResolvedValue({ isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    expect((await GET(req("GET"))).status).toBe(401)
  })

  it("503s when the service key is missing", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    expect((await GET(req("GET"))).status).toBe(503)
    expect((await PATCH(req("PATCH", { action: "void", transactionId: TX }))).status).toBe(503)
  })

  it("lets GET run for the cron bypass but 403s every write without a userId", async () => {
    authMock.mockResolvedValue({ isAdmin: true })
    expect((await GET(req("GET"))).status).toBe(200)
    for (const fn of [POST, PATCH]) {
      const res = await fn(req("X", {}))
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe("admin_user_required")
    }
    expect(updates()).toHaveLength(0)
    expect(rpcMock.mock.calls.every((c) => c[0] === "momo_suspicious_claimers")).toBe(true)
  })
})

describe("GET", () => {
  it("returns transactions, one count per status, suspicious users and display-unit settings", async () => {
    setWorld({
      txRows: [{ transaction_id: TX, status: "pending" }],
      counts: { pending: 3, flagged: 2 },
    })
    rpcMock.mockResolvedValue({
      data: [{ user_id: "u7", attempts: "7" }, { user_id: "u6", attempts: 6 }, { user_id: "u5", attempts: 5 }],
      error: null,
    })
    const res = await GET(req("GET"))
    const j = await res.json()
    expect(rpcMock).toHaveBeenCalledWith("momo_suspicious_claimers", { p_min_attempts: 5, p_limit: 100 })
    expect(j.settingsDefaulted).toBe(false)
    expect(j.transactions).toEqual([{ transaction_id: TX, status: "pending" }])
    expect(j.counts).toEqual({ pending: 3, claimed: 0, flagged: 2, voided: 0, unparsed: 0, rejected_sender: 0 })
    expect(j.suspicious).toEqual([
      { userId: "u7", attempts: 7 },
      { userId: "u6", attempts: 6 },
      { userId: "u5", attempts: 5 },
    ])
    expect(j.settings).toEqual({
      enabled: true,
      accounts: SETTINGS.accounts,
      accountName: "Datagod Ltd",
      feeCustomerPercent: 2,
      feeDealerPercent: 1,
      minNet: 5,
      maxSent: 2000,
      senderAllowlist: ["MobileMoney"],
      regressionThreshold: 1000000,
      reviewThreshold: 500,
      dailyCap: 3000,
    })
  })

  it("500s with a sanitized body when a count query or the suspicious RPC errors", async () => {
    setWorld({ countError: true })
    let res = await GET(req("GET"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
    setWorld()
    rpcMock.mockResolvedValue({ data: null, error: { code: "XX000", message: "secret" } })
    res = await GET(req("GET"))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })

  it("flags settingsDefaulted when the loader fell back to defaults", async () => {
    settingsMock.mockResolvedValue({ ...SETTINGS, source: "defaults" })
    expect((await (await GET(req("GET"))).json()).settingsDefaulted).toBe(true)
  })

  it("never selects raw_sms for the list, and caps at 200 newest first", async () => {
    await GET(req("GET"))
    const list = calls.find((c) => c.table === "momo_transactions" && c.ops.some((o) => o.method === "limit"))!
    expect(String(list.ops.find((o) => o.method === "select")!.args[0])).not.toContain("raw_sms")
    expect(list.ops).toContainEqual({ method: "limit", args: [200] })
    expect(list.ops).toContainEqual({ method: "order", args: ["received_at", { ascending: false }] })
  })

  it("applies status, network, from and to filters", async () => {
    await GET(req("GET", undefined, `${URL_}?status=flagged&network=MTN&from=2026-11-01&to=2026-11-10`))
    const list = calls.find((c) => c.table === "momo_transactions" && c.ops.some((o) => o.method === "limit"))!
    expect(list.ops).toContainEqual({ method: "eq", args: ["status", "flagged"] })
    expect(list.ops).toContainEqual({ method: "eq", args: ["network", "MTN"] })
    expect(list.ops.find((o) => o.method === "gte")!.args[0]).toBe("received_at")
    expect(list.ops.find((o) => o.method === "lte")!.args[0]).toBe("received_at")
  })

  it("ignores an unknown status value", async () => {
    await GET(req("GET", undefined, `${URL_}?status=bogus`))
    const list = calls.find((c) => c.table === "momo_transactions" && c.ops.some((o) => o.method === "limit"))!
    expect(list.ops.some((o) => o.method === "eq" && o.args[0] === "status")).toBe(false)
  })

  it("q matches txid or name, and a uuid also matches claimed_by; filter syntax is stripped", async () => {
    await GET(req("GET", undefined, `${URL_}?q=${encodeURIComponent("jo,hn(x)%")}`))
    let list = calls.find((c) => c.table === "momo_transactions" && c.ops.some((o) => o.method === "limit"))!
    const f1 = String(list.ops.find((o) => o.method === "or")!.args[0])
    expect(f1).toBe("transaction_id.ilike.%johnx%,sender_name.ilike.%johnx%")

    calls = []
    await GET(req("GET", undefined, `${URL_}?q=${USER}`))
    list = calls.find((c) => c.table === "momo_transactions" && c.ops.some((o) => o.method === "limit"))!
    expect(String(list.ops.find((o) => o.method === "or")!.args[0])).toContain(`claimed_by.eq.${USER}`)
  })

  it("GET ?raw=<txid> returns only rawSms", async () => {
    setWorld({ rawRow: { raw_sms: "hello sms" } })
    const res = await GET(req("GET", undefined, `${URL_}?raw=${TX}`))
    expect(await res.json()).toEqual({ rawSms: "hello sms" })
  })

  it("GET ?raw= needs a real admin user id (cron bypass is refused)", async () => {
    authMock.mockResolvedValue({ isAdmin: true })
    setWorld({ rawRow: { raw_sms: "hello sms" } })
    const res = await GET(req("GET", undefined, `${URL_}?raw=${TX}`))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe("admin_user_required")
    expect(calls).toHaveLength(0)
  })

  it("GET ?raw= 404s for an unknown txid", async () => {
    expect((await GET(req("GET", undefined, `${URL_}?raw=${TX}`))).status).toBe(404)
  })
})

describe("POST settings", () => {
  const GOOD = {
    enabled: true,
    accounts: [{ network: "MTN", number: "0240000000" }],
    accountName: "Datagod Ltd",
    feeCustomerPercent: 2,
    feeDealerPercent: 1,
    minNet: 5,
    maxSent: 2000,
    senderAllowlist: ["MobileMoney"],
    regressionThreshold: 1000000,
    reviewThreshold: 500,
    dailyCap: 3000,
  }

  it("400s with the field on a bad body and writes nothing", async () => {
    const res = await POST(req("POST", { ...GOOD, feeCustomerPercent: "2" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "invalid_setting", field: "feeCustomerPercent" })
    expect(calls.some((c) => c.ops.some((o) => o.method === "upsert"))).toBe(false)
  })

  it("400s on a malformed JSON body", async () => {
    const bad = new NextRequest(URL_, { method: "POST", headers: { authorization: "Bearer tok" }, body: "{nope" })
    expect((await POST(bad)).status).toBe(400)
  })

  it("400 mtn_account_required when enabling with no MTN account", async () => {
    const res = await POST(req("POST", { ...GOOD, accounts: [] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "mtn_account_required", field: "accounts" })
  })

  it("409 settings_unavailable when a fresh load reports defaults, and nothing is written", async () => {
    settingsMock.mockResolvedValue({ ...SETTINGS, source: "defaults" })
    const res = await POST(req("POST", GOOD))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("settings_unavailable")
    expect(calls.some((c) => c.ops.some((o) => o.method === "upsert"))).toBe(false)
  })

  it("upserts every key as {value} with updated_by and updated_at", async () => {
    const res = await POST(req("POST", GOOD))
    expect(res.status).toBe(200)
    const up = calls.find((c) => c.table === "admin_settings" && c.ops.some((o) => o.method === "upsert"))!
    const rows = up.ops.find((o) => o.method === "upsert")!.args[0] as { key: string; value: { value: unknown }; updated_by: string; updated_at: string }[]
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value.value]))
    expect(byKey).toEqual({
      momo_claim_enabled: true,
      momo_payment_accounts: GOOD.accounts,
      momo_account_name: "Datagod Ltd",
      momo_claim_fee_customer: 2,
      momo_claim_fee_dealer: 1,
      momo_min_claimable: 5,
      momo_max_claimable: 2000,
      momo_sms_sender_allowlist: ["MobileMoney"],
      momo_txid_regression_threshold: 1000000,
      momo_auto_claim_review_threshold: 500,
      momo_auto_claim_daily_cap: 3000,
    })
    for (const r of rows) {
      expect(r.updated_by).toBe(ADMIN)
      expect(typeof r.updated_at).toBe("string")
    }
    expect(up.ops.find((o) => o.method === "upsert")!.args[1]).toEqual({ onConflict: "key" })
  })

  it("500s on a database error without raw text", async () => {
    setWorld({ upsertError: { message: "secret detail", code: "XX000" } })
    const res = await POST(req("POST", GOOD))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })
})

describe("PATCH void / restore", () => {
  it("void is one conditional update from pending/unparsed; 0 rows -> 409 invalid_state", async () => {
    setWorld({ updateRows: [] })
    const res = await PATCH(req("PATCH", { action: "void", transactionId: TX }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("invalid_state")
    const u = updates()[0]
    expect(u.ops.find((o) => o.method === "update")!.args[0]).toEqual({ status: "voided" })
    expect(u.ops).toContainEqual({ method: "eq", args: ["transaction_id", TX] })
    expect(u.ops).toContainEqual({ method: "in", args: ["status", ["pending", "unparsed"]] })
  })

  it("void 200 when a row changed", async () => {
    setWorld({ updateRows: [{ id: "r" }] })
    const res = await PATCH(req("PATCH", { action: "void", transactionId: TX }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "voided" })
  })

  it("restore only touches voided rows and sets pending", async () => {
    setWorld({ updateRows: [{ id: "r" }] })
    const res = await PATCH(req("PATCH", { action: "restore", transactionId: TX }))
    expect(res.status).toBe(200)
    const u = updates()[0]
    expect(u.ops.find((o) => o.method === "update")!.args[0]).toEqual({ status: "pending" })
    expect(u.ops).toContainEqual({ method: "eq", args: ["status", "voided"] })
  })

  it("restore 409 when not voided", async () => {
    setWorld({ updateRows: [] })
    expect((await PATCH(req("PATCH", { action: "restore", transactionId: TX }))).status).toBe(409)
  })
})

describe("PATCH input checks", () => {
  it("400 on unknown action, missing or oversized transactionId, bad body", async () => {
    expect((await PATCH(req("PATCH", { action: "nuke", transactionId: TX }))).status).toBe(400)
    expect((await PATCH(req("PATCH", { action: "void" }))).status).toBe(400)
    expect((await PATCH(req("PATCH", { action: "void", transactionId: "x".repeat(100) }))).status).toBe(400)
    const bad = new NextRequest(URL_, { method: "PATCH", headers: { authorization: "Bearer tok" }, body: "{nope" })
    expect((await PATCH(bad)).status).toBe(400)
    expect(updates()).toHaveLength(0)
    expect(rpcMock).not.toHaveBeenCalled()
  })
})

describe("PATCH unflag", () => {
  it.each([[undefined], [""], ["   "], ["x".repeat(201)], [5]])("400 reason_required for %s", async (reason) => {
    const res = await PATCH(req("PATCH", { action: "unflag", transactionId: TX, reason }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("reason_required")
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("calls the unflag function with the trimmed reason and admin", async () => {
    rpcMock.mockResolvedValue({ data: "unflagged", error: null })
    const res = await PATCH(req("PATCH", { action: "unflag", transactionId: TX, reason: "  checked  " }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "unflagged" })
    expect(rpcMock).toHaveBeenCalledWith("admin_unflag_momo_transaction", { p_txid: TX, p_admin: ADMIN, p_reason: "checked" })
  })

  it("409 when the function says BAD_STATE", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "BAD_STATE", code: "P0001" } })
    expect((await PATCH(req("PATCH", { action: "unflag", transactionId: TX, reason: "r" }))).status).toBe(409)
  })

  it("404 when NOT_FOUND", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: "NOT_FOUND", code: "P0001" } })
    expect((await PATCH(req("PATCH", { action: "unflag", transactionId: TX, reason: "r" }))).status).toBe(404)
  })
})

describe("PATCH credit (Approve & credit)", () => {
  it("requires a reason", async () => {
    const res = await PATCH(req("PATCH", { action: "credit", transactionId: TX }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("reason_required")
  })

  it("credits the linked session's user with p_amount null", async () => {
    const res = await PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok", targetUserId: "ignored-body-value" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "credited" })
    expect(rpcMock).toHaveBeenCalledWith("admin_credit_momo_transaction", {
      p_txid: TX, p_target_user: USER, p_admin: ADMIN, p_reason: "ok", p_amount: null,
    })
  })

  it("409 no_linked_session when the row has no session", async () => {
    setWorld({ txSession: { session_id: null } })
    const res = await PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok" }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("no_linked_session")
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("409 no_linked_session when the session is gone; 404 when the row is unknown", async () => {
    setWorld({ session: null })
    expect((await PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok" }))).status).toBe(409)
    setWorld({ txSession: null })
    expect((await PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok" }))).status).toBe(404)
  })

  it("passes through already_credited", async () => {
    rpcMock.mockResolvedValue({ data: "already_credited", error: null })
    const res = await PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "already_credited" })
  })
})

describe("PATCH assign (Assign to user)", () => {
  const assign = (extra: Record<string, unknown> = {}) =>
    PATCH(req("PATCH", { action: "assign", transactionId: TX, reason: "why", targetUserId: USER, ...extra }))

  it("requires a reason", async () => {
    const res = await assign({ reason: " " })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("reason_required")
  })

  it.each([[undefined], ["nope"], [5]])("400 unknown_user for targetUserId %s without touching the DB", async (t) => {
    const res = await assign({ targetUserId: t })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown_user")
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("400 unknown_user when no such public.users row", async () => {
    setWorld({ userExists: false })
    const res = await assign()
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown_user")
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it("credits any existing user, amount null by default", async () => {
    const res = await assign()
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith("admin_credit_momo_transaction", {
      p_txid: TX, p_target_user: USER, p_admin: ADMIN, p_reason: "why", p_amount: null,
    })
  })

  it("passes a valid GHS amount", async () => {
    await assign({ amount: 25.5 })
    expect(rpcMock.mock.calls[0][1].p_amount).toBe(25.5)
  })

  it.each([[0], [-1], [10.123], ["10"], [true], [1e7]])("400 invalid_amount for amount %s", async (amount) => {
    const res = await assign({ amount })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_amount")
    expect(rpcMock).not.toHaveBeenCalled()
  })
})

describe("credit RPC error mapping", () => {
  const credit = () => PATCH(req("PATCH", { action: "credit", transactionId: TX, reason: "ok" }))
  const raise = (message: string) => rpcMock.mockResolvedValue({ data: null, error: { message, code: "P0001", details: "raw detail" } })

  it.each([
    ["BAD_INPUT", 400, "bad_input"],
    ["NO_WALLET", 400, "no_wallet"],
    ["BAD_STATE", 409, "invalid_state"],
    ["CONFLICT", 409, "conflict"],
    ["NOT_FOUND", 404, "not_found"],
  ])("%s -> %i %s", async (msg, status, code) => {
    raise(msg)
    const res = await credit()
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(code)
  })

  it("anything else -> 500 credit_failed with no raw text", async () => {
    raise("some weird internal error")
    const res = await credit()
    expect(res.status).toBe(500)
    const j = await res.json()
    expect(j).toEqual({ error: "credit_failed" })
  })

  it("a thrown rpc -> 500 credit_failed", async () => {
    rpcMock.mockRejectedValue(new Error("boom " + TX))
    const res = await credit()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("credit_failed")
  })

  it("an unexpected rpc result -> 500 credit_failed", async () => {
    rpcMock.mockResolvedValue({ data: "weird", error: null })
    expect((await credit()).status).toBe(500)
  })
})
