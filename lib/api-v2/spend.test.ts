import { describe, it, expect, vi } from "vitest"
import { createMoneySettings, reserveSpend, settleSpend, capMessage, spendGuard, guardSpend, settleOwned, MONEY_SETTINGS_TTL_MS } from "./spend"
import type { V2Context } from "./handler"

type Res = { data: unknown; error: unknown }
function settingsClient(src: () => Res | Promise<Res>) {
  let calls = 0
  const client = {
    from() {
      calls++
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => chain,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        then: (a: any, b: any) => Promise.resolve().then(src).then(a, b),
      }
      return chain
    },
  }
  return { client, calls: () => calls }
}
const row = (caps: boolean, alerts = false): Res => ({ data: { caps_enabled: caps, alerts_enabled: alerts }, error: null })

function rpcClient(res: Res | (() => never)) {
  const rpc = vi.fn(async () => (typeof res === "function" ? res() : res))
  return { rpc, client: { rpc, from: () => { throw new Error("no from") } } as never }
}

const ctx = (env: "live" | "test"): V2Context => ({ keyId: "k1", userId: "u1", role: "dealer", keyType: "standard", environment: env, firstName: null })

describe("money settings snapshot", () => {
  it("missing table (42P01/PGRST205) -> caps off, alerts off, cached for 10 s; any other error -> keep the last snapshot; no snapshot yet -> caps off (the dark default)", async () => {
    let t = 1_000_000
    for (const code of ["42P01", "PGRST205"]) {
      const f = settingsClient(() => ({ data: null, error: { code } }))
      const s = createMoneySettings({ client: f.client, now: () => t })
      expect(await s.read()).toMatchObject({ capsEnabled: false, alertsEnabled: false })
      await s.read()
      expect(f.calls()).toBe(1)
    }
    let mode: "on" | "err" = "on"
    const f = settingsClient(() => (mode === "on" ? row(true, true) : { data: null, error: { code: "57014" } }))
    const s = createMoneySettings({ client: f.client, now: () => t })
    expect(await s.read()).toMatchObject({ capsEnabled: true, alertsEnabled: true })
    mode = "err"
    t += MONEY_SETTINGS_TTL_MS + 1
    expect(await s.read()).toMatchObject({ capsEnabled: true })
    const fresh = settingsClient(() => ({ data: null, error: { code: "57014" } }))
    expect(await createMoneySettings({ client: fresh.client, now: () => t }).read()).toMatchObject({ capsEnabled: false })
  })

  it("second read inside 10 s makes zero client calls; invalidate() forces a read", async () => {
    let t = 5_000
    const f = settingsClient(() => row(true))
    const s = createMoneySettings({ client: f.client, now: () => t })
    await s.read()
    t += MONEY_SETTINGS_TTL_MS - 1
    await s.read()
    expect(f.calls()).toBe(1)
    s.invalidate()
    await s.read()
    expect(f.calls()).toBe(2)
    expect(MONEY_SETTINGS_TTL_MS).toBe(10_000)
  })

  it("a thrown client call never throws out of read()", async () => {
    const f = settingsClient(() => {
      throw new Error("boom")
    })
    await expect(createMoneySettings({ client: f.client, now: () => 1 }).read()).resolves.toMatchObject({ capsEnabled: false })
  })
})

describe("reserveSpend / settleSpend", () => {
  const p = { userId: "u1", keyId: "k1", kind: "airtime" as const, reference: "ref-1", amount: 12.5 }
  it("maps skipped, reserved, cap with scope, and rpc error/throw/bad_input to error", async () => {
    expect(await reserveSpend(rpcClient({ data: { ok: true, skipped: true }, error: null }).client, p)).toEqual({ kind: "skipped" })
    expect(await reserveSpend(rpcClient({ data: { ok: true, ledger_id: "L" }, error: null }).client, p)).toEqual({ kind: "reserved" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "cap_reached", scope: "user" }, error: null }).client, p)).toEqual({ kind: "cap", scope: "user" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "cap_reached", scope: "key" }, error: null }).client, p)).toEqual({ kind: "cap", scope: "key" })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await reserveSpend(rpcClient({ data: null, error: { code: "57014", message: "timeout" } }).client, p)).toEqual({ kind: "error" })
    expect(await reserveSpend(rpcClient({ data: { ok: false, code: "bad_input" }, error: null }).client, p)).toEqual({ kind: "error" })
    expect(await reserveSpend(rpcClient(() => { throw new Error("x") }).client, p)).toEqual({ kind: "error" })
    spy.mockRestore()
  })
  it("an existing reserved/spent row maps to 'existing' (owned by another request: the caller must never settle it)", async () => {
    expect(await reserveSpend(rpcClient({ data: { ok: true, ledger_id: "L", existing: true, state: "reserved" }, error: null }).client, p)).toEqual({ kind: "existing" })
    expect(await reserveSpend(rpcClient({ data: { ok: true, ledger_id: "L", existing: true, state: "spent" }, error: null }).client, p)).toEqual({ kind: "existing" })
  })
  it("passes the exact rpc arguments", async () => {
    const r = rpcClient({ data: { ok: true, ledger_id: "L" }, error: null })
    await reserveSpend(r.client, p)
    expect(r.rpc).toHaveBeenCalledWith("api_v2_spend_reserve", { p_user: "u1", p_key: "k1", p_kind: "airtime", p_reference: "ref-1", p_amount: 12.5 })
    const s = rpcClient({ data: { ok: true, changed: true }, error: null })
    await settleSpend(s.client, { keyId: "k1", kind: "data_bulk", reference: "b", state: "spent", amount: 4 })
    expect(s.rpc).toHaveBeenCalledWith("api_v2_spend_settle", { p_key: "k1", p_kind: "data_bulk", p_reference: "b", p_state: "spent", p_amount: 4 })
  })
  it("settleSpend swallows errors and logs only the function name and code", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(settleSpend(rpcClient({ data: null, error: { code: "57014", message: "secret detail" } }).client, { keyId: "k", kind: "data", reference: "r", state: "released" })).resolves.toBeUndefined()
    await expect(settleSpend(rpcClient(() => { throw new Error("secret") }).client, { keyId: "k", kind: "data", reference: "r", state: "released" })).resolves.toBeUndefined()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain("api_v2_spend_settle")
    expect(logged).not.toContain("secret")
    spy.mockRestore()
  })
})

