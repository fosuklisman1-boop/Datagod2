import { describe, it, expect, vi, afterEach } from "vitest"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { resultsHash, parseResultsBody } from "../standard-orders"
import {
  typesHandler,
  purchaseResultsHandler,
  resultsOrderHandler,
  resultsListHandler,
  RESULTS_LIST_LIMIT,
  MSG_RESULTS_NOT_FOUND,
  MSG_RESULTS_OUTCOME_UNKNOWN,
  MSG_RESULTS_PRIOR_UNKNOWN,
  MSG_RESULTS_IN_PROGRESS,
  type ResultsDeps,
  type ResultsEngineParams,
  type ResultsOrderRow,
  type ResultsSandboxOrder,
} from "./results"

// ---------------------------------------------------------------- fixtures

// Unique test phones for this file: 0249990901-0249990999.
const PHONE = "0249990901"
const EMAIL = "someone-else.rc@example.com"
const PIN_1 = "PIN-SECRET-ALPHA-111"
const PIN_2 = "PIN-SECRET-BETA-222"
const SERIAL_1 = "SERIAL-SECRET-1"
const SERIAL_2 = "SERIAL-SECRET-2"
const SECRETS = [PIN_1, PIN_2, SERIAL_1, SERIAL_2, PHONE, EMAIL]

const ORDER_KEYS = ["created_at", "exam_board", "quantity", "reference", "status", "total_paid", "unit_price"].sort()
const CREATED = "2026-10-26T10:00:00.000Z"
const NOW_MS = Date.parse("2026-10-26T10:00:05.000Z")

const ctxOf = (environment: "live" | "test"): V2Context => ({
  keyId: environment === "live" ? "key-live-1" : "key-test-1",
  userId: "user-1",
  role: "dealer",
  keyType: "standard",
  environment,
  firstName: null,
})
const LIVE = ctxOf("live")
const TEST = ctxOf("test")

const body = (over: Record<string, unknown> = {}) => ({ exam_board: "WASSCE", quantity: 2, reference: "RC-001", ...over })

function engineOk(p: ResultsEngineParams, code = "RC-AAA-BBB") {
  return {
    order: {
      id: "order-uuid-1",
      user_id: p.userId,
      reference_code: code,
      exam_board: p.examBoard,
      quantity: p.quantity,
      unit_price: 20,
      total_paid: 20 * p.quantity,
      status: "completed",
      inventory_ids: ["inv-1", "inv-2"],
      shop_id: null,
      created_at: CREATED,
    },
    vouchers: [
      { id: "inv-1", pin: PIN_1, serial_number: SERIAL_1 },
      { id: "inv-2", pin: PIN_2, serial_number: SERIAL_2 },
    ],
    newBalance: 60,
  }
}

function liveRow(over: Partial<ResultsOrderRow> = {}): ResultsOrderRow {
  return { reference_code: "RC-AAA-BBB", exam_board: "WASSCE", quantity: 2, unit_price: 20, total_paid: 40, status: "completed", created_at: CREATED, ...over }
}

function engineError(code: unknown, extra: Record<string, unknown> = {}) {
  const e: any = new Error(`engine said something with ${PHONE} and ${PIN_1} in it`)
  if (code !== undefined) e.code = code
  Object.assign(e, extra)
  return e
}

function claimTable() {
  type Row = { id: string; userId: string; reference: string; hash: string; status: string; orderRef: string | null; response: unknown }
  const rows = new Map<string, Row>()
  let n = 0
  const key = (u: string, r: string) => `${u}|${r}`
  return {
    rows,
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "results"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
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
    getClaim: vi.fn(
      async (_u: string, _r: string): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null> => null
    ),
    listClaims: vi.fn(async (_u: string, _limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null> => []),
    alert: vi.fn(async (_m: string): Promise<void> => {}),
    engine: vi.fn(async (p: ResultsEngineParams) => engineOk(p)),
    getMaxQuantity: vi.fn(async () => 15),
    boardEnabled: vi.fn(async (_b: string) => true),
    available: vi.fn(async (_b: string) => 100),
    price: vi.fn(async (_b: string, q: number) => ({ unitPrice: 20, totalPaid: 20 * q })),
    readVouchers: vi.fn(async (_u: string, _o: string): Promise<{ pin: string; serial_number: string | null }[] | null> => [
      { pin: PIN_1, serial_number: SERIAL_1 },
      { pin: PIN_2, serial_number: SERIAL_2 },
    ]),
    getOrderByCode: vi.fn(async (_u: string, _c: string): Promise<ResultsOrderRow | null> => liveRow()),
    getOrdersByCodes: vi.fn(async (_u: string, _c: string[]): Promise<ResultsOrderRow[] | null> => []),
    deliver: vi.fn(async (_o: Record<string, any>, _v: unknown, _p: string | null, _e: string | null): Promise<void> => {}),
    phoneGate: vi.fn(async (_u: string) => true),
    sandbox: {
      getOrder: vi.fn(async (_u: string, _r: string): Promise<ResultsSandboxOrder | null> => null),
      listOrders: vi.fn(async (_u: string, _a: "results_checker", _l: number): Promise<ResultsSandboxOrder[] | null> => []),
      place: vi.fn(async (p: any) => ({
        success: true as const,
        order: { ...p.orderFields, reference: p.reference, status: "completed", created_at: CREATED },
        newBalance: 60,
      })),
    },
    now: () => NOW_MS,
  }
  return { deps: deps satisfies ResultsDeps, table }
}

type Deps = ReturnType<typeof makeDeps>["deps"]

function liveDepsUntouched(deps: Deps) {
  for (const f of [
    deps.claim, deps.complete, deps.release, deps.markUnknown, deps.engine, deps.boardEnabled, deps.available,
    deps.readVouchers, deps.phoneGate, deps.getClaim, deps.listClaims, deps.getOrderByCode, deps.getOrdersByCodes,
    deps.deliver, deps.alert,
  ]) {
    expect(f).not.toHaveBeenCalled()
  }
}

const data = (r: { data?: unknown }) => r.data as any

/** Every console call and alert text, serialised. */
function noSecretsAnywhere(spies: { mock: { calls: unknown[][] } }[], deps?: Deps) {
  const logged = JSON.stringify(spies.map((s) => s.mock.calls))
  for (const s of SECRETS) expect(logged).not.toContain(s)
  if (deps) {
    const alerts = JSON.stringify(deps.alert.mock.calls)
    for (const s of SECRETS) expect(alerts).not.toContain(s)
  }
}

function logSpies() {
  return [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ]
}

/** Deep key scan: no object anywhere has pin / serial_number keys. */
function hasKey(v: unknown, names: string[]): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, names))
  if (typeof v === "object" && v !== null) {
    return Object.entries(v).some(([k, x]) => names.includes(k) || hasKey(x, names))
  }
  return false
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- purchase: happy path

