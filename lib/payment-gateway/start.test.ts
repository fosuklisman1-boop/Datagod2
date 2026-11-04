import { describe, it, expect, vi } from "vitest"
import { startMomoCharge, createStartStore, resolveSurfaceGateway, type StartDeps, type StartStore } from "./start"
import { deriveFromLegacy, type GatewayConfig, type SurfaceConfig } from "./config"
import { HubtelPayInputError, type PaymentStatus, type StartOutcome } from "@/lib/hubtel-pay/client"
import { newHubtelReference } from "@/lib/hubtel-pay/reference"
import type { ChargeMobileMoneyParams } from "@/lib/paystack"

const NOW = new Date("2026-11-04T10:00:00.000Z")
const PARAMS: ChargeMobileMoneyParams = {
  email: "x@example.com",
  amount: 20,
  phone: "0244123456",
  provider: "mtn",
  reference: "order-123",
  metadata: { type: "wallet_topup", user_id: "u1" },
  channel: "ussd",
  purpose: "Data",
  recipient: "0244000000",
  ip: "1.2.3.4",
}
const VERIFIED = { ...PARAMS, verifiedPayer: true }
const OPAQUE = /^[0-9a-f]{32}$/
const FORBIDDEN = /wallet|data|bundle|airtime|sms|upgrade|shop|afa|bill|result|topup|dealer/i

function config(over: Partial<SurfaceConfig> = {}, hubtelFeePercent = 0): GatewayConfig {
  const c = deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
  c.surfaces.ussd = { gateway: "hubtel", mode: "direct", feeBearer: "customer", ...over }
  c.hubtelFeePercent = hubtelFeePercent
  return c
}

function setup(o: {
  config?: GatewayConfig
  ready?: boolean
  outcome?: StartOutcome | (() => Promise<StartOutcome>)
  insertResult?: "error" | "throw"
  closeResult?: "miss" | "throw"
  callbackUrlThrows?: Error
  /** Rows already in the table. */
  seed?: Record<string, any>[]
  /** What the status check reports for an open attempt past expiry. */
  status?: PaymentStatus | (() => Promise<PaymentStatus>)
  /** Forced results for successive inserts, before the real unique check. */
  insertSeq?: ("duplicate" | "error")[]
  findOpenThrows?: boolean
  settledThrows?: boolean
  closeUnansweredResult?: "miss" | "throw"
  claimThrows?: boolean
} = {}) {
  const events: string[] = []
  const rows = new Map<string, any>()
  for (const r of o.seed ?? []) rows.set(r.reference, { ...r })
  const insertSeq = [...(o.insertSeq ?? [])]
  const store: StartStore = {
    async findSettledSibling(internalReference) {
      if (o.settledThrows) throw new Error("db down")
      const hit = [...rows.values()].find((r) => r.internal_reference === internalReference && ["paid", "needs_review"].includes(r.status))
      return hit ? { reference: hit.reference, status: hit.status } : null
    },
    async findOpen(internalReference) {
      if (o.findOpenThrows) throw new Error("db down")
      const hit = [...rows.values()].find((r) => r.internal_reference === internalReference && ["pending", "confirming"].includes(r.status))
      return hit ? { reference: hit.reference, status: hit.status, expires_at: hit.expires_at } : null
    },
    // One synchronous check-and-set, like the single UPDATE in claim_hubtel_payment.
    async claim(reference) {
      events.push("claim")
      if (o.claimThrows) throw new Error("db down")
      const r = rows.get(reference)
      if (!r || r.status !== "pending") return null
      r.status = "confirming"
      r.claimed_at = `claim-${reference}`
      return { reference, claimed_at: r.claimed_at }
    },
    async closeUnanswered(reference, claimedAt, patch) {
      events.push("closeUnanswered")
      if (o.closeUnansweredResult === "throw") throw new Error("db down")
      if (o.closeUnansweredResult === "miss") return false
      const r = rows.get(reference)
      if (!r || r.status !== "confirming" || r.claimed_at !== claimedAt) return false
      Object.assign(r, { status: "failed" }, patch)
      return true
    },
    async insert(row) {
      events.push("insert")
      if (o.insertResult === "throw") throw new Error("db down")
      if (o.insertResult === "error") return "error"
      const forced = insertSeq.shift()
      if (forced) return forced
      for (const r of rows.values()) {
        if (r.internal_reference === row.internal_reference && ["pending", "confirming"].includes(r.status)) return "duplicate"
      }
      rows.set(row.reference, { status: "pending", ...row })
      return "ok"
    },
    async closeRefused(reference, patch) {
      events.push("close")
      if (o.closeResult === "throw") throw new Error("db down")
      if (o.closeResult === "miss") return false
      const r = rows.get(reference)
      if (!r || r.status !== "pending") return false
      Object.assign(r, { status: "failed" }, patch)
      return true
    },
  }
  const outcome = o.outcome ?? { kind: "accepted" as const }
  const receiveMoney = vi.fn(async (_p: any): Promise<StartOutcome> => {
    events.push("receive")
    return typeof outcome === "function" ? outcome() : outcome
  })
  const chargeMobileMoney = vi.fn(async (p: any) => {
    events.push("paystack")
    return { status: "send_otp", reference: p.reference }
  })
  const alert = vi.fn(async (_kind: string, _message: string) => {})
  const statusOption = o.status ?? ({ kind: "not_found", raw: { from: "hubtel" } } as PaymentStatus)
  const checkStatus = vi.fn(async (_reference: string): Promise<PaymentStatus> => {
    events.push("status")
    return typeof statusOption === "function" ? statusOption() : statusOption
  })
  const deps: Partial<StartDeps> = {
    checkStatus,
    getConfig: async () => o.config ?? config(),
    isReady: () => o.ready ?? true,
    chargeMobileMoney,
    receiveMoney,
    store,
    callbackUrl: (ref) => {
      if (o.callbackUrlThrows) throw o.callbackUrlThrows
      return `https://www.example.com/cb?ref=${ref}`
    },
    alert,
    now: () => NOW,
  }
  const onlyRow = () => [...rows.values()][0]
  return { events, rows, onlyRow, deps, receiveMoney, chargeMobileMoney, alert, checkStatus }
}

