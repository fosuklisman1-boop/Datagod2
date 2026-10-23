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
import type { WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import type { SupabaseClient } from "@supabase/supabase-js"

type VerifySettings = { enabled: boolean; providers: string[] }

export interface MtnVerifyIo {
  settings(): Promise<VerifySettings>
  registry: WhitelistEntry[]
  /** The shared guard (checkCustomerFacingVerification); receives the WRAPPED registry. */
  check(phones: string[], registry: WhitelistEntry[], settings: VerifySettings): Promise<Array<{ phone: string; verified: boolean }>>
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
 * only a POSITIVE negative yields false (blocked).
 *
 * Outage detection without editing the shared guard: the guard reports
 * verified:false when every provider's checkBatch THREW (it treats a throw
 * as "no approval"). Each registry entry is wrapped to count answers; the
 * guard sends every still-unverified number to every provider in turn, so a
 * verified:false is only trusted when at least one provider ANSWERED.
 * Otherwise the number is unchecked (null).
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
    let answered = 0
    const wrapped: WhitelistEntry[] = io.registry.map((p) => ({
      ...p,
      checkBatch: async (msisdns: string[]) => {
        const r = await p.checkBatch(msisdns)
        answered++
        return r
      },
    }))
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), io.timeoutMs)
    })
    const results = await Promise.race([io.check(locals, wrapped, settings), timeout])
    const out = unchecked()
    for (const r of results) {
      if (!out.has(r.phone)) continue
      if (r.verified === true) out.set(r.phone, true)
      else if (answered > 0) out.set(r.phone, false)
      // else: every provider threw -> outage -> stays null (unchecked)
    }
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
      check: (phones, registry, s) => cv.checkCustomerFacingVerification(phones, registry, s),
      // v1 bounds the single check at 5 s; a bulk batch gets 10 s, which keeps
      // the bulk request well inside its 35 s placement deadline.
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
    // Same guard and arguments as app/api/orders/purchase and v1 bundles/airtime
    // (default failClosed: true). A throw is turned into a block by the handler.
    phoneGate: async (userId) => {
      const { checkPhoneVerified } = await import("@/lib/phone-verify-guard")
      const r = await checkPhoneVerified(client as unknown as SupabaseClient, userId)
      return { allowed: r.allowed === true }
    },
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
