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
type Rec = { filters: Filter[]; limit?: number; patch?: Record<string, unknown>; cols?: string }
type Row = { id: string; phone: string; recheck_count: number; status?: string }

type Opts = {
  expireIds?: string[]
  failFlip?: boolean
  clock?: () => number
}

function makeDeps(rows: Row[], verdictFor: (phone: string) => boolean | null, o: Opts = {}) {
  const updates: Rec[] = []
  const selects: Rec[] = []
  const chain = (rec: Rec, result: () => unknown) => {
    const q: any = {
      eq: (...a: unknown[]) => (rec.filters.push(["eq", ...a]), q),
      in: (...a: unknown[]) => (rec.filters.push(["in", ...a]), q),
      lt: (...a: unknown[]) => (rec.filters.push(["lt", ...a]), q),
      lte: (...a: unknown[]) => (rec.filters.push(["lte", ...a]), q),
      or: (...a: unknown[]) => (rec.filters.push(["or", ...a]), q),
      order: (...a: unknown[]) => (rec.filters.push(["order", ...a]), q),
      limit: (n: number) => ((rec.limit = n), q),
      select: () => q,
      then: (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res),
    }
    return q
  }
  const idsOf = (rec: Rec) => (rec.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[]) ?? []
  const db = {
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        const rec: Rec = { filters: [], patch }
        updates.push(rec)
        return chain(rec, () => {
          if (patch.status === "allowed" && o.failFlip) return { data: null, error: { code: "XX" } }
          return { data: idsOf(rec).map((id) => ({ id })), error: null }
        })
      },
      select: (cols: string) => {
        const rec: Rec = { filters: [], cols }
        selects.push(rec)
        return chain(rec, () => ({ data: cols === "id" ? (o.expireIds ?? []).map((id) => ({ id })) : rows, error: null }))
      },
    }),
  } as unknown as SupabaseClient
  const chunks: string[][] = []
  const setCache = vi.fn(async () => {})
  const deps: RecheckDeps = {
    db,
    now: () => NOW,
    clock: o.clock ?? (() => 0),
    getSettings: async () => ({ enabled: true, providers: ["p1", "p2"], block_unverified: true }),
    getBlockedSettings: async () => ({ retention_days: 30 }),
    registry: [],
    detailed: async (phones) =>
      phones.map((phone) => ({ phone, verified: verdictFor(phone) === true, approvedBy: verdictFor(phone) === true ? "prov" : null })),
    resolve: async (phones, io) => {
      chunks.push(phones)
      const settings = await io.settings()
      const d = await io.check(phones, [], settings)
      return new Map(phones.map((p) => [p, verdictFor(p) === null ? null : d.find((x) => x.phone === p)!.verified]))
    },
    setCache,
  }
  const due = () => selects.find((s) => s.cols !== "id")!
  return { deps, updates, selects, chunks, setCache, due }
}

const r = (id: string, phone: string, recheck_count = 0, status = "blocked"): Row => ({ id, phone, recheck_count, status })

