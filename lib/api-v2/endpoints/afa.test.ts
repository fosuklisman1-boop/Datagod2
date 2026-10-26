import { describe, it, expect, vi, afterEach } from "vitest"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { afaHash, parseAfaBody } from "../standard-orders"
import {
  registerAfaHandler,
  afaOrderHandler,
  afaListHandler,
  AFA_LIST_LIMIT,
  AFA_DUPLICATE_WINDOW_MS,
  MSG_AFA_NOT_FOUND,
  MSG_AFA_OUTCOME_UNKNOWN,
  type AfaDeps,
  type AfaEngineParams,
  type AfaEngineResult,
  type AfaOrderRow,
  type AfaSandboxOrder,
} from "./afa"

// Unique test phones for this file: 0249991001-0249991099.
const PHONE = "0249991001"
const PHONE_2 = "0249991002"
const CARD = "GHA-123456789-0"
const CARD_2 = "GHA-987654321-1"
const CARD_DIGITS = "123456789"
const SECRETS = [CARD, CARD_DIGITS, "987654321", PHONE, PHONE_2]

const ORDER_KEYS = ["amount", "created_at", "fulfillment", "full_name", "phone", "reference", "region", "status"].sort()
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

const body = (over: Record<string, unknown> = {}) => ({
  reference: "AFA-001",
  full_name: "Kofi Mensah",
  phone: PHONE,
  id_type: "Ghana Card",
  id_number: CARD,
  region: "greater accra",
  location: "Madina, Accra",
  ...over,
})

function engineOk(p: AfaEngineParams, code = "AFA-1234567") {
  return {
    order: {
      id: "afa-uuid-1",
      user_id: p.userId,
      order_code: code,
      transaction_code: "TX-SECRET",
      full_name: p.fullName,
      phone_number: p.phoneNumber,
      gh_card_number: p.ghCardNumber,
      location: p.location,
      region: p.region,
      occupation: p.occupation ?? null,
      amount: 15,
      status: "pending",
      fulfillment_status: "unfulfilled",
      created_at: CREATED,
    },
  }
}

function liveRow(over: Partial<AfaOrderRow> = {}): AfaOrderRow {
  return {
    order_code: "AFA-1234567",
    full_name: "Kofi Mensah",
    phone_number: PHONE,
    region: "Greater Accra",
    amount: 15,
    status: "pending",
    fulfillment_status: "unfulfilled",
    created_at: CREATED,
    ...over,
  }
}

function engineError(code: unknown, extra: Record<string, unknown> = {}) {
  const e: any = new Error(`engine said ${CARD} and ${PHONE} in it`)
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
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "afa"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
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
    listClaims: vi.fn(async (_u: string, _l: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null> => []),
    alert: vi.fn(async (_m: string): Promise<void> => {}),
    engine: vi.fn(async (p: AfaEngineParams): Promise<AfaEngineResult> => engineOk(p)),
    findRecentDuplicate: vi.fn(async (_u: string, _p: string, _c: string, _s: string) => false),
    getOrderByCode: vi.fn(async (_u: string, _c: string): Promise<AfaOrderRow | null> => liveRow()),
    getOrdersByCodes: vi.fn(async (_u: string, _c: string[]): Promise<AfaOrderRow[] | null> => []),
    phoneGate: vi.fn(async (_u: string) => true),
    afaPrice: vi.fn(async () => 15),
    sandbox: {
      getOrder: vi.fn(async (_u: string, _r: string): Promise<AfaSandboxOrder | null> => null),
      listOrders: vi.fn(async (_u: string, _a: "afa", _l: number): Promise<AfaSandboxOrder[] | null> => []),
      place: vi.fn(async (p: any) => ({
        success: true as const,
        order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED },
        newBalance: 85,
      })),
    },
    now: () => NOW_MS,
  }
  return { deps: deps satisfies AfaDeps, table }
}

type Deps = ReturnType<typeof makeDeps>["deps"]

function liveDepsUntouched(deps: Deps) {
  for (const f of [
    deps.claim, deps.complete, deps.release, deps.markUnknown, deps.engine, deps.findRecentDuplicate, deps.phoneGate,
    deps.getClaim, deps.listClaims, deps.getOrderByCode, deps.getOrdersByCodes, deps.alert,
  ]) {
    expect(f).not.toHaveBeenCalled()
  }
}

