import { describe, it, expect, vi } from "vitest"
import { DEFAULT_NETWORK_PREFIXES } from "@/lib/phone-format"
import type { PackageRow } from "../data-orders"
import type { OrderRow, PlaceParams, PlaceResult } from "../order-store"
import type { V2Context } from "../handler"
import {
  purchaseHandler,
  bulkHandler,
  listPackagesHandler,
  verifyNumberHandler,
  orderLookupHandler,
  BULK_DEADLINE_MS,
  type DataDeps,
  type SandboxOrderLike,
} from "./data"

// ---------------------------------------------------------------- fixtures

const ORDER_KEYS = ["created_at", "network", "price", "recipient", "reference", "status", "volume_gb"]

const PKGS: PackageRow[] = [
  { id: "p-mtn-1", network: "MTN", size: "1", price: 10, dealer_price: 8 },
  { id: "p-mtn-2", network: "MTN", size: "2", price: 18, dealer_price: 0 },
  { id: "p-tel-2", network: "Telecel", size: "2", price: 9, dealer_price: 8.5 },
  { id: "p-ati-1", network: "AT - iShare", size: "1", price: 5, dealer_price: 4.5 },
  // Unpriced rows are treated as unavailable (never listed, never sold).
  { id: "p-tel-3", network: "Telecel", size: "3", price: 0, dealer_price: null },
  { id: "p-mtn-4", network: "MTN", size: "4", price: -1, dealer_price: 5 },
  // Telecel 5GB and all AT-BigTime are unavailable, so never returned by the store.
]

const ctxOf = (environment: "live" | "test", role = "dealer"): V2Context => ({
  keyId: environment === "live" ? "key-live-1" : "key-test-1",
  userId: "user-1",
  role,
  keyType: "standard",
  environment,
  firstName: null,
})
const LIVE = ctxOf("live")
const LIVE_USER = ctxOf("live", "user")
const TEST = ctxOf("test")

const CREATED = "2026-10-23T10:00:00.000Z"

function placedOk(ref: string, newBalance = 92): PlaceResult {
  return { ok: true, replayed: false, orderId: `o-${ref}`, createdAt: CREATED, newBalance }
}

function makeDeps(over: { prefixEnabled?: boolean } = {}) {
  const store = {
    listAvailablePackages: vi.fn(async (dbNetwork?: string): Promise<PackageRow[] | null> =>
      PKGS.filter((p) => !dbNetwork || p.network.toLowerCase() === dbNetwork.toLowerCase())
    ),
    getOrderByReference: vi.fn(async (_u: string, _r: string): Promise<OrderRow | null> => null),
    getOrdersByReferences: vi.fn(async (_u: string, _refs: string[]): Promise<Map<string, OrderRow> | null> => new Map()),
    getWalletBalance: vi.fn(async (_u: string): Promise<number | null> => 1000),
    placeV2Order: vi.fn(async (p: PlaceParams): Promise<PlaceResult> => placedOk(p.reference)),
  }
  const sandbox = {
    getOrder: vi.fn(async (_u: string, _r: string): Promise<SandboxOrderLike | null> => null),
    getOrders: vi.fn(async (_u: string, _refs: string[]): Promise<Map<string, SandboxOrderLike> | null> => new Map()),
    place: vi.fn(async (p: any) => ({
      success: true as const,
      order: { ...p.orderFields, reference: p.reference, status: "pending", created_at: CREATED },
      newBalance: 92,
    })),
    balance: vi.fn(async (_u: string) => 100),
  }
  const deps = {
    store,
    sandbox,
    prefixConfig: vi.fn(async () => ({ enabled: over.prefixEnabled ?? true, map: DEFAULT_NETWORK_PREFIXES })),
    verifyMtn: vi.fn(async (locals: string[]) => new Map<string, boolean | null>(locals.map((l) => [l, true]))),
    phoneGate: vi.fn(async (_u: string) => ({ allowed: true })),
    schedule: vi.fn(),
    clock: { ms: 0 },
    now: (): Date => new Date(Date.parse(CREATED) + deps.clock.ms),
  }
  return deps as typeof deps & DataDeps
}

type Deps = ReturnType<typeof makeDeps>

function allFns(d: Deps) {
  return [
    ...Object.values(d.store),
    ...Object.values(d.sandbox),
    d.prefixConfig,
    d.verifyMtn,
    d.phoneGate,
    d.schedule,
  ] as Array<ReturnType<typeof vi.fn>>
}

/** Sandbox may read the real package CATALOG (same pricing as live) but nothing that holds money or orders. */
function expectNoRealOrderOrWallet(d: Deps) {
  expect(d.store.getOrderByReference).not.toHaveBeenCalled()
  expect(d.store.getOrdersByReferences).not.toHaveBeenCalled()
  expect(d.store.getWalletBalance).not.toHaveBeenCalled()
  expect(d.store.placeV2Order).not.toHaveBeenCalled()
}

function expectNothingCalled(d: Deps) {
  for (const f of allFns(d)) expect(f).not.toHaveBeenCalled()
}

function expectNoMoney(d: Deps) {
  expect(d.store.placeV2Order).not.toHaveBeenCalled()
  expect(d.sandbox.place).not.toHaveBeenCalled()
  expect(d.schedule).not.toHaveBeenCalled()
}

function expectOrderShape(o: unknown) {
  expect(Object.keys(o as object).sort()).toEqual(ORDER_KEYS)
}

const body = (o: Record<string, unknown> = {}) => ({
  network: "MTN",
  volume_gb: 1,
  recipient: "0249990401",
  reference: "REF-001",
  ...o,
})

const row = (o: Partial<OrderRow> = {}): OrderRow => ({
  api_reference: "REF-001",
  network: "MTN",
  volume_gb: "1",
  price: "8",
  recipient_phone: "0249990401",
  status: "pending",
  created_at: CREATED,
  ...o,
})

const data = (r: { data?: unknown }) => r.data as any

// ================================================================ purchase: money first

