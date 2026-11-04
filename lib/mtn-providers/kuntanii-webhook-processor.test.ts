import { describe, it, expect, vi } from "vitest"
import {
  REFETCH_THROTTLE_MS,
  extractExternalOrderId,
  signatureHeaderSnapshot,
  processKuntaniiWebhook,
} from "./kuntanii-webhook-processor"

const UUID = "123e4567-e89b-12d3-a456-426614174000"

function deps(over: Record<string, any> = {}) {
  return {
    findTracking: vi.fn(async () => ({ id: "t1", webhook_received_at: null as string | null })),
    markReceived: vi.fn(async () => {}),
    sync: vi.fn(async () => ({ success: true })),
    refreshOpenDisputes: vi.fn(async () => {}),
    now: () => 1_000_000_000_000,
    ...over,
  }
}

describe("processKuntaniiWebhook", () => {
  it("forged body status is never applied: only re-fetches via sync(trackingId)", async () => {
    const d = deps()
    const r = await processKuntaniiWebhook(
      { externalOrderId: UUID, event: "order.completed", status: "completed" } as any,
      d
    )
    expect(r).toBe("synced")
    expect(d.markReceived).toHaveBeenCalledWith("t1")
    expect(d.sync).toHaveBeenCalledTimes(1)
    expect(d.sync).toHaveBeenCalledWith("t1")
    expect(d.markReceived.mock.invocationCallOrder[0]).toBeLessThan(d.sync.mock.invocationCallOrder[0])
  })

  it("unknown externalOrderId -> ignored, no sync", async () => {
    const d = deps({ findTracking: vi.fn(async () => null) })
    expect(await processKuntaniiWebhook({ externalOrderId: UUID, event: null }, d)).toBe("ignored")
    expect(d.sync).toHaveBeenCalledTimes(0)
    expect(d.markReceived).toHaveBeenCalledTimes(0)
  })

  it("within 15s of last receipt -> throttled", async () => {
    const now = 1_000_000_000_000
    const d = deps({
      findTracking: vi.fn(async () => ({
        id: "t1",
        webhook_received_at: new Date(now - (REFETCH_THROTTLE_MS - 1000)).toISOString(),
      })),
    })
    expect(await processKuntaniiWebhook({ externalOrderId: UUID, event: null }, d)).toBe("throttled")
    expect(d.sync).toHaveBeenCalledTimes(0)
  })

  it("older than throttle window -> synced", async () => {
    const now = 1_000_000_000_000
    const d = deps({
      findTracking: vi.fn(async () => ({
        id: "t1",
        webhook_received_at: new Date(now - REFETCH_THROTTLE_MS - 1).toISOString(),
      })),
    })
    expect(await processKuntaniiWebhook({ externalOrderId: UUID, event: null }, d)).toBe("synced")
  })

  it("not_received event refreshes disputes", async () => {
    const d = deps()
    await processKuntaniiWebhook({ externalOrderId: UUID, event: "order.not_received_reported" }, d)
    expect(d.refreshOpenDisputes).toHaveBeenCalledWith("t1")
    const d2 = deps()
    await processKuntaniiWebhook({ externalOrderId: UUID, event: "order.completed" }, d2)
    expect(d2.refreshOpenDisputes).not.toHaveBeenCalled()
  })

  it("a failing dep does not throw and later steps still run", async () => {
    const d = deps({ sync: vi.fn(async () => { throw new Error("boom") }) })
    await expect(
      processKuntaniiWebhook({ externalOrderId: UUID, event: "order.not_received_x" }, d)
    ).resolves.toBe("synced")
    expect(d.refreshOpenDisputes).toHaveBeenCalled()
  })
})

describe("extractExternalOrderId", () => {
  it("rejects bad values", () => {
    expect(extractExternalOrderId({ data: { externalOrderId: 123 } })).toBeNull()
    expect(extractExternalOrderId({ data: { externalOrderId: "a".repeat(200) } })).toBeNull()
    expect(extractExternalOrderId({ data: { externalOrderId: "DB-ORDER-12345" } })).toBeNull()
    expect(extractExternalOrderId(null)).toBeNull()
    expect(extractExternalOrderId({})).toBeNull()
  })
  it("accepts uuid and -r2", () => {
    expect(extractExternalOrderId({ data: { externalOrderId: UUID } })).toBe(UUID)
    expect(extractExternalOrderId({ data: { externalOrderId: `${UUID}-r2` } })).toBe(`${UUID}-r2`)
  })
})

describe("signatureHeaderSnapshot", () => {
  it("keeps signature/timestamp headers, drops others", () => {
    const h = new Headers({
      "x-kuntanii-signature": "abc",
      "x-kuntanii-timestamp": "123",
      "content-type": "application/json",
      authorization: "Bearer secret",
    })
    expect(signatureHeaderSnapshot(h)).toEqual({
      "x-kuntanii-signature": "abc",
      "x-kuntanii-timestamp": "123",
    })
  })
})