const data = (r: { data?: unknown }) => r.data as any

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
  for (const s of [CARD, CARD_DIGITS, "987654321", PHONE, PHONE_2]) {
    expect(logged).not.toContain(s)
    expect(alerts).not.toContain(s)
    if (s === CARD || s === CARD_DIGITS) expect(rest).not.toContain(s)
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- register: happy path

describe("POST /afa/register (live): new registration", () => {
  it("claims, gates, guards, calls the engine ONCE with exact normalised args, completes, 201", async () => {
    const { deps } = makeDeps()
    const r = await registerAfaHandler(deps)(body({ phone: "+233 24 999 1001", id_number: "gha-123456789-0", full_name: "  Kofi   Mensah ", occupation: "Trader" }), LIVE)
    expect(r.status).toBe(201)
    const parsed = parseAfaBody(body({ phone: "+233 24 999 1001", id_number: "gha-123456789-0", full_name: "  Kofi   Mensah ", occupation: "Trader" }))
    if (!parsed.ok) throw new Error("fixture")
    expect(deps.claim).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      kind: "afa",
      reference: "AFA-001",
      requestHash: afaHash(parsed.value),
    })
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect(deps.engine).toHaveBeenCalledWith({
      userId: "user-1",
      fullName: "Kofi Mensah",
      phoneNumber: PHONE,
      ghCardNumber: CARD,
      location: "Madina, Accra",
      region: "Greater Accra",
      occupation: "Trader",
    })
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.complete.mock.calls[0][1]).toBe("AFA-1234567")
    expect(deps.complete.mock.calls[0][3]).toBe("user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    const order = [deps.claim, deps.phoneGate, deps.findRecentDuplicate, deps.engine, deps.complete].map((f) => f.mock.invocationCallOrder[0])
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("occupation is omitted from the engine args when absent", async () => {
    const { deps } = makeDeps()
    await registerAfaHandler(deps)(body(), LIVE)
    expect(deps.engine.mock.calls[0][0]).not.toHaveProperty("occupation")
    expect(deps.engine.mock.calls[0][0]).not.toHaveProperty("shopId")
  })

  it("201 { order } with exactly the allow-list keys, the CLIENT reference, and no card / codes / ids", async () => {
    const { deps, table } = makeDeps()
    const r = await registerAfaHandler(deps)(body(), LIVE)
    const d = data(r)
    expect(Object.keys(d)).toEqual(["order"])
    expect(Object.keys(d.order).sort()).toEqual(ORDER_KEYS)
    expect(d.order).toMatchObject({ reference: "AFA-001", full_name: "Kofi Mensah", phone: PHONE, region: "Greater Accra", amount: 15, status: "pending", fulfillment: "pending", created_at: CREATED })
    const text = JSON.stringify(d)
    for (const s of [CARD, CARD_DIGITS, "AFA-1234567", "TX-SECRET", "afa-uuid-1", "Madina"]) expect(text).not.toContain(s)
    // the stored claim is the same order: no card either
    const stored = JSON.stringify([...table.rows.values()][0])
    expect(stored).not.toContain(CARD_DIGITS)
    expect(JSON.stringify(deps.claim.mock.calls)).not.toContain(CARD_DIGITS)
  })

  it("reads the row back when the engine row lacks created_at / fulfillment_status", async () => {
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ order: { order_code: "AFA-1234567", full_name: "Kofi Mensah", phone_number: PHONE, region: "Greater Accra", amount: 15, status: "pending" } })
    const r = await registerAfaHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "AFA-1234567")
    expect(data(r).order.created_at).toBe(CREATED)
    deps.getOrderByCode.mockRejectedValueOnce(new Error("db"))
    deps.engine.mockResolvedValueOnce({ order: { order_code: "AFA-7654321", full_name: "K", phone_number: PHONE, region: "Greater Accra", amount: 15, status: "pending" } })
    const r2 = await registerAfaHandler(deps)(body({ reference: "AFA-002" }), LIVE)
    expect(r2.status).toBe(201)
    expect(data(r2).order.created_at).toBe(new Date(NOW_MS).toISOString())
  })

  it("complete() false/throw: markUnknown with the order code, alert once, still 201, no release", async () => {
    for (const mode of ["false", "throw"]) {
      const spies = logSpies()
      const { deps } = makeDeps()
      if (mode === "false") deps.complete.mockResolvedValueOnce(false)
      else deps.complete.mockRejectedValueOnce(new Error("db"))
      const r = await registerAfaHandler(deps)(body(), LIVE)
      expect(r.status).toBe(201)
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.markUnknown).toHaveBeenCalledWith("claim-1", "user-1", "AFA-1234567")
      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect(deps.alert.mock.calls[0][0]).toContain("user-1")
      expect(deps.alert.mock.calls[0][0]).toContain("AFA-001")
      noSecrets(spies, deps)
      vi.restoreAllMocks()
    }
  })
})

