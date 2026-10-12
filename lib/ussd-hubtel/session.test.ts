import { describe, it, expect, vi, afterEach } from "vitest"
import { DB_SESSION_TTL_SECONDS, dbSessionStore, sessionStore } from "./session"
import type { HubtelSession } from "./types"

const s: HubtelSession = { step: "MAIN", dialingPhone: "+233200585542", platform: "USSD" }

describe("hubtel session store (no redis configured)", () => {
  it("round-trips and deletes", async () => {
    expect(await sessionStore.get("a1")).toBeNull()
    await sessionStore.set("a1", s)
    expect(await sessionStore.get("a1")).toEqual(s)
    await sessionStore.del("a1")
    expect(await sessionStore.get("a1")).toBeNull()
  })
})

describe("hubtel session store (redis configured but failing)", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.doUnmock("@upstash/redis")
    vi.resetModules()
    vi.restoreAllMocks()
  })
  async function loadWith(redis: Record<string, unknown>) {
    vi.resetModules()
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example")
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "tok")
    vi.doMock("@upstash/redis", () => ({ Redis: class { constructor() { return redis } } }))
    vi.spyOn(console, "error").mockImplementation(() => {})
    return (await import("./session")).sessionStore
  }
  it("Redis erroring: a miss, never a per-instance copy (a stale step would misroute input)", async () => {
    const fail = async () => { throw new Error("ERR max requests limit exceeded") }
    const store = await loadWith({ get: fail, setex: fail, del: fail })
    await store.set("b1", s)
    expect(await store.get("b1")).toBeNull()
    await expect(store.del("b1")).resolves.toBeUndefined()
  })
  it("a write that failed on this instance is never served after a later successful write elsewhere", async () => {
    const data = new Map<string, string>()
    let failSet = true
    let failGet = false
    const store = await loadWith({
      get: async (k: string) => { if (failGet) throw new Error("down"); return data.has(k) ? JSON.parse(data.get(k)!) : null },
      setex: async (k: string, _t: number, v: string) => { if (failSet) throw new Error("down"); data.set(k, v) },
      del: async (k: string) => { data.delete(k) },
    })
    await store.set("b3", { ...s, step: "SHOP_ENTER_CODE" }) // fails on this instance
    failSet = false
    data.set("ussd-hubtel:session:b3", JSON.stringify({ ...s, step: "SHOP_DATA_RECIPIENT" })) // another instance moved on
    failGet = true
    expect(await store.get("b3")).toBeNull()
    failGet = false
    expect((await store.get("b3"))?.step).toBe("SHOP_DATA_RECIPIENT")
  })
  it("Redis healthy: a plain miss is a miss (no stale in-process copy is served)", async () => {
    const data = new Map<string, string>()
    const store = await loadWith({
      get: async (k: string) => (data.has(k) ? JSON.parse(data.get(k)!) : null),
      setex: async (k: string, _ttl: number, v: string) => { data.set(k, v) },
      del: async (k: string) => { data.delete(k) },
    })
    await store.set("b2", s)
    expect(await store.get("b2")).toEqual(s)
    data.clear() // TTL expiry
    expect(await store.get("b2")).toBeNull()
  })
})

describe("dbSessionStore", () => {
  /** Minimal fake of the calls dbSessionStore makes on hubtel_ussd_sessions. */
  function fakeDb(fail = false) {
    const rows = new Map<string, { data: HubtelSession; expires_at: string }>()
    const err = fail ? { code: "42P01", message: "relation does not exist" } : null
    const client = {
      from: () => ({
        select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => (err ? { data: null, error: err } : { data: rows.get(id) ?? null, error: null }) }) }),
        upsert: async (r: { session_id: string; data: HubtelSession; expires_at: string }) => {
          if (err) return { error: err }
          rows.set(r.session_id, { data: r.data, expires_at: r.expires_at })
          return { error: null }
        },
        delete: () => ({
          eq: async (_c: string, id: string) => { if (!err) rows.delete(id); return { error: err } },
          lt: async (_c: string, iso: string) => { for (const [k, v] of rows) if (v.expires_at < iso) rows.delete(k); return { error: err } },
        }),
      }),
    }
    return { client: client as never, rows }
  }
  const memFallback = () => {
    const m = new Map<string, HubtelSession>()
    return { m, store: { get: async (id: string) => m.get(id) ?? null, set: async (id: string, v: HubtelSession) => { m.set(id, v) }, del: async (id: string) => { m.delete(id) } } }
  }
  afterEach(() => { vi.restoreAllMocks() })

  it("round-trips through the table and deletes", async () => {
    const { client, rows } = fakeDb()
    const { store: fb, m } = memFallback()
    const store = dbSessionStore(client, fb)
    await store.set("d1", s)
    expect(rows.has("d1")).toBe(true)
    expect(m.has("d1")).toBe(false)
    expect(await store.get("d1")).toEqual(s)
    await store.del("d1")
    expect(await store.get("d1")).toBeNull()
  })
  it("an expired row is a miss", async () => {
    let t = 1_000_000
    const { client } = fakeDb()
    const { store: fb } = memFallback()
    const store = dbSessionStore(client, fb, () => t)
    await store.set("d2", s)
    t += (DB_SESSION_TTL_SECONDS + 1) * 1000
    expect(await store.get("d2")).toBeNull()
  })
  it("table missing / DB failing: falls back to the previous store", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { client } = fakeDb(true)
    const { store: fb, m } = memFallback()
    const store = dbSessionStore(client, fb)
    await store.set("d3", s)
    expect(m.get("d3")).toEqual(s)
    expect(await store.get("d3")).toEqual(s)
    await store.del("d3")
    expect(m.has("d3")).toBe(false)
  })
  it("a healthy DB miss does not consult the fallback", async () => {
    const { client } = fakeDb()
    const { store: fb, m } = memFallback()
    m.set("d4", s)
    expect(await dbSessionStore(client, fb).get("d4")).toBeNull()
  })
})
