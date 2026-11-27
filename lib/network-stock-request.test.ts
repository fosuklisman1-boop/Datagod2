import { describe, it, expect } from "vitest"
import { parseNetworkStockBody } from "./network-stock-request"

describe("parseNetworkStockBody", () => {
  it("accepts an out-of-stock request with a reason", () => {
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: true, reason: "Back at 6pm" })).toEqual({
      ok: true, network: "MTN", outOfStock: true, reason: "Back at 6pm",
    })
  })
  it("accepts null and missing reasons", () => {
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: true, reason: null })).toEqual({
      ok: true, network: "MTN", outOfStock: true, reason: null,
    })
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: true })).toEqual({
      ok: true, network: "MTN", outOfStock: true, reason: undefined,
    })
  })
  it("rejects a non-text reason", () => {
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: true, reason: 5 })).toEqual({ ok: false, error: "reason must be text" })
  })
  it("rejects an unknown network, listing the valid ones", () => {
    const r = parseNetworkStockBody({ network: "Glo", outOfStock: true })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe("network must be one of: MTN, Telecel, AT - iShare, AT - BigTime")
  })
  it("rejects a non-boolean outOfStock", () => {
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: "yes" })).toEqual({ ok: false, error: "outOfStock must be a boolean" })
  })
  it("ignores the reason on a restock", () => {
    expect(parseNetworkStockBody({ network: "MTN", outOfStock: false, reason: "x" })).toEqual({
      ok: true, network: "MTN", outOfStock: false, reason: undefined,
    })
  })
  it("rejects a missing body", () => {
    expect(parseNetworkStockBody(null).ok).toBe(false)
  })
})
