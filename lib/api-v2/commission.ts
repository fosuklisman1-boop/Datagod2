/**
 * Pure request rules for the Developer API v2 commission endpoints (airtime and
 * utility bills). No I/O. Money-adjacent: every parser is strict and fails
 * closed. The engines (lib/airtime-service.ts, lib/bills/*) are not touched.
 */

import { createHash } from "crypto"
import { parseReference, normalizeRecipient } from "./data-orders"
import { isBillerKey, BILLER_KEYS, type BillerKey } from "@/lib/bills/billers"
import { parseVerifyBody, type ParsedVerifyBody } from "@/lib/api-v1/bills"
// Pure constants module (type-only Supabase import, billers + phone-format): safe for tests and clients.
import { BILL_LIMIT_CEIL } from "@/lib/bills/config"
// Constant only (idempotency.ts has a type-only store import): no I/O pulled in.
import { CLAIM_STALE_MS } from "./idempotency"

type Fail = { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// ---- network ----

export type AirtimeNetwork = "MTN" | "Telecel" | "AT"

const AIRTIME_NETWORKS: Record<string, AirtimeNetwork> = {
  mtn: "MTN",
  telecel: "Telecel",
  at: "AT",
  airteltigo: "AT",
}

export function parseAirtimeNetwork(
  v: unknown
): { ok: true; network: AirtimeNetwork; engineNetwork: "MTN" | "AT" | "Telecel" } | Fail {
  if (typeof v === "string") {
    const key = v.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(AIRTIME_NETWORKS, key)) {
      const network = AIRTIME_NETWORKS[key]
      return { ok: true, network, engineNetwork: network }
    }
  }
  return { ok: false, error: "network must be one of: MTN, Telecel, AT, AirtelTigo" }
}

// ---- amount ----

const AIRTIME_MAX = 1000

/**
 * Number or numeric string, plain decimal only (no exponent, sign, spaces),
 * at most 2 decimals, > 0 and <= max. Pesewas are computed from the digits,
 * never by float multiplication.
 */
export function parseAmountPesewas(
  v: unknown,
  opts: { max?: number } = {}
): { ok: true; pesewas: number; amount: number } | Fail {
  const max = opts.max ?? AIRTIME_MAX
  const bad: Fail = { ok: false, error: `amount must be greater than 0 and at most ${max}, with at most 2 decimals` }
  let s: string
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return bad
    s = String(v)
  } else if (typeof v === "string") {
    s = v
  } else {
    return bad
  }
  const m = /^([0-9]{1,9})(?:\.([0-9]{1,2}))?$/.exec(s)
  if (!m) return bad
  const pesewas = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0")
  if (!(pesewas > 0) || pesewas > Math.round(max * 100)) return bad
  return { ok: true, pesewas, amount: pesewas / 100 }
}

// ---- request bodies ----

// Price-like and ownership fields are rejected (case-insensitively) so a client
// can never believe it set them. `amount` is a legitimate field here.
const FORBIDDEN_FIELDS = new Set([
  "price",
  "package_id",
  "status",
  "user_id",
  "total",
  "dealer_price",
  "cost",
  "api_key_id",
  "recipient_phone",
  "package",
  "user",
  "fee",
  "fee_amount",
  "total_paid",
  "cashback",
  "pay_separately",
])

function hasForbiddenField(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => FORBIDDEN_FIELDS.has(k.toLowerCase()))
}

// expected_pay includes any fee, so it is not bound by the airtime face-value
// cap. Advisory only (the engine decides price), capped at twice the bill ceiling.
const EXPECTED_PAY_MAX = BILL_LIMIT_CEIL * 2

function parseExpectedPay(v: unknown): { ok: true; value: number | undefined } | Fail {
  if (v === undefined || v === null) return { ok: true, value: undefined }
  const r = parseAmountPesewas(v, { max: EXPECTED_PAY_MAX })
  if (!r.ok) return { ok: false, error: "expected_pay must be a positive amount with at most 2 decimals" }
  return { ok: true, value: r.amount }
}

