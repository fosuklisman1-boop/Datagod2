import { describe, it, expect, vi } from "vitest"
import { deliverPrize, effectiveDeliveryStatus, type DeliveryDeps, type StartedDelivery } from "./delivery"

const PKG = "6f9619ff-8b86-4d11-b42d-00c04fc964ff"

function started(prize: Partial<StartedDelivery["prize"]>, delivery: Partial<StartedDelivery["delivery"]> = {}): StartedDelivery {
  return {
    delivery: { id: "d1", status: "in_progress", order_table: null, order_id: null, recipient_phone: null, attempts: 1, ...delivery },
    prize: { id: "p1", prize_type: "manual", label: "Prize", amount: null, package_id: null, network: null, duration_days: null, ...prize },
    result: { id: "r1", board: "dashboard", rank: 1, user_id: "u1" },
  }
}

function deps(s: StartedDelivery, over: Partial<DeliveryDeps> = {}) {
  const d = {
    start: vi.fn().mockResolvedValue(s),
    finish: vi.fn().mockResolvedValue(undefined),
    creditWallet: vi.fn().mockResolvedValue(undefined),
    grantDealerDays: vi.fn().mockResolvedValue({ action: "created", end_date: "2026-11-16T10:00:00Z" }),
    getPackage: vi.fn().mockResolvedValue({ id: PKG, network: "MTN", size: "10GB", name: "10GB" }),
    createDataOrder: vi.fn().mockResolvedValue("order-1"),
    fulfilDataOrder: vi.fn().mockResolvedValue({ success: true, message: "ok" }),
    createAirtimeOrder: vi.fn().mockResolvedValue({ id: "air-1", reference_code: "AT-1", network: "MTN", beneficiary_phone: "0241234567", airtime_amount: 20 }),
    fulfilAirtimeOrder: vi.fn().mockResolvedValue(true),
    notifyWinner: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
  return d as typeof d & DeliveryDeps
}

const run = (d: DeliveryDeps, phone?: string) => deliverPrize(d, { resultId: "r1", phone, periodLabel: "October 2026" })

describe("deliverPrize", () => {
  it("credits a cash prize with the idempotent reference and notifies the winner", async () => {
    const d = deps(started({ prize_type: "wallet_topup", label: "GH₵50 Cash", amount: 50 }))
    expect(await run(d)).toEqual({ ok: true, status: "delivered", message: "GH₵ 50.00 added to the winner's wallet" })
    expect(d.creditWallet).toHaveBeenCalledWith("u1", 50, "LB-r1", "Top Performers prize: GH₵50 Cash (October 2026)")
    expect(d.finish).toHaveBeenCalledWith("d1", "delivered")
    expect(d.notifyWinner).toHaveBeenCalledWith("u1", "Your prize has arrived!", expect.stringContaining("GH₵ 50.00 has been added to your wallet"))
  })

  it("grants dealer days and explains when the winner can't be upgraded", async () => {
    const ok = deps(started({ prize_type: "role_upgrade", duration_days: 15 }))
    expect(await run(ok)).toMatchObject({ ok: true, status: "delivered", message: "Winner is a dealer until 16 November 2026" })
    expect(ok.grantDealerDays).toHaveBeenCalledWith("u1", 15, "LB-r1")

    const refused = deps(started({ prize_type: "role_upgrade", duration_days: 15 }), {})
    refused.grantDealerDays.mockRejectedValue({ message: "not_upgradable" })
    const out = await run(refused)
    expect(out).toMatchObject({ ok: false, status: "failed" })
    expect(out.message).toContain("permanent dealer, a sub-agent or an admin")
    expect(refused.finish).toHaveBeenLastCalledWith("d1", "failed", { error: out.message })
  })

  it("creates and sends a data order, recording it before sending", async () => {
    const d = deps(started({ prize_type: "data_bundle", label: "10GB MTN", package_id: PKG }))
    expect(await run(d, "+233 24 123 4567")).toMatchObject({ ok: true, status: "sent" })
    expect(d.createDataOrder).toHaveBeenCalledWith({ userId: "u1", packageId: PKG, network: "MTN", size: "10GB", phone: "0241234567", reference: "LB-r1" })
    const calls = d.finish.mock.calls.map((c) => c[1])
    expect(calls).toEqual(["in_progress", "sent"])
    expect(d.finish.mock.invocationCallOrder[0]).toBeLessThan(d.fulfilDataOrder.mock.invocationCallOrder[0])
  })

  it("reuses the existing data order on retry instead of creating another", async () => {
    const d = deps(started({ prize_type: "data_bundle", label: "10GB", package_id: PKG }, { order_id: "order-old", recipient_phone: "0241234567" }))
    expect(await run(d)).toMatchObject({ ok: true })
    expect(d.createDataOrder).not.toHaveBeenCalled()
    expect(d.fulfilDataOrder).toHaveBeenCalledWith("order-old")
  })

  it("fails clearly when the data provider refuses, keeping the order for a retry", async () => {
    const d = deps(started({ prize_type: "data_bundle", label: "10GB", package_id: PKG }), { fulfilDataOrder: vi.fn().mockResolvedValue({ success: false, message: "Phone is blacklisted" }) })
    const out = await run(d, "0241234567")
    expect(out).toMatchObject({ ok: false, message: "The data order was created but could not be sent: Phone is blacklisted" })
    expect(d.finish.mock.calls.map((c) => c[1])).toEqual(["in_progress", "failed"])
  })

  it("sends airtime and treats a manual hand-off as sent", async () => {
    const d = deps(started({ prize_type: "airtime", label: "GH₵20 MTN Airtime", amount: 20, network: "MTN" }), { fulfilAirtimeOrder: vi.fn().mockResolvedValue(false) })
    expect(await run(d, "0241234567")).toMatchObject({ ok: true, status: "sent" })
    expect(d.createAirtimeOrder).toHaveBeenCalledWith({ userId: "u1", network: "MTN", amount: 20, phone: "0241234567", reference: "LB-r1" })
  })

  it("refuses a bad phone and manual prizes without sending anything", async () => {
    const bad = deps(started({ prize_type: "airtime", amount: 20, network: "MTN" }))
    expect(await run(bad, "12345")).toMatchObject({ ok: false, message: "Enter a valid Ghana phone number for this prize" })
    expect(bad.createAirtimeOrder).not.toHaveBeenCalled()

    const manual = deps(started({ prize_type: "manual" }))
    expect((await run(manual)).message).toContain("Mark delivered")
  })

  it("hides unexpected errors behind a generic message and still records the failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = deps(started({ prize_type: "wallet_topup", amount: 50 }), { creditWallet: vi.fn().mockRejectedValue(new Error("connection reset")) })
    const out = await run(d)
    expect(out).toEqual({ ok: false, status: "failed", message: "Delivery failed. Check the logs, then try again." })
    expect(d.finish).toHaveBeenLastCalledWith("d1", "failed", { error: out.message })
    spy.mockRestore()
  })

  it("does not undo a delivery when the notification fails", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const d = deps(started({ prize_type: "wallet_topup", amount: 50 }), { notifyWinner: vi.fn().mockRejectedValue(new Error("x")) })
    expect(await run(d)).toMatchObject({ ok: true, status: "delivered" })
    spy.mockRestore()
  })
})

describe("effectiveDeliveryStatus", () => {
  it("follows the order for sent prizes", () => {
    expect(effectiveDeliveryStatus("sent", "completed")).toBe("delivered")
    expect(effectiveDeliveryStatus("sent", "processing")).toBe("sent")
    expect(effectiveDeliveryStatus("sent", "failed")).toBe("failed")
    expect(effectiveDeliveryStatus("delivered", null)).toBe("delivered")
    expect(effectiveDeliveryStatus(null, null)).toBe("not_started")
  })
})