describe("purchase (live) money path", () => {
  it("new order: placeV2Order once with the SERVER dealer price and LOCAL recipient, fulfillment scheduled once, 201", async () => {
    const d = makeDeps()
    const r = await purchaseHandler(d)(body({ recipient: "+233 24 999 0401", network: "mtn" }), LIVE)
    expect(r.status).toBe(201)
    expect(r.error).toBeUndefined()
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(1)
    expect(d.store.placeV2Order).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-live-1",
      packageId: "p-mtn-1",
      dbNetwork: "MTN",
      gb: 1,
      price: 8,
      recipientPhone: "0249990401",
      reference: "REF-001",
      description: "API data purchase: MTN 1GB (ref REF-001)",
    })
    expect(d.schedule).toHaveBeenCalledTimes(1)
    expect(d.schedule).toHaveBeenCalledWith({
      orderId: "o-REF-001",
      dbNetwork: "MTN",
      gb: 1,
      msisdn: "233249990401",
      local: "0249990401",
    })
    expectOrderShape(data(r).order)
    expect(data(r)).toEqual({
      order: {
        reference: "REF-001",
        network: "MTN",
        volume_gb: 1,
        recipient: "0249990401",
        price: 8,
        status: "pending",
        created_at: CREATED,
      },
      new_balance: 92,
    })
    expect(d.sandbox.place).not.toHaveBeenCalled()
  })

  it("a non-dealer pays the user price (10), never the dealer price", async () => {
    const d = makeDeps()
    const r = await purchaseHandler(d)(body({ recipient: "0249990402", reference: "REF-002" }), LIVE_USER)
    expect(r.status).toBe(201)
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ price: 10, packageId: "p-mtn-1" })
    expect(data(r).order.price).toBe(10)
  })

  it("a dealer with dealer_price 0 pays the user price", async () => {
    const d = makeDeps()
    await purchaseHandler(d)(body({ volume_gb: 2, recipient: "0249990403", reference: "REF-003" }), LIVE)
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ price: 18, packageId: "p-mtn-2" })
  })

  it("replay: an existing same-content order returns 200 replayed:true with NO package lookup, NO guard, NO charge, NO schedule", async () => {
    const d = makeDeps()
    d.store.getOrderByReference.mockResolvedValue(row({ recipient_phone: "0249990404", status: "completed" }))
    const r = await purchaseHandler(d)(body({ recipient: "233249990404", volume_gb: "1", network: "MTN" }), LIVE)
    expect(r.status).toBe(200)
    expect(d.store.getOrderByReference).toHaveBeenCalledWith("user-1", "REF-001")
    expect(d.store.listAvailablePackages).not.toHaveBeenCalled()
    expect(d.prefixConfig).not.toHaveBeenCalled()
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expectNoMoney(d)
    expect(data(r).replayed).toBe(true)
    expectOrderShape(data(r).order)
    expect(data(r).order).toMatchObject({ recipient: "0249990404", status: "completed", price: 8 })
  })

  it("replay also matches a v1-era row stored with a 233 recipient and lower-case network", async () => {
    const d = makeDeps()
    d.store.getOrderByReference.mockResolvedValue(row({ network: "mtn", recipient_phone: "233249990405" }))
    const r = await purchaseHandler(d)(body({ recipient: "0249990405" }), LIVE)
    expect(r.status).toBe(200)
    expect(data(r).replayed).toBe(true)
    expectNoMoney(d)
  })

  it("same reference with a different recipient, size or network -> 409 REFERENCE_REUSED, no charge", async () => {
    const variants: Array<Record<string, unknown>> = [
      { recipient: "0249990407" },
      { volume_gb: 2 },
      { network: "Telecel" },
    ]
    for (const v of variants) {
      const d = makeDeps({ prefixEnabled: false })
      d.store.getOrderByReference.mockResolvedValue(row({ recipient_phone: "0249990406" }))
      const r = await purchaseHandler(d)(body({ recipient: "0249990406", ...v }), LIVE)
      expect(r.status).toBe(409)
      expect(r.error?.status).toBe(409)
      expect(r.error?.message.startsWith("REFERENCE_REUSED:")).toBe(true)
      expect(d.store.listAvailablePackages).not.toHaveBeenCalled()
      expectNoMoney(d)
    }
  })

  it("RPC race result replayed:true -> 200 replayed, fulfillment NOT scheduled", async () => {
    const d = makeDeps()
    d.store.getOrderByReference
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ recipient_phone: "0249990408", status: "processing" }))
    d.store.placeV2Order.mockResolvedValue({ ok: true, replayed: true, orderId: "o-x", createdAt: CREATED, status: "processing" })
    const r = await purchaseHandler(d)(body({ recipient: "0249990408" }), LIVE)
    expect(r.status).toBe(200)
    expect(data(r).replayed).toBe(true)
    expectOrderShape(data(r).order)
    expect(data(r).order.status).toBe("processing")
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(1)
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it("RPC race result replayed:true still answers when the re-read fails (built from the request)", async () => {
    const d = makeDeps()
    d.store.placeV2Order.mockResolvedValue({ ok: true, replayed: true, orderId: "o-x", createdAt: CREATED, status: "held_registration" })
    const r = await purchaseHandler(d)(body({ recipient: "0249990409" }), LIVE)
    expect(r.status).toBe(200)
    expectOrderShape(data(r).order)
    expect(data(r).order).toMatchObject({ status: "queued", recipient: "0249990409", price: 8 })
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it("RPC REFERENCE_REUSED (race) -> 409, no schedule", async () => {
    const d = makeDeps()
    d.store.placeV2Order.mockResolvedValue({ ok: false, code: "REFERENCE_REUSED" })
    const r = await purchaseHandler(d)(body({ recipient: "0249990410" }), LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message.startsWith("REFERENCE_REUSED:")).toBe(true)
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it("INSUFFICIENT_BALANCE -> 402 carrying the required amount, no schedule", async () => {
    const d = makeDeps()
    d.store.placeV2Order.mockResolvedValue({ ok: false, code: "INSUFFICIENT_BALANCE", required: 8, balance: 3 })
    const r = await purchaseHandler(d)(body({ recipient: "0249990411" }), LIVE)
    expect(r.status).toBe(402)
    expect(r.error).toEqual({ status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 8.00" })
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it("WALLET_NOT_FOUND -> 402 (same body as insufficient: no wallet is a zero balance); FAILED -> generic 500", async () => {
    const d = makeDeps()
    d.store.placeV2Order.mockResolvedValue({ ok: false, code: "WALLET_NOT_FOUND" })
    const r = await purchaseHandler(d)(body({ recipient: "0249990412" }), LIVE)
    expect(r.error).toEqual({ status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 8.00" })

    const d2 = makeDeps()
    d2.store.placeV2Order.mockResolvedValue({ ok: false, code: "FAILED" })
    const r2 = await purchaseHandler(d2)(body({ recipient: "0249990412" }), LIVE)
    expect(r2.status).toBe(500)
    expect(r2.error).toEqual({ status: 500, message: "Order could not be placed" })
    expect(d.schedule).not.toHaveBeenCalled()
    expect(d2.schedule).not.toHaveBeenCalled()
  })

  it("body price/amount/package_id/user_id/status fields are rejected 400 before ANY dependency call", async () => {
    for (const extra of [
      { price: 0.01 },
      { amount: 1 },
      { package_id: "p-mtn-1" },
      { user_id: "someone" },
      { status: "completed" },
      { Price: 1 },
    ]) {
      const d = makeDeps()
      const r = await purchaseHandler(d)(body(extra), LIVE)
      expect(r.status).toBe(400)
      expectNothingCalled(d)
    }
  })

  it("non-object / invalid bodies are 400 with no dependency call", async () => {
    for (const b of [undefined, null, [], "x", body({ recipient: "0249990413\n" }), body({ volume_gb: 0 }), body({ reference: "a" })]) {
      const d = makeDeps()
      const r = await purchaseHandler(d)(b, LIVE)
      expect(r.status).toBe(400)
      expectNothingCalled(d)
    }
  })

  it("an unavailable package (Telecel 5GB, any AT-BigTime) -> 404, no charge", async () => {
    for (const b of [
      body({ network: "Telecel", volume_gb: 5, recipient: "0249990414" }),
      body({ network: "AT-BigTime", volume_gb: 1, recipient: "0249990414" }),
      body({ network: "MTN", volume_gb: 3, recipient: "0249990414" }),
    ]) {
      const d = makeDeps({ prefixEnabled: false })
      const r = await purchaseHandler(d)(b, LIVE)
      expect(r.status).toBe(404)
      expect(r.error).toEqual({ status: 404, message: "Package not found or unavailable" })
      expectNoMoney(d)
    }
  })

  it("an unpriced package (price 0 or negative) is unavailable -> 404, no charge", async () => {
    for (const b of [
      body({ network: "Telecel", volume_gb: 3, recipient: "0249990486" }),
      body({ network: "MTN", volume_gb: 4, recipient: "0249990486" }),
    ]) {
      const d = makeDeps({ prefixEnabled: false })
      const r = await purchaseHandler(d)(b, LIVE)
      expect(r.status).toBe(404)
      expectNoMoney(d)
    }
  })

  it("package catalog unreadable -> 503 Service temporarily unavailable (not 404), no charge", async () => {
    const d = makeDeps()
    d.store.listAvailablePackages.mockResolvedValue(null)
    const r = await purchaseHandler(d)(body({ recipient: "0249990487" }), LIVE)
    expect(r).toEqual({ status: 503, error: { status: 503, message: "Service temporarily unavailable" } })
    expectNoMoney(d)
  })

  it("network/prefix mismatch -> 400 NETWORK_MISMATCH, no charge, the number is not echoed", async () => {
    const d = makeDeps()
    const r = await purchaseHandler(d)(body({ network: "Telecel", volume_gb: 2, recipient: "0249990415" }), LIVE)
    expect(r.status).toBe(400)
    expect(r.error?.message.startsWith("NETWORK_MISMATCH:")).toBe(true)
    expect(r.error?.message).not.toContain("9990415")
    expectNoMoney(d)
    expect(d.verifyMtn).not.toHaveBeenCalled()
  })

  it("prefix validation switched off by admin lets a mismatched number through (same as v1)", async () => {
    const d = makeDeps({ prefixEnabled: false })
    const r = await purchaseHandler(d)(body({ network: "Telecel", volume_gb: 2, recipient: "0249990416" }), LIVE)
    expect(r.status).toBe(201)
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ packageId: "p-tel-2", price: 8.5, dbNetwork: "Telecel" })
  })

  it("MTN recipient the whitelist guard says is NOT registered -> 409 RECIPIENT_NOT_REGISTERED, placeV2Order NOT called", async () => {
    const d = makeDeps()
    d.verifyMtn.mockResolvedValue(new Map([["0249990417", false]]))
    const r = await purchaseHandler(d)(body({ recipient: "233249990417" }), LIVE)
    expect(d.verifyMtn).toHaveBeenCalledWith(["0249990417"])
    expect(r.status).toBe(409)
    expect(r.error?.message.startsWith("RECIPIENT_NOT_REGISTERED:")).toBe(true)
    expect(r.error?.message).not.toContain("9990417")
    expectNoMoney(d)
  })

  it("MTN check unavailable (null verdict) FAILS OPEN per the customer-verification guard contract: order placed, fulfillment-time hold is the backstop", async () => {
    const d = makeDeps()
    d.verifyMtn.mockResolvedValue(new Map([["0249990418", null]]))
    const r = await purchaseHandler(d)(body({ recipient: "0249990418" }), LIVE)
    expect(r.status).toBe(201)
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(1)
    expect(d.schedule).toHaveBeenCalledTimes(1)
  })

  it("MTN check that returns no verdict for the number also fails open", async () => {
    const d = makeDeps()
    d.verifyMtn.mockResolvedValue(new Map())
    const r = await purchaseHandler(d)(body({ recipient: "0249990419" }), LIVE)
    expect(r.status).toBe(201)
  })

  it("non-MTN purchase never calls the MTN guard", async () => {
    const d = makeDeps({ prefixEnabled: false })
    const r = await purchaseHandler(d)(body({ network: "AT-iShare", recipient: "0249990420" }), LIVE)
    expect(r.status).toBe(201)
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expect(d.store.placeV2Order.mock.calls[0][0]).toMatchObject({ dbNetwork: "AT - iShare", price: 4.5 })
    expect(data(r).order.network).toBe("AT-iShare")
  })
})

// ================================================================ purchase: sandbox

describe("purchase (test key / sandbox)", () => {
  it("new reference places via the sandbox only: no real store, no placeV2Order, no guard, no schedule", async () => {
    const d = makeDeps()
    const r = await purchaseHandler(d)(body({ recipient: "233249990421", reference: "SBX-1" }), TEST)
    expect(r.status).toBe(201)
    expectNoRealOrderOrWallet(d)
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expect(d.schedule).not.toHaveBeenCalled()
    expect(d.sandbox.place).toHaveBeenCalledTimes(1)
    expect(d.sandbox.place).toHaveBeenCalledWith({
      userId: "user-1",
      apiV2KeyId: "key-test-1",
      action: "data_order",
      reference: "SBX-1",
      request: { network: "MTN", volume_gb: 1, recipient: "0249990421", reference: "SBX-1" },
      price: 8,
      orderFields: { network: "MTN", volume_gb: 1, price: 8, recipient: "0249990421" },
    })
    expectOrderShape(data(r).order)
    expect(data(r)).toMatchObject({ new_balance: 92, sandbox: true })
    expect(data(r).order).toMatchObject({ recipient: "0249990421", price: 8, status: "pending", reference: "SBX-1" })
  })

  it("sandbox still runs package and prefix checks", async () => {
    const d = makeDeps()
    expect((await purchaseHandler(d)(body({ network: "Telecel", volume_gb: 5, recipient: "0249990422" }), TEST)).status).toBe(404)
    expect((await purchaseHandler(d)(body({ network: "Telecel", volume_gb: 2, recipient: "0249990422" }), TEST)).status).toBe(400)
    expect(d.sandbox.place).not.toHaveBeenCalled()
  })

  const sbxPrior = (o: Partial<SandboxOrderLike> = {}): SandboxOrderLike => ({
    reference: "SBX-2",
    action: "data_order",
    response: { network: "MTN", volume_gb: 1, price: 8, recipient: "0249990423", reference: "SBX-2", status: "pending" },
    price: 8,
    created_at: CREATED,
    status: "completed",
    ...o,
  })

  it("sandbox replay (same reference, same content) -> 200 replayed:true, no second sandbox charge", async () => {
    const d = makeDeps()
    d.sandbox.getOrder.mockResolvedValue(sbxPrior())
    const r = await purchaseHandler(d)(body({ recipient: "0249990423", reference: "SBX-2" }), TEST)
    expect(r.status).toBe(200)
    expect(data(r)).toMatchObject({ replayed: true, sandbox: true })
    expectOrderShape(data(r).order)
    expect(data(r).order.status).toBe("completed")
    expect(d.sandbox.place).not.toHaveBeenCalled()
    expect(d.store.listAvailablePackages).not.toHaveBeenCalled()
  })

  it("sandbox same reference with different content, or a non-data sandbox order, -> 409", async () => {
    for (const prior of [sbxPrior({ response: { network: "MTN", volume_gb: 2, recipient: "0249990423" } }), sbxPrior({ action: "airtime" })]) {
      const d = makeDeps()
      d.sandbox.getOrder.mockResolvedValue(prior)
      const r = await purchaseHandler(d)(body({ recipient: "0249990423", reference: "SBX-2" }), TEST)
      expect(r.status).toBe(409)
      expect(r.error?.message.startsWith("REFERENCE_REUSED:")).toBe(true)
      expect(d.sandbox.place).not.toHaveBeenCalled()
    }
  })

  it("sandbox insufficient test balance -> 402; duplicate-insert race re-reads and replays", async () => {
    const d = makeDeps()
    d.sandbox.place.mockResolvedValue({ success: false, error: "Insufficient test balance", status: 402 } as any)
    const r = await purchaseHandler(d)(body({ recipient: "0249990424", reference: "SBX-3" }), TEST)
    expect(r.error).toEqual({ status: 402, message: "INSUFFICIENT_BALANCE: test balance is too low; required 8.00" })

    const d2 = makeDeps()
    d2.sandbox.place.mockResolvedValue({ success: false, error: "Duplicate reference", status: 409 } as any)
    d2.sandbox.getOrder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sbxPrior({ reference: "SBX-3", response: { network: "MTN", volume_gb: 1, recipient: "0249990424" } }))
    const r2 = await purchaseHandler(d2)(body({ recipient: "0249990424", reference: "SBX-3" }), TEST)
    expect(r2.status).toBe(200)
    expect(data(r2).replayed).toBe(true)
  })
})

// ================================================================ bulk

const item = (i: number, o: Record<string, unknown> = {}) => ({
  network: "MTN",
  volume_gb: 1,
  recipient: `02499904${String(30 + i).padStart(2, "0")}`,
  reference: `BULK-${i}`,
  ...o,
})

describe("bulk (live)", () => {
  it("0 or 101 items -> 400 with no dependency call", async () => {
    for (const orders of [[], Array.from({ length: 101 }, (_, i) => item(i % 60, { reference: `B101-${i}` }))]) {
      const d = makeDeps()
      const r = await bulkHandler(d)({ orders }, LIVE)
      expect(r.status).toBe(400)
      expectNothingCalled(d)
    }
  })

  it("duplicate reference in the batch -> 400 naming the index, nothing called", async () => {
    const d = makeDeps()
    const r = await bulkHandler(d)({ orders: [item(0), item(1, { reference: "BULK-0" })] }, LIVE)
    expect(r.status).toBe(400)
    expect(r.error?.message).toContain("orders[1]")
    expectNothingCalled(d)
  })

  it("one invalid item (bad recipient, price field) -> 400 with its index, nothing called", async () => {
    for (const bad of [item(2, { recipient: "12345" }), item(2, { price: 1 })]) {
      const d = makeDeps()
      const r = await bulkHandler(d)({ orders: [item(0), item(1), bad] }, LIVE)
      expect(r.status).toBe(400)
      expect(r.error?.message).toContain("orders[2]")
      expectNothingCalled(d)
    }
  })

  it("one unavailable package or one prefix mismatch rejects the WHOLE batch 400 with the index, no charge", async () => {
    const d = makeDeps()
    const r = await bulkHandler(d)({ orders: [item(0), item(1, { network: "AT-BigTime" })] }, LIVE)
    expect(r.status).toBe(400)
    expect(r.error?.message).toBe("orders[1]: Package not found or unavailable")
    expectNoMoney(d)
    expect(d.store.getWalletBalance).not.toHaveBeenCalled()

    const d2 = makeDeps()
    const r2 = await bulkHandler(d2)({ orders: [item(0), item(1, { network: "Telecel", volume_gb: 2 })] }, LIVE)
    expect(r2.status).toBe(400)
    expect(r2.error?.message.startsWith("orders[1]: NETWORK_MISMATCH:")).toBe(true)
    expect(r2.error?.message).not.toContain("99904")
    expectNoMoney(d2)
  })

  it("an existing reference with different content rejects the whole batch 409 with the index, no charge", async () => {
    const d = makeDeps()
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([["BULK-1", row({ api_reference: "BULK-1", recipient_phone: "0249990499" })]])
    )
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, LIVE)
    expect(r.status).toBe(409)
    expect(r.error?.message.startsWith("orders[1]: REFERENCE_REUSED:")).toBe(true)
    expectNoMoney(d)
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expect(d.store.getWalletBalance).not.toHaveBeenCalled()
    expect(d.store.getOrdersByReferences).toHaveBeenCalledWith("user-1", ["BULK-0", "BULK-1"])
  })

  it("a batch whose total exceeds the balance -> 402 for the whole batch, NO placeV2Order call", async () => {
    const d = makeDeps()
    d.store.getWalletBalance.mockResolvedValue(15.99)
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, LIVE)
    expect(r.status).toBe(402)
    expect(r.error).toEqual({ status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 16.00" })
    expectNoMoney(d)
  })

  it("a balance exactly equal to the total is enough", async () => {
    const d = makeDeps()
    d.store.getWalletBalance.mockResolvedValue(16)
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r).total_charged).toBe(16)
  })

  it("no wallet row -> 402 like single purchase; failed replay lookup -> 500; no charge either way", async () => {
    const d = makeDeps()
    d.store.getWalletBalance.mockResolvedValue(null)
    const r = await bulkHandler(d)({ orders: [item(0)] }, LIVE)
    expect(r.error).toEqual({ status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 8.00" })
    expectNoMoney(d)

    const d2 = makeDeps()
    d2.store.getOrdersByReferences.mockResolvedValue(null)
    expect((await bulkHandler(d2)({ orders: [item(0)] }, LIVE)).status).toBe(500)
    expectNoMoney(d2)
    expect(d2.verifyMtn).not.toHaveBeenCalled()
  })

  it("mixed batch: places registered items, skips unregistered MTN, replays existing (charged 0), total_charged = placed only", async () => {
    const d = makeDeps()
    const A = item(0) // MTN 1GB dealer 8, registered
    const B = item(1) // MTN unregistered -> skipped
    const C = item(2) // existing same content -> replayed
    const D = item(3, { volume_gb: 2 }) // MTN 2GB, dealer_price 0 -> 18
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([["BULK-2", row({ api_reference: "BULK-2", recipient_phone: "0249990432", status: "completed" })]])
    )
    d.verifyMtn.mockImplementation(
      async (locals: string[]) => new Map<string, boolean | null>(locals.map((l) => [l, l !== "0249990431"]))
    )
    const r = await bulkHandler(d)({ orders: [A, B, C, D] }, LIVE)
    expect(r.status).toBe(200)
    // Guard sees only NEW items, once, in one batch call.
    expect(d.verifyMtn).toHaveBeenCalledTimes(1)
    expect(d.verifyMtn).toHaveBeenCalledWith(["0249990430", "0249990431", "0249990433"])
    // Balance is checked against the new, non-skipped total (8 + 18).
    expect(d.store.getWalletBalance).toHaveBeenCalledTimes(1)
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(2)
    expect(d.store.placeV2Order.mock.calls.map((c) => c[0].reference)).toEqual(["BULK-0", "BULK-3"])
    expect(d.store.placeV2Order.mock.calls.map((c) => c[0].recipientPhone)).toEqual(["0249990430", "0249990433"])
    expect(d.store.placeV2Order.mock.calls.map((c) => c[0].price)).toEqual([8, 18])
    const res = data(r)
    expect(res.results.map((x: any) => [x.reference, x.status])).toEqual([
      ["BULK-0", "placed"],
      ["BULK-2", "replayed"],
      ["BULK-3", "placed"],
    ])
    for (const x of res.results) expectOrderShape(x.order)
    expect(res.skipped).toEqual([{ reference: "BULK-1", reason: "NOT_REGISTERED" }])
    expect(res.total_charged).toBe(26)
    expect(d.schedule).toHaveBeenCalledTimes(2)
    expect(d.schedule.mock.calls.map((c) => c[0].orderId)).toEqual(["o-BULK-0", "o-BULK-3"])
    expect(JSON.stringify(res.skipped)).not.toContain("0249990431")
  })

  it("an all-replayed batch charges nothing and needs no balance read", async () => {
    const d = makeDeps()
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([["BULK-0", row({ api_reference: "BULK-0", recipient_phone: "0249990430" })]])
    )
    const r = await bulkHandler(d)({ orders: [item(0)] }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r).results).toEqual([expect.objectContaining({ reference: "BULK-0", status: "replayed" })])
    expect(data(r).total_charged).toBe(0)
    expectNoMoney(d)
    expect(d.store.getWalletBalance).not.toHaveBeenCalled()
  })

  it("a mid-batch INSUFFICIENT_BALANCE marks that item failed and continues; schedule only for placed", async () => {
    const d = makeDeps()
    d.store.placeV2Order
      .mockResolvedValueOnce(placedOk("BULK-0"))
      .mockResolvedValueOnce({ ok: false, code: "INSUFFICIENT_BALANCE", required: 8 })
      .mockResolvedValueOnce(placedOk("BULK-2"))
    const r = await bulkHandler(d)({ orders: [item(0), item(1), item(2)] }, LIVE)
    expect(r.status).toBe(200)
    const res = data(r)
    expect(res.results).toEqual([
      expect.objectContaining({ reference: "BULK-0", status: "placed" }),
      { reference: "BULK-1", status: "failed", error: "INSUFFICIENT_BALANCE" },
      expect.objectContaining({ reference: "BULK-2", status: "placed" }),
    ])
    expect(res.total_charged).toBe(16)
    expect(d.schedule).toHaveBeenCalledTimes(2)
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(3)
  })

  it("an RPC replay inside the batch is reported replayed, not charged, not scheduled; FAILED is a generic failure", async () => {
    const d = makeDeps()
    d.store.placeV2Order
      .mockResolvedValueOnce({ ok: true, replayed: true, orderId: "o-r", createdAt: CREATED, status: "pending" })
      .mockResolvedValueOnce({ ok: false, code: "FAILED" })
      .mockResolvedValueOnce({ ok: false, code: "REFERENCE_REUSED" })
    const r = await bulkHandler(d)({ orders: [item(0), item(1), item(2)] }, LIVE)
    const res = data(r)
    expect(res.results[0]).toMatchObject({ reference: "BULK-0", status: "replayed" })
    expectOrderShape(res.results[0].order)
    expect(res.results[1]).toEqual({ reference: "BULK-1", status: "failed", error: "FAILED" })
    expect(res.results[2]).toEqual({ reference: "BULK-2", status: "failed", error: "REFERENCE_REUSED" })
    expect(res.total_charged).toBe(0)
    expect(d.schedule).not.toHaveBeenCalled()
  })

  it("MTN check unavailable in bulk fails open (not skipped)", async () => {
    const d = makeDeps()
    d.verifyMtn.mockResolvedValue(new Map())
    const r = await bulkHandler(d)({ orders: [item(0)] }, LIVE)
    expect(data(r).skipped).toEqual([])
    expect(data(r).results[0].status).toBe("placed")
  })

  it("non-MTN-only batch never calls the MTN guard", async () => {
    const d = makeDeps({ prefixEnabled: false })
    await bulkHandler(d)({ orders: [item(0, { network: "Telecel", volume_gb: 2 })] }, LIVE)
    expect(d.verifyMtn).not.toHaveBeenCalled()
  })

  it("a resent batch whose package was since disabled REPLAYS the existing item instead of 400; only new items are validated", async () => {
    const d = makeDeps()
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([
        ["BULK-1", row({ api_reference: "BULK-1", network: "AT - BigTime", recipient_phone: "0249990431", price: "6" })],
      ])
    )
    const r = await bulkHandler(d)({ orders: [item(0), item(1, { network: "AT-BigTime" })] }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r).results.map((x: any) => [x.reference, x.status])).toEqual([
      ["BULK-0", "placed"],
      ["BULK-1", "replayed"],
    ])
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(1)
    expect(data(r).total_charged).toBe(8)
  })

  it("package catalog unreadable -> 503, nothing charged", async () => {
    const d = makeDeps()
    d.store.listAvailablePackages.mockResolvedValue(null)
    const r = await bulkHandler(d)({ orders: [item(0)] }, LIVE)
    expect(r.error).toEqual({ status: 503, message: "Service temporarily unavailable" })
    expectNoMoney(d)
  })

  it("an unpriced package in a batch rejects it 400 with the index", async () => {
    const d = makeDeps({ prefixEnabled: false })
    const r = await bulkHandler(d)({ orders: [item(0), item(1, { network: "Telecel", volume_gb: 3 })] }, LIVE)
    expect(r.error?.message).toBe("orders[1]: Package not found or unavailable")
    expectNoMoney(d)
  })
})