describe("POST /resultschecker/purchase (live): new purchase", () => {
  it("claims, gates, calls the engine ONCE with exactly { userId, examBoard, quantity }, completes with the engine code", async () => {
    const { deps } = makeDeps()
    const r = await purchaseResultsHandler(deps)(body({ exam_board: "bece" }), LIVE)
    expect(r.status).toBe(201)
    const parsed = parseResultsBody(body({ exam_board: "bece" }), 15)
    if (!parsed.ok) throw new Error("fixture")
    expect(deps.claim).toHaveBeenCalledTimes(1)
    expect(deps.claim).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      kind: "results",
      reference: "RC-001",
      requestHash: resultsHash(parsed.value),
    })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.engine).toHaveBeenCalledWith({ userId: "user-1", examBoard: "BECE", quantity: 2 })
    expect(Object.keys(deps.engine.mock.calls[0][0]).sort()).toEqual(["examBoard", "quantity", "userId"])
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.complete.mock.calls[0][1]).toBe("RC-AAA-BBB")
    expect(deps.complete.mock.calls[0][3]).toBe("user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    // claim -> board -> stock -> phone gate -> engine -> complete
    const order = [deps.claim, deps.boardEnabled, deps.available, deps.phoneGate, deps.engine, deps.complete].map((f) => f.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("the stored claim response has NO pin / serial_number key anywhere", async () => {
    const { deps, table } = makeDeps()
    await purchaseResultsHandler(deps)(body(), LIVE)
    const stored = [...table.rows.values()][0]
    expect(stored.status).toBe("done")
    expect(stored.orderRef).toBe("RC-AAA-BBB")
    expect(hasKey(stored.response, ["pin", "serial_number", "vouchers"])).toBe(false)
    const text = JSON.stringify(deps.complete.mock.calls)
    for (const s of [PIN_1, PIN_2, SERIAL_1, SERIAL_2]) expect(text).not.toContain(s)
    expect(Object.keys(stored.response as object).sort()).toEqual(ORDER_KEYS)
  })

  it("returns 201 { order, vouchers, new_balance } with mapped vouchers (no id) and the CLIENT reference", async () => {
    const { deps } = makeDeps()
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    const d = data(r)
    expect(Object.keys(d).sort()).toEqual(["new_balance", "order", "vouchers"])
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order).toMatchObject({ reference: "RC-001", exam_board: "WASSCE", quantity: 2, unit_price: 20, total_paid: 40, status: "completed", created_at: CREATED })
    expect(d.vouchers).toEqual([
      { pin: PIN_1, serial_number: SERIAL_1 },
      { pin: PIN_2, serial_number: SERIAL_2 },
    ])
    expect(d.new_balance).toBe(60)
    expect(JSON.stringify(d)).not.toContain("RC-AAA-BBB")
    expect(JSON.stringify(d)).not.toContain("inv-1")
    expect(JSON.stringify(d)).not.toContain("order-uuid-1")
  })

  it("complete() false: markUnknown keeps the order link, one alert, still 201 with vouchers, no release", async () => {
    const spies = logSpies()
    const { deps } = makeDeps()
    deps.complete.mockResolvedValueOnce(false)
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).vouchers).toHaveLength(2)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.markUnknown).toHaveBeenCalledWith("claim-1", "user-1", "RC-AAA-BBB")
    expect(deps.alert).toHaveBeenCalledTimes(1)
    expect(deps.alert.mock.calls[0][0]).toContain("user-1")
    expect(deps.alert.mock.calls[0][0]).toContain("RC-001")
    expect(deps.alert.mock.calls[0][0]).toContain("results")
    // the engine order code is in the alert so admins can find the order (no PIN/serial/phone/email)
    expect(deps.alert.mock.calls[0][0]).toContain("RC-AAA-BBB")
    noSecretsAnywhere(spies, deps)
  })

  it("complete() throwing behaves like false", async () => {
    logSpies()
    const { deps, table } = makeDeps()
    deps.complete.mockRejectedValueOnce(new Error("db"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect([...table.rows.values()][0]).toMatchObject({ status: "unknown", orderRef: "RC-AAA-BBB" })
  })

  it("an alert that throws never changes the response", async () => {
    logSpies()
    const { deps } = makeDeps()
    deps.complete.mockResolvedValueOnce(false)
    deps.alert.mockRejectedValueOnce(new Error("notifier down"))
    expect((await purchaseResultsHandler(deps)(body(), LIVE)).status).toBe(201)
  })
})

