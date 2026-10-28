import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
const checkPhoneVerified = vi.hoisted(() => vi.fn())
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified }))

const notifyAdmins = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins }))

const buyBundle = vi.hoisted(() => vi.fn())
vi.mock("@/lib/standard-bundles/service", async (orig) => ({ ...(await orig<typeof import("@/lib/standard-bundles/service")>()), buyBundle }))

const getCatalog = vi.hoisted(() => vi.fn())
vi.mock("@/lib/standard-bundles/catalog", async (orig) => ({ ...(await orig<typeof import("@/lib/standard-bundles/catalog")>()), getCatalog }))

const runtime = vi.hoisted(() => ({
  deps: {
    getCashbackConfig: vi.fn(),
    getBuyerTier: vi.fn(),
  } as any,
}))
vi.mock("@/lib/standard-bundles/runtime", () => ({ getBundlesRuntime: () => ({ deps: runtime.deps, db: {} }) }))

const idem = vi.hoisted(() => ({
  listClaims: vi.fn(async () => []),
  getClaimByReference: vi.fn(async () => null),
  markClaimUnknown: vi.fn(async () => true),
}))
vi.mock("../idempotency", async (orig) => ({ ...(await orig<typeof import("../idempotency")>()), ...idem }))
vi.mock("../store", async (orig) => ({ ...(await orig<typeof import("../store")>()), getAdminClient: () => ({ fake: true }) }))

import {
  BUNDLE_ORDER_COLUMNS,
  fetchBundleOrderByCode,
  fetchBundleOrdersByCodes,
  realBundleAlert,
  realBundleBuy,
  realBundleCatalog,
  realBundleDeps,
  toBuyArgs,
} from "./bundles-deps"

// Unique test phones for this file: 0249991075-0249991079.

function fakeClient(result: { data: unknown; error: unknown } | "throw") {
  const calls: Array<[string, ...unknown[]]> = []
  const q: any = {}
  const settle = () => (result === "throw" ? Promise.reject(new Error("db")) : Promise.resolve(result))
  for (const m of ["select", "eq"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.in = (...a: unknown[]) => {
    calls.push(["in", ...a])
    return { then: (res: any, rej: any) => settle().then(res, rej) }
  }
  q.maybeSingle = () => {
    calls.push(["maybeSingle"])
    return settle()
  }
  const client = {
    from: (t: string) => {
      calls.push(["from", t])
      return q
    },
  }
  return { client, calls }
}

const OPEN_CFG = { enabled: true, surfaces: { api: true } }

beforeEach(() => {
  vi.clearAllMocks()
  runtime.deps.getCashbackConfig = vi.fn(async () => OPEN_CFG)
  runtime.deps.getBuyerTier = vi.fn(async () => "customer")
})

describe("bundle order reads", () => {
  it("select only the allow-listed columns", () => {
    expect(BUNDLE_ORDER_COLUMNS.split(",").map((s) => s.trim()).sort()).toEqual(
      ["amount", "beneficiary_phone", "bundle_display", "cashback_amount", "created_at", "network", "paid_amount", "payment_status", "reference_code", "status"]
    )
    for (const secret of ["notes", "failure_reason", "hubtel_client_reference", "bundle_value", "idempotency_key", "user_id", "id"]) {
      expect(BUNDLE_ORDER_COLUMNS.split(",").map((s) => s.trim())).not.toContain(secret)
    }
  })

  it("single read is owner-scoped on hubtel_data_orders and returns null on missing/error/throw", async () => {
    const { client, calls } = fakeClient({ data: { reference_code: "SB-1" }, error: null })
    expect(await fetchBundleOrderByCode(client, "u1", "SB-1")).toEqual({ reference_code: "SB-1" })
    expect(calls).toContainEqual(["from", "hubtel_data_orders"])
    expect(calls).toContainEqual(["select", BUNDLE_ORDER_COLUMNS])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["eq", "reference_code", "SB-1"])
    expect(await fetchBundleOrderByCode(fakeClient({ data: null, error: null }).client, "u1", "SB-1")).toBeNull()
    expect(await fetchBundleOrderByCode(fakeClient({ data: null, error: { message: "e" } }).client, "u1", "SB-1")).toBeNull()
    expect(await fetchBundleOrderByCode(fakeClient("throw").client, "u1", "SB-1")).toBeNull()
  })

  it("batch read is one owner-scoped .in() of at most 30 codes; null on error", async () => {
    const { client, calls } = fakeClient({ data: [{ reference_code: "SB-1" }], error: null })
    const codes = Array.from({ length: 35 }, (_, i) => `SB-${i}`)
    expect(await fetchBundleOrdersByCodes(client, "u1", codes)).toEqual([{ reference_code: "SB-1" }])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    const inCall = calls.find((c) => c[0] === "in")!
    expect(inCall[1]).toBe("reference_code")
    expect(inCall[2]).toHaveLength(30)
    expect(calls.filter((c) => c[0] === "from")).toHaveLength(1)
    expect(await fetchBundleOrdersByCodes(fakeClient({ data: null, error: { message: "e" } }).client, "u1", ["A"])).toBeNull()
    expect(await fetchBundleOrdersByCodes(fakeClient("throw").client, "u1", ["A"])).toBeNull()
    const empty = fakeClient({ data: [], error: null })
    expect(await fetchBundleOrdersByCodes(empty.client, "u1", [])).toEqual([])
    expect(empty.calls).toHaveLength(0)
  })
})

describe("realBundleBuy", () => {
  it("calls buyBundle for the key owner with channel api forced and only the whitelisted fields", async () => {
    buyBundle.mockResolvedValue({ ok: true, order: {} })
    await realBundleBuy({
      userId: "u1",
      token: "tok",
      phone: "0249991075",
      idempotencyKey: "v2-abc",
      expectedPay: 5.5,
      // stray fields must not be forwarded
      ...({ channel: "dashboard", shopId: "shop-1" } as object),
    } as any)
    expect(buyBundle).toHaveBeenCalledTimes(1)
    const [deps, userId, input] = buyBundle.mock.calls[0]
    expect(deps).toBe(runtime.deps)
    expect(userId).toBe("u1")
    expect(input).toEqual({ token: "tok", phone: "0249991075", idempotencyKey: "v2-abc", channel: "api", expectedPay: 5.5 })
  })

  it("omits expectedPay when the client sent none", () => {
    expect(toBuyArgs({ userId: "u1", token: "t", phone: "p", idempotencyKey: "k" })).toEqual({ token: "t", phone: "p", idempotencyKey: "k", channel: "api" })
  })
})

describe("realBundleCatalog", () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    ok: true as const,
    categories: [{ name: "Data", bundles: [{ token: "tok-1", display: "1GB", amount: 5.5, value: "secret-value", category: "Data", ...extra }] }],
  })

  it("API switch off or unreadable => closed, without touching the catalogue", async () => {
    runtime.deps.getCashbackConfig = vi.fn(async () => ({ enabled: true, surfaces: { api: false } }))
    expect(await realBundleCatalog("u1", "MTN")).toEqual({ kind: "closed" })
    runtime.deps.getCashbackConfig = vi.fn(async () => { throw new Error("cfg") })
    expect(await realBundleCatalog("u1", "MTN")).toEqual({ kind: "closed" })
    expect(getCatalog).not.toHaveBeenCalled()
  })

  it("engine 403 => closed; any other failure => unavailable", async () => {
    getCatalog.mockResolvedValueOnce({ ok: false, status: 403, error: "x" })
    expect(await realBundleCatalog("u1", "MTN")).toEqual({ kind: "closed" })
    getCatalog.mockResolvedValueOnce({ ok: false, status: 503, error: "x" })
    expect(await realBundleCatalog("u1", "MTN")).toEqual({ kind: "unavailable" })
  })

  it("returns the priced tokens for the key owner and never the bundle value", async () => {
    getCatalog.mockResolvedValueOnce(ok())
    const r = await realBundleCatalog("u1", "MTN")
    expect(getCatalog).toHaveBeenCalledWith(runtime.deps, "MTN")
    expect(runtime.deps.getBuyerTier).toHaveBeenCalledWith("u1")
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.categories).toHaveLength(1)
    expect(r.categories[0].bundles[0]).toMatchObject({ bundle_token: "tok-1", display: "1GB", face_amount: 5.5 })
    expect(JSON.stringify(r)).not.toContain("secret-value")
  })

  it("a failing tier lookup falls back to the standard price instead of failing the catalogue", async () => {
    runtime.deps.getBuyerTier = vi.fn(async () => { throw new Error("tier") })
    getCatalog.mockResolvedValueOnce(ok())
    const r = await realBundleCatalog("u1", "MTN")
    expect(r.kind).toBe("ok")
  })
})