describe("bulk deadline (after() only dispatches once the response is sent)", () => {
  it("the placement deadline is 25 s, leaving most of maxDuration for the after() dispatch", () => {
    expect(BULK_DEADLINE_MS).toBe(25_000)
  })

  it("stops STARTING placements past the deadline: later items are NOT_ATTEMPTED, never placed, not charged", async () => {
    const d = makeDeps()
    // Each placement takes 0.6 of the deadline in wall clock.
    d.store.placeV2Order.mockImplementation(async (p: PlaceParams) => {
      d.clock.ms += BULK_DEADLINE_MS * 0.6
      return placedOk(p.reference)
    })
    const r = await bulkHandler(d)({ orders: [item(0), item(1), item(2), item(3)] }, LIVE)
    expect(r.status).toBe(200)
    const res = data(r)
    // t=0 start #0, t=0.6D start #1, t=1.2D > D -> stop.
    expect(d.store.placeV2Order).toHaveBeenCalledTimes(2)
    expect(d.store.placeV2Order.mock.calls.map((c) => c[0].reference)).toEqual(["BULK-0", "BULK-1"])
    expect(res.results).toEqual([
      expect.objectContaining({ reference: "BULK-0", status: "placed" }),
      expect.objectContaining({ reference: "BULK-1", status: "placed" }),
      { reference: "BULK-2", status: "failed", error: "NOT_ATTEMPTED: retry this item" },
      { reference: "BULK-3", status: "failed", error: "NOT_ATTEMPTED: retry this item" },
    ])
    expect(res.total_charged).toBe(16)
    expect(res.skipped).toEqual([])
    expect(d.schedule).toHaveBeenCalledTimes(2)
  })

  it("time spent before the loop (lookups, MTN check) counts toward the deadline; skipped is unaffected", async () => {
    const d = makeDeps()
    d.verifyMtn.mockImplementation(async (locals: string[]) => {
      d.clock.ms += BULK_DEADLINE_MS + 1_000
      return new Map<string, boolean | null>(locals.map((l) => [l, l !== "0249990431"]))
    })
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, LIVE)
    expect(d.store.placeV2Order).not.toHaveBeenCalled()
    expect(data(r).results).toEqual([{ reference: "BULK-0", status: "failed", error: "NOT_ATTEMPTED: retry this item" }])
    expect(data(r).skipped).toEqual([{ reference: "BULK-1", reason: "NOT_REGISTERED" }])
    expect(data(r).total_charged).toBe(0)
  })

  it("replayed items are still reported after the deadline", async () => {
    const d = makeDeps()
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([["BULK-1", row({ api_reference: "BULK-1", recipient_phone: "0249990431" })]])
    )
    d.store.placeV2Order.mockImplementation(async (p: PlaceParams) => {
      d.clock.ms += BULK_DEADLINE_MS + 5_000
      return placedOk(p.reference)
    })
    const r = await bulkHandler(d)({ orders: [item(0), item(1), item(2)] }, LIVE)
    expect(data(r).results.map((x: any) => x.status)).toEqual(["placed", "replayed", "failed"])
  })

  it("sandbox bulk honours the same deadline", async () => {
    const d = makeDeps()
    d.sandbox.place.mockImplementation(async (p: any) => {
      d.clock.ms += BULK_DEADLINE_MS + 5_000
      return { success: true as const, order: { ...p.orderFields, status: "pending", created_at: CREATED }, newBalance: 50 }
    })
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, TEST)
    expect(d.sandbox.place).toHaveBeenCalledTimes(1)
    expect(data(r).results[1]).toEqual({ reference: "BULK-1", status: "failed", error: "NOT_ATTEMPTED: retry this item" })
  })
})

