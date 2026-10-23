import { describe, it, expect, vi } from "vitest"
import { resolveMtnVerdicts, referenceFromPath, readJsonBody } from "./data-deps"

describe("referenceFromPath", () => {
  it("takes the last segment of /api/v2/orders/{reference}, URL-decoded", () => {
    expect(referenceFromPath("/api/v2/orders/REF-1")).toBe("REF-1")
    expect(referenceFromPath("/api/v2/orders/a%3Ab")).toBe("a:b")
    expect(referenceFromPath("/api/v2/orders/REF-1/")).toBe("REF-1")
  })
  it("a malformed escape yields an empty string (handler then 404s)", () => {
    expect(referenceFromPath("/api/v2/orders/%E0%A4%A")).toBe("")
  })
})

describe("readJsonBody", () => {
  it("returns undefined for invalid JSON", async () => {
    expect(await readJsonBody({ json: async () => { throw new SyntaxError("x") } })).toBeUndefined()
    expect(await readJsonBody({ json: async () => ({ a: 1 }) })).toEqual({ a: 1 })
  })
})

const reg = (configured = true) => [{ name: "xpress", configured: () => configured }]
const on = { enabled: true, providers: ["xpress"] }

describe("resolveMtnVerdicts (MTN whitelist guard wiring)", () => {
  it("maps the guard's verified flags to true/false per local number", async () => {
    const check = vi.fn(async (phones: string[]) => phones.map((phone) => ({ phone, verified: phone !== "0249990461" })))
    const out = await resolveMtnVerdicts(["0249990460", "0249990461"], {
      settings: async () => on,
      registry: reg(),
      check,
      timeoutMs: 1000,
    })
    expect(check).toHaveBeenCalledWith(["0249990460", "0249990461"])
    expect([...out.entries()]).toEqual([
      ["0249990460", true],
      ["0249990461", false],
    ])
  })

  it("feature off, no providers selected, or none configured -> unchecked (null), the guard is not called", async () => {
    for (const io of [
      { settings: async () => ({ enabled: false, providers: ["xpress"] }), registry: reg() },
      { settings: async () => ({ enabled: true, providers: [] }), registry: reg() },
      { settings: async () => on, registry: reg(false) },
    ]) {
      const check = vi.fn()
      const out = await resolveMtnVerdicts(["0249990462"], { ...io, check, timeoutMs: 1000 })
      expect(out.get("0249990462")).toBeNull()
      expect(check).not.toHaveBeenCalled()
    }
  })

  it("guard throws, settings read throws, or the guard times out -> unchecked (fails open, never throws)", async () => {
    const thrown = await resolveMtnVerdicts(["0249990463"], {
      settings: async () => on,
      registry: reg(),
      check: async () => {
        throw new Error("provider down 0249990463")
      },
      timeoutMs: 1000,
    })
    expect(thrown.get("0249990463")).toBeNull()

    const badSettings = await resolveMtnVerdicts(["0249990463"], {
      settings: async () => {
        throw new Error("db")
      },
      registry: reg(),
      check: vi.fn(),
      timeoutMs: 1000,
    })
    expect(badSettings.get("0249990463")).toBeNull()

    const slow = await resolveMtnVerdicts(["0249990464"], {
      settings: async () => on,
      registry: reg(),
      check: () => new Promise(() => {}),
      timeoutMs: 20,
    })
    expect(slow.get("0249990464")).toBeNull()
  })

  it("a number missing from the guard's answer stays unchecked; empty input makes no call", async () => {
    const out = await resolveMtnVerdicts(["0249990465"], {
      settings: async () => on,
      registry: reg(),
      check: async () => [],
      timeoutMs: 1000,
    })
    expect(out.get("0249990465")).toBeNull()
    const settings = vi.fn(async () => on)
    expect((await resolveMtnVerdicts([], { settings, registry: reg(), check: vi.fn(), timeoutMs: 1 })).size).toBe(0)
    expect(settings).not.toHaveBeenCalled()
  })

  it("logs never carry the phone number", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await resolveMtnVerdicts(["0249990466"], {
      settings: async () => on,
      registry: reg(),
      check: async () => {
        throw new Error("bad 0249990466")
      },
      timeoutMs: 1000,
    })
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("9990466")
    spy.mockRestore()
  })
})
