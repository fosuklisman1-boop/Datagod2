import { describe, it, expect } from "vitest"
import {
  FIRST_TOUCH_KEY,
  buildFirstTouch,
  sanitizeSignupSource,
  readFirstTouch,
  recordFirstTouch,
  countByLanding,
  type SignupSource,
} from "./signup-source"

const NOW = new Date("2026-10-28T12:00:00.000Z")
const DAY = 24 * 60 * 60 * 1000

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
  }
}

const valid: SignupSource = { landing: "/mtn-data", ref: "www.google.com", at: NOW.toISOString() }

describe("buildFirstTouch", () => {
  it("records pathname only, referrer host only and the three utm keys", () => {
    const url = new URL("https://www.datagod.store/mtn-data?utm_source=facebook&utm_medium=social&utm_campaign=oct_26&phone=0241234567&token=abc")
    const s = buildFirstTouch(url, "https://www.google.com/search?q=cheap+data&email=a@b.c", NOW)
    expect(s).toEqual({
      landing: "/mtn-data",
      ref: "www.google.com",
      utm_source: "facebook",
      utm_medium: "social",
      utm_campaign: "oct_26",
      at: NOW.toISOString(),
    })
    expect(JSON.stringify(s)).not.toContain("0241234567")
    expect(JSON.stringify(s)).not.toContain("token")
    expect(JSON.stringify(s)).not.toContain("a@b.c")
  })

  it("returns null for dashboard, admin and auth landings", () => {
    for (const p of ["/dashboard", "/dashboard/data-packages", "/admin", "/admin/settings", "/auth/signup", "/auth"]) {
      expect(buildFirstTouch(new URL(`https://www.datagod.store${p}`), "", NOW)).toBeNull()
    }
  })

  it("does not exclude paths that merely share a prefix", () => {
    expect(buildFirstTouch(new URL("https://www.datagod.store/authors"), "", NOW)?.landing).toBe("/authors")
  })

  it("ref is null when the referrer is empty, invalid or the same site", () => {
    const url = new URL("https://www.datagod.store/")
    expect(buildFirstTouch(url, "", NOW)?.ref).toBeNull()
    expect(buildFirstTouch(url, "not a url", NOW)?.ref).toBeNull()
    expect(buildFirstTouch(url, "https://www.datagod.store/cheapest-data-ghana", NOW)?.ref).toBeNull()
    expect(buildFirstTouch(url, "https://datagod.store/x", NOW)?.ref).toBeNull()
  })

  it("a 10 kB referrer is reduced to its host", () => {
    const longRef = "https://l.facebook.com/l.php?u=" + "x".repeat(10_000)
    const s = buildFirstTouch(new URL("https://www.datagod.store/"), longRef, NOW)
    expect(s?.ref).toBe("l.facebook.com")
  })

  it("drops utm values with characters outside [A-Za-z0-9._-]", () => {
    const url = new URL("https://www.datagod.store/?utm_source=%3Cscript%3Ealert(1)%3C%2Fscript%3E&utm_medium=ok-1")
    const s = buildFirstTouch(url, "", NOW)
    expect(s?.utm_source).toBeUndefined()
    expect(s?.utm_medium).toBe("ok-1")
    expect(JSON.stringify(s)).not.toContain("<")
  })

  it("caps utm values at 60 and landing at 200 characters", () => {
    const url = new URL(`https://www.datagod.store/${"a".repeat(300)}?utm_campaign=${"c".repeat(100)}`)
    const s = buildFirstTouch(url, "", NOW)!
    expect(s.landing.length).toBe(200)
    expect(s.utm_campaign).toBe("c".repeat(60))
  })
})

describe("sanitizeSignupSource", () => {
  it("accepts a valid object and keeps only known fields", () => {
    expect(sanitizeSignupSource({ ...valid, utm_source: "google", evil: "x" })).toEqual({ ...valid, utm_source: "google" })
  })

  it("rejects non-objects, missing landing and unparseable dates", () => {
    expect(sanitizeSignupSource(null)).toBeNull()
    expect(sanitizeSignupSource("x")).toBeNull()
    expect(sanitizeSignupSource([valid])).toBeNull()
    expect(sanitizeSignupSource({ ...valid, landing: 5 })).toBeNull()
    expect(sanitizeSignupSource({ ...valid, landing: "mtn-data" })).toBeNull()
    expect(sanitizeSignupSource({ ...valid, at: "yesterday-ish" })).toBeNull()
    expect(sanitizeSignupSource({ ...valid, at: undefined })).toBeNull()
  })

  it("rejects hostile landing values and drops hostile ref/utm values", () => {
    expect(sanitizeSignupSource({ ...valid, landing: "/<script>alert(1)</script>" })).toBeNull()
    const s = sanitizeSignupSource({ ...valid, ref: "evil.com/<img>", utm_source: "<script>", utm_medium: 42 })
    expect(s).toEqual({ ...valid, ref: null })
  })

  it("truncates an oversized landing and ignores an oversized ref", () => {
    const s = sanitizeSignupSource({ ...valid, landing: "/" + "a".repeat(5000), ref: "a".repeat(5000) + ".com" })!
    expect(s.landing.length).toBe(200)
    expect(s.ref).toBeNull()
  })
})

