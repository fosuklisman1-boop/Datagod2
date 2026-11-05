import { describe, it, expect, afterEach, beforeEach } from "vitest"
import { hubtelReadinessReport, isHubtelCollectionReady } from "./hubtel-readiness"

const NAMES = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_PAYMENTS_CALLBACK_SECRET"]
const SWITCH = "HUBTEL_COLLECTIONS_ENABLED"
const saved = Object.fromEntries([...NAMES, SWITCH].map((n) => [n, process.env[n]]))

beforeEach(() => {
  delete process.env[SWITCH]
})
afterEach(() => {
  for (const n of [...NAMES, SWITCH]) {
    if (saved[n] === undefined) delete process.env[n]
    else process.env[n] = saved[n]
  }
})

describe("hubtelReadinessReport", () => {
  it("lists HUBTEL_PAYMENTS_CALLBACK_SECRET when it is missing", () => {
    for (const n of NAMES) process.env[n] = "x"
    delete process.env.HUBTEL_PAYMENTS_CALLBACK_SECRET
    expect(hubtelReadinessReport().missing).toContain("HUBTEL_PAYMENTS_CALLBACK_SECRET")
  })

  it("does not list it once set, and returns names only, never values", () => {
    for (const n of NAMES) process.env[n] = "secret-value"
    const { missing } = hubtelReadinessReport()
    expect(missing).not.toContain("HUBTEL_PAYMENTS_CALLBACK_SECRET")
    expect(missing.join(" ")).not.toContain("secret-value")
  })
})

describe("isHubtelCollectionReady", () => {
  it("every env set but the switch unset: not ready, and the report names the switch", () => {
    for (const n of NAMES) process.env[n] = "x"
    expect(isHubtelCollectionReady()).toBe(false)
    expect(hubtelReadinessReport()).toEqual({ ready: false, missing: [SWITCH] })
  })

  it("only the exact string true turns it on", () => {
    for (const n of NAMES) process.env[n] = "x"
    for (const v of ["1", "TRUE", "yes", " true", ""]) {
      process.env[SWITCH] = v
      expect(isHubtelCollectionReady()).toBe(false)
    }
    process.env[SWITCH] = "true"
    expect(isHubtelCollectionReady()).toBe(true)
    expect(hubtelReadinessReport()).toEqual({ ready: true, missing: [] })
  })

  it.each(NAMES)("the switch on but %s missing: not ready", (name) => {
    for (const n of NAMES) process.env[n] = "x"
    process.env[SWITCH] = "true"
    delete process.env[name]
    expect(isHubtelCollectionReady()).toBe(false)
    expect(hubtelReadinessReport().missing).toEqual([name])
  })
})
