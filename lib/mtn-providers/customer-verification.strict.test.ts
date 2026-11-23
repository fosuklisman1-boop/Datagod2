import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (t: any) => afterMock.fn(t) }))
vi.mock("@/lib/blocked-numbers/record", () => ({ recordBlockedRecipients: vi.fn(async () => ({ recorded: 0, deduped: 0 })) }))

const afterMock = vi.hoisted(() => ({ fn: (() => { throw new Error("outside request scope") }) as any }))
const state = vi.hoisted(() => ({
  on: true,
  fresh: new Map<string, Map<string, "yes" | "no">>(),
  saved: [] as Array<{ phone: string; supplier: string; verdict: string }>,
}))
vi.mock("@/lib/strict-verify/settings", () => ({ isStrictVerifyOn: vi.fn(async () => state.on) }))
vi.mock("@/lib/strict-verify/verdicts", () => ({
  getFreshVerdicts: vi.fn(async (_db: unknown, phone: string) => state.fresh.get(phone) ?? new Map()),
  saveVerdicts: vi.fn(async (_db: unknown, rows: Array<{ phone: string; supplier: string; verdict: string }>) => { state.saved.push(...rows) }),
}))

import { verifyRecipientsForOrder } from "./customer-verification"
import type { WhitelistEntry } from "./provider-whitelist"

const PHONE = "0551111111"
function dbWith(disabled: string[] | "error") {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => (disabled === "error" ? { data: null, error: { message: "x" } } : { data: { value: { providers: disabled } }, error: null }) }) }) }),
  } as never
}
const calls: string[] = []

function entry(name: string, answer: boolean | "throw" | "missing" | "echo233"): WhitelistEntry {
  const batch = async (m: string[]) => {
    calls.push(name)
    if (answer === "throw") throw new Error("down")
    if (answer === "missing") return []
    if (answer === "echo233") return m.map((x) => ({ msisdn: "233" + x.slice(1), allowed: true }))
    return m.map((x) => ({ msisdn: x, allowed: answer }))
  }
  return { name, configured: () => true, check: async () => ({ allowed: true, provider: name }), checkBatch: batch, checkBatchStrict: batch }
}

const settings = (providers: string[]) => ({ enabled: true, providers, block_unverified: true })

function run(registry: WhitelistEntry[], opts: Record<string, unknown> = {}) {
  const deferred: Array<() => Promise<unknown>> = []
  const ask = vi.fn(async (_s: string, _p: string) => "yes" as "yes" | "no" | "no_answer")
  const p = verifyRecipientsForOrder([PHONE], {
    registry,
    settings: settings(registry.map((r) => r.name)),
    strictDb: dbWith([]),
    defer: (t: () => Promise<unknown>) => { deferred.push(t) },
    ask,
    ...opts,
  } as never)
  return { p, deferred, ask }
}

describe("verifyRecipientsForOrder strict recording", () => {
  beforeEach(() => {
    state.on = true
    state.fresh.clear()
    state.saved.length = 0
    calls.length = 0
  })

  it("first supplier yes: returns without asking the second, saves the yes, defers the second", async () => {
    const { p, deferred, ask } = run([entry("a", true), entry("b", true)])
    const r = await p
    expect(r.blocked).toEqual([])
    expect(calls).toEqual(["a"])
    expect(state.saved).toEqual([{ phone: PHONE, supplier: "a", verdict: "yes" }])
    expect(ask).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
    await deferred[0]()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0].slice(0, 2)).toEqual(["b", PHONE])
    expect(state.saved).toContainEqual({ phone: PHONE, supplier: "b", verdict: "yes" })
  })

  it("does not wait for the deferred task", async () => {
    const { p } = run([entry("a", true), entry("b", true)], { ask: () => new Promise(() => {}) })
    await expect(p).resolves.toBeTruthy()
  })

  it("saves the definite no from the main check and blocks as today (no/no)", async () => {
    const { p, deferred, ask } = run([entry("a", false), entry("b", false)])
    const r = await p
    expect(r.blocked).toEqual([PHONE])
    expect(state.saved).toEqual([
      { phone: PHONE, supplier: "a", verdict: "no" },
      { phone: PHONE, supplier: "b", verdict: "no" },
    ])
    await deferred[0]?.()
    expect(ask).not.toHaveBeenCalled()
  })

  it("no_answer/no_answer: nothing saved, never blocks, both asked in the background", async () => {
    const { p, deferred, ask } = run([entry("a", "throw"), entry("b", "throw")])
    vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await p
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get(PHONE)).toBeNull()
    expect(state.saved).toEqual([])
    await deferred[0]()
    expect(ask.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"])
  })

  it("matches a supplier echoing 233 format", async () => {
    const { p } = run([entry("a", "echo233")])
    await p
    expect(state.saved).toEqual([{ phone: PHONE, supplier: "a", verdict: "yes" }])
  })

  it("does not re-ask a supplier with a fresh saved verdict", async () => {
    state.fresh.set(PHONE, new Map([["b", "no"]]))
    const { p, deferred, ask } = run([entry("a", true), entry("b", true)])
    await p
    await deferred[0]()
    expect(ask).not.toHaveBeenCalled()
  })

  it("saves only definite answers from the background task", async () => {
    const { p, deferred, ask } = run([entry("a", true), entry("b", true), entry("c", true)])
    ask.mockImplementation(async (s: string) => (s === "b" ? "no" : "no_answer"))
    await p
    await deferred[0]()
    expect(state.saved).toContainEqual({ phone: PHONE, supplier: "b", verdict: "no" })
    expect(state.saved.find((x) => x.supplier === "c")).toBeUndefined()
  })

  it("switch off: no save, no defer, nothing asked", async () => {
    state.on = false
    const { p, deferred, ask } = run([entry("a", true), entry("b", true)])
    await p
    expect(state.saved).toEqual([])
    expect(deferred).toHaveLength(0)
    expect(ask).not.toHaveBeenCalled()
  })

  it("a throwing deferred task never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const { p, deferred } = run([entry("a", true), entry("b", true)], { ask: async () => { throw new Error(PHONE) } })
    await p
    await expect(deferred[0]()).resolves.toBeUndefined()
    expect(JSON.stringify(spy.mock.calls)).not.toContain(PHONE)
  })
})

