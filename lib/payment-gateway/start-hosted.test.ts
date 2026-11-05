import { describe, it, expect, vi } from "vitest"
import { FallbackRefusedError, startHostedPayment, HostedStartError, createStartStore, type HostedStartDeps, type HostedStartStore } from "./start"
import { deriveFromLegacy, type GatewayConfig, type SurfaceConfig } from "./config"
import { HubtelPayInputError, type PaymentStatus, type StartOutcome } from "@/lib/hubtel-pay/client"
import type { InitializePaymentParams } from "@/lib/paystack"

const NOW = new Date("2026-11-04T10:00:00.000Z")
const CHECKOUT = "https://pay.hubtel.com/abc123"
const PARAMS: InitializePaymentParams = {
  email: "x@example.com",
  amount: 20,
  reference: "WALLET-123",
  redirectUrl: "https://www.datagod.store/dashboard/wallet?reference=WALLET-123",
  metadata: { type: "wallet_topup", userId: "u1" },
  channel: "wallet_topup",
  purpose: "Wallet Top-up",
  ip: "1.2.3.4",
}
const OPAQUE = /^[0-9a-f]{32}$/

function config(over: Partial<SurfaceConfig> = {}, hubtelFeePercent = 0): GatewayConfig {
  const c = deriveFromLegacy({ storefrontDirect: false, walletDirect: false })
  c.surfaces.wallet_topup = { gateway: "hubtel", mode: "checkout", feeBearer: "customer", ...over }
  c.hubtelFeePercent = hubtelFeePercent
  return c
}

function setup(o: {
  config?: GatewayConfig
  ready?: boolean
  outcome?: StartOutcome | (() => Promise<StartOutcome>)
  insertResult?: "error" | "throw"
  seed?: Record<string, any>[]
  status?: PaymentStatus
  setUrlThrows?: boolean
} = {}) {
  const events: string[] = []
  const rows = new Map<string, any>()
  for (const r of o.seed ?? []) rows.set(r.reference, { ...r })
  const store: HostedStartStore = {
    async findSettledSibling(ir) {
      const hit = [...rows.values()].find((r) => r.internal_reference === ir && ["paid", "needs_review"].includes(r.status))
      return hit ? { reference: hit.reference, status: hit.status } : null
    },
    async findOpen(ir) {
      const hit = [...rows.values()].find((r) => r.internal_reference === ir && ["pending", "confirming"].includes(r.status))
      return hit ? { reference: hit.reference, status: hit.status, expires_at: hit.expires_at, mode: hit.mode, checkout_url: hit.checkout_url ?? null } : null
    },
    async claim(reference) {
      events.push("claim")
      const r = rows.get(reference)
      if (!r || r.status !== "pending") return null
      r.status = "confirming"
      r.claimed_at = `claim-${reference}`
      return { reference, claimed_at: r.claimed_at }
    },
    async closeUnanswered(reference, claimedAt, patch) {
      events.push("closeUnanswered")
      const r = rows.get(reference)
      if (!r || r.status !== "confirming" || r.claimed_at !== claimedAt) return false
      Object.assign(r, { status: "failed" }, patch)
      return true
    },
    async insert(row) {
      events.push("insert")
      if (o.insertResult === "throw") throw new Error("db down")
      if (o.insertResult === "error") return "error"
      for (const r of rows.values()) {
        if (r.internal_reference === row.internal_reference && ["pending", "confirming"].includes(r.status)) return "duplicate"
      }
      rows.set(row.reference, { status: "pending", ...row })
      return "ok"
    },
    async closeRefused(reference, patch) {
      events.push("close")
      const r = rows.get(reference)
      if (!r || r.status !== "pending") return false
      Object.assign(r, { status: "failed" }, patch)
      return true
    },
    async setCheckoutUrl(reference, url) {
      events.push("setUrl")
      if (o.setUrlThrows) throw new Error("db down")
      const r = rows.get(reference)
      if (r) r.checkout_url = url
      return !!r
    },
  }
  const outcome = o.outcome ?? { kind: "accepted" as const, checkoutUrl: CHECKOUT }
  const initiateCheckout = vi.fn(async (_p: any): Promise<StartOutcome> => {
    events.push("checkout")
    return typeof outcome === "function" ? outcome() : outcome
  })
  const initializePayment = vi.fn(async (p: any) => {
    events.push("paystack")
    return { authorizationUrl: "https://checkout.paystack.com/xyz", accessCode: "xyz", reference: p.reference }
  })
  const alert = vi.fn(async (_k: string, _m: string) => {})
  const checkStatus = vi.fn(async (_r: string): Promise<PaymentStatus> => o.status ?? { kind: "not_found", raw: {} })
  const deps: Partial<HostedStartDeps> = {
    getConfig: async () => o.config ?? config(),
    isReady: () => o.ready ?? true,
    initializePayment,
    initiateCheckout,
    checkStatus,
    store,
    callbackUrl: (ref) => `https://www.datagod.store/api/webhooks/hubtel-payments?ref=${ref}&sig=cb`,
    returnUrl: (ref, cancelled) => `https://www.datagod.store/api/payments/hubtel-return?ref=${ref}&sig=rt${cancelled ? "&cancelled=1" : ""}`,
    alert,
    now: () => NOW,
  }
  const onlyRow = () => [...rows.values()].find((r) => r.internal_reference === PARAMS.reference && !(o.seed ?? []).some((s) => s.reference === r.reference))
  return { events, rows, onlyRow, deps, initiateCheckout, initializePayment, alert }
}

