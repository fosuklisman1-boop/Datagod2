import { describe, expect, it, vi } from "vitest"
import { initializeFee, initializeSurface, isVerifiedWebPayer, momoPhoneText, pickHubtelReplay, HUBTEL_REPLAY_LOOKBACK_MS, HUBTEL_REPLAY_WINDOW_MS } from "./initialize-gateway"

const base = { storefrontType: null, botOrder: false, orderId: null, orderType: undefined, isTopup: false, isUpgrade: false }

describe("initializeSurface", () => {
  it("top-up => wallet_topup", () => {
    expect(initializeSurface({ ...base, isTopup: true })).toBe("wallet_topup")
  })
  it("dealer upgrade => dashboard_direct", () => {
    expect(initializeSurface({ ...base, isUpgrade: true })).toBe("dashboard_direct")
  })
  it("results-check service => dashboard_direct", () => {
    expect(initializeSurface({ ...base, orderId: "o1", orderType: "results_check_service" })).toBe("dashboard_direct")
  })
  it("shop orders (data, airtime, results checker, storefront commission) => storefront", () => {
    for (const orderType of [undefined, "data", "airtime", "results_checker"]) {
      expect(initializeSurface({ ...base, orderId: "o1", orderType })).toBe("storefront")
    }
    expect(initializeSurface({ ...base, orderId: "o1", orderType: "cs_bill", storefrontType: "cs_bill" })).toBe("storefront")
  })
  it("a bot commission row maps to nothing (Task 6), so today's path is kept", () => {
    expect(initializeSurface({ ...base, orderId: "o1", orderType: "cs_bill", storefrontType: "cs_bill", botOrder: true })).toBeNull()
  })
  it("a request that is none of these maps to nothing", () => {
    expect(initializeSurface(base)).toBeNull()
  })
})

describe("initializeFee", () => {
  it("no surface => today's fee", () => {
    expect(initializeFee({ surface: null, gateway: "paystack", feeBearer: "merchant", standardFee: 1.5 })).toBe(1.5)
  })
  it("Paystack + customer bearer => today's fee", () => {
    expect(initializeFee({ surface: "wallet_topup", gateway: "paystack", feeBearer: "customer", standardFee: 1.5 })).toBe(1.5)
  })
  it("Paystack + merchant bearer => 0", () => {
    expect(initializeFee({ surface: "wallet_topup", gateway: "paystack", feeBearer: "merchant", standardFee: 1.5 })).toBe(0)
  })
  it("Hubtel => 0 whoever bears it (Hubtel adds its own charge)", () => {
    expect(initializeFee({ surface: "storefront", gateway: "hubtel", feeBearer: "customer", standardFee: 1.5 })).toBe(0)
    expect(initializeFee({ surface: "storefront", gateway: "hubtel", feeBearer: "merchant", standardFee: 1.5 })).toBe(0)
  })
})

describe("isVerifiedWebPayer", () => {
  it("an OTP-verified number passes without reading the user", async () => {
    const own = vi.fn(async () => null)
    expect(await isVerifiedWebPayer("0241234567", { isPhoneOtpVerified: async () => true, ownVerifiedPhone: own })).toBe(true)
    expect(own).not.toHaveBeenCalled()
  })
  it("the logged-in user's own verified number passes, in any format", async () => {
    const deps = { isPhoneOtpVerified: async () => false, ownVerifiedPhone: async () => "233241234567" }
    expect(await isVerifiedWebPayer("0241234567", deps)).toBe(true)
    expect(await isVerifiedWebPayer("+233 24 123 4567", deps)).toBe(true)
  })
  it("someone else's number, no user, or a bad number fails", async () => {
    expect(await isVerifiedWebPayer("0241234567", { isPhoneOtpVerified: async () => false, ownVerifiedPhone: async () => "0559999999" })).toBe(false)
    expect(await isVerifiedWebPayer("0241234567", { isPhoneOtpVerified: async () => false, ownVerifiedPhone: async () => null })).toBe(false)
    expect(await isVerifiedWebPayer("", { isPhoneOtpVerified: async () => true, ownVerifiedPhone: async () => "" })).toBe(false)
  })
  it("a lookup that throws counts as not verified", async () => {
    expect(await isVerifiedWebPayer("0241234567", {
      isPhoneOtpVerified: async () => { throw new Error("db") }, ownVerifiedPhone: async () => { throw new Error("db") },
    })).toBe(false)
  })
})

describe("pickHubtelReplay", () => {
  const now = new Date("2026-11-04T12:00:00Z").getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  it("the newest pending Hubtel row inside 15 minutes", () => {
    const rows = [
      { id: "a", reference: "R-OLD", payment_method: "hubtel", status: "pending", created_at: ago(10 * 60_000) },
      { id: "b", reference: "R-NEW", payment_method: "hubtel", status: "pending", created_at: ago(2 * 60_000) },
    ]
    expect(pickHubtelReplay(rows, now)).toEqual({ id: "b", reference: "R-NEW" })
  })
  it("ignores Paystack rows, non-pending rows and rows older than the window", () => {
    expect(pickHubtelReplay([
      { id: "a", reference: "R1", payment_method: "paystack", status: "pending", created_at: ago(60_000) },
      { id: "b", reference: "R2", payment_method: "hubtel", status: "failed", created_at: ago(60_000) },
      { id: "c", reference: "R3", payment_method: "hubtel", status: "pending", created_at: ago(HUBTEL_REPLAY_WINDOW_MS + 1) },
      { id: "d", reference: "", payment_method: "hubtel", status: "pending", created_at: ago(60_000) },
    ], now)).toBeNull()
  })
  it("nothing => null", () => {
    expect(pickHubtelReplay(null, now)).toBeNull()
  })
  it("past 15 minutes, a row replays only while its own attempt is open and unexpired", () => {
    const row = { id: "a", reference: "R1", payment_method: "hubtel", status: "pending", created_at: ago(30 * 60_000) }
    const later = new Date(now + 60_000).toISOString()
    expect(pickHubtelReplay([row], now, [{ internal_reference: "R1", expires_at: later }])).toEqual({ id: "a", reference: "R1" })
    expect(pickHubtelReplay([row], now, [{ internal_reference: "R1", expires_at: ago(1) }])).toBeNull()
    expect(pickHubtelReplay([row], now, [{ internal_reference: "OTHER", expires_at: later }])).toBeNull()
    expect(pickHubtelReplay([row], now)).toBeNull()
  })
  it("the lookback covers a hosted attempt's 60 minutes", () => {
    expect(HUBTEL_REPLAY_LOOKBACK_MS).toBe(60 * 60_000)
  })
})

describe("momoPhoneText", () => {
  it("strings are trimmed, numbers become text", () => {
    expect(momoPhoneText(" 0241234567 ")).toBe("0241234567")
    expect(momoPhoneText(241234567)).toBe("241234567")
  })
  it("anything else is no number, and never throws", () => {
    for (const v of [{ toString: 1 }, ["0241234567"], null, undefined, true, {}]) expect(momoPhoneText(v)).toBe("")
  })
})
