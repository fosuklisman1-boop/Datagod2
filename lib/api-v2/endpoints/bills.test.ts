import { describe, it, expect, vi, afterEach } from "vitest"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { billHash, parseBillPayBody } from "../commission"
import { resolveBillsConfig, type BillsConfig } from "@/lib/bills/config"
import { BILLER_KEYS } from "@/lib/bills/billers"
import { sandboxVerify, sandboxBillReference } from "@/lib/api-v1/bills"
import type { BillOrderRow, PayResult, VerifyResult } from "@/lib/bills/service"
import {
  billersHandler,
  billLookupHandler,
  billPayHandler,
  billOrderHandler,
  MSG_BILL_NOT_FOUND,
  MSG_BILL_OUTCOME_UNKNOWN,
  MSG_TOKEN_REUSED,
  type BillsV2Deps,
  type BillPayEngineParams,
  type BillOrderV2Row,
  type BillSandboxOrder,
} from "./bills"

// ---------------------------------------------------------------- fixtures

// Unique test data for this file: phones 0249990701-0249990799, meters 80000007xx.
const PHONE = "0249990701"
const METER = "8000000701"
const SMARTCARD = "8000000702"

const ORDER_KEYS = [
  "account",
  "biller",
  "cashback",
  "created_at",
  "customer_name",
  "face_amount",
  "paid_amount",
  "reference",
  "status",
].sort()

const CREATED = "2026-10-24T10:00:00.000Z"
const NOW_MS = Date.parse("2026-10-24T10:00:05.000Z")

const ctxOf = (environment: "live" | "test"): V2Context => ({
  keyId: environment === "live" ? "key-live-1" : "key-test-1",
  userId: "user-1",
  role: "dealer",
  keyType: "commission",
  environment,
  firstName: null,
})
const LIVE = ctxOf("live")
const TEST = ctxOf("test")

// A live engine token is base64url(JSON).hmac: it starts "eyJ", never "sandbox_bill.".
const LIVE_TOKEN = "eyJ1c2VySWQiOiJ1c2VyLTEifQ.0123456789abcdef0123456789abcdef"
const LIVE_TOKEN_2 = "eyJ1c2VySWQiOiJ1c2VyLTIifQ.fedcba9876543210fedcba9876543210"

const payBody = (over: Record<string, unknown> = {}) => ({
  verify_token: LIVE_TOKEN,
  amount: 50,
  reference: "BILL-0701",
  ...over,
})

function sandboxToken(userId = "user-1", account = SMARTCARD): string {
  const r = sandboxVerify(userId, "dstv", { account, addMeter: false, consent: false })
  if (!r.ok || !r.body.verify_token) throw new Error("fixture")
  return r.body.verify_token
}

/** The full engine row: internal columns must never leave the API. */
function engineRow(over: Partial<BillOrderRow> & Record<string, unknown> = {}): BillOrderRow {
  return {
    id: "bill-uuid-1",
    reference_code: "BILL-ENGINE-1",
    user_id: "user-1",
    channel: "api",
    biller: "dstv",
    account_number: SMARTCARD,
    phone: "233249990701",
    email: "hidden@example.com",
    broadband_account: null,
    session_id: "sess-secret",
    customer_name: "Kofi Test",
    verified: true,
    amount: 50,
    status: "processing",
    payment_status: "paid",
    hubtel_client_reference: "HUBTEL-SECRET-REF",
    commission: 1.25,
    failure_reason: "internal reason",
    notes: "internal notes",
    created_at: CREATED,
    updated_at: CREATED,
    paid_amount: 49.5,
    cashback_amount: 0.5,
    ...over,
  } as BillOrderRow
}

function liveRow(over: Partial<BillOrderV2Row> = {}): BillOrderV2Row {
  return {
    reference_code: "BILL-ENGINE-1",
    biller: "dstv",
    account_number: SMARTCARD,
    customer_name: "Kofi Test",
    amount: 50,
    paid_amount: 49.5,
    cashback_amount: 0.5,
    status: "completed",
    created_at: CREATED,
    ...over,
  }
}

const allOn = (): BillsConfig =>
  resolveBillsConfig({ enabled: true, billers: Object.fromEntries(BILLER_KEYS.map((k) => [k, { enabled: true, min: 5, max: 1000 }])) })

/** In-memory claim table honouring the UNIQUE (user, kind, reference) constraint. */
function claimTable() {
  type Row = { id: string; userId: string; reference: string; hash: string; status: string; orderRef: string | null; response: unknown }
  const rows = new Map<string, Row>()
  let n = 0
  const key = (u: string, r: string) => `${u}|${r}`
  const find = (claimId: string, userId?: string) =>
    [...rows.entries()].find(([, r]) => r.id === claimId && r.status === "in_progress" && (userId === undefined || r.userId === userId))
  return {
    rows,
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "bill"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
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
      const hit = find(claimId, userId)
      if (!hit) return false
      Object.assign(hit[1], { status: "done", orderRef, response })
      return true
    }),
    release: vi.fn(async (claimId: string, userId?: string) => {
      const hit = find(claimId, userId)
      if (!hit) return false
      rows.delete(hit[0])
      return true
    }),
    markUnknown: vi.fn(async (claimId: string, userId?: string) => {
      const hit = find(claimId, userId)
      if (!hit) return false
      hit[1].status = "unknown"
      return true
    }),
    findClaimByOrderRef: vi.fn(async (userId: string, orderRef: string) =>
      [...rows.values()].filter((r) => r.userId === userId && r.orderRef === orderRef).map((r) => ({ reference: r.reference, status: r.status }))
    ),
  }
}

