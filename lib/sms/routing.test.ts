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
    from: (table: string) => table === "tenant_global_settings" ? {
      // The REAL strict loadHubtelBalanceSettings reads through here.
      select: () => ({
        in: () => Promise.resolve(hub.settingsError
          ? { data: null, error: hub.settingsError }
          : { data: [{ key: "sms_hubtel_prefer_manual_balance", value: hub.prefer }], error: null }),
      }),
    } : ({
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
  resolved: { ok: false, error: "relay down" } as any,
  resolveThrows: false,
  resolveCalls: 0,
  prefer: false as unknown,
  settingsError: null as unknown,
}))
vi.mock("./wholesale", () => ({
  resolveHubtelBalance: () => {
    hub.resolveCalls++
    return hub.resolveThrows ? Promise.reject(new Error("boom")) : Promise.resolve(hub.resolved)
  },
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
    hub.resolved = { ok: false, error: "relay down" }
    hub.resolveThrows = false
    hub.resolveCalls = 0
    hub.prefer = false
    hub.settingsError = null
  })

  describe("prefer-manual on (relay reads a different wallet)", () => {
    it("relay healthy but manual estimate NOT computable → refused with the manual reason", async () => {
      hub.prefer = true
      hub.balance = { ok: true, amountGhs: 0 }
      hub.resolved = { ok: false, error: "manual balance preferred but missing or older than 30 days" }
      const res = await setRoutingConfig({ primary: "hubtel" })
      expect(res.ok).toBe(false)
      expect((res as { error: string }).error).toMatch(/manual balance preferred but missing or older than 30 days/)
      expect(mockSettings.updates).toHaveLength(0)
      expect(hub.balanceCalls).toBe(0)
    })
    it("manual estimate computable → accepted without consulting the relay", async () => {
      hub.prefer = true
      hub.balance = { ok: false, error: "relay down" }
      hub.resolved = { ok: true, amountGhs: 80, source: "manual", manualSetAt: new Date().toISOString(), preferred: true }
      expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(true)
      expect(hub.balanceCalls).toBe(0)
    })
    it("resolver throws → refused", async () => {
      hub.prefer = true
      hub.resolveThrows = true
      expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(false)
    })
  })

  it("settings select returns an error (fresh instance) → refused even though the relay works", async () => {
    hub.settingsError = { message: "connection reset" }
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/connection reset/)
    expect(mockSettings.updates).toHaveLength(0)
    expect(hub.balanceCalls).toBe(0)
  })

  it("an unreadable prefer flag → refused (never treated as off)", async () => {
    hub.prefer = "yes"
    expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(false)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("fallback-only Hubtel never reads the strict settings", async () => {
    hub.settingsError = { message: "down" }
    expect((await setRoutingConfig({ primary: "moolre", fallbacks: ["hubtel"] })).ok).toBe(true)
  })

  it("relay works → accepted without computing a manual estimate", async () => {
    expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(true)
    expect(hub.resolveCalls).toBe(0)
  })

  it("relay /balance down but the manual estimate can be computed → accepted", async () => {
    hub.balance = { ok: false, error: "relay/hubtel 403" }
    hub.resolved = { ok: true, amountGhs: 80, source: "manual", manualSetAt: new Date().toISOString() }
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(true)
    expect(mockSettings.updates.find((u) => u.key === "sms_primary_provider")?.patch.value).toBe("hubtel")
  })

  it("relay down + estimate cannot be computed (stale manual / migration missing) → refused, names the reason + manual option", async () => {
    hub.balance = { ok: false, error: "relay/hubtel 403" }
    hub.resolved = { ok: false, error: "relay/hubtel 403; manual balance estimate unavailable: function sms_hubtel_spend_since does not exist" }
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(false)
    const msg = (res as { error: string }).error
    expect(msg).toMatch(/sms_hubtel_spend_since does not exist/)
    expect(msg).toMatch(/manual Hubtel balance/i)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("relay down + a relay result from the resolver (relay recovered) is also fine", async () => {
    hub.balance = { ok: false, error: "blip" }
    hub.resolved = { ok: true, amountGhs: 10, source: "relay" }
    expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(true)
  })

  it("relay down + the resolver throws → refused (fail closed)", async () => {
    hub.balance = { ok: false, error: "relay/hubtel 403" }
    hub.resolveThrows = true
    const res = await setRoutingConfig({ primary: "hubtel" })
    expect(res.ok).toBe(false)
    expect(mockSettings.updates).toHaveLength(0)
  })

  it("a manual estimate does not bypass the credentials check", async () => {
    hub.creds = false
    hub.resolved = { ok: true, amountGhs: 80, source: "manual", manualSetAt: new Date().toISOString() }
    expect((await setRoutingConfig({ primary: "hubtel" })).ok).toBe(false)
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