describe("strict background limits", () => {
  beforeEach(() => { state.on = true; state.fresh.clear(); state.saved.length = 0; calls.length = 0 })

  it("production path: returns before the after() task runs", async () => {
    const captured: Array<() => Promise<unknown>> = []
    afterMock.fn = (t: () => Promise<unknown>) => { captured.push(t) }
    try {
      const ask = vi.fn(async () => "yes" as const)
      const r = await verifyRecipientsForOrder([PHONE], { registry: [entry("a", true), entry("b", true)], settings: settings(["a", "b"]), strictDb: dbWith([]), ask } as never)
      expect(r.blocked).toEqual([])
      expect(captured).toHaveLength(1)
      expect(ask).not.toHaveBeenCalled()
      expect(state.saved).toEqual([])
      await captured[0]()
      expect(ask).toHaveBeenCalledTimes(1)
      expect(state.saved).toContainEqual({ phone: PHONE, supplier: "a", verdict: "yes" })
    } finally {
      afterMock.fn = () => { throw new Error("outside request scope") }
    }
  })

  it("asks at most 20 phones, 3 at a time, saving after each phone", async () => {
    const phones = Array.from({ length: 30 }, (_, i) => "05511111" + String(10 + i))
    let active = 0
    let peak = 0
    const asked = new Set<string>()
    const ask = vi.fn(async (_s: string, p: string) => { active++; peak = Math.max(peak, active); asked.add(p); await new Promise((r) => setTimeout(r, 2)); active--; return "yes" as const })
    const deferred: Array<() => Promise<unknown>> = []
    await verifyRecipientsForOrder(phones, { registry: [entry("a", "throw")], settings: settings(["a"]), strictDb: dbWith([]), ask, defer: (t: () => Promise<unknown>) => { deferred.push(t) } } as never)
    state.saved.length = 0
    await deferred[0]()
    expect(asked.size).toBe(20)
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
    expect(state.saved).toHaveLength(20)
  })

  it("stops asking hubnet after its first no_answer", async () => {
    const phones = ["0551111101", "0551111102", "0551111103", "0551111104"]
    const ask = vi.fn(async (s: string) => (s === "hubnet" ? "no_answer" : "yes") as "yes" | "no_answer")
    const deferred: Array<() => Promise<unknown>> = []
    await verifyRecipientsForOrder(phones, { registry: [entry("hubnet", "throw")], settings: settings(["hubnet"]), strictDb: dbWith([]), ask, defer: (t: () => Promise<unknown>) => { deferred.push(t) } } as never)
    await deferred[0]()
    expect(ask.mock.calls.filter((c) => c[0] === "hubnet").length).toBeLessThanOrEqual(3)
  })

  it("skips disabled suppliers; unreadable disabled list asks nobody", async () => {
    for (const [db, expected] of [[dbWith(["b"]), ["a"]], [dbWith("error"), []]] as const) {
      const ask = vi.fn(async () => "yes" as const)
      const deferred: Array<() => Promise<unknown>> = []
      await verifyRecipientsForOrder([PHONE], { registry: [entry("a", "throw"), entry("b", "throw")], settings: settings(["a", "b"]), strictDb: db, ask, defer: (t: () => Promise<unknown>) => { deferred.push(t) } } as never)
      await deferred[0]()
      expect(ask.mock.calls.map((c: any[]) => c[0])).toEqual(expected)
    }
  })

  it("saves main-check answers only in the deferred task, not on the response path", async () => {
    const deferred: Array<() => Promise<unknown>> = []
    await verifyRecipientsForOrder([PHONE], { registry: [entry("a", true)], settings: settings(["a"]), strictDb: dbWith([]), ask: async () => "yes", defer: (t: () => Promise<unknown>) => { deferred.push(t) } } as never)
    expect(state.saved).toEqual([])
    await deferred[0]()
    expect(state.saved).toContainEqual({ phone: PHONE, supplier: "a", verdict: "yes" })
  })
})
