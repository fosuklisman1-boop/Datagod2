import { decideWhitelistOutcomes } from "./phone-verify-whitelist-processor"

const NOW = "2026-08-10T00:00:00.000Z"

describe("decideWhitelistOutcomes", () => {
  it("routes a non-MTN row to not_applicable without needing a whitelist result", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 1, phone_number: "0201111111", network: "TELECEL" }],
      new Map(),
      NOW
    )
    expect(decision.notApplicableIds).toEqual([1])
    expect(decision.invalidIds).toEqual([])
    expect(decision.verifiedByProvider.size).toBe(0)
    expect(decision.registryUpserts).toEqual([])
  })

  it("groups an allowed MTN row under its allowing provider", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 2, phone_number: "0551111111", network: "MTN" }],
      new Map([["0551111111", { allowed: true, allowedBy: "xpress" }]]),
      NOW
    )
    expect(decision.verifiedByProvider.get("xpress")).toEqual([2])
    expect(decision.registryUpserts).toEqual([
      { phone: "0551111111", whitelist_status: "allowed", whitelist_allowed_by: "xpress", whitelist_last_checked: NOW, whitelist_retry_count: 0 },
    ])
  })

  it("marks a blocked MTN row invalid with no allowed_by", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 3, phone_number: "0552222222", network: "MTN" }],
      new Map([["0552222222", { allowed: false }]]),
      NOW
    )
    expect(decision.invalidIds).toEqual([3])
    expect(decision.registryUpserts).toEqual([
      { phone: "0552222222", whitelist_status: "blocked", whitelist_allowed_by: null, whitelist_last_checked: NOW, whitelist_retry_count: 0 },
    ])
  })

  it("treats an MTN row missing from the results map as blocked (defensive default)", () => {
    const decision = decideWhitelistOutcomes(
      [{ id: 4, phone_number: "0553333333", network: "MTN" }],
      new Map(),
      NOW
    )
    expect(decision.invalidIds).toEqual([4])
  })

  it("groups multiple MTN rows allowed by different providers separately", () => {
    const decision = decideWhitelistOutcomes(
      [
        { id: 5, phone_number: "0551111111", network: "MTN" },
        { id: 6, phone_number: "0552222222", network: "MTN" },
      ],
      new Map([
        ["0551111111", { allowed: true, allowedBy: "xpress" }],
        ["0552222222", { allowed: true, allowedBy: "codecraft" }],
      ]),
      NOW
    )
    expect(decision.verifiedByProvider.get("xpress")).toEqual([5])
    expect(decision.verifiedByProvider.get("codecraft")).toEqual([6])
  })
})