// ---------------------------------------------------------------- purchase: replay and claim branches

describe("POST /resultschecker/purchase: claim outcomes", () => {
  async function completedTable() {
    const made = makeDeps()
    await purchaseResultsHandler(made.deps)(body(), LIVE)
    for (const f of [made.deps.engine, made.deps.deliver, made.deps.readVouchers, made.deps.phoneGate, made.deps.boardEnabled, made.deps.available, made.deps.getOrderByCode, made.deps.complete]) {
      f.mockClear()
    }
    return made
  }

  it("replay: 200 { order, vouchers, replayed: true }; no engine, gates or delivery; vouchers re-read with ctx.userId and the stored order_ref", async () => {
    const { deps } = await completedTable()
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    const d = data(r)
    expect(Object.keys(d).sort()).toEqual(["order", "replayed", "vouchers"])
    expect(d.replayed).toBe(true)
    expect(d.vouchers).toEqual([
      { pin: PIN_1, serial_number: SERIAL_1 },
      { pin: PIN_2, serial_number: SERIAL_2 },
    ])
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order.reference).toBe("RC-001")
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.boardEnabled).not.toHaveBeenCalled()
    expect(deps.available).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(deps.readVouchers).toHaveBeenCalledTimes(1)
    expect(deps.readVouchers).toHaveBeenCalledWith("user-1", "RC-AAA-BBB")
  })

  it("replay with recipient contact still never delivers again", async () => {
    const made = makeDeps()
    const b = body({ recipient_phone: PHONE })
    await purchaseResultsHandler(made.deps)(b, LIVE)
    made.deps.deliver.mockClear()
    const r = await purchaseResultsHandler(made.deps)(b, LIVE)
    expect(r.status).toBe(200)
    expect(made.deps.deliver).not.toHaveBeenCalled()
    expect(made.deps.engine).toHaveBeenCalledTimes(1)
  })

  it("replay: status refreshed from the live row; a non-completed order serves NO vouchers", async () => {
    const { deps } = await completedTable()
    deps.getOrderByCode.mockResolvedValue(liveRow({ status: "failed" }))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    expect(data(r).order.status).toBe("failed")
    expect(data(r).vouchers).toEqual([])
    expect(deps.readVouchers).not.toHaveBeenCalled()
  })

  it("replay fails closed (503) when the live order or the vouchers cannot be read", async () => {
    const a = await completedTable()
    a.deps.getOrderByCode.mockResolvedValue(null)
    expect((await purchaseResultsHandler(a.deps)(body(), LIVE)).status).toBe(503)
    const b = await completedTable()
    b.deps.readVouchers.mockResolvedValue(null)
    expect((await purchaseResultsHandler(b.deps)(body(), LIVE)).status).toBe(503)
    const c = await completedTable()
    c.deps.readVouchers.mockRejectedValue(new Error("db"))
    expect((await purchaseResultsHandler(c.deps)(body(), LIVE)).status).toBe(503)
    const d = await completedTable()
    d.deps.readVouchers.mockResolvedValue([])
    const dr = await purchaseResultsHandler(d.deps)(body(), LIVE)
    expect(dr.status).toBe(503)
    // A charged order: its own code, never the "nothing was charged" UNAVAILABLE wording.
    expect(dr.error?.message).toMatch(/^VOUCHERS_UNAVAILABLE: your order was placed and charged;/)
    expect(dr.error?.message).toContain("do not place a new order")
    expect(dr.error?.message).not.toMatch(/^UNAVAILABLE/)
    expect(dr.error?.message).not.toContain("nothing was charged")
  })

  it("conflict (same reference, different content) => 409 REFERENCE_REUSED, nothing else runs", async () => {
    const { deps } = await completedTable()
    const r = await purchaseResultsHandler(deps)(body({ quantity: 3 }), LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message).toMatch(/^REFERENCE_REUSED/)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.readVouchers).not.toHaveBeenCalled()
  })

  it("in_progress / unknown / error claim outcomes never reach the engine", async () => {
    const cases: [ClaimOutcome, number, RegExp][] = [
      [{ kind: "in_progress" }, 409, /^REQUEST_IN_PROGRESS/],
      [{ kind: "unknown" }, 409, /^OUTCOME_UNKNOWN/],
      [{ kind: "error" }, 503, /^UNAVAILABLE/],
    ]
    for (const [outcome, status, re] of cases) {
      const { deps } = makeDeps()
      deps.claim.mockResolvedValueOnce(outcome)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(status)
      expect(r.error?.message).toMatch(re)
      expect(deps.engine).not.toHaveBeenCalled()
      expect(deps.phoneGate).not.toHaveBeenCalled()
      expect(deps.readVouchers).not.toHaveBeenCalled()
      expect(deps.release).not.toHaveBeenCalled()
    }
    expect(MSG_RESULTS_IN_PROGRESS).toContain("/resultschecker/orders/{reference}")
    expect(MSG_RESULTS_PRIOR_UNKNOWN).toContain("Do not place this order again")
  })

  it("a throwing claim reads as error => 503, no engine", async () => {
    const { deps } = makeDeps()
    deps.claim.mockRejectedValueOnce(new Error("db"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(deps.engine).not.toHaveBeenCalled()
  })

  it("two concurrent requests with one reference reach the engine at most once", async () => {
    const { deps } = makeDeps()
    const [a, b] = await Promise.all([purchaseResultsHandler(deps)(body(), LIVE), purchaseResultsHandler(deps)(body(), LIVE)])
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect([a.status, b.status].sort()).toEqual([201, 409])
  })
})

