import { describe, it, expect, vi, afterEach } from "vitest"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { parseSmsSendBody, smsHash } from "../sms-rules"
import {
  handleSmsSend,
  handleSmsBalance,
  handleSmsSenders,
  handleSmsCampaigns,
  handleSmsCampaign,
  MSG_SMS_NOT_FOUND,
  MSG_SMS_OUTCOME_UNKNOWN,
  type SmsDeps,
} from "./sms"

// Unique test phones for this file: 0249991060-0249991069.
const P1 = "0249991060"
const P2 = "0249991061"
const P3 = "0249991062"
const MESSAGE = "Secret promo text for tests"
const SENDER = "ACMEBRAND"
const NOW_MS = Date.parse("2026-10-27T10:00:00.000Z")

const ctxOf = (environment: "live" | "test"): V2Context => ({
  keyId: environment === "live" ? "key-live-1" : "key-test-1",
  userId: "user-1",
  role: "dealer",
  keyType: "sms",
  environment,
  firstName: null,
})
const LIVE = ctxOf("live")
const TEST = ctxOf("test")

const body = (over: Record<string, unknown> = {}) => ({
  reference: "SMS-1060",
  message: MESSAGE,
  recipients: [P1, P2],
  ...over,
})

const ENGINE_OK = {
  ok: true,
  batches: 1,
  totalQueued: 2,
  segments: 1,
  creditsReserved: 2,
  invalidSkipped: 0,
  partial: false,
  held: false,
  scheduled: false,
  scheduledFor: null,
  sendLogId: "77",
}

const ACCOUNT = { id: "acc-1", user_id: "user-1", unit_balance: 50, status: "active", default_sender_id: null }

const LOG = {
  id: 77,
  status: "sent",
  message: MESSAGE,
  sender_id: SENDER,
  recipients_count: 2,
  segments: 1,
  credits_reserved: 2,
  credits_used: 2,
  created_at: "2026-10-27T09:00:00Z",
  completed_at: "2026-10-27T09:01:00Z",
  scheduled_for: null,
  source: "campaign",
  sms_account_id: "acc-1",
}

function claimTable() {
  type Row = { id: string; userId: string; reference: string; hash: string; status: string; orderRef: string | null; response: unknown }
  const rows = new Map<string, Row>()
  let n = 0
  const key = (u: string, r: string) => `${u}|${r}`
  return {
    rows,
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "sms"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
      const k = key(p.userId, p.reference)
      const row = rows.get(k)
      if (!row) {
        const id = `claim-${++n}`
        rows.set(k, { id, userId: p.userId, reference: p.reference, hash: p.requestHash, status: "in_progress", orderRef: null, response: null })
        return { kind: "claimed", claimId: id }
      }
      if (row.hash !== p.requestHash) return { kind: "conflict" }
      if (row.status === "done") return { kind: "replay", orderRef: row.orderRef!, response: row.response }
      if (row.status === "unknown") return { kind: "unknown" }
      return { kind: "in_progress" }
    }),
    complete: vi.fn(async (claimId: string, orderRef: string, response: unknown, userId?: string) => {
      for (const r of rows.values()) {
        if (r.id === claimId && r.status === "in_progress" && (userId === undefined || r.userId === userId)) {
          Object.assign(r, { status: "done", orderRef, response })
          return true
        }
      }
      return false
    }),
    release: vi.fn(async (claimId: string, userId?: string) => {
      for (const [k, r] of rows) {
        if (r.id === claimId && r.status === "in_progress" && (userId === undefined || r.userId === userId)) {
          rows.delete(k)
          return true
        }
      }
      return false
    }),
    markUnknown: vi.fn(async (claimId: string, userId?: string, orderRef?: string) => {
      for (const r of rows.values()) {
        if (r.id === claimId && r.status === "in_progress" && (userId === undefined || r.userId === userId)) {
          r.status = "unknown"
          if (orderRef) r.orderRef = orderRef
          return true
        }
      }
      return false
    }),
  }
}

