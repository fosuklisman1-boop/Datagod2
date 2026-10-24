/**
 * Real BillsV2Deps wiring for the v2 utility bill routes. MONEY PATH.
 *
 * - engine: the shared payBill / verifyBill (lib/bills/service.ts, unchanged)
 *   over getBillsRuntime(), always channel "api".
 * - `fresh`: payBill's API retry path hands back a verify token's EARLIER
 *   order. payBillTracked wraps insertOrder (on a shallow copy of the runtime
 *   deps) to tell whether the returned order was inserted, and so debited, by
 *   this very call. Only a fresh order may complete a claim.
 * - claims: lib/api-v2/idempotency.ts bound to the service-role client.
 * - surface gate: readApiSurface (fail closed), as v1 bills.
 * - phone gate: the same checkPhoneVerified wiring as the v2 data and airtime
 *   routes (realPhoneGate: a throw is a block).
 * - order reads: only the allow-listed hubtel_bill_orders columns, always
 *   filtered by user_id.
 */
import { payBill, verifyBill, type BillOrderRow, type BillsDeps } from "@/lib/bills/service"
import type { CashbackConfig } from "@/lib/cashback/config"
import { readApiSurface } from "@/lib/api-v1/surface"
import { getAdminClient, type SupabaseLike } from "../store"
import {
  claimRequest,
  completeClaim,
  findClaimByOrderRef,
  getClaimByReference,
  markClaimUnknown,
  releaseClaim,
} from "../idempotency"
import { realPhoneGate } from "./data-deps"
import type { BillOrderV2Row, BillPayEngineParams, BillPayEngineResult, BillSandboxOrder, BillsV2Deps } from "./bills"

export const BILL_ORDER_V2_COLUMNS =
  "reference_code, biller, account_number, customer_name, amount, paid_amount, cashback_amount, status, created_at"

/** Owner-scoped single order read; null when missing or on any error. */
export async function fetchBillOrderByCode(client: SupabaseLike, userId: string, code: string): Promise<BillOrderV2Row | null> {
  try {
    const { data, error } = await client
      .from("hubtel_bill_orders")
      .select(BILL_ORDER_V2_COLUMNS)
      .eq("user_id", userId)
      .eq("reference_code", code)
      .maybeSingle()
    if (error || !data) return null
    return data as BillOrderV2Row
  } catch {
    return null
  }
}

/**
 * payBill with channel "api", reporting whether the returned order was
 * inserted by this call. The runtime deps object is never mutated.
 */
export async function payBillTracked(d: BillsDeps, p: BillPayEngineParams): Promise<BillPayEngineResult> {
  let insertedId: string | null = null
  const tracked: BillsDeps = {
    ...d,
    insertOrder: async (row) => {
      const o: BillOrderRow = await d.insertOrder(row)
      insertedId = typeof o?.id === "string" ? o.id : null
      return o
    },
  }
  const result = await payBill(tracked, p.userId, p.verifyToken, p.amount, p.expectedPay, { channel: "api" })
  const fresh = result.ok === true && insertedId !== null && result.order?.id === insertedId
  return { result, fresh }
}

/** The admin API surface switch; a read failure is closed. Never throws. */
export async function surfaceOpenFrom(getCashbackConfig: () => Promise<CashbackConfig>): Promise<boolean> {
  try {
    return (await readApiSurface(getCashbackConfig)).open === true
  } catch {
    return false
  }
}

/** Phone gate as a boolean; only allowed === true passes. Never throws. */
export async function realBillsPhoneGate(client: unknown, userId: string): Promise<boolean> {
  try {
    return (await realPhoneGate(client, userId)).allowed === true
  } catch {
    return false
  }
}

async function runtimeDeps(): Promise<BillsDeps> {
  return (await import("@/lib/bills/runtime")).getBillsRuntime().deps
}

export function realBillsDeps(): BillsV2Deps {
  const client = getAdminClient()
  return {
    claim: (p) => claimRequest(client, p),
    complete: (claimId, orderRef, response, userId) => completeClaim(client, claimId, orderRef, response, Date.now, userId),
    release: (claimId, userId) => releaseClaim(client, claimId, userId),
    markUnknown: (claimId, userId) => markClaimUnknown(client, claimId, userId),
    getClaim: (userId, reference) => getClaimByReference(client, userId, "bill", reference),
    findClaimByOrderRef: (userId, orderRef) => findClaimByOrderRef(client, userId, "bill", orderRef),
    surfaceOpen: async () => {
      try {
        const d = await runtimeDeps()
        return await surfaceOpenFrom(() => d.getCashbackConfig())
      } catch {
        return false
      }
    },
    phoneGate: (userId) => realBillsPhoneGate(client, userId),
    getBillsConfig: async () => (await runtimeDeps()).getBillsConfig(),
    verify: async (userId, biller, inputs) => verifyBill(await runtimeDeps(), userId, biller, inputs),
    pay: async (p) => payBillTracked(await runtimeDeps(), p),
    getOrderByCode: (userId, code) => fetchBillOrderByCode(client, userId, code),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as BillSandboxOrder | null),
      findByTokenRef: async (userId, tokenRef) => (await import("@/lib/sandbox")).findSandboxBillOrdersByTokenRef(userId, tokenRef),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
    },
    now: () => Date.now(),
  }
}