describe("recheckBlockedNumbers", () => {
  it("expire step: bounded id select (limit 2000), then guarded chunked updates, before the due select", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => `e${i}`)
    const { deps, updates, selects, due } = makeDeps([], () => false, { expireIds: ids })
    const res = await recheckBlockedNumbers({}, deps)
    expect(selects[0].cols).toBe("id")
    expect(selects[0].limit).toBe(2000)
    expect(selects[0].filters).toContainEqual(["eq", "status", "blocked"])
    expect(selects[0].filters).toContainEqual(["lt", "expires_at", NOW.toISOString()])
    expect(updates.map((u) => idsOf(u).length)).toEqual([500, 500, 200])
    expect(updates[0].patch).toEqual({ status: "expired", updated_at: NOW.toISOString() })
    expect(updates[0].filters).toContainEqual(["eq", "status", "blocked"])
    expect(selects.indexOf(due())).toBeGreaterThan(0)
    expect(due().limit).toBe(2000)
    expect(due().filters).toContainEqual(["in", "status", ["blocked"]])
    expect(due().filters).toContainEqual(["lte", "next_recheck_at", NOW.toISOString()])
    expect(res.expired).toBe(1200)
  })

  it("all-null verdicts write nothing and count as unchecked", async () => {
    const { deps, updates, setCache } = makeDeps([r("a", "0241111111"), r("b", "0242222222")], () => null)
    const res = await recheckBlockedNumbers({}, deps)
    expect(updates).toHaveLength(0)
    expect(setCache).not.toHaveBeenCalled()
    expect(res).toMatchObject({ checked: 0, allowed: 0, stillBlocked: 0, unchecked: 2, newlyAllowedIds: [] })
  })

  it("allowed phone flips, primes the verdict cache with the checkout providers, and stamps updated_at", async () => {
    const { deps, updates, setCache } = makeDeps([r("a", "0241111111"), r("b", "0242222222", 3)], (p) => p === "0241111111")
    const res = await recheckBlockedNumbers({}, deps)
    expect(setCache).toHaveBeenCalledWith(new Map([["0241111111", true]]), ["p1", "p2"])
    const flip = updates.find((c) => c.patch?.status === "allowed")!
    expect(flip.patch).toMatchObject({ allowed_by: "prov", allowed_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(flip.filters).toContainEqual(["in", "id", ["a"]])
    const still = updates.find((c) => c.patch?.recheck_count === 4)!
    expect(still.patch).toMatchObject({ updated_at: NOW.toISOString() })
    expect(still.patch).not.toHaveProperty("status")
    expect(still.filters).toContainEqual(["in", "id", ["b"]])
    expect(res).toMatchObject({ checked: 2, allowed: 1, stillBlocked: 1, unchecked: 0, newlyAllowedIds: ["a"] })
  })

  it("a failing flip write is not counted, not in newlyAllowedIds, and the cache is not warmed", async () => {
    const { deps, setCache } = makeDeps([r("a", "0241111111")], () => true, { failFlip: true })
    const res = await recheckBlockedNumbers({}, deps)
    expect(res).toMatchObject({ allowed: 0, checked: 0, unchecked: 1, newlyAllowedIds: [] })
    expect(setCache).not.toHaveBeenCalled()
  })

  it("ids + reopenExpired includes expired rows and skips the due filter", async () => {
    const { deps, due } = makeDeps([], () => false)
    await recheckBlockedNumbers({ ids: ["a", "b"], reopenExpired: true }, deps)
    expect(due().filters).toContainEqual(["in", "status", ["blocked", "expired"]])
    expect(due().filters).toContainEqual(["in", "id", ["a", "b"]])
    expect(due().filters.some((f) => f[0] === "lte" && f[1] === "next_recheck_at")).toBe(false)
  })

  it("all + reopenExpired selects due blocked OR expired rows, limit 2000, ordered by next_recheck_at", async () => {
    const { deps, due } = makeDeps([], () => false)
    await recheckBlockedNumbers({ all: true, reopenExpired: true }, deps)
    expect(due().filters).toContainEqual(["or", `and(status.eq.blocked,next_recheck_at.lte.${NOW.toISOString()}),status.eq.expired`])
    expect(due().filters.some((f) => f[0] === "in" && f[1] === "status")).toBe(false)
    expect(due().filters.some((f) => f[0] === "order" && f[1] === "next_recheck_at")).toBe(true)
    expect(due().limit).toBe(2000)
  })

  it("re-opened expired row: false -> blocked with fresh expires_at, count+1, normal schedule", async () => {
    const { deps, updates } = makeDeps([r("x", "0243333333", 2, "expired")], () => false)
    const res = await recheckBlockedNumbers({ ids: ["x"], reopenExpired: true }, deps)
    const upd = updates[0]
    expect(upd.patch).toEqual({
      recheck_count: 3,
      next_recheck_at: new Date(NOW.getTime() + DAY).toISOString(),
      last_rechecked_at: NOW.toISOString(),
      status: "blocked",
      expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      updated_at: NOW.toISOString(),
    })
    expect(upd.filters).toContainEqual(["eq", "status", "expired"])
    expect(res).toMatchObject({ stillBlocked: 1, checked: 1 })
  })

  it("re-opened expired row: true -> allowed, null -> untouched", async () => {
    const t = makeDeps([r("x", "0243333333", 2, "expired")], () => true)
    const rt = await recheckBlockedNumbers({ ids: ["x"], reopenExpired: true }, t.deps)
    expect(t.updates[0].patch).toMatchObject({ status: "allowed", allowed_by: "prov" })
    expect(t.updates[0].filters).toContainEqual(["eq", "status", "expired"])
    expect(rt.allowed).toBe(1)
    const n = makeDeps([r("x", "0243333333", 2, "expired")], () => null)
    const rn = await recheckBlockedNumbers({ ids: ["x"], reopenExpired: true }, n.deps)
    expect(n.updates).toHaveLength(0)
    expect(rn.unchecked).toBe(1)
  })

  it("sends the resolver chunks of at most 500", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`))
    const { deps, chunks } = makeDeps(rows, () => false)
    await recheckBlockedNumbers({}, deps)
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 100])
  })

  it("stops starting resolver chunks after 200 s; skipped rows are counted as deferred and untouched", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`))
    let t = 0
    // clock: 0 at start, then jumps past the deadline after the first chunk has been started
    const clock = vi.fn(() => (t++ < 2 ? 0 : 201_000))
    const { deps, chunks, updates } = makeDeps(rows, () => false, { clock })
    const res = await recheckBlockedNumbers({}, deps)
    expect(chunks.map((c) => c.length)).toEqual([500])
    expect(res.deferred).toBe(600)
    expect(res.stillBlocked).toBe(500)
    expect(updates.flatMap((u) => idsOf(u))).not.toContain("id600")
  })
})

function idsOf(u: Rec): string[] {
  return (u.filters.find((f) => f[0] === "in" && f[1] === "id")?.[2] as string[]) ?? []
}