// ---------------------------------------------------------------- claim outcomes

describe("POST /afa/register: claim outcomes never reach the engine", () => {
  it("replay: 200 { order, replayed: true } refreshed from the live row; no gate, guard or engine", async () => {
    const { deps } = makeDeps()
    await registerAfaHandler(deps)(body(), LIVE)
    for (const f of [deps.engine, deps.phoneGate, deps.findRecentDuplicate, deps.complete]) f.mockClear()
    deps.getOrderByCode.mockResolvedValue(liveRow({ status: "completed", fulfillment_status: "fulfilled" }))
    const r = await registerAfaHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    expect(Object.keys(data(r)).sort()).toEqual(["order", "replayed"])
    expect(data(r).order).toMatchObject({ reference: "AFA-001", status: "completed", fulfillment: "fulfilled" })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(deps.engine).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.findRecentDuplicate).not.toHaveBeenCalled()
    expect(deps.getOrderByCode).toHaveBeenLastCalledWith("user-1", "AFA-1234567")
  })

  it("replay falls back to the stored order when the live row is unreadable", async () => {
    const { deps } = makeDeps()
    await registerAfaHandler(deps)(body(), LIVE)
    deps.getOrderByCode.mockRejectedValue(new Error("db"))
    const r = await registerAfaHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    expect(data(r).order).toMatchObject({ reference: "AFA-001", full_name: "Kofi Mensah", phone: PHONE, amount: 15 })
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
  })

  it("conflict, in_progress, unknown, error", async () => {
    const a = makeDeps()
    await registerAfaHandler(a.deps)(body(), LIVE)
    a.deps.engine.mockClear()
    const c = await registerAfaHandler(a.deps)(body({ id_number: CARD_2 }), LIVE)
    expect(c.status).toBe(409)
    expect(c.error?.message).toMatch(/^REFERENCE_REUSED/)
    expect(a.deps.engine).not.toHaveBeenCalled()
    const cases: [ClaimOutcome, number, RegExp][] = [
      [{ kind: "in_progress" }, 409, /^REQUEST_IN_PROGRESS/],
      [{ kind: "unknown" }, 409, /^OUTCOME_UNKNOWN/],
      [{ kind: "error" }, 503, /^UNAVAILABLE/],
    ]
    for (const [outcome, status, re] of cases) {
      const { deps } = makeDeps()
      deps.claim.mockResolvedValueOnce(outcome)
      const r = await registerAfaHandler(deps)(body(), LIVE)
      expect(r.status).toBe(status)
      expect(r.error?.message).toMatch(re)
      expect(deps.engine).not.toHaveBeenCalled()
      expect(deps.phoneGate).not.toHaveBeenCalled()
      expect(deps.release).not.toHaveBeenCalled()
    }
    const t = makeDeps()
    t.deps.claim.mockRejectedValueOnce(new Error("db"))
    expect((await registerAfaHandler(t.deps)(body(), LIVE)).status).toBe(503)
    expect(t.deps.engine).not.toHaveBeenCalled()
  })

  it("two concurrent requests with one reference reach the engine at most once", async () => {
    const { deps } = makeDeps()
    const [a, b] = await Promise.all([registerAfaHandler(deps)(body(), LIVE), registerAfaHandler(deps)(body(), LIVE)])
    expect(deps.engine).toHaveBeenCalledTimes(1)
    expect([a.status, b.status].sort()).toEqual([201, 409])
  })
})

// ---------------------------------------------------------------- gate and duplicate guard

