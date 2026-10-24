import { describe, it, expect } from "vitest"
import {
  parseAirtimeNetwork,
  parseAmountPesewas,
  parseAirtimeBody,
  parseBillPayBody,
  parseBillLookupBody,
  requestHash,
  airtimeHash,
  billHash,
  mapCommissionStatus,
  mapAirtimeOrder,
  mapBillOrder,
  classifyEngineError,
  airtimeErrorResponse,
  billErrorResponse,
} from "./commission"

const okAirtime = (over: Record<string, unknown> = {}) =>
  parseAirtimeBody({ network: "MTN", recipient: "0249990501", amount: 5, reference: "REF-501", ...over })

describe("parseAirtimeNetwork", () => {
  it("accepts the spellings case-insensitively and maps AT/AirtelTigo to engine AT", () => {
    expect(parseAirtimeNetwork("MTN")).toEqual({ ok: true, network: "MTN", engineNetwork: "MTN" })
    expect(parseAirtimeNetwork("mtn")).toEqual({ ok: true, network: "MTN", engineNetwork: "MTN" })
    expect(parseAirtimeNetwork("Telecel")).toEqual({ ok: true, network: "Telecel", engineNetwork: "Telecel" })
    expect(parseAirtimeNetwork("TELECEL")).toEqual({ ok: true, network: "Telecel", engineNetwork: "Telecel" })
    expect(parseAirtimeNetwork("AT")).toEqual({ ok: true, network: "AT", engineNetwork: "AT" })
    expect(parseAirtimeNetwork("airteltigo")).toEqual({ ok: true, network: "AT", engineNetwork: "AT" })
    expect(parseAirtimeNetwork("AirtelTigo")).toEqual({ ok: true, network: "AT", engineNetwork: "AT" })
  })
  it("rejects everything else", () => {
    for (const v of ["", "vodafone", " MTN", "MTN ", "AT-iShare", 1, null, undefined, {}, "__proto__", "constructor"]) {
      expect(parseAirtimeNetwork(v).ok).toBe(false)
    }
  })
})

describe("parseAmountPesewas", () => {
  it("parses valid forms with integer arithmetic", () => {
    expect(parseAmountPesewas("5")).toEqual({ ok: true, pesewas: 500, amount: 5 })
    expect(parseAmountPesewas(5.5)).toEqual({ ok: true, pesewas: 550, amount: 5.5 })
    expect(parseAmountPesewas(5.55)).toEqual({ ok: true, pesewas: 555, amount: 5.55 })
    expect(parseAmountPesewas("0.01")).toEqual({ ok: true, pesewas: 1, amount: 0.01 })
    expect(parseAmountPesewas(1000)).toEqual({ ok: true, pesewas: 100000, amount: 1000 })
    expect(parseAmountPesewas("1.10")).toEqual({ ok: true, pesewas: 110, amount: 1.1 })
    // 1.15 * 100 = 114.99999999999999 in floats; must still be 115
    expect(parseAmountPesewas(1.15)).toEqual({ ok: true, pesewas: 115, amount: 1.15 })
    expect(parseAmountPesewas(4.35)).toEqual({ ok: true, pesewas: 435, amount: 4.35 })
  })
  it("rejects bad forms", () => {
    for (const v of [5.555, "5.555", 0, "0", "0.00", -1, "-1", NaN, Infinity, "1e3", 1e21, 1e-7, "5 ", " 5", "", "abc", "5.", ".5", "+5", "0x10", null, undefined, true, {}, [], "1,000"]) {
      expect(parseAmountPesewas(v).ok, String(v)).toBe(false)
    }
  })
  it("enforces max (default 1000) and honours opts.max", () => {
    expect(parseAmountPesewas(1000.01).ok).toBe(false)
    expect(parseAmountPesewas("1000.01").ok).toBe(false)
    expect(parseAmountPesewas(99999999999999).ok).toBe(false)
    expect(parseAmountPesewas("9".repeat(400)).ok).toBe(false)
    expect(parseAmountPesewas(2000, { max: 5000 }).ok).toBe(true)
    expect(parseAmountPesewas(5000.01, { max: 5000 }).ok).toBe(false)
  })
})