function makeDeps() {
  const table = claimTable()
  const deps = {
    claim: table.claim,
    complete: table.complete,
    release: table.release,
    markUnknown: table.markUnknown,
    alert: vi.fn(async (_m: string): Promise<void> => {}),
    getOrCreateAccount: vi.fn(async (_u: string): Promise<any> => ACCOUNT),
    lookupAccount: vi.fn(async (_u: string): Promise<any> => ACCOUNT),
    resolveSender: vi.fn(async (_a: any, requested: string | null): Promise<string | null> => requested ?? SENDER),
    shopTokens: vi.fn(async (_a: any): Promise<any> => ({ shop_name: "", shop_link: "", shop_phone: "", shop_whatsapp: "" })),
    engine: vi.fn(async (_p: any): Promise<unknown> => ENGINE_OK),
    listCampaigns: vi.fn(async (_a: string, _i: { status: string; page: number }): Promise<any> => ({
      rows: [LOG],
      total: 1,
      page: 1,
      pageSize: 25,
    })),
    getCampaign: vi.fn(async (_a: string, _id: number): Promise<any> => ({
      log: LOG,
      messages: [{ id: 1, phone: "+233249991060", status: "sent", delivery_status: "delivered", refunded: false, last_error: "boom" }],
      counts: { delivered: 1, failed: 0, pending: 0, refunded: 0 },
    })),
    listSenders: vi.fn(async (_a: string): Promise<any[]> => [
      { id: "s1", sender_id: SENDER, local_status: "active", created_at: "2026-10-01T00:00:00Z" },
    ]),
    pendingUnits: vi.fn(async (_a: string) => 3),
    now: () => NOW_MS,
  }
  return { deps: deps satisfies SmsDeps, table }
}
type Deps = ReturnType<typeof makeDeps>["deps"]

const data = (r: { data?: unknown }) => r.data as any

function liveDepsUntouched(deps: Deps) {
  for (const f of [
    deps.claim, deps.complete, deps.release, deps.markUnknown, deps.alert, deps.getOrCreateAccount, deps.lookupAccount,
    deps.resolveSender, deps.shopTokens, deps.engine, deps.listCampaigns, deps.getCampaign, deps.listSenders, deps.pendingUnits,
  ]) {
    expect(f).not.toHaveBeenCalled()
  }
}

function logSpies() {
  return [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ]
}

function noSecrets(spies: { mock: { calls: unknown[][] } }[], deps?: Deps, extra: unknown[] = []) {
  const logged = JSON.stringify(spies.map((s) => s.mock.calls))
  const alerts = deps ? JSON.stringify(deps.alert.mock.calls) : ""
  const rest = JSON.stringify(extra)
  for (const s of [P1, P2, P3, MESSAGE, SENDER]) {
    expect(logged).not.toContain(s)
    expect(alerts).not.toContain(s)
    expect(rest).not.toContain(s)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- send: happy path

describe("POST /sms/send (live)", () => {
  it("claims (kind sms, request hash), resolves account+sender, calls the engine ONCE with the ORIGINAL strings, completes, 201", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsSend(deps)(body({ recipients: [P1, "+233249991061", P1] }), LIVE)
    expect(r.status).toBe(201)
    const parsed = parseSmsSendBody(body({ recipients: [P1, "+233249991061", P1] }), new Date(NOW_MS))
    if (!parsed.ok) throw new Error("fixture")
    expect(deps.claim).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      kind: "sms",
      reference: "SMS-1060",
      requestHash: smsHash(parsed.value),
    })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    const p = deps.engine.mock.calls[0][0]
    expect(p).toMatchObject({ userId: "user-1", accountId: "acc-1", message: MESSAGE, recipients: [P1, "+233249991061"], senderId: SENDER })
    expect(p.scheduledFor).toBeUndefined()
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.complete.mock.calls[0][1]).toBe("77")
    expect(deps.complete.mock.calls[0][3]).toBe("user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    const order = [deps.claim, deps.getOrCreateAccount, deps.resolveSender, deps.shopTokens, deps.engine, deps.complete].map(
      (f) => f.mock.invocationCallOrder[0]
    )
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("201 { send } is the allow-listed summary (no body, recipients, sender) and the stored claim response is the same", async () => {
    const { deps, table } = makeDeps()
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(Object.keys(data(r).send).sort()).toEqual(
      ["batches", "campaign_id", "credits_reserved", "held", "invalid_skipped", "partial", "scheduled", "scheduled_for", "segments", "status", "stopped_reason", "total"].sort()
    )
    expect(data(r).send).toMatchObject({ campaign_id: "77", status: "queued", total: 2, partial: false })
    expect(data(r).replayed).toBeUndefined()
    const stored = JSON.stringify([...table.rows.values()][0].response)
    for (const s of [MESSAGE, P1, P2, SENDER]) {
      expect(JSON.stringify(r)).not.toContain(s)
      expect(stored).not.toContain(s)
    }
  })

  it("passes a requested sender_id (trimmed) to the resolver and a scheduled instant to the engine", async () => {
    const { deps } = makeDeps()
    const at = new Date(NOW_MS + 60 * 60_000).toISOString()
    const r = await handleSmsSend(deps)(body({ sender_id: "  MYBRAND ", scheduled_at: at }), LIVE)
    expect(r.status).toBe(201)
    expect(deps.resolveSender.mock.calls[0][1]).toBe("MYBRAND")
    expect(deps.engine.mock.calls[0][0].scheduledFor).toEqual(new Date(at))
  })

  it("held and scheduled results surface in the summary; multi-batch keeps the FIRST campaign id and the batch count", async () => {
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ ...ENGINE_OK, batches: 3, totalQueued: 1200, creditsReserved: 1200, held: true, sendLogId: "90" })
    const r = await handleSmsSend(deps)(body({ reference: "SMS-HELD" }), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).send).toMatchObject({ campaign_id: "90", status: "held", held: true, batches: 3, total: 1200 })
  })

  it("a partial success is done (charged for what went out) and reports partial + stopped_reason", async () => {
    const { deps, table } = makeDeps()
    deps.engine.mockResolvedValueOnce({ ...ENGINE_OK, batches: 1, partial: true, stoppedReason: "INSUFFICIENT_CREDITS" })
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).send).toMatchObject({ partial: true, stopped_reason: "INSUFFICIENT_CREDITS" })
    expect([...table.rows.values()][0].status).toBe("done")
  })

  it("never passes a provider, price or credits field to the engine", async () => {
    const { deps } = makeDeps()
    await handleSmsSend(deps)(body(), LIVE)
    expect(Object.keys(deps.engine.mock.calls[0][0]).sort()).toEqual(
      ["accountId", "message", "recipients", "senderId", "tokens", "userId"].sort()
    )
  })
})

