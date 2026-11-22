import { describe, expect, it } from "vitest"
import { checkRiskyAck, judgeOrder, type OrderSnapshot, type Verdict } from "./eligibility"

const snap = (o: Partial<OrderSnapshot> = {}): OrderSnapshot => ({
  id: "o1",
  type: "bulk",
  status: "pending",
  network: "MTN",
  latestAttempt: null,
  hasLiveAttempt: false,
  queued: false,
  ...o,
})

describe("judgeOrder", () => {
  it("pending with no attempts is eligible", () => {
    expect(judgeOrder(snap(), "xpress")).toEqual({ kind: "eligible" })
  })
  it("pending with latest failed is eligible", () => {
    expect(judgeOrder(snap({ latestAttempt: { status: "failed", mtnOrderId: "X1" } }), "xpress")).toEqual({ kind: "eligible" })
  })
  it("status compare is case-insensitive and trimmed", () => {
    expect(judgeOrder(snap({ status: " Pending " }), "xpress")).toEqual({ kind: "eligible" })
  })
  it("completed is blocked", () => {
    expect(judgeOrder(snap({ status: "completed" }), "xpress")).toEqual({ kind: "blocked", reason: "completed" })
  })
  it("processing + latest processing is live_at_supplier", () => {
    expect(judgeOrder(snap({ status: "processing", latestAttempt: { status: "processing", mtnOrderId: "X1" } }), "xpress")).toEqual({
      kind: "blocked",
      reason: "live_at_supplier",
    })
  })
  it("processing with no attempt is live_at_supplier", () => {
    expect(judgeOrder(snap({ status: "processing" }), "xpress")).toEqual({ kind: "blocked", reason: "live_at_supplier" })
  })
  it("processing + latest abandoned is risky held", () => {
    expect(judgeOrder(snap({ status: "processing", latestAttempt: { status: "abandoned", mtnOrderId: null } }), "xpress")).toEqual({
      kind: "risky",
      why: "held",
    })
  })
  it("processing + UNKNOWN_ id is risky held", () => {
    expect(judgeOrder(snap({ status: "processing", latestAttempt: { status: "processing", mtnOrderId: "UNKNOWN_x" } }), "xpress")).toEqual({
      kind: "risky",
      why: "held",
    })
  })
  it("reversed is risky reversed", () => {
    expect(judgeOrder(snap({ status: "reversed" }), "xpress")).toEqual({ kind: "risky", why: "reversed" })
  })
  it("failed is not_pending", () => {
    expect(judgeOrder(snap({ status: "failed" }), "xpress")).toEqual({ kind: "blocked", reason: "not_pending" })
  })
  it("queued wins over risky", () => {
    expect(judgeOrder(snap({ status: "reversed", queued: true }), "xpress")).toEqual({ kind: "blocked", reason: "already_queued" })
  })
  it("pending with hasLiveAttempt is live_at_supplier", () => {
    expect(judgeOrder(snap({ hasLiveAttempt: true }), "xpress")).toEqual({ kind: "blocked", reason: "live_at_supplier" })
  })
  it("reversed with hasLiveAttempt is live_at_supplier (never risky)", () => {
    expect(judgeOrder(snap({ status: "reversed", hasLiveAttempt: true }), "xpress")).toEqual({ kind: "blocked", reason: "live_at_supplier" })
  })
  it("held processing order with hasLiveAttempt stays risky (held rule decides)", () => {
    expect(
      judgeOrder(snap({ status: "processing", hasLiveAttempt: true, latestAttempt: { status: "abandoned", mtnOrderId: null } }), "xpress"),
    ).toEqual({ kind: "risky", why: "held" })
  })
  it("Telecel + spfastit cannot be served", () => {
    expect(judgeOrder(snap({ network: "Telecel" }), "spfastit")).toEqual({ kind: "blocked", reason: "supplier_cannot_serve_network" })
  })
  it("capability check wins over risky", () => {
    expect(judgeOrder(snap({ network: "Telecel", status: "reversed" }), "spfastit")).toEqual({
      kind: "blocked",
      reason: "supplier_cannot_serve_network",
    })
  })
  it("null is not_found", () => {
    expect(judgeOrder(null, "xpress")).toEqual({ kind: "blocked", reason: "not_found" })
  })
})

describe("checkRiskyAck", () => {
  const risky: Verdict = { kind: "risky", why: "held" }
  const ok: Verdict = { kind: "eligible" }
  it("no risky, no ack is ok", () => {
    expect(checkRiskyAck([ok, ok], undefined)).toEqual({ ok: true })
  })
  it("3 risky + ack 3 is ok", () => {
    expect(checkRiskyAck([risky, risky, ok, risky], { count: 3 })).toEqual({ ok: true })
  })
  it("3 risky + ack 2 fails", () => {
    expect(checkRiskyAck([risky, risky, risky], { count: 2 })).toEqual({ ok: false, expected: 3 })
  })
  it("3 risky + missing ack fails", () => {
    expect(checkRiskyAck([risky, risky, risky], undefined)).toEqual({ ok: false, expected: 3 })
  })
})
