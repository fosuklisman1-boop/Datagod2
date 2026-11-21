import { checkWhitelistBatch, listWhitelistProviders, validateProviderSelection, unionProviders, isApexPrimeOrderable, WHITELIST_REGISTRY, type WhitelistEntry } from "./provider-whitelist"
import { describe, it, expect, vi, afterEach } from "vitest"

function fakeEntry(name: string, allowedSet: Set<string>, configured = true): WhitelistEntry {
  return {
    name,
    configured: () => configured,
    check: async (msisdn) => ({ allowed: allowedSet.has(msisdn), provider: name }),
    checkBatch: async (msisdns) => msisdns.map(m => ({ msisdn: m, allowed: allowedSet.has(m) })),
  }
}

describe("checkWhitelistBatch", () => {
  it("allows a number via the first provider that says yes", async () => {
    const registry = [
      fakeEntry("xpress", new Set(["0551111111"])),
      fakeEntry("codecraft", new Set(["0552222222"])),
    ]
    const result = await checkWhitelistBatch(["0551111111", "0552222222"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "xpress" })
    expect(result.get("0552222222")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("falls through to the next provider when the first denies", async () => {
    const registry = [
      fakeEntry("xpress", new Set()),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("marks a number blocked when every configured provider denies it", async () => {
    const registry = [fakeEntry("xpress", new Set()), fakeEntry("codecraft", new Set())]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: false })
  })

  it("skips unconfigured providers entirely", async () => {
    const registry = [
      fakeEntry("xpress", new Set(["0551111111"]), false),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkWhitelistBatch(["0551111111"], registry)
    expect(result.get("0551111111")).toEqual({ allowed: true, allowedBy: "codecraft" })
  })

  it("does not call a later provider once every number is already allowed", async () => {
    let secondProviderCalled = false
    const registry: WhitelistEntry[] = [
      fakeEntry("xpress", new Set(["0551111111"])),
      {
        name: "codecraft",
        configured: () => true,
        check: async () => ({ allowed: false, provider: "codecraft" }),
        checkBatch: async (msisdns) => {
          secondProviderCalled = true
          return msisdns.map(m => ({ msisdn: m, allowed: false }))
        },
      },
    ]
    await checkWhitelistBatch(["0551111111"], registry)
    expect(secondProviderCalled).toBe(false)
  })
})

describe("listWhitelistProviders", () => {
  it("reports each registry entry's name and configured state", () => {
    const registry = [
      fakeEntry("xpress", new Set(), true),
      fakeEntry("codecraft", new Set(), false),
    ]
    expect(listWhitelistProviders(registry)).toEqual([
      { name: "xpress", configured: true },
      { name: "codecraft", configured: false },
    ])
  })
})

describe("validateProviderSelection", () => {
  const registry = [
    fakeEntry("xpress", new Set(), true),
    fakeEntry("codecraft", new Set(), true),
    fakeEntry("agentportalgh", new Set(), false),
  ]

  it("rejects an empty selection", () => {
    const result = validateProviderSelection([], registry)
    expect(result).toEqual({ valid: false, error: "At least one provider must be selected" })
  })

  it("rejects an unknown provider name", () => {
    const result = validateProviderSelection(["xpress", "bogus"], registry)
    expect(result).toEqual({ valid: false, error: "Unknown provider(s): bogus" })
  })

  it("rejects a known but unconfigured provider", () => {
    const result = validateProviderSelection(["agentportalgh"], registry)
    expect(result).toEqual({ valid: false, error: "Provider(s) not configured: agentportalgh" })
  })

  it("accepts a valid subset, deduped and normalized to registry order", () => {
    const result = validateProviderSelection(["codecraft", "xpress", "codecraft"], registry)
    expect(result).toEqual({ valid: true, providers: ["xpress", "codecraft"] })
  })
})

describe("unionProviders", () => {
  it("merges two lists without duplicates", () => {
    expect(unionProviders(["xpress"], ["xpress", "codecraft"])).toEqual(["xpress", "codecraft"])
  })

  it("returns the added list as-is when existing is empty", () => {
    expect(unionProviders([], ["xpress"])).toEqual(["xpress"])
  })
})

describe("isApexPrimeOrderable", () => {
  it("allows a number that's valid and not unorderable (real live response shape)", () => {
    const data = { success: true, is_valid: true, provider_data: { exists: true, verified: true, is_valid: true, unorderable: false, status: "verified" } }
    expect(isApexPrimeOrderable(data)).toBe(true)
  })

  it("blocks a number flagged unorderable even if is_valid were somehow true", () => {
    const data = { is_valid: true, provider_data: { unorderable: true } }
    expect(isApexPrimeOrderable(data)).toBe(false)
  })

  it("blocks a number awaiting MTN approval (real live response shape)", () => {
    const data = { success: false, is_valid: false, provider_data: { exists: false, verified: false, is_valid: false, unorderable: true, status: "awaiting_mtn_approval" } }
    expect(isApexPrimeOrderable(data)).toBe(false)
  })

  it("treats a missing provider_data as orderable when is_valid is true", () => {
    expect(isApexPrimeOrderable({ is_valid: true })).toBe(true)
  })

  it("blocks when is_valid is missing entirely", () => {
    expect(isApexPrimeOrderable({ provider_data: { unorderable: false } })).toBe(false)
  })

  it("blocks on a null/undefined response", () => {
    expect(isApexPrimeOrderable(null)).toBe(false)
    expect(isApexPrimeOrderable(undefined)).toBe(false)
  })
})

describe("checkBatchStrict (customer-facing check)", () => {
  const xpress = () => WHITELIST_REGISTRY.find(p => p.name === "xpress")!
  const codecraft = () => WHITELIST_REGISTRY.find(p => p.name === "codecraft")!

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("xpress: a bad status throws in strict mode but still fails open in checkBatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    await expect(xpress().checkBatchStrict!(["0551111111"])).rejects.toThrow(/xpress/)
    expect(await xpress().checkBatch(["0551111111"])).toEqual([{ msisdn: "0551111111", allowed: true }])
  })

  it("xpress: a network error or a malformed body throws in strict mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET") }))
    await expect(xpress().checkBatchStrict!(["0551111111"])).rejects.toThrow()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ nope: 1 }) })))
    await expect(xpress().checkBatchStrict!(["0551111111"])).rejects.toThrow()
  })

  it("xpress: a real answer comes back unchanged in strict mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ results: [{ msisdn: "0551111111", allowed: false }] }) })))
    expect(await xpress().checkBatchStrict!(["0551111111"])).toEqual([{ msisdn: "0551111111", allowed: false }])
  })

  it("codecraft: bad status / missing results throw in strict mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })))
    await expect(codecraft().checkBatchStrict!(["0551111111"])).rejects.toThrow(/codecraft/)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) })))
    await expect(codecraft().checkBatchStrict!(["0551111111"])).rejects.toThrow(/codecraft/)
  })

  it("every registry provider offers a strict variant", () => {
    for (const p of WHITELIST_REGISTRY) expect(typeof p.checkBatchStrict).toBe("function")
  })
})