const refused = (over: Partial<Extract<StartOutcome, { kind: "refused" }>> = {}): StartOutcome =>
  ({ kind: "refused", code: "4000", message: "customer 0244123456 refused", ...over })
const unknown = (over: Partial<Extract<StartOutcome, { kind: "unknown" }>> = {}): StartOutcome =>
  ({ kind: "unknown", code: "no_response", message: "timeout", ...over })

describe("startMomoCharge — surface on Paystack", () => {
  it("passes the params through exactly, no row, returns Paystack's result plus gateway", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    const out = await startMomoCharge("ussd", PARAMS, t.deps)
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(PARAMS)
    expect(out).toEqual({ status: "send_otp", reference: "order-123", gateway: "paystack" })
    expect(t.rows.size).toBe(0)
    expect(t.receiveMoney).not.toHaveBeenCalled()
    expect(t.alert).not.toHaveBeenCalled()
  })

  it("verifiedPayer is stripped before Paystack sees the params", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(PARAMS)
  })

  it("Paystack's error propagates as it does today", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    t.chargeMobileMoney.mockRejectedValueOnce(new Error("Charge failed"))
    await expect(startMomoCharge("ussd", PARAMS, t.deps)).rejects.toThrow("Charge failed")
    expect(t.alert).not.toHaveBeenCalled()
  })

  it("a config read that throws → Paystack, alert", async () => {
    const t = setup()
    t.deps.getConfig = async () => { throw new Error("nope") }
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — Hubtel accepted", () => {
  it("inserts the row before calling Hubtel, with internal_reference, metadata and the rest", async () => {
    const t = setup()
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual(["insert", "receive"])
    const row = t.onlyRow()
    expect(row).toMatchObject({
      internal_reference: "order-123",
      metadata: { type: "wallet_topup", user_id: "u1", gateway: "hubtel" },
      surface: "ussd",
      mode: "direct",
      amount_pesewas: 2000,
      handler_amount_pesewas: null,
      msisdn: "233244123456",
      channel: "mtn-gh",
      expires_at: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    })
    expect(out).toEqual({ status: "pay_offline", reference: "order-123", gateway: "hubtel", hubtelReference: row.reference })
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(t.alert).not.toHaveBeenCalled()
  })

  it("Hubtel sees only the opaque reference, the neutral description and the callback URL for that reference", async () => {
    const t = setup()
    await startMomoCharge("ussd", VERIFIED, t.deps)
    const sent = t.receiveMoney.mock.calls[0][0]
    expect(sent.description).toBe("Payment")
    expect(sent.reference).toBe(t.onlyRow().reference)
    expect(sent.callbackUrl).toBe(`https://www.example.com/cb?ref=${sent.reference}`)
    expect(sent.msisdn).toBe("233244123456")
    expect(sent.channel).toBe("mtn-gh")
    expect(sent.amount).toBe(20)
    expect(JSON.stringify(sent)).not.toContain("order-123")
  })

  it("every reference is opaque and new, including across real newHubtelReference draws", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const t = setup()
      await startMomoCharge("ussd", { ...VERIFIED, reference: `order-${i}` }, t.deps)
      const ref = t.receiveMoney.mock.calls[0][0].reference
      expect(ref).toMatch(OPAQUE)
      expect(ref).not.toMatch(FORBIDDEN)
      seen.add(ref)
    }
    expect(seen.size).toBe(20)
    expect(newHubtelReference()).toMatch(OPAQUE)
  })

  it.each([
    ["mtn", "mtn-gh"],
    ["vod", "vodafone-gh"],
    ["tgo", "tigo-gh"],
  ] as const)("provider %s → channel %s", async (provider, channel) => {
    const t = setup()
    await startMomoCharge("ussd", { ...VERIFIED, provider }, t.deps)
    expect(t.receiveMoney.mock.calls[0][0].channel).toBe(channel)
  })

  it.each(["0244123456", "+233244123456", "233244123456"])("phone %s → msisdn 233244123456", async (phone) => {
    const t = setup()
    await startMomoCharge("ussd", { ...VERIFIED, phone }, t.deps)
    expect(t.receiveMoney.mock.calls[0][0].msisdn).toBe("233244123456")
  })

  it("a float amount is rounded to exact 2 dp before the relay and the row", async () => {
    const t = setup()
    await startMomoCharge("ussd", { ...VERIFIED, amount: 0.1 + 0.2 + 12 }, t.deps)
    expect(t.receiveMoney.mock.calls[0][0].amount).toBe(12.3)
    expect(t.onlyRow().amount_pesewas).toBe(1230)
  })

  it("metadata absent → just the gateway marker", async () => {
    const t = setup()
    const { metadata: _m, ...noMeta } = VERIFIED
    await startMomoCharge("ussd", noMeta, t.deps)
    expect(t.onlyRow().metadata).toEqual({ gateway: "hubtel" })
  })
})

