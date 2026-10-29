import { describe, it, expect, vi, afterEach } from "vitest"
import { signBundleToken } from "@/lib/standard-bundles/token"
import type { V2Context } from "../handler"
import type { ClaimOutcome } from "../idempotency"
import { bundleEngineKey, bundleHash, parseBundlePurchaseBody } from "../bundles"
import {
  BUNDLE_LIST_LIMIT,
  MSG_BUNDLE_CATALOG_UNAVAILABLE,
  MSG_BUNDLE_IN_PROGRESS,
  MSG_BUNDLE_ORDER_NOT_FOUND,
  MSG_BUNDLE_OUTCOME_UNKNOWN,
  MSG_BUNDLE_PRIOR_UNKNOWN,
  MSG_SANDBOX_TOKEN_ON_LIVE,
  MSG_TOKEN_ON_TEST_KEY,
  bundleCatalogHandler,
  bundleListHandler,
  bundleOrderHandler,
  purchaseBundleHandler,
  type BundleBuyParams,
  type BundleOrderRow,
  type BundleSandboxOrder,
  type BundleSandboxPlaceResult,
  type BundlesV2Deps,
} from "./bundles"

// Unique test phones for this file: 0249991070-0249991079.
const PHONE = "0249991070"
const PHONE_2 = "0249991071"
const ENGINE_TEXT = "ENGINE-SAID-0249991079-SECRET"
const SECRET = "test-secret-not-real"
const CREATED = "2026-10-28T10:00:00.000Z"
const NOW_MS = Date.parse("2026-10-28T10:00:05.000Z")

const ORDER_KEYS = ["bundle", "cashback", "created_at", "face_amount", "network", "paid_amount", "recipient", "reference", "status"].sort()

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

const token = (over: Record<string, unknown> = {}) =>
  signBundleToken({ network: "MTN", value: "1GB-VAL", amount: 5.5, display: "1GB", category: "Data", issuedAt: NOW_MS, ...over } as any, SECRET)

const body = (over: Record<string, unknown> = {}) => ({ bundle_token: token(), recipient: PHONE, reference: "BND-001", ...over })

function engineOrder(over: Record<string, unknown> = {}) {
  return {
    id: "order-uuid-1",
    reference_code: "SB-AAA111",
    user_id: "user-1",
    network: "MTN",
    beneficiary_phone: "233249991070",
    bundle_display: "1GB",
    bundle_value: "1GB-VAL",
    amount: 5.5,
    paid_amount: 5.5,
    cashback_amount: null,
    status: "processing",
    payment_status: "paid",
    notes: ENGINE_TEXT,
    failure_reason: ENGINE_TEXT,
    created_at: CREATED,
    ...over,
  }
}

const engineOk = (over: Record<string, unknown> = {}) => ({ ok: true as const, order: engineOrder(over) as any })

function liveRow(over: Partial<BundleOrderRow> = {}): BundleOrderRow {
  return {
    reference_code: "SB-AAA111",
    network: "MTN",
    beneficiary_phone: "233249991070",
    bundle_display: "1GB",
    amount: 5.5,
    paid_amount: 5.5,
    cashback_amount: 0,
    status: "processing",
    payment_status: "paid",
    created_at: CREATED,
    ...over,
  }
}