// ---------------------------------------------------------------- purchase: gates

describe("POST /resultschecker/purchase: gates release the claim and never reach the engine", () => {
  it("board disabled => release + 503 with the board name", async () => {
    const { deps, table } = makeDeps()
    deps.boardEnabled.mockResolvedValue(false)
    const r = await purchaseResultsHandler(deps)(body({ exam_board: "BECE" }), LIVE)
    expect(r.status).toBe(503)
    expect(r.error?.message).toBe("BECE vouchers are currently unavailable")
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.engine).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("board read throwing => release + 503", async () => {
    const { deps } = makeDeps()
    deps.boardEnabled.mockRejectedValue(new Error("db"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(deps.engine).not.toHaveBeenCalled()
  })

  it("out of stock (available < quantity) => release + 409 OUT_OF_STOCK", async () => {
    const { deps } = makeDeps()
    deps.available.mockResolvedValue(1)
    const r = await purchaseResultsHandler(deps)(body({ quantity: 2 }), LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message).toMatch(/^OUT_OF_STOCK:/)
    expect(deps.release).toHaveBeenCalledTimes(1)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
  })

  it("available == quantity passes the stock check", async () => {
    const { deps } = makeDeps()
    deps.available.mockResolvedValue(2)
    expect((await purchaseResultsHandler(deps)(body({ quantity: 2 }), LIVE)).status).toBe(201)
  })

  it("stock read throwing or NaN => release + 503, no engine", async () => {
    for (const mk of [() => Promise.reject(new Error("db")), () => Promise.resolve(Number.NaN)]) {
      const { deps } = makeDeps()
      deps.available.mockImplementation(mk as any)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(503)
      expect(deps.release).toHaveBeenCalledTimes(1)
      expect(deps.engine).not.toHaveBeenCalled()
    }
  })

  it("phone gate false or throwing => release + 403 PHONE_NOT_VERIFIED, no engine", async () => {
    for (const mk of [() => Promise.resolve(false), () => Promise.reject(new Error("db")), () => Promise.resolve("yes" as any)]) {
      const { deps } = makeDeps()
      deps.phoneGate.mockImplementation(mk as any)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(403)
      expect(r.error?.message).toMatch(/^PHONE_NOT_VERIFIED/)
      expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
      expect(deps.engine).not.toHaveBeenCalled()
    }
  })

  it("an unreadable / zero price (the engine would charge 0) => release + 503 UNAVAILABLE, nothing charged, no engine", async () => {
    const bad: Array<() => Promise<any>> = [
      () => Promise.resolve({ unitPrice: 0, totalPaid: 0 }),
      () => Promise.resolve({ unitPrice: 20, totalPaid: 0 }),
      () => Promise.resolve({ unitPrice: Number.NaN, totalPaid: Number.NaN }),
      () => Promise.resolve({ unitPrice: 20, totalPaid: -5 }),
      () => Promise.resolve(undefined),
      () => Promise.reject(new Error("db")),
    ]
    for (const mk of bad) {
      const { deps, table } = makeDeps()
      deps.price.mockImplementation(mk as any)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(503)
      expect(r.error?.message).toMatch(/^UNAVAILABLE: .*nothing was charged/)
      expect(deps.price).toHaveBeenCalledWith("WASSCE", 2)
      expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
      expect(deps.engine).not.toHaveBeenCalled()
      expect(table.rows.size).toBe(0)
    }
  })

  it("max quantity read failing => 503 before any claim", async () => {
    for (const mk of [() => Promise.reject(new Error("db")), () => Promise.resolve(Number.NaN), () => Promise.resolve(0)]) {
      const { deps } = makeDeps()
      deps.getMaxQuantity.mockImplementation(mk as any)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(503)
      liveDepsUntouched(deps)
    }
  })
})

// ---------------------------------------------------------------- purchase: engine errors

describe("POST /resultschecker/purchase: engine error classification", () => {
  it("INSUFFICIENT_BALANCE releases the claim and answers 402 with the required wording", async () => {
    const { deps, table } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE", { required: 40 }))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(402)
    expect(r.error?.message).toBe("INSUFFICIENT_BALANCE: wallet balance is too low; required 40.00")
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    expect(table.rows.size).toBe(0)
  })

  it("INSUFFICIENT_BALANCE without a required amount still maps 402", async () => {
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(402)
    expect(r.error?.message).toBe("INSUFFICIENT_BALANCE: wallet balance is too low")
  })

  it("INSUFFICIENT_INVENTORY marks unknown + alerts, never releases, answers 500 OUTCOME_UNKNOWN (never 503)", async () => {
    const spies = logSpies()
    const { deps, table } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_INVENTORY"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    const msg = r.error?.message ?? ""
    expect(msg).toMatch(/^OUTCOME_UNKNOWN:/)
    expect(msg).toContain("ran out after the wallet was charged")
    expect(msg).toContain("refund")
    expect(msg).toContain("Check your wallet balance and order history")
    expect(msg).toContain("contact support quoting the reference")
    // "new reference" only ever appears in a "do not" sentence
    for (const m of msg.matchAll(/new reference/g)) expect(msg.slice(Math.max(0, m.index! - 60), m.index!)).toMatch(/Do not place this order again under a$|Do not[^.]*$/)
    expect(msg).not.toMatch(/retrying under a new reference/)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).toHaveBeenCalledWith("claim-1", "user-1")
    expect(deps.alert).toHaveBeenCalledTimes(1)
    expect([...table.rows.values()][0].status).toBe("unknown")
    noSecretsAnywhere(spies, deps)
  })

  it("uncoded Error, unknown code and non-Error throws mark unknown + alert, 500 OUTCOME_UNKNOWN, never release", async () => {
    const throwables: unknown[] = [new Error("Failed to process payment"), engineError("SOMETHING_NEW"), "boom", undefined, null, 42, { code: "PAYMENT_FAILED" }]
    for (const t of throwables) {
      const spies = logSpies()
      const { deps } = makeDeps()
      deps.engine.mockRejectedValueOnce(t)
      const r = await purchaseResultsHandler(deps)(body(), LIVE)
      expect(r.status).toBe(500)
      expect(r.error?.message).toBe(MSG_RESULTS_OUTCOME_UNKNOWN)
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.markUnknown).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledTimes(1)
      const alertText = deps.alert.mock.calls[0][0]
      expect(alertText).toContain("user-1")
      expect(alertText).toContain("RC-001")
      noSecretsAnywhere(spies, deps)
      vi.restoreAllMocks()
    }
  })

  it("engine message text (with a phone and a PIN in it) is never echoed", async () => {
    const spies = logSpies()
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE", { required: 40 }))
    const a = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(JSON.stringify(a)).not.toContain(PHONE)
    expect(JSON.stringify(a)).not.toContain(PIN_1)
    const m = makeDeps()
    m.deps.engine.mockRejectedValueOnce(engineError(undefined))
    const b = await purchaseResultsHandler(m.deps)(body(), LIVE)
    expect(JSON.stringify(b)).not.toContain(PHONE)
    noSecretsAnywhere(spies)
  })

  it("an engine result with no order code is ambiguous: unknown + alert, no release, no vouchers returned", async () => {
    logSpies()
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ order: {}, vouchers: [], newBalance: 1 } as any)
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.alert).toHaveBeenCalledTimes(1)
  })

  it("release failing (false or throw) is logged and the no-charge answer still returns", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(engineError("INSUFFICIENT_BALANCE", { required: 40 }))
    deps.release.mockRejectedValueOnce(new Error("db"))
    const r = await purchaseResultsHandler(deps)(body(), LIVE)
    expect(r.status).toBe(402)
    expect(err).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- purchase: delivery

describe("POST /resultschecker/purchase: delivery", () => {
  it("no recipient contact => no delivery at all (never the account profile)", async () => {
    const { deps } = makeDeps()
    expect((await purchaseResultsHandler(deps)(body(), LIVE)).status).toBe(201)
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it("recipient phone and/or email => one delivery with the recipient fields, order and engine vouchers", async () => {
    const { deps } = makeDeps()
    const r = await purchaseResultsHandler(deps)(body({ recipient_phone: "+233 24 999 0901", recipient_email: " Someone-Else.RC@Example.com " }), LIVE)
    expect(r.status).toBe(201)
    expect(deps.deliver).toHaveBeenCalledTimes(1)
    const [order, vouchers, phone, email] = deps.deliver.mock.calls[0]
    expect(phone).toBe(PHONE)
    expect(email).toBe(EMAIL)
    expect(order.reference_code).toBe("RC-AAA-BBB")
    expect(order.user_id).toBe("user-1")
    expect((vouchers as any[]).map((v) => v.pin)).toEqual([PIN_1, PIN_2])
    // the delivery happens after the claim is completed
    expect(deps.complete.mock.invocationCallOrder[0]).toBeLessThan(deps.deliver.mock.invocationCallOrder[0])
  })

  it("phone only / email only pass null for the other", async () => {
    const a = makeDeps()
    await purchaseResultsHandler(a.deps)(body({ recipient_phone: PHONE }), LIVE)
    expect(a.deps.deliver.mock.calls[0].slice(2)).toEqual([PHONE, null])
    const b = makeDeps()
    await purchaseResultsHandler(b.deps)(body({ recipient_email: EMAIL }), LIVE)
    expect(b.deps.deliver.mock.calls[0].slice(2)).toEqual([null, EMAIL])
  })

  it("a delivery that throws never changes the response and logs nothing sensitive", async () => {
    const spies = logSpies()
    const { deps } = makeDeps()
    deps.deliver.mockRejectedValue(new Error(`SMS to ${PHONE} with ${PIN_1} failed`))
    const r = await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE }), LIVE)
    expect(r.status).toBe(201)
    expect(data(r).vouchers).toHaveLength(2)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    noSecretsAnywhere(spies, deps)
  })

  it("a different recipient is a different request (conflict on the same reference)", async () => {
    const { deps } = makeDeps()
    await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE }), LIVE)
    const r = await purchaseResultsHandler(deps)(body({ recipient_phone: "0249990902" }), LIVE)
    expect(r.status).toBe(409)
  })
})

