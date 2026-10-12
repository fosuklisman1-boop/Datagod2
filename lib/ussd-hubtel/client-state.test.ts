import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { CLIENT_STATE_MAX_LENGTH, CLIENT_STATE_TTL_SECONDS, clientStateStep, decodeClientState, encodeClientState } from "./client-state"
import type { HubtelSession } from "./types"

const s: HubtelSession = { mode: "shop", step: "SHOP_DATA_RECIPIENT", dialingPhone: "+233200585542", platform: "USSD", shopId: "shop-1", bundleId: "b1", bundlePrice: 4.5 }

describe("ClientState snapshot", () => {
  beforeEach(() => { vi.stubEnv("HUBTEL_WEBHOOK_SECRET", "test-secret") })
  afterEach(() => { vi.unstubAllEnvs() })

  it("round-trips for the same session and keeps the step readable", () => {
    const v = encodeClientState("S1", s)
    expect(v.startsWith("SHOP_DATA_RECIPIENT|")).toBe(true)
    expect(clientStateStep(v)).toBe("SHOP_DATA_RECIPIENT")
    expect(decodeClientState(v, "S1")).toEqual(s)
  })
  it("rejects another session's snapshot", () => {
    expect(decodeClientState(encodeClientState("S1", s), "S2")).toBeNull()
  })
  it("rejects a tampered snapshot (e.g. a lowered price)", () => {
    const v = encodeClientState("S1", s)
    const [body, sig] = [v.slice(0, v.lastIndexOf(".")), v.slice(v.lastIndexOf(".") + 1)]
    const forged = Buffer.from(JSON.stringify({ s: "S1", e: 9e9, d: { ...s, bundlePrice: 0.01 } })).toString("base64url")
    expect(decodeClientState(`SHOP_DATA_RECIPIENT|${forged}.${sig}`, "S1")).toBeNull()
    expect(decodeClientState(`${body}.AAAAAAAAAAAAAAAAAAAAAA`, "S1")).toBeNull()
  })
  it("rejects an expired snapshot", () => {
    const t = 1_700_000_000_000
    const v = encodeClientState("S1", s, t)
    expect(decodeClientState(v, "S1", t + (CLIENT_STATE_TTL_SECONDS - 1) * 1000)).toEqual(s)
    expect(decodeClientState(v, "S1", t + (CLIENT_STATE_TTL_SECONDS + 1) * 1000)).toBeNull()
  })
  it("a snapshot signed with another secret is rejected", () => {
    const v = encodeClientState("S1", s)
    vi.stubEnv("HUBTEL_WEBHOOK_SECRET", "other")
    expect(decodeClientState(v, "S1")).toBeNull()
  })
  it("too large: falls back to the bare step name", () => {
    const big = { ...s, rcMyOrders: Array.from({ length: 60 }, (_, i) => ({ id: `id-${i}-xxxxxxxxxxxxxxxx`, exam_board: "WASSCE", reference_code: "REF-0000000", created_at: "2026-10-12T00:00:00Z" })) }
    const v = encodeClientState("S1", big)
    expect(v).toBe("SHOP_DATA_RECIPIENT")
    expect(v.length).toBeLessThanOrEqual(CLIENT_STATE_MAX_LENGTH)
  })
  it("bare step names and garbage never decode", () => {
    expect(decodeClientState("SHOP_ENTER_CODE", "S1")).toBeNull()
    expect(decodeClientState("", "S1")).toBeNull()
    expect(decodeClientState("x|y.z", "S1")).toBeNull()
  })
})

describe("ClientState without the secret", () => {
  afterEach(() => { vi.unstubAllEnvs() })
  it("is the bare step name and never decodes", () => {
    vi.stubEnv("HUBTEL_WEBHOOK_SECRET", "")
    expect(encodeClientState("S1", s)).toBe("SHOP_DATA_RECIPIENT")
    expect(decodeClientState("SHOP_DATA_RECIPIENT", "S1")).toBeNull()
  })
})
