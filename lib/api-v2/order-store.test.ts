import { describe, it, expect, vi } from "vitest"
import { storageRecipient, placeV2Order, getOrderByReference, getWalletBalance, listAvailablePackages, purchaseDescription } from "./order-store"

const P = {
  userId: "u1",
  apiV2KeyId: "k1",
  packageId: "pkg1",
  dbNetwork: "AT - iShare",
  gb: 2,
  price: 9.5,
  recipientPhone: "0249990301",
  reference: "REF-1",
  description: "API data purchase: AT-iShare 2GB (ref REF-1)",
}

function rpcClient(result: { data?: unknown; error?: unknown } | Error) {
  const rpc = vi.fn(async () => {
    if (result instanceof Error) throw result
    return { data: result.data ?? null, error: result.error ?? null }
  })
  return { rpc, from: vi.fn() } as any
}

describe("placeV2Order", () => {
  it("passes exactly the nine RPC parameters and nothing else", async () => {
    const c = rpcClient({ data: { success: true, replayed: false, order_id: "o1", new_balance: 5, created_at: "t" } })
    await placeV2Order(c, { ...P, extra: "nope" } as any)
    expect(c.rpc).toHaveBeenCalledWith("place_api_v2_order", {
      p_user_id: "u1",
      p_api_v2_key_id: "k1",
      p_package_id: "pkg1",
      p_network: "AT - iShare",
      p_volume_gb: 2,
      p_price: 9.5,
      p_recipient_phone: "0249990301",
      p_api_reference: "REF-1",
      p_description: P.description,
    })
  })

  it("refuses a 233 msisdn or any non-local recipient without calling the RPC", async () => {
    for (const bad of ["233249990302", "+233249990302", "249990302", "0149990302", "", "0249990302\n"]) {
      const c = rpcClient({ data: { success: true, replayed: false, order_id: "o1", new_balance: 5, created_at: "t" } })
      expect(await placeV2Order(c, { ...P, recipientPhone: bad })).toEqual({ ok: false, code: "FAILED" })
      expect(c.rpc).not.toHaveBeenCalled()
    }
  })

  it("storageRecipient is the local form", () => {
    expect(storageRecipient({ local: "0249990303" })).toBe("0249990303")
  })

  it("maps success", async () => {
    const c = rpcClient({ data: { success: true, replayed: false, order_id: "o1", new_balance: 5.5, created_at: "t" } })
    expect(await placeV2Order(c, P)).toEqual({ ok: true, replayed: false, orderId: "o1", createdAt: "t", newBalance: 5.5 })
  })

  it("maps replay", async () => {
    const c = rpcClient({ data: { success: true, replayed: true, order_id: "o1", status: "completed", created_at: "t" } })
    expect(await placeV2Order(c, P)).toEqual({ ok: true, replayed: true, orderId: "o1", createdAt: "t", status: "completed" })
  })

  it("maps insufficient balance", async () => {
    const c = rpcClient({ data: { success: false, error: "Insufficient balance", required: 9.5, balance: 1 } })
    expect(await placeV2Order(c, P)).toEqual({ ok: false, code: "INSUFFICIENT_BALANCE", required: 9.5, balance: 1 })
  })

  it("maps reference reused", async () => {
    const c = rpcClient({ data: { success: false, error: "Reference reused with a different order", code: "REFERENCE_REUSED" } })
    expect(await placeV2Order(c, P)).toEqual({ ok: false, code: "REFERENCE_REUSED" })
  })

  it("maps wallet missing", async () => {
    const c = rpcClient({ data: { success: false, error: "Wallet not found" } })
    expect(await placeV2Order(c, P)).toEqual({ ok: false, code: "WALLET_NOT_FOUND" })
  })

  it("maps the generic failure and unknown errors to FAILED", async () => {
    expect(await placeV2Order(rpcClient({ data: { success: false, error: "Order could not be placed" } }), P)).toEqual({ ok: false, code: "FAILED" })
    expect(await placeV2Order(rpcClient({ data: { success: false, error: "something else" } }), P)).toEqual({ ok: false, code: "FAILED" })
  })

  it("never throws: transport error, thrown error, malformed JSON all become FAILED", async () => {
    const failed = { ok: false, code: "FAILED" }
    expect(await placeV2Order(rpcClient({ error: { message: "boom" } }), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient(new Error("network down")), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient({ data: null }), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient({ data: "garbage" }), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient({ data: [] }), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient({ data: {} }), P)).toEqual(failed)
    expect(await placeV2Order(rpcClient({ data: { success: true, replayed: false } }), P)).toEqual(failed)
  })
})

function chain(result: any) {
  const calls: Array<[string, ...unknown[]]> = []
  const q: any = {}
  for (const m of ["select", "eq", "order", "limit"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, ...a])
      return q
    }
  }
  q.maybeSingle = async () => {
    calls.push(["maybeSingle"])
    return result
  }
  q.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej)
  return { q, calls }
}

