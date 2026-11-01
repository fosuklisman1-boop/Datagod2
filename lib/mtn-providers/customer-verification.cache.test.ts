import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: vi.fn() } }))

const providerCalls: string[][] = []
vi.mock("./provider-whitelist", async (importActual) => ({
  ...(await importActual<typeof import("./provider-whitelist")>()),
  WHITELIST_REGISTRY: [
    {
      name: "agentportalgh",
      configured: () => true,
      check: async () => ({ allowed: false, provider: "agentportalgh" }),
      checkBatch: async (m: string[]) => m.map(msisdn => ({ msisdn, allowed: msisdn === "0551111111" })),
      checkBatchStrict: async (m: string[]) => {
        providerCalls.push(m)
        return m.map(msisdn => ({ msisdn, allowed: msisdn === "0551111111" }))
      },
    },
  ],
}))

const cache = new Map<string, boolean>()
vi.mock("./verdict-cache", () => ({
  getCachedVerdicts: vi.fn(async (phones: string[]) => new Map(phones.filter(p => cache.has(p)).map(p => [p, cache.get(p)!]))),
  setCachedVerdicts: vi.fn(async (v: Map<string, boolean>) => { for (const [p, b] of v) cache.set(p, b) }),
}))

import { verifyRecipientsForOrder } from "./customer-verification"
import { setCachedVerdicts } from "./verdict-cache"

const on = { enabled: true, providers: ["agentportalgh"], block_unverified: true }

describe("verifyRecipientsForOrder verdict cache", () => {
  beforeEach(() => {
    cache.clear()
    providerCalls.length = 0
    vi.clearAllMocks()
  })

  it("stores definite verdicts and answers the next call from the cache without asking providers", async () => {
    const first = await verifyRecipientsForOrder(["0559999999"], { settings: on })
    expect(first.blocked).toEqual(["0559999999"])
    expect(providerCalls).toEqual([["0559999999"]])

    const second = await verifyRecipientsForOrder(["0559999999"], { settings: on })
    expect(second.blocked).toEqual(["0559999999"])
    expect(providerCalls).toHaveLength(1)
  })

  it("only checks the numbers the cache doesn't know", async () => {
    cache.set("0559999999", false)
    const r = await verifyRecipientsForOrder(["0559999999", "0551111111"], { settings: on })
    expect(providerCalls).toEqual([["0551111111"]])
    expect(r.verdicts.get("0551111111")).toBe(true)
    expect(r.blocked).toEqual(["0559999999"])
  })

  it("a cached rejection still follows the live toggle: not blocked when blocking is off", async () => {
    cache.set("0559999999", false)
    const r = await verifyRecipientsForOrder(["0559999999"], { settings: { ...on, block_unverified: false } })
    expect(r.blocked).toEqual([])
    expect(r.verdicts.get("0559999999")).toBe(false)
  })

  it("never reads or writes the cache while the feature is off", async () => {
    await verifyRecipientsForOrder(["0559999999"], { settings: { ...on, enabled: false } })
    expect(setCachedVerdicts).not.toHaveBeenCalled()
  })
})
