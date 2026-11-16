import { describe, it, expect } from "vitest"
import {
  isUnpaid, formatCappedCount,
  amountError, balanceAfter, parseAmountInput, parseOrderFilters, parsePaging, parseTxFilter,
  parseWalletAdjustBody, reasonError, walletAdjustError,
} from "./drawer-params"

const sp = (s: string) => new URLSearchParams(s)
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

describe("parsePaging", () => {
  it("defaults to page 1 of 20", () => {
    expect(parsePaging(sp(""))).toEqual({ ok: true, value: { page: 1, pageSize: 20, offset: 0, to: 19 } })
  })
  it("computes offset and inclusive end", () => {
    expect(parsePaging(sp("page=3&pageSize=10"))).toEqual({ ok: true, value: { page: 3, pageSize: 10, offset: 20, to: 29 } })
  })
  it("rejects anything that is not a whole number in range", () => {
    for (const q of ["page=0", "page=-1", "page=1.5", "page=1e3", "page=abc", "page=10001", "pageSize=0", "pageSize=51", "pageSize=x", "page= 2"]) {
      expect(parsePaging(sp(q)).ok, q).toBe(false)
    }
  })
  it("honours a custom max", () => {
    expect(parsePaging(sp("pageSize=80"), { maxSize: 100 }).ok).toBe(true)
  })
})

describe("filters", () => {
  it("order source and status are allow-listed", () => {
    expect(parseOrderFilters(sp("source=airtime&status=failed"))).toEqual({ ok: true, value: { source: "airtime", status: "failed" } })
    expect(parseOrderFilters(sp(""))).toEqual({ ok: true, value: { source: null, status: null } })
    expect(parseOrderFilters(sp("source=shop")).ok).toBe(false)
    expect(parseOrderFilters(sp("status=FAILED")).ok).toBe(false)
  })
  it("refund clawbacks (and their undo) are a filter group", async () => {
    const { TX_FILTERS } = await import("./drawer-params")
    expect(parseTxFilter(sp("type=clawback"))).toEqual({ ok: true, value: "clawback" })
    expect([...TX_FILTERS.clawback]).toEqual(["refund_clawback", "refund_clawback_undo"])
  })
  it("transaction type groups", () => {
    expect(parseTxFilter(sp("type=admin"))).toEqual({ ok: true, value: "admin" })
    expect(parseTxFilter(sp(""))).toEqual({ ok: true, value: null })
    expect(parseTxFilter(sp("type=toString")).ok).toBe(false)
  })
})

describe("orders tab labels", () => {
  it("unpaid: payment taken outside the wallet that never completed", () => {
    for (const s of ["unpaid", "pending", "pending_payment", "failed", "UNPAID"]) expect(isUnpaid(s), s).toBe(true)
    for (const s of [null, undefined, "paid", "completed", "refunded"]) expect(isUnpaid(s), String(s)).toBe(false)
  })
  it("capped counts read as 1000+", () => {
    expect(formatCappedCount(12, false)).toBe("12")
    expect(formatCappedCount(1000, true)).toBe("1,000+")
  })
  it("pending_payment is a status filter", () => {
    expect(parseOrderFilters(sp("status=pending_payment")).ok).toBe(true)
  })
})

describe("wallet adjustment validation", () => {
  it("amount: > 0, at most 2 decimals, at most 50000", () => {
    for (const ok of [0.01, 1, 1.1, 12.34, 50000]) expect(amountError(ok), String(ok)).toBeNull()
    for (const bad of [0, -1, 1.005, 0.001, 50000.01, NaN, Infinity, "5", null]) expect(amountError(bad), String(bad)).not.toBeNull()
  })
  it("reason: 5 to 500 characters after trimming", () => {
    expect(reasonError("refund")).toBeNull()
    expect(reasonError("   abcd   ")).not.toBeNull()
    expect(reasonError("x".repeat(500))).toBeNull()
    expect(reasonError("x".repeat(501))).not.toBeNull()
    expect(reasonError(undefined)).not.toBeNull()
  })
  it("typed amounts", () => {
    expect(parseAmountInput(" 12.5 ")).toEqual({ ok: true, amount: 12.5 })
    for (const bad of ["", "abc", "1.234", "-1", "1e2", "0", "0.00", "1,000", "50000.01"]) expect(parseAmountInput(bad).ok, bad).toBe(false)
  })
  it("parses a full body and trims the reason", () => {
    expect(parseWalletAdjustBody({ userId: U, type: "debit", amount: 2.5, reason: "  chargeback  ", expectedBalance: 10 }))
      .toEqual({ ok: true, value: { userId: U, type: "debit", amount: 2.5, reason: "chargeback", expectedBalance: 10 } })
    expect(parseWalletAdjustBody({ userId: U, type: "credit", amount: 1, reason: "reason" }))
      .toMatchObject({ ok: true, value: { expectedBalance: null } })
    for (const bad of [null, "x", { userId: "nope", type: "credit", amount: 1, reason: "reason" }, { userId: U, type: "credit", amount: 1, reason: "reason", expectedBalance: NaN }]) {
      expect(parseWalletAdjustBody(bad).ok).toBe(false)
    }
  })
  it("balance after is exact to the pesewa", () => {
    expect(balanceAfter(0.1, "credit", 0.2)).toBe(0.3)
    expect(balanceAfter(10, "debit", 10.01)).toBe(-0.01)
    expect(balanceAfter(1.15, "debit", 1.15)).toBe(0)
  })
  it("maps RPC errors", () => {
    expect(walletAdjustError("INSUFFICIENT_BALANCE").status).toBe(409)
    expect(walletAdjustError("BAD_INPUT", "reason must be 5 to 500 characters")).toEqual({ status: 400, error: "reason must be 5 to 500 characters" })
    expect(walletAdjustError(undefined).status).toBe(500)
  })
})
