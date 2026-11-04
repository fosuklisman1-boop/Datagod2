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
    findTracking: vi.fn(async () => ({ id: "t1", status: "pending", webhook_received_at: null as string | null })),
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
        status: "pending",
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
        status: "processing",
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

  it("completed row + not_received event: no sync, disputes still refreshed", async () => {
    const d = deps({ findTracking: vi.fn(async () => ({ id: "t1", status: "completed", webhook_received_at: null })) })
    const r = await processKuntaniiWebhook({ externalOrderId: UUID, event: "order.not_received_reported" }, d)
    expect(r).toBe("terminal")
    expect(d.sync).not.toHaveBeenCalled()
    expect(d.refreshOpenDisputes).toHaveBeenCalledWith("t1")
  })

  it("completed row + other event -> terminal, no sync", async () => {
    const d = deps({ findTracking: vi.fn(async () => ({ id: "t1", status: "completed", webhook_received_at: null })) })
    const r = await processKuntaniiWebhook({ externalOrderId: UUID, event: "order.completed" }, d)
    expect(r).toBe("terminal")
    expect(d.sync).not.toHaveBeenCalled()
    expect(d.refreshOpenDisputes).not.toHaveBeenCalled()
  })

  it("failed / reversed / abandoned rows are never synced", async () => {
    for (const status of ["failed", "reversed", "abandoned"]) {
      const d = deps({ findTracking: vi.fn(async () => ({ id: "t1", status, webhook_received_at: null })) })
      expect(await processKuntaniiWebhook({ externalOrderId: UUID, event: "order.cancelled" }, d)).toBe("terminal")
      expect(d.sync).not.toHaveBeenCalled()
    }
  })

  it("processing and retrying rows are still synced", async () => {
    for (const status of ["processing", "retrying"]) {
      const d = deps({ findTracking: vi.fn(async () => ({ id: "t1", status, webhook_received_at: null })) })
      expect(await processKuntaniiWebhook({ externalOrderId: UUID, event: null }, d)).toBe("synced")
      expect(d.sync).toHaveBeenCalledWith("t1")
    }
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

describe("resolveWebhookEvent / isBodyTooLarge", () => {
  it("prefers the header, slicing to 64 chars", async () => {
    const { resolveWebhookEvent } = await import("./kuntanii-webhook-processor")
    expect(resolveWebhookEvent("order.completed", { event: "other" })).toBe("order.completed")
    expect(resolveWebhookEvent("e".repeat(100), null)).toHaveLength(64)
  })
  it("falls back to a string body event, ignores non-strings", async () => {
    const { resolveWebhookEvent } = await import("./kuntanii-webhook-processor")
    expect(resolveWebhookEvent(null, { event: "order.not_received_resolved" })).toBe("order.not_received_resolved")
    expect(resolveWebhookEvent(null, { event: 5 })).toBeNull()
    expect(resolveWebhookEvent("", { event: "x" })).toBe("x")
    expect(resolveWebhookEvent(null, "str")).toBeNull()
  })
  it("counts bytes, not characters", async () => {
    const { isBodyTooLarge } = await import("./kuntanii-webhook-processor")
    expect(isBodyTooLarge("a".repeat(65536))).toBe(false)
    expect(isBodyTooLarge("a".repeat(65537))).toBe(true)
    // 32769 two-byte chars = 65538 bytes but only 32769 string length
    expect(isBodyTooLarge("é".repeat(32769))).toBe(true)
  })
})

import { createHmac } from "crypto"
import { verifyKuntaniiSignature } from "./kuntanii-webhook-processor"

describe("verifyKuntaniiSignature", () => {
  const secret = "fake-test-secret"
  const body = '{"data":{"externalOrderId":"x"}}'
  const good = "sha256=" + createHmac("sha256", secret).update(body).digest("hex")

  it("match", () => expect(verifyKuntaniiSignature(body, good, secret)).toBe("match"))
  it("mismatch on tampered body", () => expect(verifyKuntaniiSignature(body + " ", good, secret)).toBe("mismatch"))
  it("mismatch on wrong secret", () => expect(verifyKuntaniiSignature(body, good, "other")).toBe("mismatch"))
  it("missing_header", () => {
    expect(verifyKuntaniiSignature(body, null, secret)).toBe("missing_header")
    expect(verifyKuntaniiSignature(body, "", secret)).toBe("missing_header")
  })
  it("no_secret", () => {
    expect(verifyKuntaniiSignature(body, good, undefined)).toBe("no_secret")
    expect(verifyKuntaniiSignature(body, good, "")).toBe("no_secret")
  })
  it("malformed header: no prefix / wrong length / bad hex", () => {
    expect(verifyKuntaniiSignature(body, good.slice(7), secret)).toBe("mismatch")
    expect(verifyKuntaniiSignature(body, "sha256=abcd", secret)).toBe("mismatch")
    expect(verifyKuntaniiSignature(body, "sha256=" + "z".repeat(64), secret)).toBe("mismatch")
  })
})