// ---------------------------------------------------------------- send: replay / claims

describe("POST /sms/send: reference handling", () => {
  it("a retry of a scheduled send replays even after the scheduled time has passed (no lead-time check)", async () => {
    const { deps } = makeDeps()
    const b = body({ scheduled_at: new Date(NOW_MS + 5 * 60_000).toISOString() })
    expect((await handleSmsSend(deps)(b, LIVE)).status).toBe(201)
    deps.now = () => NOW_MS + 60 * 60_000
    const again = await handleSmsSend(deps)(b, LIVE)
    expect(again.status).toBe(200)
    expect(data(again).replayed).toBe(true)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("a past-time retry meets in_progress / unknown / conflict claims, not a 400", async () => {
    const at = new Date(NOW_MS - 60 * 60_000).toISOString()
    for (const [kind, status] of [["in_progress", 409], ["unknown", 409], ["conflict", 409]] as const) {
      const { deps } = makeDeps()
      deps.claim = vi.fn(async () => ({ kind }) as any)
      const r = await handleSmsSend(deps)(body({ scheduled_at: at }), LIVE)
      expect(r.status, kind).toBe(status)
      expect(deps.engine).not.toHaveBeenCalled()
    }
  })

  it("a fresh send with a 1 minute lead is 400, the claim is released and nothing is sent", async () => {
    const { deps, table } = makeDeps()
    const r = await handleSmsSend(deps)(body({ scheduled_at: new Date(NOW_MS + 60_000).toISOString() }), LIVE)
    expect(r.status).toBe(400)
    expect(r.error?.message).toBe("Pick a time at least 2 minutes from now")
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.getOrCreateAccount).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("the sandbox still enforces the minimum lead", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsSend(deps)(body({ scheduled_at: new Date(NOW_MS + 60_000).toISOString() }), TEST)
    expect(r.status).toBe(400)
    expect(r.error?.message).toBe("Pick a time at least 2 minutes from now")
  })

  it("a repeat of the same request replays the stored summary with replayed:true and never re-runs the engine", async () => {
    const { deps } = makeDeps()
    await handleSmsSend(deps)(body(), LIVE)
    const again = await handleSmsSend(deps)(body({ recipients: ["+233249991061", P1] }), LIVE)
    expect(again.status).toBe(200)
    expect(data(again).replayed).toBe(true)
    expect(data(again).send).toMatchObject({ campaign_id: "77", total: 2 })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.getOrCreateAccount).toHaveBeenCalledTimes(1)
  })

  it("same reference, different request => 409 conflict, engine untouched", async () => {
    const { deps } = makeDeps()
    await handleSmsSend(deps)(body(), LIVE)
    const r = await handleSmsSend(deps)(body({ message: "A different message" }), LIVE)
    expect(r.status).toBe(409)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("in_progress and unknown claims => 409 with fixed machine-coded messages; the engine is not called", async () => {
    const a = makeDeps()
    a.deps.claim.mockResolvedValueOnce({ kind: "in_progress" })
    const r1 = await handleSmsSend(a.deps)(body(), LIVE)
    expect(r1.status).toBe(409)
    expect(r1.error?.message).toMatch(/^REQUEST_IN_PROGRESS:/)
    const b = makeDeps()
    b.deps.claim.mockResolvedValueOnce({ kind: "unknown" })
    const r2 = await handleSmsSend(b.deps)(body(), LIVE)
    expect(r2.status).toBe(409)
    expect(r2.error?.message).toMatch(/^OUTCOME_UNKNOWN:/)
    expect(a.deps.engine).not.toHaveBeenCalled()
    expect(b.deps.engine).not.toHaveBeenCalled()
  })

  it("a claim error or throw => 503, nothing reserved, engine untouched", async () => {
    const a = makeDeps()
    a.deps.claim.mockResolvedValueOnce({ kind: "error" })
    expect((await handleSmsSend(a.deps)(body(), LIVE)).status).toBe(503)
    const b = makeDeps()
    b.deps.claim.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsSend(b.deps)(body(), LIVE)).status).toBe(503)
    expect(a.deps.engine).not.toHaveBeenCalled()
    expect(b.deps.engine).not.toHaveBeenCalled()
  })

  it("a bad body is 400 before ANY dependency is touched", async () => {
    for (const b of [undefined, null, "x", [], body({ reference: "ab" }), body({ message: "hi" }), body({ recipients: [] }), body({ provider: "moolre" })]) {
      const { deps } = makeDeps()
      const r = await handleSmsSend(deps)(b, LIVE)
      expect(r.status).toBe(400)
      liveDepsUntouched(deps)
    }
  })
})

// ---------------------------------------------------------------- send: pre-engine failures

describe("POST /sms/send: failures before the engine release the reference", () => {
  it("no SMS account => 403 and the claim is released", async () => {
    const { deps, table } = makeDeps()
    deps.getOrCreateAccount.mockResolvedValueOnce(null)
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(table.rows.size).toBe(0)
  })

  it("account lookup throws => 503, released", async () => {
    const { deps, table } = makeDeps()
    deps.getOrCreateAccount.mockRejectedValueOnce(new Error("db"))
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(table.rows.size).toBe(0)
    expect(deps.engine).not.toHaveBeenCalled()
  })

  it("no resolvable sender => the engine is still called with senderId undefined (v1 parity: platform sender fallback), hash uses the input sender or null", async () => {
    const { deps } = makeDeps()
    deps.resolveSender.mockResolvedValueOnce(null)
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.engine.mock.calls[0][0].senderId).toBeUndefined()
    const parsed = parseSmsSendBody(body(), new Date(NOW_MS))
    if (!parsed.ok) throw new Error("parse")
    expect(deps.claim.mock.calls[0][0].requestHash).toBe(smsHash(parsed.value))
    expect(parsed.value.senderId).toBeNull()
  })

  it("an engine INVALID_SENDER_ID (no sender, or a requested one the account does not own) is a mapped 400 and frees the reference", async () => {
    const { deps, table } = makeDeps()
    deps.resolveSender.mockResolvedValueOnce(null)
    deps.engine.mockResolvedValueOnce({ ok: false, error: "INVALID_SENDER_ID" })
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(400)
    expect(r.error?.message).toMatch(/^INVALID_SENDER_ID:/)
    expect(table.rows.size).toBe(0)
  })

  it("sender resolver or token lookup throws => 503, released, engine untouched", async () => {
    const a = makeDeps()
    a.deps.resolveSender.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsSend(a.deps)(body(), LIVE)).status).toBe(503)
    expect(a.table.rows.size).toBe(0)
    const b = makeDeps()
    b.deps.shopTokens.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsSend(b.deps)(body(), LIVE)).status).toBe(503)
    expect(b.table.rows.size).toBe(0)
    expect(a.deps.engine).not.toHaveBeenCalled()
    expect(b.deps.engine).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- send: engine failures