describe("getOrderByReference", () => {
  const row = { api_reference: "REF-1", network: "MTN", volume_gb: 1, price: 5, recipient_phone: "0249990201", status: "pending", created_at: "t" }

  it("filters on both user_id and api_reference and selects only the allow-listed columns", async () => {
    const { q, calls } = chain({ data: row, error: null })
    const client = { from: vi.fn(() => q) } as any
    const r = await getOrderByReference(client, "u1", "REF-1")
    expect(r).toEqual(row)
    expect(client.from).toHaveBeenCalledWith("api_orders")
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
    expect(calls).toContainEqual(["eq", "api_reference", "REF-1"])
    const sel = calls.find((c) => c[0] === "select")![1] as string
    expect(sel.split(",").map((s) => s.trim())).toEqual([
      "api_reference",
      "network",
      "volume_gb",
      "price",
      "recipient_phone",
      "status",
      "created_at",
    ])
    for (const banned of ["provider_reference", "error_message", "api_key_id", "id,", "*"]) expect(sel).not.toContain(banned)
  })

  it("returns null when absent or on error, and never throws", async () => {
    expect(await getOrderByReference({ from: () => chain({ data: null, error: null }).q } as any, "u1", "x")).toBeNull()
    expect(await getOrderByReference({ from: () => chain({ data: null, error: { message: "e" } }).q } as any, "u1", "x")).toBeNull()
    expect(await getOrderByReference({ from: () => { throw new Error("x") } } as any, "u1", "x")).toBeNull()
  })

  it("strips extra columns defensively", async () => {
    const { q } = chain({ data: { ...row, provider_reference: "p", id: "i" }, error: null })
    const r = await getOrderByReference({ from: () => q } as any, "u1", "REF-1")
    expect(Object.keys(r!).sort()).toEqual(Object.keys(row).sort())
  })
})

describe("getWalletBalance", () => {
  it("returns a number", async () => {
    const { q, calls } = chain({ data: { balance: "12.50" }, error: null })
    const client = { from: vi.fn(() => q) } as any
    expect(await getWalletBalance(client, "u1")).toBe(12.5)
    expect(client.from).toHaveBeenCalledWith("wallets")
    expect(calls).toContainEqual(["select", "balance"])
    expect(calls).toContainEqual(["eq", "user_id", "u1"])
  })
  it("returns null when missing, non-numeric, or on error", async () => {
    expect(await getWalletBalance({ from: () => chain({ data: null, error: null }).q } as any, "u1")).toBeNull()
    expect(await getWalletBalance({ from: () => chain({ data: { balance: null }, error: null }).q } as any, "u1")).toBeNull()
    expect(await getWalletBalance({ from: () => chain({ data: { balance: "abc" }, error: null }).q } as any, "u1")).toBeNull()
    expect(await getWalletBalance({ from: () => chain({ data: null, error: { message: "e" } }).q } as any, "u1")).toBeNull()
    expect(await getWalletBalance({ from: () => { throw new Error("x") } } as any, "u1")).toBeNull()
  })
})

describe("listAvailablePackages", () => {
  const rows = [
    { id: "a", network: "MTN", size: "10", price: "20", dealer_price: "18" },
    { id: "b", network: "MTN", size: "2", price: 5, dealer_price: null },
    { id: "c", network: "AT - iShare", size: "1", price: 3, dealer_price: 0 },
    { id: "d", network: "MTN", size: "1", price: 2, dealer_price: null },
  ]

  it("filters is_available, sorts by network then numeric size, coerces prices", async () => {
    const { q, calls } = chain({ data: rows, error: null })
    const client = { from: vi.fn(() => q) } as any
    const out = await listAvailablePackages(client)
    expect(client.from).toHaveBeenCalledWith("packages")
    expect(calls).toContainEqual(["eq", "is_available", true])
    expect(out.map((p) => p.id)).toEqual(["c", "d", "b", "a"])
    expect(out[3]).toEqual({ id: "a", network: "MTN", size: "10", price: 20, dealer_price: 18 })
    expect(out[2].dealer_price).toBeNull()
  })

  it("filters by network case-insensitively when given", async () => {
    const { q } = chain({ data: rows, error: null })
    const out = await listAvailablePackages({ from: () => q } as any, "mtn")
    expect(out.map((p) => p.id)).toEqual(["d", "b", "a"])
    const { q: q2 } = chain({ data: rows, error: null })
    expect((await listAvailablePackages({ from: () => q2 } as any, "AT - ISHARE")).map((p) => p.id)).toEqual(["c"])
  })

  it("returns [] on error", async () => {
    expect(await listAvailablePackages({ from: () => chain({ data: null, error: { message: "e" } }).q } as any)).toEqual([])
    expect(await listAvailablePackages({ from: () => { throw new Error("x") } } as any)).toEqual([])
  })
})

describe("purchaseDescription", () => {
  it("contains only network, size and reference", () => {
    expect(purchaseDescription("MTN", 1, "ABC123")).toBe("API data purchase: MTN 1GB (ref ABC123)")
    const d = purchaseDescription("AT-iShare", 2.5, "REF-9")
    expect(d).toBe("API data purchase: AT-iShare 2.5GB (ref REF-9)")
    // The helper takes no recipient at all, so none can appear in the text.
    expect(d).not.toMatch(/[0-9]{9,}/)
  })
})