// ---------------------------------------------------------------- purchase: validation

describe("POST /resultschecker/purchase: validation before any dependency call", () => {
  const forbidden = ["price", "unit_price", "total_paid", "amount", "shop_id", "markup", "user_id", "status", "package_id", "fee"]
  for (const f of forbidden) {
    it(`rejects body field ${f} with 400 and touches nothing`, async () => {
      const { deps } = makeDeps()
      const r = await purchaseResultsHandler(deps)(body({ [f]: 1 }), LIVE)
      expect(r.status).toBe(400)
      liveDepsUntouched(deps)
    })
  }

  it("quantity: 0 / 1.5 / 'abc' / negative / above max => 400, nothing touched", async () => {
    for (const q of [0, 1.5, "abc", -1, 16, "16", null, undefined, true, 1e21]) {
      const { deps } = makeDeps()
      const r = await purchaseResultsHandler(deps)(body({ quantity: q }), LIVE)
      expect(r.status).toBe(400)
      liveDepsUntouched(deps)
    }
  })

  it("quantity at the max passes, and the max is read from getMaxQuantity", async () => {
    const { deps } = makeDeps()
    deps.getMaxQuantity.mockResolvedValue(5)
    expect((await purchaseResultsHandler(deps)(body({ quantity: 6 }), LIVE)).status).toBe(400)
    expect((await purchaseResultsHandler(deps)(body({ quantity: 5, reference: "RC-005" }), LIVE)).status).toBe(201)
  })

  it("bad board / reference / contact / body shape => 400", async () => {
    for (const b of [body({ exam_board: "GCE" }), body({ exam_board: 1 }), body({ reference: "" }), body({ recipient_phone: "12" }), body({ recipient_email: "nope" }), null, [], "x"]) {
      const { deps } = makeDeps()
      const r = await purchaseResultsHandler(deps)(b, LIVE)
      expect(r.status).toBe(400)
      liveDepsUntouched(deps)
    }
  })
})