describe("POST /sms/send: engine outcomes", () => {
  it.each([
    ["INSUFFICIENT_CREDITS", 402],
    ["NOT_ACTIVATED", 403],
    ["SUSPENDED", 403],
    ["INVALID_SENDER_ID", 400],
    ["BLOCKED", 400],
    ["SMS_DISABLED", 503],
    ["SEND_IN_PROGRESS", 429],
    ["NO_VALID_RECIPIENTS", 400],
  ])("returned %s => release the claim and map to %i, no alert", async (error, status) => {
    const { deps, table } = makeDeps()
    deps.engine.mockResolvedValueOnce({ ok: false, error })
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(status)
    expect(r.error?.message).toContain(`${error}:`)
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("returned ENQUEUE_FAILED => claim marked unknown, urgent alert, 500 OUTCOME_UNKNOWN, never released", async () => {
    logSpies()
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ ok: false, error: "ENQUEUE_FAILED" })
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(r.error?.message).toContain("OUTCOME_UNKNOWN:")
    expect(r.error?.message).not.toContain("SEND_FAILED")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.alert).toHaveBeenCalledTimes(1)
  })

  it("a throw => claim marked unknown, urgent alert, 500 OUTCOME_UNKNOWN, never released, no secrets anywhere", async () => {
    const spies = logSpies()
    const { deps, table } = makeDeps()
    deps.engine.mockRejectedValueOnce(new Error(`boom ${P1} ${MESSAGE} ${SENDER}`))
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(r.error?.message).toBe(MSG_SMS_OUTCOME_UNKNOWN)
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledTimes(1)
    expect([...table.rows.values()][0].status).toBe("unknown")
    noSecrets(spies, deps, [r])
    // and a retry with the same reference cannot re-run the engine
    const again = await handleSmsSend(deps)(body(), LIVE)
    expect(again.status).toBe(409)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("an unrecognised shape (or a bare ok:true-less value) is ambiguous, never released", async () => {
    for (const weird of [undefined, null, "ok", { error: "NEW_ERROR" }, { ok: false, error: "NEW_ERROR" }]) {
      const { deps } = makeDeps()
      deps.engine.mockResolvedValueOnce(weird)
      const r = await handleSmsSend(deps)(body(), LIVE)
      expect(r.status).toBe(500)
      expect(r.error?.message).toBe(MSG_SMS_OUTCOME_UNKNOWN)
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    }
  })

  it("success whose claim cannot be completed still returns 201 but marks the claim unknown and alerts", async () => {
    const { deps } = makeDeps()
    deps.complete.mockResolvedValueOnce(false)
    const spies = logSpies()
    const r = await handleSmsSend(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.alert).toHaveBeenCalledTimes(1)
    noSecrets(spies, deps, [r])
  })

  it("release/markUnknown/alert failures never break the response", async () => {
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ ok: false, error: "SUSPENDED" })
    deps.release.mockRejectedValueOnce(new Error("x"))
    logSpies()
    expect((await handleSmsSend(deps)(body(), LIVE)).status).toBe(403)
    const b = makeDeps()
    b.deps.engine.mockRejectedValueOnce(new Error("x"))
    b.deps.markUnknown.mockRejectedValueOnce(new Error("x"))
    b.deps.alert.mockRejectedValueOnce(new Error("x"))
    expect((await handleSmsSend(b.deps)(body(), LIVE)).status).toBe(500)
  })
})

