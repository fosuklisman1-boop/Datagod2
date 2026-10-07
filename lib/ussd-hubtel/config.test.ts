import { describe, it, expect } from "vitest"
import { getHubtelUssdConfig, setHubtelUssdConfig, hubtelEnvReady, validateWelcome, DEFAULT_WELCOME,
  validateBrandName, DEFAULT_BRAND } from "./config"

describe("hubtelEnvReady", () => {
  const all = { HUBTEL_WEBHOOK_SECRET: "a", HUBTEL_RELAY_URL: "b", HUBTEL_RELAY_SECRET: "c" }
  it("is ready when all set", () => {
    expect(hubtelEnvReady(all)).toEqual({ ready: true, missing: [] })
  })
  for (const k of Object.keys(all)) {
    it(`reports ${k} missing`, () => {
      const env: Record<string, string | undefined> = { ...all }
      delete env[k]
      expect(hubtelEnvReady(env)).toEqual({ ready: false, missing: [k] })
    })
  }
  it("treats empty string as missing", () => {
    expect(hubtelEnvReady({ ...all, HUBTEL_RELAY_URL: "" })).toEqual({ ready: false, missing: ["HUBTEL_RELAY_URL"] })
  })
})

function fakeSupabase(initial: unknown) {
  let stored = initial
  const client: any = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored === undefined ? null : { value: stored }, error: null }) }) }),
      upsert: async (row: any) => { stored = row.value; return { error: null } },
    }),
  }
  return { client, read: () => stored }
}

describe("hubtel ussd config", () => {
  it("defaults to disabled/main/all visible when unseeded", async () => {
    const { client } = fakeSupabase(undefined)
    expect(await getHubtelUssdConfig(client)).toEqual({
      enabled: false, mode: "main",
      visibility: { data: true, afa: true, airtime: true, resultsChecker: true },
      brandName: "Clingshub",
      welcome: "Welcome to Clingshub",
      welcomeCustom: false,
    })
  })

  it("fills missing fields from defaults and ignores a bad mode", async () => {
    const { client } = fakeSupabase({ enabled: true, mode: "bogus", visibility: { afa: false } })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg.enabled).toBe(true)
    expect(cfg.mode).toBe("main")
    expect(cfg.visibility).toEqual({ data: true, afa: false, airtime: true, resultsChecker: true })
  })

  it("set merges a partial patch and persists", async () => {
    const { client, read } = fakeSupabase({ enabled: false, mode: "main", visibility: { data: true, afa: true, airtime: true, resultsChecker: true } })
    const cfg = await setHubtelUssdConfig(client, { enabled: true, visibility: { airtime: false } })
    expect(cfg).toEqual({
      enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true },
      brandName: "Clingshub", welcome: "Welcome to Clingshub", welcomeCustom: false,
    })
    // Only the custom welcome is stored; the derived text is not persisted.
    expect(read()).toEqual({ enabled: true, mode: "main", visibility: { data: true, afa: true, airtime: false, resultsChecker: true }, brandName: "Clingshub" })
  })

  it("rejects an invalid mode", async () => {
    const { client } = fakeSupabase(undefined)
    await expect(setHubtelUssdConfig(client, { mode: "weird" as any })).rejects.toThrow("invalid mode")
  })
})

