import { NON_MTN_CAPABLE, VALID_PROVIDERS, getProviderByName, isValidMtnProviderName } from "./factory"
import { getProviderDisplay } from "./provider-display"

describe("kuntanii wiring", () => {
  it("getProviderByName returns the Kuntanii provider", () => {
    expect(getProviderByName("kuntanii").name).toBe("kuntanii")
  })

  it("is a valid MTN provider", () => {
    expect(VALID_PROVIDERS).toContain("kuntanii")
    expect(isValidMtnProviderName("kuntanii")).toBe(true)
  })

  it("is never NON_MTN_CAPABLE (MTN only)", () => {
    for (const list of Object.values(NON_MTN_CAPABLE)) {
      expect(list).not.toContain("kuntanii")
    }
  })

  it("has a display label", () => {
    expect(getProviderDisplay("kuntanii").label).toBe("Kuntanii")
  })
})

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

  it("includes apexprime for Telecel", () => {
    expect(NON_MTN_CAPABLE.telecel_provider_selection).toContain("apexprime")
  })

  it("includes apexprime for AT-iShare", () => {
    expect(NON_MTN_CAPABLE.at_ishare_provider_selection).toContain("apexprime")
  })

  it("EXCLUDES apexprime for AT-BigTime", () => {
    expect(NON_MTN_CAPABLE.at_bigtime_provider_selection).not.toContain("apexprime")
  })
})