describe("parseAirtimeBody", () => {
  it("parses a valid body into the canonical input", () => {
    const r = okAirtime({ network: "airteltigo", recipient: "+233 24 999 0501", amount: "5.50", reference: "  REF-501 ", expected_pay: 5.5 })
    expect(r).toEqual({
      ok: true,
      value: {
        network: "AT",
        engineNetwork: "AT",
        recipient: { msisdn: "233249990501", local: "0249990501" },
        amount: 5.5,
        pesewas: 550,
        reference: "REF-501",
        expectedPay: 5.5,
      },
    })
  })
  it("omits expectedPay when absent or null", () => {
    for (const body of [okAirtime(), okAirtime({ expected_pay: null })]) {
      expect(body.ok && "expectedPay" in body.value).toBe(false)
    }
  })
  it("rejects a bad expected_pay", () => {
    for (const v of ["abc", -1, 0, "1e3", 5.555, {}]) expect(okAirtime({ expected_pay: v }).ok).toBe(false)
  })
  it("rejects non-objects", () => {
    for (const b of [null, undefined, "x", 5, [], [{}]]) expect(parseAirtimeBody(b).ok).toBe(false)
  })
  it("rejects bad network, recipient, amount, reference", () => {
    expect(okAirtime({ network: "x" }).ok).toBe(false)
    expect(okAirtime({ recipient: "0149990501" }).ok).toBe(false)
    expect(okAirtime({ recipient: undefined }).ok).toBe(false)
    expect(okAirtime({ amount: 0 }).ok).toBe(false)
    expect(okAirtime({ amount: 1001 }).ok).toBe(false)
    expect(okAirtime({ amount: undefined }).ok).toBe(false)
    expect(okAirtime({ reference: "ab" }).ok).toBe(false)
    expect(okAirtime({ reference: "a b c" }).ok).toBe(false)
    expect(okAirtime({ reference: undefined }).ok).toBe(false)
  })
  it("rejects forbidden price/ownership fields in any case", () => {
    for (const f of ["price", "Price", "PRICE", "fee", "Fee", "fee_amount", "FEE_AMOUNT", "total_paid", "cashback", "pay_separately", "status", "user_id", "total", "cost", "api_key_id", "package_id", "dealer_price", "recipient_phone"]) {
      expect(okAirtime({ [f]: 1 }).ok, f).toBe(false)
    }
  })
  it("ignores unknown harmless fields", () => {
    expect(okAirtime({ note: "hi" }).ok).toBe(true)
  })
})

describe("parseBillPayBody", () => {
  const token = "t".repeat(40)
  const pay = (over: Record<string, unknown> = {}) =>
    parseBillPayBody({ verify_token: token, amount: 50, reference: "BILL-501", ...over })
  it("parses a valid body", () => {
    expect(pay({ expected_pay: "49.5" })).toEqual({
      ok: true,
      value: { verifyToken: token, amount: 50, pesewas: 5000, reference: "BILL-501", expectedPay: 49.5 },
    })
  })
  it("verify_token must be a string of 10 to 4000 chars", () => {
    expect(pay({ verify_token: "x".repeat(9) }).ok).toBe(false)
    expect(pay({ verify_token: "x".repeat(10) }).ok).toBe(true)
    expect(pay({ verify_token: "x".repeat(4000) }).ok).toBe(true)
    expect(pay({ verify_token: "x".repeat(4001) }).ok).toBe(false)
    expect(pay({ verify_token: 123456789012 }).ok).toBe(false)
    expect(pay({ verify_token: undefined }).ok).toBe(false)
  })
  it("amount and reference rules and forbidden fields", () => {
    expect(pay({ amount: 0 }).ok).toBe(false)
    expect(pay({ amount: 5.555 }).ok).toBe(false)
    expect(pay({ amount: "1e3" }).ok).toBe(false)
    expect(pay({ reference: "x" }).ok).toBe(false)
    expect(pay({ Fee: 1 }).ok).toBe(false)
    expect(pay({ cashback: 1 }).ok).toBe(false)
    expect(pay({ total_paid: 1 }).ok).toBe(false)
    expect(parseBillPayBody(null).ok).toBe(false)
  })
})

describe("parseBillLookupBody", () => {
  it("maps the v1 shape", () => {
    expect(
      parseBillLookupBody({ biller: "ecg", account: "12345678", phone: "0249990502", add_meter: true, consent: true })
    ).toEqual({
      ok: true,
      biller: "ecg",
      inputs: { account: "12345678", phone: "0249990502", email: undefined, broadbandAccount: undefined, addMeter: true, consent: true },
    })
  })
  it("maps broadband_account and defaults flags false", () => {
    const r = parseBillLookupBody({ biller: "telecel_broadband", account: "0302000000", broadband_account: "BB123" })
    expect(r).toMatchObject({ ok: true, biller: "telecel_broadband", inputs: { broadbandAccount: "BB123", addMeter: false, consent: false } })
  })
  it("rejects unknown biller and non-objects", () => {
    expect(parseBillLookupBody({ biller: "nope" }).ok).toBe(false)
    expect(parseBillLookupBody({}).ok).toBe(false)
    expect(parseBillLookupBody(null).ok).toBe(false)
    expect(parseBillLookupBody([]).ok).toBe(false)
  })
})

