import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))

import { checkCustomerFacingVerification } from "@/lib/mtn-providers/customer-verification"
import type { WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { resolveMtnVerdicts, referenceFromPath, readJsonBody, type MtnVerifyIo } from "./data-deps"

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

const on = { enabled: true, providers: ["p1", "p2"] }

function provider(name: string, behaviour: Set<string> | "throw", configured = true): WhitelistEntry {
  return {
    name,
    configured: () => configured,
    check: async () => {
      throw new Error("not used")
    },
    checkBatch: async (msisdns) => {
      if (behaviour === "throw") throw new Error(`provider down ${msisdns.join(",")}`)
      return msisdns.map((m) => ({ msisdn: m, allowed: behaviour.has(m) }))
    },
  }
}

/** The REAL shared guard with fake providers: proves the outage detection against its actual behaviour. */
function io(registry: WhitelistEntry[], over: Partial<MtnVerifyIo> = {}): MtnVerifyIo {
  return {
    settings: async () => on,
    registry,
    check: (phones, reg, settings) => checkCustomerFacingVerification(phones, reg, settings),
    timeoutMs: 1000,
    ...over,
  }
}

describe("resolveMtnVerdicts (MTN whitelist guard wiring)", () => {
  it("verified -> true, positively unregistered -> false", async () => {
    const out = await resolveMtnVerdicts(
      ["0249990460", "0249990461"],
      io([provider("p1", new Set(["0249990460"]))])
    )
    expect([...out.entries()]).toEqual([
      ["0249990460", true],
      ["0249990461", false],
    ])
  })

  it("ALL configured providers throw (outage) -> unchecked (null), never 'not registered'", async () => {
    const out = await resolveMtnVerdicts(
      ["0249990467", "0249990468"],
      io([provider("p1", "throw"), provider("p2", "throw")])
    )
    expect(out.get("0249990467")).toBeNull()
    expect(out.get("0249990468")).toBeNull()
  })

  it("one provider throws, another answers 'unregistered' -> unregistered (false)", async () => {
    const out = await resolveMtnVerdicts(
      ["0249990469"],
      io([provider("p1", "throw"), provider("p2", new Set())])
    )
    expect(out.get("0249990469")).toBe(false)
  })

  it("one provider throws, another verifies -> true", async () => {
    const out = await resolveMtnVerdicts(
      ["0249990470"],
      io([provider("p1", "throw"), provider("p2", new Set(["0249990470"]))])
    )
    expect(out.get("0249990470")).toBe(true)
  })

  it("feature off, no providers selected, or none configured -> unchecked (null), the guard is not called", async () => {
    for (const over of [
      { settings: async () => ({ enabled: false, providers: ["p1"] }) },
      { settings: async () => ({ enabled: true, providers: [] }) },
    ]) {
      const check = vi.fn()
      const out = await resolveMtnVerdicts(["0249990462"], io([provider("p1", new Set())], { ...over, check }))
      expect(out.get("0249990462")).toBeNull()
      expect(check).not.toHaveBeenCalled()
    }
    const check = vi.fn()
    const out = await resolveMtnVerdicts(["0249990462"], io([provider("p1", new Set(), false)], { check }))
    expect(out.get("0249990462")).toBeNull()
    expect(check).not.toHaveBeenCalled()
  })

  it("guard throws, settings read throws, or the guard times out -> unchecked (fails open, never throws)", async () => {
    const thrown = await resolveMtnVerdicts(
      ["0249990463"],
      io([provider("p1", new Set())], {
        check: async () => {
          throw new Error("boom 0249990463")
        },
      })
    )
    expect(thrown.get("0249990463")).toBeNull()

    const badSettings = await resolveMtnVerdicts(
      ["0249990463"],
      io([provider("p1", new Set())], {
        settings: async () => {
          throw new Error("db")
        },
      })
    )
    expect(badSettings.get("0249990463")).toBeNull()

    const slow = await resolveMtnVerdicts(
      ["0249990464"],
      io([provider("p1", new Set())], { check: () => new Promise(() => {}), timeoutMs: 20 })
    )
    expect(slow.get("0249990464")).toBeNull()
  })

  it("a number missing from the guard's answer stays unchecked; empty input makes no call", async () => {
    const out = await resolveMtnVerdicts(["0249990465"], io([provider("p1", new Set())], { check: async () => [] }))
    expect(out.get("0249990465")).toBeNull()
    const settings = vi.fn(async () => on)
    expect((await resolveMtnVerdicts([], io([], { settings }))).size).toBe(0)
    expect(settings).not.toHaveBeenCalled()
  })

  it("logs never carry the phone number", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    await resolveMtnVerdicts(
      ["0249990466"],
      io([provider("p1", new Set())], {
        check: async () => {
          throw new Error("bad 0249990466")
        },
      })
    )
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("9990466")
    spy.mockRestore()
  })
})
