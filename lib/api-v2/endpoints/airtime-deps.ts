/**
 * Real AirtimeDeps wiring for the v2 airtime routes. MONEY PATH.
 *
 * - engine: the shared purchaseAirtime (lib/airtime-service.ts, unchanged),
 *   always channel "api", paySeparately false, NEVER a shopId.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - phone gate: the same checkPhoneVerified wiring as the v2 data routes
 *   (realPhoneGate: default failClosed, a throw is a block).
 * - order reads: only the allow-listed airtime_orders columns, always
 *   filtered by user_id.
 */
import { purchaseAirtime } from "@/lib/airtime-service"
import { getAdminClient, type SupabaseLike } from "../store"
import {
  claimRequest,
  completeClaim,
  getClaimByReference,
  listClaims,
  markClaimUnknown,
  releaseClaim,
} from "../idempotency"
import { realPhoneGate } from "./data-deps"
import type { AirtimeDeps, AirtimeEngineParams, AirtimeEngineResult, AirtimeOrderRow, AirtimeSandboxOrder } from "./airtime"

export const AIRTIME_ORDER_COLUMNS =
  "reference_code, network, beneficiary_phone, airtime_amount, fee_amount, total_paid, cashback_amount, status, created_at"

const MAX_CODES = 30

/** Owner-scoped single order read; null when missing or on any error. */
export async function fetchAirtimeOrderByCode(
  client: SupabaseLike,
  userId: string,
  code: string
): Promise<AirtimeOrderRow | null> {
  try {
    const { data, error } = await client
      .from("airtime_orders")
      .select(AIRTIME_ORDER_COLUMNS)
      .eq("user_id", userId)
      .eq("reference_code", code)
      .maybeSingle()
    if (error || !data) return null
    return data as AirtimeOrderRow
  } catch {
    return null
  }
}

/** Owner-scoped batch read (one .in() of at most 30 codes); null on a read error. */
export async function fetchAirtimeOrdersByCodes(
  client: SupabaseLike,
  userId: string,
  codes: string[]
): Promise<AirtimeOrderRow[] | null> {
  const list = codes.slice(0, MAX_CODES)
  if (list.length === 0) return []
  try {
    const { data, error } = await client
      .from("airtime_orders")
      .select(AIRTIME_ORDER_COLUMNS)
      .eq("user_id", userId)
      .in("reference_code", list)
    if (error || !Array.isArray(data)) return null
    return data as AirtimeOrderRow[]
  } catch {
    return null
  }
}

/** Exactly the arguments v2 hands the engine: no shopId, channel "api". */
export function toEngineParams(p: AirtimeEngineParams) {
  return {
    userId: p.userId,
    network: p.network,
    beneficiaryPhone: p.beneficiaryPhone,
    airtimeAmount: p.airtimeAmount,
    paySeparately: false,
    channel: "api" as const,
    ...(p.expectedPay !== undefined ? { expectedPay: p.expectedPay } : {}),
  }
}

export async function realAirtimeEngine(p: AirtimeEngineParams): Promise<AirtimeEngineResult> {
  return purchaseAirtime(toEngineParams(p))
}

/** Phone gate as a boolean; only allowed === true passes. Never throws. */
export async function realAirtimePhoneGate(client: unknown, userId: string): Promise<boolean> {
  try {
    return (await realPhoneGate(client, userId)).allowed === true
  } catch {
    return false
  }
}

export function realAirtimeDeps(): AirtimeDeps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId) => markClaimUnknown(client, claimId, userId),
    getClaim: (userId, reference) => getClaimByReference(client, userId, "airtime", reference),
    listClaims: (userId, limit) => listClaims(client, userId, "airtime", limit),
    engine: realAirtimeEngine,
    getOrderByCode: (userId, code) => fetchAirtimeOrderByCode(client, userId, code),
    getOrdersByCodes: (userId, codes) => fetchAirtimeOrdersByCodes(client, userId, codes),
    phoneGate: (userId) => realAirtimePhoneGate(client, userId),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as AirtimeSandboxOrder | null),
      listOrders: async (userId, action, limit) =>
        ((await (await import("@/lib/sandbox")).listSandboxOrders(userId, action, limit)) as AirtimeSandboxOrder[] | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
    },
    now: () => Date.now(),
  }
}