describe("hashes", () => {
  const base = () => {
    const r = okAirtime({ recipient: "0249990503" })
    if (!r.ok) throw new Error("bad")
    return r.value
  }
  it("requestHash is stable across key order and hex sha256", () => {
    const a = requestHash("airtime", { b: 1, a: { y: 2, x: 3 } })
    const b = requestHash("airtime", { a: { x: 3, y: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(requestHash("bill", { b: 1, a: { y: 2, x: 3 } })).not.toBe(a)
  })
  it("airtimeHash is equal for every spelling of the same recipient and network", () => {
    const forms = ["0249990503", "233249990503", "+233249990503", "024 999 0503"]
    const hashes = forms.map((f) => {
      const r = okAirtime({ recipient: f })
      if (!r.ok) throw new Error(f)
      return airtimeHash(r.value)
    })
    expect(new Set(hashes).size).toBe(1)
    const at1 = okAirtime({ network: "AT" }), at2 = okAirtime({ network: "AirtelTigo" })
    if (!at1.ok || !at2.ok) throw new Error("x")
    expect(airtimeHash(at1.value)).toBe(airtimeHash(at2.value))
  })
  it("airtimeHash differs on amount, network, recipient and ignores expectedPay and reference", () => {
    const v = base()
    const h = airtimeHash(v)
    expect(airtimeHash({ ...v, pesewas: v.pesewas + 1, amount: 5.01 })).not.toBe(h)
    expect(airtimeHash({ ...v, network: "Telecel", engineNetwork: "Telecel" })).not.toBe(h)
    expect(airtimeHash({ ...v, recipient: { msisdn: "233249990504", local: "0249990504" } })).not.toBe(h)
    expect(airtimeHash({ ...v, expectedPay: 99 })).toBe(h)
    expect(airtimeHash({ ...v, reference: "OTHER-REF" })).toBe(h)
  })
  it("billHash hashes the token, ignores expectedPay, differs on token and amount", () => {
    const v = { verifyToken: "tok-aaaaaaaaaa", amount: 50, pesewas: 5000, reference: "BILL-503" }
    const h = billHash(v)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(billHash({ ...v, expectedPay: 49 })).toBe(h)
    expect(billHash({ ...v, verifyToken: "tok-bbbbbbbbbb" })).not.toBe(h)
    expect(billHash({ ...v, pesewas: 5001, amount: 50.01 })).not.toBe(h)
    expect(JSON.stringify(h)).not.toContain("tok-aaaaaaaaaa")
  })
})

describe("mapCommissionStatus", () => {
  it("maps known values and never leaks raw ones", () => {
    expect(mapCommissionStatus("pending_payment")).toBe("pending")
    expect(mapCommissionStatus("pending")).toBe("pending")
    expect(mapCommissionStatus("processing")).toBe("processing")
    expect(mapCommissionStatus("completed")).toBe("completed")
    expect(mapCommissionStatus(" Completed ")).toBe("completed")
    expect(mapCommissionStatus("failed")).toBe("failed")
    expect(mapCommissionStatus("refunded")).toBe("refunded")
    for (const v of ["weird", "", null, undefined, 5, {}]) expect(mapCommissionStatus(v)).toBe("processing")
  })
})

describe("order mappers (allow-list)", () => {
  it("mapAirtimeOrder returns exactly the allow-list", () => {
    const row = {
      id: "internal-id", user_id: "u1", reference_code: "AT-INTERNAL", network: "AT", beneficiary_phone: "233249990504",
      airtime_amount: "5.005", fee_amount: 0.25, total_paid: 5.25, cashback_amount: null, status: "pending_payment",
      created_at: "2026-10-24T00:00:00Z", notes: "secret", hubtel_client_reference: "hc", failure_reason: "boom",
      provider_reference: "p", shop_id: "s", expected_commission: 1,
    }
    const out = mapAirtimeOrder(row, "CLIENT-1")
    expect(Object.keys(out).sort()).toEqual(
      ["airtime_amount", "cashback", "created_at", "fee", "network", "recipient", "reference", "status", "total_paid"].sort()
    )
    expect(out).toMatchObject({ reference: "CLIENT-1", network: "AT", recipient: "0249990504", airtime_amount: 5.01, fee: 0.25, total_paid: 5.25, cashback: 0, status: "pending" })
    expect(JSON.stringify(out)).not.toContain("secret")
  })
  it("mapAirtimeOrder keeps cashback and local recipient, and tolerates junk", () => {
    const out = mapAirtimeOrder({ network: "MTN", beneficiary_phone: "0249990505", airtime_amount: 10, fee_amount: 0, total_paid: 9.5, cashback_amount: "0.5", status: "completed", created_at: "t" }, "R-1")
    expect(out).toMatchObject({ recipient: "0249990505", cashback: 0.5, status: "completed" })
    expect(mapAirtimeOrder({}, "R-2").status).toBe("processing")
  })
  it("mapBillOrder returns exactly the allow-list", () => {
    const row = {
      id: "x", user_id: "u", reference_code: "BL-INTERNAL", biller: "ecg", account_number: "12345678", customer_name: "A B",
      amount: 50, paid_amount: 49.5, cashback_amount: 0.5, status: "completed", payment_status: "paid", created_at: "t",
      notes: "secret", hubtel_client_reference: "hc", failure_reason: "boom", commission: 2, phone: "0249990506", email: "e@x.y",
    }
    const out = mapBillOrder(row, "CLIENT-2")
    expect(Object.keys(out).sort()).toEqual(
      ["account", "biller", "cashback", "created_at", "customer_name", "face_amount", "paid_amount", "reference", "status"].sort()
    )
    expect(out).toMatchObject({ reference: "CLIENT-2", face_amount: 50, paid_amount: 49.5, cashback: 0.5, status: "completed" })
    expect(JSON.stringify(out)).not.toContain("secret")
  })
  it("mapBillOrder defaults paid_amount to amount and cashback to 0", () => {
    const out = mapBillOrder({ biller: "dstv", account_number: "1", customer_name: null, amount: 20, status: "failed", created_at: "t" }, "R-3")
    expect(out).toMatchObject({ paid_amount: 20, cashback: 0, status: "failed", customer_name: null })
  })
})

describe("classifyEngineError", () => {
  it("no_charge only for codes raised before any debit", () => {
    for (const c of ["NETWORK_DISABLED", "NETWORK_MISMATCH", "INVALID_AMOUNT", "DUPLICATE_REQUEST", "PRICE_CHANGED", "INSUFFICIENT_BALANCE"]) {
      expect(classifyEngineError(c), c).toBe("no_charge")
    }
  })
  it("ambiguous for everything else", () => {
    for (const c of ["PAYMENT_FAILED", "ORDER_CREATE_FAILED", undefined, null, "", 402, {}, "network_disabled", "SOMETHING_ELSE"]) {
      expect(classifyEngineError(c), String(c)).toBe("ambiguous")
    }
  })
})

describe("error responses", () => {
  it("airtimeErrorResponse follows the v1 status table", () => {
    const code = (c: string, extra: object = {}) => airtimeErrorResponse(Object.assign(new Error("engine detail"), { code: c }, extra))
    expect(code("NETWORK_DISABLED").status).toBe(503)
    expect(code("NETWORK_MISMATCH").status).toBe(400)
    expect(code("INVALID_AMOUNT").status).toBe(400)
    expect(code("DUPLICATE_REQUEST").status).toBe(409)
    expect(code("PAYMENT_FAILED").status).toBe(500)
    expect(code("ORDER_CREATE_FAILED").status).toBe(500)
    const ins = code("INSUFFICIENT_BALANCE", { required: 5.25 })
    expect(ins).toMatchObject({ status: 402, required: 5.25 })
    const pc = code("PRICE_CHANGED", { quote: { faceAmount: 5, payAmount: 5.25, customerCashback: 0, feeAmount: 1 } })
    expect(pc).toMatchObject({ status: 409, quote: { face_amount: 5, pay_amount: 5.25, customer_cashback: 0 } })
    expect(Object.keys((pc as any).quote).sort()).toEqual(["customer_cashback", "face_amount", "pay_amount"])
  })
  it("airtimeErrorResponse never leaks engine messages and handles unknowns", () => {
    for (const e of [new Error("db password"), undefined, null, "str", { code: 5 }]) {
      const r = airtimeErrorResponse(e)
      expect(r.status).toBe(500)
      expect(JSON.stringify(r)).not.toContain("db password")
    }
    expect(airtimeErrorResponse(Object.assign(new Error("secret sql"), { code: "PAYMENT_FAILED" })).message).not.toContain("secret")
  })
  it("billErrorResponse maps results", () => {
    expect(billErrorResponse({ ok: false, status: 402, error: "Insufficient wallet balance" }).status).toBe(402)
    expect(billErrorResponse({ ok: false, status: 400, error: "Invalid request" }).status).toBe(400)
    const q = billErrorResponse({ ok: false, status: 409, error: "Price updated — please review", quote: { faceAmount: 50, payAmount: 49.5, customerCashback: 0.5 } })
    expect(q).toMatchObject({ status: 409, quote: { face_amount: 50, pay_amount: 49.5, customer_cashback: 0.5 } })
    // unexpected statuses collapse to 500 with a fixed message
    const odd = billErrorResponse({ ok: false, status: 418, error: "internal stack trace" })
    expect(odd.status).toBe(500)
    expect(JSON.stringify(odd)).not.toContain("stack trace")
    expect(billErrorResponse({ ok: false, status: 502, error: "x" }).status).toBe(500)
  })
})
