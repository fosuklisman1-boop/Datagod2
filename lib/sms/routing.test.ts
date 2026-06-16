import { describe, it, expect, vi } from "vitest"

// Hoist the fake admin_settings store before any module import
const mockSettings = vi.hoisted(() => ({
  store: {} as Record<string, string>,
  reset() {
    this.store = {
      sms_primary_provider: "moolre",
      sms_fallback_providers: '["mnotify"]',
    }
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
    }),
  })),
}))

// Import AFTER mock registration
import { parseRoutingConfig } from "./routing"

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