export interface AirtimeInput {
  network: AirtimeNetwork
  engineNetwork: "MTN" | "AT" | "Telecel"
  recipient: { msisdn: string; local: string }
  amount: number
  pesewas: number
  reference: string
  expectedPay?: number
}

export function parseAirtimeBody(body: unknown): { ok: true; value: AirtimeInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (hasForbiddenField(body)) return { ok: false, error: "Unexpected field" }
  const net = parseAirtimeNetwork(body.network)
  if (!net.ok) return net
  const rec = normalizeRecipient(body.recipient)
  if (!rec.ok) return rec
  const amt = parseAmountPesewas(body.amount)
  if (!amt.ok) return amt
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref
  const exp = parseExpectedPay(body.expected_pay)
  if (!exp.ok) return exp
  return {
    ok: true,
    value: {
      network: net.network,
      engineNetwork: net.engineNetwork,
      recipient: { msisdn: rec.msisdn, local: rec.local },
      amount: amt.amount,
      pesewas: amt.pesewas,
      reference: ref.reference,
      ...(exp.value !== undefined ? { expectedPay: exp.value } : {}),
    },
  }
}

export interface BillPayInput {
  verifyToken: string
  amount: number
  pesewas: number
  reference: string
  expectedPay?: number
}

// The admin bill limits can never exceed BILL_LIMIT_CEIL (lib/bills/config.ts).
const BILL_MAX = BILL_LIMIT_CEIL

export function parseBillPayBody(body: unknown): { ok: true; value: BillPayInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (hasForbiddenField(body)) return { ok: false, error: "Unexpected field" }
  const token = body.verify_token
  if (typeof token !== "string" || token.length < 10 || token.length > 4000) {
    return { ok: false, error: "verify_token is required" }
  }
  const amt = parseAmountPesewas(body.amount, { max: BILL_MAX })
  if (!amt.ok) return amt
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref
  const exp = parseExpectedPay(body.expected_pay)
  if (!exp.ok) return exp
  return {
    ok: true,
    value: {
      verifyToken: token,
      amount: amt.amount,
      pesewas: amt.pesewas,
      reference: ref.reference,
      ...(exp.value !== undefined ? { expectedPay: exp.value } : {}),
    },
  }
}

/**
 * Reuses parseVerifyBody from lib/api-v1/bills.ts: it is a pure function and the
 * module has no server-only imports at module scope (crypto, billers, a pure
 * quote helper), so it is safe to import here and in tests.
 */
export function parseBillLookupBody(
  body: unknown
): { ok: true; biller: BillerKey; inputs: ParsedVerifyBody["inputs"] } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  const parsed = parseVerifyBody(body)
  if (!isBillerKey(parsed.biller)) return { ok: false, error: `biller must be one of: ${BILLER_KEYS.join(", ")}` }
  return { ok: true, biller: parsed.biller, inputs: parsed.inputs }
}

// ---- hashes ----

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(v) ?? "null"
}

/** sha256 hex of a key-sorted canonical JSON of {kind, ...canonical}. */
export function requestHash(kind: "airtime" | "bill" | "results" | "afa", canonical: object): string {
  return createHash("sha256").update(canonicalJson({ kind, request: canonical })).digest("hex")
}

/** Network, recipient (local form) and pesewas only. Reference and expectedPay are excluded. */
export function airtimeHash(i: AirtimeInput): string {
  return requestHash("airtime", { network: i.network, recipient: i.recipient.local, pesewas: i.pesewas })
}

/** The verify token is hashed first so the token never sits in a canonical string. expectedPay is excluded. */
export function billHash(i: BillPayInput): string {
  return requestHash("bill", {
    verify_token_sha256: createHash("sha256").update(i.verifyToken).digest("hex"),
    pesewas: i.pesewas,
  })
}

// ---- status and order shapes ----

export type CommissionStatus = "pending" | "processing" | "completed" | "failed" | "refunded"

