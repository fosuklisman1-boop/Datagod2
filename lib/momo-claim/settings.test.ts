import { loadMomoClaimSettings, isStrictlyPhoneVerified } from "./settings"

type Row = { key: string; value: unknown }

function settingsClient(rows: Row[] | null, error: unknown = null, calls?: { n: number; keys?: string[] }) {
  return {
    from: (table: string) => {
      if (table !== "admin_settings") throw new Error(`Unexpected table: ${table}`)
      return {
        select: () => ({
          in: (_col: string, keys: string[]) => {
            if (calls) {
              calls.n++
              calls.keys = keys
            }
            return Promise.resolve({ data: rows, error })
          },
        }),
      }
    },
  } as never
}

const v = (key: string, value: unknown): Row => ({ key, value: { value } })

describe("loadMomoClaimSettings", () => {
  it("applies defaults for missing keys", async () => {
    const s = await loadMomoClaimSettings(settingsClient([]))
    expect(s).toEqual({
      enabled: false,
      accounts: [],
      accountName: "",
      feeCustomerPercent: 0,
      feeDealerPercent: 0,
      minNetPesewas: 1000,
      maxSentPesewas: 200000,
      senderAllowlist: ["MobileMoney"],
      regressionThreshold: 1000000,
      reviewThresholdPesewas: 50000,
      dailyCapPesewas: 300000,
      source: "db",
    })
  })

  it("source is 'defaults' whenever the DB read errored, returned no array, or threw", async () => {
    expect((await loadMomoClaimSettings(settingsClient(null, { message: "boom" }))).source).toBe("defaults")
    expect((await loadMomoClaimSettings(settingsClient(null))).source).toBe("defaults")
    const t = await loadMomoClaimSettings({
      from: () => {
        throw new Error("down")
      },
    } as never)
    expect(t.source).toBe("defaults")
    expect((await loadMomoClaimSettings(settingsClient([v("momo_claim_enabled", true)]))).source).toBe("db")
  })

  it("reads everything in one query", async () => {
    const calls = { n: 0 } as { n: number; keys?: string[] }
    await loadMomoClaimSettings(settingsClient([], null, calls))
    expect(calls.n).toBe(1)
    expect(calls.keys).toContain("momo_claim_enabled")
    expect(calls.keys).toHaveLength(11)
  })

  it("enabled only for exact boolean true", async () => {
    for (const bad of ["true", 1, null, "yes", {}]) {
      const s = await loadMomoClaimSettings(settingsClient([v("momo_claim_enabled", bad)]))
      expect(s.enabled).toBe(false)
    }
    const s = await loadMomoClaimSettings(settingsClient([v("momo_claim_enabled", true)]))
    expect(s.enabled).toBe(true)
    // bare (unwrapped) true is not accepted
    const bare = await loadMomoClaimSettings(settingsClient([{ key: "momo_claim_enabled", value: true }]))
    expect(bare.enabled).toBe(false)
  })

  it("DB error returns defaults with enabled false and does not throw", async () => {
    const s = await loadMomoClaimSettings(settingsClient(null, { message: "boom" }))
    expect(s.enabled).toBe(false)
    expect(s.minNetPesewas).toBe(1000)
    const t = await loadMomoClaimSettings({
      from: () => {
        throw new Error("down")
      },
    } as never)
    expect(t.enabled).toBe(false)
  })

  it("converts GHS to integer pesewas", async () => {
    const s = await loadMomoClaimSettings(
      settingsClient([
        v("momo_claim_enabled", true),
        v("momo_min_claimable", 10.1),
        v("momo_max_claimable", 1999.99),
        v("momo_auto_claim_review_threshold", 0.29),
        v("momo_auto_claim_daily_cap", 4000),
        v("momo_txid_regression_threshold", 5),
      ])
    )
    expect(s.minNetPesewas).toBe(1010)
    expect(s.maxSentPesewas).toBe(199999)
    expect(s.reviewThresholdPesewas).toBe(29)
    expect(s.dailyCapPesewas).toBe(400000)
    expect(s.regressionThreshold).toBe(5)
  })

  it("falls back to defaults for malformed numbers", async () => {
    const s = await loadMomoClaimSettings(
      settingsClient([
        v("momo_min_claimable", "10"),
        v("momo_max_claimable", -5),
        v("momo_auto_claim_review_threshold", null),
        v("momo_auto_claim_daily_cap", Infinity),
        v("momo_txid_regression_threshold", -1),
      ])
    )
    expect(s.minNetPesewas).toBe(1000)
    expect(s.maxSentPesewas).toBe(200000)
    expect(s.reviewThresholdPesewas).toBe(50000)
    expect(s.dailyCapPesewas).toBe(300000)
    expect(s.regressionThreshold).toBe(1000000)
  })

  it("passes through maxSent < minNet", async () => {
    const s = await loadMomoClaimSettings(
      settingsClient([v("momo_min_claimable", 50), v("momo_max_claimable", 20)])
    )
    expect(s.minNetPesewas).toBe(5000)
    expect(s.maxSentPesewas).toBe(2000)
  })

  it("fee percents: valid kept, invalid -> 0", async () => {
    const ok = await loadMomoClaimSettings(
      settingsClient([v("momo_claim_fee_customer", 1.5), v("momo_claim_fee_dealer", 100)])
    )
    expect(ok.feeCustomerPercent).toBe(1.5)
    expect(ok.feeDealerPercent).toBe(100)
    for (const bad of ["2", -1, 100.1, null, NaN]) {
      const s = await loadMomoClaimSettings(
        settingsClient([v("momo_claim_fee_customer", bad), v("momo_claim_fee_dealer", bad)])
      )
      expect(s.feeCustomerPercent).toBe(0)
      expect(s.feeDealerPercent).toBe(0)
    }
  })

  it("accounts: drops malformed entries, non-array -> []", async () => {
    const s = await loadMomoClaimSettings(
      settingsClient([
        v("momo_payment_accounts", [
          { network: "MTN", number: "0240000000" },
          { network: "MTN" },
          { number: "1" },
          null,
          "x",
          { network: 1, number: "2" },
        ]),
        v("momo_account_name", "Datagod Ltd"),
      ])
    )
    expect(s.accounts).toEqual([{ network: "MTN", number: "0240000000" }])
    expect(s.accountName).toBe("Datagod Ltd")
    const t = await loadMomoClaimSettings(settingsClient([v("momo_payment_accounts", "nope")]))
    expect(t.accounts).toEqual([])
  })

  it("allowlist: trims, filters, falls back when empty/invalid", async () => {
    const s = await loadMomoClaimSettings(
      settingsClient([v("momo_sms_sender_allowlist", [" MobileMoney ", "", "   ", 5, "MTN"])])
    )
    expect(s.senderAllowlist).toEqual(["MobileMoney", "MTN"])
    for (const bad of [[], "x", [1, ""], null]) {
      const t = await loadMomoClaimSettings(settingsClient([v("momo_sms_sender_allowlist", bad)]))
      expect(t.senderAllowlist).toEqual(["MobileMoney"])
    }
  })
})

function usersClient(result: { data: unknown; error: unknown } | "throw") {
  return {
    from: (table: string) => {
      if (table !== "users") throw new Error(`Unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => (result === "throw" ? Promise.reject(new Error("x")) : Promise.resolve(result)),
          }),
        }),
      }
    },
  } as never
}

describe("isStrictlyPhoneVerified", () => {
  it("true only when phone_verified is exactly true", async () => {
    expect(await isStrictlyPhoneVerified(usersClient({ data: { phone_verified: true }, error: null }), "u")).toBe(true)
    for (const bad of [false, null, "true", 1, undefined]) {
      expect(
        await isStrictlyPhoneVerified(usersClient({ data: { phone_verified: bad }, error: null }), "u")
      ).toBe(false)
    }
  })
  it("false on error, missing row, or throw", async () => {
    expect(await isStrictlyPhoneVerified(usersClient({ data: null, error: { message: "e" } }), "u")).toBe(false)
    expect(await isStrictlyPhoneVerified(usersClient({ data: null, error: null }), "u")).toBe(false)
    expect(await isStrictlyPhoneVerified(usersClient("throw"), "u")).toBe(false)
  })
})
