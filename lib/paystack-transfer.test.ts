import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  mapNetworkToPaystackBankCode,
  toPesewas,
  matchBankByName,
  type PaystackBank,
  fetchGhanaBankList,
  createRecipient,
  initiateTransfer,
  finalizeTransfer,
  getTransferStatus,
  getPaystackTransferBalance,
} from "@/lib/paystack-transfer"

describe("mapNetworkToPaystackBankCode", () => {
  it("maps MTN", () => expect(mapNetworkToPaystackBankCode("MTN")).toBe("MTN"))
  it("maps Telecel and Vodafone to VOD", () => {
    expect(mapNetworkToPaystackBankCode("Telecel")).toBe("VOD")
    expect(mapNetworkToPaystackBankCode("Vodafone")).toBe("VOD")
  })
  it("maps AT and AirtelTigo to ATL", () => {
    expect(mapNetworkToPaystackBankCode("AT")).toBe("ATL")
    expect(mapNetworkToPaystackBankCode("AirtelTigo")).toBe("ATL")
  })
  it("is case-insensitive", () => expect(mapNetworkToPaystackBankCode("mtn")).toBe("MTN"))
  it("returns undefined for an unknown network", () => expect(mapNetworkToPaystackBankCode("XYZ")).toBeUndefined())
})

describe("toPesewas", () => {
  it("converts GHS to pesewas", () => expect(toPesewas(50)).toBe(5000))
  it("rounds fractional pesewas", () => expect(toPesewas(10.005)).toBe(1001))
})

describe("matchBankByName", () => {
  const banks: PaystackBank[] = [
    { name: "GCB Bank", code: "GCB" },
    { name: "Ecobank Ghana", code: "ECO" },
  ]
  it("matches an exact name", () => expect(matchBankByName("GCB Bank", banks)).toEqual(banks[0]))
  it("is case-insensitive", () => expect(matchBankByName("gcb bank", banks)).toEqual(banks[0]))
  it("trims whitespace", () => expect(matchBankByName("  GCB Bank  ", banks)).toEqual(banks[0]))
  it("does not fuzzy-match a partial name", () => expect(matchBankByName("GCB", banks)).toBeUndefined())
  it("returns undefined when no bank matches", () => expect(matchBankByName("Unknown Bank", banks)).toBeUndefined())
})

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  process.env.PAYSTACK_SECRET_KEY = "sk_test_123"
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchGhanaBankList", () => {
  it("maps the bank list response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ name: "GCB Bank", code: "GCB" }] }))
    const banks = await fetchGhanaBankList()
    expect(banks).toEqual([{ name: "GCB Bank", code: "GCB" }])
    expect(String(fetchMock.mock.calls[0][0])).toContain("/bank?currency=GHS")
  })
  it("returns [] on an error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: false, message: "error" }, 500))
    expect(await fetchGhanaBankList()).toEqual([])
  })
})

describe("createRecipient", () => {
  it("returns the recipient code on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: { recipient_code: "RCP_abc" } }))
    const result = await createRecipient({ name: "Jane Doe", accountNumber: "0241234567", bankCode: "MTN", type: "mobile_money" })
    expect(result).toEqual({ recipientCode: "RCP_abc" })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ type: "mobile_money", name: "Jane Doe", account_number: "0241234567", bank_code: "MTN", currency: "GHS" })
  })
  it("returns Paystack's error message when it rejects the recipient", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: false, message: "Invalid account" }, 400))
    const result = await createRecipient({ name: "Jane Doe", accountNumber: "bad", bankCode: "MTN", type: "mobile_money" })
    expect(result).toEqual({ error: "Invalid account" })
  })
})

describe("initiateTransfer", () => {
  const params = { recipientCode: "RCP_abc", amount: 50, reference: "wd-123" }

  it("converts amount to pesewas in the request body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "otp", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    await initiateTransfer(params)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.amount).toBe(5000)
    expect(body.recipient).toBe("RCP_abc")
    expect(body.reference).toBe("wd-123")
  })
  it("parses an OTP-required response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "otp", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    const result = await initiateTransfer(params)
    expect(result).toEqual({ status: "otp", transferCode: "TRF_1", transactionReference: "wd-123", fee: 50, errorMessage: undefined })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.recipient).toBe("RCP_abc")
    expect(body.reference).toBe("wd-123")
  })
  it("parses an immediate success response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_2", reference: "wd-123", fee: 0 } }))
    const result = await initiateTransfer(params)
    expect(result?.status).toBe("success")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.recipient).toBe("RCP_abc")
    expect(body.reference).toBe("wd-123")
  })
  it("returns a failed result on an error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Insufficient balance" }, 400))
    const result = await initiateTransfer(params)
    expect(result).toMatchObject({ status: "failed", errorMessage: "Insufficient balance" })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.recipient).toBe("RCP_abc")
    expect(body.reference).toBe("wd-123")
  })
  it("returns null on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
    expect(await initiateTransfer(params)).toBeNull()
  })
})

describe("finalizeTransfer", () => {
  it("parses a successful finalize response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    const result = await finalizeTransfer("TRF_1", "123456")
    expect(result?.status).toBe("success")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ transfer_code: "TRF_1", otp: "123456" })
  })
  it("returns a failed result on a rejected OTP", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Invalid OTP" }, 400))
    const result = await finalizeTransfer("TRF_1", "000000")
    expect(result).toMatchObject({ status: "failed", errorMessage: "Invalid OTP" })
  })
})

describe("getTransferStatus", () => {
  it("looks up by reference and parses the status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_1", reference: "wd-123", fee: 0 } }))
    const result = await getTransferStatus("wd-123")
    expect(result?.status).toBe("success")
    expect(String(fetchMock.mock.calls[0][0])).toContain("/transfer/verify/wd-123")
  })
})

describe("getPaystackTransferBalance", () => {
  it("finds the GHS entry among multiple currencies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ currency: "NGN", balance: 100000 }, { currency: "GHS", balance: 250000 }] }))
    expect(await getPaystackTransferBalance()).toEqual({ balance: 2500, currency: "GHS" })
  })
  it("returns null when there is no GHS balance", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ currency: "NGN", balance: 100000 }] }))
    expect(await getPaystackTransferBalance()).toBeNull()
  })
})
