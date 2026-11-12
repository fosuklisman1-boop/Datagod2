import { describe, it, expect } from "vitest"
import { parsePurgeArgs, PURGE_CONFIRM_VALUE } from "./support-purge-cli"

const OK = { PURGE_CONFIRM: "DELETE-RESOLVED-COMPLAINTS" }

describe("parsePurgeArgs", () => {
  it("defaults to a dry run with no arguments, whatever the environment says", () => {
    expect(parsePurgeArgs([], {})).toEqual({ mode: "dry" })
    expect(parsePurgeArgs([], OK)).toEqual({ mode: "dry" })
  })

  it("applies only with --apply and the exact confirmation", () => {
    expect(PURGE_CONFIRM_VALUE).toBe("DELETE-RESOLVED-COMPLAINTS")
    expect(parsePurgeArgs(["--apply"], OK)).toEqual({ mode: "apply" })
  })

  it("rejects --apply with a missing or wrong confirmation", () => {
    for (const env of [{}, { PURGE_CONFIRM: undefined }, { PURGE_CONFIRM: "" }, { PURGE_CONFIRM: "yes" }, { PURGE_CONFIRM: "delete-resolved-complaints" }, { PURGE_CONFIRM: " DELETE-RESOLVED-COMPLAINTS" }]) {
      expect(parsePurgeArgs(["--apply"], env)).toHaveProperty("error")
    }
  })

  it("rejects near-miss and unknown arguments, even with the right confirmation", () => {
    for (const a of ["--Apply", "-apply", "apply", "--apply=true", "--dry", "--force", ""]) {
      expect(parsePurgeArgs([a], OK)).toHaveProperty("error")
    }
  })

  it("rejects any extra argument", () => {
    expect(parsePurgeArgs(["--apply", "--apply"], OK)).toHaveProperty("error")
    expect(parsePurgeArgs(["--apply", "x"], OK)).toHaveProperty("error")
    expect(parsePurgeArgs(["x", "--apply"], OK)).toHaveProperty("error")
  })
})
