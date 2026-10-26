/**
 * Real AfaDeps wiring for the v2 AFA routes. MONEY PATH.
 *
 * - engine: the shared submitAfaOrder (lib/afa-fulfillment.ts, unchanged). The engine fires
 *   fulfillment WITHOUT awaiting it (existing behaviour); v1 and the dashboard are unchanged.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - order reads: only the allow-listed afa_orders columns, always filtered by user_id. The
 *   engine's order_code is 7 digits of a ms clock and NOT unique, so reads take the newest match.
 * - the Ghana Card number is only ever a filter value in the duplicate guard; it is never
 *   selected, returned or logged.
 */
import { submitAfaOrder } from "@/lib/afa-fulfillment"
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

/**
 * Duplicate guard: this user's non-failed afa_orders created since `sinceIso` with the same
 * phone (local or msisdn form, as stored) OR the same Ghana Card. Throws on any read error.
 */
export async function findRecentAfaDuplicate(
  client: SupabaseLike,
  userId: string,
  phoneLocal: string,
  cardCanonical: string,
  sinceIso: string
): Promise<boolean> {
  const msisdn = /^0[0-9]{9}$/.test(phoneLocal) ? `233${phoneLocal.slice(1)}` : phoneLocal
  const filter = [`phone_number.eq.${phoneLocal}`, `phone_number.eq.${msisdn}`, `phone_number.eq.+${msisdn}`, `gh_card_number.eq.${cardCanonical}`].join(",")
  const { data, error } = await (client as any)
    .from("afa_orders")
    .select("order_code")
    .eq("user_id", userId)
    .neq("status", "failed")
    .gte("created_at", sinceIso)
    .or(filter)
    .limit(1)
  if (error || !Array.isArray(data)) throw new Error("duplicate guard read failed")
  return data.length > 0
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
