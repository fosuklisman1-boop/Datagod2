import {
  findExistingMoolreNumbers,
  findRecentWhitelistChecks,
  isWhitelistResultCovered,
  buildMoolreRows,
  buildWhitelistRows,
} from "./phone-verify-upload"

function fakeSupabase(rows: any[]) {
  return {
    from() {
      return {
        select() {
          return {
            in() { return this },
            gte() { return this },
            order() { return this },
            range: () => Promise.resolve({ data: rows, error: null }),
          }
        },
      }
    },
  } as any
}

describe("findExistingMoolreNumbers", () => {
  it("maps a phone to the best (non-null) account name seen across rows", async () => {
    const fake = fakeSupabase([
      { phone_number: "0551111111", account_name: null },
      { phone_number: "0551111111", account_name: "Kwame Doe" },
    ])
    const result = await findExistingMoolreNumbers(fake, ["0551111111"])
    expect(result.get("0551111111")).toBe("Kwame Doe")
  })

  it("does not include numbers with no history", async () => {
    const fake = fakeSupabase([])
    const result = await findExistingMoolreNumbers(fake, ["0559999999"])
    expect(result.has("0559999999")).toBe(false)
  })
})

describe("isWhitelistResultCovered", () => {
  it("covers an allowed row when the allowing provider is selected", () => {
    expect(isWhitelistResultCovered(
      { status: "allowed", allowedBy: "xpress", checkedProviders: ["xpress"] },
      ["xpress", "codecraft"]
    )).toBe(true)
  })

  it("does not cover an allowed row when the allowing provider is excluded from selection", () => {
    expect(isWhitelistResultCovered(
      { status: "allowed", allowedBy: "xpress", checkedProviders: ["xpress"] },
      ["codecraft"]
    )).toBe(false)
  })

  it("covers a blocked row when every selected provider was already tried", () => {
    expect(isWhitelistResultCovered(
      { status: "blocked", allowedBy: null, checkedProviders: ["xpress", "codecraft"] },
      ["xpress"]
    )).toBe(true)
  })

  it("does not cover a blocked row when a selected provider was never tried", () => {
    expect(isWhitelistResultCovered(
      { status: "blocked", allowedBy: null, checkedProviders: ["xpress"] },
      ["xpress", "codecraft"]
    )).toBe(false)
  })
})

describe("findRecentWhitelistChecks", () => {
  it("includes an allowed row when the allowing provider is in the selected set", async () => {
    const fake = fakeSupabase([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0551111111"], ["xpress", "codecraft"])
    expect(result.get("0551111111")).toEqual({ status: "allowed", allowedBy: "xpress" })
  })

  it("excludes an allowed row when the allowing provider is NOT in the selected set (treated as fresh)", async () => {
    const fake = fakeSupabase([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0551111111"], ["codecraft"])
    expect(result.has("0551111111")).toBe(false)
  })

  it("includes a blocked row only when every selected provider was already tried", async () => {
    const fake = fakeSupabase([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_checked_providers: ["xpress", "codecraft"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0552222222"], ["xpress"])
    expect(result.get("0552222222")).toEqual({ status: "blocked", allowedBy: null })
  })

  it("excludes a blocked row when a selected provider was never tried against it (treated as fresh)", async () => {
    const fake = fakeSupabase([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_checked_providers: ["xpress"], whitelist_last_checked: "2026-08-10T00:00:00Z" },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0552222222"], ["xpress", "codecraft"])
    expect(result.has("0552222222")).toBe(false)
  })

  it("still excludes rows with no resolved allowed/blocked status", async () => {
    const fake = fakeSupabase([
      { phone: "0553333333", whitelist_status: "unchecked", whitelist_allowed_by: null, whitelist_checked_providers: [], whitelist_last_checked: null },
    ])
    const result = await findRecentWhitelistChecks(fake, ["0553333333"], ["xpress"])
    expect(result.has("0553333333")).toBe(false)
  })
})

describe("buildMoolreRows", () => {
  it("marks a known number duplicate with its remembered name", () => {
    const rows = buildMoolreRows(
      [{ phone: "0551111111", network: "MTN" }],
      new Map([["0551111111", "Kwame Doe"]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", account_name: "Kwame Doe", whitelist_provider: null })
  })

  it("marks a new number pending with no name", () => {
    const rows = buildMoolreRows([{ phone: "0552222222", network: "MTN" }], new Map())
    expect(rows[0]).toMatchObject({ status: "pending", account_name: null })
  })
})

describe("buildWhitelistRows", () => {
  it("marks a recently-allowed number duplicate, carrying the provider", () => {
    const rows = buildWhitelistRows(
      [{ phone: "0551111111", network: "MTN" }],
      new Map([["0551111111", { status: "allowed" as const, allowedBy: "xpress" }]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", whitelist_provider: "xpress" })
  })

  it("marks a recently-blocked number duplicate with no provider", () => {
    const rows = buildWhitelistRows(
      [{ phone: "0552222222", network: "MTN" }],
      new Map([["0552222222", { status: "blocked" as const, allowedBy: null }]])
    )
    expect(rows[0]).toMatchObject({ status: "duplicate", whitelist_provider: null })
  })

  it("marks an unchecked/stale number pending regardless of network", () => {
    const rows = buildWhitelistRows([{ phone: "0553333333", network: "TELECEL" }], new Map())
    expect(rows[0]).toMatchObject({ status: "pending", whitelist_provider: null })
  })
})
