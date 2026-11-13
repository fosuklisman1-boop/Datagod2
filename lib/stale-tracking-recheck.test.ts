import { describe, it, expect } from "vitest"
import { classifyRecheck, redactPhoneNumbers, runStaleRecheck, type StaleRow } from "./stale-tracking-recheck"

function harness(opts: {
  apply: boolean
  providerSays: { success: boolean; status?: string; message?: string }
  orderStatus: string | null
  syncReturns?: { success: boolean; newStatus?: string }
}) {
  const syncCalls: string[] = []
  const deps = {
    check: async () => opts.providerSays,
    orderStatus: async () => opts.orderStatus,
    sync: async (id: string) => {
      syncCalls.push(id)
      return opts.syncReturns ?? { success: true, newStatus: "completed" }
    },
    sleep: async () => {},
  }
  const rows: StaleRow[] = [{ id: "t1", mtn_order_id: "m1", provider: "agentportalgh", order_type: "bulk", created_at: "2026-10-01T00:00:00Z" }]
  return { run: () => runStaleRecheck(rows, { apply: opts.apply }, deps), syncCalls }
}

describe("runStaleRecheck apply rule", () => {
  it("never writes on a dry run, even when the provider confirms completion", async () => {
    const h = harness({ apply: false, providerSays: { success: true, status: "completed" }, orderStatus: "processing" })
    const out = await h.run()
    expect(h.syncCalls).toEqual([])
    expect(out.rows[0]).toMatchObject({ verdict: "confirm_completed", orderStatus: "processing", applied: false })
  })

  it("never applies a provider-confirmed failure", async () => {
    const h = harness({ apply: true, providerSays: { success: true, status: "failed" }, orderStatus: "processing" })
    const out = await h.run()
    expect(h.syncCalls).toEqual([])
    expect(out.counts).toMatchObject({ confirm_failed: 1, applied: 0 })
  })

  it("never touches an order that is no longer pending/processing (refunded, cancelled, completed...)", async () => {
    for (const s of ["refunded", "cancelled", "completed", "failed", null]) {
      const h = harness({ apply: true, providerSays: { success: true, status: "completed" }, orderStatus: s })
      const out = await h.run()
      expect(h.syncCalls).toEqual([])
      expect(out.rows[0]).toMatchObject({ verdict: "confirm_completed", skipped: "order_not_open", applied: false })
      expect(out.counts.skipped_order_not_open).toBe(1)
    }
  })

  it("applies a confirmed completion on an open order, and only counts it if the write really ended completed", async () => {
    const ok = harness({ apply: true, providerSays: { success: true, status: "completed" }, orderStatus: "pending" })
    const okOut = await ok.run()
    expect(ok.syncCalls).toEqual(["t1"])
    expect(okOut.rows[0].applied).toBe(true)
    expect(okOut.counts.applied).toBe(1)

    const flipped = harness({
      apply: true,
      providerSays: { success: true, status: "completed" },
      orderStatus: "processing",
      syncReturns: { success: true, newStatus: "failed" },
    })
    const flippedOut = await flipped.run()
    expect(flippedOut.rows[0].applied).toBe(false)
    expect(flippedOut.counts.applied).toBe(0)
  })

  it("masks phone numbers in the reported provider message", async () => {
    const h = harness({ apply: false, providerSays: { success: true, status: "failed", message: "dup: 0530191982" }, orderStatus: "processing" })
    const out = await h.run()
    expect(out.rows[0].providerMessage).toBe("dup: ***1982")
  })
})

describe("redactPhoneNumbers", () => {
  it("masks local and international phone numbers in a provider message", () => {
    expect(redactPhoneNumbers("These numbers appear more than once: 0530191982, 233533027123")).toBe(
      "These numbers appear more than once: ***1982, ***7123"
    )
  })

  it("leaves short numbers (sizes, codes) and null alone", () => {
    expect(redactPhoneNumbers("1GB order already active (ref BULK_API_D5AE086F30)")).toBe(
      "1GB order already active (ref BULK_API_D5AE086F30)"
    )
    expect(redactPhoneNumbers(null)).toBeNull()
  })
})

describe("classifyRecheck", () => {
  it("confirms completed only when the provider call succeeded and says completed", () => {
    expect(classifyRecheck({ success: true, status: "completed" })).toBe("confirm_completed")
  })

  it("confirms failed only when the provider call succeeded and says failed", () => {
    expect(classifyRecheck({ success: true, status: "failed" })).toBe("confirm_failed")
  })

  it.each([
    [{ success: true, status: "processing", message: "Order in flight (not yet found in order listing)" }],
    [{ success: true, status: "pending" }],
    [{ success: false, message: "Service temporarily unavailable" }],
    [{ success: false, status: "completed" }], // a failed call never counts as an answer
    [{ success: true }], // no status
  ])("everything else is unresolved: %o", (r) => {
    expect(classifyRecheck(r)).toBe("unresolved")
  })
})
