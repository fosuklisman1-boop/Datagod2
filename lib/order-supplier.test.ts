import { describe, it, expect } from "vitest"
import { resolveSupplier } from "./order-supplier"

const rows = [
  { provider: "sykes", created_at: "2026-11-01T10:00:00Z" },
  { provider: "kuntanii", created_at: "2026-11-01T10:05:00Z" },
]

describe("resolveSupplier", () => {
  it("picks the latest known provider for completed orders", () => {
    expect(resolveSupplier(rows, "completed", "auto_mtn")).toEqual({ kind: "supplier", provider: "kuntanii", attemptedOnly: false })
  })
  it("is order-independent (latest by created_at wins)", () => {
    expect(resolveSupplier([...rows].reverse(), "completed", null)).toMatchObject({ provider: "kuntanii" })
  })
  it("marks failed and pending as attemptedOnly", () => {
    expect(resolveSupplier(rows, "failed", null)).toMatchObject({ provider: "kuntanii", attemptedOnly: true })
    expect(resolveSupplier(rows, "pending", null)).toMatchObject({ attemptedOnly: true })
  })
  it("processing, refunded and reversed are not attemptedOnly", () => {
    for (const s of ["processing", "refunded", "reversed"]) {
      expect(resolveSupplier(rows, s, null)).toMatchObject({ attemptedOnly: false })
    }
  })
  it("skips a later unknown provider in favour of the earlier known one", () => {
    const r = [...rows, { provider: "mystery", created_at: "2026-11-01T11:00:00Z" }]
    expect(resolveSupplier(r, "completed", null)).toMatchObject({ provider: "kuntanii" })
  })
  it("sorts an unparseable created_at oldest", () => {
    const good = { provider: "xpress", created_at: "2026-11-01T10:00:00Z" }
    const bad = { provider: "sykes", created_at: "garbage" }
    expect(resolveSupplier([bad, good], "completed", null)).toMatchObject({ provider: "xpress" })
    expect(resolveSupplier([good, bad], "completed", null)).toMatchObject({ provider: "xpress" })
    expect(resolveSupplier([{ provider: "sykes", created_at: null }, good], "completed", null)).toMatchObject({ provider: "xpress" })
  })
  it("returns manual when no rows and fulfillment is manual", () => {
    expect(resolveSupplier([], "completed", "manual")).toEqual({ kind: "manual" })
  })
  it("returns null with no rows and a non-manual method", () => {
    expect(resolveSupplier([], "completed", "auto_mtn")).toBeNull()
    expect(resolveSupplier([], null, null)).toBeNull()
  })
  it("returns null when only unknown providers exist", () => {
    expect(
      resolveSupplier([{ provider: "mystery", created_at: "2026-11-01T10:00:00Z" }, { provider: null, created_at: null }], "completed", null),
    ).toBeNull()
  })
})