describe("startMomoCharge — fee bearer", () => {
  it("merchant bears: requested amount lowered, handler amount = full price", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 2) })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.receiveMoney.mock.calls[0][0].amount).toBe(19.6)
    expect(t.onlyRow()).toMatchObject({ amount_pesewas: 1960, handler_amount_pesewas: 2000 })
  })

  it("merchant bears: rounds DOWN to 2 dp", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 1.95) })
    await startMomoCharge("ussd", { ...VERIFIED, amount: 3.33 }, t.deps)
    // 333 × 0.9805 = 326.5065 pesewas
    expect(t.receiveMoney.mock.calls[0][0].amount).toBe(3.26)
    expect(t.onlyRow()).toMatchObject({ amount_pesewas: 326, handler_amount_pesewas: 333 })
  })

  it("merchant bears: binary float noise never loses a pesewa (10.00 at 1.1% = 9.89)", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 1.1) })
    await startMomoCharge("ussd", { ...VERIFIED, amount: 10 }, t.deps)
    expect(t.onlyRow().amount_pesewas).toBe(989)
  })

  it("merchant bears at 0%: handler amount still set, requested = price", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 0) })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.onlyRow()).toMatchObject({ amount_pesewas: 2000, handler_amount_pesewas: 2000 })
  })

  it("customer bears: the fee percent changes nothing, handler amount null", async () => {
    const t = setup({ config: config({ feeBearer: "customer" }, 2) })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.onlyRow()).toMatchObject({ amount_pesewas: 2000, handler_amount_pesewas: null })
  })

  it("merchant-lowered amount under 0.10 → Paystack at the full original price, no row", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 50) })
    await startMomoCharge("ussd", { ...VERIFIED, amount: 0.15 }, t.deps)
    expect(t.rows.size).toBe(0)
    expect(t.receiveMoney).not.toHaveBeenCalled()
    expect(t.chargeMobileMoney.mock.calls[0][0].amount).toBe(0.15)
  })
})

