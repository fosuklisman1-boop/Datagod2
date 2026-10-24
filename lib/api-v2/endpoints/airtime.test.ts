import { describe, it, expect, vi, afterEach } from "vitest"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { airtimeHash, parseAirtimeBody } from "../commission"
import {
  purchaseAirtimeHandler,
  airtimeOrderHandler,
  airtimeListHandler,
  AIRTIME_LIST_LIMIT,
  MSG_AIRTIME_NOT_FOUND,
  MSG_OUTCOME_UNKNOWN,
  type AirtimeDeps,
  type AirtimeEngineParams,
  type AirtimeOrderRow,
  type AirtimeSandboxOrder,
} from "./airtime"

// ---------------------------------------------------------------- fixtures

// Unique test phones for this file: 0249990601-0249990699.
const PHONE = "0249990601"
const PHONE_2 = "0249990602"

const ORDER_KEYS = [
  "airtime_amount",
  "cashback",
  "created_at",
  "fee",
  "network",
  "recipient",
  "reference",
  "status",
  "total_paid",
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

const body = (over: Record<string, unknown> = {}) => ({
  network: "MTN",
  recipient: PHONE,
  amount: 10,
  reference: "AIR-001",
  ...over,
})

function engineOk(p: AirtimeEngineParams, code = "AT-CODE-1") {
  return {
    order: {
      id: "order-uuid-1",
      reference_code: code,
      network: p.network,
      beneficiary_phone: p.beneficiaryPhone,
      airtime_amount: p.airtimeAmount,
      fee_amount: 0.5,
      total_paid: p.airtimeAmount + 0.5,
      status: "pending",
    },
    newBalance: 89.5,
  }
}

function liveRow(over: Partial<AirtimeOrderRow> = {}): AirtimeOrderRow {
  return {
    reference_code: "AT-CODE-1",
    network: "MTN",
    beneficiary_phone: PHONE,
    airtime_amount: 10,
    fee_amount: 0.5,
    total_paid: 10.5,
    cashback_amount: 0,
    status: "pending",
    created_at: CREATED,
    ...over,
  }
}

function engineError(code: unknown, extra: Record<string, unknown> = {}) {
  const e: any = new Error("engine said something with 0249990699 in it")
  if (code !== undefined) e.code = code
  Object.assign(e, extra)
  return e
}

/** In-memory claim table honouring the UNIQUE (user, kind, reference) constraint. */
function claimTable() {
  type Row = { id: string; userId: string; reference: string; hash: string; status: string; orderRef: string | null; response: unknown }
  const rows = new Map<string, Row>()
  let n = 0
  const key = (u: string, r: string) => `${u}|${r}`
  return {
    rows,
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "airtime"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
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
    complete: vi.fn(async (claimId: string, orderRef: string, response: unknown) => {
      for (const r of rows.values()) {
        if (r.id === claimId && r.status === "in_progress") {
          Object.assign(r, { status: "done", orderRef, response })
          return true
        }
      }
      return false
    }),
    release: vi.fn(async (claimId: string) => {
      for (const [k, r] of rows) {
        if (r.id === claimId && r.status === "in_progress") {
          rows.delete(k)
          return true
        }
      }
      return false
    }),
    markUnknown: vi.fn(async (claimId: string) => {
      for (const r of rows.values()) {
        if (r.id === claimId && r.status === "in_progress") {
          r.status = "unknown"
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
    getClaim: vi.fn(async (_u: string, _r: string): Promise<{ orderRef: string | null; status: string; response: unknown } | null> => null),
    listClaims: vi.fn(async (_u: string, _limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[]> => []),
    engine: vi.fn(async (p: AirtimeEngineParams) => engineOk(p)),
    getOrderByCode: vi.fn(async (_u: string, _c: string): Promise<AirtimeOrderRow | null> => liveRow()),
    getOrdersByCodes: vi.fn(async (_u: string, _c: string[]): Promise<AirtimeOrderRow[] | null> => []),
    phoneGate: vi.fn(async (_u: string) => true),
    sandbox: {
      getOrder: vi.fn(async (_u: string, _r: string): Promise<AirtimeSandboxOrder | null> => null),
      listOrders: vi.fn(async (_u: string, _a: "airtime", _l: number): Promise<AirtimeSandboxOrder[] | null> => []),
      place: vi.fn(async (p: any) => ({
        success: true as const,
        order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED },
        newBalance: 90,
      })),
    },
    now: () => NOW_MS,
  }
  return { deps: deps satisfies AirtimeDeps, table }
}

type Deps = ReturnType<typeof makeDeps>["deps"]

function liveDepsUntouched(deps: Deps) {
  expect(deps.claim).not.toHaveBeenCalled()
  expect(deps.complete).not.toHaveBeenCalled()
  expect(deps.release).not.toHaveBeenCalled()
  expect(deps.markUnknown).not.toHaveBeenCalled()
  expect(deps.engine).not.toHaveBeenCalled()
  expect(deps.phoneGate).not.toHaveBeenCalled()
  expect(deps.getClaim).not.toHaveBeenCalled()
  expect(deps.listClaims).not.toHaveBeenCalled()
  expect(deps.getOrderByCode).not.toHaveBeenCalled()
  expect(deps.getOrdersByCodes).not.toHaveBeenCalled()
}

function nothingCalled(deps: Deps) {
  liveDepsUntouched(deps)
  expect(deps.sandbox.getOrder).not.toHaveBeenCalled()
  expect(deps.sandbox.place).not.toHaveBeenCalled()
  expect(deps.sandbox.listOrders).not.toHaveBeenCalled()
}

const data = (r: { data?: unknown }) => r.data as any

afterEach(() => {
  vi.restoreAllMocks()
})

function quietErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {})
}

// ---------------------------------------------------------------- purchase: happy path

describe("POST /airtime/purchase (live): new purchase", () => {
  it("claims once, calls the engine once with the normalised arguments, completes, never releases", async () => {
    const { deps } = makeDeps()
    const r = await purchaseAirtimeHandler(deps)(body({ network: "airteltigo", recipient: "+233 26 999 0603", amount: "12.50" }), LIVE)
    expect(r.status).toBe(201)
    expect(deps.claim).toHaveBeenCalledTimes(1)
    const parsed = parseAirtimeBody(body({ network: "airteltigo", recipient: "+233 26 999 0603", amount: "12.50" }))
    if (!parsed.ok) throw new Error("fixture")
    expect(deps.claim).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      kind: "airtime",
      reference: "AIR-001",
      requestHash: airtimeHash(parsed.value),
    })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.engine).toHaveBeenCalledWith({
      userId: "user-1",
      network: "AT",
      beneficiaryPhone: "0269990603",
      airtimeAmount: 12.5,
      paySeparately: false,
      channel: "api",
    })
    expect(deps.engine.mock.calls[0][0]).not.toHaveProperty("shopId")
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    // claim -> phone gate -> engine -> complete
    const order = [deps.claim, deps.phoneGate, deps.engine, deps.complete].map((f) => f.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("returns 201 { order, new_balance } with the CLIENT reference, never the engine reference_code", async () => {
    const { deps } = makeDeps()
    deps.getOrderByCode.mockResolvedValue(liveRow({ cashback_amount: 0.2 }))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    const d = data(r)
    expect(Object.keys(d).sort()).toEqual(["new_balance", "order"])
    expect(d.new_balance).toBe(89.5)
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order.reference).toBe("AIR-001")
    expect(JSON.stringify(d)).not.toContain("AT-CODE-1")
    expect(JSON.stringify(d)).not.toContain("order-uuid-1")
    expect(d.order).toMatchObject({ network: "MTN", recipient: PHONE, airtime_amount: 10, fee: 0.5, total_paid: 10.5, cashback: 0.2, status: "pending", created_at: CREATED })
    // complete() stores the engine code as order_ref and the mapped public order as response
    expect(deps.complete).toHaveBeenCalledWith("claim-1", "AT-CODE-1", d.order)
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "AT-CODE-1")
  })

  it("falls back to the engine row (created_at = now) when the post-purchase read fails or throws", async () => {
    const { deps } = makeDeps()
    deps.getOrderByCode.mockRejectedValueOnce(new Error("db down"))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).order).toMatchObject({ reference: "AIR-001", total_paid: 10.5, cashback: 0, created_at: new Date(NOW_MS).toISOString() })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
  })

  it("passes expected_pay through to the engine (the engine decides price mismatches)", async () => {
    const { deps } = makeDeps()
    await purchaseAirtimeHandler(deps)(body({ expected_pay: "10.50" }), LIVE)
    expect(deps.engine.mock.calls[0][0].expectedPay).toBe(10.5)
  })

  it("amounts pass at exact pesewa precision (float traps)", async () => {
    for (const [amount, expected] of [[5.1, 5.1], ["19.99", 19.99], [1.15, 1.15], ["0.10", 0.1], [999.99, 999.99]] as const) {
      const { deps } = makeDeps()
      const r = await purchaseAirtimeHandler(deps)(body({ amount }), LIVE)
      expect(r.status).toBe(201)
      expect(deps.engine.mock.calls[0][0].airtimeAmount).toBe(expected)
    }
  })

  it("complete() returning false after engine success still returns 201 (money moved) and logs a PII-free line", async () => {
    const err = quietErrors()
    const { deps } = makeDeps()
    deps.complete.mockResolvedValueOnce(false)
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).order.reference).toBe("AIR-001")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    const logged = JSON.stringify(err.mock.calls)
    expect(logged).not.toContain(PHONE)
    expect(logged).not.toContain("AIR-001")
  })
})