describe("guardSpend / settleOwned (request-path helpers)", () => {
  const hook = (reserve: ReserveResultLike, caps = true) => {
    const h = {
      settings: vi.fn(async () => ({ capsEnabled: caps, alertsEnabled: false, at: 0 })),
      reserve: vi.fn(async () => reserve),
      settle: vi.fn(async () => {}),
    }
    return h
  }
  type ReserveResultLike = Awaited<ReturnType<typeof reserveSpend>>
  it("no hook, test key, or caps off -> proceed, not owned, reserve never called", async () => {
    expect(await guardSpend(undefined, ctx("live"), "airtime", "R", 5)).toEqual({ proceed: true, owned: false })
    const h1 = hook({ kind: "reserved" })
    expect(await guardSpend(h1, ctx("test"), "airtime", "R", 5)).toEqual({ proceed: true, owned: false })
    const h2 = hook({ kind: "reserved" }, false)
    expect(await guardSpend(h2, ctx("live"), "airtime", "R", 5)).toEqual({ proceed: true, owned: false })
    expect(h1.reserve).not.toHaveBeenCalled()
    expect(h2.reserve).not.toHaveBeenCalled()
  })
  it("reserved -> owned; existing/skipped -> proceed, not owned; reserve gets user, key, kind, reference, amount", async () => {
    const h = hook({ kind: "reserved" })
    expect(await guardSpend(h, ctx("live"), "bill", "R", 12.5)).toEqual({ proceed: true, owned: true })
    expect(h.reserve).toHaveBeenCalledWith({ userId: "u1", keyId: "k1", kind: "bill", reference: "R", amount: 12.5 })
    expect(await guardSpend(hook({ kind: "existing" }), ctx("live"), "bill", "R", 1)).toEqual({ proceed: true, owned: false })
    expect(await guardSpend(hook({ kind: "skipped" }), ctx("live"), "bill", "R", 1)).toEqual({ proceed: true, owned: false })
  })
  it("cap -> 402 with the scope's message; error -> 503; never proceed", async () => {
    const k = await guardSpend(hook({ kind: "cap", scope: "key" }), ctx("live"), "afa", "R", 1)
    expect(k).toEqual({ proceed: false, result: { status: 402, error: { status: 402, message: capMessage("key") } } })
    const u = await guardSpend(hook({ kind: "cap", scope: "user" }), ctx("live"), "afa", "R", 1)
    expect(u).toEqual({ proceed: false, result: { status: 402, error: { status: 402, message: capMessage("user") } } })
    const e = await guardSpend(hook({ kind: "error" }), ctx("live"), "afa", "R", 1)
    expect(e).toMatchObject({ proceed: false, result: { status: 503 } })
  })
  it("a settings read that throws -> treated as caps off (never blocks, never reserves)", async () => {
    const h = hook({ kind: "reserved" })
    h.settings.mockRejectedValueOnce(new Error("x"))
    expect(await guardSpend(h, ctx("live"), "data", "R", 1)).toEqual({ proceed: true, owned: false })
    expect(h.reserve).not.toHaveBeenCalled()
  })
  it("settleOwned settles only when owned", async () => {
    const h = hook({ kind: "reserved" })
    await settleOwned(h, false, ctx("live"), "data", "R", "spent")
    expect(h.settle).not.toHaveBeenCalled()
    await settleOwned(h, true, ctx("live"), "data", "R", "released")
    expect(h.settle).toHaveBeenCalledWith({ keyId: "k1", kind: "data", reference: "R", state: "released" })
    await settleOwned(h, true, ctx("live"), "data_bulk", "B", "spent", 4)
    expect(h.settle).toHaveBeenLastCalledWith({ keyId: "k1", kind: "data_bulk", reference: "B", state: "spent", amount: 4 })
  })
})

describe("capMessage / spendGuard", () => {
  it("capMessage('key') starts with the code and names 00:00 GMT; capMessage('user') adds the Datagod line and no digits beyond the time", () => {
    const k = capMessage("key")
    expect(k.startsWith("DAILY_LIMIT_REACHED: ")).toBe(true)
    expect(k).toContain("00:00 GMT")
    const u = capMessage("user")
    expect(u.startsWith("DAILY_LIMIT_REACHED: ")).toBe(true)
    expect(u).toContain("A Datagod limit applies.")
    expect(u.replace("00:00", "")).not.toMatch(/\d/)
  })
  it("spendGuard: test key -> false; live key with caps off -> false; live with caps on -> true", () => {
    const on = { capsEnabled: true, alertsEnabled: false, at: 0 }
    const off = { capsEnabled: false, alertsEnabled: false, at: 0 }
    expect(spendGuard(ctx("test"), on)).toBe(false)
    expect(spendGuard(ctx("live"), off)).toBe(false)
    expect(spendGuard(ctx("live"), on)).toBe(true)
  })
})
