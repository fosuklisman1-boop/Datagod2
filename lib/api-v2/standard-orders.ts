/**
 * Pure request rules for the Developer API v2 standard-order endpoints:
 * results checker vouchers and AFA registration. No I/O. Money-adjacent: every
 * parser is strict and fails closed, and every mapper returns an exact
 * allow-list. The engines (lib/results-checker-service.ts, lib/afa-fulfillment.ts)
 * are not touched; price is always decided server-side by the engine.
 *
 * Privacy: the Ghana Card number never appears in an error message or a return
 * value except AfaInput.cardCanonical, and only its sha256 enters the request hash.
 */

import { createHash } from "crypto"
import { parseReference, normalizeRecipient } from "./data-orders"
import { requestHash, mapCommissionStatus, type CommissionStatus, type EngineErrorClass, type ErrorResponse } from "./commission"
import { parseGhanaCardNumber } from "@/lib/ghana-card"

type Fail = { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// C0, DEL, C1 and the Unicode line/paragraph separators.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "")

// ---- forbidden request fields ----

// Price-like and ownership fields are rejected (case-insensitively) so a client
// can never believe it set them. Unlike the commission set, recipient_phone is
// a legitimate results field, so this set is local.
const FORBIDDEN_FIELDS = new Set([
  "price",
  "package_id",
  "status",
  "user_id",
  "total",
  "dealer_price",
  "cost",
  "api_key_id",
  "package",
  "user",
  "fee",
  "fee_amount",
  "total_paid",
  "cashback",
  "pay_separately",
  "amount",
  "unit_price",
  "quantity_price",
  "shop_id",
  "markup",
])

function hasForbiddenField(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((k) => FORBIDDEN_FIELDS.has(k.toLowerCase()))
}

// ---- results checker ----

export type ExamBoard = "WASSCE" | "BECE" | "NOVDEC"
const EXAM_BOARDS: readonly ExamBoard[] = ["WASSCE", "BECE", "NOVDEC"]

export function parseExamBoard(v: unknown): { ok: true; board: ExamBoard } | Fail {
  if (typeof v === "string") {
    const up = v.toUpperCase()
    const board = EXAM_BOARDS.find((b) => b === up)
    if (board) return { ok: true, board }
  }
  return { ok: false, error: "exam_board must be one of: WASSCE, BECE, NOVDEC" }
}

/** Positive integer from a number or a digit-only string (no exponent, sign, decimals), 1..max. */
export function parseVoucherQuantity(v: unknown, max: number): { ok: true; quantity: number } | Fail {
  const hi = Number.isSafeInteger(max) && max >= 1 ? max : 0
  const bad: Fail = { ok: false, error: `quantity must be a whole number from 1 to ${hi || 1}` }
  if (hi === 0) return bad
  let n: number
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) return bad
    n = v
  } else if (typeof v === "string") {
    if (!/^[0-9]{1,9}$/.test(v)) return bad
    n = Number(v)
  } else {
    return bad
  }
  if (n < 1 || n > hi) return bad
  return { ok: true, quantity: n }
}

/** Absent or blank => null. Otherwise a valid Ghana mobile number in LOCAL form. */
export function parseOptionalPhone(v: unknown, field = "recipient_phone"): { ok: true; local: string | null } | Fail {
  if (isBlank(v)) return { ok: true, local: null }
  const r = normalizeRecipient(v)
  if (!r.ok) return { ok: false, error: `${field} must be a valid Ghana mobile number` }
  return { ok: true, local: r.local }
}

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** Absent or blank => null. Otherwise trimmed, lowercased, <= 254 chars, simple valid shape. */
export function parseOptionalEmail(v: unknown, field = "recipient_email"): { ok: true; email: string | null } | Fail {
  if (isBlank(v)) return { ok: true, email: null }
  const bad: Fail = { ok: false, error: `${field} must be a valid email address` }
  if (typeof v !== "string" || CONTROL_CHARS.test(v)) return bad
  const email = v.trim().toLowerCase()
  if (email.length > 254 || !EMAIL_RE.test(email) || email.includes("..") || email.startsWith(".") || email.includes(".@")) return bad
  return { ok: true, email }
}

