import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
const checkPhoneVerified = vi.hoisted(() => vi.fn())
vi.mock("@/lib/phone-verify-guard", () => ({ checkPhoneVerified }))
const purchaseAirtime = vi.hoisted(() => vi.fn())
vi.mock("@/lib/airtime-service", () => ({ purchaseAirtime }))

import {
  AIRTIME_ORDER_COLUMNS,
  fetchAirtimeOrderByCode,
  fetchAirtimeOrdersByCodes,
  realAirtimeEngine,
  realAirtimePhoneGate,
} from "./airtime-deps"

// Unique test phones for this file: 0249990650-0249990659.

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

describe("airtime order reads", () => {
  it("select only the allow-listed columns", () => {
    expect(AIRTIME_ORDER_COLUMNS.split(",").map((s) => s.trim()).sort()).toEqual(
      ["airtime_amount", "beneficiary_phone", "cashback_amount", "created_at", "fee_amount", "network", "reference_code", "status", "total_paid"]
    )
  })

  it("single read is owner-scoped and returns null on missing/error/throw", async () => {
    const { client, calls } = fakeClient({ data: { reference_code: "AT-1" }, error: null })
    expect(await fetchAirtimeOrderByCode(client, "u1", "AT-1")).toEqual({ reference_code: "AT-1" })
    expect(calls).toContainEqual(["from", "airtime_orders"])
    expect(calls).toContainEqual(["select", AIRTIME_ORDER_COLUMNS])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["eq", "reference_code", "AT-1"])
    expect(await fetchAirtimeOrderByCode(fakeClient({ data: null, error: null }).client, "u1", "AT-1")).toBeNull()
    expect(await fetchAirtimeOrderByCode(fakeClient({ data: null, error: { message: "e" } }).client, "u1", "AT-1")).toBeNull()
    expect(await fetchAirtimeOrderByCode(fakeClient("throw").client, "u1", "AT-1")).toBeNull()
  })

  it("batch read is one owner-scoped .in() of at most 30 codes; null on error", async () => {
    const { client, calls } = fakeClient({ data: [{ reference_code: "AT-1" }], error: null })
    const codes = Array.from({ length: 35 }, (_, i) => `AT-${i}`)
    expect(await fetchAirtimeOrdersByCodes(client, "u1", codes)).toEqual([{ reference_code: "AT-1" }])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    const inCall = calls.find((c) => c[0] === "in")!
    expect(inCall[1]).toBe("reference_code")
    expect(inCall[2]).toHaveLength(30)
    expect(calls.filter((c) => c[0] === "from")).toHaveLength(1)
    expect(await fetchAirtimeOrdersByCodes(fakeClient({ data: null, error: { message: "e" } }).client, "u1", ["A"])).toBeNull()
    expect(await fetchAirtimeOrdersByCodes(fakeClient("throw").client, "u1", ["A"])).toBeNull()
    const empty = fakeClient({ data: [], error: null })
    expect(await fetchAirtimeOrdersByCodes(empty.client, "u1", [])).toEqual([])
    expect(empty.calls).toHaveLength(0)
  })
})

describe("realAirtimeEngine", () => {
  it("calls purchaseAirtime with channel api, paySeparately false and NO shopId", async () => {
    purchaseAirtime.mockReset().mockResolvedValue({ order: {}, newBalance: 1 })
    await realAirtimeEngine({
      userId: "u1",
      network: "MTN",
      beneficiaryPhone: "0249990650",
      airtimeAmount: 5.1,
      paySeparately: false,
      channel: "api",
      // a stray field must not be forwarded
      ...({ shopId: "shop-1" } as object),
    } as any)
    expect(purchaseAirtime).toHaveBeenCalledWith({
      userId: "u1",
      network: "MTN",
      beneficiaryPhone: "0249990650",
      airtimeAmount: 5.1,
      paySeparately: false,
      channel: "api",
    })
    expect(purchaseAirtime.mock.calls[0][0]).not.toHaveProperty("shopId")
  })

  it("forwards expectedPay when given and lets engine errors propagate", async () => {
    const err: any = new Error("x")
    err.code = "INSUFFICIENT_BALANCE"
    purchaseAirtime.mockReset().mockRejectedValue(err)
    await expect(
      realAirtimeEngine({ userId: "u1", network: "AT", beneficiaryPhone: "0269990651", airtimeAmount: 2, paySeparately: false, channel: "api", expectedPay: 2.1 })
    ).rejects.toBe(err)
    expect(purchaseAirtime.mock.calls[0][0].expectedPay).toBe(2.1)
  })
})

describe("realAirtimePhoneGate", () => {
  it("only allowed === true passes; a block or a throw is false (fail closed)", async () => {
    checkPhoneVerified.mockReset().mockResolvedValue({ allowed: true })
    expect(await realAirtimePhoneGate({}, "u1")).toBe(true)
    checkPhoneVerified.mockReset().mockResolvedValue({ allowed: false, reason: "unverified" })
    expect(await realAirtimePhoneGate({}, "u1")).toBe(false)
    checkPhoneVerified.mockReset().mockResolvedValue({ allowed: "yes" })
    expect(await realAirtimePhoneGate({}, "u1")).toBe(false)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    checkPhoneVerified.mockReset().mockRejectedValue(new Error("db down for 0249990652"))
    expect(await realAirtimePhoneGate({}, "u1")).toBe(false)
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("9990652")
    spy.mockRestore()
  })
})
