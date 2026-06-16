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

// Import AFTER mock registration
import { parseRoutingConfig, setRoutingConfig, invalidateRoutingCache } from "./routing"

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