describe("welcome message config", () => {
  it("DEFAULT_WELCOME is exactly 'Welcome to Clingshub'", () => {
    expect(DEFAULT_WELCOME).toBe("Welcome to Clingshub")
  })
  it("get returns a valid stored welcome", async () => {
    const { client } = fakeSupabase({ enabled: true, mode: "main", welcome: "Akwaaba to Ama Data" })
    expect((await getHubtelUssdConfig(client)).welcome).toBe("Akwaaba to Ama Data")
  })
  it("get trims a stored welcome", async () => {
    const { client } = fakeSupabase({ welcome: "  Hello there  " })
    expect((await getHubtelUssdConfig(client)).welcome).toBe("Hello there")
  })
  it("get falls back to the default for an invalid stored welcome", async () => {
    for (const welcome of ["", "   ", "x".repeat(61), "a\nb", "Café", "Hi \u{1F31F}", "“Hi”", 42, null, { a: 1 }]) {
      const { client } = fakeSupabase({ welcome })
      expect((await getHubtelUssdConfig(client)).welcome, JSON.stringify(welcome)).toBe(DEFAULT_WELCOME)
    }
  })
  it("set merges a welcome patch, keeps other fields, and persists", async () => {
    const { client, read } = fakeSupabase({ enabled: true, mode: "shop", visibility: { afa: false } })
    const cfg = await setHubtelUssdConfig(client, { welcome: "  Welcome to Ama  " })
    expect(cfg).toEqual({
      enabled: true, mode: "shop", visibility: { data: true, afa: false, airtime: true, resultsChecker: true },
      brandName: "Clingshub", welcome: "Welcome to Ama", welcomeCustom: true,
    })
    expect(read()).toEqual({
      enabled: true, mode: "shop", visibility: { data: true, afa: false, airtime: true, resultsChecker: true },
      brandName: "Clingshub", welcome: "Welcome to Ama",
    })
  })
  it("set without welcome keeps the current one", async () => {
    const { client } = fakeSupabase({ welcome: "Custom hello" })
    expect((await setHubtelUssdConfig(client, { enabled: true })).welcome).toBe("Custom hello")
  })
  it("set rejects an invalid welcome and writes nothing", async () => {
    const { client, read } = fakeSupabase(undefined)
    await expect(setHubtelUssdConfig(client, { welcome: "Café" })).rejects.toThrow(/^invalid welcome: /)
    await expect(setHubtelUssdConfig(client, { welcome: "x".repeat(61) })).rejects.toThrow(/invalid welcome/)
    expect(read()).toBeUndefined()
  })
})

describe("brand name config + derived welcome", () => {
  it("DEFAULT_BRAND is exactly 'Clingshub'", () => {
    expect(DEFAULT_BRAND).toBe("Clingshub")
  })
  it("get: stored valid brand (trimmed) is returned and drives the derived welcome", async () => {
    const { client } = fakeSupabase({ brandName: "  Ama Data  " })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg.brandName).toBe("Ama Data")
    expect(cfg.welcome).toBe("Welcome to Ama Data")
    expect(cfg.welcomeCustom).toBe(false)
  })
  it("get: invalid stored brand falls back to the default", async () => {
    for (const brandName of ["", "  ", "x".repeat(31), "a\nb", "Café", "\u{1F31F}", 7, null, {}]) {
      const { client } = fakeSupabase({ brandName })
      const cfg = await getHubtelUssdConfig(client)
      expect(cfg.brandName, JSON.stringify(brandName)).toBe("Clingshub")
      expect(cfg.welcome).toBe("Welcome to Clingshub")
    }
  })
  it("get: a custom welcome wins over the derived one", async () => {
    const { client } = fakeSupabase({ brandName: "Ama Data", welcome: "Akwaaba!" })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg).toMatchObject({ brandName: "Ama Data", welcome: "Akwaaba!", welcomeCustom: true })
  })
  it("get: legacy stored literal 'Welcome to Clingshub' is NOT custom, so the brand drives the welcome", async () => {
    const { client } = fakeSupabase({ brandName: "Ama Data", welcome: "Welcome to Clingshub" })
    const cfg = await getHubtelUssdConfig(client)
    expect(cfg).toMatchObject({ welcome: "Welcome to Ama Data", welcomeCustom: false })
  })
  it("set: brandName merges, persists, and the derived welcome follows it", async () => {
    const { client, read } = fakeSupabase({ enabled: true })
    const cfg = await setHubtelUssdConfig(client, { brandName: "  Ama Data " })
    expect(cfg).toMatchObject({ enabled: true, brandName: "Ama Data", welcome: "Welcome to Ama Data", welcomeCustom: false })
    expect(read()).toMatchObject({ brandName: "Ama Data" })
    expect(read()).not.toHaveProperty("welcome")
  })
  it("set: brandName change keeps an existing custom welcome", async () => {
    const { client } = fakeSupabase({ welcome: "Akwaaba!" })
    const cfg = await setHubtelUssdConfig(client, { brandName: "Ama Data" })
    expect(cfg).toMatchObject({ brandName: "Ama Data", welcome: "Akwaaba!", welcomeCustom: true })
  })
  it("set: welcome null clears the custom override (back to the derived welcome)", async () => {
    const { client, read } = fakeSupabase({ brandName: "Ama Data", welcome: "Akwaaba!" })
    const cfg = await setHubtelUssdConfig(client, { welcome: null })
    expect(cfg).toMatchObject({ welcome: "Welcome to Ama Data", welcomeCustom: false })
    expect(read()).not.toHaveProperty("welcome")
  })
  it("set: legacy literal welcome is dropped on the next save", async () => {
    const { client, read } = fakeSupabase({ welcome: "Welcome to Clingshub" })
    await setHubtelUssdConfig(client, { enabled: true })
    expect(read()).not.toHaveProperty("welcome")
  })
  it("set: rejects an invalid brandName and writes nothing", async () => {
    const { client, read } = fakeSupabase(undefined)
    await expect(setHubtelUssdConfig(client, { brandName: "Café" })).rejects.toThrow(/^invalid brandName: /)
    await expect(setHubtelUssdConfig(client, { brandName: "x".repeat(31) })).rejects.toThrow(/invalid brandName/)
    expect(read()).toBeUndefined()
  })
})