/** Airtime in prod: failed, completed, pending_payment, pending. Anything unknown reads processing. */
export function mapCommissionStatus(db: unknown): CommissionStatus {
  const s = typeof db === "string" ? db.trim().toLowerCase() : ""
  switch (s) {
    case "pending":
    case "pending_payment":
      return "pending"
    case "processing":
    case "completed":
    case "failed":
    case "refunded":
      return s
    default:
      return "processing"
  }
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function localRecipient(stored: unknown): string {
  const s = String(stored ?? "")
  if (/^\+?233[0-9]{9}$/.test(s)) return "0" + s.replace(/^\+?233/, "")
  return s
}

export interface PublicAirtimeOrder {
  reference: string
  network: string
  recipient: string
  airtime_amount: number
  fee_amount: number
  total_paid: number
  cashback: number
  status: CommissionStatus
  created_at: string | null
}

/** Allow-list mapper: only these keys ever leave the API. */
export function mapAirtimeOrder(row: any, clientReference: string): PublicAirtimeOrder {
  const r = row ?? {}
  return {
    reference: clientReference,
    network: String(r.network ?? ""),
    recipient: localRecipient(r.beneficiary_phone),
    airtime_amount: money(r.airtime_amount),
    fee_amount: money(r.fee_amount),
    total_paid: money(r.total_paid),
    cashback: money(r.cashback_amount),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

export interface PublicBillOrder {
  reference: string
  biller: string
  account: string
  customer_name: string | null
  face_amount: number
  paid_amount: number
  cashback: number
  status: CommissionStatus
  created_at: string | null
}

export function mapBillOrder(row: any, clientReference: string): PublicBillOrder {
  const r = row ?? {}
  return {
    reference: clientReference,
    biller: String(r.biller ?? ""),
    account: String(r.account_number ?? ""),
    customer_name: typeof r.customer_name === "string" ? r.customer_name : null,
    face_amount: money(r.amount),
    paid_amount: money(r.paid_amount ?? r.amount),
    cashback: money(r.cashback_amount),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

// ---- pending claim state (order lookups) ----

export type ClaimState = "in_progress" | "outcome_unknown"

export interface PublicClaimState {
  reference: string
  state: ClaimState
}

/**
 * The caller's own not-yet-done claim as the order lookups show it, so a
 * client never reads "still running / outcome unknown" as "never created"
 * and pays again under a new reference. in_progress older than
 * CLAIM_STALE_MS (or with an unreadable timestamp) reads outcome_unknown,
 * the same rule as claimRequest. Exactly { reference, state }; null for any
 * other status (done is shown as an order).
 */
export function mapClaimState(
  claim: { status: unknown; createdAt?: unknown },
  reference: string,
  now: number
): PublicClaimState | null {
  if (claim?.status === "unknown") return { reference, state: "outcome_unknown" }
  if (claim?.status !== "in_progress") return null
  const created = typeof claim.createdAt === "string" ? Date.parse(claim.createdAt) : NaN
  const stale = !Number.isFinite(created) || now - created > CLAIM_STALE_MS
  return { reference, state: stale ? "outcome_unknown" : "in_progress" }
}

// ---- engine errors ----

export type EngineErrorClass = "no_charge" | "ambiguous"

/**
 * no_charge ONLY for codes purchaseAirtime raises before the deduct_wallet RPC:
 * the network gate (NETWORK_DISABLED), prefix check (NETWORK_MISMATCH), amount
 * gate (INVALID_AMOUNT), price check (PRICE_CHANGED), the duplicate look-back
 * (DUPLICATE_REQUEST), and INSUFFICIENT_BALANCE (deduct_wallet returned no rows,
 * so nothing was debited). PAYMENT_FAILED (RPC errored, outcome unknown) and
 * ORDER_CREATE_FAILED (after the debit, refund best-effort) are ambiguous, as is
 * anything unrecognised.
 */
export const NO_CHARGE_ENGINE_CODES = [
  "NETWORK_DISABLED",
  "NETWORK_MISMATCH",
  "INVALID_AMOUNT",
  "DUPLICATE_REQUEST",
  "PRICE_CHANGED",
  "INSUFFICIENT_BALANCE",
] as const

const NO_CHARGE_CODES = new Set<string>(NO_CHARGE_ENGINE_CODES)

export function classifyEngineError(code: unknown): EngineErrorClass {
  return typeof code === "string" && NO_CHARGE_CODES.has(code) ? "no_charge" : "ambiguous"
}

export interface PublicQuote {
  face_amount: number
  pay_amount: number
  customer_cashback: number
}

export interface ErrorResponse {
  status: number
  code: string
  message: string
  required?: number
  quote?: PublicQuote
}

const publicQuote = (q: any): PublicQuote => ({
  face_amount: money(q?.faceAmount),
  pay_amount: money(q?.payAmount),
  customer_cashback: money(q?.customerCashback),
})

/** Same status table as v1 airtime; fixed messages (engine text is never forwarded). */
export function airtimeErrorResponse(e: unknown): ErrorResponse {
  const err = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; required?: unknown; quote?: unknown }
  switch (err.code) {
    case "NETWORK_DISABLED":
      return { status: 503, code: "NETWORK_DISABLED", message: "Airtime for this network is currently unavailable" }
    case "NETWORK_MISMATCH":
      return { status: 400, code: "NETWORK_MISMATCH", message: "The recipient number does not belong to the selected network" }
    case "INVALID_AMOUNT":
      return { status: 400, code: "INVALID_AMOUNT", message: "The amount is outside the allowed range" }
    case "DUPLICATE_REQUEST":
      // Never "wait and retry": after a timeout a client that resends under a NEW reference would buy twice.
      return {
        status: 409,
        code: "DUPLICATE_REQUEST",
        message:
          "An identical airtime order was just placed. Look it up under its original reference; do not resend it under a new reference unless you intend a second identical order.",
      }
    case "PRICE_CHANGED":
      return {
        status: 409,
        code: "PRICE_CHANGED",
        message: "The price has changed. Please review the new price and try again.",
        ...(err.quote ? { quote: publicQuote(err.quote) } : {}),
      }
    case "INSUFFICIENT_BALANCE":
      return {
        status: 402,
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient wallet balance",
        ...(Number.isFinite(Number(err.required)) && err.required !== null && err.required !== undefined
          ? { required: money(err.required) }
          : {}),
      }
    case "PAYMENT_FAILED":
      return { status: 500, code: "PAYMENT_FAILED", message: "Failed to process payment" }
    case "ORDER_CREATE_FAILED":
      return { status: 500, code: "ORDER_CREATE_FAILED", message: "Failed to create the order" }
    default:
      return { status: 500, code: "INTERNAL_ERROR", message: "Failed to purchase airtime" }
  }
}

const BILL_STATUS_MESSAGES: Record<number, { code: string; message: string }> = {
  400: { code: "INVALID_REQUEST", message: "Invalid request" },
  402: { code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance" },
  403: { code: "FORBIDDEN", message: "This payment is not permitted" },
  404: { code: "NOT_FOUND", message: "Not found" },
  409: { code: "CONFLICT", message: "This payment cannot be completed as requested" },
  422: { code: "UNPROCESSABLE", message: "The payment details could not be accepted" },
  503: { code: "TEMPORARILY_UNAVAILABLE", message: "Temporarily unavailable" },
}

/** Engine failure result -> {status, message}. Unexpected statuses collapse to 500 with a fixed message. */
export function billErrorResponse(r: { ok?: false; status: number; error: string; quote?: unknown }): ErrorResponse {
  if (r.quote && r.status === 409) {
    return {
      status: 409,
      code: "PRICE_CHANGED",
      message: "The price has changed. Please review the new price and try again.",
      quote: publicQuote(r.quote),
    }
  }
  const known = BILL_STATUS_MESSAGES[r.status]
  if (known) return { status: r.status, ...known }
  return { status: 500, code: "INTERNAL_ERROR", message: "Failed to pay the bill" }
}
