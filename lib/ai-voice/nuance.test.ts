import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mapNuanceError, mintNuanceToken, getNuanceUsage, __resetNuanceUsageCache } from "./nuance"

describe("mapNuanceError", () => {
  it("maps the known refusals", () => {
    expect(mapNuanceError(429, "credits_spent")).toBe("credits")
    expect(mapNuanceError(409, "concurrency_limit")).toBe("busy")
    expect(mapNuanceError(429, "start_limit")).toBe("busy")
    expect(mapNuanceError(429, "capacity_unavailable")).toBe("busy")
    expect(mapNuanceError(503, "busy")).toBe("busy")
    expect(mapNuanceError(403, undefined, "policy_curfew")).toBe("policy")
    expect(mapNuanceError(403, undefined, "organization_paused")).toBe("policy")
    expect(mapNuanceError(400, undefined, "app_review_held")).toBe("review_pending")
    expect(mapNuanceError(500)).toBe("unavailable")
  })
})

const INPUT = {
  systemPrompt: "SECRET PROMPT TEXT", personaId: "sam", expressiveness: 1, endUserId: "u_1", camera: false,
}
const json = (status: number, body: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response

describe("mintNuanceToken", () => {
  beforeEach(() => {
    process.env.NUANCE_API_KEY = "nk_testkey123"
    process.env.NUANCE_API_URL = "https://nuance.test"
  })
  afterEach(() => vi.restoreAllMocks())

  it("posts the right request and returns the token", async () => {
    const f = vi.fn(async () => json(200, { token: "tok", warnings: ["w"] }))
    const r = await mintNuanceToken(INPUT, f as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, token: "tok", warnings: ["w"] })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://nuance.test/session-tokens")
    expect(init.method).toBe("POST")
    const h = init.headers as Record<string, string>
    expect(h.Authorization).toBe("Bearer nk_testkey123")
    expect(h["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({
      interface: "nuance_live",
      personality: { system_prompt: "SECRET PROMPT TEXT", persona_id: "sam" },
      expressiveness: 1,
      end_user_id: "u_1",
      interface_setup: {
        delegation: { type: "client" },
        runtime_tools: { end_call: true, call_time: true },
        video: { input: { camera: false } },
      },
    })
  })

  it("maps a refusal and never logs secrets", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const f = vi.fn(async () => json(403, { detail: "SECRET PROMPT TEXT nk_testkey123", error: { code: "policy_curfew" } }))
    const r = await mintNuanceToken(INPUT, f as unknown as typeof fetch)
    expect(r).toMatchObject({ ok: false, reason: "policy", status: 403 })
    const out = JSON.stringify([...err.mock.calls, ...log.mock.calls])
    expect(out).toContain("[voice] mint refused 403")
    expect(out).not.toContain("nk_")
    expect(out).not.toContain("SECRET PROMPT")
  })

  it("uses top-level code when present", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = vi.fn(async () => json(429, { detail: "x", code: "credits_spent" }))
    expect(await mintNuanceToken(INPUT, f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: "credits", code: "credits_spent" })
  })

  it("thrown fetch -> unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = vi.fn(async () => { throw new Error("boom nk_testkey123") })
    expect(await mintNuanceToken(INPUT, f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: "unavailable" })
  })

  it("missing NUANCE_API_KEY -> unavailable without fetching", async () => {
    delete process.env.NUANCE_API_KEY
    const f = vi.fn(async () => json(200, { token: "tok" }))
    expect(await mintNuanceToken(INPUT, f as unknown as typeof fetch)).toEqual({ ok: false, reason: "unavailable", status: 0 })
    expect(f).not.toHaveBeenCalled()
  })

  it("passes an 8 s abort signal; an abort -> unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      throw new DOMException("timed out", "TimeoutError")
    })
    expect(await mintNuanceToken(INPUT, f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: "unavailable", status: 0 })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("returned code is the sanitised value, not the raw remote string", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = vi.fn(async () => json(400, { code: "bad code <script> nk_testkey123" }))
    const r = await mintNuanceToken(INPUT, f as unknown as typeof fetch)
    expect(r).toMatchObject({ ok: false, code: "unknown" })
  })

  it("200 without a token -> unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const f = vi.fn(async () => json(200, {}))
    expect(await mintNuanceToken(INPUT, f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: "unavailable" })
  })
})

describe("getNuanceUsage", () => {
  beforeEach(() => {
    process.env.NUANCE_API_KEY = "nk_testkey123"
    process.env.NUANCE_API_URL = "https://nuance.test"
    __resetNuanceUsageCache()
  })
  it("parses defensively and caches for 60 s", async () => {
    const f = vi.fn(async () => json(200, { credits_left: 42, renews_at: "2026-12-01T00:00:00" }))
    const a = await getNuanceUsage(f as unknown as typeof fetch)
    const b = await getNuanceUsage(f as unknown as typeof fetch)
    expect(a).toEqual({ creditsLeft: 42, renewsAt: "2026-12-01T00:00:00Z" })
    expect(b).toEqual(a)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it("odd fields -> nulls", async () => {
    const f = vi.fn(async () => json(200, { credits_left: "lots" }))
    expect(await getNuanceUsage(f as unknown as typeof fetch)).toEqual({ creditsLeft: null, renewsAt: null })
  })
  it("missing key -> null without fetching; passes an abort signal", async () => {
    delete process.env.NUANCE_API_KEY
    const f = vi.fn(async () => json(200, { credits_left: 1 }))
    expect(await getNuanceUsage(f as unknown as typeof fetch)).toBeNull()
    expect(f).not.toHaveBeenCalled()
    process.env.NUANCE_API_KEY = "nk_testkey123"
    __resetNuanceUsageCache()
    const g = vi.fn(async (_u: string, init: RequestInit) => { expect(init.signal).toBeInstanceOf(AbortSignal); return json(200, {}) })
    await getNuanceUsage(g as unknown as typeof fetch)
    expect(g).toHaveBeenCalledTimes(1)
  })
  it("non-200 or throw -> null", async () => {
    expect(await getNuanceUsage((async () => json(500, {})) as unknown as typeof fetch)).toBeNull()
    __resetNuanceUsageCache()
    expect(await getNuanceUsage((async () => { throw new Error("x") }) as unknown as typeof fetch)).toBeNull()
  })
})