export interface ResultsInput {
  board: ExamBoard
  quantity: number
  reference: string
  /** LOCAL form (0XXXXXXXXX), or null. */
  recipientPhone: string | null
  recipientEmail: string | null
}

export function parseResultsBody(body: unknown, maxQuantity: number): { ok: true; value: ResultsInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (hasForbiddenField(body)) return { ok: false, error: "Unexpected field" }
  const board = parseExamBoard(body.exam_board)
  if (!board.ok) return board
  const qty = parseVoucherQuantity(body.quantity, maxQuantity)
  if (!qty.ok) return qty
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref
  const phone = parseOptionalPhone(body.recipient_phone)
  if (!phone.ok) return phone
  const email = parseOptionalEmail(body.recipient_email)
  if (!email.ok) return email
  return {
    ok: true,
    value: {
      board: board.board,
      quantity: qty.quantity,
      reference: ref.reference,
      recipientPhone: phone.local,
      recipientEmail: email.email,
    },
  }
}

/** Board, quantity and recipients only. The reference is excluded. */
export function resultsHash(i: ResultsInput): string {
  return requestHash("results", {
    board: i.board,
    quantity: i.quantity,
    recipient_phone: i.recipientPhone,
    recipient_email: i.recipientEmail,
  })
}

// ---- AFA registration ----

export const GH_REGIONS = [
  "Ahafo",
  "Ashanti",
  "Bono",
  "Bono East",
  "Central",
  "Eastern",
  "Greater Accra",
  "North East",
  "Northern",
  "Oti",
  "Savannah",
  "Upper East",
  "Upper West",
  "Volta",
  "Western",
  "Western North",
] as const
export type GhRegion = (typeof GH_REGIONS)[number]

const REGION_BY_KEY = new Map<string, GhRegion>(GH_REGIONS.map((r) => [r.toLowerCase(), r]))

export function parseRegion(v: unknown): { ok: true; region: GhRegion } | Fail {
  if (typeof v === "string") {
    const region = REGION_BY_KEY.get(v.trim().toLowerCase().replace(/\s+/g, " "))
    if (region) return { ok: true, region }
  }
  return { ok: false, error: `region must be one of: ${GH_REGIONS.join(", ")}` }
}

/** Trim, single-space, 3..100 chars, at least two letters, no control characters. */
export function parseFullName(v: unknown): { ok: true; name: string } | Fail {
  const bad: Fail = { ok: false, error: "full_name must be 3 to 100 characters and contain at least two letters" }
  if (typeof v !== "string" || CONTROL_CHARS.test(v)) return bad
  const name = v.trim().replace(/\s+/g, " ")
  if (name.length < 3 || name.length > 100) return bad
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return bad
  return { ok: true, name }
}

export function parseLocation(v: unknown): { ok: true; location: string } | Fail {
  const bad: Fail = { ok: false, error: "location must be 2 to 120 characters" }
  if (typeof v !== "string" || CONTROL_CHARS.test(v)) return bad
  const location = v.trim()
  if (location.length < 2 || location.length > 120) return bad
  return { ok: true, location }
}

export function parseOccupation(v: unknown): { ok: true; occupation: string | null } | Fail {
  if (isBlank(v)) return { ok: true, occupation: null }
  const bad: Fail = { ok: false, error: "occupation must be at most 80 characters" }
  if (typeof v !== "string" || CONTROL_CHARS.test(v)) return bad
  const occupation = v.trim()
  if (occupation.length > 80) return bad
  return { ok: true, occupation }
}

export interface AfaInput {
  reference: string
  fullName: string
  phone: { msisdn: string; local: string }
  /** Canonical GHA-XXXXXXXXX-X. The only place the card number may live; never log or return it. */
  cardCanonical: string
  region: GhRegion
  location: string
  occupation: string | null
}

