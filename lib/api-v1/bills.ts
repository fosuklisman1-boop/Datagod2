// lib/api-v1/bills.ts
//
// Pure helpers for the v1 Utility Bills endpoints (request mapping, response
// shaping, sandbox fixtures). The routes stay thin and export handlers only.

import { createHash, randomBytes } from "crypto"
import { BILLERS, isBillerKey, type BillerKey } from "@/lib/bills/billers"
import type { BillOrderRow, PriceQuote } from "@/lib/bills/service"

const asString = (v: unknown): string | undefined =>
  typeof v === "string" || typeof v === "number" ? String(v) : undefined

export interface ParsedVerifyBody {
  biller: string
  inputs: { account?: string; phone?: string; email?: string; broadbandAccount?: string; addMeter: boolean; consent: boolean }
}

/**
 * snake_case request -> engine inputs. `meter_type` is informational: prepaid
 * sends the meter number and postpaid the account number, both as `account`.
 */
export function parseVerifyBody(body: Record<string, unknown>): ParsedVerifyBody {
  return {
    biller: String(body.biller ?? ""),
    inputs: {
      account: asString(body.account),
      phone: asString(body.phone),
      email: asString(body.email),
      broadbandAccount: asString(body.broadband_account),
      addMeter: body.add_meter === true,
      consent: body.consent === true,
    },
  }
}

export function parseAmount(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return NaN
}

export function parseExpectedPay(v: unknown): number | undefined {
  const n = parseAmount(v)
  return Number.isFinite(n) ? n : undefined
}

/** Engine verify result (minus ok) -> snake_case API body. Names are not masked: the caller is an authenticated reseller. */
export function verifyResponse(r: {
  customerName: string | null; amountDue: number | null; suggestedAmount: number; token?: string
  meters?: { meter: string; name: string | null; outstanding: number | null; token: string }[]
}) {
  return {
    success: true,
    customer_name: r.customerName,
    amount_due: r.amountDue,
    suggested_amount: r.suggestedAmount,
    ...(r.token !== undefined ? { verify_token: r.token } : {}),
    ...(r.meters
      ? { meters: r.meters.map(m => ({ meter: m.meter, name: m.name, outstanding: m.outstanding, verify_token: m.token })) }
      : {}),
  }
}

export function quoteBody(q: PriceQuote) {
  return { face_amount: q.faceAmount, pay_amount: q.payAmount, customer_cashback: q.customerCashback }
}

/** Error body for a failed pay. A 409 with a quote is the price_changed contract shared with the other v1 endpoints. */
export function payErrorBody(r: { status: number; error: string; order?: BillOrderRow; quote?: PriceQuote }) {
  if (r.quote) return { success: false, error: "price_changed", message: r.error, quote: quoteBody(r.quote) }
  return { success: false, error: r.error, ...(r.order ? { reference: r.order.reference_code } : {}) }
}

export function orderBody(o: Pick<BillOrderRow, "reference_code" | "biller" | "account_number" | "customer_name" | "amount" | "paid_amount" | "cashback_amount" | "status" | "payment_status"> & { created_at?: string }) {
  return {
    reference: o.reference_code,
    biller: o.biller,
    account: o.account_number,
    customer_name: o.customer_name,
    status: o.status,
    payment_status: o.payment_status,
    face_amount: o.amount,
    paid_amount: o.paid_amount ?? o.amount,
    cashback: o.cashback_amount ?? 0,
    ...(o.created_at ? { created_at: o.created_at } : {}),
  }
}

/** Explicit column list for GET /bills/{reference}: never internal notes, tokens or provider references. */
export const ORDER_COLUMNS =
  "reference_code, biller, account_number, customer_name, amount, paid_amount, cashback_amount, status, payment_status, created_at"

// ---- sandbox ----

const SANDBOX_PREFIX = "sandbox_bill."
const sig = (payload: string, userId: string) =>
  createHash("sha256").update(`${payload}|${userId}|sandbox-bill`).digest("hex").slice(0, 16)

export function sandboxVerify(userId: string, biller: string, inputs: ParsedVerifyBody["inputs"]):
  | { ok: true; body: ReturnType<typeof verifyResponse> }
  | { ok: false; status: number; error: string } {
  if (!isBillerKey(biller)) return { ok: false, status: 400, error: "Unknown biller" }
  const account = (inputs.account ?? inputs.broadbandAccount ?? inputs.phone ?? "").replace(/ /g, "")
  if (!account) return { ok: false, status: 400, error: "Enter the account or meter number" }
  const mk = (acct: string) => {
    const payload = Buffer.from(JSON.stringify({ b: biller, a: acct })).toString("base64url")
    return `${SANDBOX_PREFIX}${payload}.${sig(payload, userId)}`
  }
  if (biller === "ecg" && !inputs.addMeter) {
    return {
      ok: true,
      body: verifyResponse({
        customerName: null, amountDue: null, suggestedAmount: 0,
        meters: [{ meter: account, name: "Sandbox Customer", outstanding: 50, token: mk(account) }],
      }),
    }
  }
  return {
    ok: true,
    body: verifyResponse({ customerName: "Sandbox Customer", amountDue: 50, suggestedAmount: 50, token: mk(account) }),
  }
}

export function parseSandboxToken(userId: string, token: string): { biller: BillerKey; account: string } | null {
  if (!token.startsWith(SANDBOX_PREFIX)) return null
  const [payload, s] = token.slice(SANDBOX_PREFIX.length).split(".")
  if (!payload || !s || s !== sig(payload, userId)) return null
  try {
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return isBillerKey(j?.b) && typeof j?.a === "string" ? { biller: j.b, account: j.a } : null
  } catch { return null }
}

export const sandboxBillReference = () => `SBX-BILL-${randomBytes(5).toString("hex").toUpperCase()}`
export const billerLabel = (b: BillerKey) => BILLERS[b].label