function makeDeps() {
  const table = claimTable()
  const deps = {
    claim: table.claim,
    complete: table.complete,
    release: table.release,
    markUnknown: table.markUnknown,
    findClaimByOrderRef: table.findClaimByOrderRef as ReturnType<typeof vi.fn<(u: string, o: string) => Promise<{ reference: string; status: string }[] | null>>>,
    getClaim: vi.fn(async (_u: string, _r: string): Promise<{ orderRef: string | null; status: string; response: unknown } | null> => null),
    surfaceOpen: vi.fn(async () => true),
    phoneGate: vi.fn(async (_u: string) => true),
    getBillsConfig: vi.fn(async (): Promise<BillsConfig> => allOn()),
    verify: vi.fn(
      async (_u: string, _b: string, _i: Record<string, unknown>): Promise<VerifyResult> => ({
        ok: true,
        customerName: "Kofi Test",
        amountDue: 42.5,
        suggestedAmount: 42.5,
        token: LIVE_TOKEN,
      })
    ),
    pay: vi.fn(async (_p: BillPayEngineParams): Promise<{ result: PayResult; fresh: boolean }> => ({
      result: { ok: true, order: engineRow() },
      fresh: true,
    })),
    getOrderByCode: vi.fn(async (_u: string, _c: string): Promise<BillOrderV2Row | null> => liveRow()),
    sandbox: {
      getOrder: vi.fn(async (_u: string, _r: string): Promise<BillSandboxOrder | null> => null),
      findByTokenRef: vi.fn(async (_u: string, _t: string): Promise<{ reference: string }[] | null> => []),
      place: vi.fn(async (p: any) => ({
        success: true as const,
        order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED },
        newBalance: 50,
      })),
    },
    now: () => NOW_MS,
  }
  return { deps: deps satisfies BillsV2Deps, table }
}

type Deps = ReturnType<typeof makeDeps>["deps"]

function liveDepsUntouched(deps: Deps) {
  for (const f of [
    deps.claim,
    deps.complete,
    deps.release,
    deps.markUnknown,
    deps.findClaimByOrderRef,
    deps.getClaim,
    deps.surfaceOpen,
    deps.phoneGate,
    deps.verify,
    deps.pay,
    deps.getOrderByCode,
  ]) {
    expect(f).not.toHaveBeenCalled()
  }
}

function nothingCalled(deps: Deps) {
  liveDepsUntouched(deps)
  expect(deps.getBillsConfig).not.toHaveBeenCalled()
  expect(deps.sandbox.getOrder).not.toHaveBeenCalled()
  expect(deps.sandbox.findByTokenRef).not.toHaveBeenCalled()
  expect(deps.sandbox.place).not.toHaveBeenCalled()
}

const data = (r: { data?: unknown }) => r.data as any
const msgOf = (r: { error?: { message: string } }) => r.error?.message ?? ""

afterEach(() => {
  vi.restoreAllMocks()
})

function quietErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}

function captureLogs() {
  const lines: string[] = []
  const rec = (...a: unknown[]) => {
    lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
  }
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(rec)
  return lines
}

const parsedHash = (b: Record<string, unknown>) => {
  const p = parseBillPayBody(b)
  if (!p.ok) throw new Error("fixture")
  return billHash(p.value)
}

// ================================================================ POST /utilities/pay (live)

describe("POST /utilities/pay (live): new payment", () => {
  it("claims once, runs surface gate -> phone gate -> engine in order, completes once with the exact args", async () => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.claim).toHaveBeenCalledTimes(1)
    expect(deps.claim).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      kind: "bill",
      reference: "BILL-0701",
      requestHash: parsedHash(payBody()),
    })
    expect(deps.pay).toHaveBeenCalledTimes(1)
    expect(deps.pay).toHaveBeenCalledWith({ userId: "user-1", verifyToken: LIVE_TOKEN, amount: 50, channel: "api" })
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.complete).toHaveBeenCalledWith("claim-1", "BILL-ENGINE-1", data(r).order, "user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    const order = [deps.claim, deps.surfaceOpen, deps.phoneGate, deps.pay, deps.complete].map((f) => f.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("returns 201 { order } with the CLIENT reference and exactly the allow-listed keys", async () => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody(), LIVE)
    const d = data(r)
    expect(Object.keys(d)).toEqual(["order"])
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order).toEqual({
      reference: "BILL-0701",
      biller: "dstv",
      account: SMARTCARD,
      customer_name: "Kofi Test",
      face_amount: 50,
      paid_amount: 49.5,
      cashback: 0.5,
      status: "processing",
      created_at: CREATED,
    })
    const s = JSON.stringify(d)
    for (const secret of ["BILL-ENGINE-1", "bill-uuid-1", "HUBTEL-SECRET-REF", "internal", "sess-secret", "hidden@example.com", "233249990701", "1.25"]) {
      expect(s).not.toContain(secret)
    }
  })

  it("passes expected_pay through and a pesewa-precision amount exactly", async () => {
    const { deps } = makeDeps()
    await billPayHandler(deps)(payBody({ amount: "12.34", expected_pay: "12.10" }), LIVE)
    expect(deps.pay).toHaveBeenCalledWith({ userId: "user-1", verifyToken: LIVE_TOKEN, amount: 12.34, expectedPay: 12.1, channel: "api" })
    const { deps: d2 } = makeDeps()
    await billPayHandler(d2)(payBody({ amount: 0.07 }), LIVE)
    expect(d2.pay.mock.calls[0][0].amount).toBe(0.07)
  })

  it("still answers 201 when the claim cannot be finalised after a successful payment, with a fixed log line", async () => {
    const { deps } = makeDeps()
    deps.complete.mockResolvedValueOnce(false)
    const lines = captureLogs()
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(lines.join("\n")).toContain("[API v2] bills:")
    expect(lines.join("\n")).not.toContain(LIVE_TOKEN)
    expect(lines.join("\n")).not.toContain(SMARTCARD)
  })

  it("a complete() throw after success is still 201", async () => {
    const { deps } = makeDeps()
    deps.complete.mockRejectedValueOnce(new Error("db"))
    quietErrors()
    expect((await billPayHandler(deps)(payBody(), LIVE)).status).toBe(201)
  })
})

