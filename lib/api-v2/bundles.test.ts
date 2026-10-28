import { describe, it, expect } from "vitest"
import { signBundleToken } from "@/lib/standard-bundles/token"
import {
  BUNDLE_CATALOG_VALID_SECONDS,
  MSG_BUNDLE_NOT_AVAILABLE,
  MSG_BUNDLE_TOKEN_EXPIRED,
  MSG_BUNDLE_UNAVAILABLE,
  MSG_BUNDLE_UNAVAILABLE_FOR_NUMBER,
  MSG_BUNDLE_INSUFFICIENT,
  bundleEngineKey,
  bundleHash,
  classifyBundleRefusal,
  mapBundleCatalog,
  mapBundleOrder,
  parseBundleNetwork,
  parseBundlePurchaseBody,
} from "./bundles"

// Unique test phones for this file: 0249991070-0249991079.
const PHONE = "0249991070"
const SECRET = "test-secret-not-real"
const ISSUED = 1_800_000_000_000

function liveToken(over: Partial<{ network: string; value: string; amount: number; display: string; category: string; issuedAt: number }> = {}) {
  return signBundleToken(
    { network: "MTN", value: "1GB-VAL", amount: 5.5, display: "1GB", category: "Data", issuedAt: ISSUED, ...over } as any,
    SECRET
  )
}

const body = (over: Record<string, unknown> = {}) => ({
  bundle_token: liveToken(),
  recipient: PHONE,
  reference: "BND-001",
  ...over,
})

describe("parseBundleNetwork", () => {
  it.each([
    ["MTN", "MTN", "MTN"],
    ["mtn", "MTN", "MTN"],
    ["Telecel", "Telecel", "TELECEL"],
    ["TELECEL", "Telecel", "TELECEL"],
    ["AT", "AT", "AT"],
    ["airteltigo", "AT", "AT"],
  ])("%s => %s", (input, network, engineNetwork) => {
    expect(parseBundleNetwork(input)).toEqual({ ok: true, network, engineNetwork })
  })

  it.each([undefined, null, "", "vodafone", "MTN ", 7, {}, ["MTN"], "constructor", "__proto__"])("rejects %j", (v) => {
    const r = parseBundleNetwork(v)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe("network must be one of: MTN, Telecel, AT")
  })
})

