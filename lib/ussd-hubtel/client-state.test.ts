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
  it("is encrypted: no session field is readable in the value", () => {
    const pii: HubtelSession = { ...s, step: "RC_CHECK_CONFIRM", afaGhCard: "GHA-123456789-0", rcCheckVoucherPin: "998877", rcCheckDob: "01/02/2005" }
    const v = encodeClientState("S1", pii)
    const blob = Buffer.from(v.split("|")[1], "base64url").toString("latin1")
    for (const secret of ["GHA-123456789-0", "998877", "01/02/2005", "+233200585542", "S1"]) {
      expect(v).not.toContain(secret)
      expect(blob).not.toContain(secret)
    }
    expect(decodeClientState(v, "S1")).toEqual(pii)
  })
  it("rejects a tampered snapshot or a swapped step prefix", () => {
    const v = encodeClientState("S1", s)
    const blob = Buffer.from(v.split("|")[1], "base64url")
    blob[20] ^= 1
    expect(decodeClientState(`SHOP_DATA_RECIPIENT|${blob.toString("base64url")}`, "S1")).toBeNull()
    expect(decodeClientState(v.replace("SHOP_DATA_RECIPIENT|", "SHOP_DATA_CONFIRM|"), "S1")).toBeNull()
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