describe("realBundleDeps", () => {
  it("lists done 'bundle' claims only and reads claims by kind 'bundle'", async () => {
    const deps = realBundleDeps()
    await deps.listClaims("u1", 30)
    expect(idem.listClaims).toHaveBeenCalledWith({ fake: true }, "u1", "bundle", 30, { status: "done" })
    await deps.getClaim("u1", "BND-001")
    expect(idem.getClaimByReference).toHaveBeenCalledWith({ fake: true }, "u1", "bundle", "BND-001")
  })

  it("the surface gate is closed when the switch is off and when the config read throws", async () => {
    const deps = realBundleDeps()
    expect(await deps.surfaceOpen()).toBe(true)
    runtime.deps.getCashbackConfig = vi.fn(async () => ({ enabled: true, surfaces: { api: false } }))
    expect(await deps.surfaceOpen()).toBe(false)
    runtime.deps.getCashbackConfig = vi.fn(async () => { throw new Error("cfg") })
    expect(await deps.surfaceOpen()).toBe(false)
  })

  it("the phone gate passes only on allowed === true and a throw is a block", async () => {
    const deps = realBundleDeps()
    checkPhoneVerified.mockResolvedValueOnce({ allowed: true })
    expect(await deps.phoneGate("u1")).toBe(true)
    checkPhoneVerified.mockResolvedValueOnce({ allowed: false, error: "x" })
    expect(await deps.phoneGate("u1")).toBe(false)
    checkPhoneVerified.mockRejectedValueOnce(new Error("gate"))
    expect(await deps.phoneGate("u1")).toBe(false)
  })
})

describe("realBundleAlert", () => {
  it("forwards to the admin notifier and never throws", async () => {
    await realBundleAlert("msg")
    expect(notifyAdmins).toHaveBeenCalledWith("msg", "bills_review", undefined, false)
    notifyAdmins.mockRejectedValueOnce(new Error("down"))
    await expect(realBundleAlert("msg")).resolves.toBeUndefined()
  })
})
