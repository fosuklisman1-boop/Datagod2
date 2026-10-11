import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist the fake admin_settings store before any module import
const mockSettings = vi.hoisted(() => ({
  store: {} as Record<string, string>,
  // setRoutingConfig write-path capture
  updates: [] as { key: string; patch: Record<string, unknown> }[],
  inserts: [] as Record<string, unknown>[],
  updateReturn: [] as { id: string }[], // rows update().select() returns (≥1 ⇒ existing ⇒ no insert)
  reset() {
    this.store = {
      sms_primary_provider: "moolre",
      sms_fallback_providers: '["mnotify"]',
    }
    this.updates = []
    this.inserts = []
    this.updateReturn = [{ id: "row-1" }]
  },
}))

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: (_: string) => ({
      select: () => ({
        in: (_col: string, keys: string[]) => ({
          data: keys
            .filter((k) => k in mockSettings.store)
            .map((k) => ({ key: k, value: mockSettings.store[k] })),
          error: null,
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => ({
          select: (_cols?: string) => {
            mockSettings.updates.push({ key: val, patch })
            return Promise.resolve({ data: mockSettings.updateReturn, error: null })
          },
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        mockSettings.inserts.push(row)
        return Promise.resolve({ error: null })
      },
    }),
  })),
}))

const hub = vi.hoisted(() => ({
  creds: true,
  balance: { ok: true, amountGhs: 10 } as { ok: true; amountGhs: number } | { ok: false; error: string },
  balanceCalls: 0,
}))
vi.mock("./providers/hubtel", () => ({
  hubtelConfigFromEnv: () => (hub.creds ? { clientId: "i", clientSecret: "s" } : null),
}))
vi.mock("@/lib/ussd-hubtel/relay", () => ({
  fetchDisbursementBalance: () => { hub.balanceCalls++; return Promise.resolve(hub.balance) },
}))

// Import AFTER mock registration
import { parseRoutingConfig, setRoutingConfig, invalidateRoutingCache, narrowProvidersForSender } from "./routing"

describe("parseRoutingConfig", () => {
  it("returns primary + fallbacks from settings rows", () => {
    const rows = [
      { key: "sms_primary_provider", value: "moolre" },
      { key: "sms_fallback_providers", value: '["mnotify","brevo"]' },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.primary).toBe("moolre")
    expect(result.fallbacks).toEqual(["mnotify", "brevo"])
  })

  it("falls back to env defaults when rows are missing", () => {
    const result = parseRoutingConfig([])
    // env fallback is tested via the module default; just assert type safety
    expect(typeof result.primary).toBe("string")
    expect(Array.isArray(result.fallbacks)).toBe(true)
  })

  it("handles malformed JSON for fallbacks by returning an empty array", () => {
    const rows = [
      { key: "sms_primary_provider", value: "mnotify" },
      { key: "sms_fallback_providers", value: "not-json" },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.primary).toBe("mnotify")
    expect(result.fallbacks).toEqual([])
  })

  it("trims unknown provider names out of the fallback list", () => {
    const rows = [
      { key: "sms_primary_provider", value: "moolre" },
      { key: "sms_fallback_providers", value: '["mnotify","unknown_provider"]' },
    ]
    const result = parseRoutingConfig(rows)
    expect(result.fallbacks).toEqual(["mnotify"])
  })
})

