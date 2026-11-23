import {
  checkCustomerFacingVerification,
  checkCustomerFacingVerificationDetailed,
  getCustomerVerificationSettings,
  isRecipientBlocked,
  verifyRecipientsForOrder,
} from "./customer-verification"
import type { WhitelistEntry } from "./provider-whitelist"
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/blocked-numbers/record", () => ({
  recordBlockedRecipients: vi.fn(async () => ({ recorded: 1, deduped: 0 })),
}))

// Default behaves like "outside a request scope": after() throws, so the gate awaits the recorder.
const afterMock = vi.hoisted(() => ({ fn: (() => { throw new Error("outside request scope") }) as any }))
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (t: any) => afterMock.fn(t) }))

// Strict supplier verification is off for these legacy-behaviour tests.
vi.mock("@/lib/strict-verify/settings", () => ({ isStrictVerifyOn: async () => false }))
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

  it("checks each unique phone only once via checkBatch, returning one result per input occurrence", async () => {
    let batchCallCount = 0
    let lastBatchArg: string[] = []
    const countingEntry: WhitelistEntry = {
      name: "xpress",
      configured: () => true,
      check: async (msisdn) => ({ allowed: msisdn === "0551111111", provider: "xpress" }),
      checkBatch: async (msisdns) => {
        batchCallCount++
        lastBatchArg = msisdns
        return msisdns.map(m => ({ msisdn: m, allowed: m === "0551111111" }))
      },
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
    // checkBatch called exactly once (not once per phone), with only the 2 unique phones
    expect(batchCallCount).toBe(1)
    expect(lastBatchArg.slice().sort()).toEqual(["0551111111", "0552222222"])
  })

  it("matches a provider's differently-formatted echoed number back to the original input", async () => {
    const entry: WhitelistEntry = {
      name: "agentportalgh",
      configured: () => true,
      check: async () => ({ allowed: false, provider: "agentportalgh" }),
      checkBatch: async (msisdns) =>
        // Simulates a provider echoing back the international format (2335...)
        // for an input sent in local format (0551234567...).
        msisdns.map(m => ({ msisdn: "233" + m.slice(1), allowed: true })),
    }
    const result = await checkCustomerFacingVerification(
      ["0551234567"],
      [entry],
      { enabled: true, providers: ["agentportalgh"] }
    )
    expect(result).toEqual([{ phone: "0551234567", verified: true }])
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

  it("exercises the real WHITELIST_REGISTRY default parameter's filter() against actual entries", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { value: { enabled: true, providers: ["xpress"] } },
            error: null,
          }),
        }),
      }),
    })
    // No registry override — this binds the real WHITELIST_REGISTRY default and
    // runs registry.filter(...) against its real entries. In the test env none
    // of xpress/codecraft/agentportalgh/apexprime's configured() checks are
    // true (their API-key env vars aren't set), so filter() correctly yields
    // an empty array and the function fails open — verified for every phone.
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
    expect(settings).toEqual({ enabled: false, providers: [], block_unverified: false })
  })

  it("defaults to disabled when the read throws", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    ;(supabaseAdmin.from as any).mockImplementation(() => { throw new Error("db down") })
    const settings = await getCustomerVerificationSettings()
    expect(settings).toEqual({ enabled: false, providers: [], block_unverified: false })
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
    expect(settings).toEqual({ enabled: true, providers: ["xpress", "apexprime"], block_unverified: false })
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
    expect(settings).toEqual({ enabled: false, providers: [], block_unverified: false })
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
    expect(settings).toEqual({ enabled: false, providers: [], block_unverified: false })
  })
})

function mockSettingRow(value: unknown) {
  return import("@/lib/supabase").then(({ supabaseAdmin }) => {
    ;(supabaseAdmin.from as any).mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value }, error: null }) }) }),
    })
  })
}

describe("getCustomerVerificationSettings block_unverified", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("reads block_unverified:true from the stored setting", async () => {
    await mockSettingRow({ enabled: true, providers: ["xpress"], block_unverified: true })
    expect(await getCustomerVerificationSettings()).toEqual({ enabled: true, providers: ["xpress"], block_unverified: true })
  })

  it("treats a non-boolean block_unverified as false", async () => {
    await mockSettingRow({ enabled: true, providers: ["xpress"], block_unverified: "yes" })
    expect((await getCustomerVerificationSettings()).block_unverified).toBe(false)
  })
})