const refused = (over: Partial<Extract<StartOutcome, { kind: "refused" }>> = {}): StartOutcome =>
  ({ kind: "refused", code: "4000", message: "nope", ...over })
const unknown = (over: Partial<Extract<StartOutcome, { kind: "unknown" }>> = {}): StartOutcome =>
  ({ kind: "unknown", code: "no_response", message: "timeout", ...over })

describe("startHostedPayment — surface on Paystack", () => {
  it("passes the params through exactly, no row, Paystack's result plus gateway", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(t.initializePayment.mock.calls[0][0]).toStrictEqual(PARAMS)
    expect(out).toEqual({ authorizationUrl: "https://checkout.paystack.com/xyz", accessCode: "xyz", reference: "WALLET-123", gateway: "paystack" })
    expect(t.rows.size).toBe(0)
    expect(t.initiateCheckout).not.toHaveBeenCalled()
  })

  it("Paystack's error propagates unchanged", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    t.initializePayment.mockRejectedValueOnce(new Error("HTTP 500"))
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toThrow("HTTP 500")
  })

  it("Hubtel not ready → Paystack with an alert, nothing sent", async () => {
    const t = setup({ ready: false })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
    expect(t.alert).toHaveBeenCalledTimes(1)
  })

  it.each([0.09, 0, Number.NaN])("amount %s under 0.10 → Paystack, no row", async (amount) => {
    const t = setup()
    const out = await startHostedPayment("wallet_topup", { ...PARAMS, amount }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.events).toEqual(["paystack"])
  })
})

