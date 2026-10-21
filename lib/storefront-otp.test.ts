// readStorefrontOtpRequiredStrict: the storefront OTP switch for fail-closed callers (WhatsApp bots' paying number).
// Unlike isStorefrontOtpRequired (fails to last-known / off), it throws when the switch cannot be read.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const h = vi.hoisted(() => ({
  reads: 0,
  next: [] as ({ value?: unknown } | null | Error)[],
}))

vi.mock("./security-log", () => ({ logSecurityEvent: vi.fn() }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table !== "admin_settings") throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_c: string, key: string) => ({
            async maybeSingle() {
              if (key !== "storefront_otp_required") throw new Error(`unexpected key ${key}`)
              h.reads++
              const n = h.next.length > 1 ? h.next.shift()! : h.next[0]
              if (n instanceof Error) return { data: null, error: n }
              return { data: n, error: null }
            },
          }),
        }),
      }
    },
  }),
}))

import { invalidateStorefrontOtpCache, isStorefrontOtpRequired, readStorefrontOtpRequiredStrict } from "./storefront-otp"

const T0 = Date.parse("2026-10-21T10:00:00Z")

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(T0)
  invalidateStorefrontOtpCache()
  h.reads = 0
  h.next = [null]
})
afterEach(() => { vi.useRealTimers() })

describe("readStorefrontOtpRequiredStrict", () => {
  it("on only when stored enabled === true", async () => {
    for (const [row, want] of [
      [{ value: { enabled: true } }, true], [{ value: { enabled: "true" } }, false], [{ value: {} }, false], [null, false],
    ] as const) {
      invalidateStorefrontOtpCache()
      h.next = [row as any]
      expect(await readStorefrontOtpRequiredStrict()).toBe(want)
    }
  })

  it("a read error THROWS (no fallback to off), even with no cache ever", async () => {
    h.next = [new Error("timeout")]
    await expect(readStorefrontOtpRequiredStrict()).rejects.toBeTruthy()
    // the lenient reader keeps its legacy behaviour (never read => off)
    expect(await isStorefrontOtpRequired()).toBe(false)
  })

  it("a read error after the cache expired throws instead of using the stale value", async () => {
    h.next = [{ value: { enabled: false } }, new Error("timeout")]
    expect(await readStorefrontOtpRequiredStrict()).toBe(false)
    vi.setSystemTime(T0 + 31_000)
    await expect(readStorefrontOtpRequiredStrict()).rejects.toBeTruthy()
  })

  it("uses and refreshes the shared 30s cache", async () => {
    h.next = [{ value: { enabled: true } }]
    expect(await readStorefrontOtpRequiredStrict()).toBe(true)
    expect(await readStorefrontOtpRequiredStrict()).toBe(true)
    expect(await isStorefrontOtpRequired()).toBe(true)
    expect(h.reads).toBe(1)
    vi.setSystemTime(T0 + 31_000)
    h.next = [{ value: { enabled: false } }]
    expect(await readStorefrontOtpRequiredStrict()).toBe(false)
    expect(h.reads).toBe(2)
  })
})
