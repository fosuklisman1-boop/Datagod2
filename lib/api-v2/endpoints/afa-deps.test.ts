import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
const checkPhoneVerified = vi.hoisted(() => vi.fn())
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified }))
const submitAfaOrder = vi.hoisted(() => vi.fn(async () => ({ order: {} })))
vi.mock("@/lib/afa-fulfillment", () => ({ submitAfaOrder }))
const notifyAdmins = vi.hoisted(() => vi.fn(async () => {}))
vi.mock("@/lib/sms-service", () => ({ notifyAdmins }))
vi.mock("../store", async (orig) => ({ ...(await orig<typeof import("../store")>()), getAdminClient: () => ({ fake: true }) }))

import {
  AFA_ORDER_COLUMNS,
  fetchAfaOrderByCode,
  fetchAfaOrdersByCodes,
  fetchAfaPrice,
  findRecentAfaDuplicate,
  realAfaAlert,
  realAfaEngine,
} from "./afa-deps"

// Unique test phones for this file: 0249991050-0249991059.
type Call = [string, ...unknown[]]

function fakeClient(result: { data: unknown; error?: unknown } | "throw") {
  const calls: Call[] = []
  const q: any = {}
  const settle = () => (result === "throw" ? Promise.reject(new Error("db")) : Promise.resolve({ error: null, ...result }))
  for (const m of ["select", "eq", "neq", "gte", "or", "in", "order", "limit"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.maybeSingle = () => settle()
  q.then = (res: any, rej: any) => settle().then(res, rej)
  return {
    client: { from: (t: string) => (calls.push(["from", t]), q) } as any,
    calls,
  }
}

describe("afa order reads", () => {
  it("select only the allow-listed columns, owner-scoped, newest match first, limit 1", async () => {
    const { client, calls } = fakeClient({ data: [{ order_code: "AFA-1" }] })
    expect(await fetchAfaOrderByCode(client, "u1", "AFA-1")).toEqual({ order_code: "AFA-1" })
    expect(calls).toContainEqual(["from", "afa_orders"])
    expect(calls).toContainEqual(["select", AFA_ORDER_COLUMNS])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["eq", "order_code", "AFA-1"])
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }])
    expect(calls).toContainEqual(["limit", 1])
    expect(AFA_ORDER_COLUMNS.split(",").map((s) => s.trim()).sort()).toEqual(
      ["amount", "created_at", "fulfillment_status", "full_name", "order_code", "phone_number", "region", "status"]
    )
    expect(AFA_ORDER_COLUMNS).not.toContain("gh_card_number")
  })

  it("single read: null on empty / error / throw", async () => {
    expect(await fetchAfaOrderByCode(fakeClient({ data: [] }).client, "u1", "x")).toBeNull()
    expect(await fetchAfaOrderByCode(fakeClient({ data: null, error: { message: "x" } }).client, "u1", "x")).toBeNull()
    expect(await fetchAfaOrderByCode(fakeClient("throw").client, "u1", "x")).toBeNull()
  })

  it("batch read: ONE owner-scoped .in() of at most 30 codes, newest first; null on error", async () => {
    const { client, calls } = fakeClient({ data: [] })
    const codes = Array.from({ length: 40 }, (_, i) => `AFA-${i}`)
    await fetchAfaOrdersByCodes(client, "u1", codes)
    const inCalls = calls.filter((c) => c[0] === "in")
    expect(inCalls).toHaveLength(1)
    expect((inCalls[0][2] as string[]).length).toBe(30)
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }])
    expect(await fetchAfaOrdersByCodes(client, "u1", [])).toEqual([])
    expect(await fetchAfaOrdersByCodes(fakeClient({ data: null, error: { message: "x" } }).client, "u1", ["a"])).toBeNull()
    expect(await fetchAfaOrdersByCodes(fakeClient("throw").client, "u1", ["a"])).toBeNull()
  })
})