export function parseAfaBody(body: unknown): { ok: true; value: AfaInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (hasForbiddenField(body)) return { ok: false, error: "Unexpected field" }
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref
  const name = parseFullName(body.full_name)
  if (!name.ok) return name
  const phone = normalizeRecipient(body.phone)
  if (!phone.ok) return { ok: false, error: "phone must be a valid Ghana mobile number" }
  if (typeof body.id_type !== "string" || body.id_type.trim().toLowerCase() !== "ghana card") {
    return { ok: false, error: 'id_type must be "Ghana Card"' }
  }
  const card = typeof body.id_number === "string" ? parseGhanaCardNumber(body.id_number) : null
  if (!card) return { ok: false, error: "id_number must be a valid Ghana Card number" }
  const region = parseRegion(body.region)
  if (!region.ok) return region
  const location = parseLocation(body.location)
  if (!location.ok) return location
  const occupation = parseOccupation(body.occupation)
  if (!occupation.ok) return occupation
  // date_of_birth is deliberately ignored: neither required, forbidden nor carried.
  return {
    ok: true,
    value: {
      reference: ref.reference,
      fullName: name.name,
      phone: { msisdn: phone.msisdn, local: phone.local },
      cardCanonical: card,
      region: region.region,
      location: location.location,
      occupation: occupation.occupation,
    },
  }
}

/** Card (sha256 of the canonical number), name, phone, region, location and occupation. The raw card number never enters the hash input. The reference is excluded. */
export function afaHash(i: AfaInput): string {
  return requestHash("afa", {
    card: createHash("sha256").update(i.cardCanonical).digest("hex"),
    full_name: i.fullName,
    phone: i.phone.local,
    region: i.region,
    location: i.location,
    occupation: i.occupation,
  })
}

// ---- order shapes ----

export interface PublicResultsOrder {
  reference: string
  exam_board: string
  quantity: number
  unit_price: number
  total_paid: number
  status: CommissionStatus
  created_at: string | null
}

