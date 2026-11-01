import { describe, it, expect, vi, beforeEach } from "vitest"

// No Upstash env in tests: the cache must work fully on the Supabase table.
type Row = { cache_key: string; verdict: boolean; expires_at: string }
const table = new Map<string, Row>()
let failNext: unknown = null

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: { keys?: string[]; after?: string } = {}
      const chain: any = {
        select: () => chain,
        in: (_c: string, keys: string[]) => { q.keys = keys; return chain },
        gt: (_c: string, iso: string) => { q.after = iso; return chain },
        then: (resolve: any, reject: any) => {
          if (failNext) { const error = failNext; failNext = null; return Promise.resolve({ data: null, error }).then(resolve, reject) }
          const data = [...table.values()].filter(r => q.keys!.includes(r.cache_key) && r.expires_at > q.after!)
          return Promise.resolve({ data, error: null }).then(resolve, reject)
        },
        upsert: async (rows: Row[]) => {
          if (failNext) { const error = failNext; failNext = null; return { error } }
          rows.forEach(r => table.set(r.cache_key, r))
          return { error: null }
        },
        delete: () => ({ lt: async () => ({ error: null }) }),
      }
      return chain
    },
  },
}))

import { getCachedVerdicts, setCachedVerdicts, verdictCacheKey } from "./verdict-cache"

describe("verdict cache without Upstash (Supabase table)", () => {
  beforeEach(() => {
    table.clear()
    failNext = null
  })

  it("round-trips definite verdicts", async () => {
    await setCachedVerdicts(new Map([["0559999999", false], ["0551111111", true]]), ["agentportalgh", "xpress"])
    const got = await getCachedVerdicts(["0559999999", "0551111111", "0550000000"], ["agentportalgh", "xpress"])
    expect(got).toEqual(new Map([["0559999999", false], ["0551111111", true]]))
  })

  it("the same number in 233/+233 form hits the same entry", async () => {
    await setCachedVerdicts(new Map([["0559999999", false]]), ["agentportalgh"])
    expect((await getCachedVerdicts(["233559999999"], ["agentportalgh"])).get("233559999999")).toBe(false)
    expect(verdictCacheKey("+233 55 999 9999", ["agentportalgh"])).toBe(verdictCacheKey("0559999999", ["agentportalgh"]))
  })

  it("a different provider list (or order) is a miss", async () => {
    await setCachedVerdicts(new Map([["0559999999", false]]), ["agentportalgh", "xpress"])
    expect((await getCachedVerdicts(["0559999999"], ["xpress", "agentportalgh"])).size).toBe(0)
  })

  it("ignores expired rows", async () => {
    const key = verdictCacheKey("0559999999", ["agentportalgh"])
    table.set(key, { cache_key: key, verdict: false, expires_at: new Date(Date.now() - 1000).toISOString() })
    expect((await getCachedVerdicts(["0559999999"], ["agentportalgh"])).size).toBe(0)
  })

  it("a database error (e.g. table not migrated yet) is a miss, never a throw", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    failNext = { code: "42P01", message: "relation does not exist" }
    await expect(getCachedVerdicts(["0559999999"], ["agentportalgh"])).resolves.toEqual(new Map())
    failNext = { code: "42P01" }
    await expect(setCachedVerdicts(new Map([["0559999999", false]]), ["agentportalgh"])).resolves.toBeUndefined()
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("9999999")
    spy.mockRestore()
  })
})