describe("startMomoCharge — gates that go to Paystack before anything is sent", () => {
  it.each([
    ["false", false],
    ["undefined (callers must state it)", undefined],
  ])("verifiedPayer %s → Paystack, nothing sent to Hubtel, no row", async (_n, verifiedPayer) => {
    const t = setup()
    const out = await startMomoCharge("ussd", { ...PARAMS, verifiedPayer }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.receiveMoney).not.toHaveBeenCalled()
    expect(t.rows.size).toBe(0)
    expect(t.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(PARAMS)
  })

  it("Hubtel not ready → Paystack, no row, alert", async () => {
    const t = setup({ ready: false })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it.each([0.09, 0.05, 0, Number.NaN])("amount %s under 0.10 → Paystack, no row", async (amount) => {
    const t = setup()
    const out = await startMomoCharge("ussd", { ...VERIFIED, amount }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
  })

  it("exactly 0.10 goes to Hubtel", async () => {
    const t = setup()
    await startMomoCharge("ussd", { ...VERIFIED, amount: 0.1 }, t.deps)
    expect(t.onlyRow().amount_pesewas).toBe(10)
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
  })

  it.each(["024412345", "abcdefghij", ""])("unusable phone %j → Paystack, nothing sent", async (phone) => {
    const t = setup()
    const out = await startMomoCharge("ussd", { ...VERIFIED, phone }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
  })

  it("unmapped provider at runtime → Paystack, nothing sent", async () => {
    const t = setup()
    const out = await startMomoCharge("ussd", { ...VERIFIED, provider: "xyz" as any }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
  })

  it("callback URL unavailable (plain Error) → Paystack, no row, alert", async () => {
    const t = setup({ callbackUrlThrows: new Error("secret not configured") })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — row insert fails", () => {
  it.each(["error", "throw"] as const)("insert %s → nothing sent, Paystack with the caller's params, alert", async (insertResult) => {
    const t = setup({ insertResult })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual(["insert", "paystack"])
    expect(t.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(PARAMS)
    expect(out).toEqual({ status: "send_otp", reference: "order-123", gateway: "paystack" })
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — refused", () => {
  it("row closed failed with refused_at, then Paystack once with the original reference and price", async () => {
    const t = setup({ outcome: refused(), config: config({ feeBearer: "merchant" }, 2) })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual(["insert", "receive", "close", "paystack"])
    const row = t.onlyRow()
    expect(row.status).toBe("failed")
    expect(row.refused_at).toBe(NOW.toISOString())
    expect(row.last_check).toEqual({ start_outcome: { kind: "refused", code: "4000" } })
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney.mock.calls[0][0]).toStrictEqual(PARAMS)
    expect(out).toEqual({ status: "send_otp", reference: "order-123", gateway: "paystack" })
    expect(row.reference).not.toBe("order-123")
  })

  it("an ordinary customer refusal does not alert", async () => {
    const t = setup({ outcome: refused() })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.alert).not.toHaveBeenCalled()
  })

  it.each([
    ["config code", refused({ code: "relay_not_configured" })],
    ["unreachable relay", refused({ code: "relay_unreachable" })],
    ["Hubtel 401", refused({ code: "http_401", upstreamStatus: 401 })],
    ["Hubtel 404", refused({ code: "http_404", upstreamStatus: 404 })],
    ["Hubtel 405", refused({ code: "http_405", upstreamStatus: 405 })],
  ])("%s → alert and fallback", async (_n, outcome) => {
    const t = setup({ outcome })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it.each(["miss", "throw"] as const)("the close write %s → still Paystack (nothing reached Hubtel), alert", async (closeResult) => {
    const t = setup({ outcome: refused(), closeResult })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("Paystack also throwing on the fallback propagates, and the row is already closed", async () => {
    const t = setup({ outcome: refused({ code: "relay_401" }) })
    t.chargeMobileMoney.mockRejectedValueOnce(new Error("Charge failed"))
    await expect(startMomoCharge("ussd", VERIFIED, t.deps)).rejects.toThrow("Charge failed")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.onlyRow().status).toBe("failed")
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — start errors", () => {
  it("HubtelPayInputError → nothing sent: row closed with refused_at, Paystack once, alert", async () => {
    const t = setup({ outcome: async () => { throw new HubtelPayInputError("relay rejected receive input") } })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["insert", "receive", "close", "paystack"])
    expect(t.onlyRow()).toMatchObject({ status: "failed", refused_at: NOW.toISOString() })
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("any OTHER throw from the send is not proof of nothing sent: row stays pending, no Paystack, alert", async () => {
    const t = setup({ outcome: async () => { throw new Error("surprise") } })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out).toMatchObject({ status: "pay_offline", gateway: "hubtel" })
    expect(t.onlyRow().status).toBe("pending")
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — unknown", () => {
  it("row stays pending, Paystack never called, status pay_offline", async () => {
    const t = setup({ outcome: unknown() })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual(["insert", "receive"])
    const row = t.onlyRow()
    expect(row.status).toBe("pending")
    expect(row.refused_at).toBeUndefined()
    expect(out).toEqual({ status: "pay_offline", reference: "order-123", gateway: "hubtel", hubtelReference: row.reference })
    expect(t.alert).not.toHaveBeenCalled()
  })

  it.each([
    ["relay_404", unknown({ code: "relay_404" })],
    ["Hubtel 404 contradicted by a live code", unknown({ code: "0001", upstreamStatus: 404 })],
    ["Hubtel 405 contradicted by a live code", unknown({ code: "0001", upstreamStatus: 405 })],
  ])("%s → alert, still no fallback", async (_n, outcome) => {
    const t = setup({ outcome })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.status).toBe("pay_offline")
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — one Paystack call at most, never after accepted/unknown", () => {
  it.each<[string, StartOutcome, number]>([
    ["accepted", { kind: "accepted" }, 0],
    ["unknown", unknown(), 0],
    ["refused", refused(), 1],
  ])("%s → %#", async (_n, outcome, expected) => {
    const t = setup({ outcome })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(expected)
  })
})

describe("startMomoCharge — one open attempt per order", () => {
  it("a second start while one is open → no second prompt, no Paystack, pay_offline", async () => {
    const t = setup()
    await startMomoCharge("ussd", VERIFIED, t.deps)
    const second = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.receiveMoney).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(second).toEqual({ status: "pay_offline", reference: "order-123", gateway: "hubtel" })
    expect(t.rows.size).toBe(1)
    expect(t.alert).not.toHaveBeenCalled()
  })

  it("a retry after a refused attempt gets a brand-new reference", async () => {
    const t = setup({ outcome: refused() })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    await startMomoCharge("ussd", VERIFIED, t.deps)
    const sent = t.receiveMoney.mock.calls.map((c) => c[0].reference)
    expect(sent).toHaveLength(2)
    expect(sent[0]).not.toBe(sent[1])
  })
})

describe("startMomoCharge — paid or in-review sibling", () => {
  const sibling = (status: string) => ({ reference: "e".repeat(32), internal_reference: "order-123", status, expires_at: NOW.toISOString() })

  it.each(["paid", "needs_review"])("%s sibling → no row, no prompt, no Paystack, pay_offline, alert", async (status) => {
    const t = setup({ seed: [sibling(status)] })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual([])
    expect(t.rows.size).toBe(1)
    expect(out).toEqual({ status: "pay_offline", reference: "order-123", gateway: "hubtel" })
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(t.alert.mock.calls)).not.toContain("order-123")
  })

  it("a failed sibling does not block a new attempt", async () => {
    const t = setup({ seed: [sibling("failed")] })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.receiveMoney).toHaveBeenCalledTimes(1)
  })

  it("a paid row for another order does not block", async () => {
    const t = setup({ seed: [{ ...sibling("paid"), internal_reference: "other" }] })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.receiveMoney).toHaveBeenCalledTimes(1)
  })

  it("the lookup failing → nothing sent, Paystack, alert (same as a failed insert)", async () => {
    const t = setup({ settledThrows: true })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("the surface being on Paystack never looks at siblings", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }), seed: [sibling("paid")] })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.alert).not.toHaveBeenCalled()
  })
})

describe("startMomoCharge — stuck open attempt", () => {
  const OLD = "d".repeat(32)
  const open = (expiresInMs: number, status = "pending") => ({
    reference: OLD, internal_reference: "order-123", status, claimed_at: null,
    expires_at: new Date(NOW.getTime() + expiresInMs).toISOString(),
  })
  const offline = { status: "pay_offline", reference: "order-123", gateway: "hubtel" }

  it("not past expires_at → pay_offline, no claim, no status check", async () => {
    const t = setup({ seed: [open(1)] })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert"])
  })

  it("the open row vanished, or could not be read → pay_offline", async () => {
    const gone = setup({ insertSeq: ["duplicate"] })
    expect(await startMomoCharge("ussd", VERIFIED, gone.deps)).toEqual(offline)
    expect(gone.events).toEqual(["insert"])
    const down = setup({ seed: [open(-1)], findOpenThrows: true })
    expect(await startMomoCharge("ussd", VERIFIED, down.deps)).toEqual(offline)
    expect(down.events).toEqual(["insert"])
  })

  it("past expiry but the claim is lost → pay_offline, no status check", async () => {
    const t = setup({ seed: [open(-1, "confirming")] })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert", "claim"])
  })

  it("the claim throwing → pay_offline", async () => {
    const t = setup({ seed: [open(-1)], claimThrows: true })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert", "claim"])
  })

  it.each<[string, PaymentStatus]>([
    ["not_found", { kind: "not_found", raw: { from: "hubtel" } }],
    ["unpaid", { kind: "unpaid", raw: { from: "hubtel" } }],
  ])("%s → closed failed with refused_at NULL, new attempt with a new reference, one prompt", async (_n, status) => {
    const t = setup({ seed: [open(0)], status })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.events).toEqual(["insert", "claim", "status", "closeUnanswered", "insert", "receive"])
    const old = t.rows.get(OLD)
    expect(old.status).toBe("failed")
    expect(old.refused_at ?? null).toBeNull()
    expect(old.last_check).toEqual({ from: "hubtel" })
    expect(old.updated_at).toBe(NOW.toISOString())
    const sent = t.receiveMoney.mock.calls[0][0]
    expect(sent.reference).not.toBe(OLD)
    expect(t.rows.get(sent.reference)).toMatchObject({ status: "pending", internal_reference: "order-123" })
    expect(out).toEqual({ ...offline, hubtelReference: sent.reference })
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
  })

  it.each<[string, PaymentStatus]>([
    ["paid", { kind: "paid", amountPesewas: 2000, raw: {} }],
    ["refunded", { kind: "refunded", raw: {} }],
    ["error", { kind: "error", raw: {} }],
  ])("%s → pay_offline, nothing sent, not closed; the sweep settles it", async (_n, status) => {
    const t = setup({ seed: [open(-1)], status })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert", "claim", "status"])
    expect(t.rows.get(OLD).status).toBe("confirming")
  })

  it("the status check throwing → pay_offline, nothing sent", async () => {
    const t = setup({ seed: [open(-1)], status: async () => { throw new Error("boom") } })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.receiveMoney).not.toHaveBeenCalled()
  })

  it.each(["miss", "throw"] as const)("the guarded close %s → pay_offline, nothing sent", async (closeUnansweredResult) => {
    const t = setup({ seed: [open(-1)], closeUnansweredResult })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert", "claim", "status", "closeUnanswered"])
  })

  it("the second insert hitting 23505 again → pay_offline, nothing sent", async () => {
    const t = setup({ seed: [open(-1)], insertSeq: ["duplicate", "duplicate"] })
    expect(await startMomoCharge("ussd", VERIFIED, t.deps)).toEqual(offline)
    expect(t.events).toEqual(["insert", "claim", "status", "closeUnanswered", "insert"])
  })

  it("the second insert failing → Paystack, alert, nothing sent to Hubtel", async () => {
    const t = setup({ seed: [open(-1)], insertSeq: ["duplicate", "error"] })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.receiveMoney).not.toHaveBeenCalled()
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it("the re-sent attempt refused → falls back once, as a first attempt would", async () => {
    const t = setup({ seed: [open(-1)], outcome: refused() })
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
  })

  it("concurrent starts on a stuck row → exactly one prompt, no Paystack", async () => {
    const t = setup({
      seed: [open(-1)],
      status: async () => { await new Promise((r) => setTimeout(r, 5)); return { kind: "not_found", raw: {} } },
    })
    const results = await Promise.all(Array.from({ length: 5 }, () => startMomoCharge("ussd", VERIFIED, t.deps)))
    expect(t.receiveMoney).toHaveBeenCalledTimes(1)
    expect(t.checkStatus).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    for (const r of results) expect(r.status).toBe("pay_offline")
    const open_ = [...t.rows.values()].filter((r) => ["pending", "confirming"].includes(r.status))
    expect(open_).toHaveLength(1)
  })
})

describe("resolveSurfaceGateway", () => {
  const deps = (c: GatewayConfig, ready = true) => ({ getConfig: async () => c, isReady: () => ready })

  it("hubtel surface, verified payer, ready → hubtel with the surface's bearer", async () => {
    expect(await resolveSurfaceGateway("ussd", { verifiedPayer: true }, deps(config({ feeBearer: "merchant" }))))
      .toEqual({ gateway: "hubtel", feeBearer: "merchant" })
  })

  it("paystack surface → paystack, keeping the surface's bearer", async () => {
    const c = deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
    c.surfaces.ussd.feeBearer = "merchant"
    expect(await resolveSurfaceGateway("ussd", { verifiedPayer: true }, deps(c))).toEqual({ gateway: "paystack", feeBearer: "merchant" })
  })

  it.each([false, undefined])("verifiedPayer %s → paystack", async (verifiedPayer) => {
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer }, deps(config()))).gateway).toBe("paystack")
  })

  it("not ready → paystack", async () => {
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true }, deps(config(), false))).gateway).toBe("paystack")
  })

  it("amount under 0.10 → paystack; 0.10 → hubtel; no amount given → not considered", async () => {
    const c = deps(config())
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true, amount: 0.09 }, c)).gateway).toBe("paystack")
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true, amount: 0.1 }, c)).gateway).toBe("hubtel")
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true }, c)).gateway).toBe("hubtel")
  })

  it("the merchant-lowered amount is what the minimum applies to", async () => {
    const c = deps(config({ feeBearer: "merchant" }, 50))
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true, amount: 0.15 }, c)).gateway).toBe("paystack")
    expect((await resolveSurfaceGateway("ussd", { verifiedPayer: true, amount: 0.2 }, c)).gateway).toBe("hubtel")
  })

  it("a config read that throws → paystack, customer bearer, and does not throw", async () => {
    expect(await resolveSurfaceGateway("ussd", { verifiedPayer: true }, { getConfig: async () => { throw new Error("x") }, isReady: () => true }))
      .toEqual({ gateway: "paystack", feeBearer: "customer" })
  })

  it("agrees with startMomoCharge on every gate", async () => {
    for (const [cfg, ready, verifiedPayer, amount] of [
      [config(), true, true, 20], [config(), false, true, 20], [config(), true, false, 20], [config(), true, true, 0.05],
      [config({ feeBearer: "merchant" }, 50), true, true, 0.15], [deriveFromLegacy({ storefrontDirect: false, walletDirect: false }), true, true, 20],
    ] as [GatewayConfig, boolean, boolean, number][]) {
      const t = setup({ config: cfg, ready })
      const started = await startMomoCharge("ussd", { ...PARAMS, amount, verifiedPayer }, t.deps)
      expect((await resolveSurfaceGateway("ussd", { verifiedPayer, amount }, deps(cfg, ready))).gateway).toBe(started.gateway)
    }
  })
})

