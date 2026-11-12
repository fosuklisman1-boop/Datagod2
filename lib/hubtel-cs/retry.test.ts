import { describe, expect, it } from "vitest"
import { ledgerRetryCheck, supersededBy, RETRYABLE_ORDER_TABLES } from "./retry"
import type { LedgerFact } from "@/lib/bills/admin"

const fact = (over: Partial<LedgerFact> = {}): LedgerFact => ({
  client_reference: "r1", state: "failed", refund_claimed_at: null, resolved_by: null, created_at: "2026-11-10T10:00:00Z", ...over,
})
const tx = (over: any = {}) => ({ client_reference: "r1", state: "failed", order_table: "airtime_orders", order_id: "o1", refund_claimed_at: null, resolved_by: null, ...over })

describe("ledgerRetryCheck", () => {
  it("allows the latest failed attempt of a linked order", () => {
    expect(ledgerRetryCheck(tx(), [fact()])).toEqual({ ok: true })
  })
  it("covers all three Hubtel order tables", () => {
    expect([...RETRYABLE_ORDER_TABLES].sort()).toEqual(["airtime_orders", "hubtel_bill_orders", "hubtel_data_orders"])
    for (const t of RETRYABLE_ORDER_TABLES) expect(ledgerRetryCheck(tx({ order_table: t }), [fact()]).ok).toBe(true)
  })
  it("refuses a row that is not failed", () => {
    expect(ledgerRetryCheck(tx({ state: "pending" }), [fact({ state: "pending" })]).ok).toBe(false)
  })
  it("refuses a row with no order (admin test purchase)", () => {
    expect(ledgerRetryCheck(tx({ order_table: null, order_id: null }), [])).toMatchObject({ ok: false, reason: expect.stringMatching(/not linked/i) })
  })
  it("refuses an unknown order table", () => {
    expect(ledgerRetryCheck(tx({ order_table: "mystery" }), [fact()]).ok).toBe(false)
  })
  it("refuses when a newer attempt exists for the same order", () => {
    const out = ledgerRetryCheck(tx(), [fact({ client_reference: "r2", state: "fulfilled", created_at: "2026-11-11T10:00:00Z" }), fact()])
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/newer attempt/i) })
  })
  it("refuses when any attempt is still live (Hubtel may deliver)", () => {
    expect(ledgerRetryCheck(tx(), [fact(), fact({ client_reference: "r0", state: "needs_review", created_at: "2026-11-09T10:00:00Z" })]).ok).toBe(false)
  })
  it("refuses once a refund was claimed on any attempt", () => {
    expect(ledgerRetryCheck(tx({ refund_claimed_at: "x" }), [fact({ refund_claimed_at: "x" })])).toMatchObject({ ok: false, reason: expect.stringMatching(/refund/i) })
    expect(ledgerRetryCheck(tx(), [fact(), fact({ client_reference: "r0", refund_claimed_at: "x", created_at: "2026-11-09T10:00:00Z" })]).ok).toBe(false)
  })
  it("refuses an admin-override failure (it may have been delivered)", () => {
    expect(ledgerRetryCheck(tx({ resolved_by: "a" }), [fact({ resolved_by: "a" })])).toMatchObject({ ok: false, reason: expect.stringMatching(/override/i) })
  })
  it("refuses while an earlier settled attempt has not synced to the order (a replayed onFailed could fail the retry)", () => {
    const out = ledgerRetryCheck(tx(), [fact({ order_synced_at: null })])
    expect(out).toMatchObject({ ok: false, reason: expect.stringMatching(/sync/i) })
    expect(ledgerRetryCheck(tx(), [fact({ order_synced_at: "2026-11-10T10:01:00Z" })]).ok).toBe(true)
  })
  it("refuses when the row itself is missing from the ledger read (fail closed)", () => {
    expect(ledgerRetryCheck(tx(), []).ok).toBe(false)
  })
})

describe("supersededBy", () => {
  it("returns the newest later attempt for the same order", () => {
    const ledger = [fact(), fact({ client_reference: "r2", state: "failed", created_at: "2026-11-11T10:00:00Z" }), fact({ client_reference: "r3", state: "fulfilled", created_at: "2026-11-12T10:00:00Z" })]
    expect(supersededBy(tx(), ledger)).toEqual({ ref: "r3", state: "fulfilled" })
  })
  it("is null for the latest attempt", () => {
    expect(supersededBy(tx(), [fact(), fact({ client_reference: "r0", created_at: "2026-11-01T10:00:00Z" })])).toBeNull()
  })
})
