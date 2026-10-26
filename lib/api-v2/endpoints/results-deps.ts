/**
 * Real ResultsDeps wiring for the v2 results checker routes. MONEY + PIN PATH.
 *
 * - engine: the shared purchaseResultsCheckerVouchers (lib/results-checker-service.ts,
 *   unchanged), called with { userId, examBoard, quantity } ONLY: never a shopId, never
 *   applyBulk. v1 and the dashboard are unchanged.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - phone gate: the same checkPhoneVerified wiring as the other v2 routes (fail closed).
 * - order reads: only the allow-listed results_checker_orders columns, always filtered by user_id.
 * - readVouchers: owner-scoped THROUGH the order. The order is selected by reference_code AND
 *   user_id first; only the ids in ITS inventory_ids are then read, and only pin + serial_number.
 *   Vouchers are never selected by board, so another user's stock can never be reached.
 * - delivery: to the request's RECIPIENT contact only (never the account profile).
 */
import {
  calculateRCPrice,
  getAvailableCount,
  getMaxQuantity,
  isExamBoardEnabled,
  purchaseResultsCheckerVouchers,
} from "@/lib/results-checker-service"
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
import type {
  ResultsDeps,
  ResultsEngineParams,
  ResultsEngineResult,
  ResultsOrderRow,
  ResultsSandboxOrder,
} from "./results"

export const RESULTS_ORDER_COLUMNS = "reference_code, exam_board, quantity, unit_price, total_paid, status, created_at"

const MAX_CODES = 30
/** Upper bound on the inventory ids read for one order (the admin max quantity is far below this). */
export const MAX_VOUCHER_IDS = 100

/** Owner-scoped single order read; null when missing or on any error. */
export async function fetchResultsOrderByCode(client: SupabaseLike, userId: string, code: string): Promise<ResultsOrderRow | null> {
  try {
    const { data, error } = await client
      .from("results_checker_orders")
      .select(RESULTS_ORDER_COLUMNS)
      .eq("user_id", userId)
      .eq("reference_code", code)
      .maybeSingle()
    if (error || !data) return null
    return data as ResultsOrderRow
  } catch {
    return null
  }
}

/** Owner-scoped batch read (one .in() of at most 30 codes); null on a read error. */
export async function fetchResultsOrdersByCodes(client: SupabaseLike, userId: string, codes: string[]): Promise<ResultsOrderRow[] | null> {
  const list = codes.slice(0, MAX_CODES)
  if (list.length === 0) return []
  try {
    const { data, error } = await client
      .from("results_checker_orders")
      .select(RESULTS_ORDER_COLUMNS)
      .eq("user_id", userId)
      .in("reference_code", list)
    if (error || !Array.isArray(data)) return null
    return data as ResultsOrderRow[]
  } catch {
    return null
  }
}

/**
 * Vouchers of the user's OWN completed order. Step 1 selects the order by reference_code AND
 * user_id (a foreign or missing code yields null before inventory is ever touched). Step 2
 * reads only pin + serial_number for the ids in that order's inventory_ids, in a deterministic
 * order (serial_number, then id). Fails closed (null) on any error, a non-completed order,
 * no ids, more than MAX_VOUCHER_IDS ids, or fewer rows than ids.
 */
export async function fetchOwnedVouchers(
  client: SupabaseLike,
  userId: string,
  orderRef: string
): Promise<{ pin: string; serial_number: string | null }[] | null> {
  try {
    const { data: order, error } = await client
      .from("results_checker_orders")
      .select("status, inventory_ids")
      .eq("user_id", userId)
      .eq("reference_code", orderRef)
      .maybeSingle()
    if (error || !order || order.status !== "completed") return null
    const ids: unknown = order.inventory_ids
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_VOUCHER_IDS) return null
    if (!ids.every((i) => typeof i === "string" && i)) return null
    const { data, error: invError } = await client
      .from("results_checker_inventory")
      .select("pin, serial_number")
      .in("id", ids as string[])
      .order("serial_number", { ascending: true })
      .order("id", { ascending: true })
    if (invError || !Array.isArray(data) || data.length !== ids.length) return null
    return data.map((r: any) => ({
      pin: String(r.pin ?? ""),
      serial_number: typeof r.serial_number === "string" ? r.serial_number : null,
    }))
  } catch {
    return null
  }
}

/** Exactly the arguments v2 hands the engine: no shopId, no applyBulk. */
export function toEngineParams(p: ResultsEngineParams) {
  return { userId: p.userId, examBoard: p.examBoard, quantity: p.quantity }
}

export async function realResultsEngine(p: ResultsEngineParams): Promise<ResultsEngineResult> {
  return purchaseResultsCheckerVouchers(toEngineParams(p))
}

/** URGENT admin alert through the same notifier as the airtime alert. Never throws. */
export async function realResultsAlert(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "results_review", undefined, false)
  } catch {
    // alerting must never break the flow
  }
}

/**
 * Delivers the PINs to the request's recipient. Persists the recipient contact on the order
 * (owner-scoped) so a later resend finds it, as v1 does, then hands off to deliverVouchers.
 * Throws are the caller's to swallow; nothing is logged here (it would carry contact data).
 */
export async function realResultsDeliver(
  client: SupabaseLike,
  order: Record<string, any>,
  vouchers: ResultsEngineResult["vouchers"],
  phone: string | null,
  email: string | null
): Promise<void> {
  if (!phone && !email) return
  if (typeof order?.id === "string" && typeof order?.user_id === "string") {
    await client
      .from("results_checker_orders")
      .update({ customer_phone: phone, customer_email: email, updated_at: new Date().toISOString() })
      .eq("id", order.id)
      .eq("user_id", order.user_id)
  }
  const { deliverVouchers } = await import("@/lib/results-checker-notification-service")
  await deliverVouchers({ ...order, customer_phone: phone, customer_email: email }, vouchers as any)
}

export function realResultsDeps(): ResultsDeps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId, orderRef) => markClaimUnknown(client, claimId, userId, orderRef),
    alert: realResultsAlert,
    getClaim: (userId, reference) => getClaimByReference(client, userId, "results", reference),
    // Done claims only, filtered in the query: the limit must count orders, not claims still running.
    listClaims: (userId, limit) => listClaims(client, userId, "results", limit, { status: "done" }),
    engine: realResultsEngine,
    getMaxQuantity: () => getMaxQuantity(),
    boardEnabled: (board) => isExamBoardEnabled(board),
    available: (board) => getAvailableCount(board),
    price: async (board, quantity) => {
      const p = await calculateRCPrice({ examBoard: board, quantity })
      return { unitPrice: p.unitPrice, totalPaid: p.totalPaid }
    },
    readVouchers: (userId, orderRef) => fetchOwnedVouchers(client, userId, orderRef),
    getOrderByCode: (userId, code) => fetchResultsOrderByCode(client, userId, code),
    getOrdersByCodes: (userId, codes) => fetchResultsOrdersByCodes(client, userId, codes),
    deliver: (order, vouchers, phone, email) => realResultsDeliver(client, order, vouchers, phone, email),
    phoneGate: (userId) => realAirtimePhoneGate(client, userId),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as ResultsSandboxOrder | null),
      listOrders: async (userId, action, limit) =>
        ((await (await import("@/lib/sandbox")).listSandboxOrders(userId, action, limit)) as ResultsSandboxOrder[] | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
    },
    now: () => Date.now(),
  }
}