// ---------------------------------------------------------------- send: sandbox

describe("POST /sms/send (test key): stateless sandbox", () => {
  it("touches no live dependency and returns the allow-listed summary with campaign_id null and sandbox:true", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsSend(deps)(body({ recipients: [P1, P2, P1] }), TEST)
    expect(r.status).toBe(201)
    liveDepsUntouched(deps)
    expect(data(r).sandbox).toBe(true)
    expect(data(r).send).toMatchObject({ campaign_id: null, status: "queued", total: 2, batches: 1, partial: false, held: false, scheduled: false })
  })

  it("echoes a valid schedule and counts batches of 500", async () => {
    const { deps } = makeDeps()
    const at = new Date(NOW_MS + 60 * 60_000).toISOString()
    const many = Array.from({ length: 1200 }, (_, i) => "0244" + String(100000 + i))
    const r = await handleSmsSend(deps)(body({ recipients: many, scheduled_at: at }), TEST)
    expect(data(r).send).toMatchObject({ status: "scheduled", scheduled: true, scheduled_for: at, total: 1200, batches: 3 })
  })

  it("validates exactly like live (bad body => 400)", async () => {
    const { deps } = makeDeps()
    expect((await handleSmsSend(deps)(body({ message: "hi" }), TEST)).status).toBe(400)
  })
})