describe("startMomoCharge — alerts are bounded at 3 seconds", () => {
  const never = () => new Promise<void>(() => {})

  it.each<[string, Parameters<typeof setup>[0], string]>([
    ["fallback after a config refusal", { outcome: refused({ code: "relay_401" }) }, "paystack"],
    ["fallback after a failed insert", { insertResult: "error" }, "paystack"],
    ["relay_404 with no fallback", { outcome: unknown({ code: "relay_404" }) }, "hubtel"],
    ["unexpected send error", { outcome: async () => { throw new Error("surprise") } }, "hubtel"],
    ["paid sibling", { seed: [{ reference: "e".repeat(32), internal_reference: "order-123", status: "paid" }] }, "hubtel"],
  ])("%s: a never-resolving notify cannot hang the start", async (_n, o, gateway) => {
    vi.useFakeTimers()
    try {
      const t = setup(o)
      t.deps.alert = vi.fn(never)
      let done: { gateway: string } | null = null
      const run = startMomoCharge("ussd", VERIFIED, t.deps).then((r) => { done = r })
      await vi.advanceTimersByTimeAsync(2_999)
      expect(done).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      await run
      expect(done!.gateway).toBe(gateway)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a quick alert does not wait for the timer, and an alert that rejects changes nothing", async () => {
    const t = setup({ outcome: refused({ code: "relay_401" }) })
    t.deps.alert = vi.fn(async () => { throw new Error("sms down") })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const out = await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(out.gateway).toBe("paystack")
    err.mockRestore()
  })
})

describe("PII-free alerts", () => {
  it.each<[string, Parameters<typeof setup>[0]]>([
    ["refused config", { outcome: refused({ code: "relay_401", message: "bad 0244123456" }) }],
    ["unknown 404", { outcome: unknown({ code: "relay_404", message: "bad 0244123456" }) }],
    ["input error", { outcome: async () => { throw new HubtelPayInputError("bad 0244123456") } }],
    ["surprise", { outcome: async () => { throw new Error("bad 0244123456") } }],
    ["insert", { insertResult: "error" }],
  ])("%s: no phone, email or caller reference", async (_n, o) => {
    const t = setup(o)
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.alert).toHaveBeenCalled()
    const text = JSON.stringify(t.alert.mock.calls)
    for (const secret of ["244123456", "example.com", "order-123"]) expect(text).not.toContain(secret)
  })
})

