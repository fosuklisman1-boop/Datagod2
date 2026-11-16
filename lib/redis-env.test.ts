import { describe, it, expect } from "vitest"
import { getRedisRestEnv } from "./redis-env"

const UP = { UPSTASH_REDIS_REST_URL: "https://up.example", UPSTASH_REDIS_REST_TOKEN: "up-tok" }
const KV = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-tok" }

describe("getRedisRestEnv", () => {
  it("returns null when nothing is configured", () => {
    expect(getRedisRestEnv({})).toBeNull()
  })

  it("uses UPSTASH_* by default even when KV_* is also present", () => {
    expect(getRedisRestEnv({ ...UP, ...KV })).toEqual({ url: "https://up.example", token: "up-tok", source: "upstash" })
  })

  it("uses KV_* when REDIS_SOURCE=vercel-kv", () => {
    expect(getRedisRestEnv({ ...UP, ...KV, REDIS_SOURCE: "vercel-kv" })).toEqual({
      url: "https://kv.example",
      token: "kv-tok",
      source: "vercel-kv",
    })
  })

  it("falls back to UPSTASH_* when REDIS_SOURCE=vercel-kv but KV_* is incomplete", () => {
    expect(getRedisRestEnv({ ...UP, KV_REST_API_URL: "https://kv.example", REDIS_SOURCE: "vercel-kv" })?.source).toBe("upstash")
  })

  it("ignores KV_* without REDIS_SOURCE, even when it is the only pair", () => {
    expect(getRedisRestEnv({ ...KV })).toBeNull()
  })

  it("uses KV_* alone when REDIS_SOURCE=vercel-kv and UPSTASH_* is absent", () => {
    expect(getRedisRestEnv({ ...KV, REDIS_SOURCE: "vercel-kv" })?.source).toBe("vercel-kv")
  })

  it("returns null when REDIS_SOURCE=vercel-kv and neither pair is set", () => {
    expect(getRedisRestEnv({ REDIS_SOURCE: "vercel-kv" })).toBeNull()
  })

  it("ignores an incomplete UPSTASH_* pair", () => {
    expect(getRedisRestEnv({ UPSTASH_REDIS_REST_URL: "https://up.example", ...KV })).toBeNull()
  })

  it("never picks the read-only KV token", () => {
    const r = getRedisRestEnv({ KV_REST_API_URL: "https://kv.example", KV_REST_API_READ_ONLY_TOKEN: "ro", REDIS_SOURCE: "vercel-kv" })
    expect(r).toBeNull()
  })

  it("treats REDIS_SOURCE case- and whitespace-insensitively", () => {
    expect(getRedisRestEnv({ ...UP, ...KV, REDIS_SOURCE: " Vercel-KV " })?.source).toBe("vercel-kv")
  })
})