describe("account phone gate (live purchase and bulk only)", () => {
  const BLOCK_MSG = "PHONE_NOT_VERIFIED: verify your account phone number in the dashboard to continue"

  it("single: a blocked account gets 403 and placeV2Order is never called (no MTN check either)", async () => {
    const d = makeDeps()
    d.phoneGate.mockResolvedValue({ allowed: false })
    const r = await purchaseHandler(d)(body({ recipient: "0249990480" }), LIVE)
    expect(r).toEqual({ status: 403, error: { status: 403, message: BLOCK_MSG } })
    expect(d.phoneGate).toHaveBeenCalledWith("user-1")
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expectNoMoney(d)
  })

  it("single: allowed (verified or in grace period) proceeds", async () => {
    const d = makeDeps()
    const r = await purchaseHandler(d)(body({ recipient: "0249990481" }), LIVE)
    expect(r.status).toBe(201)
    expect(d.phoneGate).toHaveBeenCalledTimes(1)
  })

  it("single: the gate throwing fails CLOSED with 403", async () => {
    const d = makeDeps()
    d.phoneGate.mockRejectedValue(new Error("db down"))
    const r = await purchaseHandler(d)(body({ recipient: "0249990482" }), LIVE)
    expect(r.status).toBe(403)
    expect(r.error?.message).toBe(BLOCK_MSG)
    expectNoMoney(d)
  })

  it("single: a replay of an existing order still answers 200 for a blocked account", async () => {
    const d = makeDeps()
    d.phoneGate.mockResolvedValue({ allowed: false })
    d.store.getOrderByReference.mockResolvedValue(row({ recipient_phone: "0249990483" }))
    const r = await purchaseHandler(d)(body({ recipient: "0249990483" }), LIVE)
    expect(r.status).toBe(200)
    expect(data(r).replayed).toBe(true)
    expectNoMoney(d)
  })

  it("bulk: a blocked account with new items gets 403, nothing placed, no MTN check, no balance read", async () => {
    const d = makeDeps()
    d.phoneGate.mockResolvedValue({ allowed: false })
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, LIVE)
    expect(r.status).toBe(403)
    expectNoMoney(d)
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expect(d.store.getWalletBalance).not.toHaveBeenCalled()
  })

  it("bulk: the gate throwing fails closed", async () => {
    const d = makeDeps()
    d.phoneGate.mockRejectedValue(new Error("x"))
    expect((await bulkHandler(d)({ orders: [item(0)] }, LIVE)).status).toBe(403)
    expectNoMoney(d)
  })

  it("bulk: an all-replay batch still answers 200 for a blocked account", async () => {
    const d = makeDeps()
    d.phoneGate.mockResolvedValue({ allowed: false })
    d.store.getOrdersByReferences.mockResolvedValue(
      new Map([["BULK-0", row({ api_reference: "BULK-0", recipient_phone: "0249990430" })]])
    )
    const r = await bulkHandler(d)({ orders: [item(0)] }, LIVE)
    expect(r.status).toBe(200)
    expect(data(r).results[0].status).toBe("replayed")
  })

  it("sandbox keys skip the gate (single and bulk), and reads never call it", async () => {
    const d = makeDeps()
    d.phoneGate.mockResolvedValue({ allowed: false })
    expect((await purchaseHandler(d)(body({ recipient: "0249990484", reference: "SBX-G" }), TEST)).status).toBe(201)
    expect((await bulkHandler(d)({ orders: [item(0)] }, TEST)).status).toBe(200)
    await listPackagesHandler(d)({}, LIVE)
    await verifyNumberHandler(d)({ network: "MTN", phone: "0249990485" }, LIVE)
    await orderLookupHandler(d)("REF-001", LIVE)
    expect(d.phoneGate).not.toHaveBeenCalled()
  })
})

