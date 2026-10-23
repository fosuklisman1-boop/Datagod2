/**
 * Pure data-order rules for Developer API v2: input parsing, pricing, package
 * lookup and the public order shape. No I/O. Money-adjacent: every parser is
 * strict and fails closed.
 */

export type ApiNetwork = "MTN" | "Telecel" | "AT-iShare" | "AT-BigTime"

const NETWORKS: Record<ApiNetwork, string> = {
  MTN: "MTN",
  Telecel: "Telecel",
  "AT-iShare": "AT - iShare",
  "AT-BigTime": "AT - BigTime",
}

/** lower-case accepted spelling -> canonical API name */
const NETWORK_LOOKUP: Record<string, ApiNetwork> = {
  mtn: "MTN",
  telecel: "Telecel",
  "at-ishare": "AT-iShare",
  "at-bigtime": "AT-BigTime",
  "at - ishare": "AT-iShare",
  "at - bigtime": "AT-BigTime",
}

const VALID_NETWORKS_MESSAGE = "network must be one of: MTN, Telecel, AT-iShare, AT-BigTime"

export function parseNetwork(
  v: unknown
): { ok: true; network: ApiNetwork; dbNetwork: string } | { ok: false; error: string } {
  if (typeof v === "string") {
    const key = v.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(NETWORK_LOOKUP, key)) {
      const network = NETWORK_LOOKUP[key]
      return { ok: true, network, dbNetwork: NETWORKS[network] }
    }
  }
  return { ok: false, error: VALID_NETWORKS_MESSAGE }
}

export function normalizeRecipient(
  v: unknown
): { ok: true; msisdn: string; local: string } | { ok: false; error: string } {
  const bad = { ok: false as const, error: "recipient must be a valid Ghana mobile number" }
  if (typeof v !== "string") return bad
  // Only spaces and hyphens are tolerated separators; anything else (newlines, letters) fails.
  const s = v.replace(/[ -]/g, "")
  let local: string
  if (/^\+233[235][0-9]{8}$/.test(s)) local = "0" + s.slice(4)
  else if (/^233[235][0-9]{8}$/.test(s)) local = "0" + s.slice(3)
  else if (/^0[235][0-9]{8}$/.test(s)) local = s
  else return bad
  return { ok: true, msisdn: "233" + local.slice(1), local }
}

export function parseVolume(v: unknown): { ok: true; gb: number } | { ok: false; error: string } {
  const bad = { ok: false as const, error: "volume_gb must be a positive number up to 1000 with at most 3 decimals" }
  let s: string
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return bad
    s = String(v)
  } else if (typeof v === "string") {
    s = v
  } else {
    return bad
  }
  if (!/^[0-9]+(\.[0-9]{1,3})?$/.test(s)) return bad
  const gb = Number(s)
  if (!(gb > 0) || gb > 1000) return bad
  return { ok: true, gb }
}

export function parseReference(v: unknown): { ok: true; reference: string } | { ok: false; error: string } {
  const bad = {
    ok: false as const,
    error: "reference must be 3 to 100 characters: letters, digits, '-', '_', '.', ':'",
  }
  if (typeof v !== "string") return bad
  const reference = v.trim()
  if (reference.length < 3 || reference.length > 100) return bad
  if (!/^[A-Za-z0-9_.:-]+$/.test(reference)) return bad
  return { ok: true, reference }
}

export interface PurchaseInput {
  network: ApiNetwork
  dbNetwork: string
  gb: number
  msisdn: string
  local: string
  reference: string
}

// Price-like and ownership fields are rejected (case-insensitively) so a client
// can never believe it set them. Unknown OTHER fields are ignored deliberately.
const FORBIDDEN_FIELDS = new Set([
  "price",
  "amount",
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
])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

export function parsePurchaseBody(
  body: unknown
): { ok: true; value: PurchaseInput } | { ok: false; error: string } {
  if (!isPlainObject(body)) return { ok: false, error: "Request body must be a JSON object" }
  for (const k of Object.keys(body)) {
    if (FORBIDDEN_FIELDS.has(k.toLowerCase())) return { ok: false, error: "Unexpected field" }
  }
  const net = parseNetwork(body.network)
  if (!net.ok) return net
  const vol = parseVolume(body.volume_gb)
  if (!vol.ok) return vol
  const rec = normalizeRecipient(body.recipient)
  if (!rec.ok) return rec
  const ref = parseReference(body.reference)
  if (!ref.ok) return ref
  return {
    ok: true,
    value: {
      network: net.network,
      dbNetwork: net.dbNetwork,
      gb: vol.gb,
      msisdn: rec.msisdn,
      local: rec.local,
      reference: ref.reference,
    },
  }
}