describe("POST /afa/register: phone gate and duplicate guard", () => {
  it("phone gate false / throw / non-true => release + 403, no guard, no engine", async () => {
    for (const mk of [() => Promise.resolve(false), () => Promise.reject(new Error("db")), () => Promise.resolve("yes" as any)]) {
      const { deps } = makeDeps()
      deps.phoneGate.mockImplementation(mk as any)
      const r = await registerAfaHandler(deps)(body(), LIVE)
      expect(r.status).toBe(403)
      expect(r.error?.message).toMatch(/^PHONE_NOT_VERIFIED/)
      expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
      expect(deps.findRecentDuplicate).not.toHaveBeenCalled()
      expect(deps.engine).not.toHaveBeenCalled()
    }
  })

  it("guard receives user, local phone, canonical card and a since computed from the injected clock", async () => {
    const { deps } = makeDeps()
    await registerAfaHandler(deps)(body({ phone: "+233249991001" }), LIVE)
    expect(deps.findRecentDuplicate).toHaveBeenCalledTimes(1)
    expect(deps.findRecentDuplicate).toHaveBeenCalledWith("user-1", PHONE, CARD, new Date(NOW_MS - AFA_DUPLICATE_WINDOW_MS).toISOString())
    expect(AFA_DUPLICATE_WINDOW_MS).toBe(600_000)
  })

  it("a duplicate (same phone/different card, or same card/different phone) => release + 409 DUPLICATE_REGISTRATION, no engine", async () => {
    const rows = [{ phone: PHONE, card: CARD }]
    for (const over of [{ id_number: CARD_2 }, { phone: PHONE_2 }]) {
      const { deps, table } = makeDeps()
      deps.findRecentDuplicate.mockImplementation(async (_u, phone, card) => rows.some((r) => r.phone === phone || r.card === card))
      const r = await registerAfaHandler(deps)(body(over), LIVE)
      expect(r.status).toBe(409)
      expect(r.error?.message).toMatch(/^DUPLICATE_REGISTRATION:/)
      expect(r.error?.message).toContain("original reference")
      expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
      expect(deps.engine).not.toHaveBeenCalled()
      expect(table.rows.size).toBe(0)
      expect(JSON.stringify(r)).not.toContain(CARD_DIGITS)
    }
  })

  it("a guard read error or non-boolean answer fails closed: release + 503, no engine", async () => {
    const a = makeDeps()
    a.deps.findRecentDuplicate.mockRejectedValue(new Error("db"))
    const r = await registerAfaHandler(a.deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(a.deps.release).toHaveBeenCalledTimes(1)
    expect(a.deps.engine).not.toHaveBeenCalled()
    const b = makeDeps()
    b.deps.findRecentDuplicate.mockResolvedValue(undefined as any)
    expect((await registerAfaHandler(b.deps)(body(), LIVE)).status).toBe(409)
    expect(b.deps.engine).not.toHaveBeenCalled()
  })

  it("a guard hit frees the reference so the client can retry later", async () => {
    const { deps } = makeDeps()
    deps.findRecentDuplicate.mockResolvedValueOnce(true)
    expect((await registerAfaHandler(deps)(body(), LIVE)).status).toBe(409)
    expect((await registerAfaHandler(deps)(body(), LIVE)).status).toBe(201)
  })
})

// ---------------------------------------------------------------- engine errors

describe("POST /afa/register: engine error classification", () => {
  it("INVALID_GHANA_CARD (400), PRICE_UNAVAILABLE (503), INSUFFICIENT_BALANCE (402) release the claim", async () => {
    const cases: [unknown, number, RegExp][] = [
      [engineError("INVALID_GHANA_CARD"), 400, /^INVALID_GHANA_CARD:/],
      [engineError("PRICE_UNAVAILABLE"), 503, /^PRICE_UNAVAILABLE:/],
      [engineError("INSUFFICIENT_BALANCE", { required: 15 }), 402, /^INSUFFICIENT_BALANCE: wallet balance is too low; required 15.00$/],
    ]
    for (const [err, status, re] of cases) {
      const spies = logSpies()
      const { deps, table } = makeDeps()
      deps.engine.mockRejectedValueOnce(err)
      const r = await registerAfaHandler(deps)(body(), LIVE)
      expect(r.status).toBe(status)
      expect(r.error?.message).toMatch(re)
      expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
      expect(deps.markUnknown).not.toHaveBeenCalled()
      expect(deps.alert).not.toHaveBeenCalled()
      expect(table.rows.size).toBe(0)
      expect(JSON.stringify(r)).not.toContain(CARD)
      noSecrets(spies, deps)
      vi.restoreAllMocks()
    }
  })

  it("PAYMENT_FAILED / ORDER_CREATE_FAILED / uncoded / unknown / non-Error mark unknown + alert, never release", async () => {
    const throwables: unknown[] = [engineError("PAYMENT_FAILED"), engineError("ORDER_CREATE_FAILED"), new Error("x"), engineError("NEW_CODE"), "boom", undefined, null, 7]
    for (const t of throwables) {
      const spies = logSpies()
      const { deps, table } = makeDeps()
      deps.engine.mockRejectedValueOnce(t)
      const r = await registerAfaHandler(deps)(body(), LIVE)
      expect(r.status).toBe(500)
      expect(r.error?.message).toBe(MSG_AFA_OUTCOME_UNKNOWN)
      expect(deps.release).not.toHaveBeenCalled()
      expect(deps.markUnknown).toHaveBeenCalledTimes(1)
      expect(deps.alert).toHaveBeenCalledTimes(1)
      expect([...table.rows.values()][0].status).toBe("unknown")
      expect(JSON.stringify(r)).not.toContain(CARD)
      noSecrets(spies, deps)
      vi.restoreAllMocks()
    }
  })

  it("an engine result without an order code is ambiguous", async () => {
    logSpies()
    const { deps } = makeDeps()
    deps.engine.mockResolvedValueOnce({ order: {} })
    const r = await registerAfaHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.alert).toHaveBeenCalledTimes(1)
  })

  it("an alert that throws never changes the response", async () => {
    logSpies()
    const { deps } = makeDeps()
    deps.engine.mockRejectedValueOnce(new Error("x"))
    deps.alert.mockRejectedValueOnce(new Error("down"))
    expect((await registerAfaHandler(deps)(body(), LIVE)).status).toBe(500)
  })
})