describe("bulk (test key / sandbox)", () => {
  it("never touches the real store, guard or fulfillment; places through the sandbox", async () => {
    const d = makeDeps()
    d.sandbox.getOrders.mockResolvedValue(
      new Map([
        [
          "BULK-1",
          {
            reference: "BULK-1",
            action: "data_order",
            response: { network: "MTN", volume_gb: 1, recipient: "0249990431", price: 8 },
            price: 8,
            created_at: CREATED,
            status: "completed",
          },
        ],
      ])
    )
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, TEST)
    expect(r.status).toBe(200)
    // One batch query for existing sandbox orders, not one per item.
    expect(d.sandbox.getOrders).toHaveBeenCalledTimes(1)
    expect(d.sandbox.getOrders).toHaveBeenCalledWith("user-1", ["BULK-0", "BULK-1"])
    expect(d.sandbox.getOrder).not.toHaveBeenCalled()
    expectNoRealOrderOrWallet(d)
    expect(d.verifyMtn).not.toHaveBeenCalled()
    expect(d.schedule).not.toHaveBeenCalled()
    expect(d.sandbox.place).toHaveBeenCalledTimes(1)
    expect(d.sandbox.place.mock.calls[0][0]).toMatchObject({ apiV2KeyId: "key-test-1", action: "data_order", reference: "BULK-0" })
    const res = data(r)
    expect(res.sandbox).toBe(true)
    expect(res.results.map((x: any) => x.status)).toEqual(["placed", "replayed"])
    expect(res.total_charged).toBe(8)
  })

  it("sandbox batch lookup failure -> 500, no sandbox placement", async () => {
    const d = makeDeps()
    d.sandbox.getOrders.mockResolvedValue(null)
    expect((await bulkHandler(d)({ orders: [item(0)] }, TEST)).status).toBe(500)
    expect(d.sandbox.place).not.toHaveBeenCalled()
  })

  it("sandbox total over the test balance -> 402, no sandbox placement", async () => {
    const d = makeDeps()
    d.sandbox.balance.mockResolvedValue(10)
    const r = await bulkHandler(d)({ orders: [item(0), item(1)] }, TEST)
    expect(r.status).toBe(402)
    expect(d.sandbox.place).not.toHaveBeenCalled()
  })
})

