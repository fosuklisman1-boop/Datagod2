import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// api.digiwapy.com's TLS broke 2026-07-02 (custom-domain cert gone) while the
// API stayed up on Digiwapy's raw Supabase functions host. These tests pin the
// network-error fallback: primary host first, fallback host only when the
// primary fetch rejects at the network level (undici "fetch failed").

import { sendAirtimeViaDigiwapy, fetchDigiWapyTransactionStatus } from "@/lib/digiwapy-provider"

const PRIMARY_HOST = "https://api.digiwapy.com"
const FALLBACK_HOST = "https://uzizihluxnhxnsluokki.supabase.co"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  process.env.DIGIWAPY_API_KEY = "test-key"
  process.env.DIGIWAPY_PARTNER_CODE = "test-partner"
  delete process.env.DIGIWAPY_BASE_URL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const sendParams = { network: "MTN", recipient: "0241234567", amount: 5, reference: "AT-TST-001" }

describe("sendAirtimeViaDigiwapy host fallback", () => {
  it("uses the primary host when it responds", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Airtime sent", data: { reference: "DGW-1" } }))

    const result = await sendAirtimeViaDigiwapy(sendParams)

    expect(result).toMatchObject({ success: true, digiwapyRef: "DGW-1" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(`${PRIMARY_HOST}/v1/airtime/send`)
  })

  it("retries on the fallback host when the primary fetch fails at the network level", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ message: "Airtime sent", data: { reference: "DGW-2" } }))

    const result = await sendAirtimeViaDigiwapy(sendParams)

    expect(result).toMatchObject({ success: true, digiwapyRef: "DGW-2" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain(`${FALLBACK_HOST}/functions/v1/api/v1/airtime/send`)
    // Same idempotency key on both attempts — the retry must not double-send
    const h1 = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    const h2 = (fetchMock.mock.calls[1][1] as RequestInit).headers as Record<string, string>
    expect(h1["X-Idempotency-Key"]).toBe("AIRTIME-AT-TST-001")
    expect(h2["X-Idempotency-Key"]).toBe("AIRTIME-AT-TST-001")
  })

  it("returns failure when both hosts are unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))

    const result = await sendAirtimeViaDigiwapy(sendParams)

    expect(result.success).toBe(false)
    expect(result.message).toBe("fetch failed")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not fall back on an HTTP error response (only network-level failures)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Insufficient balance" }, 402))

    const result = await sendAirtimeViaDigiwapy(sendParams)

    expect(result).toMatchObject({ success: false, message: "Insufficient balance" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("honors DIGIWAPY_BASE_URL override as the primary host", async () => {
    process.env.DIGIWAPY_BASE_URL = "https://override.example.com/v1"
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Airtime sent" }))

    await sendAirtimeViaDigiwapy(sendParams)

    expect(String(fetchMock.mock.calls[0][0])).toContain("https://override.example.com/v1/airtime/send")
  })
})

describe("fetchDigiWapyTransactionStatus host fallback", () => {
  it("retries on the fallback host after a network-level failure", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { reference: "AT-TST-001", status: "completed" } }))

    const txn = await fetchDigiWapyTransactionStatus("AT-TST-001")

    expect(txn?.status).toBe("completed")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain(`${FALLBACK_HOST}/functions/v1/api/v1/transactions/status`)
  })
})
