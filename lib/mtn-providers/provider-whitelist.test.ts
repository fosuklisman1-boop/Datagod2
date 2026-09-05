import { checkWhitelistBatch, listWhitelistProviders, validateProviderSelection, unionProviders, isApexPrimeOrderable, type WhitelistEntry } from "./provider-whitelist"

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