// ================================================================ order lookup

describe("order lookup", () => {
  it("returns the owner's order as the seven allow-listed keys; held MTN reads queued", async () => {
    const d = makeDeps()
    d.store.getOrderByReference.mockResolvedValue({ ...row({ status: "held_registration" }), provider_reference: "x" } as any)
    const r = await orderLookupHandler(d)("REF-001", LIVE)
    expect(r.status).toBe(200)
    expect(d.store.getOrderByReference).toHaveBeenCalledWith("user-1", "REF-001")
    expectOrderShape(data(r).order)
    expect(data(r).order.status).toBe("queued")
  })

  it("missing, foreign and malformed references return the IDENTICAL 404 body", async () => {
    // Store is owner-scoped: an order owned by user-2 is invisible to user-1.
    const owned = new Map([["user-2|REF-FOREIGN", row({ api_reference: "REF-FOREIGN" })]])
    const d = makeDeps()
    d.store.getOrderByReference.mockImplementation(async (u: string, ref: string) => owned.get(`${u}|${ref}`) ?? null)
    const missing = await orderLookupHandler(d)("REF-MISSING", LIVE)
    const foreign = await orderLookupHandler(d)("REF-FOREIGN", LIVE)
    const malformed = await orderLookupHandler(d)("bad ref!", LIVE)
    expect(missing).toEqual({ status: 404, error: { status: 404, message: "Order not found" } })
    expect(foreign).toEqual(missing)
    expect(malformed).toEqual(missing)
  })

  it("test keys read only the sandbox, mapped to the same shape plus sandbox:true; non-data sandbox rows are 404", async () => {
    const d = makeDeps()
    d.sandbox.getOrder.mockResolvedValue({
      reference: "SBX-9",
      action: "data_order",
      response: { network: "AT - iShare", volume_gb: 1, price: 4.5, recipient: "0249990440", secret: "no" },
      price: 4.5,
      created_at: CREATED,
      status: "completed",
    })
    const r = await orderLookupHandler(d)("SBX-9", TEST)
    expect(r.status).toBe(200)
    expect(data(r).sandbox).toBe(true)
    expectOrderShape(data(r).order)
    expect(data(r).order).toMatchObject({ network: "AT-iShare", status: "completed", recipient: "0249990440" })
    for (const f of Object.values(d.store)) expect(f).not.toHaveBeenCalled()

    const d2 = makeDeps()
    d2.sandbox.getOrder.mockResolvedValue({
      reference: "SBX-9",
      action: "airtime",
      response: {},
      price: 1,
      created_at: CREATED,
      status: "completed",
    })
    expect(await orderLookupHandler(d2)("SBX-9", TEST)).toEqual({ status: 404, error: { status: 404, message: "Order not found" } })
  })
})

