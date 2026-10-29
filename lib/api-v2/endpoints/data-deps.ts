/**
 * Real DataDeps wiring for the v2 data routes. Heavy modules (provider
 * whitelist, sandbox, prefix config) are imported lazily so unit tests of
 * the pure handlers never load them.
 */
import { getAdminClient } from "../store"
import {
  getOrderByReference,
  getOrdersByReferences,
  getWalletBalance,
  listAvailablePackages,
  placeV2Order,
  type RpcClient,
} from "../order-store"
// Static: after() must be registered synchronously while the request scope is
// still live (a dynamic import resolves later, possibly after the response).
import { after } from "next/server"
import { BULK_DISPATCH_CONCURRENCY, scheduleFulfillment, scheduleFulfillmentBatch } from "../fulfillment"
import type { DataDeps, SandboxOrderLike } from "./data"
import type { SupabaseClient } from "@supabase/supabase-js"

export {
  resolveVerdicts as resolveMtnVerdicts,
  type VerdictIo as MtnVerifyIo,
} from "@/lib/mtn-providers/customer-verification"

/** Error class name only: provider errors can carry phone numbers. */
function errName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "UnknownError"
}

async function realVerifyMtn(locals: string[]): Promise<Map<string, boolean | null>> {
  try {
    const cv = await import("@/lib/mtn-providers/customer-verification")
    const { WHITELIST_REGISTRY } = await import("@/lib/mtn-providers/provider-whitelist")
    // Settings read once and handed to the guard so both see the same snapshot.
    const settings = await cv.getCustomerVerificationSettings()
    return await cv.resolveVerdicts(locals, {
      settings: async () => settings,
      registry: WHITELIST_REGISTRY,
      check: (phones, registry, s) => cv.checkCustomerFacingVerification(phones, registry, s),
      // v1 bounds the single check at 5 s; a bulk batch gets 10 s, which keeps
      // the bulk request well inside its BULK_DEADLINE_MS placement deadline.
      timeoutMs: locals.length > 1 ? 10_000 : 5_000,
    })
  } catch (err) {
    console.error("[API v2] MTN verification unavailable (failing open):", errName(err))
    return new Map(locals.map((l) => [l, null]))
  }
}

/**
 * Account phone gate: the same guard and arguments as app/api/orders/purchase
 * and v1 bundles/airtime (default failClosed: true). Only allowed === true
 * passes; a throw is a block (the handler also fails closed). Never throws.
 */
export async function realPhoneGate(client: unknown, userId: string): Promise<{ allowed: boolean }> {
  try {
    const { checkPhoneVerified } = await import("@/lib/phone-verify-guard")
    const r = await checkPhoneVerified(client as SupabaseClient, userId)
    return { allowed: r?.allowed === true }
  } catch (err) {
    console.error("[API v2] phone gate check failed (blocking):", errName(err))
    return { allowed: false }
  }
}

export function realDataDeps(): DataDeps {
  const client = getAdminClient() as RpcClient
  return {
    store: {
      listAvailablePackages: (dbNetwork) => listAvailablePackages(client, dbNetwork),
      getOrderByReference: (userId, reference) => getOrderByReference(client, userId, reference),
      getOrdersByReferences: (userId, refs) => getOrdersByReferences(client, userId, refs),
      getWalletBalance: (userId) => getWalletBalance(client, userId),
      placeV2Order: (p) => placeV2Order(client, p),
    },
    prefixConfig: async () => (await import("@/lib/network-prefix-config")).getPrefixValidationConfig(),
    verifyMtn: realVerifyMtn,
    mtnBlocking: async () => {
      const cv = await import("@/lib/mtn-providers/customer-verification")
      return cv.isBlockingOn(await cv.getCustomerVerificationSettings())
    },
    phoneGate: (userId) => realPhoneGate(client, userId),
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as SandboxOrderLike | null),
      getOrders: async (userId, refs) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrdersByReferences(userId, refs)) as Map<
          string,
          SandboxOrderLike
        > | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
      balance: async (userId) => (await import("@/lib/sandbox")).getSandboxBalance(userId),
    },
    schedule: (o) => scheduleFulfillment(o, after),
    scheduleBatch: (targets) => scheduleFulfillmentBatch(targets, { concurrency: BULK_DISPATCH_CONCURRENCY }, after),
    now: () => new Date(),
  }
}

/** The {reference} segment of /api/v2/orders/{reference}; "" when undecodable. */
export function referenceFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean)
  const last = parts[parts.length - 1] ?? ""
  try {
    return decodeURIComponent(last)
  } catch {
    return ""
  }
}

/** JSON body or undefined (the handlers turn undefined into a 400). */
export async function readJsonBody(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}
