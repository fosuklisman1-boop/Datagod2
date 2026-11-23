import { describe, it, expect, vi, afterEach } from "vitest"
import type { WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { askSupplier, canCheck } from "./ask"

const PHONE = "0240000001"

type Batch = (m: string[]) => Promise<Array<{ msisdn: string; allowed: boolean }>>
function entry(name: string, strict: Batch | undefined, configured = true): WhitelistEntry {
  const nonStrict = vi.fn(async () => {
    throw new Error("non-strict must not be used")
  })
  return {
    name,
    configured: () => configured,
    check: nonStrict as any,
    checkBatch: nonStrict as any,
    checkBatchStrict: strict,
  }
}

afterEach(() => vi.restoreAllMocks())

describe("canCheck", () => {
  const reg = [entry("a", async () => []), entry("off", async () => [], false)]
  it("true for a configured, enabled registry entry", () => {
    expect(canCheck("a", new Set(), reg)).toBe(true)
  })
  it("false when unknown, unconfigured or disabled", () => {
    expect(canCheck("zzz", new Set(), reg)).toBe(false)
    expect(canCheck("off", new Set(), reg)).toBe(false)
    expect(canCheck("a", new Set(["a"]), reg)).toBe(false)
  })
  it("false when the entry has no strict check", () => {
    expect(canCheck("n", new Set(), [entry("n", undefined)])).toBe(false)
  })
})

describe("askSupplier", () => {
  const ask = (strict: Batch | undefined, opts?: { timeoutMs?: number }, phone = PHONE) =>
    askSupplier("s", phone, { ...opts, registry: [entry("s", strict)] })

  it("allowed true -> yes, allowed false -> no", async () => {
    expect(await ask(async (m) => [{ msisdn: m[0], allowed: true }])).toBe("yes")
    expect(await ask(async (m) => [{ msisdn: m[0], allowed: false }])).toBe("no")
  })

  it("sends exactly the one phone to the strict batch", async () => {
    const fn = vi.fn<Batch>(async (m) => [{ msisdn: m[0], allowed: true }])
    await ask(fn)
    expect(fn).toHaveBeenCalledWith([PHONE])
  })

  it("matches a row echoed as 233... for a 0... input", async () => {
    expect(await ask(async () => [{ msisdn: "233240000001", allowed: true }])).toBe("yes")
  })

  it("a matched row without a real boolean allowed -> no_answer", async () => {
    expect(await ask((async () => [{ msisdn: PHONE, allowed: undefined }]) as any)).toBe("no_answer")
    expect(await ask((async () => [{ msisdn: PHONE, allowed: null }]) as any)).toBe("no_answer")
    expect(await ask((async () => [{ msisdn: PHONE, allowed: "true" }]) as any)).toBe("no_answer")
  })

  it("ignores rows for other numbers", async () => {
    expect(await ask(async () => [{ msisdn: "0240000002", allowed: true }])).toBe("no_answer")
  })

  it("empty result -> no_answer", async () => {
    expect(await ask(async () => [])).toBe("no_answer")
  })

  it("throw (e.g. Hubnet cooldown or queued) -> no_answer", async () => {
    expect(await ask(async () => { throw new Error("Hubnet cooldown") })).toBe("no_answer")
  })

  it("slower than the timeout -> no_answer", async () => {
    const slow: Batch = () => new Promise((r) => setTimeout(() => r([{ msisdn: PHONE, allowed: true }]), 200))
    expect(await ask(slow, { timeoutMs: 20 })).toBe("no_answer")
  })

  it("unknown supplier, no strict check, or invalid phone -> no_answer", async () => {
    expect(await askSupplier("nope", PHONE, { registry: [] })).toBe("no_answer")
    expect(await ask(undefined)).toBe("no_answer")
    expect(await ask(async (m) => [{ msisdn: m[0], allowed: true }], undefined, "junk")).toBe("no_answer")
  })

  it("never logs the phone", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")].map((s) => s.mockImplementation(() => {}))
    await ask(async () => { throw new Error(`failed for ${PHONE}`) })
    await ask(async () => [{ msisdn: PHONE, allowed: true }])
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("240000001")
  })
})
