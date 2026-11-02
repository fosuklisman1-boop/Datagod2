/**
 * Real BundlesV2Deps wiring for the v2 Standard Bundles routes. MONEY PATH.
 *
 * - buy: the shared buyBundle (lib/standard-bundles/service.ts, unchanged) over
 *   getBundlesRuntime(), always channel "api" and the claim-derived idempotency
 *   key v2 hands in. v1 and the dashboard are unchanged.
 * - catalog: the same signed, priced catalogue as v1, behind the admin API surface switch.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - surface gate: readApiSurface (fail closed), as v1 bundles and v2 bills.
 * - phone gate: the same checkPhoneVerified wiring as the other v2 routes (a throw is a block).
 * - order reads: only the allow-listed hubtel_data_orders columns, always filtered by user_id.
 */
import { buyBundle, type BuyResult } from "@/lib/standard-bundles/service"
import { getBundlesRuntime } from "@/lib/standard-bundles/runtime"
import { getCatalog } from "@/lib/standard-bundles/catalog"
import type { BundleNetwork } from "@/lib/standard-bundles/categories"
import { readApiSurface } from "@/lib/api-v1/surface"
import { priceCatalog } from "@/lib/api-v1/bundles"
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
import { surfaceOpenFrom } from "./bills-deps"
import type {
  BundleBuyParams,
  BundleCatalogResult,
  BundleOrderRow,
  BundleSandboxOrder,
  BundlesV2Deps,
} from "./bundles"

// payment_status is read only to resolve an unknown claim; mapBundleOrder never returns it.
export const BUNDLE_ORDER_COLUMNS =
  "reference_code, network, beneficiary_phone, bundle_display, amount, paid_amount, cashback_amount, status, payment_status, created_at"

const MAX_CODES = 30

/** Owner-scoped single order read; null when missing or on any error. */
export async function fetchBundleOrderByCode(client: SupabaseLike, userId: string, code: string): Promise<BundleOrderRow | null> {
  try {
    const { data, error } = await client
      .from("hubtel_data_orders")
      .select(BUNDLE_ORDER_COLUMNS)
      .eq("user_id", userId)
      .eq("reference_code", code)
      .maybeSingle()
    if (error || !data) return null
    return data as BundleOrderRow
  } catch {
    return null
  }
}

/** Owner-scoped batch read (one .in() of at most 30 codes); null on a read error. */
export async function fetchBundleOrdersByCodes(client: SupabaseLike, userId: string, codes: string[]): Promise<BundleOrderRow[] | null> {
  const list = codes.slice(0, MAX_CODES)
  if (list.length === 0) return []
  try {
    const { data, error } = await client
      .from("hubtel_data_orders")
      .select(BUNDLE_ORDER_COLUMNS)
      .eq("user_id", userId)
      .in("reference_code", list)
    if (error || !Array.isArray(data)) return null
    return data as BundleOrderRow[]
  } catch {
    return null
  }
}

/** Exactly the arguments v2 hands the engine: channel "api" is fixed here, never taken from the caller. */
export function toBuyArgs(p: BundleBuyParams) {
  return {
    token: p.token,
    phone: p.phone,
    idempotencyKey: p.idempotencyKey,
    channel: "api" as const,
    ...(p.expectedPay !== undefined ? { expectedPay: p.expectedPay } : {}),
  }
}

export async function realBundleBuy(p: BundleBuyParams): Promise<BuyResult> {
  const { deps } = getBundlesRuntime()
  return buyBundle(deps, p.userId, toBuyArgs(p))
}

/**
 * The signed catalogue priced for the key owner (api channel). Mirrors v1 GET /api/v1/bundles: the admin API switch off
 * (or unreadable) => closed; the engine's own 403 (bundles/network switch off) => closed; any other failure => unavailable.
 */
export async function realBundleCatalog(userId: string, network: BundleNetwork): Promise<BundleCatalogResult> {
  const { deps } = getBundlesRuntime()
  const surface = await readApiSurface(() => deps.getCashbackConfig())
  if (!surface.open) return { kind: "closed" }
  const result = await getCatalog(deps, network)
  if (!result.ok) return result.status === 403 ? { kind: "closed" } : { kind: "unavailable" }
  let buyer: "customer" | "dealer" = "customer"
  try {
    buyer = await deps.getBuyerTier(userId)
  } catch {
    // standard price
  }
  const categories = priceCatalog(
    network,
    result.categories.map((c) => ({
      name: c.name,
      bundles: c.bundles.map((b) => ({ token: b.token, display: b.display, amount: b.amount })),
    })),
    surface.cfg,
    buyer
  )
  return { kind: "ok", categories }
}

/**
 * URGENT admin alert through the same notifier the bundles runtime uses for its own
 * alerts (email fallback kept). Never throws.
 */
export async function realBundleAlert(message: string): Promise<void> {
  try {
    const { notifyAdmins } = await import("@/lib/sms-service")
    await notifyAdmins(message, "bills_review", undefined, false)
  } catch {
    // alerting must never break the flow
  }
}

export function realBundleDeps(): BundlesV2Deps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId, orderRef) => markClaimUnknown(client, claimId, userId, orderRef),
    alert: realBundleAlert,
    getClaim: (userId, reference) => getClaimByReference(client, userId, "bundle", reference),
    // Done claims only, filtered in the query: the limit must count orders, not claims still running.
    listClaims: (userId, limit) => listClaims(client, userId, "bundle", limit, { status: "done" }),
    surfaceOpen: async () => {
      try {
        const { deps } = getBundlesRuntime()
        return await surfaceOpenFrom(() => deps.getCashbackConfig())
      } catch {
        return false
      }
    },
    phoneGate: (userId) => realAirtimePhoneGate(client, userId),
    loadCatalog: realBundleCatalog,
    buy: realBundleBuy,
    getOrderByCode: (userId, code) => fetchBundleOrderByCode(client, userId, code),
    getOrdersByCodes: (userId, codes) => fetchBundleOrdersByCodes(client, userId, codes),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as BundleSandboxOrder | null),
      listOrders: async (userId, action, limit) =>
        ((await (await import("@/lib/sandbox")).listSandboxOrders(userId, action, limit)) as BundleSandboxOrder[] | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
    },
    now: () => Date.now(),
  }
}
