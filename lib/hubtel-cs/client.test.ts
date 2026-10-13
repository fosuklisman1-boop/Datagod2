import { describe, it, expect, vi } from "vitest"
import { buildPurchaseBody, createHubtelCsClient, validatePurchase } from "./client"
import { resolveConfig } from "./config"
import { verifySig } from "./callback"
import { createMemoryStore } from "./testing/memory-store"
import { T0 } from "./testing/fixtures"
import { HubtelDisabledError, HubtelDuplicateOrderError, HubtelOutcomeUnknownError, HubtelNotConfiguredError, HubtelPausedError, HubtelServiceDisabledError, HubtelValidationError } from "./errors"
import type { TransportResult } from "./transport"

const PENDING: TransportResult = { httpStatus: 200, body: { ResponseCode: "0001", Message: "Transaction pending.", Data: { ClientReference: "x", Amount: 5, TransactionId: " abc123 ", Meta: { Commission: "0.0198" } } } }

function setup(over: { cfg?: any; results?: TransportResult[]; callbackSecret?: string; callbackBaseUrl?: string; transportCall?: (req: any) => void; getConfig?: () => Promise<any> } = {}) {
  const store = createMemoryStore()
  const calls: any[] = []
  const results = over.results ?? [PENDING]
  let i = 0
  const transport = { call: async (req: any) => { calls.push(req); over.transportCall?.(req); return results[Math.min(i++, results.length - 1)] } }
  const onFloat = vi.fn(async (_r: string) => {})
  const onTransition = vi.fn(async () => {})
  const cfg = resolveConfig({ enabled: true, ...over.cfg })
  const client = createHubtelCsClient({
    store, getConfig: over.getConfig ?? (async () => cfg), getTransport: () => transport,
    callbackBaseUrl: over.callbackBaseUrl ?? "https://app.example.com", callbackSecret: over.callbackSecret ?? "s3cret",
    onFloat, onTransition, now: () => T0, newRef: k => `HCS-${k}-TESTREF1`,
  })
  return { store, calls, client, onFloat, onTransition }
}

const AIRTIME = { serviceKey: "airtime_mtn" as const, destination: "233246912184", amount: 5 }

describe("validatePurchase / buildPurchaseBody", () => {
  it("accepts float-noise amounts and sends them rounded to 2dp", () => {
    const input = { ...AIRTIME, amount: 0.1 + 0.2 }
    expect(() => validatePurchase(input)).not.toThrow()
    expect(buildPurchaseBody(input, "https://cb", "REF").Amount).toBe(0.3)
  })
  it("rejects 3-decimal, zero, negative, NaN and over-cap airtime amounts", () => {
    for (const amount of [0.001, 1.234, 0, -1, NaN, Infinity, 100.01]) {
      expect(() => validatePurchase({ ...AIRTIME, amount })).toThrow(HubtelValidationError)
    }
    expect(() => validatePurchase({ ...AIRTIME, amount: 100 })).not.toThrow()
  })
  it("requires a destination", () => {
    expect(() => validatePurchase({ ...AIRTIME, destination: "  " })).toThrow(HubtelValidationError)
  })
  it("data needs a bundle and sends it EXACTLY as Hubtel returned it (leading spaces kept)", () => {
    const input = { serviceKey: "data_telecel" as const, destination: "233206439599", amount: 10, bundle: " 5.7 GB" }
    expect(buildPurchaseBody(input, "https://cb", "REF").Extradata).toEqual({ bundle: " 5.7 GB" })
    expect(() => validatePurchase({ ...input, bundle: undefined })).toThrow(HubtelValidationError)
  })
  it("ghana water needs bundle + email + sessionId and sends Email/SessionId", () => {
    const input = { serviceKey: "bill_ghana_water" as const, destination: "233548359582", amount: 10, bundle: "080706070056", extra: { email: "a@b.co", sessionId: "sess1" } }
    expect(buildPurchaseBody(input, "https://cb", "REF").Extradata).toEqual({ bundle: "080706070056", Email: "a@b.co", SessionId: "sess1" })
    expect(() => validatePurchase({ ...input, extra: { sessionId: "s" } })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...input, extra: { email: "not-an-email", sessionId: "s" } })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...input, extra: { email: "a@b.co" } })).toThrow(HubtelValidationError)
  })
  it("tv bills send no Extradata", () => {
    expect(buildPurchaseBody({ serviceKey: "bill_dstv", destination: "7029864396", amount: 50 }, "https://cb", "REF").Extradata).toBeUndefined()
  })
  it("the request body carries Destination, CallbackUrl and ClientReference", () => {
    expect(buildPurchaseBody({ ...AIRTIME, destination: " 233246912184 " }, "https://cb", "REF"))
      .toEqual({ Destination: "233246912184", Amount: 5, CallbackUrl: "https://cb", ClientReference: "REF" })
  })
})