describe("validateProviderSelection keepOrder", () => {
  const reg = WHITELIST_REGISTRY.map(p => ({ ...p, configured: () => true }))
  it("keeps the admin's order (deduped) when asked", () => {
    expect(validateProviderSelection(["agentportalgh", "xpress", "agentportalgh"], reg, { keepOrder: true }))
      .toEqual({ valid: true, providers: ["agentportalgh", "xpress"] })
  })
  it("still normalizes to registry order by default", () => {
    expect(validateProviderSelection(["agentportalgh", "xpress"], reg)).toEqual({ valid: true, providers: ["xpress", "agentportalgh"] })
  })
})

// ── Kuntanii ───────────────────────────────────────────────────────────────────
const kuntaniiVerify = vi.fn()
vi.mock("./kuntanii-client", () => ({
  createKuntaniiClient: () => ({ verifyBeneficiaries: kuntaniiVerify }),
}))

function kuntaniiEntry() {
  return WHITELIST_REGISTRY.find(e => e.name === "kuntanii")!
}

describe("kuntanii whitelist", () => {
  afterEach(() => {
    kuntaniiVerify.mockReset()
    vi.unstubAllEnvs()
  })

  it("kuntanii check maps eligible → allowed", async () => {
    kuntaniiVerify.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { results: [{ phoneNumber: "0241234567", eligible: true, reason: "ok" }] },
    })
    expect(await kuntaniiEntry().check("0241234567")).toEqual({ allowed: true, provider: "kuntanii", reason: "ok" })

    kuntaniiVerify.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { results: [{ phoneNumber: "0241234567", eligible: false, reason: "blocked_number" }] },
    })
    expect(await kuntaniiEntry().check("0241234567")).toEqual({ allowed: false, provider: "kuntanii", reason: "blocked_number" })
  })

  it("kuntanii check fails open on client error", async () => {
    kuntaniiVerify.mockResolvedValueOnce({ ok: false, status: 500 })
    expect((await kuntaniiEntry().check("0241234567")).allowed).toBe(true)
    kuntaniiVerify.mockRejectedValueOnce(new Error("boom"))
    expect(await kuntaniiEntry().check("0241234567")).toEqual({ allowed: true, provider: "kuntanii" })
  })

  it("kuntanii check rejects invalid phone without calling the client", async () => {
    const r = await kuntaniiEntry().check("12345")
    expect(r).toEqual({ allowed: false, provider: "kuntanii", reason: "invalid_phone_number" })
    expect(kuntaniiVerify).not.toHaveBeenCalled()
  })

  it("kuntanii batch chunks at 100 and matches results by position", async () => {
    const phones = Array.from({ length: 250 }, (_, i) => `024${String(1000000 + i).padStart(7, "0")}`)
    kuntaniiVerify.mockImplementation(async (chunk: string[]) => ({
      ok: true, status: 200,
      data: { results: chunk.map(p => ({ phoneNumber: p, eligible: Number(p.slice(-1)) % 2 === 0, reason: "r" })) },
    }))
    const out = await kuntaniiEntry().checkBatch(phones)
    expect(kuntaniiVerify).toHaveBeenCalledTimes(3)
    expect(kuntaniiVerify.mock.calls.map(c => c[0].length)).toEqual([100, 100, 50])
    expect(out).toHaveLength(250)
    out.forEach((r, i) => {
      expect(r.msisdn).toBe(phones[i])
      expect(r.allowed).toBe(Number(phones[i].slice(-1)) % 2 === 0)
    })
  })

  it("kuntanii batch fails open per chunk", async () => {
    const phones = Array.from({ length: 150 }, (_, i) => `024${String(2000000 + i).padStart(7, "0")}`)
    kuntaniiVerify
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        data: { results: phones.slice(100).map(p => ({ phoneNumber: p, eligible: false, reason: "blocked_number" })) },
      })
    const out = await kuntaniiEntry().checkBatch(phones)
    expect(out.slice(0, 100).every(r => r.allowed)).toBe(true)
    expect(out.slice(100).every(r => !r.allowed)).toBe(true)
  })

  it("kuntanii batch: invalid numbers blocked, not sent, order and original string preserved; short array fails open", async () => {
    kuntaniiVerify.mockResolvedValueOnce({
      ok: true, status: 200,
      data: { results: [{ phoneNumber: "0241111111", eligible: false, reason: "blocked_number" }] },
    })
    const out = await kuntaniiEntry().checkBatch(["0241111111", "abc", "+233242222222"])
    expect(kuntaniiVerify).toHaveBeenCalledWith(["0241111111", "0242222222"])
    expect(out).toEqual([
      { msisdn: "0241111111", allowed: false, reason: "blocked_number" },
      { msisdn: "abc", allowed: false, reason: "invalid_phone_number" },
      { msisdn: "+233242222222", allowed: true },
    ])
  })

  it("kuntanii strict batch throws on a failed chunk", async () => {
    kuntaniiVerify.mockResolvedValueOnce({ ok: false, status: 500 })
    await expect(kuntaniiEntry().checkBatchStrict!(["0241111111"])).rejects.toThrow(/kuntanii/)
  })

  it("registry includes kuntanii configured by KUNTANII_API_KEY", () => {
    vi.stubEnv("KUNTANII_API_KEY", "")
    expect(kuntaniiEntry().configured()).toBe(false)
    vi.stubEnv("KUNTANII_API_KEY", "x")
    expect(kuntaniiEntry().configured()).toBe(true)
    expect(validateProviderSelection(["kuntanii"])).toEqual({ valid: true, providers: ["kuntanii"] })
  })
})

