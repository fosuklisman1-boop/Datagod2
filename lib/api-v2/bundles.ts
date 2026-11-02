/**
 * Pure request rules for the Developer API v2 Standard Bundles endpoints
 * (Hubtel-fulfilled bundles, commission key). No I/O. Money-adjacent: every
 * parser is strict and fails closed. The engine (lib/standard-bundles/service.ts)
 * is not touched.
 */

import { createHash } from "crypto"
import { BUNDLE_NETWORKS, type BundleNetwork } from "@/lib/standard-bundles/categories"
import { BUNDLE_TOKEN_TTL_MS } from "@/lib/standard-bundles/token"
import { NOT_AVAILABLE_FOR_NUMBER, PRICES_REFRESHED, PRICE_UPDATED } from "@/lib/standard-bundles/service"
import { normalizeRecipient, parseReference } from "./data-orders"
import { mapCommissionStatus, parseAmountPesewas, requestHash, type CommissionStatus } from "./commission"

type Fail = { ok: false; error: string }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const money = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

const fixed2 = (v: unknown) => money(v).toFixed(2)

// ---- network ----

export type BundleApiNetwork = "MTN" | "Telecel" | "AT"

const NETWORK_LOOKUP: Record<string, { network: BundleApiNetwork; engineNetwork: BundleNetwork }> = {
  mtn: { network: "MTN", engineNetwork: "MTN" },
  telecel: { network: "Telecel", engineNetwork: "TELECEL" },
  at: { network: "AT", engineNetwork: "AT" },
  airteltigo: { network: "AT", engineNetwork: "AT" },
}

const PUBLIC_NETWORK: Record<BundleNetwork, BundleApiNetwork> = { MTN: "MTN", TELECEL: "Telecel", AT: "AT" }

export function parseBundleNetwork(
  v: unknown
): { ok: true; network: BundleApiNetwork; engineNetwork: BundleNetwork } | Fail {
  if (typeof v === "string") {
    const key = v.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(NETWORK_LOOKUP, key)) return { ok: true, ...NETWORK_LOOKUP[key] }
  }
  return { ok: false, error: "network must be one of: MTN, Telecel, AT" }
}

// ---- purchase body ----

// Price-like and ownership fields are rejected (case-insensitively) so a client can never believe it set them.
// `network` is rejected too: the bundle_token already decides it, and a mismatching value must never be silently ignored.
const FORBIDDEN_FIELDS = new Set([
  "price",
  "amount",
  "face_amount",
  "pay_amount",
  "paid_amount",
  "status",
  "user_id",
  "network",
  "cashback",
  "customer_cashback",
  "fee",
  "total",
  "cost",
  "package_id",
  "package",
  "dealer_price",
  "api_key_id",
  "recipient_phone",
  "user",
  "channel",
])

/** What the bundle_token says it is. Decoded WITHOUT verifying: the engine verifies the signature, this only fixes the request hash. */
export interface BundleIdentity {
  network: BundleNetwork
  value: string
  pesewas: number
}

export interface BundlePurchaseInput {
  kind: "live" | "sandbox"
  token: string
  /** null for a sandbox token. */
  identity: BundleIdentity | null
  recipient: { msisdn: string; local: string }
  reference: string
  expectedPay?: number
}

const SANDBOX_TOKEN = /^sbx_[a-z0-9_]{1,40}$/
const TOKEN_MIN = 8
const TOKEN_MAX = 4000
const VALUE_MAX = 200
const FACE_MAX = 100_000
const TOKEN_BAD: Fail = { ok: false, error: "bundle_token is invalid" }

function decodeLiveToken(token: string): BundleIdentity | null {
  const parts = token.split(".")
  if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]{64}$/.test(parts[1])) return null
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!isPlainObject(payload)) return null
  const { network, value, amount } = payload
  if (typeof network !== "string" || !(BUNDLE_NETWORKS as readonly string[]).includes(network)) return null
  if (typeof value !== "string" || value === "" || value.length > VALUE_MAX) return null
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > FACE_MAX) return null
  return { network: network as BundleNetwork, value, pesewas: Math.round(amount * 100) }
}

