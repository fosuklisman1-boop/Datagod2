import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => { throw new Error("outside request scope") } }))
vi.mock("@/lib/blocked-numbers/record", () => ({ recordBlockedRecipients: vi.fn(async () => ({ recorded: 0, deduped: 0 })) }))

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
    strictDb: {} as never,
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
