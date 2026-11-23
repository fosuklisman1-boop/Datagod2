import { describe, it, expect } from "vitest"
import { sandboxOutcomeFor, SANDBOX_TEST_NUMBERS, SANDBOX_FAIL_SUFFIX, SANDBOX_STUCK_SUFFIX } from "./sandbox-outcomes"

describe("sandboxOutcomeFor", () => {
  it("maps the reserved failure pattern to fail and the pending pattern to stuck", () => {
    expect(sandboxOutcomeFor("0240000404")).toBe("fail")
    expect(sandboxOutcomeFor("0540000404")).toBe("fail")
    expect(sandboxOutcomeFor("0200000202")).toBe("stuck")
  })
  it("returns null for everything else", () => {
    for (const v of ["0240000405", "024000404", "02400004040", "+233240000404", "", "0440000404", "0240000204"]) {
      expect(sandboxOutcomeFor(v)).toBeNull()
    }
  })
  it("every listed test number maps to its own outcome", () => {
    expect(SANDBOX_FAIL_SUFFIX).toBe("0000404")
    expect(SANDBOX_STUCK_SUFFIX).toBe("0000202")
    expect(SANDBOX_TEST_NUMBERS.fail).toEqual(["0240000404", "0200000404", "0270000404"])
    expect(SANDBOX_TEST_NUMBERS.stuck).toEqual(["0240000202", "0200000202", "0270000202"])
    for (const n of SANDBOX_TEST_NUMBERS.fail) expect(sandboxOutcomeFor(n)).toBe("fail")
    for (const n of SANDBOX_TEST_NUMBERS.stuck) expect(sandboxOutcomeFor(n)).toBe("stuck")
  })
})
