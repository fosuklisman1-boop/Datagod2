import { NON_MTN_CAPABLE } from "./factory"

describe("NON_MTN_CAPABLE", () => {
  it("includes agentportalgh for Telecel", () => {
    expect(NON_MTN_CAPABLE.telecel_provider_selection).toContain("agentportalgh")
  })

  it("includes agentportalgh for AT-iShare", () => {
    expect(NON_MTN_CAPABLE.at_ishare_provider_selection).toContain("agentportalgh")
  })

  it("EXCLUDES agentportalgh for AT-BigTime", () => {
    expect(NON_MTN_CAPABLE.at_bigtime_provider_selection).not.toContain("agentportalgh")
  })

  it("keeps the original 4 providers capable for all three networks", () => {
    for (const key of ["telecel_provider_selection", "at_ishare_provider_selection", "at_bigtime_provider_selection"]) {
      expect(NON_MTN_CAPABLE[key]).toEqual(expect.arrayContaining(["datakazina", "xpress", "eazyghdata", "codecraft"]))
    }
  })
})