describe("startMomoCharge — earlier attempts block every Paystack path on a Hubtel surface", () => {
  const OLD = "d".repeat(32)
  const seedRow = (status: string, expiresInMs = 60_000) => ({
    reference: OLD, internal_reference: "order-123", status, claimed_at: null,
    expires_at: new Date(NOW.getTime() + expiresInMs).toISOString(),
  })
  const offline = { status: "pay_offline", reference: "order-123", gateway: "hubtel" }
  const paths: [string, any, Parameters<typeof setup>[0]][] = [
    ["unverified payer", { ...PARAMS, verifiedPayer: false }, {}],
    ["verifiedPayer not stated", PARAMS, {}],
    ["under the minimum", { ...VERIFIED, amount: 0.05 }, {}],
    ["malformed phone", { ...VERIFIED, phone: "024 412 3456" }, {}],
    ["unknown provider", { ...VERIFIED, provider: "xyz" }, {}],
    ["Hubtel not ready", VERIFIED, { ready: false }],
    ["callback URL unavailable", VERIFIED, { callbackUrlThrows: new Error("no url") }],
    ["row insert error", VERIFIED, { insertResult: "error" }],
  ]

  it.each(paths)("%s + an open attempt → no Paystack prompt", async (_n, params, o) => {
    const t = setup({ ...o, seed: [seedRow("pending")] })
    expect(await startMomoCharge("ussd", params, t.deps)).toEqual(offline)
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(t.receiveMoney).not.toHaveBeenCalled()
  })

  it.each(paths)("%s + a paid sibling → no Paystack prompt", async (_n, params, o) => {
    for (const status of ["paid", "needs_review"]) {
      const t = setup({ ...o, seed: [seedRow(status)] })
      expect(await startMomoCharge("ussd", params, t.deps)).toEqual(offline)
      expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    }
  })

  it("an expired open attempt Hubtel never saw is freed, then the Paystack path may run", async () => {
    const t = setup({ seed: [seedRow("pending", -1)] })
    const out = await startMomoCharge("ussd", { ...PARAMS, verifiedPayer: false }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.rows.get(OLD).status).toBe("failed")
  })

  it("no earlier attempt: the Paystack paths run as before", async () => {
    for (const [, params, o] of paths) {
      const t = setup(o)
      expect((await startMomoCharge("ussd", params, t.deps)).gateway).toBe("paystack")
      expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    }
  })

  it("surface on Paystack: the attempt tables are never read", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }), seed: [seedRow("pending")] })
    const sibling = vi.spyOn(t.deps.store!, "findSettledSibling")
    const open = vi.spyOn(t.deps.store!, "findOpen")
    expect((await startMomoCharge("ussd", VERIFIED, t.deps)).gateway).toBe("paystack")
    expect(sibling).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
  })
})