/** In-memory claim table honouring the UNIQUE (user, kind, reference) constraint. */
function claimTable() {
  type Row = { id: string; userId: string; reference: string; hash: string; status: string; orderRef: string | null; response: unknown }
  const rows = new Map<string, Row>()
  let n = 0
  const key = (u: string, r: string) => `${u}|${r}`
  return {
    rows,
    claim: vi.fn(async (p: { userId: string; apiV2KeyId: string; kind: "bundle"; reference: string; requestHash: string }): Promise<ClaimOutcome> => {
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
    getClaim: vi.fn(
      async (_u: string, _r: string): Promise<{ orderRef: string | null; status: string; response: unknown; createdAt?: string | null } | null> => null
    ),
    listClaims: vi.fn(async (_u: string, _limit: number): Promise<{ reference: string; orderRef: string | null; status: string }[] | null> => []),
    surfaceOpen: vi.fn(async () => true),
    phoneGate: vi.fn(async (_u: string) => true),
    loadCatalog: vi.fn(async (_u: string, _n: string): Promise<any> => ({
      kind: "ok",
      categories: [{ name: "Data", bundles: [{ bundle_token: "tok-1", display: "1GB", face_amount: 5.5, pay_amount: 5, customer_cashback: 0.5 }] }],
    })),
    buy: vi.fn(async (_p: BundleBuyParams): Promise<any> => engineOk()),
    getOrderByCode: vi.fn(async (_u: string, _c: string): Promise<BundleOrderRow | null> => liveRow()),
    getOrdersByCodes: vi.fn(async (_u: string, _c: string[]): Promise<BundleOrderRow[] | null> => []),
    sandbox: {
      getOrder: vi.fn(async (_u: string, _r: string): Promise<BundleSandboxOrder | null> => null),
      listOrders: vi.fn(async (_u: string, _a: "standard_bundle", _l: number): Promise<BundleSandboxOrder[] | null> => []),
      place: vi.fn(
        async (p: any): Promise<BundleSandboxPlaceResult> => ({
          success: true,
          order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED },
          newBalance: 90,
        })
      ),
    },
    now: () => NOW_MS,
  }
  return { deps: deps satisfies BundlesV2Deps, table }
}

type Deps = ReturnType<typeof makeDeps>["deps"]

function liveUntouched(deps: Deps) {
  for (const f of [deps.claim, deps.complete, deps.release, deps.markUnknown, deps.alert, deps.getClaim, deps.listClaims, deps.surfaceOpen, deps.phoneGate, deps.loadCatalog, deps.buy, deps.getOrderByCode, deps.getOrdersByCodes]) {
    expect(f).not.toHaveBeenCalled()
  }
}

function sandboxUntouched(deps: Deps) {
  expect(deps.sandbox.getOrder).not.toHaveBeenCalled()
  expect(deps.sandbox.listOrders).not.toHaveBeenCalled()
  expect(deps.sandbox.place).not.toHaveBeenCalled()
}

const err = (r: { status: number; error?: { status: number; message: string } }) => r.error?.message

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- catalog

describe("bundleCatalogHandler", () => {
  it("rejects a missing or unknown network before any I/O", async () => {
    const { deps } = makeDeps()
    for (const n of [undefined, null, "", "vodafone", 5]) {
      const r = await bundleCatalogHandler(deps)(n, LIVE)
      expect(r.status).toBe(400)
      expect(err(r)).toBe("network must be one of: MTN, Telecel, AT")
    }
    liveUntouched(deps)
  })

  it("live: returns the priced catalogue with the token lifetime and asks the engine network", async () => {
    const { deps } = makeDeps()
    const r = await bundleCatalogHandler(deps)("telecel", LIVE)
    expect(r.status).toBe(200)
    expect(deps.loadCatalog).toHaveBeenCalledWith("user-1", "TELECEL")
    expect(r.data).toEqual({
      network: "Telecel",
      token_valid_seconds: 600,
      categories: [{ name: "Data", bundles: [{ bundle_token: "tok-1", display: "1GB", face_amount: 5.5, pay_amount: 5, customer_cashback: 0.5 }] }],
    })
  })

  it("closed => 403 NOT_AVAILABLE; unavailable, throw and a malformed result => 503", async () => {
    const { deps } = makeDeps()
    deps.loadCatalog.mockResolvedValueOnce({ kind: "closed" })
    const closed = await bundleCatalogHandler(deps)("MTN", LIVE)
    expect(closed.status).toBe(403)
    expect(err(closed)).toContain("NOT_AVAILABLE")
    for (const impl of [async () => ({ kind: "unavailable" }), async () => { throw new Error(ENGINE_TEXT) }, async () => null, async () => ({ kind: "ok" })]) {
      deps.loadCatalog.mockImplementationOnce(impl as any)
      const r = await bundleCatalogHandler(deps)("MTN", LIVE)
      expect(r.status).toBe(503)
      expect(err(r)).toBe(MSG_BUNDLE_CATALOG_UNAVAILABLE)
      expect(JSON.stringify(r)).not.toContain(ENGINE_TEXT)
    }
  })

  it("test key: static sandbox catalogue, no live dependency touched", async () => {
    const { deps } = makeDeps()
    const r = await bundleCatalogHandler(deps)("MTN", TEST)
    expect(r.status).toBe(200)
    expect((r.data as any).sandbox).toBe(true)
    expect((r.data as any).network).toBe("MTN")
    expect((r.data as any).categories[0].bundles[0]).toMatchObject({ bundle_token: "sbx_mtn_1gb", display: "1GB", face_amount: 5, pay_amount: 5, customer_cashback: 0 })
    liveUntouched(deps)
  })
})

// ---------------------------------------------------------------- live purchase

describe("purchaseBundleHandler (live)", () => {
  it("claims once, then surface gate -> phone gate -> engine -> complete, with the exact engine args", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(body({ expected_pay: 5.5 }), LIVE)
    expect(r.status).toBe(201)
    expect(deps.claim).toHaveBeenCalledTimes(1)
    expect(deps.claim.mock.calls[0][0]).toMatchObject({ userId: "user-1", apiV2KeyId: "key-live-1", kind: "bundle", reference: "BND-001" })
    const order = [deps.claim, deps.surfaceOpen, deps.phoneGate, deps.buy, deps.complete].map((f) => f.mock.invocationCallOrder[0])
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(deps.buy).toHaveBeenCalledTimes(1)
    const p = deps.buy.mock.calls[0][0]
    expect(p).toEqual({
      userId: "user-1",
      token: expect.any(String),
      phone: PHONE,
      idempotencyKey: bundleEngineKey("claim-1"),
      expectedPay: 5.5,
    })
    expect(deps.complete).toHaveBeenCalledTimes(1)
    expect(deps.complete.mock.calls[0].slice(0, 2)).toEqual(["claim-1", "SB-AAA111"])
    expect(deps.complete.mock.calls[0][3]).toBe("user-1")
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
  })

  it("answers 201 with only the allow-listed order and never engine text, ids or notes", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    const order = (r.data as any).order
    expect(Object.keys(order).sort()).toEqual(ORDER_KEYS)
    expect(order).toMatchObject({ reference: "BND-001", network: "MTN", bundle: "1GB", recipient: PHONE, face_amount: 5.5, paid_amount: 5.5, status: "processing" })
    expect(Object.keys(r.data as object)).toEqual(["order"])
    const text = JSON.stringify(r)
    for (const leak of [ENGINE_TEXT, "SB-AAA111", "order-uuid-1", "1GB-VAL", "233249991070"]) expect(text).not.toContain(leak)
  })

  it("a paid order that failed at the provider is still a 201 with status failed (money is held; the claim is done)", async () => {
    const { deps } = makeDeps()
    deps.buy.mockResolvedValueOnce(engineOk({ status: "failed" }))
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect((r.data as any).order.status).toBe("failed")
    expect(deps.complete).toHaveBeenCalledTimes(1)
  })

  it("rejects a bad body, a forbidden field and a sandbox token before any I/O", async () => {
    const { deps } = makeDeps()
    for (const b of [null, [], body({ price: 1 }), body({ network: "MTN" }), body({ bundle_token: "garbage" }), body({ recipient: "123" }), body({ reference: "x" }), body({ expected_pay: "abc" })]) {
      const r = await purchaseBundleHandler(deps)(b, LIVE)
      expect(r.status, JSON.stringify(b)).toBe(400)
    }
    const sbx = await purchaseBundleHandler(deps)(body({ bundle_token: "sbx_mtn_1gb" }), LIVE)
    expect(sbx.status).toBe(400)
    expect(err(sbx)).toBe(MSG_SANDBOX_TOKEN_ON_LIVE)
    liveUntouched(deps)
    sandboxUntouched(deps)
  })

  it("replay: 200 with the stored order, status refreshed from the live row, engine never called", async () => {
    const { deps } = makeDeps()
    await purchaseBundleHandler(deps)(body(), LIVE)
    deps.buy.mockClear()
    deps.surfaceOpen.mockClear()
    deps.phoneGate.mockClear()
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ status: "completed" }))
    const r = await purchaseBundleHandler(deps)(body({ bundle_token: token({ issuedAt: NOW_MS + 60_000 }) }), LIVE)
    expect(r.status).toBe(200)
    expect((r.data as any).replayed).toBe(true)
    expect((r.data as any).order.status).toBe("completed")
    expect(Object.keys((r.data as any).order).sort()).toEqual(ORDER_KEYS)
    expect(deps.buy).not.toHaveBeenCalled()
    expect(deps.surfaceOpen).not.toHaveBeenCalled()
    expect(deps.phoneGate).not.toHaveBeenCalled()
  })

  it("replay keeps the stored order when the live read fails", async () => {
    const { deps } = makeDeps()
    await purchaseBundleHandler(deps)(body(), LIVE)
    deps.getOrderByCode.mockRejectedValueOnce(new Error("db down"))
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(200)
    expect((r.data as any).order.status).toBe("processing")
  })

  it("the same reference for a different bundle or recipient => 409 REFERENCE_REUSED, engine not called again", async () => {
    const { deps } = makeDeps()
    await purchaseBundleHandler(deps)(body(), LIVE)
    deps.buy.mockClear()
    for (const other of [body({ recipient: PHONE_2 }), body({ bundle_token: token({ value: "2GB-VAL", amount: 9 }) })]) {
      const r = await purchaseBundleHandler(deps)(other, LIVE)
      expect(r.status).toBe(409)
      expect(err(r)).toContain("REFERENCE_REUSED")
    }
    expect(deps.buy).not.toHaveBeenCalled()
  })

  it.each([
    ["in_progress", { kind: "in_progress" }, 409, MSG_BUNDLE_IN_PROGRESS],
    ["unknown", { kind: "unknown" }, 409, MSG_BUNDLE_PRIOR_UNKNOWN],
  ])("claim %s => %s, no gate, no engine", async (_n, outcome, status, message) => {
    const { deps } = makeDeps()
    deps.claim.mockResolvedValueOnce(outcome as ClaimOutcome)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(status)
    expect(err(r)).toBe(message)
    expect(err(r)).toContain("Do not place this order again under a new reference")
    for (const f of [deps.surfaceOpen, deps.phoneGate, deps.buy, deps.complete, deps.release]) expect(f).not.toHaveBeenCalled()
  })

  it.each([
    ["error outcome", async () => ({ kind: "error" }) as ClaimOutcome],
    ["claim throws", async () => { throw new Error("db") }],
  ])("%s => 503 fail closed, no gate, no engine", async (_n, impl) => {
    const { deps } = makeDeps()
    deps.claim.mockImplementationOnce(impl as any)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(503)
    expect(err(r)).toContain("nothing was charged")
    for (const f of [deps.surfaceOpen, deps.phoneGate, deps.buy, deps.complete, deps.release]) expect(f).not.toHaveBeenCalled()
  })

  it.each([
    ["surface closed", async () => false],
    ["surface throws", async () => { throw new Error("cfg") }],
  ])("%s => 403 NOT_AVAILABLE, claim released, no engine", async (_n, impl) => {
    const { deps, table } = makeDeps()
    deps.surfaceOpen.mockImplementationOnce(impl as any)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(err(r)).toContain("NOT_AVAILABLE")
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(table.rows.size).toBe(0)
    expect(deps.phoneGate).not.toHaveBeenCalled()
    expect(deps.buy).not.toHaveBeenCalled()
  })

  it.each([
    ["phone gate false", async () => false],
    ["phone gate throws", async () => { throw new Error("gate") }],
  ])("%s => 403 PHONE_NOT_VERIFIED, claim released, no engine", async (_n, impl) => {
    const { deps, table } = makeDeps()
    deps.phoneGate.mockImplementationOnce(impl as any)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(403)
    expect(err(r)).toContain("PHONE_NOT_VERIFIED")
    expect(table.rows.size).toBe(0)
    expect(deps.buy).not.toHaveBeenCalled()
  })

  it.each([
    [{ ok: false, status: 400, error: "Enter a valid Ghana mobile number" }, 400, "recipient must be a valid Ghana mobile number"],
    [{ ok: false, status: 403, error: "Standard Bundles are not available" }, 403, "NOT_AVAILABLE"],
    [{ ok: false, status: 409, error: "Prices refreshed — pick the bundle again" }, 409, "BUNDLE_TOKEN_EXPIRED"],
    [{ ok: false, status: 409, error: "This bundle isn't available for that number right now — refresh" }, 409, "BUNDLE_UNAVAILABLE_FOR_NUMBER"],
    [{ ok: false, status: 503, error: "Bundles unavailable right now" }, 503, "UNAVAILABLE"],
    [{ ok: false, status: 402, error: "Insufficient wallet balance", order: { payment_status: "unpaid", reference_code: "SB-X" } }, 402, "INSUFFICIENT_BALANCE"],
    [
      { ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 5.5, payAmount: 5, customerCashback: 0.5 } },
      409,
      "PRICE_CHANGED: expected 5.50, current 5.00",
    ],
  ])("no-charge refusal %j => %s released, mapped, no alert", async (refusal, status, fragment) => {
    const { deps, table } = makeDeps()
    deps.buy.mockResolvedValueOnce(refusal)
    const r = await purchaseBundleHandler(deps)(body({ expected_pay: 5.5 }), LIVE)
    expect(r.status).toBe(status)
    expect(err(r)).toContain(fragment)
    expect(deps.release).toHaveBeenCalledWith("claim-1", "user-1")
    expect(table.rows.size).toBe(0)
    expect(deps.markUnknown).not.toHaveBeenCalled()
    expect(deps.alert).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(JSON.stringify(r)).not.toContain(ENGINE_TEXT)
  })

  it("after a released no-charge refusal the same reference can be retried with a FRESH engine key", async () => {
    const { deps } = makeDeps()
    deps.buy.mockResolvedValueOnce({ ok: false, status: 402, error: "Insufficient wallet balance", order: { payment_status: "unpaid", reference_code: "SB-X" } })
    const first = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(first.status).toBe(402)
    const second = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(second.status).toBe(201)
    const keys = deps.buy.mock.calls.map((c) => c[0].idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys[0]).toBe(bundleEngineKey("claim-1"))
    expect(keys[1]).toBe(bundleEngineKey("claim-2"))
  })

  it.each([
    ["500 uncertain with the order", { ok: false, status: 500, error: ENGINE_TEXT, order: { reference_code: "SB-AAA111", payment_status: "unpaid" } }, "SB-AAA111"],
    ["409 with an order", { ok: false, status: 409, error: ENGINE_TEXT, order: { reference_code: "SB-AAA111" } }, "SB-AAA111"],
    ["bare 500", { ok: false, status: 500, error: ENGINE_TEXT }, undefined],
    ["unknown 409 text", { ok: false, status: 409, error: ENGINE_TEXT }, undefined],
    ["unknown status", { ok: false, status: 418, error: ENGINE_TEXT }, undefined],
    ["null result", null, undefined],
    ["no ok flag", { order: engineOrder() }, undefined],
    ["ok without an order", { ok: true }, undefined],
    ["ok with an unpaid order", { ok: true, order: engineOrder({ payment_status: "unpaid" }) }, "SB-AAA111"],
    ["ok with a blank reference", { ok: true, order: engineOrder({ reference_code: "" }) }, undefined],
  ])("ambiguous: %s => claim marked unknown (order kept), urgent alert, OUTCOME_UNKNOWN, never released", async (_n, result, orderRef) => {
    const { deps, table } = makeDeps()
    vi.spyOn(console, "error").mockImplementation(() => {})
    deps.buy.mockResolvedValueOnce(result as any)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(err(r)).toBe(MSG_BUNDLE_OUTCOME_UNKNOWN)
    expect(deps.release).not.toHaveBeenCalled()
    expect(deps.complete).not.toHaveBeenCalled()
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.markUnknown.mock.calls[0].slice(0, 2)).toEqual(["claim-1", "user-1"])
    expect(deps.markUnknown.mock.calls[0][2]).toBe(orderRef)
    expect(table.rows.get("user-1|BND-001")?.status).toBe("unknown")
    expect(deps.alert).toHaveBeenCalledTimes(1)
    const alert = deps.alert.mock.calls[0][0]
    expect(alert).toContain("BND-001")
    expect(alert).toContain("user-1")
    for (const leak of [ENGINE_TEXT, PHONE, "233249991070"]) {
      expect(alert).not.toContain(leak)
      expect(JSON.stringify(r)).not.toContain(leak)
    }
  })

  it("the engine throwing is ambiguous, and the reference then answers OUTCOME_UNKNOWN without a second engine call", async () => {
    const { deps } = makeDeps()
    vi.spyOn(console, "error").mockImplementation(() => {})
    deps.buy.mockRejectedValueOnce(new Error(ENGINE_TEXT))
    const first = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(first.status).toBe(500)
    expect(err(first)).toBe(MSG_BUNDLE_OUTCOME_UNKNOWN)
    const again = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(again.status).toBe(409)
    expect(err(again)).toBe(MSG_BUNDLE_PRIOR_UNKNOWN)
    expect(deps.buy).toHaveBeenCalledTimes(1)
  })

  it("a failed claim finalisation after a successful purchase still answers 201 and falls back to unknown WITH the order", async () => {
    const { deps, table } = makeDeps()
    vi.spyOn(console, "error").mockImplementation(() => {})
    deps.complete.mockResolvedValueOnce(false)
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(201)
    expect(deps.markUnknown).toHaveBeenCalledTimes(1)
    expect(deps.markUnknown.mock.calls[0][2]).toBe("SB-AAA111")
    expect(table.rows.get("user-1|BND-001")?.orderRef).toBe("SB-AAA111")
    expect(deps.alert).toHaveBeenCalledTimes(1)
  })

  it("an alert that throws never changes the response", async () => {
    const { deps } = makeDeps()
    vi.spyOn(console, "error").mockImplementation(() => {})
    deps.alert.mockRejectedValue(new Error("sms down"))
    deps.buy.mockResolvedValueOnce({ ok: false, status: 500, error: "x" })
    const r = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(r.status).toBe(500)
    expect(err(r)).toBe(MSG_BUNDLE_OUTCOME_UNKNOWN)
  })

  it("two concurrent requests with one reference reach the engine once", async () => {
    const { deps } = makeDeps()
    let release!: () => void
    deps.buy.mockImplementationOnce(() => new Promise((res) => { release = () => res(engineOk() as any) }))
    const a = purchaseBundleHandler(deps)(body(), LIVE)
    await Promise.resolve()
    await Promise.resolve()
    const b = await purchaseBundleHandler(deps)(body(), LIVE)
    expect(b.status).toBe(409)
    expect(err(b)).toBe(MSG_BUNDLE_IN_PROGRESS)
    release()
    expect((await a).status).toBe(201)
    expect(deps.buy).toHaveBeenCalledTimes(1)
  })

  it("a live claim is hashed from the decoded bundle, so the engine sees exactly what was claimed", async () => {
    const { deps } = makeDeps()
    const b = body()
    const parsed = parseBundlePurchaseBody(b)
    if (!parsed.ok) throw new Error("parse")
    await purchaseBundleHandler(deps)(b, LIVE)
    expect(deps.claim.mock.calls[0][0].requestHash).toBe(bundleHash(parsed.value))
  })
})

