import { describe, it, expect, vi } from "vitest"
import { budgetedClient, lookupBudget, rotatingSlice, HUBNET_CRON_LOOKUP_BUDGET } from "./run-budget"

describe("lookupBudget", () => {
  it("allows n takes, then refuses", () => {
    const b = lookupBudget(2)
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(true)
    expect(b.take()).toBe(false)
    expect(b.left).toBe(0)
  })
  it("a rate_limited result stops the rest of the run", () => {
    const b = lookupBudget(5)
    b.take()
    b.note({ kind: "rate_limited", retryAfterSec: 60 })
    expect(b.stopped).toBe(true)
    expect(b.take()).toBe(false)
  })
  it("other results do not stop it", () => {
    const b = lookupBudget(3)
    b.note({ kind: "missing" })
    b.note({ kind: "unknown" })
    expect(b.take()).toBe(true)
  })
  it("defaults to the cron budget", () => {
    const b = lookupBudget()
    let n = 0
    while (b.take()) n++
    expect(n).toBe(HUBNET_CRON_LOOKUP_BUDGET)
  })
})

describe("budgetedClient", () => {
  it("passes lookups through until spent, then answers rate_limited without calling Hubnet", async () => {
    const getStatus = vi.fn(async (_ref: string) => ({ kind: "missing" as const }))
    const c = budgetedClient({ getStatus }, lookupBudget(2))
    expect((await c.getStatus("a")).kind).toBe("missing")
    expect((await c.getStatus("b")).kind).toBe("missing")
    expect((await c.getStatus("c")).kind).toBe("rate_limited")
    expect(getStatus).toHaveBeenCalledTimes(2)
  })
  it("stops after Hubnet's own 429", async () => {
    const getStatus = vi.fn(async (_ref: string) => ({ kind: "rate_limited" as const, retryAfterSec: 60 }))
    const c = budgetedClient({ getStatus }, lookupBudget(5))
    await c.getStatus("a")
    await c.getStatus("b")
    expect(getStatus).toHaveBeenCalledTimes(1)
  })
  it("keeps the client's other methods", async () => {
    const getBalance = vi.fn(async () => 5)
    const c = budgetedClient({ getStatus: vi.fn(), getBalance } as any, lookupBudget(1))
    expect(await (c as any).getBalance()).toBe(5)
  })
})

describe("rotatingSlice", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
  it("returns everything when it fits", () => {
    expect(rotatingSlice([1, 2], 8, 3)).toEqual([1, 2])
  })
  it("walks the backlog across runs and wraps", () => {
    expect(rotatingSlice(items, 4, 0)).toEqual([0, 1, 2, 3])
    expect(rotatingSlice(items, 4, 1)).toEqual([4, 5, 6, 7])
    expect(rotatingSlice(items, 4, 2)).toEqual([8, 9, 0, 1])
  })
  it("covers every item within a few runs", () => {
    const seen = new Set<number>()
    for (let run = 0; run < 3; run++) rotatingSlice(items, 4, run).forEach((x) => seen.add(x))
    expect(seen.size).toBe(items.length)
  })
})
