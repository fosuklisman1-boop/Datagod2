import { describe, it, expect } from "vitest"
import { escapeLike, chunk } from "./admin-log-filter"

describe("escapeLike", () => {
  it("escapes backslash, percent and underscore", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d")
  })
  it("leaves plain text unchanged", () => {
    expect(escapeLike("/api/v2/orders")).toBe("/api/v2/orders")
  })
  it("escapes the backslash first so escapes are not doubled", () => {
    expect(escapeLike("%")).toBe("\\%")
  })
})

describe("chunk", () => {
  it("splits into pieces of at most size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
  it("returns empty for empty input", () => {
    expect(chunk([], 200)).toEqual([])
  })
  it("rejects a non-positive size", () => {
    expect(() => chunk([1], 0)).toThrow()
  })
})