// ---------------------------------------------------------------- sandbox purchase

describe("purchaseBundleHandler (test key)", () => {
  const sbxBody = (over: Record<string, unknown> = {}) => ({ bundle_token: "sbx_mtn_1gb", recipient: PHONE, reference: "SBX-001", ...over })

  it("places a sandbox order, never touching live dependencies", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(sbxBody(), TEST)
    expect(r.status).toBe(201)
    expect((r.data as any).sandbox).toBe(true)
    expect(Object.keys((r.data as any).order).sort()).toEqual(ORDER_KEYS)
    expect((r.data as any).order).toMatchObject({ reference: "SBX-001", network: "MTN", bundle: "1GB", recipient: PHONE, face_amount: 5, paid_amount: 5, cashback: 0 })
    const p = deps.sandbox.place.mock.calls[0][0]
    expect(p).toMatchObject({ userId: "user-1", apiV2KeyId: "key-test-1", action: "standard_bundle", reference: "SBX-001", price: 5 })
    expect(JSON.stringify(r)).not.toContain("sbx_mtn_1gb")
    liveUntouched(deps)
  })

  it("rejects a live token on a test key without touching anything", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(body(), TEST)
    expect(r.status).toBe(400)
    expect(err(r)).toBe(MSG_TOKEN_ON_TEST_KEY)
    liveUntouched(deps)
    sandboxUntouched(deps)
  })

  it("rejects an unknown sandbox token", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(sbxBody({ bundle_token: "sbx_nope" }), TEST)
    expect(r.status).toBe(400)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it("replays the same order and conflicts on a different one", async () => {
    const { deps } = makeDeps()
    const first = await purchaseBundleHandler(deps)(sbxBody(), TEST)
    const stored: BundleSandboxOrder = {
      reference: "SBX-001",
      action: "standard_bundle",
      response: { ...(deps.sandbox.place.mock.calls[0][0] as any).orderFields, reference: "SBX-001", status: "pending" },
      price: 5,
      created_at: CREATED,
      status: "pending",
    }
    expect(first.status).toBe(201)
    deps.sandbox.getOrder.mockResolvedValue(stored)
    deps.sandbox.place.mockClear()
    const same = await purchaseBundleHandler(deps)(sbxBody(), TEST)
    expect(same.status).toBe(200)
    expect((same.data as any).replayed).toBe(true)
    const other = await purchaseBundleHandler(deps)(sbxBody({ recipient: PHONE_2 }), TEST)
    expect(other.status).toBe(409)
    expect(err(other)).toContain("REFERENCE_REUSED")
    const otherBundle = await purchaseBundleHandler(deps)(sbxBody({ bundle_token: "sbx_mtn_5gb" }), TEST)
    expect(otherBundle.status).toBe(409)
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it("expected_pay that is not the face price => 409 PRICE_CHANGED with nothing placed", async () => {
    const { deps } = makeDeps()
    const r = await purchaseBundleHandler(deps)(sbxBody({ expected_pay: 4 }), TEST)
    expect(r.status).toBe(409)
    expect(err(r)).toContain("PRICE_CHANGED: expected 4.00, current 5.00")
    expect(deps.sandbox.place).not.toHaveBeenCalled()
  })

  it("maps sandbox placement failures", async () => {
    const { deps } = makeDeps()
    deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 402 })
    const poor = await purchaseBundleHandler(deps)(sbxBody(), TEST)
    expect(poor.status).toBe(402)
    expect(err(poor)).toBe("INSUFFICIENT_BALANCE: test balance is too low; required 5.00")
    deps.sandbox.place.mockResolvedValueOnce({ success: false, error: "x", status: 500 })
    const down = await purchaseBundleHandler(deps)(sbxBody({ reference: "SBX-002" }), TEST)
    expect(down.status).toBe(500)
    deps.sandbox.getOrder.mockRejectedValueOnce(new Error("db"))
    const boom = await purchaseBundleHandler(deps)(sbxBody({ reference: "SBX-003" }), TEST)
    expect(boom.status).toBe(500)
  })
})

