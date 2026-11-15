import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { nextState, recheckBlockedNumbers, type RecheckDeps } from "./recheck"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const DAY = 86_400_000

describe("nextState", () => {
  it("false at count 0 schedules +1 day", () => {
    expect(nextState({ recheck_count: 0 }, false, null, NOW)).toEqual({
      recheck_count: 1,
      next_recheck_at: new Date(NOW.getTime() + DAY).toISOString(),
      last_rechecked_at: NOW.toISOString(),
    })
  })
  it("false at count 6 schedules +7 days (count 5 is still +1 day)", () => {
    expect(nextState({ recheck_count: 6 }, false, null, NOW)).toEqual({
      recheck_count: 7,
      next_recheck_at: new Date(NOW.getTime() + 7 * DAY).toISOString(),
      last_rechecked_at: NOW.toISOString(),
    })
    expect(nextState({ recheck_count: 5 }, false, null, NOW)?.next_recheck_at).toBe(new Date(NOW.getTime() + DAY).toISOString())
  })
  it("true flips to allowed with the approving provider", () => {
    expect(nextState({ recheck_count: 2 }, true, "agentportalgh", NOW)).toEqual({
      status: "allowed",
      allowed_at: NOW.toISOString(),
      allowed_by: "agentportalgh",
    })
  })
  it("null leaves the row untouched", () => {
    expect(nextState({ recheck_count: 2 }, null, null, NOW)).toBeNull()
  })
})

type Filter = [string, ...unknown[]]
type Rec = { filters: Filter[]; limit?: number; patch?: Record<string, unknown> }
type Row = { id: string; phone: string; recheck_count: number }

function makeDeps(rows: Row[], verdictFor: (phone: string) => boolean | null, approvedBy = "prov") {
  const updates: Rec[] = []
  const selects: Rec[] = []
  const chain = (rec: Rec, result: () => unknown) => {
    const q: any = {
      eq: (...a: unknown[]) => (rec.filters.push(["eq", ...a]), q),
      in: (...a: unknown[]) => (rec.filters.push(["in", ...a]), q),
      lt: (...a: unknown[]) => (rec.filters.push(["lt", ...a]), q),
      lte: (...a: unknown[]) => (rec.filters.push(["lte", ...a]), q),
      order: (...a: unknown[]) => (rec.filters.push(["order", ...a]), q),
      limit: (n: number) => ((rec.limit = n), q),
      select: () => q,
      then: (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res),
    }
    return q
  }
  const db = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const rec: Rec = { filters: [], patch }
        updates.push(rec)
        const isExpire = patch.status === "expired"
        return chain(rec, () => ({ data: isExpire ? [{ id: "x1" }, { id: "x2" }] : null, error: null }))
      },
      select: () => {
        const rec: Rec = { filters: [] }
        selects.push(rec)
        return chain(rec, () => ({ data: rows, error: null }))
      },
    }),
  } as unknown as SupabaseClient
  const chunks: string[][] = []
  const setCache = vi.fn(async () => {})
  const deps: RecheckDeps = {
    db,
    now: () => NOW,
    getSettings: async () => ({ enabled: true, providers: ["p1", "p2"], block_unverified: true }),
    registry: [],
    detailed: async (phones) =>
      phones.map((phone) => ({ phone, verified: verdictFor(phone) === true, approvedBy: verdictFor(phone) === true ? approvedBy : null })),
    resolve: async (phones, io) => {
      chunks.push(phones)
      const settings = await io.settings()
      const d = await io.check(phones, [], settings)
      return new Map(phones.map((p) => [p, verdictFor(p) === null ? null : d.find((x) => x.phone === p)!.verified]))
    },
    setCache,
  }
  return { deps, updates, selects, chunks, setCache }
}

describe("recheckBlockedNumbers", () => {
  it("expires first, then selects due blocked rows with limit 2000", async () => {
    const { deps, updates, selects } = makeDeps([], () => false)
    const r = await recheckBlockedNumbers({}, deps)
    expect(updates[0].patch).toMatchObject({ status: "expired" })
    expect(updates[0].filters).toContainEqual(["eq", "status", "blocked"])
    expect(updates[0].filters).toContainEqual(["lt", "expires_at", NOW.toISOString()])
    expect(selects[0].limit).toBe(2000)
    expect(selects[0].filters).toContainEqual(["in", "status", ["blocked"]])
    expect(selects[0].filters).toContainEqual(["lte", "next_recheck_at", NOW.toISOString()])
    expect(r.expired).toBe(2)
  })

  it("all-null verdicts write nothing and count as unchecked", async () => {
    const rows = [
      { id: "a", phone: "0241111111", recheck_count: 0 },
      { id: "b", phone: "0242222222", recheck_count: 0 },
    ]
    const { deps, updates, setCache } = makeDeps(rows, () => null)
    const r = await recheckBlockedNumbers({}, deps)
    expect(updates.filter((c) => c.patch?.status !== "expired")).toHaveLength(0)
    expect(setCache).not.toHaveBeenCalled()
    expect(r).toMatchObject({ checked: 0, allowed: 0, stillBlocked: 0, unchecked: 2, newlyAllowedIds: [] })
  })

  it("allowed phone flips, primes the verdict cache with the checkout providers, and stamps updated_at", async () => {
    const rows = [
      { id: "a", phone: "0241111111", recheck_count: 0 },
      { id: "b", phone: "0242222222", recheck_count: 3 },
    ]
    const { deps, updates, setCache } = makeDeps(rows, (p) => p === "0241111111")
    const r = await recheckBlockedNumbers({}, deps)
    expect(setCache).toHaveBeenCalledWith(new Map([["0241111111", true]]), ["p1", "p2"])
    const flip = updates.find((c) => c.patch?.status === "allowed")!
    expect(flip.patch).toMatchObject({ allowed_by: "prov", allowed_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(flip.filters).toContainEqual(["in", "id", ["a"]])
    const still = updates.find((c) => c.patch?.recheck_count === 4)!
    expect(still.patch).toMatchObject({ updated_at: NOW.toISOString() })
    expect(still.filters).toContainEqual(["in", "id", ["b"]])
    expect(r).toMatchObject({ checked: 2, allowed: 1, stillBlocked: 1, unchecked: 0, newlyAllowedIds: ["a"] })
  })

  it("ids + reopenExpired includes expired rows and skips the due filter", async () => {
    const { deps, selects } = makeDeps([], () => false)
    await recheckBlockedNumbers({ ids: ["a", "b"], reopenExpired: true }, deps)
    expect(selects[0].filters).toContainEqual(["in", "status", ["blocked", "expired"]])
    expect(selects[0].filters).toContainEqual(["in", "id", ["a", "b"]])
    expect(selects[0].filters.some((f) => f[0] === "lte" && f[1] === "next_recheck_at")).toBe(false)
  })

  it("sends the resolver chunks of at most 500", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => ({
      id: `id${i}`,
      phone: `024${String(i).padStart(7, "0")}`,
      recheck_count: 0,
    }))
    const { deps, chunks } = makeDeps(rows, () => false)
    await recheckBlockedNumbers({}, deps)
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 100])
  })
})