describe("readFirstTouch / recordFirstTouch", () => {
  it("returns null for empty, non-JSON or invalid storage", () => {
    expect(readFirstTouch(memoryStorage(), NOW)).toBeNull()
    expect(readFirstTouch(memoryStorage({ [FIRST_TOUCH_KEY]: "{not json" }), NOW)).toBeNull()
    expect(readFirstTouch(memoryStorage({ [FIRST_TOUCH_KEY]: JSON.stringify({ landing: 1 }) }), NOW)).toBeNull()
  })

  it("returns null when getItem throws (storage blocked)", () => {
    const throwing = { getItem: () => { throw new Error("SecurityError") } }
    expect(readFirstTouch(throwing, NOW)).toBeNull()
  })

  it("honours the 30-day window", () => {
    const at29 = new Date(NOW.getTime() - 29 * DAY).toISOString()
    const at31 = new Date(NOW.getTime() - 31 * DAY).toISOString()
    expect(readFirstTouch(memoryStorage({ [FIRST_TOUCH_KEY]: JSON.stringify({ ...valid, at: at29 }) }), NOW)?.at).toBe(at29)
    expect(readFirstTouch(memoryStorage({ [FIRST_TOUCH_KEY]: JSON.stringify({ ...valid, at: at31 }) }), NOW)).toBeNull()
  })

  it("treats a far-future timestamp as invalid", () => {
    const future = new Date(NOW.getTime() + 10 * DAY).toISOString()
    expect(readFirstTouch(memoryStorage({ [FIRST_TOUCH_KEY]: JSON.stringify({ ...valid, at: future }) }), NOW)).toBeNull()
  })

  it("writes when nothing valid is stored and never overwrites a valid entry", () => {
    const storage = memoryStorage()
    expect(recordFirstTouch(storage, valid, NOW)).toBe(true)
    expect(JSON.parse(storage.data.get(FIRST_TOUCH_KEY)!)).toEqual(valid)

    const second: SignupSource = { landing: "/cheapest-data-ghana", ref: null, at: NOW.toISOString() }
    expect(recordFirstTouch(storage, second, NOW)).toBe(false)
    expect(JSON.parse(storage.data.get(FIRST_TOUCH_KEY)!)).toEqual(valid)
  })

  it("replaces an expired entry", () => {
    const old = { ...valid, at: new Date(NOW.getTime() - 40 * DAY).toISOString() }
    const storage = memoryStorage({ [FIRST_TOUCH_KEY]: JSON.stringify(old) })
    const fresh: SignupSource = { landing: "/afa", ref: null, at: NOW.toISOString() }
    expect(recordFirstTouch(storage, fresh, NOW)).toBe(true)
    expect(JSON.parse(storage.data.get(FIRST_TOUCH_KEY)!)).toEqual(fresh)
  })

  it("returns false instead of throwing when setItem throws", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded") } }
    expect(recordFirstTouch(storage, valid, NOW)).toBe(false)
  })
})

describe("countByLanding", () => {
  it("counts by landing, maps invalid/null to unknown, sorts desc", () => {
    const rows = [
      { signup_source: valid },
      { signup_source: { ...valid, ref: null } },
      { signup_source: { ...valid, landing: "/afa" } },
      { signup_source: null },
      { signup_source: { landing: "/<x>", at: "nope" } },
      { signup_source: "garbage" },
    ]
    expect(countByLanding(rows)).toEqual([
      { landing: "/mtn-data", count: 2 },
      { landing: "unknown", count: 3 },
      { landing: "/afa", count: 1 },
    ].sort((a, b) => b.count - a.count || a.landing.localeCompare(b.landing)))
  })

  it("returns an empty list for no rows", () => {
    expect(countByLanding([])).toEqual([])
  })
})