// ================================================================ verify-number

describe("verify-number", () => {
  it("Telecel (non-MTN) -> allowed:true checked:false without calling the guard", async () => {
    const d = makeDeps()
    const r = await verifyNumberHandler(d)({ network: "Telecel", phone: "0249990450" }, LIVE)
    expect(r).toEqual({ status: 200, data: { allowed: true, checked: false } })
    expect(d.verifyMtn).not.toHaveBeenCalled()
  })

  it("MTN: registered, unregistered, and unavailable (fails open)", async () => {
    const cases: Array<[boolean | null | undefined, { allowed: boolean; checked: boolean }]> = [
      [true, { allowed: true, checked: true }],
      [false, { allowed: false, checked: true }],
      [null, { allowed: true, checked: false }],
      [undefined, { allowed: true, checked: false }],
    ]
    for (const [verdict, expected] of cases) {
      const d = makeDeps()
      d.verifyMtn.mockResolvedValue(verdict === undefined ? new Map() : new Map([["0249990451", verdict]]))
      const r = await verifyNumberHandler(d)({ network: "mtn", phone: "+233249990451" }, LIVE)
      expect(r).toEqual({ status: 200, data: expected })
      expect(d.verifyMtn).toHaveBeenCalledWith(["0249990451"])
    }
  })

  it("invalid input -> 400, no guard call", async () => {
    for (const b of [{ network: "Vodafone", phone: "0249990452" }, { network: "MTN", phone: "123" }, null]) {
      const d = makeDeps()
      const r = await verifyNumberHandler(d)(b, LIVE)
      expect(r.status).toBe(400)
      expect(d.verifyMtn).not.toHaveBeenCalled()
    }
  })

  it("test keys never reach the providers", async () => {
    const d = makeDeps()
    const r = await verifyNumberHandler(d)({ network: "MTN", phone: "0249990453" }, TEST)
    expect(r).toEqual({ status: 200, data: { allowed: true, checked: false, sandbox: true } })
    expect(d.verifyMtn).not.toHaveBeenCalled()
  })
})