// ---------------------------------------------------------------- lookup + list

describe("bundleOrderHandler", () => {
  it("treats a malformed reference as not found without I/O", async () => {
    const { deps } = makeDeps()
    for (const ref of ["", "a", "bad ref!", "x".repeat(101)]) {
      const r = await bundleOrderHandler(deps)(ref, LIVE)
      expect(r.status).toBe(404)
      expect(err(r)).toBe(MSG_BUNDLE_ORDER_NOT_FOUND)
    }
    liveUntouched(deps)
  })

  it("not found for a missing, non-done-without-state or order-less claim", async () => {
    const { deps } = makeDeps()
    expect((await bundleOrderHandler(deps)("BND-001", LIVE)).status).toBe(404)
    deps.getClaim.mockResolvedValueOnce({ orderRef: null, status: "done", response: {} })
    expect((await bundleOrderHandler(deps)("BND-001", LIVE)).status).toBe(404)
    deps.getClaim.mockRejectedValueOnce(new Error("db"))
    expect((await bundleOrderHandler(deps)("BND-001", LIVE)).status).toBe(404)
  })

  it("shows the caller's own running or ambiguous claim as claim.state, never a 404", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValueOnce({ orderRef: null, status: "in_progress", response: null, createdAt: new Date(NOW_MS - 1000).toISOString() })
    const running = await bundleOrderHandler(deps)("BND-001", LIVE)
    expect(running.data).toEqual({ order: null, claim: { reference: "BND-001", state: "in_progress" } })
    deps.getClaim.mockResolvedValueOnce({ orderRef: "SB-AAA111", status: "unknown", response: null })
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ payment_status: "unpaid" }))
    const unknown = await bundleOrderHandler(deps)("BND-001", LIVE)
    expect(unknown.data).toEqual({ order: null, claim: { reference: "BND-001", state: "outcome_unknown" } })
  })

  it("an unknown claim whose engine order is PAID shows the order (the money moved), else still claim.state", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue({ orderRef: "SB-AAA111", status: "unknown", response: null })
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ payment_status: "paid", status: "processing" }))
    const paid = await bundleOrderHandler(deps)("BND-001", LIVE)
    expect(paid.status).toBe(200)
    expect((paid.data as any).claim).toBeNull()
    expect(Object.keys((paid.data as any).order).sort()).toEqual(ORDER_KEYS)
    expect((paid.data as any).order.reference).toBe("BND-001")
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "SB-AAA111")
    for (const live of [liveRow({ payment_status: "unpaid" }), liveRow({ payment_status: null }), null]) {
      deps.getOrderByCode.mockResolvedValueOnce(live)
      const r = await bundleOrderHandler(deps)("BND-001", LIVE)
      expect(r.data).toEqual({ order: null, claim: { reference: "BND-001", state: "outcome_unknown" } })
    }
    deps.getOrderByCode.mockRejectedValueOnce(new Error("db"))
    expect((await bundleOrderHandler(deps)("BND-001", LIVE)).data).toEqual({ order: null, claim: { reference: "BND-001", state: "outcome_unknown" } })
  })

  it("a done claim returns the stored order with the live status", async () => {
    const { deps } = makeDeps()
    const stored = { reference: "BND-001", network: "MTN", bundle: "1GB", recipient: PHONE, face_amount: 5.5, paid_amount: 5.5, cashback: 0, status: "processing", created_at: CREATED, leak: ENGINE_TEXT }
    deps.getClaim.mockResolvedValueOnce({ orderRef: "SB-AAA111", status: "done", response: stored })
    deps.getOrderByCode.mockResolvedValueOnce(liveRow({ status: "completed" }))
    const r = await bundleOrderHandler(deps)("BND-001", LIVE)
    expect(r.status).toBe(200)
    expect((r.data as any).claim).toBeNull()
    expect((r.data as any).order.status).toBe("completed")
    expect(Object.keys((r.data as any).order).sort()).toEqual(ORDER_KEYS)
    expect(JSON.stringify(r)).not.toContain(ENGINE_TEXT)
    expect(deps.getOrderByCode).toHaveBeenCalledWith("user-1", "SB-AAA111")
  })

  it("a done claim without a stored response falls back to the live row, else 404", async () => {
    const { deps } = makeDeps()
    deps.getClaim.mockResolvedValue({ orderRef: "SB-AAA111", status: "done", response: null })
    const live = await bundleOrderHandler(deps)("BND-001", LIVE)
    expect(live.status).toBe(200)
    expect((live.data as any).order.reference).toBe("BND-001")
    deps.getOrderByCode.mockResolvedValueOnce(null)
    expect((await bundleOrderHandler(deps)("BND-001", LIVE)).status).toBe(404)
  })

  it("test key reads the sandbox only", async () => {
    const { deps } = makeDeps()
    deps.sandbox.getOrder.mockResolvedValueOnce({
      reference: "SBX-001",
      action: "standard_bundle",
      response: { network: "TELECEL", bundle: "1GB Daily", phone: PHONE, face_amount: 6, paid_amount: 6, cashback: 0, sandbox_token: "sbx_tel_1gb" },
      price: 6,
      created_at: CREATED,
      status: "completed",
    })
    const r = await bundleOrderHandler(deps)("SBX-001", TEST)
    expect(r.status).toBe(200)
    expect((r.data as any)).toMatchObject({ claim: null, sandbox: true, order: { network: "Telecel", bundle: "1GB Daily", status: "completed" } })
    expect(JSON.stringify(r)).not.toContain("sbx_tel_1gb")
    deps.sandbox.getOrder.mockResolvedValueOnce({ reference: "X", action: "airtime", response: {}, price: 1, created_at: CREATED, status: "pending" })
    expect((await bundleOrderHandler(deps)("SBX-009", TEST)).status).toBe(404)
    liveUntouched(deps)
  })
})

