import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/hubtel-cs/runtime", () => ({ getHubtelCsRuntime: vi.fn() }))
vi.mock("@/lib/network-prefix-config", () => ({ getPrefixValidationConfig: vi.fn() }))

import { buildBundlesDeps, getBundlesAvailability, listUserDataOrders, pickOrder } from "./runtime"

function fakeDb(result: { data?: any; error?: any }, configValue?: any) {
  const calls: { fn: string; args: any[] }[] = []
  const chain: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "then") return (res: any) => res({ data: result.data ?? null, error: result.error ?? null })
      return (...args: any[]) => { calls.push({ fn: prop, args }); return chain }
    },
  })
  const db: any = {
    from: (t: string) => { calls.push({ fn: "from", args: [t] }); return t === "admin_settings" ? cfgChain(configValue) : chain },
    rpc: async (name: string, args: any) => { calls.push({ fn: "rpc", args: [name, args] }); return { data: result.data ?? null, error: result.error ?? null } },
  }
  return { db, calls }
}
const cfgChain = (value: any): any => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value }, error: null }) }) }),
})
const parts = (db: any) => ({ db, getConfig: async () => ({ enabled: true, paused: false, services: {} }), client: { query: vi.fn(), purchase: vi.fn() } as any })
const prefix = async () => ({ enabled: true, map: {} as any })
const deps = (db: any) => buildBundlesDeps(parts(db), "sek", async () => {}, prefix)

describe("debitOrder", () => {
  it("calls data_order_debit with p_order_id and passes through ok/insufficient/not_found", async () => {
    for (const v of ["ok", "insufficient", "not_found"] as const) {
      const { db, calls } = fakeDb({ data: v })
      expect(await deps(db).debitOrder("o1")).toBe(v)
      expect(calls.find(c => c.fn === "rpc")!.args).toEqual(["data_order_debit", { p_order_id: "o1" }])
    }
  })
  it("throws on RPC error and on an unexpected result", async () => {
    await expect(deps(fakeDb({ error: { message: "x" } }).db).debitOrder("o1")).rejects.toBeTruthy()
    await expect(deps(fakeDb({ data: "weird" }).db).debitOrder("o1")).rejects.toThrow()
  })
})

describe("order store wiring", () => {
  it("updateOrder guards with .in(status), sets updated_at, returns row count", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "o1" }] })
    expect(await deps(db).updateOrder("o1", { status: "failed" }, ["pending"])).toBe(1)
    expect(calls.find(c => c.fn === "in")!.args).toEqual(["status", ["pending"]])
    expect(typeof calls.find(c => c.fn === "update")!.args[0].updated_at).toBe("string")
  })
  it("updateOrder without guard; 0 rows -> 0", async () => {
    const { db, calls } = fakeDb({ data: [] })
    expect(await deps(db).updateOrder("o1", { notes: "n" })).toBe(0)
    expect(calls.some(c => c.fn === "in")).toBe(false)
  })
  it("insertOrder re-throws the supabase error object (code 23505 preserved)", async () => {
    const err = { code: "23505", message: "dup" }
    await expect(deps(fakeDb({ error: err }).db).insertOrder({} as any)).rejects.toBe(err)
  })
  it("getOrder / findOrderByIdempotencyKey: null when none, throw on error, filter by user + key", async () => {
    expect(await deps(fakeDb({ data: null }).db).getOrder("o1")).toBeNull()
    await expect(deps(fakeDb({ error: { message: "x" } }).db).getOrder("o1")).rejects.toBeTruthy()
    const { db, calls } = fakeDb({ data: { id: "o1" } })
    expect(await deps(db).findOrderByIdempotencyKey("u1", "key-12345")).toEqual({ id: "o1" })
    expect(calls.filter(c => c.fn === "eq").map(c => c.args)).toEqual([["user_id", "u1"], ["idempotency_key", "key-12345"]])
    await expect(deps(fakeDb({ error: { message: "x" } }).db).findOrderByIdempotencyKey("u1", "k")).rejects.toBeTruthy()
  })
  it("newReference is SB- + 12 hex uppercase; secret, now and prefix reader wired", async () => {
    const d = deps(fakeDb({}).db)
    expect(d.newReference()).toMatch(/^SB-[0-9A-F]{12}$/)
    expect(d.secret).toBe("sek")
    expect(typeof d.now()).toBe("number")
    expect(d.getPrefixConfig).toBe(prefix)
  })
})

