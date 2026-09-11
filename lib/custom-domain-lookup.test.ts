import { describe, it, expect, vi, beforeEach } from "vitest"

const redisGetMock = vi.fn()
const redisSetMock = vi.fn()
const redisDelMock = vi.fn()

vi.mock("@upstash/redis", () => ({
  // Note: must use `function` (not an arrow function) here — this mock is
  // invoked with `new Redis(...)` by the module under test, and Vitest 4's
  // mock implementation only supports the construct trap when the wrapped
  // implementation is itself constructable (arrow functions never are).
  Redis: vi.fn(function () {
    return {
      get: redisGetMock,
      set: redisSetMock,
      del: redisDelMock,
    }
  }),
}))

const maybeSingleMock = vi.fn()
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: maybeSingleMock,
          }),
        }),
      }),
    }),
  },
}))

const ORIGINAL_ENV = process.env

beforeEach(() => {
  vi.clearAllMocks()
  process.env = {
    ...ORIGINAL_ENV,
    UPSTASH_REDIS_REST_URL: "https://fake-upstash.example.com",
    UPSTASH_REDIS_REST_TOKEN: "fake-token",
  }
  // Real @upstash/redis `.set()` always resolves to a Promise; give the mock
  // the same shape by default so the implementation's fire-and-forget
  // `redis.set(...).catch(...)` has something thenable to chain onto.
  redisSetMock.mockResolvedValue(undefined)
})

const sampleConfig = {
  domain: "checkresults.com",
  service: "results_checker" as const,
  site_name: "CheckResults",
  logo_url: null,
  primary_color: "#059669",
  is_active: true,
}

describe("resolveCustomDomain", () => {
  it("returns the cached config on a Redis hit without querying Supabase", async () => {
    redisGetMock.mockResolvedValueOnce(sampleConfig)
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(maybeSingleMock).not.toHaveBeenCalled()
  })

  it("queries Supabase and fills the cache on a Redis miss", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:checkresults.com", sampleConfig, { ex: 300 })
  })

  it("negative-caches a definitive miss on both the exact host and its www-toggled variant", async () => {
    redisGetMock.mockResolvedValue(null) // no cache hit for either host form
    maybeSingleMock.mockResolvedValue({ data: null, error: null }) // no active row for either form
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("unknown-domain.com")

    expect(result).toBeNull()
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:unknown-domain.com", "__none__", { ex: 60 })
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:www.unknown-domain.com", "__none__", { ex: 60 })
  })

  it("negative-caches so a repeated lookup for the same host never touches Supabase again", async () => {
    redisGetMock.mockResolvedValue(null)
    maybeSingleMock.mockResolvedValue({ data: null, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const first = await resolveCustomDomain("ghost-domain.com")
    expect(first).toBeNull()
    const callsAfterFirstLookup = maybeSingleMock.mock.calls.length
    expect(callsAfterFirstLookup).toBeGreaterThan(0)

    // Simulate the negative marker that was just written now living in the
    // cache under the exact host's own key — a real Redis would already
    // reflect this by the time a second request comes in.
    redisGetMock.mockImplementation(async (key: string) =>
      key === "custom_domain:ghost-domain.com" ? "__none__" : null
    )

    const second = await resolveCustomDomain("ghost-domain.com")

    expect(second).toBeNull()
    expect(maybeSingleMock.mock.calls.length).toBe(callsAfterFirstLookup) // no new Supabase calls
  })

  it("falls back to the www-toggled host when the exact host has no active row", async () => {
    redisGetMock.mockResolvedValue(null) // no cache hit for either form
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // miss for "checkresults.com"
      .mockResolvedValueOnce({ data: sampleConfig, error: null }) // hit for "www.checkresults.com"
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
    expect(maybeSingleMock).toHaveBeenCalledTimes(2)
  })

  it("falls back to Supabase and still returns a result when Redis throws", async () => {
    redisGetMock.mockRejectedValueOnce(new Error("redis down"))
    maybeSingleMock.mockResolvedValueOnce({ data: sampleConfig, error: null })
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toEqual(sampleConfig)
  })

  it("fails open to null when Supabase throws", async () => {
    redisGetMock.mockResolvedValueOnce(null)
    maybeSingleMock.mockRejectedValueOnce(new Error("db down"))
    const { resolveCustomDomain } = await import("./custom-domain-lookup")

    const result = await resolveCustomDomain("checkresults.com")

    expect(result).toBeNull()
  })
})

describe("setCustomDomainCache / clearCustomDomainCache", () => {
  it("writes the config to Redis under the domain key", async () => {
    const { setCustomDomainCache } = await import("./custom-domain-lookup")
    await setCustomDomainCache(sampleConfig)
    expect(redisSetMock).toHaveBeenCalledWith("custom_domain:checkresults.com", sampleConfig, { ex: 300 })
  })

  it("deletes the domain key from Redis", async () => {
    const { clearCustomDomainCache } = await import("./custom-domain-lookup")
    await clearCustomDomainCache("checkresults.com")
    expect(redisDelMock).toHaveBeenCalledWith("custom_domain:checkresults.com")
  })
})