describe("purchase", () => {
  it("persists the row BEFORE calling Hubtel", async () => {
    const seen: string[] = []
    const ctx = setup({ transportCall: () => seen.push("called") })
    const store = ctx.store
    const orig = store.insert
    store.insert = async row => { seen.push("inserted"); return orig(row) }
    await ctx.client.purchase(AIRTIME)
    expect(seen).toEqual(["inserted", "called"])
  })
  it("0001 -> pending with trimmed hubtel id and commission; one POST only", async () => {
    const { client, calls, store } = setup()
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("pending")
    expect(tx.hubtel_transaction_id).toBe("abc123")
    expect(tx.commission).toBe(0.0198)
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("POST")
    expect(store.rows).toHaveLength(1)
  })
  it("sends a CallbackUrl whose signature verifies, and never logs the signature", async () => {
    const { client, calls, store } = setup()
    await client.purchase(AIRTIME)
    const u = new URL(calls[0].body.CallbackUrl)
    expect(u.searchParams.get("ref")).toBe("HCS-airtime_mtn-TESTREF1")
    expect(verifySig("HCS-airtime_mtn-TESTREF1", u.searchParams.get("sig"), "s3cret")).toBe(true)
    const reqEvent = store.events.find(e => e.direction === "request")!
    expect(JSON.stringify(reqEvent.payload)).not.toContain("sig=")
  })
  it("a transport error -> needs_review and the POST is NOT retried", async () => {
    const { client, calls } = setup({ results: [{ error: "timeout" }] })
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("needs_review")
    expect(calls).toHaveLength(1)
  })
  it("a transport that THROWS -> needs_review, not retried", async () => {
    const { client, calls } = setup({ transportCall: () => { throw new Error("boom") } })
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("needs_review")
    expect(calls).toHaveLength(1)
  })
  it("an html 5xx body -> needs_review, never failed", async () => {
    const { client } = setup({ results: [{ httpStatus: 502, body: "<html>Bad gateway</html>" }] })
    expect((await client.purchase(AIRTIME)).state).toBe("needs_review")
  })
  it("4075 -> failed and onFloat is called once", async () => {
    const { client, onFloat } = setup({ results: [{ httpStatus: 200, body: { ResponseCode: "4075", Message: "Insufficient prepaid balance." } }] })
    const tx = await client.purchase(AIRTIME)
    expect(tx.state).toBe("failed")
    expect(onFloat).toHaveBeenCalledTimes(1)
    expect(onFloat.mock.calls[0][0]).toMatch(/4075/)
  })
  it("a definite failure fires the order hook (row entered a terminal state)", async () => {
    const { client, onTransition } = setup({ results: [{ httpStatus: 400, body: { ResponseCode: "4010", Message: "Validation errors" } }] })
    expect((await client.purchase(AIRTIME)).state).toBe("failed")
    expect(onTransition).toHaveBeenCalledTimes(1)
  })
  it("stores the order link and extra on the row", async () => {
    const { client, store } = setup()
    await client.purchase({ ...AIRTIME, orderTable: "airtime_orders", orderId: "7d1f0c9e-1111-4222-8333-444455556666" })
    expect(store.rows[0].order_table).toBe("airtime_orders")
    expect(store.rows[0].order_id).toBe("7d1f0c9e-1111-4222-8333-444455556666")
  })
})