describe("startMomoCharge — onFallback", () => {
  const withFallback = (amount = 20.6) => {
    const onFallback = vi.fn(async () => ({ amount }))
    return { onFallback, params: { ...VERIFIED, onFallback } }
  }

  it("refused → row closed first, called once, Paystack charges the amount it returns and never sees the callback", async () => {
    const { onFallback, params } = withFallback()
    const t = setup({ outcome: refused() })
    onFallback.mockImplementation(async () => { t.events.push("onFallback"); return { amount: 20.6 } })
    const out = await startMomoCharge("ussd", params, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(t.events).toEqual(["insert", "receive", "close", "onFallback", "paystack"])
    const sent = t.chargeMobileMoney.mock.calls[0][0]
    expect(sent.amount).toBe(20.6)
    expect(sent).not.toHaveProperty("onFallback")
    expect(sent).not.toHaveProperty("verifiedPayer")
  })

  it.each<[string, any, Parameters<typeof setup>[0]]>([
    ["unverified", { verifiedPayer: false }, {}],
    ["under the minimum", { amount: 0.05 }, {}],
    ["not ready", {}, { ready: false }],
    ["insert error", {}, { insertResult: "error" }],
    ["surface back on Paystack after the caller resolved Hubtel", {}, { config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) }],
  ])("%s → called once before Paystack", async (_n, over, o) => {
    const { onFallback, params } = withFallback()
    const t = setup(o)
    await startMomoCharge("ussd", { ...params, ...over }, t.deps)
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney).toHaveBeenCalledTimes(1)
    expect(t.chargeMobileMoney.mock.calls[0][0].amount).toBe(20.6)
  })

  it("onFallback throwing → the error reaches the caller, nothing charged, the Hubtel row stays closed", async () => {
    const { onFallback, params } = withFallback()
    onFallback.mockRejectedValue(new Error("no row"))
    const t = setup({ outcome: refused() })
    await expect(startMomoCharge("ussd", params, t.deps)).rejects.toThrow("no row")
    expect(t.chargeMobileMoney).not.toHaveBeenCalled()
    expect(t.onlyRow().status).toBe("failed")
  })

  it("Hubtel accepted or unknown → never called", async () => {
    for (const outcome of [{ kind: "accepted" } as StartOutcome, { kind: "unknown", code: "timeout" } as StartOutcome]) {
      const { onFallback, params } = withFallback()
      const t = setup({ outcome })
      expect((await startMomoCharge("ussd", params, t.deps)).gateway).toBe("hubtel")
      expect(onFallback).not.toHaveBeenCalled()
    }
  })

  it("omitted → Paystack charges the caller's amount, as before", async () => {
    const t = setup({ outcome: refused() })
    await startMomoCharge("ussd", VERIFIED, t.deps)
    expect(t.chargeMobileMoney.mock.calls[0][0].amount).toBe(20)
  })
})