// ---------------------------------------------------------------- validation

describe("POST /afa/register: validation before any dependency call", () => {
  for (const f of ["price", "amount", "fee", "total_paid", "user_id", "status", "shop_id", "markup", "package_id"]) {
    it(`rejects body field ${f} with 400 and touches nothing`, async () => {
      const { deps } = makeDeps()
      const r = await registerAfaHandler(deps)(body({ [f]: 1 }), LIVE)
      expect(r.status).toBe(400)
      liveDepsUntouched(deps)
    })
  }

  it("bad card / phone / region / id_type / name / body shape => 400, and the card never appears in the error", async () => {
    for (const b of [
      body({ id_number: "GHA-12-0" }),
      body({ id_number: 5 }),
      body({ phone: "12" }),
      body({ region: "Atlantis" }),
      body({ id_type: "Passport" }),
      body({ full_name: "K" }),
      body({ reference: "" }),
      null,
      [],
      "x",
    ]) {
      const { deps } = makeDeps()
      const r = await registerAfaHandler(deps)(b, LIVE)
      expect(r.status).toBe(400)
      expect(JSON.stringify(r)).not.toContain("GHA-12-0")
      liveDepsUntouched(deps)
    }
  })
})

// ---------------------------------------------------------------- lookup

describe("GET /afa/orders/{reference}", () => {
  const done = {
    orderRef: "AFA-1234567",
    status: "done",
    response: { reference: "AFA-001", full_name: "Kofi Mensah", phone: PHONE, region: "Greater Accra", amount: 15, status: "pending", fulfillment: "pending", created_at: CREATED, gh_card_number: CARD },
    createdAt: CREATED,
  }

  it("done claim: live row owner-scoped, status/fulfillment refreshed, claim null, allow-list only", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue(done)
    deps.getOrderByCode.mockResolvedValue(liveRow({ status: "completed", fulfillment_status: "fulfilled" }))
    const r = await afaOrderHandler(deps)("AFA-001", LIVE)
    expect(r.status).toBe(200)
    expect(Object.keys(data(r)).sort()).toEqual(["claim", "order"])
    expect(data(r).claim).toBeNull()
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(data(r).order).toMatchObject({ reference: "AFA-001", status: "completed", fulfillment: "fulfilled" })
    expect(deps.getClaim).toHaveBeenCalledWith("user-1", "AFA-001")
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "AFA-1234567")
    expect(JSON.stringify(r)).not.toContain(CARD_DIGITS)
    expect(deps.engine).not.toHaveBeenCalled()
  })

  it("falls back to the stored order (allow-listed) when the live row is unreadable; the stored card never leaks", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue(done)
    deps.getOrderByCode.mockResolvedValue(null)
    const r = await afaOrderHandler(deps)("AFA-001", LIVE)
    expect(r.status).toBe(200)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(r)).not.toContain(CARD_DIGITS)
  })

  it("own in_progress / unknown claim => 200 { order: null, claim }", async () => {
    for (const [status, state] of [["in_progress", "in_progress"], ["unknown", "outcome_unknown"]] as const) {
      const { deps } = makeDeps()
      deps.getClaim.mockResolvedValue({ orderRef: null, status, response: null, createdAt: new Date(NOW_MS - 1000).toISOString() })
      const r = await afaOrderHandler(deps)("AFA-001", LIVE)
      expect(data(r)).toEqual({ order: null, claim: { reference: "AFA-001", state } })
      expect(deps.getOrderByCode).not.toHaveBeenCalled()
    }
  })

  it("missing, foreign, malformed, throwing: the identical 404", async () => {
    const results: unknown[] = []
    for (const [ref, setup] of [
      ["AFA-404", (d: Deps) => d.getClaim.mockResolvedValue(null)],
      ["AFA-405", (d: Deps) => d.getClaim.mockRejectedValue(new Error("db"))],
      ["bad ref!", (_d: Deps) => {}],
      ["AFA-406", (d: Deps) => d.getClaim.mockResolvedValue({ orderRef: null, status: "done", response: null })],
    ] as const) {
      const { deps } = makeDeps()
      setup(deps)
      const r = await afaOrderHandler(deps)(ref, LIVE)
      expect(r.status).toBe(404)
      results.push(r)
    }
    for (const r of results) expect(r).toEqual(results[0])
    expect((results[0] as any).error.message).toBe(MSG_AFA_NOT_FOUND)
  })
})