describe("duplicate guard query", () => {
  const PHONE = "0249991050"
  const CARD = "GHA-123456789-0"
  const SINCE = "2026-10-26T09:50:00.000Z"
  const dup = (rows: unknown[], phone = PHONE, card = CARD) => findRecentAfaDuplicate(fakeClient({ data: rows }).client, "u1", phone, card, SINCE)

  it("queries ONLY by user and window (non-failed, newest first, limit 200), selecting just phone + card; neither value is in the query", async () => {
    const { client, calls } = fakeClient({ data: [] })
    expect(await findRecentAfaDuplicate(client, "u1", PHONE, CARD, SINCE)).toBe(false)
    expect(calls).toContainEqual(["from", "afa_orders"])
    expect(calls).toContainEqual(["select", "phone_number, gh_card_number"])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["neq", "status", "failed"])
    expect(calls).toContainEqual(["gte", "created_at", SINCE])
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }])
    expect(calls).toContainEqual(["limit", 200])
    // no .or() / phone / card filter: nothing sensitive reaches the PostgREST query string
    expect(calls.some((c) => c[0] === "or")).toBe(false)
    const serialised = JSON.stringify(calls)
    expect(serialised).not.toContain("123456789")
    expect(serialised).not.toContain("0249991050")
    expect(serialised).not.toContain("233249991050")
  })

  it("matches the phone in memory in every stored form, or the card, for this window's rows", async () => {
    for (const stored of ["0249991050", "233249991050", "+233249991050", "+233 24 999 1050", "024 999 1050"]) {
      expect(await dup([{ phone_number: stored, gh_card_number: "GHA-000000001-1" }])).toBe(true)
    }
    for (const card of ["GHA-123456789-0", "gha-123456789-0", "1234567890", " GHA-123456789-0 "]) {
      expect(await dup([{ phone_number: "0249991099", gh_card_number: card }])).toBe(true)
    }
  })

  it("does not match a different phone and a different card, or empty/odd rows", async () => {
    expect(await dup([{ phone_number: "0249991099", gh_card_number: "GHA-987654321-1" }])).toBe(false)
    expect(await dup([{ phone_number: null, gh_card_number: null }, {}, null as any])).toBe(false)
    expect(await dup([])).toBe(false)
  })

  it("no rows => false; an error or throw rejects (the handler fails closed)", async () => {
    expect(await findRecentAfaDuplicate(fakeClient({ data: [] }).client, "u1", "0249991051", "GHA-123456789-0", "x")).toBe(false)
    await expect(findRecentAfaDuplicate(fakeClient({ data: null, error: { message: "x" } }).client, "u1", "0249991051", "c", "x")).rejects.toThrow()
    await expect(findRecentAfaDuplicate(fakeClient("throw").client, "u1", "0249991051", "c", "x")).rejects.toThrow()
  })
})

describe("engine, alert, price", () => {
  it("passes the engine params through unchanged", async () => {
    const p = { userId: "u1", fullName: "A B", phoneNumber: "0249991052", ghCardNumber: "GHA-123456789-0", location: "X", region: "Volta" }
    await realAfaEngine(p)
    expect(submitAfaOrder).toHaveBeenCalledWith(p)
  })

  it("alert type afa_review, never throws", async () => {
    await realAfaAlert("m")
    expect(notifyAdmins).toHaveBeenCalledWith("m", "afa_review", undefined, false)
    notifyAdmins.mockRejectedValueOnce(new Error("down"))
    await expect(realAfaAlert("m")).resolves.toBeUndefined()
  })

  it("price reads the active default row and throws when unavailable", async () => {
    const { client, calls } = fakeClient({ data: { price: "15.5" } })
    expect(await fetchAfaPrice(client)).toBe(15.5)
    expect(calls).toContainEqual(["from", "afa_registration_prices"])
    expect(calls).toContainEqual(["eq", "is_active", true])
    expect(calls).toContainEqual(["eq", "name", "default"])
    await expect(fetchAfaPrice(fakeClient({ data: null }).client)).rejects.toThrow()
    await expect(fetchAfaPrice(fakeClient({ data: { price: "0" } }).client)).rejects.toThrow()
  })
})
