/**
 * Real AfaDeps wiring for the v2 AFA routes. MONEY PATH.
 *
 * - engine: the shared submitAfaOrder (lib/afa-fulfillment.ts, unchanged). The engine fires
 *   fulfillment WITHOUT awaiting it (existing behaviour); v1 and the dashboard are unchanged.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - order reads: only the allow-listed afa_orders columns, always filtered by user_id. The
 *   engine's order_code is 7 digits of a ms clock and NOT unique, so reads take the newest match.
 * - the Ghana Card number: the duplicate guard reads this user's recent rows (phone_number and
 *   gh_card_number only) and compares in memory, so neither value is ever put in a request URL
 *   (Supabase logs those). It is never returned or logged.
 */
import { submitAfaOrder } from "@/lib/afa-fulfillment"
import { parseGhanaCardNumber } from "@/lib/ghana-card"
import { getAdminClient, type SupabaseLike } from "../store"
import {
  claimRequest,
  completeClaim,
  getClaimByReference,
  listClaims,
  markClaimUnknown,
  releaseClaim,
} from "../idempotency"
import { realAirtimePhoneGate } from "./airtime-deps"
import type { AfaDeps, AfaEngineParams, AfaEngineResult, AfaOrderRow, AfaSandboxOrder } from "./afa"

export const AFA_ORDER_COLUMNS = "order_code, full_name, phone_number, region, amount, status, fulfillment_status, created_at"

const MAX_CODES = 30
const MAX_ROWS = 100

/** Owner-scoped newest match for (user, order_code); null when missing or on any error. */
export async function fetchAfaOrderByCode(client: SupabaseLike, userId: string, code: string): Promise<AfaOrderRow | null> {
  try {
    const { data, error } = await (client as any)
      .from("afa_orders")
      .select(AFA_ORDER_COLUMNS)
      .eq("user_id", userId)
      .eq("order_code", code)
      .order("created_at", { ascending: false })
      .limit(1)
    if (error || !Array.isArray(data) || data.length === 0) return null
    return data[0] as AfaOrderRow
  } catch {
    return null
  }
}

/** Owner-scoped batch read, newest first (one .in() of at most 30 codes); null on a read error. */
export async function fetchAfaOrdersByCodes(client: SupabaseLike, userId: string, codes: string[]): Promise<AfaOrderRow[] | null> {
  const list = codes.slice(0, MAX_CODES)
  if (list.length === 0) return []
  try {
    const { data, error } = await (client as any)
      .from("afa_orders")
      .select(AFA_ORDER_COLUMNS)
      .eq("user_id", userId)
      .in("order_code", list)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS)
    if (error || !Array.isArray(data)) return null
    return data as AfaOrderRow[]
  } catch {
    return null
  }
}

/** Digits-only phone, normalised to the local 0XXXXXXXXX form when it is a Ghana number. */
function localDigits(v: unknown): string {
  const d = String(v ?? "").replace(/\D/g, "")
  return d.startsWith("233") && d.length === 12 ? `0${d.slice(3)}` : d
}

// A reseller can legitimately register well over 50 customers in the 10-minute window (the default
// purchase limit alone allows ~100 per key), so scan up to 200 recent rows. Two columns only.
const DUPLICATE_SCAN_LIMIT = 200

/**
 * Duplicate guard: does this user have a non-failed afa_orders row created since `sinceIso`
 * with the same phone (any stored form) OR the same Ghana Card? The query filters by user and
 * window ONLY and selects just phone + card; the phone and the card are compared in memory so
 * neither ever appears in the PostgREST query string (which lands in request logs).
 * Throws on any read error (the handler fails closed).
 */
export async function findRecentAfaDuplicate(
  client: SupabaseLike,
  userId: string,
  phoneLocal: string,
  cardCanonical: string,
  sinceIso: string
): Promise<boolean> {
  const { data, error } = await (client as any)
    .from("afa_orders")
    .select("phone_number, gh_card_number")
    .eq("user_id", userId)
    .neq("status", "failed")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(DUPLICATE_SCAN_LIMIT)
  if (error || !Array.isArray(data)) throw new Error("duplicate guard read failed")
  const phone = localDigits(phoneLocal)
  const card = parseGhanaCardNumber(cardCanonical) ?? cardCanonical
  return data.some((row: any) => {
    if (!row || typeof row !== "object") return false
    if (phone && localDigits(row.phone_number) === phone) return true
    const stored = typeof row.gh_card_number === "string" ? (parseGhanaCardNumber(row.gh_card_number) ?? row.gh_card_number.trim().toUpperCase()) : ""
    return stored !== "" && stored === card
  })
}

export async function realAfaEngine(p: AfaEngineParams): Promise<AfaEngineResult> {
  return submitAfaOrder(p as any) as Promise<AfaEngineResult>
}

/** URGENT admin alert through the same notifier as the airtime alert. Never throws. */
export async function realAfaAlert(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "afa_review", undefined, false)
  } catch {
    // alerting must never break the flow
  }
}

/** Active default AFA price, as submitAfaOrder reads it. Throws when unavailable. */
export async function fetchAfaPrice(client: SupabaseLike): Promise<number> {
  const { data } = await (client as any)
    .from("afa_registration_prices")
    .select("price")
    .eq("is_active", true)
    .eq("name", "default")
    .maybeSingle()
  const price = data?.price != null ? parseFloat(data.price) : NaN
  if (!Number.isFinite(price) || price <= 0) throw new Error("AFA price unavailable")
  return price
}

export function realAfaDeps(): AfaDeps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId, orderRef) => markClaimUnknown(client, claimId, userId, orderRef),
    alert: realAfaAlert,
    getClaim: (userId, reference) => getClaimByReference(client, userId, "afa", reference),
    listClaims: (userId, limit) => listClaims(client, userId, "afa", limit, { status: "done" }),
    engine: realAfaEngine,
    findRecentDuplicate: (userId, phone, card, since) => findRecentAfaDuplicate(client, userId, phone, card, since),
    getOrderByCode: (userId, code) => fetchAfaOrderByCode(client, userId, code),
    getOrdersByCodes: (userId, codes) => fetchAfaOrdersByCodes(client, userId, codes),
    phoneGate: (userId) => realAirtimePhoneGate(client, userId),
    afaPrice: () => fetchAfaPrice(client),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as AfaSandboxOrder | null),
      listOrders: async (userId, action, limit) =>
        ((await (await import("@/lib/sandbox")).listSandboxOrders(userId, action, limit)) as AfaSandboxOrder[] | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
    },
    now: () => Date.now(),
  }
}