// ---------------------------------------------------------------- list

describe("GET /afa/orders", () => {
  it("caps at 30, ONE order query, same shape", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValue(Array.from({ length: 40 }, (_, i) => ({ reference: `REF-${i}`, orderRef: `AFA-${i}`, status: "done" })))
    deps.getOrdersByCodes.mockImplementation(async (_u: string, codes: string[]) => codes.map((c) => liveRow({ order_code: c })))
    const r = await afaListHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(deps.listClaims).toHaveBeenCalledWith("user-1", AFA_LIST_LIMIT)
    expect(deps.getOrdersByCodes).toHaveBeenCalledTimes(1)
    expect(deps.getOrdersByCodes.mock.calls[0][0]).toBe("user-1")
    expect(deps.getOrdersByCodes.mock.calls[0][1]).toHaveLength(30)
    expect(data(r).orders).toHaveLength(30)
    for (const o of data(r).orders) expect(Object.keys(o).sort()).toEqual(ORDER_KEYS)
  })

  it("duplicate codes resolve to the first (newest) row", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValue([{ reference: "A", orderRef: "AFA-1", status: "done" }])
    deps.getOrdersByCodes.mockResolvedValue([liveRow({ order_code: "AFA-1", status: "completed" }), liveRow({ order_code: "AFA-1", status: "failed" })])
    expect(data(await afaListHandler(deps)(LIVE)).orders[0].status).toBe("completed")
  })

  it("empty => 200 [] without an order query; failures => 503", async () => {
    const e = makeDeps()
    expect(data(await afaListHandler(e.deps)(LIVE))).toEqual({ orders: [] })
    expect(e.deps.getOrdersByCodes).not.toHaveBeenCalled()
    const a = makeDeps()
    a.deps.listClaims.mockResolvedValue(null)
    expect((await afaListHandler(a.deps)(LIVE)).status).toBe(503)
    const b = makeDeps()
    b.deps.listClaims.mockRejectedValue(new Error("db"))
    expect((await afaListHandler(b.deps)(LIVE)).status).toBe(503)
    const c = makeDeps()
    c.deps.listClaims.mockResolvedValue([{ reference: "A", orderRef: "AFA-1", status: "done" }])
    c.deps.getOrdersByCodes.mockResolvedValue(null)
    expect((await afaListHandler(c.deps)(LIVE)).status).toBe(503)
  })
})