describe("verifyRecipientsForOrder", () => {
  const on = { enabled: true, providers: ["xpress"], block_unverified: true }
  const registry = [fakeEntry("xpress", new Set(["0551111111"]))]

  it("blocks a number the selected provider rejects when blocking is on", async () => {
    const r = await verifyRecipientsForOrder(["0551111111", "0559999999"], { registry, settings: on })
    expect(r.blocking).toBe(true)
    expect(r.blocked).toEqual(["0559999999"])
    expect(r.verdicts.get("0551111111")).toBe(true)
    expect(r.verdicts.get("0559999999")).toBe(false)
  })

  it("lists a repeated rejected number once", async () => {
    const r = await verifyRecipientsForOrder(["0559999999", "0559999999"], { registry, settings: on })
    expect(r.blocked).toEqual(["0559999999"])
  })

  it("reports the rejection but blocks nothing when block_unverified is off", async () => {
    const r = await verifyRecipientsForOrder(["0559999999"], { registry, settings: { ...on, block_unverified: false } })
    expect(r.blocking).toBe(false)
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get("0559999999")).toBe(false)
  })

  it("never blocks when every provider throws (outage)", async () => {
    const broken: WhitelistEntry = { ...fakeEntry("xpress", new Set()), checkBatch: async () => { throw new Error("down") } }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await verifyRecipientsForOrder(["0559999999"], { registry: [broken], settings: on })
    spy.mockRestore()
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get("0559999999")).toBeNull()
  })

  it("never blocks when the check times out", async () => {
    const hung: WhitelistEntry = { ...fakeEntry("xpress", new Set()), checkBatch: () => new Promise(() => {}) }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await verifyRecipientsForOrder(["0559999999"], { registry: [hung], settings: on, timeoutMs: 20 })
    spy.mockRestore()
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get("0559999999")).toBeNull()
  })

  it("never blocks when the feature itself is disabled", async () => {
    const r = await verifyRecipientsForOrder(["0559999999"], { registry, settings: { ...on, enabled: false } })
    expect(r.blocking).toBe(false)
    expect(r.blocked).toEqual([])
  })
})

describe("isRecipientBlocked", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("is false for a non-MTN network without reading settings", async () => {
    const { supabaseAdmin } = await import("@/lib/supabase")
    expect(await isRecipientBlocked("Telecel", "0201111111")).toBe(false)
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it("is false for MTN when no real provider is configured (fails open)", async () => {
    await mockSettingRow({ enabled: true, providers: ["xpress"], block_unverified: true })
    expect(await isRecipientBlocked("MTN", "0559999999")).toBe(false)
  })
})

describe("provider order and failures", () => {
  function recording(name: string, allowed: Set<string>, log: string[], opts: { fail?: boolean } = {}): WhitelistEntry {
    const run = async (msisdns: string[]) => {
      log.push(`${name}:${msisdns.join(",")}`)
      if (opts.fail) throw new Error(`${name} down`)
      return msisdns.map(m => ({ msisdn: m, allowed: allowed.has(m) }))
    }
    // checkBatch fails OPEN (like the real providers); checkBatchStrict throws.
    return {
      name,
      configured: () => true,
      check: async (m) => ({ allowed: allowed.has(m), provider: name }),
      checkBatch: async (m) => (opts.fail ? m.map(x => ({ msisdn: x, allowed: true })) : run(m)),
      checkBatchStrict: run,
    }
  }

  it("asks providers in the admin's order, not registry order", async () => {
    const log: string[] = []
    const registry = [recording("xpress", new Set(), log), recording("agentportalgh", new Set(["0551111111"]), log)]
    const result = await checkCustomerFacingVerification(
      ["0551111111", "0552222222"], registry, { enabled: true, providers: ["agentportalgh", "xpress"] }
    )
    expect(log).toEqual(["agentportalgh:0551111111,0552222222", "xpress:0552222222"])
    expect(result).toEqual([{ phone: "0551111111", verified: true }, { phone: "0552222222", verified: false }])
  })

  it("a failing first provider is NOT treated as approval: the next provider is asked", async () => {
    const log: string[] = []
    const registry = [recording("agentportalgh", new Set(), log, { fail: true }), recording("xpress", new Set(), log)]
    const result = await checkCustomerFacingVerification(
      ["0559999999"], registry, { enabled: true, providers: ["agentportalgh", "xpress"] }
    )
    expect(log).toEqual(["agentportalgh:0559999999", "xpress:0559999999"])
    expect(result).toEqual([{ phone: "0559999999", verified: false }])
  })

  it("order verdicts: first provider failed + second rejected -> blocked; all failed -> unchecked (never blocked)", async () => {
    const on = { enabled: true, providers: ["agentportalgh", "xpress"], block_unverified: true }
    const log: string[] = []
    const rejectAfterFail = [recording("agentportalgh", new Set(), log, { fail: true }), recording("xpress", new Set(), log)]
    expect((await verifyRecipientsForOrder(["0559999999"], { registry: rejectAfterFail, settings: on })).blocked).toEqual(["0559999999"])

    const allFail = [recording("agentportalgh", new Set(), log, { fail: true }), recording("xpress", new Set(), log, { fail: true })]
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const r = await verifyRecipientsForOrder(["0559999999"], { registry: allFail, settings: on })
    spy.mockRestore()
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get("0559999999")).toBeNull()
  })
})