describe("parseBundlePurchaseBody", () => {
  it("accepts a live token, normalises the recipient and keeps the reference", () => {
    const r = parseBundlePurchaseBody(body({ recipient: "+233249991070", reference: " BND-001 " }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.kind).toBe("live")
    expect(r.value.recipient).toEqual({ msisdn: "233249991070", local: PHONE })
    expect(r.value.reference).toBe("BND-001")
    expect(r.value.expectedPay).toBeUndefined()
    expect(r.value.identity).toEqual({ network: "MTN", value: "1GB-VAL", pesewas: 550 })
  })

  it("accepts a sandbox token", () => {
    const r = parseBundlePurchaseBody(body({ bundle_token: "sbx_mtn_1gb" }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.kind).toBe("sandbox")
  })

  it("parses expected_pay as a number or plain decimal string", () => {
    for (const [v, want] of [[5.5, 5.5], ["5.50", 5.5], [10, 10]] as const) {
      const r = parseBundlePurchaseBody(body({ expected_pay: v }))
      expect(r.ok && r.value.expectedPay).toBe(want)
    }
    for (const v of [0, -1, "abc", "1e2", "5.555", NaN, Infinity, {}, [], true, "99999999999"]) {
      const r = parseBundlePurchaseBody(body({ expected_pay: v }))
      expect(r.ok, String(v)).toBe(false)
    }
  })

  it("rejects a non-object body", () => {
    for (const b of [null, undefined, "x", 5, [], [body()]]) {
      const r = parseBundlePurchaseBody(b)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("Request body must be a JSON object")
    }
  })

  it.each(["price", "amount", "face_amount", "pay_amount", "status", "user_id", "network", "cashback", "fee", "total", "cost", "PRICE", "Amount"])(
    "rejects the forbidden field %s",
    (k) => {
      const r = parseBundlePurchaseBody(body({ [k]: 1 }))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toBe("Unexpected field")
    }
  )

  it("rejects bad tokens", () => {
    for (const t of [undefined, null, 5, "", "short", "x".repeat(4001), "not.a.token", "abc.def", "sbx_", "sbx_UPPER", "sbx_a b"]) {
      const r = parseBundlePurchaseBody(body({ bundle_token: t }))
      expect(r.ok, String(t)).toBe(false)
      if (!r.ok) expect(r.error).toBe("bundle_token is invalid")
    }
  })

  it("rejects a token whose payload is not a bundle (wrong network / amount / value)", () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url") + "." + "a".repeat(64)
    for (const p of [
      { network: "VODAFONE", value: "v", amount: 5 },
      { network: "MTN", value: "", amount: 5 },
      { network: "MTN", value: "v", amount: 0 },
      { network: "MTN", value: "v", amount: -1 },
      { network: "MTN", value: "v", amount: "5" },
      { network: "MTN", amount: 5 },
      null,
      [],
    ]) {
      const r = parseBundlePurchaseBody(body({ bundle_token: enc(p as object) }))
      expect(r.ok, JSON.stringify(p)).toBe(false)
    }
  })

  it("rejects a bad recipient and a bad reference", () => {
    const rec = parseBundlePurchaseBody(body({ recipient: "12345" }))
    expect(rec.ok).toBe(false)
    if (!rec.ok) expect(rec.error).toBe("recipient must be a valid Ghana mobile number")
    const ref = parseBundlePurchaseBody(body({ reference: "ab" }))
    expect(ref.ok).toBe(false)
    const missing = parseBundlePurchaseBody({ bundle_token: liveToken(), recipient: PHONE })
    expect(missing.ok).toBe(false)
  })
})

describe("bundleHash", () => {
  const parsed = (over: Record<string, unknown> = {}) => {
    const r = parseBundlePurchaseBody(body(over))
    if (!r.ok) throw new Error(r.error)
    return r.value
  }

  it("is stable across recipient spellings and a refreshed token for the same bundle", () => {
    const a = bundleHash(parsed())
    expect(bundleHash(parsed({ recipient: "233249991070" }))).toBe(a)
    expect(bundleHash(parsed({ recipient: "024 999 1070" }))).toBe(a)
    expect(bundleHash(parsed({ bundle_token: liveToken({ issuedAt: ISSUED + 120_000 }) }))).toBe(a)
  })

  it("ignores reference and expected_pay", () => {
    const a = bundleHash(parsed())
    expect(bundleHash(parsed({ reference: "OTHER-REF" }))).toBe(a)
    expect(bundleHash(parsed({ expected_pay: 5.5 }))).toBe(a)
  })

  it("differs for another bundle, price, network or recipient", () => {
    const a = bundleHash(parsed())
    expect(bundleHash(parsed({ bundle_token: liveToken({ value: "2GB-VAL" }) }))).not.toBe(a)
    expect(bundleHash(parsed({ bundle_token: liveToken({ amount: 6 }) }))).not.toBe(a)
    expect(bundleHash(parsed({ bundle_token: liveToken({ network: "AT" }) }))).not.toBe(a)
    expect(bundleHash(parsed({ recipient: "0249991071" }))).not.toBe(a)
  })

  it("differs between a sandbox and a live bundle and never embeds the raw token", () => {
    const live = parsed()
    const sbx = parsed({ bundle_token: "sbx_mtn_1gb" })
    expect(bundleHash(sbx)).not.toBe(bundleHash(live))
    expect(bundleHash(live)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("bundleEngineKey", () => {
  it("is a valid engine idempotency key, deterministic per claim and distinct across claims", () => {
    const k = bundleEngineKey("claim-uuid-1")
    expect(k).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    expect(bundleEngineKey("claim-uuid-1")).toBe(k)
    expect(bundleEngineKey("claim-uuid-2")).not.toBe(k)
    expect(k.startsWith("v2-")).toBe(true)
  })
})

describe("classifyBundleRefusal", () => {
  const quote = { faceAmount: 5.5, payAmount: 5.0, customerCashback: 0.5 }
  const unpaid = { payment_status: "unpaid", reference_code: "SB-1" }

  it("maps the pre-insert refusals to fixed no-charge responses", () => {
    const cases: [any, number, RegExp | string][] = [
      [{ status: 400, error: "Enter a valid Ghana mobile number" }, 400, "recipient must be a valid Ghana mobile number"],
      [{ status: 400, error: "Invalid request, please try again" }, 400, "INVALID_REQUEST: the request was refused; nothing was charged"],
      [{ status: 400, error: "This number is not an MTN number" }, 400, "NETWORK_MISMATCH: the recipient number does not belong to this bundle's network; nothing was charged"],
      [{ status: 403, error: "Standard Bundles are not available" }, 403, MSG_BUNDLE_NOT_AVAILABLE],
      [{ status: 403, error: "This bundle is not available" }, 403, MSG_BUNDLE_NOT_AVAILABLE],
      [{ status: 409, error: "Prices refreshed — pick the bundle again" }, 409, MSG_BUNDLE_TOKEN_EXPIRED],
      [{ status: 409, error: "This bundle isn't available for that number right now — refresh" }, 409, MSG_BUNDLE_UNAVAILABLE_FOR_NUMBER],
      [{ status: 503, error: "Bundles unavailable right now" }, 503, MSG_BUNDLE_UNAVAILABLE],
      [{ status: 503, error: "Temporarily unavailable" }, 503, MSG_BUNDLE_UNAVAILABLE],
      [{ status: 503, error: "Could not create the order. You were not charged — please try again." }, 503, MSG_BUNDLE_UNAVAILABLE],
    ]
    for (const [r, status, message] of cases) {
      const c = classifyBundleRefusal(r, undefined)
      expect(c.kind, JSON.stringify(r)).toBe("no_charge")
      if (c.kind === "no_charge") {
        expect(c.status).toBe(status)
        expect(c.message).toBe(message)
      }
    }
  })

  it("maps a price change with the quote and the client's expected_pay", () => {
    const c = classifyBundleRefusal({ status: 409, error: "Price updated — please review", quote }, 5.5)
    expect(c.kind).toBe("no_charge")
    if (c.kind === "no_charge") {
      expect(c.status).toBe(409)
      expect(c.message).toBe(
        "PRICE_CHANGED: expected 5.50, current 5.00 (face_amount 5.50, customer_cashback 0.50). Review the price and resend with expected_pay"
      )
    }
    const noExp = classifyBundleRefusal({ status: 409, error: "Price updated — please review", quote }, undefined)
    expect(noExp.kind === "no_charge" && noExp.message.startsWith("PRICE_CHANGED: current 5.00")).toBe(true)
  })

  it("treats insufficient balance as no-charge only while the order stayed unpaid", () => {
    const c = classifyBundleRefusal({ status: 402, error: "Insufficient wallet balance", order: unpaid }, undefined)
    expect(c).toEqual({ kind: "no_charge", status: 402, message: MSG_BUNDLE_INSUFFICIENT })
    expect(classifyBundleRefusal({ status: 402, error: "Insufficient wallet balance" }, undefined).kind).toBe("no_charge")
    expect(classifyBundleRefusal({ status: 402, error: "Insufficient wallet balance", order: { payment_status: "paid" } }, undefined).kind).toBe("ambiguous")
  })

  it("is ambiguous for anything that carries an order, any 5xx other than the pre-insert 503, and unknown shapes", () => {
    const cases: any[] = [
      { status: 500, error: "We could not confirm your payment. Please check your wallet before retrying.", order: unpaid },
      { status: 500, error: "x" },
      { status: 409, error: "This order can no longer be paid", order: unpaid },
      { status: 409, error: "something new" },
      { status: 400, error: "x", order: unpaid },
      { status: 403, error: "x", order: unpaid },
      { status: 503, error: "x", order: unpaid },
      { status: 401, error: "Unauthorized" },
      { status: 404, error: "x" },
      { status: 502, error: "x" },
      { status: "400", error: "x" },
      { error: "x" },
      null,
      undefined,
      "boom",
    ]
    for (const r of cases) expect(classifyBundleRefusal(r, undefined).kind, JSON.stringify(r)).toBe("ambiguous")
  })

  it("never forwards engine text", () => {
    const secret = "ENGINE-TEXT-0249991079"
    for (const status of [400, 403, 409, 503, 402]) {
      const c = classifyBundleRefusal({ status, error: secret }, undefined)
      if (c.kind === "no_charge") expect(c.message).not.toContain(secret)
    }
  })
})

describe("mappers", () => {
  it("mapBundleOrder is an allow-list with the client reference, public network and local recipient", () => {
    const row = {
      id: "uuid",
      reference_code: "SB-ABC",
      network: "TELECEL",
      beneficiary_phone: "233249991070",
      bundle_display: "2GB Daily",
      bundle_value: "secret-value",
      amount: "6",
      paid_amount: "5.4",
      cashback_amount: "0.6",
      status: "processing",
      payment_status: "paid",
      notes: "Outcome unknown, do not resend. Hubtel ref X",
      failure_reason: "provider said no",
      hubtel_client_reference: "HUB-1",
      user_id: "user-1",
      created_at: "2026-10-28T10:00:00.000Z",
    }
    expect(mapBundleOrder(row, "BND-001")).toEqual({
      reference: "BND-001",
      network: "Telecel",
      bundle: "2GB Daily",
      recipient: PHONE,
      face_amount: 6,
      paid_amount: 5.4,
      cashback: 0.6,
      status: "processing",
      created_at: "2026-10-28T10:00:00.000Z",
    })
  })

  it("mapBundleOrder tolerates a sparse row", () => {
    const o = mapBundleOrder({ status: "weird" }, "BND-002")
    expect(o).toMatchObject({ reference: "BND-002", network: "", bundle: "", recipient: "", face_amount: 0, paid_amount: 0, cashback: 0, status: "processing", created_at: null })
  })

  it("mapBundleOrder paid_amount falls back to the face amount", () => {
    expect(mapBundleOrder({ amount: 8, paid_amount: null, cashback_amount: null }, "r").paid_amount).toBe(8)
  })

  it("mapBundleCatalog allow-lists categories and bundles and rounds money", () => {
    const out = mapBundleCatalog("Telecel", [
      {
        name: "Daily",
        extra: "x",
        bundles: [{ bundle_token: "t1", display: "1GB", face_amount: 6.004, pay_amount: 5.5, customer_cashback: 0.504, value: "leak" }],
      },
    ] as any)
    expect(out).toEqual({
      network: "Telecel",
      token_valid_seconds: BUNDLE_CATALOG_VALID_SECONDS,
      categories: [{ name: "Daily", bundles: [{ bundle_token: "t1", display: "1GB", face_amount: 6, pay_amount: 5.5, customer_cashback: 0.5 }] }],
    })
    expect(BUNDLE_CATALOG_VALID_SECONDS).toBe(600)
  })
})
