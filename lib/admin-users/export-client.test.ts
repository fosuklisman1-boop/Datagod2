import { describe, it, expect, vi } from "vitest"
import { UsersExportError, exportAllUsers, retryDelayMs } from "./export-client"

const ok = (ids: string[], nextCursor: string | null) =>
  new Response(JSON.stringify({ users: ids.map((id) => ({ id })), nextCursor }), { status: 200 })
const status = (code: number, headers: Record<string, string> = {}, body: unknown = { error: `HTTP ${code}` }) =>
  new Response(JSON.stringify(body), { status: code, headers })
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).join("")

describe("exportAllUsers", () => {
  it("follows nextCursor until it is null, in one request per chunk", async () => {
    const pages: Record<string, Response> = { start: ok(["a", "b"], "c1"), c1: ok(["c", "d"], "c2"), c2: ok(["e"], null) }
    const fetchChunk = vi.fn(async (cursor: string | null) => pages[cursor ?? "start"])
    const progress: number[] = []
    const rows = await exportAllUsers(fetchChunk, { sleep: async () => {}, onProgress: (n) => progress.push(n) })
    expect(ids(rows)).toBe("abcde")
    expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([null, "c1", "c2"])
    expect(progress).toEqual([2, 4, 5])
  })

  it("retries a 429 for the same cursor after the server's reset time", async () => {
    const responses = [ok(["a"], "c1"), status(429, { "Retry-After": "3" }), ok(["b"], null)]
    const fetchChunk = vi.fn(async (_cursor: string | null) => responses.shift()!)
    const sleep = vi.fn(async () => {})
    const rows = await exportAllUsers(fetchChunk, { sleep })
    expect(ids(rows)).toBe("ab")
    expect(fetchChunk.mock.calls.map((c) => c[0])).toEqual([null, "c1", "c1"])
    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it("gives up after maxRetries 429s with an explicit error that says how far it got", async () => {
    const fetchChunk = vi.fn(async (cursor: string | null) => (cursor ? status(429) : ok(["a", "b"], "c1")))
    const err = await exportAllUsers(fetchChunk, { sleep: async () => {}, maxRetries: 2 }).catch((e) => e)
    expect(err).toBeInstanceOf(UsersExportError)
    expect(err.loaded).toBe(2)
    expect(err.message).toMatch(/rate limit/i)
    expect(fetchChunk).toHaveBeenCalledTimes(1 + 3)
  })

  it("fails loudly on a server error, a stuck cursor, or too many chunks (never truncates silently)", async () => {
    const e1 = await exportAllUsers(async () => status(500, {}, { error: "db down" }), { sleep: async () => {} }).catch((e) => e)
    expect(e1).toBeInstanceOf(UsersExportError)
    expect(e1.message).toMatch(/db down/)

    const e2 = await exportAllUsers(async () => ok(["a"], "same"), { sleep: async () => {} }).catch((e) => e)
    expect(e2).toBeInstanceOf(UsersExportError)
    expect(e2.message).toMatch(/did not advance/)

    let n = 0
    const e3 = await exportAllUsers(async () => ok([`u${n}`], `c${n++}`), { sleep: async () => {}, maxChunks: 3 }).catch((e) => e)
    expect(e3).toBeInstanceOf(UsersExportError)
    expect(e3.loaded).toBe(3)
    expect(e3.message).toMatch(/more than 3 requests/)
  })

  it("wraps network failures", async () => {
    const err = await exportAllUsers(async () => { throw new TypeError("Failed to fetch") }, { sleep: async () => {} }).catch((e) => e)
    expect(err).toBeInstanceOf(UsersExportError)
    expect(err.message).toMatch(/Failed to fetch/)
  })
})

describe("retryDelayMs", () => {
  const h = (o: Record<string, string>) => new Headers(o)
  it("prefers Retry-After, then X-RateLimit-Reset, then exponential backoff; clamped to 0.5s..60s", () => {
    expect(retryDelayMs(h({ "Retry-After": "2" }), 0, 0)).toBe(2000)
    expect(retryDelayMs(h({ "X-RateLimit-Reset": new Date(10_000).toISOString() }), 0, 4_000)).toBe(6000)
    expect(retryDelayMs(h({}), 0, 0)).toBe(1000)
    expect(retryDelayMs(h({}), 3, 0)).toBe(8000)
    expect(retryDelayMs(h({ "Retry-After": "3600" }), 0, 0)).toBe(60_000)
    expect(retryDelayMs(h({ "X-RateLimit-Reset": new Date(0).toISOString() }), 0, 5_000)).toBe(500)
  })
})