// ---------------------------------------------------------------- sandbox

describe("sandbox (test key)", () => {
  function sandboxStore() {
    const store = new Map<string, AfaSandboxOrder>()
    return {
      store,
      getOrder: vi.fn(async (_u: string, ref: string) => store.get(ref) ?? null),
      listOrders: vi.fn(async (_u: string, _a: "afa", _l: number): Promise<AfaSandboxOrder[] | null> => [...store.values()]),
      place: vi.fn(async (p: any) => {
        store.set(p.reference, {
          reference: p.reference,
          action: p.action,
          response: { ...p.orderFields, reference: p.reference, status: "pending" },
          price: p.price,
          created_at: CREATED,
          status: "pending",
        })
        return { success: true as const, order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED }, newBalance: 85 }
      }),
    }
  }

  it("places via the sandbox store with the v2 key; no card number in request or fields; never touches live deps", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    const r = await registerAfaHandler(deps)(body(), TEST)
    expect(r.status).toBe(201)
    expect(data(r).sandbox).toBe(true)
    expect(data(r).new_balance).toBe(85)
    expect(Object.keys(data(r).order).sort()).toEqual(ORDER_KEYS)
    const p = sb.place.mock.calls[0][0]
    expect(p).toMatchObject({ userId: "user-1", apiV2KeyId: "key-test-1", action: "afa", reference: "AFA-001", price: 15 })
    const text = JSON.stringify(p) + JSON.stringify(r)
    expect(text).not.toContain(CARD_DIGITS)
    expect(text).not.toContain(CARD)
    liveDepsUntouched(deps)
  })

  it("replay 200, different content (incl. a different card) 409, no second place", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    await registerAfaHandler(deps)(body(), TEST)
    const again = await registerAfaHandler(deps)(body(), TEST)
    expect(again.status).toBe(200)
    expect(data(again).replayed).toBe(true)
    const diff = await registerAfaHandler(deps)(body({ id_number: CARD_2 }), TEST)
    expect(diff.status).toBe(409)
    expect(sb.place).toHaveBeenCalledTimes(1)
    liveDepsUntouched(deps)
  })

  it("price unavailable => 503; 402 test balance; thrown sandbox => 500", async () => {
    const a = makeDeps()
    a.deps.afaPrice.mockRejectedValue(new Error("none"))
    expect((await registerAfaHandler(a.deps)(body(), TEST)).status).toBe(503)
    const b = makeDeps()
    b.deps.afaPrice.mockResolvedValue(0)
    expect((await registerAfaHandler(b.deps)(body(), TEST)).status).toBe(503)
    expect(b.deps.sandbox.place).not.toHaveBeenCalled()
    const c = makeDeps()
    c.deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 402 } as any)
    const cr = await registerAfaHandler(c.deps)(body(), TEST)
    expect(cr.status).toBe(402)
    expect(cr.error?.message).toMatch(/required 15.00/)
    const d = makeDeps()
    d.deps.sandbox.getOrder.mockRejectedValue(new Error("db"))
    expect((await registerAfaHandler(d.deps)(body(), TEST)).status).toBe(500)
  })

  it("lookup and list read the sandbox store only", async () => {
    const { deps } = makeDeps()
    const sb = sandboxStore()
    Object.assign(deps.sandbox, sb)
    await registerAfaHandler(deps)(body(), TEST)
    const look = await afaOrderHandler(deps)("AFA-001", TEST)
    expect(look.status).toBe(200)
    expect(data(look).claim).toBeNull()
    expect((await afaOrderHandler(deps)("AFA-NOPE", TEST)).status).toBe(404)
    const list = await afaListHandler(deps)(TEST)
    expect(data(list).orders).toHaveLength(1)
    expect(Object.keys(data(list).orders[0]).sort()).toEqual(ORDER_KEYS)
    expect(sb.listOrders).toHaveBeenCalledWith("user-1", "afa", AFA_LIST_LIMIT)
    liveDepsUntouched(deps)
  })
})
