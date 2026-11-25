import { describe, it, expect, vi } from "vitest"
import { setDeveloperCap, getKeySpend, parseCapInput } from "./spend-caps"

const U = "11111111-1111-4111-8111-111111111111"
const K = "22222222-2222-4222-8222-222222222222"

function client(o: { rpc?: Record<string, unknown>; rpcError?: unknown; key?: { user_id: string; environment: string } | null } = {}) {
  const rpc = vi.fn(async (fn: string) => ({ data: o.rpc?.[fn] ?? null, error: o.rpcError ?? null }))
  const c = {
    rpc,
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: o.key === undefined ? { user_id: U, environment: "live" } : o.key, error: null }) }
      return chain
    },
  }
  return { c: c as never, rpc }
}

describe("parseCapInput", () => {
  it("null or empty means no limit; positive numbers up to 1000000 with at most 2 decimals; anything else refused", () => {
    expect(parseCapInput(null)).toEqual({ ok: true, cap: null })
    expect(parseCapInput("")).toEqual({ ok: true, cap: null })
    expect(parseCapInput(25)).toEqual({ ok: true, cap: 25 })
    expect(parseCapInput("12.50")).toEqual({ ok: true, cap: 12.5 })
    for (const bad of [0, -1, 1000001, "abc", 12.345, NaN, Infinity, [], {}, true]) expect(parseCapInput(bad).ok).toBe(false)
  })
  it("gate fix: ordinary two-decimal amounts are accepted despite floating point (19.99, 1.15, 0.29, 4.35, 999999.99)", () => {
    for (const [v, want] of [[19.99, 19.99], ["19.99", 19.99], [1.15, 1.15], [0.29, 0.29], [4.35, 4.35], ["999999.99", 999999.99], [0.01, 0.01]] as const) {
      expect(parseCapInput(v)).toEqual({ ok: true, cap: want })
    }
    expect(parseCapInput("1e3").ok).toBe(false)
    expect(parseCapInput(0.001).ok).toBe(false)
    expect(parseCapInput(12.345).ok).toBe(false)
  })
})

describe("setDeveloperCap", () => {
  it("bad key id or bad cap -> 400 before any rpc", async () => {
    const { c, rpc } = client()
    expect((await setDeveloperCap(c, { userId: U, keyId: "nope", cap: 5 })).status).toBe(400)
    expect((await setDeveloperCap(c, { userId: U, keyId: K, cap: -1 })).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })
  it("defence in depth: someone else's key -> 404 and a test key -> 400 BEFORE any write rpc (SQL checks too)", async () => {
    const theirs = client({ key: { user_id: "33333333-3333-4333-8333-333333333333", environment: "live" } })
    expect((await setDeveloperCap(theirs.c, { userId: U, keyId: K, cap: 20 })).status).toBe(404)
    expect(theirs.rpc).not.toHaveBeenCalled()
    const missing = client({ key: null })
    expect((await setDeveloperCap(missing.c, { userId: U, keyId: K, cap: 20 })).status).toBe(404)
    const test = client({ key: { user_id: U, environment: "test" } })
    expect((await setDeveloperCap(test.c, { userId: U, keyId: K, cap: 20 })).status).toBe(400)
    expect(test.rpc).not.toHaveBeenCalled()
  })
  it("calls the key-scope rpc with the session user as actor; maps not_found 404, not_live 400", async () => {
    const ok = client({ rpc: { api_v2_set_spend_cap: { ok: true, changed: true } } })
    const r = await setDeveloperCap(ok.c, { userId: U, keyId: K, cap: 20 })
    expect(r).toEqual({ status: 200, body: { ok: true, changed: true } })
    expect(ok.rpc).toHaveBeenCalledWith("api_v2_set_spend_cap", { p_scope: "key", p_scope_id: K, p_cap: 20, p_actor: U })
    expect((await setDeveloperCap(client({ rpc: { api_v2_set_spend_cap: { ok: false, code: "not_found" } } }).c, { userId: U, keyId: K, cap: 20 })).status).toBe(404)
    expect((await setDeveloperCap(client({ rpc: { api_v2_set_spend_cap: { ok: false, code: "not_live" } } }).c, { userId: U, keyId: K, cap: 20 })).status).toBe(400)
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await setDeveloperCap(client({ rpcError: { code: "57014", message: "x" } }).c, { userId: U, keyId: K, cap: 20 })).status).toBe(500)
    spy.mockRestore()
  })
})

describe("getKeySpend", () => {
  const today = { user: { spent: 12, cap: 50 }, keys: [{ key_id: K, spent: 7.5, cap: 30 }], refusals_today: 0 }
  it("someone else's key -> 404; a test key -> 400; never touches the spend rpc", async () => {
    const theirs = client({ key: { user_id: "33333333-3333-4333-8333-333333333333", environment: "live" }, rpc: { api_v2_spend_today: today } })
    expect((await getKeySpend(theirs.c, { userId: U, keyId: K, capsActive: true })).status).toBe(404)
    expect((await getKeySpend(client({ key: null }).c, { userId: U, keyId: K, capsActive: true })).status).toBe(404)
    const test = client({ key: { user_id: U, environment: "test" } })
    expect((await getKeySpend(test.c, { userId: U, keyId: K, capsActive: true })).status).toBe(400)
    expect(test.rpc).not.toHaveBeenCalled()
  })
  it("returns spent today, the developer's own cap, whether a Datagod limit applies and whether caps are active; never the admin cap value", async () => {
    const { c } = client({ rpc: { api_v2_spend_today: today } })
    const r = await getKeySpend(c, { userId: U, keyId: K, capsActive: false })
    expect(r).toEqual({ status: 200, body: { spentToday: 7.5, cap: 30, adminLimitApplies: true, active: false } })
    expect(JSON.stringify(r.body)).not.toContain("50")
  })
})