// ---------------------------------------------------------------- purchase: validation

describe("POST /airtime/purchase: validation before any dependency", () => {
  const cases: Array<[string, unknown]> = [
    ["price", body({ price: 1 })],
    ["fee", body({ fee: 0 })],
    ["fee_amount", body({ fee_amount: 0 })],
    ["total_paid", body({ total_paid: 1 })],
    ["total", body({ total: 1 })],
    ["cashback", body({ cashback: 5 })],
    ["Price (case)", body({ Price: 1 })],
    ["user_id", body({ user_id: "someone-else" })],
    ["pay_separately", body({ pay_separately: true })],
    ["not an object", "hello"],
    ["array", [body()]],
    ["undefined", undefined],
    ["bad network", body({ network: "Vodafone" })],
    ["bad recipient", body({ recipient: "12345" })],
    ["zero", body({ amount: 0 })],
    ["negative", body({ amount: -5 })],
    ["NaN", body({ amount: NaN })],
    ["exponent", body({ amount: "1e3" })],
    ["3 decimals", body({ amount: "1.005" })],
    ["float sum", body({ amount: 0.1 + 0.2 })],
    ["over max", body({ amount: 1000.01 })],
    ["missing reference", body({ reference: undefined })],
    ["short reference", body({ reference: "ab" })],
    ["bad expected_pay", body({ expected_pay: "abc" })],
  ]
  for (const [name, b] of cases) {
    it(`rejects ${name} with 400 and touches nothing`, async () => {
      const { deps } = makeDeps()
      for (const ctx of [LIVE, TEST]) {
        const r = await purchaseAirtimeHandler(deps)(b, ctx)
        expect(r.status).toBe(400)
        expect(r.error?.status).toBe(400)
      }
      nothingCalled(deps)
    })
  }
})