// ================================================================ packages

describe("packages", () => {
  it("dealer sees dealer prices (user price when dealer_price is 0), canonical networks, numeric sizes, sorted", async () => {
    const d = makeDeps()
    const r = await listPackagesHandler(d)({}, LIVE)
    expect(r.status).toBe(200)
    expect(data(r).packages).toEqual([
      { network: "AT-iShare", size_gb: 1, price: 4.5 },
      { network: "MTN", size_gb: 1, price: 8 },
      { network: "MTN", size_gb: 2, price: 18 },
      { network: "Telecel", size_gb: 2, price: 8.5 },
    ])
    expect(d.store.listAvailablePackages).toHaveBeenCalledWith(undefined)
  })

  it("a user sees user prices", async () => {
    const d = makeDeps()
    const r = await listPackagesHandler(d)({}, LIVE_USER)
    expect(data(r).packages.map((p: any) => p.price)).toEqual([5, 10, 18, 9])
  })

  it("filters by network (any accepted spelling) and size_gb", async () => {
    const d = makeDeps()
    const r = await listPackagesHandler(d)({ network: "at-ishare" }, LIVE)
    expect(d.store.listAvailablePackages).toHaveBeenCalledWith("AT - iShare")
    expect(data(r).packages).toEqual([{ network: "AT-iShare", size_gb: 1, price: 4.5 }])
    const r2 = await listPackagesHandler(d)({ size_gb: "2" }, LIVE)
    expect(data(r2).packages.map((p: any) => p.network)).toEqual(["MTN", "Telecel"])
  })

  it("invalid network or size_gb -> 400 without a store call; empty strings mean no filter", async () => {
    for (const q of [{ network: "Vodafone" }, { size_gb: "abc" }, { size_gb: "-1" }]) {
      const d = makeDeps()
      const r = await listPackagesHandler(d)(q, LIVE)
      expect(r.status).toBe(400)
      expect(d.store.listAvailablePackages).not.toHaveBeenCalled()
    }
    const d = makeDeps()
    expect((await listPackagesHandler(d)({ network: "", size_gb: null }, LIVE)).status).toBe(200)
  })

  it("catalog unreadable -> 503, never an empty list", async () => {
    const d = makeDeps()
    d.store.listAvailablePackages.mockResolvedValue(null)
    expect(await listPackagesHandler(d)({}, LIVE)).toEqual({
      status: 503,
      error: { status: 503, message: "Service temporarily unavailable" },
    })
  })

  it("drops rows with a non-numeric size or an unknown network", async () => {
    const d = makeDeps()
    d.store.listAvailablePackages.mockResolvedValue([
      ...PKGS,
      { id: "x", network: "MTN", size: "1GB", price: 1, dealer_price: null },
      { id: "y", network: "Glo", size: "1", price: 1, dealer_price: null },
    ])
    const r = await listPackagesHandler(d)({}, LIVE)
    expect(data(r).packages).toHaveLength(4)
    for (const p of data(r).packages) expect(Object.keys(p).sort()).toEqual(["network", "price", "size_gb"])
  })
})