describe("purchase guards (no row is created)", () => {
  it("master switch off", async () => {
    const { client, store, calls } = setup({ cfg: { enabled: false } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelDisabledError)
    expect(store.rows).toHaveLength(0); expect(calls).toHaveLength(0)
  })
  it("config read failure fails closed (disabled, no row, no POST)", async () => {
    const { client, store, calls } = setup({ getConfig: async () => { throw new Error("db down") } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelDisabledError)
    expect(store.rows).toHaveLength(0); expect(calls).toHaveLength(0)
  })
  it("service switch off", async () => {
    const { client, store } = setup({ cfg: { services: { airtime_mtn: false } } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelServiceDisabledError)
    expect(store.rows).toHaveLength(0)
  })
  it("paused after a 4075", async () => {
    const { client, store } = setup({ cfg: { paused: true, pausedReason: "4075" } })
    await expect(client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelPausedError)
    expect(store.rows).toHaveLength(0)
  })
  it("missing callback secret or base url", async () => {
    await expect(setup({ callbackSecret: "" }).client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelNotConfiguredError)
    await expect(setup({ callbackBaseUrl: "" }).client.purchase(AIRTIME)).rejects.toBeInstanceOf(HubtelNotConfiguredError)
  })
  it("validation failures create nothing", async () => {
    const { client, store } = setup()
    await expect(client.purchase({ ...AIRTIME, amount: 100.01 })).rejects.toBeInstanceOf(HubtelValidationError)
    expect(store.rows).toHaveLength(0)
  })
})

describe("query", () => {
  const OK: TransportResult = { httpStatus: 200, body: { ResponseCode: "0000", Label: "Select bundle", Data: [{ Display: "80MB", Value: "DATA1", Amount: 1 }] } }
  it("returns the bundle list and sends destination in the query", async () => {
    const { client, calls } = setup({ results: [OK] })
    const out = await client.query("data_at", "233273833933")
    expect(out).toEqual({ ok: true, data: [{ Display: "80MB", Value: "DATA1", Amount: 1 }], label: "Select bundle" })
    expect(calls[0]).toMatchObject({ method: "GET", query: { destination: "233273833933" } })
  })
  it("ghana water requires the customer mobile", async () => {
    const { client } = setup({ results: [OK] })
    await expect(client.query("bill_ghana_water", "091019010006")).rejects.toBeInstanceOf(HubtelValidationError)
    const out = await setup({ results: [OK] }).client.query("bill_ghana_water", "091019010006", { mobile: "233242825109" })
    expect(out.ok).toBe(true)
  })
  it("airtime has no query endpoint", async () => {
    await expect(setup().client.query("airtime_mtn", "233246912184")).rejects.toBeInstanceOf(HubtelValidationError)
  })
  it("a non-0000 code or transport error -> ok:false", async () => {
    expect(await setup({ results: [{ httpStatus: 200, body: { ResponseCode: "4000", Message: "bad" } }] }).client.query("data_at", "1")).toEqual({ ok: false, error: "bad", code: "4000" })
    expect(await setup({ results: [{ error: "timeout" }] }).client.query("data_at", "1")).toEqual({ ok: false, error: "timeout" })
  })
  it("respects the master switch and service switch but NOT the pause (read-only)", async () => {
    await expect(setup({ cfg: { enabled: false } }).client.query("data_at", "1")).rejects.toBeInstanceOf(HubtelDisabledError)
    const out = await setup({ cfg: { paused: true }, results: [OK] }).client.query("data_at", "1")
    expect(out.ok).toBe(true)
  })
})

describe("outcome unknown / idempotency / destination", () => {
  it("a store failure AFTER the POST -> HubtelOutcomeUnknownError with the ref; exactly one POST", async () => {
    const { client, store, calls } = setup()
    store.updateGuarded = async () => { throw new Error("db down") }
    const err: any = await client.purchase(AIRTIME).catch(e => e)
    expect(err).toBeInstanceOf(HubtelOutcomeUnknownError)
    expect(err.clientReference).toBe("HCS-airtime_mtn-TESTREF1")
    expect(calls).toHaveLength(1)
    expect(store.rows[0].state).toBe("created")
  })
  it("an insert failure BEFORE the POST propagates unchanged and never calls the transport", async () => {
    const { client, store, calls } = setup()
    store.insert = async () => { throw new Error("insert down") }
    await expect(client.purchase(AIRTIME)).rejects.toThrow("insert down")
    expect(calls).toHaveLength(0)
  })
  it("a PostgREST 23505 object on insert -> HubtelDuplicateOrderError, no POST", async () => {
    const { client, store, calls } = setup()
    store.insert = async () => { throw { code: "23505", message: "dup" } }
    await expect(client.purchase({ ...AIRTIME, orderTable: "t", orderId: "o1" })).rejects.toBeInstanceOf(HubtelDuplicateOrderError)
    expect(calls).toHaveLength(0)
  })
  it("second purchase for the same order while the first is live -> duplicate, 1 POST total", async () => {
    const ctx = setup()
    const o = { ...AIRTIME, orderTable: "airtime_orders", orderId: "o1" }
    await ctx.client.purchase(o)
    const again = setup()
    again.store.rows.push(...ctx.store.rows.map(r => ({ ...r, client_reference: "OTHER-REF" })))
    await expect(again.client.purchase(o)).rejects.toBeInstanceOf(HubtelDuplicateOrderError)
    expect(again.calls).toHaveLength(0)
    expect(ctx.calls).toHaveLength(1)
  })
  it("needs_review also blocks; failed allows a new purchase", async () => {
    const ctx = setup({ results: [{ error: "timeout" }] })
    const o = { ...AIRTIME, orderTable: "airtime_orders", orderId: "o2" }
    expect((await ctx.client.purchase(o)).state).toBe("needs_review")
    const blocked = setup(); blocked.store.rows.push(...ctx.store.rows.map(r => ({ ...r, client_reference: "OTHER-REF" })))
    await expect(blocked.client.purchase(o)).rejects.toBeInstanceOf(HubtelDuplicateOrderError)
    ctx.store.rows[0].state = "failed"
    const ok = setup(); ok.store.rows.push(...ctx.store.rows.map(r => ({ ...r, client_reference: "OTHER-REF" })))
    expect((await ok.client.purchase(o)).state).toBe("pending")
  })
  it("airtime/data destinations normalise to 233XXXXXXXXX in body and row", async () => {
    for (const d of ["0246912184", "+233246912184", "233246912184", " 024 691 2184 "]) {
      const { client, calls, store } = setup()
      await client.purchase({ ...AIRTIME, destination: d })
      expect(calls[0].body.Destination).toBe("233246912184")
      expect(store.rows[0].destination).toBe("233246912184")
    }
  })
  it("invalid airtime number is rejected with no row and no POST", async () => {
    const { client, calls, store } = setup()
    await expect(client.purchase({ ...AIRTIME, destination: "12345" })).rejects.toBeInstanceOf(HubtelValidationError)
    expect(calls).toHaveLength(0); expect(store.rows).toHaveLength(0)
  })
  it("bill destinations pass through unchanged", async () => {
    const { client, calls } = setup()
    await client.purchase({ serviceKey: "bill_dstv", destination: " 7029864396 ", amount: 50 })
    expect(calls[0].body.Destination).toBe("7029864396")
  })
  it("onFloat is not fired when the commit lost the race (changed=false)", async () => {
    const { client, store, onFloat } = setup({ results: [{ httpStatus: 200, body: { ResponseCode: "4075", Message: "x" } }] })
    store.updateGuarded = async () => null
    await client.purchase(AIRTIME)
    expect(onFloat).not.toHaveBeenCalled()
  })
})

describe("validatePurchase orderTable/orderId pairing", () => {
  it("rejects one without the other (a NULL order_table would defeat the per-order unique index)", () => {
    expect(() => validatePurchase({ ...AIRTIME, orderId: "o1" })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...AIRTIME, orderTable: "airtime_orders" })).toThrow(HubtelValidationError)
    expect(() => validatePurchase({ ...AIRTIME, orderTable: "", orderId: "o1" })).toThrow(HubtelValidationError)
  })
  it("accepts both together or neither", () => {
    expect(() => validatePurchase({ ...AIRTIME, orderTable: "airtime_orders", orderId: "o1" })).not.toThrow()
    expect(() => validatePurchase(AIRTIME)).not.toThrow()
  })
})