describe("startHostedPayment — Hubtel accepted", () => {
  it("row first, then checkout; returns the checkout URL under the caller's reference", async () => {
    const t = setup()
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(t.events).toEqual(["insert", "checkout", "setUrl"])
    expect(out).toEqual({ authorizationUrl: CHECKOUT, accessCode: "", reference: "WALLET-123", gateway: "hubtel" })
    const row = t.onlyRow()
    expect(row).toMatchObject({
      internal_reference: "WALLET-123",
      surface: "wallet_topup",
      mode: "checkout",
      amount_pesewas: 2000,
      handler_amount_pesewas: null,
      msisdn: null,
      channel: null,
      expires_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      checkout_url: CHECKOUT,
    })
    expect(row.metadata).toEqual({ type: "wallet_topup", userId: "u1", gateway: "hubtel", redirect_url: PARAMS.redirectUrl })
    expect(row.reference).toMatch(OPAQUE)
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("Hubtel sees only the opaque reference, 'Payment', and app-host callback/return/cancel URLs", async () => {
    const t = setup()
    await startHostedPayment("wallet_topup", PARAMS, t.deps)
    const sent = t.initiateCheckout.mock.calls[0][0]
    const ref = t.onlyRow().reference
    expect(sent).toEqual({
      reference: ref,
      amount: 20,
      description: "Payment",
      callbackUrl: `https://www.datagod.store/api/webhooks/hubtel-payments?ref=${ref}&sig=cb`,
      returnUrl: `https://www.datagod.store/api/payments/hubtel-return?ref=${ref}&sig=rt`,
      cancellationUrl: `https://www.datagod.store/api/payments/hubtel-return?ref=${ref}&sig=rt&cancelled=1`,
    })
    expect(JSON.stringify(sent)).not.toContain("WALLET")
  })

  it("float amount rounded to 2 dp", async () => {
    const t = setup()
    await startHostedPayment("wallet_topup", { ...PARAMS, amount: 0.1 + 0.2 + 12 }, t.deps)
    expect(t.initiateCheckout.mock.calls[0][0].amount).toBe(12.3)
    expect(t.onlyRow().amount_pesewas).toBe(1230)
  })

  it("merchant bears: requested amount lowered, handler amount = full price", async () => {
    const t = setup({ config: config({ feeBearer: "merchant" }, 2) })
    await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(t.initiateCheckout.mock.calls[0][0].amount).toBe(19.6)
    expect(t.onlyRow()).toMatchObject({ amount_pesewas: 1960, handler_amount_pesewas: 2000 })
  })

  it("a failed checkout_url write never returns the URL: try_again, row left open, alert, no Paystack", async () => {
    const t = setup({ setUrlThrows: true })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    err.mockRestore()
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.onlyRow()).toMatchObject({ status: "pending" })
    expect(t.onlyRow().checkout_url ?? null).toBeNull()
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("a checkout_url write that changes no row never returns the URL either", async () => {
    const t = setup()
    vi.spyOn(t.deps.store!, "setCheckoutUrl").mockResolvedValue(false)
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.alert).toHaveBeenCalledTimes(1)
    expect(t.initializePayment).not.toHaveBeenCalled()
  })
})

describe("startHostedPayment — refused and errors", () => {
  it("refused → row failed with refused_at, Paystack URL returned", async () => {
    const t = setup({ outcome: refused() })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out).toEqual({ authorizationUrl: "https://checkout.paystack.com/xyz", accessCode: "xyz", reference: "WALLET-123", gateway: "paystack" })
    expect(t.events).toEqual(["insert", "checkout", "close", "paystack"])
    expect(t.onlyRow()).toMatchObject({ status: "failed", refused_at: NOW.toISOString() })
    expect(t.initializePayment.mock.calls[0][0]).toStrictEqual(PARAMS)
  })

  it("relay input error (e.g. return URL off the app host) → closed, Paystack, alert", async () => {
    const t = setup({ outcome: async () => { throw new HubtelPayInputError("invalid returnUrl") } })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.onlyRow().status).toBe("failed")
    expect(t.alert).toHaveBeenCalled()
  })

  it("unknown → throws a clear try-again error, row stays pending, no Paystack", async () => {
    const t = setup({ outcome: unknown() })
    const p = startHostedPayment("wallet_topup", PARAMS, t.deps)
    await expect(p).rejects.toBeInstanceOf(HostedStartError)
    await expect(startHostedPayment("wallet_topup", { ...PARAMS, reference: "WALLET-9" }, setup({ outcome: unknown() }).deps))
      .rejects.toThrow(/try again/i)
    expect(t.initializePayment).not.toHaveBeenCalled()
    expect(t.onlyRow().status).toBe("pending")
  })

  it("an unexpected send error → try-again error, row pending, no Paystack", async () => {
    const t = setup({ outcome: async () => { throw new Error("socket hang up") } })
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    err.mockRestore()
    expect(t.initializePayment).not.toHaveBeenCalled()
    expect(t.onlyRow().status).toBe("pending")
  })

  it("insert fails → Paystack, alert, nothing sent to Hubtel", async () => {
    const t = setup({ insertResult: "error" })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(t.initiateCheckout).not.toHaveBeenCalled()
    expect(t.alert).toHaveBeenCalledTimes(1)
  })
})