// ---------------------------------------------------------------- types

describe("GET /resultschecker/types", () => {
  it("lists WASSCE/BECE/NOVDEC with price, available (a number) and enabled; never PIN data", async () => {
    const { deps } = makeDeps()
    deps.price.mockImplementation(async (b: string, q: number) => ({ unitPrice: b === "BECE" ? 15.5 : 20, totalPaid: 0 * q }))
    deps.available.mockImplementation(async (b: string) => (b === "NOVDEC" ? 0 : 42))
    deps.boardEnabled.mockImplementation(async (b: string) => b !== "NOVDEC")
    const r = await typesHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(data(r).types).toEqual([
      { exam_board: "WASSCE", price: 20, available: 42, enabled: true },
      { exam_board: "BECE", price: 15.5, available: 42, enabled: true },
      { exam_board: "NOVDEC", price: 20, available: 0, enabled: false },
    ])
    expect(deps.price).toHaveBeenCalledWith("WASSCE", 1)
    expect(hasKey(data(r), ["pin", "serial_number", "id"])).toBe(false)
    expect(deps.readVouchers).not.toHaveBeenCalled()
    expect(deps.claim).not.toHaveBeenCalled()
  })

  it("a failing board shows enabled false, available 0, price null; the others are unaffected", async () => {
    const { deps } = makeDeps()
    deps.available.mockImplementation(async (b: string) => {
      if (b === "BECE") throw new Error("db")
      return 10
    })
    const r = await typesHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(data(r).types[1]).toEqual({ exam_board: "BECE", price: null, available: 0, enabled: false })
    expect(data(r).types[0]).toMatchObject({ exam_board: "WASSCE", enabled: true, available: 10 })
  })

  it("all three failing => 503", async () => {
    const { deps } = makeDeps()
    deps.boardEnabled.mockRejectedValue(new Error("db"))
    const r = await typesHandler(deps)(LIVE)
    expect(r.status).toBe(503)
  })
})

// ---------------------------------------------------------------- lookup

describe("GET /resultschecker/orders/{reference}", () => {
  const done = { orderRef: "RC-AAA-BBB", status: "done", response: { reference: "RC-001", exam_board: "WASSCE", quantity: 2, unit_price: 20, total_paid: 40, status: "completed", created_at: CREATED, pin: "LEAK" }, createdAt: CREATED }

  it("done claim + completed order: order + owner-scoped vouchers, claim null, allow-listed keys only", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue(done)
    const r = await resultsOrderHandler(deps)("RC-001", LIVE)
    expect(r.status).toBe(200)
    const d = data(r)
    expect(Object.keys(d).sort()).toEqual(["claim", "order", "vouchers"])
    expect(d.claim).toBeNull()
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.vouchers).toEqual([
      { pin: PIN_1, serial_number: SERIAL_1 },
      { pin: PIN_2, serial_number: SERIAL_2 },
    ])
    expect(JSON.stringify(d)).not.toContain("LEAK")
    expect(deps.getClaim).toHaveBeenCalledWith("user-1", "RC-001")
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "RC-AAA-BBB")
    expect(deps.readVouchers).toHaveBeenCalledWith("user-1", "RC-AAA-BBB")
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.deliver).not.toHaveBeenCalled()
  })

  it("status refreshed from the live row; a non-completed order carries no vouchers and no read", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue(done)
    deps.getOrderByCode.mockResolvedValue(liveRow({ status: "refunded" }))
    const r = await resultsOrderHandler(deps)("RC-001", LIVE)
    expect(data(r).order.status).toBe("refunded")
    expect(data(r).vouchers).toEqual([])
    expect(deps.readVouchers).not.toHaveBeenCalled()
  })

  it("done claim whose live order or vouchers cannot be read => 503, never an empty 200", async () => {
    const a = makeDeps()
    a.deps.getClaim.mockResolvedValue(done)
    a.deps.getOrderByCode.mockResolvedValue(null)
    expect((await resultsOrderHandler(a.deps)("RC-001", LIVE)).status).toBe(503)
    const b = makeDeps()
    b.deps.getClaim.mockResolvedValue(done)
    b.deps.readVouchers.mockResolvedValue(null)
    const br = await resultsOrderHandler(b.deps)("RC-001", LIVE)
    expect(br.status).toBe(503)
    expect(br.error?.message).toMatch(/^VOUCHERS_UNAVAILABLE:/)
  })

  it("own in_progress / unknown claim => 200 { order: null, claim } with no vouchers and no reads", async () => {
    for (const [status, state] of [["in_progress", "in_progress"], ["unknown", "outcome_unknown"]] as const) {
      const { deps } = makeDeps()
      deps.getClaim.mockResolvedValue({ orderRef: "RC-AAA-BBB", status, response: null, createdAt: new Date(NOW_MS - 1000).toISOString() })
      const r = await resultsOrderHandler(deps)("RC-001", LIVE)
      expect(r.status).toBe(200)
      expect(data(r)).toEqual({ order: null, claim: { reference: "RC-001", state } })
      expect(deps.getOrderByCode).not.toHaveBeenCalled()
      expect(deps.readVouchers).not.toHaveBeenCalled()
    }
  })

  it("missing, foreign (getClaim is owner-scoped), malformed and throwing lookups all give the identical 404", async () => {
    const results: unknown[] = []
    for (const [ref, setup] of [
      ["RC-404", (d: Deps) => d.getClaim.mockResolvedValue(null)],
      ["RC-405", (d: Deps) => d.getClaim.mockRejectedValue(new Error("db"))],
      ["bad ref!", (_d: Deps) => {}],
      ["RC-406", (d: Deps) => d.getClaim.mockResolvedValue({ orderRef: null, status: "done", response: null })],
    ] as const) {
      const { deps } = makeDeps()
      setup(deps)
      const r = await resultsOrderHandler(deps)(ref, LIVE)
      expect(r.status).toBe(404)
      results.push(r)
      expect(deps.readVouchers).not.toHaveBeenCalled()
    }
    for (const r of results) expect(r).toEqual(results[0])
    expect((results[0] as any).error.message).toBe(MSG_RESULTS_NOT_FOUND)
  })
})