// ---------------------------------------------------------------- balance / senders

describe("GET /sms/balance", () => {
  it("returns the allow-listed balance from a read-only account lookup (never creates an account)", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsBalance(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(data(r)).toEqual({ balance: { credits: 50, pending_credits: 3, status: "active" } })
    expect(deps.lookupAccount).toHaveBeenCalledWith("user-1")
    expect(deps.pendingUnits).toHaveBeenCalledWith("acc-1")
    expect(deps.getOrCreateAccount).not.toHaveBeenCalled()
  })

  it("no account => 403; read failure => 503; pending failure => 503", async () => {
    const a = makeDeps()
    a.deps.lookupAccount.mockResolvedValueOnce(null)
    expect((await handleSmsBalance(a.deps)(LIVE)).status).toBe(403)
    const b = makeDeps()
    b.deps.lookupAccount.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsBalance(b.deps)(LIVE)).status).toBe(503)
    const c = makeDeps()
    c.deps.pendingUnits.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsBalance(c.deps)(LIVE)).status).toBe(503)
  })

  it("test key: fixed sandbox balance, no live dependency touched", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsBalance(deps)(TEST)
    expect(r.status).toBe(200)
    expect(data(r).sandbox).toBe(true)
    expect(typeof data(r).balance.credits).toBe("number")
    liveDepsUntouched(deps)
  })
})

describe("GET /sms/senders", () => {
  it("maps the account's senders with the default flag", async () => {
    const { deps } = makeDeps()
    deps.lookupAccount.mockResolvedValueOnce({ ...ACCOUNT, default_sender_id: "s1" })
    const r = await handleSmsSenders(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(data(r)).toEqual({ senders: [{ sender_id: SENDER, status: "active", is_default: true, created_at: "2026-10-01T00:00:00Z" }] })
    expect(deps.listSenders).toHaveBeenCalledWith("acc-1")
    expect(deps.getOrCreateAccount).not.toHaveBeenCalled()
  })

  it("no account => 403; failures => 503; test key => sandbox sender, nothing live touched", async () => {
    const a = makeDeps()
    a.deps.lookupAccount.mockResolvedValueOnce(null)
    expect((await handleSmsSenders(a.deps)(LIVE)).status).toBe(403)
    const b = makeDeps()
    b.deps.listSenders.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsSenders(b.deps)(LIVE)).status).toBe(503)
    const c = makeDeps()
    const r = await handleSmsSenders(c.deps)(TEST)
    expect(r.status).toBe(200)
    expect(data(r).sandbox).toBe(true)
    expect(data(r).senders.length).toBe(1)
    liveDepsUntouched(c.deps)
  })
})

// ---------------------------------------------------------------- campaigns