describe("POST /utilities/pay (live): body validation happens before any dependency", () => {
  it.each([
    ["price", { price: 1 }],
    ["fee", { fee: 0 }],
    ["fee_amount", { fee_amount: 0 }],
    ["total_paid", { total_paid: 1 }],
    ["cashback", { cashback: 10 }],
    ["cost", { cost: 1 }],
    ["user_id", { user_id: "user-2" }],
    ["status", { status: "completed" }],
  ])("rejects %s", async (_n, extra) => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody(extra), LIVE)
    expect(r.status).toBe(400)
    nothingCalled(deps)
  })

  it.each([
    ["no body", undefined],
    ["array", []],
    ["missing token", { amount: 50, reference: "BILL-0702" }],
    ["short token", payBody({ verify_token: "short" })],
    ["zero amount", payBody({ amount: 0 })],
    ["negative amount", payBody({ amount: -5 })],
    ["3 decimals", payBody({ amount: "1.234" })],
    ["exponent", payBody({ amount: "1e3" })],
    ["above ceiling", payBody({ amount: 10000.01 })],
    ["missing reference", { verify_token: LIVE_TOKEN, amount: 50 }],
    ["bad reference", payBody({ reference: "a b" })],
    ["bad expected_pay", payBody({ expected_pay: "-1" })],
  ])("400 for %s with nothing called", async (_n, b) => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(b, LIVE)
    expect(r.status).toBe(400)
    nothingCalled(deps)
  })

  it("a sandbox token on a live key is 400 before any claim or engine call", async () => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody({ verify_token: sandboxToken() }), LIVE)
    expect(r.status).toBe(400)
    expect(msgOf(r)).toMatch(/^INVALID_TOKEN: /)
    nothingCalled(deps)
  })
})