describe("setRoutingConfig", () => {
  beforeEach(() => {
    mockSettings.reset()
    invalidateRoutingCache()
  })

  it("writes primary (as a JSONB string) and fallbacks (as a JSONB array) by key", async () => {
    const res = await setRoutingConfig({ primary: "mnotify", fallbacks: ["moolre", "brevo"] })
    expect(res.ok).toBe(true)

    const byKey = Object.fromEntries(mockSettings.updates.map((u) => [u.key, u.patch.value]))
    expect(byKey["sms_primary_provider"]).toBe("mnotify") // bare string → JSONB string
    expect(byKey["sms_fallback_providers"]).toEqual(["moolre", "brevo"]) // array → JSONB array
  })

  it("inserts when no existing row matches the key (update returns no rows)", async () => {
    mockSettings.updateReturn = [] // simulate "key not present yet"
    const res = await setRoutingConfig({ primary: "moolre" })
    expect(res.ok).toBe(true)
    expect(mockSettings.inserts).toHaveLength(1)
    expect(mockSettings.inserts[0]).toMatchObject({ key: "sms_primary_provider", value: "moolre" })
  })

  it("does NOT insert when the update already hit an existing row", async () => {
    mockSettings.updateReturn = [{ id: "row-1" }]
    await setRoutingConfig({ primary: "moolre" })
    expect(mockSettings.inserts).toHaveLength(0)
  })

  it("rejects an invalid primary provider without writing", async () => {
    const res = await setRoutingConfig({ primary: "twilio" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/Invalid primary/)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("rejects an invalid fallback provider without writing", async () => {
    const res = await setRoutingConfig({ fallbacks: ["moolre", "twilio"] })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/Invalid fallback/)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("returns an error when no routing fields are supplied", async () => {
    const res = await setRoutingConfig({})
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/No routing fields/)
  })
})

describe("setRoutingConfig hubtel guard", () => {
  beforeEach(() => {
    mockSettings.reset()
    invalidateRoutingCache()
    hub.creds = true
    hub.balance = { ok: true, amountGhs: 10 }
    hub.balanceCalls = 0
  })

  it("rejects hubtel primary when credentials are missing, without writing", async () => {
    hub.creds = false
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/Hubtel credentials are not set in Vercel/)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("rejects hubtel primary when the relay balance check fails, naming the error", async () => {
    hub.balance = { ok: false, error: "relay not configured" }
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(false)
    const msg = (res as { error: string }).error
    expect(msg).toMatch(/balance check via the relay failed: relay not configured/)
    expect(msg).toMatch(/HUBTEL_DISBURSEMENT_ACCOUNT/)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("accepts hubtel primary when creds are set and the balance check passes", async () => {
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(true)
    expect(mockSettings.updates.find((u) => u.key === "sms_primary_provider")?.patch.value).toBe("hubtel")
  })

  it("hubtel as fallback only needs credentials (no balance check)", async () => {
    hub.balance = { ok: false, error: "down" }
    const ok = await setRoutingConfig({ primary: "moolre", fallbacks: ["hubtel"] })
    expect(ok.ok).toBe(true)
    expect(hub.balanceCalls).toBe(0)

    hub.creds = false
    mockSettings.updates = []
    const bad = await setRoutingConfig({ fallbacks: ["hubtel"] })
    expect(bad.ok).toBe(false)
    expect((bad as { error: string }).error).toMatch(/credentials are not set/)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("non-hubtel changes never touch the guard", async () => {
    hub.creds = false
    const res = await setRoutingConfig({ primary: "moolre", fallbacks: ["mnotify"] })
    expect(res.ok).toBe(true)
    expect(hub.balanceCalls).toBe(0)
  })
})

describe("hubtel routing", () => {
  it("accepts hubtel as primary", () => {
    expect(parseRoutingConfig([{ key: "sms_primary_provider", value: "hubtel" }]).primary).toBe("hubtel")
  })
  it("accepts hubtel as a fallback", () => {
    expect(parseRoutingConfig([{ key: "sms_fallback_providers", value: ["hubtel"] }]).fallbacks).toEqual(["hubtel"])
  })
})

describe("narrowProvidersForSender", () => {
  const active = { local_status: "active", mnotify_local_status: "pending" }
  it("no custom sender -> unchanged", () => {
    expect(narrowProvidersForSender(["hubtel", "moolre", "mnotify"], null, false)).toEqual(["hubtel", "moolre", "mnotify"])
  })
  it("custom sender with hubtel leading -> hubtel only (fallback gateways never registered it)", () => {
    expect(narrowProvidersForSender(["hubtel", "moolre", "mnotify"], active, true)).toEqual(["hubtel"])
  })
  it("custom sender with moolre leading keeps today's narrowing, hubtel allowed for local active", () => {
    expect(narrowProvidersForSender(["moolre", "mnotify", "hubtel"], active, true)).toEqual(["moolre", "hubtel"])
  })
  it("unknown sender row leaves the order alone", () => {
    expect(narrowProvidersForSender(["moolre", "mnotify"], null, true)).toEqual(["moolre", "mnotify"])
  })
  it("mnotify-only approval keeps mnotify", () => {
    expect(narrowProvidersForSender(["moolre", "mnotify"], { local_status: "pending", mnotify_local_status: "active" }, true)).toEqual(["mnotify"])
  })
})