// ---------------------------------------------------------------- purchase: claim outcomes

describe("POST /airtime/purchase (live): claim outcomes decided before phone gate and engine", () => {
  const stored = {
    reference: "AIR-001",
    network: "MTN",
    recipient: PHONE,
    airtime_amount: 10,
    fee: 0.5,
    total_paid: 10.5,
    cashback: 0,
    status: "pending",
    created_at: CREATED,
  }

  it("replay => 200 { order, replayed: true } with the stored order; NO engine, NO phone gate", async () => {
    const { deps } = makeDeps()
    deps.claim.mockResolvedValueOnce({ kind: "replay", orderRef: "AT-CODE-1", response: stored })
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    expect(data(r)).toEqual({ order: stored, replayed: true })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(deps.release).not.toHaveBeenCalled()
  })

  it("replay whose stored response carries extra keys still returns only the allow-listed keys", async () => {
    const { deps } = makeDeps()
    deps.claim.mockResolvedValueOnce({ kind: "replay", orderRef: "AT-CODE-1", response: { ...stored, reference_code: "AT-CODE-1", user_id: "x" } })
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(data(r))).not.toContain("AT-CODE-1")
  })

  const blocked: Array<[ClaimOutcome["kind"], number, string]> = [
    ["conflict", 409, "REFERENCE_REUSED:"],
    ["in_progress", 409, "REQUEST_IN_PROGRESS:"],
    ["unknown", 409, "OUTCOME_UNKNOWN:"],
    ["error", 503, "UNAVAILABLE:"],
  ]
  for (const [kind, status, prefix] of blocked) {
    it(`${kind} => ${status} ${prefix} with NO engine, NO phone gate, no finalisation`, async () => {
      const { deps } = makeDeps()
      deps.claim.mockResolvedValueOnce({ kind } as ClaimOutcome)
      const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
      expect(r.status).toBe(status)
      expect(r.error?.status).toBe(status)
      expect(r.error?.message.startsWith(prefix)).toBe(true)
      expect(deps.engine).not.toHaveBeenCalled()
      expect(deps.phoneGate).not.toHaveBeenCalled()
      expect(deps.complete).not.toHaveBeenCalled()
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.markUnknown).not.toHaveBeenCalled()
    })
  }

  it("a claim() that throws fails closed with 503 and no engine call", async () => {
    const { deps } = makeDeps()
    deps.claim.mockRejectedValueOnce(new Error("boom"))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(deps.engine).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- purchase: phone gate

describe("POST /airtime/purchase (live): phone gate", () => {
  it("gate false => 403 PHONE_NOT_VERIFIED, claim released, engine never called", async () => {
    const { deps, table } = makeDeps()
    deps.phoneGate.mockResolvedValueOnce(false)
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(r.error?.message.startsWith("PHONE_NOT_VERIFIED:")).toBe(true)
    expect(r.error?.message).not.toContain(PHONE)
    expect(deps.release).toHaveBeenCalledWith("claim-1")
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("gate throwing => 403, claim released, engine never called", async () => {
    const { deps } = makeDeps()
    deps.phoneGate.mockRejectedValueOnce(new Error("guard down"))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(deps.release).toHaveBeenCalledWith("claim-1")
    expect(deps.engine).not.toHaveBeenCalled()
  })

  it("gate returning a truthy non-true value is a block (fail closed)", async () => {
    const { deps } = makeDeps()
    deps.phoneGate.mockResolvedValueOnce("yes" as unknown as boolean)
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(deps.engine).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- purchase: engine errors

describe("POST /airtime/purchase (live): engine no-charge errors release the claim", () => {
  const noCharge: Array<[string, number, Record<string, unknown>, string]> = [
    ["INSUFFICIENT_BALANCE", 402, { required: 12.5 }, "INSUFFICIENT_BALANCE:"],
    ["DUPLICATE_REQUEST", 409, { reference: "AT-OTHER" }, "DUPLICATE_REQUEST:"],
    ["PRICE_CHANGED", 409, { quote: { faceAmount: 10, payAmount: 10.8, customerCashback: 0.2 } }, "PRICE_CHANGED:"],
    ["NETWORK_MISMATCH", 400, {}, "NETWORK_MISMATCH:"],
    ["INVALID_AMOUNT", 400, {}, "INVALID_AMOUNT:"],
    ["NETWORK_DISABLED", 503, {}, "NETWORK_DISABLED:"],
  ]
  for (const [code, status, extra, prefix] of noCharge) {
    it(`${code} => ${status}, release called, markUnknown NOT called`, async () => {
      const { deps, table } = makeDeps()
      deps.engine.mockRejectedValueOnce(engineError(code, extra))
      const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
      expect(r.status).toBe(status)
      expect(r.error?.status).toBe(status)
      expect(r.error?.message.startsWith(prefix)).toBe(true)
      // engine text (which can carry phone numbers) is never forwarded
      expect(r.error?.message).not.toContain("0249990699")
      expect(r.error?.message).not.toContain("AT-OTHER")
      expect(deps.release).toHaveBeenCalledWith("claim-1")
      expect(deps.markUnknown).not.toHaveBeenCalled()
      expect(deps.complete).not.toHaveBeenCalled()
      expect(table.rows.size).toBe(0)
    })
  }

  it("402 carries the required amount in the message", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE", { required: 12.5 }))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.error?.message).toContain("required 12.50")
  })

  it("402 without a required amount still answers 402", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE"))
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(402)
    expect(r.error?.message).not.toContain("required")
  })

  it("PRICE_CHANGED carries the quote fields in the message", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("PRICE_CHANGED", { quote: { faceAmount: 10, payAmount: 10.8, customerCashback: 0.2 } }))
    const r = await purchaseAirtimeHandler(deps)(body({ expected_pay: 10.5 }), LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message).toContain("pay_amount 10.80")
    expect(r.error?.message).toContain("face_amount 10.00")
    expect(r.error?.message).toContain("customer_cashback 0.20")
  })

  it("after a no-charge release the same reference can be retried (e.g. after a top-up)", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE", { required: 10.5 }))
    expect((await purchaseAirtimeHandler(deps)(body(), LIVE)).status).toBe(402)
    expect((await purchaseAirtimeHandler(deps)(body(), LIVE)).status).toBe(201)
    expect(deps.engine).toHaveBeenCalledTimes(2)
  })

  it("a failed release is logged (PII-free) and the mapped error is still returned", async () => {
    const err = quietErrors()
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INVALID_AMOUNT"))
    deps.release.mockResolvedValueOnce(false)
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(400)
    expect(err).toHaveBeenCalled()
    expect(JSON.stringify(err.mock.calls)).not.toContain(PHONE)
  })
})

describe("POST /airtime/purchase (live): ambiguous engine outcomes mark the claim unknown", () => {
  const ambiguous: Array<[string, () => unknown]> = [
    ["PAYMENT_FAILED", () => engineError("PAYMENT_FAILED")],
    ["ORDER_CREATE_FAILED", () => engineError("ORDER_CREATE_FAILED")],
    ["an unknown code", () => engineError("SOMETHING_NEW")],
    ["no code", () => engineError(undefined)],
    ["a string throw", () => "kaboom"],
    ["a TypeError", () => new TypeError("cannot read properties of undefined")],
    ["a non-string code", () => engineError(42)],
  ]
  for (const [name, make] of ambiguous) {
    it(`${name} => markUnknown, NOT release, generic 500 OUTCOME_UNKNOWN`, async () => {
      const { deps, table } = makeDeps()
      deps.engine.mockImplementationOnce(async () => {
        throw make()
      })
      const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
      expect(r.status).toBe(500)
      expect(r.error?.status).toBe(500)
      expect(r.error?.message).toBe(MSG_OUTCOME_UNKNOWN)
      expect(MSG_OUTCOME_UNKNOWN.startsWith("OUTCOME_UNKNOWN:")).toBe(true)
      expect(MSG_OUTCOME_UNKNOWN).toContain("GET /airtime/orders/{reference}")
      expect(MSG_OUTCOME_UNKNOWN).toMatch(/do not resend with a new reference/i)
      expect(deps.markUnknown).toHaveBeenCalledWith("claim-1")
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.complete).not.toHaveBeenCalled()
      expect([...table.rows.values()][0].status).toBe("unknown")
    })
  }

  it("a retry with the same reference after an ambiguous outcome NEVER re-calls the engine", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("ORDER_CREATE_FAILED"))
    expect((await purchaseAirtimeHandler(deps)(body(), LIVE)).status).toBe(500)
    const again = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(again.status).toBe(409)
    expect(again.error?.message.startsWith("OUTCOME_UNKNOWN:")).toBe(true)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("a failed markUnknown is logged and the generic 500 is still returned", async () => {
    const err = quietErrors()
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("PAYMENT_FAILED"))
    deps.markUnknown.mockResolvedValueOnce(false)
    const r = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(deps.release).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- purchase: duplicates

describe("POST /airtime/purchase (live): never two engine calls for one reference", () => {
  it("two sequential identical requests: the second is a replay, engine called exactly once", async () => {
    const { deps } = makeDeps()
    const first = await purchaseAirtimeHandler(deps)(body(), LIVE)
    const second = await purchaseAirtimeHandler(deps)(body(), LIVE)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    expect(data(second)).toEqual({ order: data(first).order, replayed: true })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.phoneGate).toHaveBeenCalledTimes(1)
  })

  it("same reference, different content => 409 REFERENCE_REUSED, engine called once", async () => {
    const { deps } = makeDeps()
    await purchaseAirtimeHandler(deps)(body(), LIVE)
    const r = await purchaseAirtimeHandler(deps)(body({ recipient: PHONE_2 }), LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message.startsWith("REFERENCE_REUSED:")).toBe(true)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("expected_pay is advisory: same request with a different expected_pay replays", async () => {
    const { deps } = makeDeps()
    await purchaseAirtimeHandler(deps)(body({ expected_pay: 10.5 }), LIVE)
    const r = await purchaseAirtimeHandler(deps)(body({ expected_pay: 11 }), LIVE)
    expect(r.status).toBe(200)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("two concurrent identical requests (unique-constraint fake): engine called exactly once", async () => {
    const { deps } = makeDeps()
    let releaseEngine!: () => void
    const gate = new Promise<void>((res) => (releaseEngine = res))
    deps.engine.mockImplementation(async (p: AirtimeEngineParams) => {
      await gate
      return engineOk(p)
    })
    const h = purchaseAirtimeHandler(deps)
    const a = h(body(), LIVE)
    const b = h(body(), LIVE)
    // let both reach their claim before the engine finishes
    await new Promise((r) => setTimeout(r, 0))
    releaseEngine()
    const [ra, rb] = await Promise.all([a, b])
    const statuses = [ra.status, rb.status].sort()
    expect(statuses).toEqual([201, 409])
    const loser = ra.status === 409 ? ra : rb
    expect(loser.error?.message.startsWith("REQUEST_IN_PROGRESS:")).toBe(true)
    expect(deps.engine).toHaveBeenCalledTimes(1)
    // and once the winner finished, a resend replays
    const c = await h(body(), LIVE)
    expect(c.status).toBe(200)
    expect(deps.engine).toHaveBeenCalledTimes(1)
  })

  it("different users may use the same reference independently", async () => {
    const { deps } = makeDeps()
    await purchaseAirtimeHandler(deps)(body(), LIVE)
    const r = await purchaseAirtimeHandler(deps)(body(), { ...LIVE, userId: "user-2" })
    expect(r.status).toBe(201)
    expect(deps.engine).toHaveBeenCalledTimes(2)
    expect(deps.engine.mock.calls[1][0].userId).toBe("user-2")
  })
})

// ---------------------------------------------------------------- lookup

describe("GET /airtime/orders/{reference} (live)", () => {
  const stored = {
    reference: "AIR-001",
    network: "MTN",
    recipient: PHONE,
    airtime_amount: 10,
    fee: 0.5,
    total_paid: 10.5,
    cashback: 0,
    status: "pending",
    created_at: CREATED,
  }

  it("returns the stored order with status refreshed from the live row (owner-scoped)", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValueOnce({ orderRef: "AT-CODE-1", status: "done", response: stored })
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ status: "completed" }))
    const r = await airtimeOrderHandler(deps)("AIR-001", LIVE)
    expect(r.status).toBe(200)
    expect(deps.getClaim).toHaveBeenCalledWith("user-1", "AIR-001")
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "AT-CODE-1")
    expect(data(r)).toEqual({ order: { ...stored, status: "completed" } })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
  })

  it("unrecognised live status reads processing; a missing or failing live row falls back to the stored order", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue({ orderRef: "AT-CODE-1", status: "done", response: stored })
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ status: "weird" }))
    expect(data(await airtimeOrderHandler(deps)("AIR-001", LIVE)).order.status).toBe("processing")
    deps.getOrderByCode.mockResolvedValueOnce(null)
    expect(data(await airtimeOrderHandler(deps)("AIR-001", LIVE)).order).toEqual(stored)
    deps.getOrderByCode.mockRejectedValueOnce(new Error("db"))
    expect(data(await airtimeOrderHandler(deps)("AIR-001", LIVE)).order).toEqual(stored)
  })

  const notFoundCases: Array<[string, (d: Deps) => void, string]> = [
    ["missing", (d) => d.getClaim.mockResolvedValueOnce(null), "AIR-001"],
    ["in_progress without order", (d) => d.getClaim.mockResolvedValueOnce({ orderRef: null, status: "in_progress", response: null }), "AIR-001"],
    ["unknown", (d) => d.getClaim.mockResolvedValueOnce({ orderRef: null, status: "unknown", response: null }), "AIR-001"],
    ["done without order_ref", (d) => d.getClaim.mockResolvedValueOnce({ orderRef: null, status: "done", response: stored }), "AIR-001"],
    ["getClaim throws", (d) => d.getClaim.mockRejectedValueOnce(new Error("x")), "AIR-001"],
    ["malformed reference", () => {}, "a b"],
    ["empty reference", () => {}, ""],
  ]
  let firstBody: string | null = null
  for (const [name, setup, ref] of notFoundCases) {
    it(`${name} => the identical 404 body`, async () => {
      const { deps } = makeDeps()
      setup(deps)
      const r = await airtimeOrderHandler(deps)(ref, LIVE)
      expect(r.status).toBe(404)
      expect(r.error).toEqual({ status: 404, message: MSG_AIRTIME_NOT_FOUND })
      const s = JSON.stringify(r)
      if (firstBody === null) firstBody = s
      expect(s).toBe(firstBody)
    })
  }

  it("a foreign reference is invisible: lookup is scoped by the caller's user id", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockImplementation(async (u: string) =>
      u === "user-2" ? { orderRef: "AT-CODE-1", status: "done", response: stored } : null
    )
    const r = await airtimeOrderHandler(deps)("AIR-001", LIVE)
    expect(r).toEqual({ status: 404, error: { status: 404, message: MSG_AIRTIME_NOT_FOUND } })
    expect(deps.getOrderByCode).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- list

describe("GET /airtime/orders (live)", () => {
  const storedFor = (ref: string) => ({ reference: ref })

  it("lists done claims newest first with ONE batched order read and refreshed statuses", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValueOnce([
      { reference: "R-3", orderRef: "AT-3", status: "done" },
      { reference: "R-2", orderRef: null, status: "in_progress" },
      { reference: "R-1", orderRef: "AT-1", status: "done" },
    ])
    deps.getOrdersByCodes.mockResolvedValueOnce([
      liveRow({ reference_code: "AT-1", status: "failed", airtime_amount: 5 }),
      liveRow({ reference_code: "AT-3", status: "completed", airtime_amount: 7 }),
    ])
    const r = await airtimeListHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(deps.listClaims).toHaveBeenCalledWith("user-1", AIRTIME_LIST_LIMIT)
    expect(AIRTIME_LIST_LIMIT).toBe(30)
    expect(deps.getOrdersByCodes).toHaveBeenCalledTimes(1)
    expect(deps.getOrdersByCodes).toHaveBeenCalledWith("user-1", ["AT-3", "AT-1"])
    const orders = data(r).orders
    expect(orders.map((o: any) => o.reference)).toEqual(["R-3", "R-1"])
    expect(orders.map((o: any) => o.status)).toEqual(["completed", "failed"])
    expect(orders[0].airtime_amount).toBe(7)
    for (const o of orders) expect(Object.keys(o).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(data(r))).not.toContain("AT-3")
  })

  it("is capped at 30 even when the claim store returns more", async () => {
    const { deps } = makeDeps()
    const claims = Array.from({ length: 40 }, (_, i) => ({ reference: `R-${i}`, orderRef: `AT-${i}`, status: "done" }))
    deps.listClaims.mockResolvedValueOnce(claims)
    deps.getOrdersByCodes.mockImplementationOnce(async (_u: string, codes: string[]) =>
      codes.map((c) => liveRow({ reference_code: c }))
    )
    const r = await airtimeListHandler(deps)(LIVE)
    expect(data(r).orders).toHaveLength(30)
    expect(deps.getOrdersByCodes.mock.calls[0][1]).toHaveLength(30)
  })

  it("no claims => empty list and no order read", async () => {
    const { deps } = makeDeps()
    const r = await airtimeListHandler(deps)(LIVE)
    expect(data(r)).toEqual({ orders: [] })
    expect(deps.getOrdersByCodes).not.toHaveBeenCalled()
  })

  it("a failing batch read (null or throw) => 503, never invented orders", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValue([{ reference: "R-1", orderRef: "AT-1", status: "done" }])
    deps.getOrdersByCodes.mockRejectedValueOnce(new Error("db"))
    expect((await airtimeListHandler(deps)(LIVE)).status).toBe(503)
    deps.getOrdersByCodes.mockResolvedValueOnce(null)
    expect((await airtimeListHandler(deps)(LIVE)).status).toBe(503)
  })

  it("a done claim whose order row is not returned is omitted", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValueOnce([
      { reference: "R-2", orderRef: "AT-2", status: "done" },
      { reference: "R-1", orderRef: "AT-1", status: "done" },
    ])
    deps.getOrdersByCodes.mockResolvedValueOnce([liveRow({ reference_code: "AT-1" })])
    const r = await airtimeListHandler(deps)(LIVE)
    expect(data(r).orders.map((o: any) => o.reference)).toEqual(["R-1"])
  })

  it("a foreign order row returned by mistake is never matched to the caller's claim by anything but the code", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValueOnce([{ reference: "R-1", orderRef: "AT-1", status: "done" }])
    deps.getOrdersByCodes.mockResolvedValueOnce([liveRow({ reference_code: "AT-9" })])
    const r = await airtimeListHandler(deps)(LIVE)
    expect(data(r).orders).toEqual([])
    void storedFor
  })
})