describe("createStartStore", () => {
  function fakeSb(res: { error?: { code?: string; message: string } | null; data?: unknown[] }) {
    const calls: unknown[][] = []
    const reply = () => ({ data: res.data ?? null, error: res.error ?? null })
    const q: any = {
      insert: (v: unknown) => { calls.push(["insert", v]); return Promise.resolve({ error: res.error ?? null }) },
      update: (v: unknown) => { calls.push(["update", v]); return q },
      eq: (c: string, v: unknown) => { calls.push(["eq", c, v]); return q },
      in: (c: string, v: unknown) => { calls.push(["in", c, v]); return q },
      limit: (n: number) => { calls.push(["limit", n]); return q },
      select: (c: string) => { calls.push(["select", c]); return q },
      maybeSingle: async () => { const r = reply(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } },
      then: (ok: any, ko: any) => Promise.resolve(reply()).then(ok, ko),
    }
    return {
      sb: {
        from: (t: string) => { calls.push(["from", t]); return q },
        rpc: async (name: string, args: unknown) => { calls.push(["rpc", name, args]); return reply() },
      } as any,
      calls,
    }
  }

  it("findSettledSibling looks only at paid and needs_review for that order; throws on a database error", async () => {
    const hit = fakeSb({ data: [{ reference: "r1", status: "paid" }] })
    expect(await createStartStore(hit.sb).findSettledSibling("order-1")).toEqual({ reference: "r1", status: "paid" })
    expect(hit.calls).toContainEqual(["eq", "internal_reference", "order-1"])
    expect(hit.calls).toContainEqual(["in", "status", ["paid", "needs_review"]])
    expect(await createStartStore(fakeSb({ data: [] }).sb).findSettledSibling("order-1")).toBeNull()
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).findSettledSibling("order-1")).rejects.toThrow()
  })

  it("findOpen looks only at pending and confirming for that order; throws on a database error", async () => {
    const open = { reference: "r1", status: "pending", expires_at: NOW.toISOString() }
    const hit = fakeSb({ data: [open] })
    expect(await createStartStore(hit.sb).findOpen("order-1")).toEqual(open)
    expect(hit.calls).toContainEqual(["eq", "internal_reference", "order-1"])
    expect(hit.calls).toContainEqual(["in", "status", ["pending", "confirming"]])
    expect(await createStartStore(fakeSb({ data: [] }).sb).findOpen("order-1")).toBeNull()
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).findOpen("order-1")).rejects.toThrow()
  })

  it("claim uses the claim_hubtel_payment RPC; no row back means lost", async () => {
    const hit = fakeSb({ data: [{ reference: "r1", claimed_at: "2026-11-04T10:00:00.123456+00:00" }] })
    expect(await createStartStore(hit.sb).claim("r1")).toEqual({ reference: "r1", claimed_at: "2026-11-04T10:00:00.123456+00:00" })
    expect(hit.calls).toContainEqual(["rpc", "claim_hubtel_payment", { p_reference: "r1" }])
    expect(await createStartStore(fakeSb({ data: [] }).sb).claim("r1")).toBeNull()
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).claim("r1")).rejects.toThrow()
  })

  it("closeUnanswered is guarded on confirming and the exact claimed_at, and never sets refused_at", async () => {
    const stamp = "2026-11-04T10:00:00.123456+00:00"
    const patch = { last_check: { a: 1 }, updated_at: NOW.toISOString() }
    const hit = fakeSb({ data: [{ reference: "r1" }] })
    expect(await createStartStore(hit.sb).closeUnanswered("r1", stamp, patch)).toBe(true)
    expect(hit.calls).toContainEqual(["update", { status: "failed", ...patch }])
    expect(hit.calls).toContainEqual(["eq", "reference", "r1"])
    expect(hit.calls).toContainEqual(["eq", "status", "confirming"])
    expect(hit.calls).toContainEqual(["eq", "claimed_at", stamp])
    expect(await createStartStore(fakeSb({ data: [] }).sb).closeUnanswered("r1", stamp, patch)).toBe(false)
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).closeUnanswered("r1", stamp, patch)).rejects.toThrow()
  })

  const row = {
    reference: "a".repeat(32), internal_reference: "order-1", metadata: {}, surface: "ussd" as const, mode: "direct" as const, amount_pesewas: 100,
    handler_amount_pesewas: null, msisdn: "233244123456", channel: "mtn-gh", expires_at: NOW.toISOString(),
  }

  it("insert maps 23505 to duplicate, any other error to error, success to ok", async () => {
    expect(await createStartStore(fakeSb({ error: { code: "23505", message: "dup" } }).sb).insert(row)).toBe("duplicate")
    expect(await createStartStore(fakeSb({ error: { code: "42P01", message: "no table" } }).sb).insert(row)).toBe("error")
    expect(await createStartStore(fakeSb({}).sb).insert(row)).toBe("ok")
  })

  it("closeRefused writes failed + refused_at, guarded on pending, and reports whether a row changed", async () => {
    const hit = fakeSb({ data: [{ reference: row.reference }] })
    const patch = { refused_at: NOW.toISOString(), last_check: {}, updated_at: NOW.toISOString() }
    expect(await createStartStore(hit.sb).closeRefused(row.reference, patch)).toBe(true)
    expect(hit.calls).toContainEqual(["from", "hubtel_payments"])
    expect(hit.calls).toContainEqual(["update", { status: "failed", ...patch }])
    expect(hit.calls).toContainEqual(["eq", "reference", row.reference])
    expect(hit.calls).toContainEqual(["eq", "status", "pending"])
    expect(await createStartStore(fakeSb({ data: [] }).sb).closeRefused(row.reference, patch)).toBe(false)
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).closeRefused(row.reference, patch)).rejects.toThrow()
  })
})
