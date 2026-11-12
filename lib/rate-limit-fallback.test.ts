// lib/rate-limit-fallback.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const rpc = vi.fn()
let clientRpcOverride: (() => never) | null = null
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ rpc: (...a: unknown[]) => (clientRpcOverride ? clientRpcOverride() : (rpc as any)(...a)) }),
}))

import { pgFallbackLimit } from "@/lib/rate-limit-fallback"

describe("pgFallbackLimit", () => {
  beforeEach(() => {
    rpc.mockReset()
    clientRpcOverride = null
  })

  it("calls the RPC with whole seconds and maps the row", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, remaining: 4, reset_at: "2026-11-12T10:01:00.000Z" }], error: null })
    const r = await pgFallbackLimit("v2-purchase:user:a", 5, 60_000)
    expect(rpc).toHaveBeenCalledWith("rate_limit_fallback_hit", { p_bucket: "v2-purchase:user:a", p_max: 5, p_window_seconds: 60 })
    expect(r).toEqual({ allowed: true, remaining: 4, resetAt: Date.parse("2026-11-12T10:01:00.000Z") })
  })

  it("rounds sub-second windows up to 1 second", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, remaining: 0, reset_at: "2026-11-12T10:01:00Z" }], error: null })
    await pgFallbackLimit("k", 1, 200)
    expect(rpc.mock.calls[0][1].p_window_seconds).toBe(1)
  })

  it("returns null on an RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } })
    expect(await pgFallbackLimit("k", 1, 1000)).toBeNull()
  })

  it("returns null when the RPC throws", async () => {
    // vitest records an error thrown by a vi.fn as a test error, so the throw comes from a plain function
    clientRpcOverride = () => { throw new Error("network") }
    expect(await pgFallbackLimit("k", 1, 1000)).toBeNull()
  })

  it("returns null on an empty or malformed result", async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect(await pgFallbackLimit("k", 1, 1000)).toBeNull()
    rpc.mockResolvedValue({ data: [{ allowed: "yes" }], error: null })
    expect(await pgFallbackLimit("k", 1, 1000)).toBeNull()
  })
})
