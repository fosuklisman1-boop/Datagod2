import { describe, it, expect } from "vitest"
import { slotFor, type V2KeySummary } from "./key-slots"

function key(over: Partial<V2KeySummary>): V2KeySummary {
  return {
    id: "k1",
    key_type: "standard",
    environment: "live",
    status: "active",
    key_prefix: "dg2_live_abcdef0",
    last_used_at: null,
    created_at: "2026-10-20T10:00:00.000Z",
    ...over,
  }
}

describe("slotFor", () => {
  it("is none when there is no key for the type and environment", () => {
    const keys = [key({ environment: "test" }), key({ key_type: "commission" })]
    expect(slotFor(keys, "standard", "live")).toEqual({ state: "none", key: null })
  })

  it("reads a pending live key as pending, never active", () => {
    const k = key({ status: "pending" })
    expect(slotFor([k], "standard", "live")).toEqual({ state: "pending", key: k })
  })

  it("reads an active key as active", () => {
    const k = key({ environment: "test", key_prefix: "dg2_test_0000000" })
    expect(slotFor([k], "standard", "test")).toEqual({ state: "active", key: k })
  })

  it("reads a revoked-only slot as revoked", () => {
    const k = key({ status: "revoked" })
    expect(slotFor([k], "standard", "live")).toEqual({ state: "revoked", key: k })
  })

  it("prefers a live (pending or active) key over a newer revoked one", () => {
    const pending = key({ id: "a", status: "pending", created_at: "2026-10-20T10:00:00.000Z" })
    const revoked = key({ id: "b", status: "revoked", created_at: "2026-10-21T10:00:00.000Z" })
    expect(slotFor([revoked, pending], "standard", "live").key?.id).toBe("a")
  })

  it("picks the newest when several non-revoked keys exist", () => {
    const older = key({ id: "old", created_at: "2026-10-01T00:00:00.000Z" })
    const newer = key({ id: "new", status: "pending", created_at: "2026-10-02T00:00:00.000Z" })
    expect(slotFor([older, newer], "standard", "live")).toEqual({ state: "pending", key: newer })
  })

  it("never reads an unknown status as active", () => {
    const k = key({ status: "weird" as V2KeySummary["status"] })
    expect(slotFor([k], "standard", "live").state).toBe("revoked")
  })
})
