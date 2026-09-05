import { checkCustomerFacingVerification, getCustomerVerificationSettings } from "./customer-verification"
import type { WhitelistEntry } from "./provider-whitelist"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

function fakeEntry(name: string, allowedSet: Set<string>, configured = true): WhitelistEntry {
  return {
    name,
    configured: () => configured,
    check: async (msisdn) => ({ allowed: allowedSet.has(msisdn), provider: name }),
    checkBatch: async (msisdns) => msisdns.map(m => ({ msisdn: m, allowed: allowedSet.has(m) })),
  }
}

describe("checkCustomerFacingVerification", () => {
  it("marks every phone verified when the feature is disabled", async () => {
    const registry = [fakeEntry("xpress", new Set())]
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0552222222"],
      registry,
      { enabled: false, providers: ["xpress"] }
    )
    expect(result).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: true },
    ])
  })

  it("marks every phone verified when no configured provider is selected", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: [] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("marks every phone verified when the selected provider isn't in the registry or isn't configured", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]), false)]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("returns per-phone results for a mixed batch against one configured provider", async () => {
    const registry = [fakeEntry("xpress", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0559999999"],
      registry,
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0559999999", verified: false },
    ])
  })

  it("is verified if ANY configured provider approves, checked in registry order", async () => {
    const registry = [
      fakeEntry("xpress", new Set()),
      fakeEntry("codecraft", new Set(["0551111111"])),
    ]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress", "codecraft"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("does not let one provider's thrown exception fail the whole check", async () => {
    const throwing: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async () => { throw new Error("network down") },
      checkBatch: async () => { throw new Error("network down") },
    }
    const registry = [throwing, fakeEntry("codecraft", new Set(["0551111111"]))]
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      registry,
      { enabled: true, providers: ["xpress", "codecraft"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })

  it("marks a phone unverified (not throws) when every configured provider is unreachable", async () => {
    const throwing: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async () => { throw new Error("network down") },
      checkBatch: async () => { throw new Error("network down") },
    }
    const result = await checkCustomerFacingVerification(
      ["0551111111"],
      [throwing],
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([{ phone: "0551111111", verified: false }])
  })

  it("checks a duplicate phone only once but returns one result per input occurrence", async () => {
    let callCount = 0
    const countingEntry: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async (msisdn) => {
        callCount++
        return { allowed: msisdn === "0551111111", provider: "xpress" }
      },
      checkBatch: async (msisdns) => msisdns.map(m => ({ msisdn: m, allowed: m === "0551111111" })),
    }
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0552222222", "0551111111"],
      [countingEntry],
      { enabled: true, providers: ["xpress"] }
    )
    expect(result).toEqual([
      { phone: "0551111111", verified: true },
      { phone: "0552222222", verified: false },
      { phone: "0551111111", verified: true },
    ])
    // Only 2 unique phones, so exactly 2 calls despite 3 input entries
    expect(callCount).toBe(2)
  })

  it("exercises the real default registry + settings read when called with only phones", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: false, providers: [] } },
            error: null,
          }),
        }),
      }),
    })
    const result = await checkCustomerFacingVerification(["0551111111"])
    expect(result).toEqual([{ phone: "0551111111", verified: true }])
  })
})

describe("getCustomerVerificationSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("defaults to disabled with no providers when the setting row is missing", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })

  it("defaults to disabled when the read throws", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockImplementation(() => { throw new Error("db down") })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })

  it("returns the stored setting when present", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: true, providers: ["xpress", "apexprime"] } },
            error: null,
          }),
        }),
      }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: true, providers: ["xpress", "apexprime"] })
  })

  it("defaults to disabled when the stored value is malformed (providers not an array)", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: "yes", providers: "not-an-array" } },
            error: null,
          }),
        }),
      }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })

  it("defaults to disabled when the stored value is missing the providers field", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: true } },
            error: null,
          }),
        }),
      }),
    })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [] })
  })
})
