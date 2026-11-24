import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({ status: "error" as unknown, ann: [] as unknown[] }))
vi.mock("@/lib/api-v2/status-public", () => ({ getPublicStatus: async () => state.status }))
vi.mock("@/lib/api-v2/announcements", () => ({ getPublicAnnouncements: async () => state.ann }))

import * as statusRoute from "./status/route"
import * as annRoute from "./announcements/route"

beforeEach(() => {
  state.status = { generatedAt: "2026-11-23T12:00:00.000Z", services: [] }
  state.ann = [{ id: "a", title: "t", body: "b", severity: "info", endsAt: "2026-11-24T00:00:00.000Z" }]
})

describe("public routes", () => {
  it("Cache-Control public, s-maxage=60, stale-while-revalidate=300 on success; no Set-Cookie; unknown query params ignored", async () => {
    const cases = [
      [statusRoute, "http://x/api/developers/status?x=random&window=999999"],
      [annRoute, "http://x/api/developers/announcements?x=1"],
    ] as const
    for (const [mod, url] of cases) {
      const res = await mod.GET(new Request(url))
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
      expect(res.headers.get("set-cookie")).toBeNull()
    }
    const body = await (await annRoute.GET(new Request("http://x/a"))).json()
    expect(body.announcements).toHaveLength(1)
  })
  it("status: no-store on error, generic message, no details", async () => {
    state.status = "error"
    const res = await statusRoute.GET(new Request("http://x/s"))
    expect(res.status).toBe(503)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ error: "Status is temporarily unavailable" })
  })
  it("routes export only GET and config (Next answers 405 for every other method)", () => {
    const allowed = new Set(["GET", "dynamic"])
    for (const mod of [statusRoute, annRoute]) {
      for (const k of Object.keys(mod)) expect(allowed.has(k)).toBe(true)
      expect(typeof (mod as Record<string, unknown>).GET).toBe("function")
      expect((mod as Record<string, unknown>).dynamic).toBe("force-dynamic")
    }
  })
})