// ---------------------------------------------------------------- sandbox

describe("airtime sandbox (test key)", () => {
  const prior = (over: Partial<AirtimeSandboxOrder> = {}): AirtimeSandboxOrder => ({
    reference: "AIR-001",
    action: "airtime",
    response: { network: "MTN", recipient: PHONE, airtime_amount: 10, fee: 0, total_paid: 10, cashback: 0, reference: "AIR-001", status: "pending" },
    price: 10,
    created_at: CREATED,
    status: "completed",
    ...over,
  })

  it("places a sandbox order with the v2 key id and never touches claim/engine/phoneGate", async () => {
    const { deps } = makeDeps()
    const r = await purchaseAirtimeHandler(deps)(body({ network: "Telecel", recipient: "0209990604", amount: "7.25" }), TEST)
    expect(r.status).toBe(201)
    expect(deps.sandbox.place).toHaveBeenCalledTimes(1)
    const p = deps.sandbox.place.mock.calls[0][0]
    expect(p).toMatchObject({
      userId: "user-1",
      apiV2KeyId: "key-test-1",
      action: "airtime",
      reference: "AIR-001",
      price: 7.25,
      request: { network: "Telecel", recipient: "0209990604", amount: 7.25, reference: "AIR-001" },
    })
    expect(p).not.toHaveProperty("apiKeyId")
    const d = data(r)
    expect(d.sandbox).toBe(true)
    expect(d.new_balance).toBe(90)
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order).toMatchObject({ reference: "AIR-001", network: "Telecel", recipient: "0209990604", airtime_amount: 7.25, total_paid: 7.25, status: "pending" })
    liveDepsUntouched(deps)
  })

  it("same reference + same content => 200 replayed sandbox", async () => {
    const { deps } = makeDeps()
    deps.sandbox.getOrder.mockResolvedValueOnce(prior())
    const r = await purchaseAirtimeHandler(deps)(body({ recipient: "233249990601" }), TEST)
    expect(r.status).toBe(200)
    expect(data(r)).toMatchObject({ replayed: true, sandbox: true })
    expect(data(r).order).toMatchObject({ reference: "AIR-001", status: "completed", created_at: CREATED })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
    liveDepsUntouched(deps)
  })

  for (const [name, over] of [
    ["different recipient", { recipient: PHONE_2 }],
    ["different amount", { amount: 11 }],
    ["different network", { network: "AT", recipient: "0269990605" }],
  ] as const) {
    it(`same reference + ${name} => 409 REFERENCE_REUSED`, async () => {
      const { deps } = makeDeps()
      deps.sandbox.getOrder.mockResolvedValueOnce(prior())
      const r = await purchaseAirtimeHandler(deps)(body(over), TEST)
      expect(r.status).toBe(409)
      expect(r.error?.message.startsWith("REFERENCE_REUSED:")).toBe(true)
      expect(deps.sandbox.place).not.toHaveBeenCalled()
      liveDepsUntouched(deps)
    })
  }

  it("a reference used by another sandbox action => 409 REFERENCE_REUSED", async () => {
    const { deps } = makeDeps()
    deps.sandbox.getOrder.mockResolvedValueOnce(prior({ action: "data_order" }))
    const r = await purchaseAirtimeHandler(deps)(body(), TEST)
    expect(r.status).toBe(409)
  })

  it("insufficient test balance => 402; insert race same content => replay; other failure => 500", async () => {
    const { deps } = makeDeps()
    deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 402 } as any)
    const a = await purchaseAirtimeHandler(deps)(body(), TEST)
    expect(a.status).toBe(402)
    expect(a.error?.message.startsWith("INSUFFICIENT_BALANCE:")).toBe(true)

    deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "dup", status: 409 } as any)
    deps.sandbox.getOrder.mockResolvedValueOnce(null).mockResolvedValueOnce(prior())
    const b = await purchaseAirtimeHandler(deps)(body(), TEST)
    expect(b.status).toBe(200)
    expect(data(b).replayed).toBe(true)

    deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 500 } as any)
    const c = await purchaseAirtimeHandler(deps)(body(), TEST)
    expect(c.status).toBe(500)
    liveDepsUntouched(deps)
  })

  it("sandbox lookup uses the sandbox store; non-airtime or missing => identical 404", async () => {
    const { deps } = makeDeps()
    deps.sandbox.getOrder.mockResolvedValueOnce(prior())
    const ok = await airtimeOrderHandler(deps)("AIR-001", TEST)
    expect(ok.status).toBe(200)
    expect(data(ok).sandbox).toBe(true)
    expect(Object.keys(data(ok).order).sort()).toEqual(ORDER_KEYS)
    deps.sandbox.getOrder.mockResolvedValueOnce(prior({ action: "data_order" }))
    const other = await airtimeOrderHandler(deps)("AIR-001", TEST)
    deps.sandbox.getOrder.mockResolvedValueOnce(null)
    const missing = await airtimeOrderHandler(deps)("AIR-001", TEST)
    expect(other).toEqual({ status: 404, error: { status: 404, message: MSG_AIRTIME_NOT_FOUND } })
    expect(missing).toEqual(other)
    expect(deps.sandbox.getOrder).toHaveBeenCalledWith("user-1", "AIR-001")
    liveDepsUntouched(deps)
  })

  it("sandbox list uses listOrders(user, 'airtime', 30); a read error => 503", async () => {
    const { deps } = makeDeps()
    deps.sandbox.listOrders.mockResolvedValueOnce([prior(), prior({ reference: "AIR-000" })])
    const r = await airtimeListHandler(deps)(TEST)
    expect(r.status).toBe(200)
    expect(deps.sandbox.listOrders).toHaveBeenCalledWith("user-1", "airtime", 30)
    expect(data(r).sandbox).toBe(true)
    expect(data(r).orders.map((o: any) => o.reference)).toEqual(["AIR-001", "AIR-000"])
    for (const o of data(r).orders) expect(Object.keys(o).sort()).toEqual(ORDER_KEYS)
    deps.sandbox.listOrders.mockResolvedValueOnce(null)
    expect((await airtimeListHandler(deps)(TEST)).status).toBe(503)
    liveDepsUntouched(deps)
  })
})