describe("blocked-number recording from the gate", () => {
  const rejecting = () => [fakeEntry("xpress", new Set())]
  const blockingOn = { enabled: true, providers: ["xpress"], block_unverified: true }
  const ctx = { surface: "storefront" as const, shopId: "s1" }

  beforeEach(async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    afterMock.fn = () => { throw new Error("outside request scope") }
    ;(recordBlockedRecipients as any).mockClear()
    ;(recordBlockedRecipients as any).mockImplementation(async () => ({ recorded: 1, deduped: 0 }))
  })

  it("records a blocked number once with context and providers", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    const r = await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: ctx })
    expect(r.blocked).toEqual(["0551111111"])
    expect(recordBlockedRecipients).toHaveBeenCalledTimes(1)
    expect(recordBlockedRecipients).toHaveBeenCalledWith(["0551111111"], ctx, ["xpress"])
  })

  it("context without defer defaults to next/server after()", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    const tasks: Array<() => Promise<unknown>> = []
    afterMock.fn = vi.fn((t: () => Promise<unknown>) => { tasks.push(t) })
    const r = await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: ctx })
    expect(r.blocked).toEqual(["0551111111"])
    expect(afterMock.fn).toHaveBeenCalledTimes(1)
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
    await tasks[0]()
    expect(recordBlockedRecipients).toHaveBeenCalledTimes(1)
  })

  it("after() throwing (no request scope) falls back to awaiting the task", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    afterMock.fn = vi.fn(() => { throw new Error("outside request scope") })
    const r = await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: ctx })
    expect(r.blocked).toEqual(["0551111111"])
    expect(afterMock.fn).toHaveBeenCalledTimes(1)
    expect(recordBlockedRecipients).toHaveBeenCalledTimes(1)
  })

  it("hands the recorder to defer and does not await it", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    let never = false
    ;(recordBlockedRecipients as any).mockImplementation(() => new Promise(() => { never = true }))
    const deferred: Array<() => Promise<unknown>> = []
    const r = await verifyRecipientsForOrder(["0551111111"], {
      registry: rejecting(), settings: blockingOn, context: ctx, defer: (t) => { deferred.push(t) },
    })
    expect(r.blocked).toEqual(["0551111111"])
    expect(deferred).toHaveLength(1)
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
    void deferred[0]()
    expect(recordBlockedRecipients).toHaveBeenCalledTimes(1)
    expect(never).toBe(true)
  })

  it("never records when blocking is off", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    await verifyRecipientsForOrder(["0551111111"], {
      registry: rejecting(), settings: { enabled: true, providers: ["xpress"], block_unverified: false }, context: ctx,
    })
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
  })

  it("never records a verified number", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    await verifyRecipientsForOrder(["0551111111"], {
      registry: [fakeEntry("xpress", new Set(["0551111111"]))], settings: blockingOn, context: ctx,
    })
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
  })

  it("never records without a context", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn })
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
  })

  it("a throwing recorder leaves blocked unchanged", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    ;(recordBlockedRecipients as any).mockRejectedValue(new Error("boom"))
    const r = await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: ctx })
    expect(r.blocked).toEqual(["0551111111"])
    expect(r.blocking).toBe(true)
  })

  it("resolves a lazy context only when something is blocked, and skips on null", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    const lazy = vi.fn(async () => ctx)
    await verifyRecipientsForOrder(["0551111111"], {
      registry: [fakeEntry("xpress", new Set(["0551111111"]))], settings: blockingOn, context: lazy,
    })
    expect(lazy).not.toHaveBeenCalled()
    await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: lazy })
    expect(lazy).toHaveBeenCalledTimes(1)
    expect(recordBlockedRecipients).toHaveBeenCalledWith(["0551111111"], ctx, ["xpress"])
    ;(recordBlockedRecipients as any).mockClear()
    await verifyRecipientsForOrder(["0551111111"], { registry: rejecting(), settings: blockingOn, context: async () => null })
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
  })

  it("isRecipientBlocked passes context through for MTN only", async () => {
    const { recordBlockedRecipients } = await import("@/lib/blocked-numbers/record")
    expect(await isRecipientBlocked("AT", "0551111111", ctx)).toBe(false)
    expect(recordBlockedRecipients).not.toHaveBeenCalled()
  })
})

describe("checkCustomerFacingVerificationDetailed", () => {
  it("reports the provider that approved each phone", async () => {
    const registry = [
      fakeEntry("xpress", new Set(["0551111111"])),
      fakeEntry("kuntanii", new Set(["0552222222"])),
    ]
    const r = await checkCustomerFacingVerificationDetailed(
      ["0551111111", "0552222222", "0553333333"],
      registry,
      { enabled: true, providers: ["xpress", "kuntanii"] }
    )
    expect(r).toEqual([
      { phone: "0551111111", verified: true, approvedBy: "xpress" },
      { phone: "0552222222", verified: true, approvedBy: "kuntanii" },
      { phone: "0553333333", verified: false, approvedBy: null },
    ])
  })

  it("approvedBy is null when the check is disabled (fail open)", async () => {
    const r = await checkCustomerFacingVerificationDetailed(["0551111111"], [], { enabled: false, providers: [] })
    expect(r).toEqual([{ phone: "0551111111", verified: true, approvedBy: null }])
  })
})