describe("bundleListHandler", () => {
  it("lists done claims with their live orders, newest first, skipping unreadable ones", async () => {
    const { deps } = makeDeps()
    deps.listClaims.mockResolvedValueOnce([
      { reference: "BND-002", orderRef: "SB-2", status: "done" },
      { reference: "BND-X", orderRef: null, status: "done" },
      { reference: "BND-003", orderRef: "SB-3", status: "unknown" },
      { reference: "BND-001", orderRef: "SB-1", status: "done" },
    ])
    deps.getOrdersByCodes.mockResolvedValueOnce([liveRow({ reference_code: "SB-1" }), liveRow({ reference_code: "SB-2", bundle_display: "5GB" })])
    const r = await bundleListHandler(deps)(LIVE)
    expect(r.status).toBe(200)
    expect(deps.listClaims).toHaveBeenCalledWith("user-1", BUNDLE_LIST_LIMIT)
    expect(deps.getOrdersByCodes).toHaveBeenCalledWith("user-1", ["SB-2", "SB-1"])
    expect((r.data as any).orders.map((o: any) => [o.reference, o.bundle])).toEqual([["BND-002", "5GB"], ["BND-001", "1GB"]])
  })

  it("empty => 200 []; claim-store or order-read failure => 503, never an empty 200", async () => {
    const { deps } = makeDeps()
    expect((await bundleListHandler(deps)(LIVE)).data).toEqual({ orders: [] })
    deps.listClaims.mockResolvedValueOnce(null)
    expect((await bundleListHandler(deps)(LIVE)).status).toBe(503)
    deps.listClaims.mockRejectedValueOnce(new Error("db"))
    expect((await bundleListHandler(deps)(LIVE)).status).toBe(503)
    deps.listClaims.mockResolvedValueOnce([{ reference: "BND-001", orderRef: "SB-1", status: "done" }])
    deps.getOrdersByCodes.mockResolvedValueOnce(null)
    expect((await bundleListHandler(deps)(LIVE)).status).toBe(503)
  })

  it("test key lists sandbox bundle orders only", async () => {
    const { deps } = makeDeps()
    deps.sandbox.listOrders.mockResolvedValueOnce([
      { reference: "SBX-001", action: "standard_bundle", response: { network: "AT", bundle: "2GB BigTime", phone: PHONE, face_amount: 9, paid_amount: 9, cashback: 0 }, price: 9, created_at: CREATED, status: "pending" },
      { reference: "OTHER", action: "airtime", response: {}, price: 1, created_at: CREATED, status: "pending" },
    ])
    const r = await bundleListHandler(deps)(TEST)
    expect(r.status).toBe(200)
    expect((r.data as any).sandbox).toBe(true)
    expect((r.data as any).orders).toHaveLength(1)
    expect(deps.sandbox.listOrders).toHaveBeenCalledWith("user-1", "standard_bundle", BUNDLE_LIST_LIMIT)
    liveUntouched(deps)
    deps.sandbox.listOrders.mockResolvedValueOnce(null)
    expect((await bundleListHandler(deps)(TEST)).status).toBe(503)
  })
})