const hubnetVerify = vi.fn()
const hubnetConfigured = vi.fn(() => false)
vi.mock("../hubnet/client", () => ({
  createHubnetClient: () => ({ verifyMtn: hubnetVerify }),
  isHubnetConfigured: () => hubnetConfigured(),
}))

function hubnetEntry() {
  return WHITELIST_REGISTRY.find(e => e.name === "hubnet")!
}

describe("hubnet whitelist", () => {
  afterEach(() => {
    hubnetVerify.mockReset()
    hubnetConfigured.mockReset()
  })

  it("maps verified → allowed", async () => {
    hubnetVerify.mockResolvedValueOnce("verified")
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: true, provider: "hubnet" })
  })

  it("maps unverified → not allowed", async () => {
    hubnetVerify.mockResolvedValueOnce("unverified")
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: false, provider: "hubnet", reason: "unverified" })
  })

  it("maps invalid → invalid_phone_number", async () => {
    hubnetVerify.mockResolvedValueOnce("invalid")
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: false, provider: "hubnet", reason: "invalid_phone_number" })
  })

  it("unparseable phone is blocked without a network call", async () => {
    expect(await hubnetEntry().check("12345")).toEqual({ allowed: false, provider: "hubnet", reason: "invalid_phone_number" })
    expect(hubnetVerify).not.toHaveBeenCalled()
  })

  it("maps queued → allowed with reason queued", async () => {
    hubnetVerify.mockResolvedValueOnce("queued")
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: true, provider: "hubnet", reason: "queued" })
  })

  it("fails open on null and on throw", async () => {
    hubnetVerify.mockResolvedValueOnce(null)
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: true, provider: "hubnet" })
    hubnetVerify.mockRejectedValueOnce(new Error("boom"))
    expect(await hubnetEntry().check("0241234567")).toEqual({ allowed: true, provider: "hubnet" })
  })

  it("batch preserves input order with out-of-order resolution and original msisdn strings", async () => {
    const inputs = ["0241111111", "bad", "+233242222222", "0243333333"]
    hubnetVerify.mockImplementation(async (n: string) => {
      await new Promise(r => setTimeout(r, n === "0241111111" ? 30 : 1))
      return n === "0241111111" ? "verified" : n === "0242222222" ? "unverified" : "queued"
    })
    const out = await hubnetEntry().checkBatch(inputs)
    expect(out).toEqual([
      { msisdn: "0241111111", allowed: true },
      { msisdn: "bad", allowed: false, reason: "invalid_phone_number" },
      { msisdn: "+233242222222", allowed: false, reason: "unverified" },
      { msisdn: "0243333333", allowed: true, reason: "queued" },
    ])
  })

  it("batch caps concurrency at 5", async () => {
    let inFlight = 0
    let max = 0
    hubnetVerify.mockImplementation(async () => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise(r => setTimeout(r, 5))
      inFlight--
      return "verified"
    })
    const phones = Array.from({ length: 12 }, (_, i) => `02411111${String(i).padStart(2, "0")}`)
    const out = await hubnetEntry().checkBatch(phones)
    expect(out).toHaveLength(12)
    expect(hubnetVerify).toHaveBeenCalledTimes(12)
    expect(max).toBeGreaterThan(1)
    expect(max).toBeLessThanOrEqual(5)
  })

  it("non-strict batch fails open on null/throw", async () => {
    hubnetVerify.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("x"))
    const out = await hubnetEntry().checkBatch(["0241111111", "0242222222"])
    expect(out.map(r => r.allowed)).toEqual([true, true])
  })

  it("strict batch throws WhitelistCheckFailed on null and on throw", async () => {
    hubnetVerify.mockResolvedValueOnce("verified").mockResolvedValueOnce(null)
    await expect(hubnetEntry().checkBatchStrict!(["0241111111", "0242222222"])).rejects.toThrow(/hubnet/)
    hubnetVerify.mockReset()
    hubnetVerify.mockRejectedValue(new Error("boom"))
    await expect(hubnetEntry().checkBatchStrict!(["0241111111"])).rejects.toMatchObject({ name: "WhitelistCheckFailed" })
  })

  it("registry entry follows isHubnetConfigured", () => {
    hubnetConfigured.mockReturnValue(false)
    expect(hubnetEntry().configured()).toBe(false)
    hubnetConfigured.mockReturnValue(true)
    expect(hubnetEntry().configured()).toBe(true)
  })
})

describe("hubnet whitelist opt-in (C1)", () => {
  afterEach(() => {
    hubnetConfigured.mockReset()
    delete process.env.HUBNET_WHITELIST_ENABLED
  })
  it("key set but flag unset is not configured", () => {
    hubnetConfigured.mockReturnValue(true)
    delete process.env.HUBNET_WHITELIST_ENABLED
    expect(hubnetEntry().configured()).toBe(false)
  })
  it("key set and flag true is configured", () => {
    hubnetConfigured.mockReturnValue(true)
    process.env.HUBNET_WHITELIST_ENABLED = "true"
    expect(hubnetEntry().configured()).toBe(true)
  })
  it("flag true but no key is not configured", () => {
    hubnetConfigured.mockReturnValue(false)
    process.env.HUBNET_WHITELIST_ENABLED = "true"
    expect(hubnetEntry().configured()).toBe(false)
  })
})