describe("validateBrandName", () => {
  it("accepts and trims printable ASCII up to 30 chars", () => {
    expect(validateBrandName(" Clingshub ")).toEqual({ ok: true, value: "Clingshub" })
    expect(validateBrandName("x".repeat(30))).toEqual({ ok: true, value: "x".repeat(30) })
    expect(validateBrandName("  " + "y".repeat(30) + "  ")).toEqual({ ok: true, value: "y".repeat(30) })
    expect(validateBrandName("Ama's Data & Co.")).toEqual({ ok: true, value: "Ama's Data & Co." })
  })
  it("rejects empty after trim (the route treats that as a reset)", () => {
    const r = validateBrandName("  ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/empty/i)
  })
  it("rejects more than 30 chars", () => {
    const r = validateBrandName("x".repeat(31))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/30/)
  })
  it("rejects a newline or carriage return", () => {
    for (const s of ["Ama\nData", "Ama\rData"]) {
      const r = validateBrandName(s)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/single line/i)
    }
  })
  it("rejects non-ASCII and names the character", () => {
    const cases: Array<[string, string]> = [["Café", "é"], ["Ama \u{1F31F}", "\u{1F31F}"], ["“Ama”", "“"]]
    for (const [s, ch] of cases) {
      const r = validateBrandName(s)
      expect(r.ok, s).toBe(false)
      if (!r.ok) {
        expect(r.error).toMatch(/special character/i)
        expect(r.error).toContain(ch)
        expect(r.error).toMatch(/^Brand name/)
      }
    }
  })
  it("rejects non-strings", () => {
    for (const v of [undefined, null, 5, false, {}, ["a"]]) {
      const r = validateBrandName(v)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/string/i)
    }
  })
})

describe("validateWelcome", () => {
  it("accepts and trims printable ASCII up to 60 chars", () => {
    expect(validateWelcome("  Welcome to Clingshub ")).toEqual({ ok: true, value: "Welcome to Clingshub" })
    expect(validateWelcome("x".repeat(60))).toEqual({ ok: true, value: "x".repeat(60) })
    expect(validateWelcome(" " + "y".repeat(60) + " ")).toEqual({ ok: true, value: "y".repeat(60) })
    expect(validateWelcome("A-Z a-z 0-9 !@#$%^&*()_+=[]{}|;:'\",.<>/?~`")).toMatchObject({ ok: true })
  })
  it("rejects empty after trim (the route treats that as a reset)", () => {
    const r = validateWelcome("   ")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/empty/i)
  })
  it("rejects more than 60 chars", () => {
    const r = validateWelcome("x".repeat(61))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/60/)
  })
  it("rejects a newline or carriage return", () => {
    for (const s of ["Hello\nWorld", "Hello\rWorld", "Hello\r\nWorld"]) {
      const r = validateWelcome(s)
      expect(r.ok, JSON.stringify(s)).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/single line/i)
    }
  })
  it("rejects non-ASCII (accents, emoji, curly quotes) and names the character", () => {
    const cases: Array<[string, string]> = [["Café Data", "é"], ["Hi \u{1F31F}", "\u{1F31F}"], ["“Hi”", "“"], ["It’s us", "’"]]
    for (const [s, ch] of cases) {
      const r = validateWelcome(s)
      expect(r.ok, s).toBe(false)
      if (!r.ok) {
        expect(r.error).toMatch(/special character/i)
        expect(r.error).toContain(ch)
      }
    }
  })
  it("rejects a tab and other control characters", () => {
    expect(validateWelcome("Hi\tthere").ok).toBe(false)
    expect(validateWelcome("Hi\u0007").ok).toBe(false)
  })
  it("rejects non-strings", () => {
    for (const v of [undefined, null, 5, true, {}, ["a"]]) {
      const r = validateWelcome(v)
      expect(r.ok, String(v)).toBe(false)
      if (!r.ok) expect(r.error).toMatch(/string/i)
    }
  })
})
