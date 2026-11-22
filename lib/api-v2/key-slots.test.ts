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
    expect(slotFor(keys, "standard", "live")).toEqual({ state: "none", key: null, replacement: null })
  })

  it("reads a pending live key as pending, never active", () => {
    const k = key({ status: "pending" })
    expect(slotFor([k], "standard", "live")).toEqual({ state: "pending", key: k, replacement: null })
  })

  it("reads an active key as active", () => {
    const k = key({ environment: "test", key_prefix: "dg2_test_0000000" })
    expect(slotFor([k], "standard", "test")).toEqual({ state: "active", key: k, replacement: null })
  })

  it("reads a revoked-only slot as revoked", () => {
    const k = key({ status: "revoked" })
    expect(slotFor([k], "standard", "live")).toEqual({ state: "revoked", key: k, replacement: null })
  })

  it("prefers a live (pending or active) key over a newer revoked one", () => {
    const pending = key({ id: "a", status: "pending", created_at: "2026-10-20T10:00:00.000Z" })
    const revoked = key({ id: "b", status: "revoked", created_at: "2026-10-21T10:00:00.000Z" })
    expect(slotFor([revoked, pending], "standard", "live").key?.id).toBe("a")
  })

  it("the active key keeps the slot while a newer pending key waits to replace it (no-outage swap)", () => {
    const older = key({ id: "old", created_at: "2026-10-01T00:00:00.000Z" })
    const newer = key({ id: "new", status: "pending", created_at: "2026-10-02T00:00:00.000Z" })
    expect(slotFor([older, newer], "standard", "live")).toEqual({ state: "active", key: older, replacement: newer })
  })

  it("never reads an unknown status as active", () => {
    const k = key({ status: "weird" as V2KeySummary["status"] })
    expect(slotFor([k], "standard", "live").state).toBe("revoked")
  })

  it("an active key with a newer pending replacement stays active and exposes the replacement", () => {
    const active = key({ id: "old", status: "active", created_at: "2026-10-01T10:00:00.000Z" })
    const pending = key({ id: "new", status: "pending", created_at: "2026-11-22T10:00:00.000Z", request_code: "API-Q2N7RB" })
    const s = slotFor([pending, active], "standard", "live")
    expect(s.state).toBe("active")
    expect(s.key?.id).toBe("old")
    expect(s.replacement?.id).toBe("new")
  })

  it("a pending key alone is pending with no replacement", () => {
    const s = slotFor([key({ status: "pending" })], "standard", "live")
    expect(s.state).toBe("pending")
    expect(s.replacement).toBeNull()
  })

  it("an active key alone has no replacement", () => {
    expect(slotFor([key({ status: "active" })], "standard", "live").replacement).toBeNull()
  })
})