// ---------------------------------------------------------------- list

describe("GET /resultschecker/orders", () => {
  it("caps at 30, lists done claims with ONE order query, and never includes vouchers", async () => {
    const { deps } = makeDeps()
    const claims = Array.from({ length: 40 }, (_, i) => ({ reference: `REF-${i}`, orderRef: `RC-${i}`, status: "done" }))
    deps.listClaims.mockResolvedValue(claims)
    deps.getOrdersByCodes.mockImplementation(async (_u: string, codes: string[]) => codes.map((c) => liveRow({ reference_code: c })))
    const r = await resultsListHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(deps.listClaims).toHaveBeenCalledWith("user-1", RESULTS_LIST_LIMIT)
    expect(deps.getOrdersByCodes).toHaveBeenCalledTimes(1)
    expect(deps.getOrdersByCodes.mock.calls[0][0]).toBe("user-1")
    expect(deps.getOrdersByCodes.mock.calls[0][1]).toHaveLength(30)
    expect(data(r).orders).toHaveLength(30)
    expect(data(r).orders[0].reference).toBe("REF-0")
    for (const o of data(r).orders) expect(Object.keys(o).sort()).toEqual(ORDER_KEYS)
    expect(hasKey(data(r), ["pin", "serial_number", "vouchers"])).toBe(false)
    expect(deps.readVouchers).not.toHaveBeenCalled()
  })

  it("skips non-done claims and orders that vanished; empty => 200 [] without an order query", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValue([
      { reference: "A", orderRef: "RC-1", status: "done" },
      { reference: "B", orderRef: null, status: "in_progress" },
      { reference: "C", orderRef: "RC-3", status: "done" },
    ])
    deps.getOrdersByCodes.mockResolvedValue([liveRow({ reference_code: "RC-1" })])
    const r = await resultsListHandler(deps)(LIVE)
    expect(data(r).orders.map((o: any) => o.reference)).toEqual(["A"])
    const e = makeDeps()
    expect(data(await resultsListHandler(e.deps)(LIVE))).toEqual({ orders: [] })
    expect(e.deps.getOrdersByCodes).not.toHaveBeenCalled()
  })

  it("claim store or order read failure => 503, never an empty 200", async () => {
    const a = makeDeps()
    a.deps.listClaims.mockResolvedValue(null)
    expect((await resultsListHandler(a.deps)(LIVE)).status).toBe(503)
    const b = makeDeps()
    b.deps.listClaims.mockRejectedValue(new Error("db"))
    expect((await resultsListHandler(b.deps)(LIVE)).status).toBe(503)
    const c = makeDeps()
    c.deps.listClaims.mockResolvedValue([{ reference: "A", orderRef: "RC-1", status: "done" }])
    c.deps.getOrdersByCodes.mockResolvedValue(null)
    expect((await resultsListHandler(c.deps)(LIVE)).status).toBe(503)
  })
})

// ---------------------------------------------------------------- sandbox

