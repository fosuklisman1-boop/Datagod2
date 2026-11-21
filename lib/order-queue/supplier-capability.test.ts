import { describe, it, expect } from "vitest"
import { getProviderOptionsForNetwork, suppliersForNetworks } from "./supplier-capability"

const values = (opts: { value: string }[]) => opts.map((o) => o.value)

describe("getProviderOptionsForNetwork", () => {
  it("MTN offers the 11 suppliers listed today, in order", () => {
    expect(values(getProviderOptionsForNetwork("MTN"))).toEqual([
      "xpress", "codecraft", "sykes", "datakazina", "eazyghdata", "bisdel",
      "agentportalgh", "apexprime", "bundleportal", "kuntanii", "hubnet",
    ])
  })
  it("AT - iShare offers spfastit but not spfastit_telecel", () => {
    const v = values(getProviderOptionsForNetwork("AT - iShare"))
    expect(v).toContain("spfastit")
    expect(v).not.toContain("spfastit_telecel")
    expect(v).toContain("agentportalgh")
  })
  it("AT - BigTime excludes agentportalgh, apexprime and both spfastit accounts", () => {
    const v = values(getProviderOptionsForNetwork("AT - BigTime"))
    for (const s of ["agentportalgh", "apexprime", "spfastit", "spfastit_telecel"]) expect(v).not.toContain(s)
    expect(v).toContain("bundleportal")
  })
  it("labels are kept", () => {
    expect(getProviderOptionsForNetwork("MTN").find((o) => o.value === "apexprime")?.label).toBe("Apex Prime")
  })
})

describe("suppliersForNetworks", () => {
  it("MTN + AT - BigTime is the intersection (no agentportalgh, apexprime, sykes, kuntanii)", () => {
    const v = values(suppliersForNetworks(["MTN", "AT - BigTime"]))
    for (const s of ["agentportalgh", "apexprime", "sykes", "kuntanii"]) expect(v).not.toContain(s)
    expect(v).toEqual(["xpress", "codecraft", "datakazina", "eazyghdata", "bundleportal", "hubnet"])
  })
  it("Telecel includes spfastit_telecel and excludes spfastit", () => {
    const v = values(suppliersForNetworks(["Telecel"]))
    expect(v).toContain("spfastit_telecel")
    expect(v).not.toContain("spfastit")
  })
  it("no networks ⇒ no suppliers", () => {
    expect(suppliersForNetworks([])).toEqual([])
  })
  it("duplicate networks behave like one", () => {
    expect(suppliersForNetworks(["MTN", "MTN"])).toEqual(getProviderOptionsForNetwork("MTN"))
  })
})
