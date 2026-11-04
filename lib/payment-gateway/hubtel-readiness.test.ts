import { describe, it, expect, afterEach } from "vitest"
import { hubtelReadinessReport } from "./hubtel-readiness"

const NAMES = ["HUBTEL_RELAY_URL", "HUBTEL_RELAY_SECRET", "HUBTEL_COLLECTION_ACCOUNT", "HUBTEL_PAYMENTS_CALLBACK_SECRET"]
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]))

afterEach(() => {
  for (const n of NAMES) {
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
