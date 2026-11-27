import { describe, it, expect } from "vitest"
import { nuanceKeys, candidateKeys } from "./keys"

describe("nuanceKeys", () => {
  it("reads NUANCE_API_KEY as account 1 and NUANCE_API_KEY_2..9 as the rest, skipping blanks and gaps", () => {
    const keys = nuanceKeys({ NUANCE_API_KEY: "nk_a", NUANCE_API_KEY_2: "nk_b", NUANCE_API_KEY_3: " ", NUANCE_API_KEY_4: "nk_d", NUANCE_API_KEY_10: "nk_x" })
    expect(keys).toEqual([{ index: 1, key: "nk_a" }, { index: 2, key: "nk_b" }, { index: 4, key: "nk_d" }])
  })
  it("returns nothing when no key is set", () => {
    expect(nuanceKeys({})).toEqual([])
  })
})

describe("candidateKeys", () => {
  const keys = [{ index: 1, key: "nk_a" }, { index: 2, key: "nk_b" }, { index: 3, key: "nk_c" }]

  it("uses only account 1 when multiple accounts are switched off, even if it is busy", () => {
    expect(candidateKeys(keys, { multiAccount: false, callsPerKey: 1, openByKey: { 1: 1 } }).map((k) => k.index)).toEqual([1])
  })
  it("uses nothing when switched off and account 1 is missing", () => {
    expect(candidateKeys([{ index: 2, key: "nk_b" }], { multiAccount: false, callsPerKey: 1, openByKey: {} })).toEqual([])
  })
  it("skips accounts whose call slots are full and keeps their order", () => {
    expect(candidateKeys(keys, { multiAccount: true, callsPerKey: 1, openByKey: { 1: 1, 3: 0 } }).map((k) => k.index)).toEqual([2, 3])
  })
  it("respects a higher calls-per-account setting", () => {
    expect(candidateKeys(keys, { multiAccount: true, callsPerKey: 2, openByKey: { 1: 1, 2: 2 } }).map((k) => k.index)).toEqual([1, 3])
  })
  it("returns nothing when every account is full", () => {
    expect(candidateKeys(keys, { multiAccount: true, callsPerKey: 1, openByKey: { 1: 1, 2: 1, 3: 1 } })).toEqual([])
  })
})