describe("POST /utilities/pay (live): claim outcomes answer before any gate or engine", () => {
  it("replay of a completed reference: 200 { order, replayed: true }, no gate, no engine, no new claim", async () => {
    const { deps } = makeDeps()
    const first = await billPayHandler(deps)(payBody(), LIVE)
    for (const f of [deps.surfaceOpen, deps.phoneGate, deps.pay, deps.complete]) f.mockClear()
    const again = await billPayHandler(deps)(payBody(), LIVE)
    expect(again.status).toBe(200)
    expect(data(again)).toEqual({ order: data(first).order, replayed: true })
    expect(deps.surfaceOpen).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.pay).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it("a replayed stored response is re-read through the allow-list", async () => {
    const { deps } = makeDeps()
    deps.claim.mockResolvedValueOnce({
      kind: "replay",
      orderRef: "BILL-ENGINE-1",
      response: { ...liveRow(), reference: "X", biller: "dstv", account: SMARTCARD, face_amount: 50, notes: "leak", hubtel_client_reference: "leak" },
    })
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(200)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(data(r).order.reference).toBe("BILL-0701")
    expect(JSON.stringify(data(r))).not.toContain("leak")
  })

  it("same reference with a different amount is 409 REFERENCE_REUSED with no engine call", async () => {
    const { deps } = makeDeps()
    await billPayHandler(deps)(payBody(), LIVE)
    deps.pay.mockClear()
    const r = await billPayHandler(deps)(payBody({ amount: 51 }), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toMatch(/^REFERENCE_REUSED: /)
    expect(deps.pay).not.toHaveBeenCalled()
  })

  it.each([
    ["conflict", { kind: "conflict" }, 409, /^REFERENCE_REUSED: /],
    ["in_progress", { kind: "in_progress" }, 409, /^REQUEST_IN_PROGRESS: /],
    ["unknown", { kind: "unknown" }, 409, /^OUTCOME_UNKNOWN: /],
    ["error", { kind: "error" }, 503, /^UNAVAILABLE: /],
  ] as const)("%s => %i with no gate and no engine call", async (_n, outcome, status, re) => {
    const { deps } = makeDeps()
    deps.claim.mockResolvedValueOnce(outcome as ClaimOutcome)
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(status)
    expect(msgOf(r)).toMatch(re)
    for (const f of [deps.surfaceOpen, deps.phoneGate, deps.pay, deps.complete, deps.release, deps.markUnknown]) {
      expect(f).not.toHaveBeenCalled()
    }
  })

  it("a claim() throw reads as error (503), never reaches the engine", async () => {
    const { deps } = makeDeps()
    deps.claim.mockRejectedValueOnce(new Error("db"))
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(503)
    expect(deps.pay).not.toHaveBeenCalled()
  })
})

describe("POST /utilities/pay (live): gates release the claim and never call the engine", () => {
  it.each([
    ["closed", async () => false],
    ["throws", async () => {
      throw new Error("cfg")
    }],
  ])("surface %s => 403 NOT_AVAILABLE, claim released", async (_n, impl) => {
    const { deps, table } = makeDeps()
    deps.surfaceOpen.mockImplementationOnce(impl as () => Promise<boolean>)
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(403)
    expect(msgOf(r)).toMatch(/^NOT_AVAILABLE: /)
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.pay).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it.each([
    ["blocked", async () => false],
    ["non-true", async () => "yes" as unknown as boolean],
    ["throws", async () => {
      throw new Error("guard")
    }],
  ])("phone gate %s => 403 PHONE_NOT_VERIFIED, claim released", async (_n, impl) => {
    const { deps, table } = makeDeps()
    deps.phoneGate.mockImplementationOnce(impl as (u: string) => Promise<boolean>)
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(403)
    expect(msgOf(r)).toMatch(/^PHONE_NOT_VERIFIED: /)
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.pay).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("after a gate block the same reference can be retried and pays once", async () => {
    const { deps } = makeDeps()
    deps.phoneGate.mockResolvedValueOnce(false)
    expect((await billPayHandler(deps)(payBody(), LIVE)).status).toBe(403)
    expect((await billPayHandler(deps)(payBody(), LIVE)).status).toBe(201)
    expect(deps.pay).toHaveBeenCalledTimes(1)
  })
})

describe("POST /utilities/pay (live): engine refusals (no debit) release the claim and map", () => {
  const refuse = (r: Extract<PayResult, { ok: false }>) => async () => ({ result: r as PayResult, fresh: false })

  it("402 insufficient => 402 INSUFFICIENT_BALANCE, released, never marked unknown", async () => {
    const { deps, table } = makeDeps()
    deps.pay.mockImplementationOnce(refuse({ ok: false, status: 402, error: "Insufficient wallet balance", order: engineRow({ status: "failed", payment_status: "unpaid" }) }))
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(402)
    expect(msgOf(r)).toMatch(/^INSUFFICIENT_BALANCE: /)
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
    expect(JSON.stringify(r)).not.toContain("BILL-ENGINE-1")
  })

  it("409 with a quote => PRICE_CHANGED: expected X, current Y", async () => {
    const { deps } = makeDeps()
    deps.pay.mockImplementationOnce(
      refuse({ ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 50, payAmount: 49.5, customerCashback: 0.5 } })
    )
    const r = await billPayHandler(deps)(payBody({ expected_pay: 50 }), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toMatch(/^PRICE_CHANGED: expected 50\.00, current 49\.50/)
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(deps.markUnknown).not.toHaveBeenCalled()
  })

  it.each([
    ["expired/foreign token", { status: 400, error: "Please verify the account again" }, 400, /^INVALID_TOKEN: /],
    ["amount below min", { status: 400, error: "Amount must be at least GHS 5.00" }, 400, /^INVALID_AMOUNT: /],
    ["amount precision", { status: 400, error: "Enter a valid amount" }, 400, /^INVALID_AMOUNT: /],
    ["token already used (dashboard)", { status: 409, error: "This verification was already used — please verify again" }, 409, /^VERIFY_AGAIN: /],
    ["order can no longer be paid", { status: 409, error: "This order can no longer be paid" }, 409, /^VERIFY_AGAIN: /],
    ["biller disabled", { status: 403, error: "This biller is not available" }, 503, /^BILLER_UNAVAILABLE: /],
    ["unexpected 401", { status: 401, error: "Unauthorized" }, 500, /^INTERNAL_ERROR: /],
    ["hubtel off / paused (pre-debit 503)", { status: 503, error: "Temporarily unavailable" }, 503, /^UNAVAILABLE: /],
  ] as const)("%s => %i, released", async (_n, res, status, re) => {
    const { deps } = makeDeps()
    deps.pay.mockImplementationOnce(refuse({ ok: false, ...res }))
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(status)
    expect(msgOf(r)).toMatch(re)
    expect(msgOf(r)).not.toContain(res.error)
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
  })

  it("a failed release is logged with a fixed line and the mapped answer still goes out", async () => {
    const { deps } = makeDeps()
    deps.pay.mockImplementationOnce(refuse({ ok: false, status: 402, error: "Insufficient wallet balance" }))
    deps.release.mockResolvedValueOnce(false)
    const lines = captureLogs()
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(402)
    expect(lines.join("\n")).toContain("[API v2] bills:")
  })
})

describe("POST /utilities/pay (live): ambiguous outcomes mark the claim unknown", () => {
  it.each([
    ["500 debit uncertain", async () => ({ result: { ok: false, status: 500, error: "We could not confirm your payment.", order: engineRow() } as PayResult, fresh: true })],
    ["500 insert failed", async () => ({ result: { ok: false, status: 500, error: "Could not create the order" } as PayResult, fresh: false })],
    ["502 unexpected", async () => ({ result: { ok: false, status: 502, error: "x" } as PayResult, fresh: false })],
    ["thrown Error", async () => {
      throw new Error("boom with 0249990799")
    }],
    ["non-Error throw", async () => {
      throw "string thrown"
    }],
    ["ok without a reference_code", async () => ({ result: { ok: true, order: engineRow({ reference_code: "" }) } as PayResult, fresh: true })],
    ["malformed result", async () => (undefined as unknown as { result: PayResult; fresh: boolean })],
  ])("%s => 500 OUTCOME_UNKNOWN, marked unknown, never released", async (_n, impl) => {
    const { deps, table } = makeDeps()
    deps.pay.mockImplementationOnce(impl as (p: BillPayEngineParams) => Promise<{ result: PayResult; fresh: boolean }>)
    const lines = captureLogs()
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(500)
    expect(msgOf(r)).toBe(MSG_BILL_OUTCOME_UNKNOWN)
    expect(deps.markUnknown).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect([...table.rows.values()][0].status).toBe("unknown")
    const log = lines.join("\n")
    expect(log).not.toContain("0249990799")
    expect(log).not.toContain(LIVE_TOKEN)
  })

  it("a retry with the same reference after an ambiguous outcome never re-calls the engine", async () => {
    const { deps } = makeDeps()
    quietErrors()
    deps.pay.mockRejectedValueOnce(new Error("timeout"))
    expect((await billPayHandler(deps)(payBody(), LIVE)).status).toBe(500)
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toMatch(/^OUTCOME_UNKNOWN: /)
    expect(deps.pay).toHaveBeenCalledTimes(1)
  })
})

describe("POST /utilities/pay (live): one verify_token pays one reference", () => {
  it("same token + NEW reference after a completed order => 409 REFERENCE_REUSED, claim released, no second order, no complete", async () => {
    const { deps, table } = makeDeps()
    expect((await billPayHandler(deps)(payBody(), LIVE)).status).toBe(201)
    // The engine hands back the ORIGINAL order (findApiOrderByTokenHash): nothing new was inserted.
    deps.pay.mockResolvedValueOnce({ result: { ok: true, order: engineRow() }, fresh: false })
    deps.complete.mockClear()
    const r = await billPayHandler(deps)(payBody({ reference: "BILL-0702" }), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toBe(MSG_TOKEN_REUSED)
    expect(deps.findClaimByOrderRef).toHaveBeenCalledWith("user-1", "BILL-ENGINE-1")
    expect(deps.release).toHaveBeenCalledWith("claim-2", "user-1")
    expect(deps.complete).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    // Only the first reference remains, still pointing at the one order.
    expect([...table.rows.values()].map((x) => [x.reference, x.status, x.orderRef])).toEqual([["BILL-0701", "done", "BILL-ENGINE-1"]])
    expect(JSON.stringify(r)).not.toContain("BILL-ENGINE-1")
  })

  it("a prior PAID order with no linked claim yet (another reference still in flight, or a v1 key) is also REFERENCE_REUSED", async () => {
    const { deps, table } = makeDeps()
    deps.pay.mockResolvedValueOnce({ result: { ok: true, order: engineRow({ reference_code: "BILL-ENGINE-9" }) }, fresh: false })
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toBe(MSG_TOKEN_REUSED)
    expect(deps.complete).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("a prior UNPAID order (e.g. an earlier insufficient-balance attempt) is 409 VERIFY_AGAIN, released", async () => {
    const { deps, table } = makeDeps()
    deps.pay.mockResolvedValueOnce({
      result: { ok: true, order: engineRow({ status: "failed", payment_status: "unpaid" }) },
      fresh: false,
    })
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toMatch(/^VERIFY_AGAIN: /)
    expect(deps.complete).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("the reuse check fails safe: a claim lookup error still refuses (409) and never completes", async () => {
    const { deps } = makeDeps()
    deps.pay.mockResolvedValueOnce({ result: { ok: true, order: engineRow() }, fresh: false })
    deps.findClaimByOrderRef.mockResolvedValueOnce(null)
    const r = await billPayHandler(deps)(payBody(), LIVE)
    expect(r.status).toBe(409)
    expect(deps.complete).not.toHaveBeenCalled()
    expect(deps.release).toHaveBeenCalledTimes(1)
  })

  it("a fresh order (inserted by this request) completes without a reuse lookup", async () => {
    const { deps } = makeDeps()
    await billPayHandler(deps)(payBody(), LIVE)
    expect(deps.findClaimByOrderRef).not.toHaveBeenCalled()
    expect(deps.complete).toHaveBeenCalledTimes(1)
  })
})

// ================================================================ POST /utilities/pay (sandbox)

describe("POST /utilities/pay (sandbox)", () => {
  it("pays under the CLIENT reference with token_ref, never touching live deps", async () => {
    const { deps } = makeDeps()
    const token = sandboxToken()
    const r = await billPayHandler(deps)(payBody({ verify_token: token, amount: "12.50" }), TEST)
    expect(r.status).toBe(201)
    liveDepsUntouched(deps)
    expect(deps.getBillsConfig).not.toHaveBeenCalled()
    expect(deps.sandbox.place).toHaveBeenCalledTimes(1)
    const p = deps.sandbox.place.mock.calls[0][0]
    expect(p).toMatchObject({
      userId: "user-1",
      apiV2KeyId: "key-test-1",
      action: "utility_bill",
      reference: "BILL-0701",
      price: 12.5,
      request: { biller: "dstv", account: SMARTCARD, amount: 12.5, token_ref: sandboxBillReference(token), reference: "BILL-0701" },
    })
    expect(p.orderFields.token_ref).toBe(sandboxBillReference(token))
    expect(p).not.toHaveProperty("apiKeyId")
    const d = data(r)
    expect(d.sandbox).toBe(true)
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order).toMatchObject({ reference: "BILL-0701", biller: "dstv", account: SMARTCARD, face_amount: 12.5, paid_amount: 12.5, cashback: 0, status: "pending" })
    expect(JSON.stringify(d)).not.toContain("SBX-BILL-")
  })

  it("replay: same reference and same token/amount => 200 replayed sandbox; different amount => 409", async () => {
    const { deps } = makeDeps()
    const token = sandboxToken()
    deps.sandbox.getOrder.mockResolvedValue({
      reference: "BILL-0701",
      action: "utility_bill",
      response: { biller: "dstv", account: SMARTCARD, customer_name: "Sandbox Customer", face_amount: 50, paid_amount: 50, cashback: 0, token_ref: sandboxBillReference(token) },
      price: 50,
      created_at: CREATED,
      status: "completed",
    })
    const r = await billPayHandler(deps)(payBody({ verify_token: token }), TEST)
    expect(r.status).toBe(200)
    expect(data(r)).toMatchObject({ replayed: true, sandbox: true, order: { reference: "BILL-0701", status: "completed" } })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    const c = await billPayHandler(deps)(payBody({ verify_token: token, amount: 51 }), TEST)
    expect(c.status).toBe(409)
    expect(msgOf(c)).toMatch(/^REFERENCE_REUSED: /)
    const other = await billPayHandler(deps)(payBody({ verify_token: sandboxToken("user-1", "8000000703") }), TEST)
    expect(other.status).toBe(409)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
    liveDepsUntouched(deps)
  })

  it("token reuse: a token that already paid another reference => 409 REFERENCE_REUSED, nothing placed", async () => {
    const { deps } = makeDeps()
    const token = sandboxToken()
    deps.sandbox.findByTokenRef.mockResolvedValueOnce([{ reference: "BILL-0790" }])
    const r = await billPayHandler(deps)(payBody({ verify_token: token, reference: "BILL-0791" }), TEST)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toBe(MSG_TOKEN_REUSED)
    expect(deps.sandbox.findByTokenRef).toHaveBeenCalledWith("user-1", sandboxBillReference(token))
    expect(deps.sandbox.place).not.toHaveBeenCalled()
    liveDepsUntouched(deps)
  })

  it("token reuse: a v1 sandbox order under the deterministic token reference => 409", async () => {
    const { deps } = makeDeps()
    const token = sandboxToken()
    deps.sandbox.getOrder.mockImplementation(async (_u, ref) =>
      ref === sandboxBillReference(token)
        ? { reference: ref, action: "utility_bill", response: {}, price: 50, created_at: CREATED, status: "completed" }
        : null
    )
    const r = await billPayHandler(deps)(payBody({ verify_token: token }), TEST)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toBe(MSG_TOKEN_REUSED)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it("a token-ref read error fails closed (503)", async () => {
    const { deps } = makeDeps()
    deps.sandbox.findByTokenRef.mockResolvedValueOnce(null)
    const r = await billPayHandler(deps)(payBody({ verify_token: sandboxToken() }), TEST)
    expect(r.status).toBe(503)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it("expected_pay mismatch => 409 PRICE_CHANGED, nothing placed", async () => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody({ verify_token: sandboxToken(), expected_pay: 49 }), TEST)
    expect(r.status).toBe(409)
    expect(msgOf(r)).toMatch(/^PRICE_CHANGED: expected 49\.00, current 50\.00/)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it.each([
    ["a live token on a test key", LIVE_TOKEN],
    ["another user's sandbox token", sandboxToken("user-2")],
    ["a tampered sandbox token", sandboxToken().slice(0, -2) + "00"],
  ])("%s => 400 INVALID_TOKEN, nothing called", async (_n, token) => {
    const { deps } = makeDeps()
    const r = await billPayHandler(deps)(payBody({ verify_token: token }), TEST)
    expect(r.status).toBe(400)
    expect(msgOf(r)).toMatch(/^INVALID_TOKEN: /)
    nothingCalled(deps)
  })

  it("insert race (409) answers as a replay when it is the same order; 402 maps; other failures 500", async () => {
    const token = sandboxToken()
    const same = {
      reference: "BILL-0701",
      action: "utility_bill",
      response: { biller: "dstv", account: SMARTCARD, face_amount: 50, paid_amount: 50, cashback: 0, token_ref: sandboxBillReference(token) },
      price: 50,
      created_at: CREATED,
      status: "pending",
    }
    const a = makeDeps().deps
    a.sandbox.place.mockResolvedValueOnce({ success: false, error: "Duplicate reference", status: 409 } as any)
    a.sandbox.getOrder.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(same)
    const ra = await billPayHandler(a)(payBody({ verify_token: token }), TEST)
    expect(ra.status).toBe(200)
    expect(data(ra).replayed).toBe(true)

    const b = makeDeps().deps
    b.sandbox.place.mockResolvedValueOnce({ success: false, error: "Insufficient test balance", status: 402 } as any)
    const rb = await billPayHandler(b)(payBody({ verify_token: token }), TEST)
    expect(rb.status).toBe(402)
    expect(msgOf(rb)).toMatch(/^INSUFFICIENT_BALANCE: /)

    const c = makeDeps().deps
    c.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 500 } as any)
    expect((await billPayHandler(c)(payBody({ verify_token: token }), TEST)).status).toBe(500)
  })
})

// ================================================================ POST /utilities/lookup

describe("POST /utilities/lookup (live)", () => {
  it("passes the parsed inputs to verify and returns the v1 verifyResponse shape (minus success)", async () => {
    const { deps } = makeDeps()
    const r = await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, LIVE)
    expect(r.status).toBe(200)
    expect(deps.verify).toHaveBeenCalledWith("user-1", "dstv", {
      account: SMARTCARD,
      phone: undefined,
      email: undefined,
      broadbandAccount: undefined,
      addMeter: false,
      consent: false,
    })
    expect(data(r)).toEqual({ customer_name: "Kofi Test", amount_due: 42.5, suggested_amount: 42.5, verify_token: LIVE_TOKEN })
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.claim).not.toHaveBeenCalled()
  })

  it("ECG meters list is shaped exactly like v1", async () => {
    const { deps } = makeDeps()
    deps.verify.mockResolvedValueOnce({
      ok: true,
      customerName: null,
      amountDue: null,
      suggestedAmount: 0,
      meters: [{ meter: METER, name: "Ama", outstanding: 12, token: LIVE_TOKEN_2 }],
    })
    const r = await billLookupHandler(deps)({ biller: "ecg", phone: PHONE }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r)).toEqual({
      customer_name: null,
      amount_due: null,
      suggested_amount: 0,
      meters: [{ meter: METER, name: "Ama", outstanding: 12, verify_token: LIVE_TOKEN_2 }],
    })
  })

  it.each([
    ["closed", async () => false],
    ["throws", async () => {
      throw new Error("cfg")
    }],
  ])("surface %s => 403 NOT_AVAILABLE with no provider call", async (_n, impl) => {
    const { deps } = makeDeps()
    deps.surfaceOpen.mockImplementationOnce(impl as () => Promise<boolean>)
    const r = await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, LIVE)
    expect(r.status).toBe(403)
    expect(msgOf(r)).toMatch(/^NOT_AVAILABLE: /)
    expect(deps.verify).not.toHaveBeenCalled()
  })

  it.each([
    ["input error", { ok: false, status: 400, error: `Enter a valid smartcard number ${SMARTCARD}` }, 400, /^INVALID_REQUEST: /],
    ["biller disabled", { ok: false, status: 403, error: "This biller is not available" }, 503, /^BILLER_UNAVAILABLE: /],
    ["bills/hubtel off", { ok: false, status: 503, error: "Temporarily unavailable" }, 503, /^UNAVAILABLE: /],
    ["provider failed", { ok: false, status: 422, error: `Couldn't verify this account: provider said ${SMARTCARD}` }, 502, /^LOOKUP_FAILED: /],
    ["unexpected status", { ok: false, status: 418, error: "x" }, 500, /^INTERNAL_ERROR: /],
  ] as const)("%s => %i with a fixed message", async (_n, res, status, re) => {
    const { deps } = makeDeps()
    deps.verify.mockResolvedValueOnce(res as VerifyResult)
    const r = await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, LIVE)
    expect(r.status).toBe(status)
    expect(msgOf(r)).toMatch(re)
    expect(msgOf(r)).not.toContain(SMARTCARD)
  })

  it("a verify throw is 500 with a fixed log line; the token and account are never logged", async () => {
    const lines = captureLogs()
    const { deps } = makeDeps()
    await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, LIVE)
    deps.verify.mockRejectedValueOnce(new Error(`boom ${SMARTCARD}`))
    const r = await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, LIVE)
    expect(r.status).toBe(500)
    const log = lines.join("\n")
    expect(log).not.toContain(LIVE_TOKEN)
    expect(log).not.toContain(SMARTCARD)
  })

  it("unknown biller / non-object body => 400 with nothing called", async () => {
    for (const b of [{ biller: "nope", account: SMARTCARD }, [], undefined, "x"]) {
      const { deps } = makeDeps()
      const r = await billLookupHandler(deps)(b, LIVE)
      expect(r.status).toBe(400)
      nothingCalled(deps)
    }
  })
})

describe("POST /utilities/lookup (sandbox)", () => {
  it("returns a sandbox token, never touching live deps", async () => {
    const { deps } = makeDeps()
    const r = await billLookupHandler(deps)({ biller: "dstv", account: SMARTCARD }, TEST)
    expect(r.status).toBe(200)
    expect(data(r)).toMatchObject({ customer_name: "Sandbox Customer", amount_due: 50, suggested_amount: 50, sandbox: true })
    expect(data(r).verify_token).toMatch(/^sandbox_bill\./)
    expect(data(r)).not.toHaveProperty("success")
    nothingCalled(deps)
  })

  it("ECG returns a meters list; missing account => 400", async () => {
    const { deps } = makeDeps()
    const r = await billLookupHandler(deps)({ biller: "ecg", phone: PHONE, account: METER }, TEST)
    expect(r.status).toBe(200)
    expect(data(r).meters[0]).toMatchObject({ meter: METER, name: "Sandbox Customer" })
    const bad = await billLookupHandler(deps)({ biller: "dstv" }, TEST)
    expect(bad.status).toBe(400)
    nothingCalled(deps)
  })
})

// ================================================================ GET /utilities/billers

describe("GET /utilities/billers", () => {
  it("lists every biller with key, label, enabled, limits and inputs; a disabled biller is enabled:false", async () => {
    const { deps } = makeDeps()
    deps.getBillsConfig.mockResolvedValueOnce(
      resolveBillsConfig({
        enabled: true,
        billers: { ...Object.fromEntries(BILLER_KEYS.map((k) => [k, { enabled: true, min: 5, max: 1000 }])), gotv: { enabled: false, min: 10, max: 200 } },
      })
    )
    const r = await billersHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    const list = data(r).billers as any[]
    expect(list.map((b) => b.key)).toEqual([...BILLER_KEYS])
    for (const b of list) expect(Object.keys(b).sort()).toEqual(["enabled", "inputs", "key", "label", "max_amount", "min_amount"])
    const gotv = list.find((b) => b.key === "gotv")
    expect(gotv).toMatchObject({ enabled: false, min_amount: 10, max_amount: 200, label: "GOtv" })
    expect(list.find((b) => b.key === "dstv")).toMatchObject({ enabled: true, min_amount: 5, max_amount: 1000 })
    const gw = list.find((b) => b.key === "ghana_water")
    expect(gw.inputs.filter((i: any) => i.required).map((i: any) => i.name).sort()).toEqual(["account", "email", "phone"])
    expect(deps.verify).not.toHaveBeenCalled()
    expect(deps.claim).not.toHaveBeenCalled()
    expect(deps.pay).not.toHaveBeenCalled()
  })

  it("bills globally off => every biller enabled:false", async () => {
    const { deps } = makeDeps()
    deps.getBillsConfig.mockResolvedValueOnce(resolveBillsConfig({ enabled: false, billers: { dstv: { enabled: true, min: 5, max: 100 } } }))
    const r = await billersHandler(deps)(LIVE)
    expect((data(r).billers as any[]).every((b) => b.enabled === false)).toBe(true)
  })

  it("a config read failure is 503 (never a guessed list)", async () => {
    const { deps } = makeDeps()
    deps.getBillsConfig.mockRejectedValueOnce(new Error("db"))
    quietErrors()
    const r = await billersHandler(deps)(LIVE)
    expect(r.status).toBe(503)
    expect(r.data).toBeUndefined()
  })
})

// ================================================================ GET /utilities/orders/{reference}

describe("GET /utilities/orders/{reference} (live)", () => {
  it("resolves through the claim, refreshes from the owner-scoped row, allow-listed keys only", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValueOnce({ orderRef: "BILL-ENGINE-1", status: "done", response: { status: "processing" } })
    deps.getOrderByCode.mockResolvedValueOnce({ ...liveRow(), notes: "x", hubtel_client_reference: "y", failure_reason: "z", commission: 9 } as any)
    const r = await billOrderHandler(deps)("BILL-0701", LIVE)
    expect(r.status).toBe(200)
    expect(deps.getClaim).toHaveBeenCalledWith("user-1", "BILL-0701")
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "BILL-ENGINE-1")
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(data(r).order).toMatchObject({ reference: "BILL-0701", status: "completed" })
    expect(JSON.stringify(data(r))).not.toContain("BILL-ENGINE-1")
  })

  it("falls back to the stored response (allow-listed) when the row read fails", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValueOnce({
      orderRef: "BILL-ENGINE-1",
      status: "done",
      response: { reference: "BILL-0701", biller: "dstv", account: SMARTCARD, face_amount: 50, paid_amount: 49.5, cashback: 0.5, status: "processing", created_at: CREATED, notes: "leak" },
    })
    deps.getOrderByCode.mockResolvedValueOnce(null)
    const r = await billOrderHandler(deps)("BILL-0701", LIVE)
    expect(r.status).toBe(200)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(data(r))).not.toContain("leak")
  })

  it("missing, foreign, in-progress, unknown, malformed and errored are the identical 404", async () => {
    const cases: Array<(d: Deps) => void> = [
      () => {},
      (d) => d.getClaim.mockResolvedValueOnce({ orderRef: null, status: "in_progress", response: null }),
      (d) => d.getClaim.mockResolvedValueOnce({ orderRef: null, status: "unknown", response: null }),
      (d) => d.getClaim.mockRejectedValueOnce(new Error("db")),
      (d) => {
        d.getClaim.mockResolvedValueOnce({ orderRef: "BILL-ENGINE-1", status: "done", response: null })
        d.getOrderByCode.mockResolvedValueOnce(null)
      },
    ]
    const bodies: string[] = []
    for (const setup of cases) {
      const { deps } = makeDeps()
      setup(deps)
      const r = await billOrderHandler(deps)("BILL-0701", LIVE)
      expect(r.status).toBe(404)
      bodies.push(JSON.stringify(r))
    }
    const { deps } = makeDeps()
    const bad = await billOrderHandler(deps)("bad ref!", LIVE)
    bodies.push(JSON.stringify(bad))
    expect(deps.getClaim).not.toHaveBeenCalled()
    expect(new Set(bodies).size).toBe(1)
    expect(JSON.parse(bodies[0]).error.message).toBe(MSG_BILL_NOT_FOUND)
  })
})

describe("GET /utilities/orders/{reference} (sandbox)", () => {
  it("reads the sandbox order by client reference only; another action is 404", async () => {
    const { deps } = makeDeps()
    deps.sandbox.getOrder.mockResolvedValueOnce({
      reference: "BILL-0701",
      action: "utility_bill",
      response: { biller: "dstv", account: SMARTCARD, face_amount: 50, paid_amount: 50, cashback: 0, token_ref: "SBX-BILL-X" },
      price: 50,
      created_at: CREATED,
      status: "completed",
    })
    const r = await billOrderHandler(deps)("BILL-0701", TEST)
    expect(r.status).toBe(200)
    expect(data(r).sandbox).toBe(true)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(data(r))).not.toContain("SBX-BILL-X")
    liveDepsUntouched(deps)
    deps.sandbox.getOrder.mockResolvedValueOnce({ reference: "BILL-0701", action: "airtime", response: {}, price: 5, created_at: CREATED, status: "completed" })
    expect((await billOrderHandler(deps)("BILL-0701", TEST)).status).toBe(404)
  })
})