export function parseBulkBody(
  body: unknown
): { ok: true; items: PurchaseInput[] } | { ok: false; error: string; index?: number } {
  if (!isPlainObject(body) || !Array.isArray(body.orders)) {
    return { ok: false, error: "orders must be an array of 1 to 100 orders" }
  }
  const orders = body.orders as unknown[]
  if (orders.length < 1 || orders.length > 100) {
    return { ok: false, error: "orders must be an array of 1 to 100 orders" }
  }
  const items: PurchaseInput[] = []
  const seen = new Set<string>()
  for (let i = 0; i < orders.length; i++) {
    const r = parsePurchaseBody(orders[i])
    if (!r.ok) return { ok: false, error: r.error, index: i }
    if (seen.has(r.value.reference)) return { ok: false, error: "Duplicate reference in batch", index: i }
    seen.add(r.value.reference)
    items.push(r.value)
  }
  return { ok: true, items }
}

/** v1 rule: dealers pay dealer_price when it is positive; everyone else pays price. */
export function priceForRole(role: string, pkg: { price: number; dealer_price: number | null }): number {
  if (role === "dealer" && pkg.dealer_price != null && Number(pkg.dealer_price) > 0) return Number(pkg.dealer_price)
  return Number(pkg.price)
}

export type ApiOrderStatus = "pending" | "processing" | "completed" | "failed" | "refunded" | "queued"

/**
 * DB status -> public status. cancelled is terminal (nothing will be
 * delivered) so it reads failed; reversed and refunding are still being
 * worked on (admin review / refund in flight) so they read processing, as
 * does anything unknown.
 */
export function mapOrderStatus(dbStatus: unknown): ApiOrderStatus {
  const s = typeof dbStatus === "string" ? dbStatus.trim().toLowerCase() : ""
  switch (s) {
    case "pending":
    case "processing":
    case "completed":
    case "failed":
    case "refunded":
      return s
    case "cancelled":
      return "failed"
    case "held_registration":
      return "queued"
    case "reversed":
    case "refunding":
    default:
      return "processing"
  }
}

export interface OrderDbRow {
  api_reference: string
  network: string
  volume_gb: number | string
  price: number | string
  recipient_phone: string
  status: unknown
  created_at: string
}

export interface PublicOrder {
  reference: string
  network: string
  volume_gb: number
  recipient: string
  price: number
  status: ApiOrderStatus
  created_at: string
}

function canonicalNetwork(dbNetwork: string): string {
  const trimmed = String(dbNetwork ?? "").trim()
  const key = trimmed.toLowerCase()
  return Object.prototype.hasOwnProperty.call(NETWORK_LOOKUP, key) ? NETWORK_LOOKUP[key] : trimmed
}

function localRecipient(stored: string): string {
  const s = String(stored ?? "")
  if (/^\+?233[0-9]{9}$/.test(s)) return "0" + s.replace(/^\+?233/, "")
  return s
}

/** Allow-list mapper: only these seven keys ever leave the API. */
export function mapOrder(row: OrderDbRow): PublicOrder {
  return {
    reference: row.api_reference,
    network: canonicalNetwork(row.network),
    volume_gb: Number(row.volume_gb),
    recipient: localRecipient(row.recipient_phone),
    price: Math.round(Number(row.price) * 100) / 100,
    status: mapOrderStatus(row.status),
    created_at: row.created_at,
  }
}

export interface PackageRow {
  id: string
  network: string
  size: string
  price: number
  dealer_price: number | null
}

/** Mirrors the SQL regex in place_api_v2_order exactly; no parseFloat tolerance. */
const SIZE_RE = /^[0-9]+(\.[0-9]+)?$/

export function findPackage(rows: PackageRow[], dbNetwork: string, gb: number): PackageRow | null {
  const net = dbNetwork.toLowerCase()
  for (const r of rows) {
    if (typeof r.size !== "string" || !SIZE_RE.test(r.size)) continue
    if (String(r.network).toLowerCase() !== net) continue
    if (Number(r.size) === gb) return r
  }
  return null
}