/** Allow-list mapper: only these keys ever leave the API. */
export function mapResultsOrder(row: any, clientReference: string): PublicResultsOrder {
  const r = row ?? {}
  const q = Number(r.quantity)
  return {
    reference: clientReference,
    exam_board: String(r.exam_board ?? ""),
    quantity: Number.isSafeInteger(q) && q > 0 ? q : 0,
    unit_price: money(r.unit_price),
    total_paid: money(r.total_paid),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

export interface PublicVoucher {
  pin: string
  serial_number: string
}

/** Exactly pin and serial_number; ids, order and inventory references are dropped. */
export function mapVoucher(v: any): PublicVoucher {
  const r = v ?? {}
  return { pin: String(r.pin ?? ""), serial_number: String(r.serial_number ?? "") }
}

export type AfaFulfillment = "fulfilled" | "pending" | "failed"

/** fulfilled | failed pass through; anything else (incl. unfulfilled and unknown) reads pending. */
export function mapAfaFulfillment(db: unknown): AfaFulfillment {
  const s = typeof db === "string" ? db.trim().toLowerCase() : ""
  return s === "fulfilled" || s === "failed" ? s : "pending"
}

function localPhone(stored: unknown): string {
  const s = String(stored ?? "")
  if (/^\+?233[0-9]{9}$/.test(s)) return "0" + s.replace(/^\+?233/, "")
  return s
}

export interface PublicAfaOrder {
  reference: string
  full_name: string
  phone: string
  region: string
  amount: number
  status: CommissionStatus
  fulfillment: AfaFulfillment
  created_at: string | null
}

/** Allow-list mapper: no card number, order/transaction codes, notes or fulfillment internals. */
export function mapAfaOrder(row: any, clientReference: string): PublicAfaOrder {
  const r = row ?? {}
  return {
    reference: clientReference,
    full_name: String(r.full_name ?? ""),
    phone: localPhone(r.phone_number),
    region: String(r.region ?? ""),
    amount: money(r.amount),
    status: mapCommissionStatus(r.status),
    fulfillment: mapAfaFulfillment(r.fulfillment_status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

// ---- engine errors ----

/**
 * purchaseResultsCheckerVouchers (lib/results-checker-service.ts): the only
 * coded errors are INSUFFICIENT_BALANCE (thrown when deduct_wallet returned no
 * rows, so nothing was debited) and INSUFFICIENT_INVENTORY (thrown AFTER the
 * debit and an unchecked refund, so ambiguous). Uncoded errors (deduct RPC
 * failure, "Wallet refunded", price calculation) and anything unrecognised
 * are ambiguous.
 */
export function classifyResultsError(code: unknown): EngineErrorClass {
  return code === "INSUFFICIENT_BALANCE" ? "no_charge" : "ambiguous"
}

const AFA_NO_CHARGE_CODES = new Set(["INVALID_GHANA_CARD", "PRICE_UNAVAILABLE", "INSUFFICIENT_BALANCE"])

/**
 * submitAfaOrder (lib/afa-fulfillment.ts): INVALID_GHANA_CARD, PRICE_UNAVAILABLE
 * and INSUFFICIENT_BALANCE are all thrown before any debit. PAYMENT_FAILED (RPC
 * errored, outcome unknown) and ORDER_CREATE_FAILED (after the debit, refund
 * best-effort) are ambiguous, as is anything unrecognised.
 */
export function classifyAfaError(code: unknown): EngineErrorClass {
  return typeof code === "string" && AFA_NO_CHARGE_CODES.has(code) ? "no_charge" : "ambiguous"
}

function errParts(e: unknown): { code?: unknown; required?: unknown } {
  return typeof e === "object" && e !== null ? (e as { code?: unknown; required?: unknown }) : {}
}

function insufficient(err: { required?: unknown }): ErrorResponse {
  const hasRequired = (typeof err.required === "number" || typeof err.required === "string") && err.required !== "" && Number.isFinite(Number(err.required))
  if (!hasRequired) return { status: 402, code: "INSUFFICIENT_BALANCE", message: "Insufficient wallet balance" }
  const required = money(err.required)
  return {
    status: 402,
    code: "INSUFFICIENT_BALANCE",
    message: `Insufficient wallet balance. Required: GHS ${required.toFixed(2)}`,
    required,
  }
}

/** Fixed messages; engine text is never forwarded. */
export function resultsErrorResponse(e: unknown): ErrorResponse {
  const err = errParts(e)
  switch (err.code) {
    case "INSUFFICIENT_BALANCE":
      return insufficient(err)
    case "INSUFFICIENT_INVENTORY":
      return {
        status: 503,
        code: "INSUFFICIENT_INVENTORY",
        message:
          "Vouchers for this exam board are out of stock. Check your wallet balance and order history before retrying under a new reference.",
      }
    default:
      return { status: 500, code: "INTERNAL_ERROR", message: "Failed to purchase results checker vouchers" }
  }
}

export function afaErrorResponse(e: unknown): ErrorResponse {
  const err = errParts(e)
  switch (err.code) {
    case "INVALID_GHANA_CARD":
      return { status: 400, code: "INVALID_GHANA_CARD", message: "id_number must be a valid Ghana Card number" }
    case "PRICE_UNAVAILABLE":
      return { status: 503, code: "PRICE_UNAVAILABLE", message: "AFA registration is temporarily unavailable" }
    case "INSUFFICIENT_BALANCE":
      return insufficient(err)
    case "PAYMENT_FAILED":
      return { status: 500, code: "PAYMENT_FAILED", message: "Failed to process payment" }
    case "ORDER_CREATE_FAILED":
      return { status: 500, code: "ORDER_CREATE_FAILED", message: "Failed to create the AFA order" }
    default:
      return { status: 500, code: "INTERNAL_ERROR", message: "Failed to submit the AFA registration" }
  }
}