describe("getBundlesAvailability", () => {
  const hubOn = (over: Partial<{ enabled: boolean; paused: boolean; services: Record<string, boolean> }> = {}) =>
    async () => ({ enabled: true, paused: false, services: { data_mtn: true, data_telecel: true, data_at: true }, ...over })
  it("returns only enabled networks with labels when master is on", async () => {
    const { db } = fakeDb({}, { enabled: true, networks: { MTN: { enabled: true }, TELECEL: { enabled: false }, AT: { enabled: true } } })
    expect(await getBundlesAvailability(db, hubOn())).toEqual({
      enabled: true, networks: [{ network: "MTN", label: "MTN" }, { network: "AT", label: "AT" }],
    })
  })
  it("labels Telecel", async () => {
    const { db } = fakeDb({}, { enabled: true, networks: { TELECEL: { enabled: true } } })
    const a = await getBundlesAvailability(db, hubOn())
    expect(a.networks.find(n => n.network === "TELECEL")?.label).toBe("Telecel")
  })
  it("is disabled when master is off, and never throws on a read error", async () => {
    const { db } = fakeDb({}, { enabled: false, networks: { MTN: { enabled: true } } })
    expect(await getBundlesAvailability(db, hubOn())).toEqual({ enabled: false, networks: [] })
    const bad: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: new Error("boom") }) }) }) }) }
    expect(await getBundlesAvailability(bad, hubOn())).toEqual({ enabled: false, networks: [] })
  })
  it("M4: requires Hubtel enabled and the network's data_* service on; a pause does not hide it; never throws", async () => {
    const cfg = { enabled: true, networks: { MTN: { enabled: true }, TELECEL: { enabled: true }, AT: { enabled: true } } }
    expect(await getBundlesAvailability(fakeDb({}, cfg).db, hubOn({ enabled: false }))).toEqual({ enabled: false, networks: [] })
    expect(await getBundlesAvailability(fakeDb({}, cfg).db, hubOn({ services: { data_mtn: true, data_telecel: false } })))
      .toEqual({ enabled: true, networks: [{ network: "MTN", label: "MTN" }] })
    expect(await getBundlesAvailability(fakeDb({}, cfg).db, hubOn({ services: {} }))).toEqual({ enabled: false, networks: [] })
    expect((await getBundlesAvailability(fakeDb({}, cfg).db, hubOn({ paused: true }))).networks).toHaveLength(3)
    expect(await getBundlesAvailability(fakeDb({}, cfg).db, async () => { throw new Error("db") })).toEqual({ enabled: false, networks: [] })
  })
})

describe("listUserDataOrders / pickOrder", () => {
  it("filters by caller, newest first, limit 50, explicit columns without secrets", async () => {
    const { db, calls } = fakeDb({ data: [{ id: "o1" }] })
    expect(await listUserDataOrders(db, "u1")).toEqual([{ id: "o1" }])
    expect(calls.find(c => c.fn === "eq")!.args).toEqual(["user_id", "u1"])
    expect(calls.find(c => c.fn === "order")!.args).toEqual(["created_at", { ascending: false }])
    expect(calls.find(c => c.fn === "limit")!.args).toEqual([50])
    const cols = calls.find(c => c.fn === "select")!.args[0] as string
    for (const bad of ["*", "notes", "user_id", "idempotency_key", "hubtel_client_reference"]) expect(cols).not.toContain(bad)
    await expect(listUserDataOrders(fakeDb({ error: { message: "x" } }).db, "u1")).rejects.toBeTruthy()
  })
  it("pickOrder returns only the allow-listed fields", () => {
    const row: any = { id: "i", reference_code: "SB-1", network: "MTN", bundle_display: "1GB", amount: 5, beneficiary_phone: "233240000000", status: "failed", payment_status: "paid", created_at: "t", notes: "raw hubtel", user_id: "u", idempotency_key: "k" }
    expect(Object.keys(pickOrder(row)).sort()).toEqual(
      ["amount", "beneficiary_phone", "bundle_display", "cashback", "created_at", "faceAmount", "id", "network", "paidAmount", "payment_status", "reference_code", "status"],
    )
  })
  it("pickOrder price fields: no cashback => paid = face, cashback 0; cashback => stored paid_amount + cashback_amount", () => {
    const base: any = { id: "i", amount: 10, paid_amount: null, cashback_amount: null }
    expect(pickOrder(base)).toMatchObject({ amount: 10, faceAmount: 10, paidAmount: 10, cashback: 0 })
    expect(pickOrder({ ...base, paid_amount: 9.8, cashback_amount: 0.2 })).toMatchObject({ amount: 10, faceAmount: 10, paidAmount: 9.8, cashback: 0.2 })
  })
})

describe("cashback wiring", () => {
  const usersDb = (role: string | null, error: any = null): any => ({
    from: (t: string) => t === "users"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: role === null ? null : { role }, error }) }) }) }
      : cfgChain({ enabled: true, surfaces: { dashboard: true } }),
  })
  it("getBuyerTier: dealer and sub_agent => dealer; anything else => customer; read error throws", async () => {
    expect(await deps(usersDb("dealer")).getBuyerTier("u1")).toBe("dealer")
    expect(await deps(usersDb("sub_agent")).getBuyerTier("u1")).toBe("dealer")
    expect(await deps(usersDb("user")).getBuyerTier("u1")).toBe("customer")
    expect(await deps(usersDb(null)).getBuyerTier("u1")).toBe("customer")
    await expect(deps(usersDb(null, { message: "x" })).getBuyerTier("u1")).rejects.toBeTruthy()
  })
  it("getCashbackConfig reads and resolves admin_settings", async () => {
    const c = await deps(usersDb(null)).getCashbackConfig()
    expect(c.enabled).toBe(true)
    expect(c.surfaces.dashboard).toBe(true)
  })
})