describe("sandbox (test key)", () => {
  function sandboxStore() {
    const store = new Map<string, ResultsSandboxOrder>()
    return {
      store,
      getOrder: vi.fn(async (_u: string, ref: string) => store.get(ref) ?? null),
      listOrders: vi.fn(async (_u: string, _a: "results_checker", _l: number): Promise<ResultsSandboxOrder[] | null> => [...store.values()]),
      place: vi.fn(async (p: any) => {
        const row: ResultsSandboxOrder = {
          reference: p.reference,
          action: p.action,
          response: { ...p.orderFields, reference: p.reference, status: "completed" },
          price: p.price,
          created_at: CREATED,
          status: "completed",
        }
        store.set(p.reference, row)
        return { success: true as const, order: { ...p.orderFields, reference: p.reference, status: "completed", created_at: CREATED }, newBalance: 60 }
      }),
    }
  }

  it("places via the sandbox store with the v2 key and instant, fake TEST- vouchers, never touching live deps", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    const r = await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE }), TEST)
    expect(r.status).toBe(201)
    const d = data(r)
    expect(d.sandbox).toBe(true)
    expect(d.vouchers).toHaveLength(2)
    for (const [i, v] of d.vouchers.entries()) {
      expect(v.pin).toMatch(/^TEST-\d{8}$/)
      expect(v.serial_number).toBe(`SANDBOX-WASSCE-${String(i + 1).padStart(4, "0")}`)
    }
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(sb.place).toHaveBeenCalledTimes(1)
    const p = sb.place.mock.calls[0][0]
    expect(p).toMatchObject({ userId: "user-1", apiV2KeyId: "key-test-1", action: "results_checker", reference: "RC-001", price: 40, instant: true })
    expect(deps.price).toHaveBeenCalledWith("WASSCE", 2)
    liveDepsUntouched(deps)
    expect(deps.boardEnabled).not.toHaveBeenCalled()
  })

  it("replay returns the SAME fake PINs; the lookup agrees; different content => 409", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    const first = await purchaseResultsHandler(deps)(body(), TEST)
    const second = await purchaseResultsHandler(deps)(body(), TEST)
    expect(second.status).toBe(200)
    expect(data(second).replayed).toBe(true)
    expect(data(second).vouchers).toEqual(data(first).vouchers)
    expect(sb.place).toHaveBeenCalledTimes(1)
    const look = await resultsOrderHandler(deps)("RC-001", TEST)
    expect(look.status).toBe(200)
    expect(data(look).vouchers).toEqual(data(first).vouchers)
    expect(data(look).claim).toBeNull()
    const conflict = await purchaseResultsHandler(deps)(body({ quantity: 3 }), TEST)
    expect(conflict.status).toBe(409)
    liveDepsUntouched(deps)
  })

  it("same reference with a changed recipient phone or email => 409 (like live); identical recipients replay", async () => {
    const { deps } = makeDeps()
    Object.assign(deps.sandbox, sandboxStore())
    const first = await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE }), TEST)
    expect(first.status).toBe(201)
    expect((await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE }), TEST)).status).toBe(200)
    expect((await purchaseResultsHandler(deps)(body({ recipient_phone: "0249990902" }), TEST)).status).toBe(409)
    expect((await purchaseResultsHandler(deps)(body(), TEST)).status).toBe(409)
    expect((await purchaseResultsHandler(deps)(body({ recipient_phone: PHONE, recipient_email: EMAIL }), TEST)).status).toBe(409)
    // the contacts are never stored in the sandbox order
    const placed = JSON.stringify(deps.sandbox.place.mock.calls)
    expect(placed).not.toContain(PHONE)
    expect(placed).not.toContain(EMAIL)
  })

  it("different references get different fake PINs", async () => {
    const { deps } = makeDeps()
    Object.assign(deps.sandbox, sandboxStore())
    const a = await purchaseResultsHandler(deps)(body({ reference: "RC-S1" }), TEST)
    const b = await purchaseResultsHandler(deps)(body({ reference: "RC-S2" }), TEST)
    expect(data(a).vouchers[0].pin).not.toBe(data(b).vouchers[0].pin)
  })

  it("max quantity falls back to a fixed 15 when the settings read fails", async () => {
    const { deps } = makeDeps()
    Object.assign(deps.sandbox, sandboxStore())
    deps.getMaxQuantity.mockRejectedValue(new Error("db"))
    expect((await purchaseResultsHandler(deps)(body({ quantity: 16 }), TEST)).status).toBe(400)
    expect((await purchaseResultsHandler(deps)(body({ quantity: 15 }), TEST)).status).toBe(201)
  })

  it("402 test balance, validation and thrown sandbox failures", async () => {
    const a = makeDeps()
    a.deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 402 } as any)
    const r = await purchaseResultsHandler(a.deps)(body(), TEST)
    expect(r.status).toBe(402)
    expect(r.error?.message).toMatch(/^INSUFFICIENT_BALANCE: test balance is too low; required 40.00/)
    const v = makeDeps()
    expect((await purchaseResultsHandler(v.deps)(body({ price: 1 }), TEST)).status).toBe(400)
    expect(v.deps.sandbox.place).not.toHaveBeenCalled()
    const t = makeDeps()
    t.deps.sandbox.getOrder.mockRejectedValue(new Error("db"))
    const tr = await purchaseResultsHandler(t.deps)(body(), TEST)
    expect(tr.status).toBe(500)
    expect(tr.error?.message).toBe("Sandbox is temporarily unavailable")
  })

  it("lookup and list read the sandbox store only, list has no vouchers", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    await purchaseResultsHandler(deps)(body(), TEST)
    const miss = await resultsOrderHandler(deps)("RC-NOPE", TEST)
    expect(miss.status).toBe(404)
    expect(miss.error?.message).toBe(MSG_RESULTS_NOT_FOUND)
    const list = await resultsListHandler(deps)(TEST)
    expect(list.status).toBe(200)
    expect(data(list).orders).toHaveLength(1)
    expect(Object.keys(data(list).orders[0]).sort()).toEqual(ORDER_KEYS)
    expect(hasKey(data(list), ["pin", "serial_number", "vouchers"])).toBe(false)
    expect(sb.listOrders).toHaveBeenCalledWith("user-1", "results_checker", RESULTS_LIST_LIMIT)
    liveDepsUntouched(deps)
  })
})