export function parseBundlePurchaseBody(body: unknown): { ok: true; value: BundlePurchaseInput } | Fail {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  if (Object.keys(body).some((k) => FORBIDDEN_FIELDS.has(k.toLowerCase()))) return { ok: false, error: "Unexpected field" }

  const token = body.bundle_token
  if (typeof token !== "string" || token.length < TOKEN_MIN || token.length > TOKEN_MAX) return TOKEN_BAD
  let kind: "live" | "sandbox"
  let identity: BundleIdentity | null = null
  if (SANDBOX_TOKEN.test(token)) {
    kind = "sandbox"
  } else {
    identity = decodeLiveToken(token)
    if (!identity) return TOKEN_BAD
    kind = "live"
  }

  const rec = normalizeRecipient(body.recipient)
  if (!rec.ok) return rec
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref

  let expectedPay: number | undefined
  if (body.expected_pay !== undefined && body.expected_pay !== null) {
    const ep = parseAmountPesewas(body.expected_pay, { max: 10_000 })
    if (!ep.ok) return { ok: false, error: "expected_pay must be a positive amount with at most 2 decimals" }
    expectedPay = ep.amount
  }

  return {
    ok: true,
    value: {
      kind,
      token,
      identity,
      recipient: { msisdn: rec.msisdn, local: rec.local },
      reference: ref.reference,
      ...(expectedPay !== undefined ? { expectedPay } : {}),
    },
  }
}

/**
 * Network + bundle value + face amount + recipient (local form). The token itself is not hashed, so a refreshed token
 * for the same bundle replays instead of conflicting. Reference and expected_pay are excluded.
 */
export function bundleHash(i: BundlePurchaseInput): string {
  return requestHash("bundle", {
    bundle: i.identity ? { network: i.identity.network, value: i.identity.value, pesewas: i.identity.pesewas } : { sandbox_token: i.token },
    recipient: i.recipient.local,
  })
}

/**
 * The engine's own idempotency key, derived from the CLAIM id: one claim reaches the engine at most once, and a released
 * claim's retry gets a new claim and so a fresh key (an engine key reused after a failed-unpaid order would answer 402 forever).
 * Always matches the engine's /^[A-Za-z0-9-]{8,64}$/.
 */
export function bundleEngineKey(claimId: string): string {
  return "v2-" + createHash("sha256").update(String(claimId)).digest("hex").slice(0, 40)
}

// ---- messages ----

export const BUNDLE_CATALOG_VALID_SECONDS = BUNDLE_TOKEN_TTL_MS / 1000

export const MSG_BUNDLE_NOT_AVAILABLE = "NOT_AVAILABLE: standard bundles are not available on the API right now"
export const MSG_BUNDLE_TOKEN_EXPIRED =
  "BUNDLE_TOKEN_EXPIRED: the bundle_token is invalid or expired; nothing was charged. Fetch the catalog again with GET /bundles/catalog"
export const MSG_BUNDLE_UNAVAILABLE_FOR_NUMBER =
  "BUNDLE_UNAVAILABLE_FOR_NUMBER: this bundle is not offered for that number right now; nothing was charged. Fetch the catalog again with GET /bundles/catalog"
export const MSG_BUNDLE_UNAVAILABLE = "UNAVAILABLE: standard bundles are temporarily unavailable; nothing was charged"
export const MSG_BUNDLE_INSUFFICIENT = "INSUFFICIENT_BALANCE: wallet balance is too low; nothing was charged"
const MSG_BUNDLE_RECIPIENT = "recipient must be a valid Ghana mobile number"
const MSG_BUNDLE_INVALID_REQUEST = "INVALID_REQUEST: the request was refused; nothing was charged"
const MSG_BUNDLE_NETWORK_MISMATCH =
  "NETWORK_MISMATCH: the recipient number does not belong to this bundle's network; nothing was charged"

/** The engine quote shape ({ faceAmount, payAmount, customerCashback }) as a fixed PRICE_CHANGED message. */
export function bundlePriceChangedMessage(expectedPay: number | undefined, q: Record<string, unknown>): string {
  const exp = expectedPay !== undefined ? `expected ${fixed2(expectedPay)}, ` : ""
  return `PRICE_CHANGED: ${exp}current ${fixed2(q.payAmount)} (face_amount ${fixed2(q.faceAmount)}, customer_cashback ${fixed2(
    q.customerCashback
  )}). Review the price and resend with expected_pay`
}

// ---- engine refusals ----

export type BundleRefusalClass =
  | { kind: "no_charge"; status: 400 | 402 | 403 | 409 | 503; message: string }
  | { kind: "ambiguous" }

const AMBIGUOUS: BundleRefusalClass = { kind: "ambiguous" }