describe("startHostedPayment — siblings and one open attempt per order", () => {
  it.each(["paid", "needs_review"])("a %s sibling → 'already being processed' error, no URL, no Paystack", async (status) => {
    const t = setup({ seed: [{ reference: "e".repeat(32), internal_reference: "WALLET-123", status }] })
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "already_processing" })
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toThrow(/already being processed/i)
    expect(t.initiateCheckout).not.toHaveBeenCalled()
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("an open, unexpired hosted attempt → its stored checkout URL, nothing new sent", async () => {
    const open = { reference: "d".repeat(32), internal_reference: "WALLET-123", status: "pending", mode: "checkout",
      checkout_url: "https://pay.hubtel.com/stored", expires_at: new Date(NOW.getTime() + 60_000).toISOString() }
    const t = setup({ seed: [open] })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out).toEqual({ authorizationUrl: "https://pay.hubtel.com/stored", accessCode: "", reference: "WALLET-123", gateway: "hubtel" })
    expect(t.initiateCheckout).not.toHaveBeenCalled()
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("an open hosted attempt with no stored URL → try-again error", async () => {
    const open = { reference: "d".repeat(32), internal_reference: "WALLET-123", status: "pending", mode: "checkout",
      checkout_url: null, expires_at: new Date(NOW.getTime() + 60_000).toISOString() }
    const t = setup({ seed: [open] })
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.initiateCheckout).not.toHaveBeenCalled()
  })

  it("an open direct attempt, unexpired → try-again error, nothing sent", async () => {
    const open = { reference: "d".repeat(32), internal_reference: "WALLET-123", status: "pending", mode: "direct",
      expires_at: new Date(NOW.getTime() + 60_000).toISOString() }
    const t = setup({ seed: [open] })
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.initiateCheckout).not.toHaveBeenCalled()
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("an expired open attempt Hubtel has no record of is freed, and a new checkout starts", async () => {
    const open = { reference: "d".repeat(32), internal_reference: "WALLET-123", status: "pending", mode: "direct",
      expires_at: new Date(NOW.getTime() - 60_000).toISOString() }
    const t = setup({ seed: [open] })
    const out = await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(out.authorizationUrl).toBe(CHECKOUT)
    expect(t.rows.get(open.reference).status).toBe("failed")
    expect(t.events).toEqual(["insert", "claim", "closeUnanswered", "insert", "checkout", "setUrl"])
  })

  it("an expired open attempt Hubtel reports paid is left alone → try-again error", async () => {
    const open = { reference: "d".repeat(32), internal_reference: "WALLET-123", status: "pending", mode: "checkout", checkout_url: CHECKOUT,
      expires_at: new Date(NOW.getTime() - 60_000).toISOString() }
    const t = setup({ seed: [open], status: { kind: "paid", amountPesewas: 2000, raw: {} } })
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.initiateCheckout).not.toHaveBeenCalled()
  })
})

