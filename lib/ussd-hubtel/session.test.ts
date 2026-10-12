import { describe, it, expect, vi, afterEach } from "vitest"
import { sessionStore } from "./session"
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
  it("Redis erroring on every call: falls back to the in-process copy (like the Uzo shop)", async () => {
    const fail = async () => { throw new Error("ERR max requests limit exceeded") }
    const store = await loadWith({ get: fail, setex: fail, del: fail })
    await store.set("b1", s)
    expect(await store.get("b1")).toEqual(s)
    await store.del("b1")
    expect(await store.get("b1")).toBeNull()
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
