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
import { scheduleFulfillment } from "../fulfillment"
import type { DataDeps, SandboxOrderLike } from "./data"

export interface MtnVerifyIo {
  settings(): Promise<{ enabled: boolean; providers: string[] }>
  registry: Array<{ name: string; configured: () => boolean }>
  check(phones: string[]): Promise<Array<{ phone: string; verified: boolean }>>
  timeoutMs: number
}

/** Error class name only: provider errors can carry phone numbers. */
function errName(err: unknown): string {
  return err instanceof Error && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "UnknownError"
}

/**
 * The MTN whitelist guard used by v2: the same customer-facing verification
 * (lib/mtn-providers/customer-verification) v1 runs on MTN API orders.
 * Contract (same as that guard): FAIL OPEN. Feature off, no configured
 * provider, an error or a timeout yields null ("unchecked") for every number;
 * only an explicit verified:false from the guard yields false (blocked).
 * Never throws; logs a fixed string with the error class name only.
 */
export async function resolveMtnVerdicts(locals: string[], io: MtnVerifyIo): Promise<Map<string, boolean | null>> {
  const unchecked = () => new Map<string, boolean | null>(locals.map((l) => [l, null]))
  if (locals.length === 0) return new Map()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settings = await io.settings()
    if (!settings.enabled || settings.providers.length === 0) return unchecked()
    if (!io.registry.some((p) => settings.providers.includes(p.name) && p.configured())) return unchecked()
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), io.timeoutMs)
    })
    const results = await Promise.race([io.check(locals), timeout])
    const out = unchecked()
    for (const r of results) if (out.has(r.phone)) out.set(r.phone, r.verified === true)
    return out
  } catch (err) {
    console.error("[API v2] MTN verification unavailable (failing open):", errName(err))
    return unchecked()
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function realVerifyMtn(locals: string[]): Promise<Map<string, boolean | null>> {
  try {
    const cv = await import("@/lib/mtn-providers/customer-verification")
    const { WHITELIST_REGISTRY } = await import("@/lib/mtn-providers/provider-whitelist")
    // Settings read once and handed to the guard so both see the same snapshot.
    const settings = await cv.getCustomerVerificationSettings()
    return await resolveMtnVerdicts(locals, {
      settings: async () => settings,
      registry: WHITELIST_REGISTRY,
      check: (phones) => cv.checkCustomerFacingVerification(phones, WHITELIST_REGISTRY, settings),
      // v1 bounds the single check at 5 s; a bulk batch gets a little longer.
      timeoutMs: locals.length > 1 ? 10_000 : 5_000,
    })
  } catch (err) {
    console.error("[API v2] MTN verification unavailable (failing open):", errName(err))
    return new Map(locals.map((l) => [l, null]))
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
    sandbox: {
      getOrder: async (userId, reference) =>
        ((await (await import("@/lib/sandbox")).getSandboxOrder(userId, reference)) as SandboxOrderLike | null),
      place: async (p) => (await import("@/lib/sandbox")).placeSandboxOrder(p),
      balance: async (userId) => (await import("@/lib/sandbox")).getSandboxBalance(userId),
    },
    schedule: (o) => scheduleFulfillment(o),
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