describe("startHostedPayment — earlier attempts block every Paystack path on a Hubtel surface", () => {
  const OLD = "d".repeat(32)
  const seedRow = (status: string, over: Record<string, unknown> = {}) => ({
    reference: OLD, internal_reference: PARAMS.reference, status, mode: "direct", claimed_at: null,
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(), ...over,
  })
  const paths: [string, InitializePaymentParams, Parameters<typeof setup>[0]][] = [
    ["under the minimum", { ...PARAMS, amount: 0.05 }, {}],
    ["Hubtel not ready", PARAMS, { ready: false }],
    ["row insert error", PARAMS, { insertResult: "error" }],
  ]

  it.each(paths)("%s + an open attempt with no link → try_again, no Paystack", async (_n, params, o) => {
    const t = setup({ ...o, seed: [seedRow("pending")] })
    await expect(startHostedPayment("wallet_topup", params, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it.each(paths)("%s + a live hosted attempt → its link, no Paystack", async (_n, params, o) => {
    const t = setup({ ...o, seed: [seedRow("pending", { mode: "checkout", checkout_url: CHECKOUT })] })
    expect(await startHostedPayment("wallet_topup", params, t.deps)).toMatchObject({ authorizationUrl: CHECKOUT, gateway: "hubtel" })
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it.each(paths)("%s + a paid sibling → already_processing, no Paystack", async (_n, params, o) => {
    const t = setup({ ...o, seed: [seedRow("paid")] })
    await expect(startHostedPayment("wallet_topup", params, t.deps)).rejects.toMatchObject({ code: "already_processing" })
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("callback URL unavailable + an open attempt → try_again, no Paystack", async () => {
    const t = setup({ seed: [seedRow("pending")] })
    t.deps.callbackUrl = () => { throw new Error("no url") }
    await expect(startHostedPayment("wallet_topup", PARAMS, t.deps)).rejects.toMatchObject({ code: "try_again" })
    expect(t.initializePayment).not.toHaveBeenCalled()
  })

  it("surface on Paystack: the attempt tables are never read", async () => {
    const t = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }), seed: [seedRow("pending")] })
    const sibling = vi.spyOn(t.deps.store!, "findSettledSibling")
    const open = vi.spyOn(t.deps.store!, "findOpen")
    expect((await startHostedPayment("wallet_topup", PARAMS, t.deps)).gateway).toBe("paystack")
    expect(sibling).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })
})

describe("startHostedPayment — onFallback", () => {
  const refusedOutcome: StartOutcome = { kind: "refused", code: "4000", message: "no" }

  it("refused → row closed first, called once, Paystack gets the amount it returns and never sees the callback", async () => {
    const t = setup({ outcome: refusedOutcome })
    const onFallback = vi.fn(async () => { t.events.push("onFallback"); return { amount: 20.6 } })
    const out = await startHostedPayment("wallet_topup", { ...PARAMS, onFallback }, t.deps)
    expect(out.gateway).toBe("paystack")
    expect(onFallback).toHaveBeenCalledTimes(1)
    expect(t.events).toEqual(["insert", "checkout", "close", "onFallback", "paystack"])
    const sent = t.initializePayment.mock.calls[0][0]
    expect(sent.amount).toBe(20.6)
    expect(sent).not.toHaveProperty("onFallback")
  })

  it("onFallback throwing → the error reaches the caller, nothing started, the Hubtel row stays closed", async () => {
    const t = setup({ outcome: refusedOutcome })
    await expect(startHostedPayment("wallet_topup", { ...PARAMS, onFallback: async () => { throw new Error("no row") } }, t.deps)).rejects.toThrow("no row")
    expect(t.initializePayment).not.toHaveBeenCalled()
    expect(t.onlyRow().status).toBe("failed")
  })

  it("accepted → never called; omitted → the caller's amount, as before", async () => {
    const onFallback = vi.fn(async () => ({ amount: 20.6 }))
    const ok = setup()
    await startHostedPayment("wallet_topup", { ...PARAMS, onFallback }, ok.deps)
    expect(onFallback).not.toHaveBeenCalled()
    const t = setup({ outcome: refusedOutcome })
    await startHostedPayment("wallet_topup", PARAMS, t.deps)
    expect(t.initializePayment.mock.calls[0][0].amount).toBe(20)
  })
})

describe("startHostedPayment — reusedReference: a failed read never leads to a second link", () => {
  const siblingDown = (o: Parameters<typeof setup>[0] = {}) => {
    const t = setup(o)
    vi.spyOn(t.deps.store!, "findSettledSibling").mockRejectedValue(new Error("db down"))
    return t
  }

  it.each<[string, Parameters<typeof setup>[0]]>([["Hubtel ready", {}], ["Hubtel not ready", { ready: false }]])(
    "sibling read fails, %s + reused → refused, onFallback not called, nothing started",
    async (_n, o) => {
      const onFallback = vi.fn(async () => ({ amount: 20.6 }))
      const t = siblingDown(o)
      await expect(startHostedPayment("wallet_topup", { ...PARAMS, onFallback, reusedReference: true }, t.deps)).rejects.toBeInstanceOf(FallbackRefusedError)
      expect(onFallback).not.toHaveBeenCalled()
      expect(t.initializePayment).not.toHaveBeenCalled()
      expect(t.initiateCheckout).not.toHaveBeenCalled()
    },
  )

  it.each<[string, Parameters<typeof setup>[0]]>([["Hubtel ready", {}], ["Hubtel not ready", { ready: false }]])(
    "sibling read fails, %s + a just-minted reference → Paystack stays available",
    async (_n, o) => {
      const t = siblingDown(o)
      expect((await startHostedPayment("wallet_topup", { ...PARAMS, reusedReference: false }, t.deps)).gateway).toBe("paystack")
      expect(t.initializePayment).toHaveBeenCalledTimes(1)
      expect(t.initializePayment.mock.calls[0][0]).not.toHaveProperty("reusedReference")
    },
  )

  it("open read fails on a Paystack path → try_again, reused or not", async () => {
    for (const reusedReference of [true, false]) {
      const t = setup({ ready: false })
      vi.spyOn(t.deps.store!, "findOpen").mockRejectedValue(new Error("db down"))
      await expect(startHostedPayment("wallet_topup", { ...PARAMS, reusedReference }, t.deps)).rejects.toBeInstanceOf(HostedStartError)
      expect(t.initializePayment).not.toHaveBeenCalled()
    }
  })

  it("reused, and the surface went back to Paystack or the config is unreadable → refused", async () => {
    const flipped = setup({ config: deriveFromLegacy({ storefrontDirect: false, walletDirect: false }) })
    await expect(startHostedPayment("wallet_topup", { ...PARAMS, reusedReference: true }, flipped.deps)).rejects.toBeInstanceOf(FallbackRefusedError)
    expect(flipped.initializePayment).not.toHaveBeenCalled()
    const unreadable = setup()
    unreadable.deps.getConfig = async () => { throw new Error("db down") }
    await expect(startHostedPayment("wallet_topup", { ...PARAMS, reusedReference: true }, unreadable.deps)).rejects.toBeInstanceOf(FallbackRefusedError)
    expect(unreadable.initializePayment).not.toHaveBeenCalled()
  })
})

describe("createStartStore — hosted additions", () => {
  function fakeSb(res: { error?: { message: string } | null; data?: unknown[] }) {
    const calls: unknown[][] = []
    const reply = () => ({ data: res.data ?? null, error: res.error ?? null })
    const q: any = {
      update: (v: unknown) => { calls.push(["update", v]); return q },
      eq: (c: string, v: unknown) => { calls.push(["eq", c, v]); return q },
      in: (c: string, v: unknown) => { calls.push(["in", c, v]); return q },
      select: (c: string) => { calls.push(["select", c]); return q },
      maybeSingle: async () => { const r = reply(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data } },
      then: (ok: any, ko: any) => Promise.resolve(reply()).then(ok, ko),
    }
    return { sb: { from: (t: string) => { calls.push(["from", t]); return q } } as any, calls }
  }

  it("findOpen also reads mode and checkout_url", async () => {
    const hit = fakeSb({ data: [{ reference: "r1", status: "pending", expires_at: NOW.toISOString(), mode: "checkout", checkout_url: CHECKOUT }] })
    expect(await createStartStore(hit.sb).findOpen("o")).toMatchObject({ mode: "checkout", checkout_url: CHECKOUT })
    expect(hit.calls).toContainEqual(["select", "reference, status, expires_at, mode, checkout_url"])
  })

  it("setCheckoutUrl writes only on that reference; throws on a database error", async () => {
    const hit = fakeSb({ data: [{ reference: "r1" }] })
    expect(await createStartStore(hit.sb).setCheckoutUrl("r1", CHECKOUT)).toBe(true)
    expect(hit.calls).toContainEqual(["eq", "reference", "r1"])
    expect(hit.calls.some((c) => c[0] === "update" && (c[1] as any).checkout_url === CHECKOUT)).toBe(true)
    await expect(createStartStore(fakeSb({ error: { message: "x" } }).sb).setCheckoutUrl("r1", CHECKOUT)).rejects.toThrow()
  })
})