/**
 * An engine `{ ok: false }` result -> a fixed no-charge response, or ambiguous.
 *
 * no_charge ONLY for refusals the engine raises BEFORE it inserts the order row (400/403/409/503 without an `order`) and
 * for the unpaid-insufficient 402. A refusal that carries an order, any 5xx other than the pre-insert 503, and any shape
 * or text we do not recognise is ambiguous: the claim is never released, because money may have moved. Engine text is
 * matched but never forwarded.
 */
export function classifyBundleRefusal(r: unknown, expectedPay: number | undefined): BundleRefusalClass {
  if (!isPlainObject(r) || typeof r.status !== "number" || typeof r.error !== "string") return AMBIGUOUS
  const order = r.order
  const hasOrder = order !== undefined && order !== null
  const noCharge = (status: 400 | 402 | 403 | 409 | 503, message: string): BundleRefusalClass => ({ kind: "no_charge", status, message })

  if (r.status === 402) {
    if (!hasOrder || (isPlainObject(order) && order.payment_status === "unpaid")) return noCharge(402, MSG_BUNDLE_INSUFFICIENT)
    return AMBIGUOUS
  }
  if (hasOrder) return AMBIGUOUS

  switch (r.status) {
    case 400:
      if (r.error === "Enter a valid Ghana mobile number") return noCharge(400, MSG_BUNDLE_RECIPIENT)
      if (r.error === "Invalid request, please try again") return noCharge(400, MSG_BUNDLE_INVALID_REQUEST)
      return noCharge(400, MSG_BUNDLE_NETWORK_MISMATCH)
    case 403:
      return noCharge(403, MSG_BUNDLE_NOT_AVAILABLE)
    case 409: {
      if (r.error === PRICE_UPDATED && isPlainObject(r.quote)) {
        return noCharge(409, bundlePriceChangedMessage(expectedPay, r.quote))
      }
      if (r.error === PRICES_REFRESHED) return noCharge(409, MSG_BUNDLE_TOKEN_EXPIRED)
      if (r.error === NOT_AVAILABLE_FOR_NUMBER) return noCharge(409, MSG_BUNDLE_UNAVAILABLE_FOR_NUMBER)
      return AMBIGUOUS
    }
    case 503:
      return noCharge(503, MSG_BUNDLE_UNAVAILABLE)
    default:
      return AMBIGUOUS
  }
}

// ---- public shapes ----

function localRecipient(stored: unknown): string {
  const s = String(stored ?? "")
  if (/^\+?233[0-9]{9}$/.test(s)) return "0" + s.replace(/^\+?233/, "")
  return s
}

export interface PublicBundleOrder {
  reference: string
  network: string
  bundle: string
  recipient: string
  face_amount: number
  paid_amount: number
  cashback: number
  status: CommissionStatus
  created_at: string | null
}

/** Allow-list mapper: only these keys ever leave the API (never notes, failure reasons, provider references or bundle values). */
export function mapBundleOrder(row: any, clientReference: string): PublicBundleOrder {
  const r = row ?? {}
  const net =
    typeof r.network === "string" && Object.prototype.hasOwnProperty.call(PUBLIC_NETWORK, r.network)
      ? PUBLIC_NETWORK[r.network as BundleNetwork]
      : String(r.network ?? "")
  return {
    reference: clientReference,
    network: net,
    bundle: String(r.bundle_display ?? ""),
    recipient: localRecipient(r.beneficiary_phone),
    face_amount: money(r.amount),
    paid_amount: money(r.paid_amount ?? r.amount),
    cashback: money(r.cashback_amount),
    status: mapCommissionStatus(r.status),
    created_at: typeof r.created_at === "string" ? r.created_at : null,
  }
}

export interface PublicBundleCatalog {
  network: BundleApiNetwork
  token_valid_seconds: number
  categories: { name: string; bundles: { bundle_token: string; display: string; face_amount: number; pay_amount: number; customer_cashback: number }[] }[]
}

export function mapBundleCatalog(
  network: BundleApiNetwork,
  categories: { name: string; bundles: { bundle_token: string; display: string; face_amount: number; pay_amount: number; customer_cashback: number }[] }[]
): PublicBundleCatalog {
  return {
    network,
    token_valid_seconds: BUNDLE_CATALOG_VALID_SECONDS,
    categories: categories.map((c) => ({
      name: String(c.name),
      bundles: c.bundles.map((b) => ({
        bundle_token: String(b.bundle_token),
        display: String(b.display),
        face_amount: money(b.face_amount),
        pay_amount: money(b.pay_amount),
        customer_cashback: money(b.customer_cashback),
      })),
    })),
  }
}
