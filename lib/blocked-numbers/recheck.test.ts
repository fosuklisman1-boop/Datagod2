import { describe, it, expect, vi } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { nextState, recheckBlockedNumbers, type RecheckDeps } from "./recheck"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const DAY = 86_400_000
const DUE_BY = new Date(NOW.getTime() + 2 * 3_600_000).toISOString()

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
    expect(due().filters).toContainEqual(["lte", "next_recheck_at", DUE_BY])
    expect(res.expired).toBe(1200)
  })

  it("a row scheduled seconds after yesterday's run started is still due today (cron start jitter)", async () => {
    // Seen in prod 2026-11-22: due at 06:30:59.296, the run started at 06:30:57.860, so it waited another day.
    const { deps, due } = makeDeps([], () => false)
    await recheckBlockedNumbers({}, { ...deps, now: () => new Date("2026-11-22T06:30:57.860Z") })
    const cutoff = due().filters.find((f) => f[0] === "lte" && f[1] === "next_recheck_at")![2] as string
    expect(Date.parse(cutoff)).toBeGreaterThanOrEqual(Date.parse("2026-11-22T06:30:59.296Z"))
    expect(Date.parse(cutoff)).toBeLessThan(Date.parse("2026-11-23T06:30:00.000Z"))
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
    expect(due().filters).toContainEqual(["or", `and(status.eq.blocked,next_recheck_at.lte.${DUE_BY}),status.eq.expired`])
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

describe("recheck with outside providers", () => {
  const outsideResult = (allowedPhones: string[]) => async (phones: string[]) => ({
    providers: ["p1", "hubx"],
    checkoutProviders: ["p1"],
    failedProviders: [],
    rows: phones.map((phone) => ({
      phone,
      results: {},
      allowedByCheckout: false,
      allowedOutsideCheckout: allowedPhones.includes(phone) ? ["hubx"] : [],
    })),
  })
  const markOk = () => vi.fn(async (rows: Array<{ id: string }>) => ({ updatedIds: rows.map((x) => x.id), failed: false, cacheFailed: 0 }))
  const clockAt = () => { const c = { t: 0 }; return { c, clock: () => c.t } }

  it("refused by checkout and allowed outside flips via markAllowedByAdminCheck; counts move from stillBlocked to allowed", async () => {
    const { deps } = makeDeps([r("a", "0241111111"), r("b", "0242222222")], () => false)
    const markAllowed = markOk()
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll: vi.fn(outsideResult(["0241111111"])), markAllowed })
    expect(markAllowed).toHaveBeenCalledWith([{ id: "a", phone: "0241111111", allowedBy: "hubx" }])
    expect(res).toMatchObject({ allowed: 1, stillBlocked: 1, checked: 2, newlyAllowedIds: ["a"] })
  })

  it("refused everywhere stays scheduled", async () => {
    const { deps } = makeDeps([r("a", "0241111111")], () => false)
    const markAllowed = vi.fn()
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll: vi.fn(outsideResult([])), markAllowed })
    expect(markAllowed).not.toHaveBeenCalled()
    expect(res).toMatchObject({ stillBlocked: 1, allowed: 0 })
  })

  it("a checkout outage (null) triggers no outside check", async () => {
    const { deps } = makeDeps([r("a", "0241111111")], () => null)
    const checkAll = vi.fn(outsideResult(["0241111111"]))
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })
    expect(checkAll).not.toHaveBeenCalled()
    expect(res.unchecked).toBe(1)
  })

  it("a failed outside flip changes nothing", async () => {
    const { deps } = makeDeps([r("a", "0241111111")], () => false)
    const markAllowed = vi.fn(async () => ({ updatedIds: [], failed: true, cacheFailed: 1 }))
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll: vi.fn(outsideResult(["0241111111"])), markAllowed })
    expect(res).toMatchObject({ allowed: 0, stillBlocked: 1 })
  })

  it("outside checks go in batches of at most 100", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`))
    const sizes: number[] = []
    const checkAll = vi.fn(async (phones: string[]) => { sizes.push(phones.length); return outsideResult([])(phones) })
    const { deps } = makeDeps(rows, () => false)
    await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })
    expect(sizes).toEqual([100, 100, 50])
  })

  it("no outside batch starts after 150 s even though the 200 s checkout deadline has not passed", async () => {
    const { c, clock } = clockAt()
    const { deps } = makeDeps([r("a", "0241111111")], () => false, { clock })
    const resolve: typeof deps.resolve = async (...a) => { const out = await deps.resolve(...a); c.t = 151_000; return out }
    const checkAll = vi.fn(outsideResult([]))
    await recheckBlockedNumbers({}, { ...deps, resolve, checkAll, markAllowed: vi.fn() })
    expect(checkAll).not.toHaveBeenCalled()
  })

  it("stops starting outside batches once the 90 s cumulative budget is spent", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`))
    const { c, clock } = clockAt()
    const checkAll = vi.fn(async (phones: string[]) => { c.t += 50_000; return outsideResult([])(phones) })
    const { deps } = makeDeps(rows, () => false, { clock })
    await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })
    expect(checkAll).toHaveBeenCalledTimes(2) // 50 s, 100 s >= 90 s budget
  })

  it("refused rows the budget did not reach stay due, with their count restored, and are reported deferred", async () => {
    const rows = Array.from({ length: 250 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`, i < 225 ? 2 : 6))
    const { c, clock } = clockAt()
    const checkAll = vi.fn(async (phones: string[]) => { c.t += 50_000; return outsideResult([])(phones) })
    const { deps, updates } = makeDeps(rows, () => false, { clock })
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })

    const undone = updates.filter((u) => u.patch?.next_recheck_at === NOW.toISOString())
    expect(undone.map((u) => u.patch)).toEqual([
      { recheck_count: 2, next_recheck_at: NOW.toISOString(), updated_at: NOW.toISOString() },
      { recheck_count: 6, next_recheck_at: NOW.toISOString(), updated_at: NOW.toISOString() },
    ])
    for (const u of undone) expect(u.filters).toContainEqual(["eq", "status", "blocked"])
    expect(undone.flatMap(idsOf)).toEqual(rows.slice(200).map((x) => x.id))
    expect(res).toMatchObject({ stillBlocked: 200, checked: 200, deferred: 50 })
  })

  it("a batch that throws, or where every outside provider failed, keeps its rows due as deferred", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`, 1))
    let call = 0
    const checkAll = vi.fn(async (phones: string[]) => {
      call++
      if (call === 1) throw new Error("boom")
      return { ...(await outsideResult([])(phones)), failedProviders: ["hubx"] }
    })
    const { deps, updates } = makeDeps(rows, () => false)
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })
    const kept = updates.filter((u) => u.patch?.next_recheck_at === NOW.toISOString())
    expect(kept.flatMap(idsOf).sort()).toEqual(rows.map((x) => x.id).sort())
    expect(res).toMatchObject({ stillBlocked: 0, deferred: 150 })
  })

  it("refused rows are all kept due when the outside start deadline has already passed", async () => {
    const { c, clock } = clockAt()
    const { deps, updates } = makeDeps([r("a", "0241111111", 4)], () => false, { clock })
    const resolve: typeof deps.resolve = async (...a) => { const out = await deps.resolve(...a); c.t = 151_000; return out }
    const res = await recheckBlockedNumbers({}, { ...deps, resolve, checkAll: vi.fn(outsideResult([])), markAllowed: vi.fn() })
    expect(updates.at(-1)?.patch).toEqual({ recheck_count: 4, next_recheck_at: NOW.toISOString(), updated_at: NOW.toISOString() })
    expect(res).toMatchObject({ stillBlocked: 0, deferred: 1 })
  })

  it("outside work never defers checkout parts: all checkout parts run before any outside batch", async () => {
    const rows = Array.from({ length: 1100 }, (_, i) => r(`id${i}`, `024${String(i).padStart(7, "0")}`))
    const { c, clock } = clockAt()
    const checkAll = vi.fn(async (phones: string[]) => { c.t += 100_000; return outsideResult([])(phones) })
    const { deps, chunks } = makeDeps(rows, () => false, { clock })
    const res = await recheckBlockedNumbers({}, { ...deps, checkAll, markAllowed: vi.fn() })
    expect(chunks.map((x) => x.length)).toEqual([500, 500, 100]) // every checkout part ran
    // One outside batch spent the budget: those 100 are fully checked, the other 1000 stay due.
    expect(res).toMatchObject({ stillBlocked: 100, deferred: 1000 })
  })
})