describe("GET /sms/campaigns", () => {
  it("lists owner-scoped, 25 per page, mapped through the allow-list (no message body, no account id)", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsCampaigns(deps)({ page: null, status: null }, LIVE)
    expect(r.status).toBe(200)
    expect(deps.listCampaigns).toHaveBeenCalledWith("acc-1", { status: "", page: 1 })
    expect(data(r)).toMatchObject({ page: 1, page_size: 25, total: 1, has_more: false })
    expect(data(r).campaigns[0]).toMatchObject({ campaign_id: "77", status: "sent", recipient_count: 2 })
    const text = JSON.stringify(r)
    for (const s of [MESSAGE, "acc-1", "sms_account_id", "source"]) expect(text).not.toContain(s)
    expect(deps.getOrCreateAccount).not.toHaveBeenCalled()
  })

  it("passes a valid page and status; has_more reflects the total", async () => {
    const { deps } = makeDeps()
    deps.listCampaigns.mockResolvedValueOnce({ rows: [LOG], total: 80, page: 2, pageSize: 25 })
    const r = await handleSmsCampaigns(deps)({ page: "2", status: "failed" }, LIVE)
    expect(deps.listCampaigns).toHaveBeenCalledWith("acc-1", { status: "failed", page: 2 })
    expect(data(r)).toMatchObject({ page: 2, total: 80, has_more: true })
  })

  it.each([["0"], ["-1"], ["1.5"], ["abc"], ["9999999"], [" 2"]])("invalid page %j => 400, nothing read", async (page) => {
    const { deps } = makeDeps()
    const r = await handleSmsCampaigns(deps)({ page, status: null }, LIVE)
    expect(r.status).toBe(400)
    liveDepsUntouched(deps)
  })

  it("unknown status => 400", async () => {
    const { deps } = makeDeps()
    expect((await handleSmsCampaigns(deps)({ page: null, status: "cancelled" }, LIVE)).status).toBe(400)
    expect((await handleSmsCampaigns(deps)({ page: null, status: "'; drop" }, LIVE)).status).toBe(400)
    liveDepsUntouched(deps)
  })

  it("no account => an empty list; read failure => 503; test key => empty sandbox list", async () => {
    const a = makeDeps()
    a.deps.lookupAccount.mockResolvedValueOnce(null)
    const r = await handleSmsCampaigns(a.deps)({ page: null, status: null }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r)).toMatchObject({ campaigns: [], total: 0, has_more: false })
    const b = makeDeps()
    b.deps.listCampaigns.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsCampaigns(b.deps)({ page: null, status: null }, LIVE)).status).toBe(503)
    const c = makeDeps()
    const t = await handleSmsCampaigns(c.deps)({ page: null, status: null }, TEST)
    expect(data(t)).toMatchObject({ campaigns: [], sandbox: true })
    liveDepsUntouched(c.deps)
  })
})

describe("GET /sms/campaigns/{campaignId}", () => {
  it("returns the allow-listed detail with E.164 recipients and no provider internals", async () => {
    const { deps } = makeDeps()
    const r = await handleSmsCampaign(deps)("77", LIVE)
    expect(r.status).toBe(200)
    expect(deps.getCampaign).toHaveBeenCalledWith("acc-1", 77)
    const c = data(r).campaign
    expect(c).toMatchObject({ campaign_id: "77", status: "sent", delivery: { delivered: 1, failed: 0, pending: 0, refunded: 0 } })
    expect(c.recipients).toEqual([{ phone: "+233249991060", status: "delivered", refunded: false }])
    const text = JSON.stringify(r)
    for (const s of [MESSAGE, "boom", "last_error", "acc-1"]) expect(text).not.toContain(s)
  })

  it("missing, foreign and malformed ids all give the IDENTICAL 404", async () => {
    const missing = makeDeps()
    missing.deps.getCampaign.mockResolvedValueOnce(null)
    const a = await handleSmsCampaign(missing.deps)("78", LIVE)
    const noAcct = makeDeps()
    noAcct.deps.lookupAccount.mockResolvedValueOnce(null)
    const b = await handleSmsCampaign(noAcct.deps)("77", LIVE)
    expect(a.status).toBe(404)
    expect(a.error?.message).toBe(MSG_SMS_NOT_FOUND)
    expect(b).toEqual(a)
    for (const id of ["", "0", "-1", "1.5", "abc", "07", "1e3", "9".repeat(20), "77 ", "77/../78"]) {
      const { deps } = makeDeps()
      const r = await handleSmsCampaign(deps)(id, LIVE)
      expect(r).toEqual(a)
      expect(deps.getCampaign).not.toHaveBeenCalled()
    }
  })

  it("scopes by the CALLER's account id, never by anything in the path", async () => {
    const { deps } = makeDeps()
    deps.lookupAccount.mockResolvedValueOnce({ ...ACCOUNT, id: "acc-other" })
    await handleSmsCampaign(deps)("77", LIVE)
    expect(deps.getCampaign).toHaveBeenCalledWith("acc-other", 77)
  })

  it("read failure => 503; test key => 404 with nothing live touched", async () => {
    const a = makeDeps()
    a.deps.getCampaign.mockRejectedValueOnce(new Error("db"))
    expect((await handleSmsCampaign(a.deps)("77", LIVE)).status).toBe(503)
    const b = makeDeps()
    const r = await handleSmsCampaign(b.deps)("77", TEST)
    expect(r.status).toBe(404)
    liveDepsUntouched(b.deps)
  })
})
