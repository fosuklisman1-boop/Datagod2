/**
 * Admin "Check all providers": asks EVERY configured whitelist provider (not just the checkout list)
 * about a set of numbers. Read-only and nothing is persisted. An approval from a provider outside the
 * checkout list is information for the admin only (allowedOutsideCheckout); only allowedByCheckout may
 * ever move a row to allowed. Logs carry counts only.
 */

import { WHITELIST_REGISTRY, type WhitelistEntry } from "@/lib/mtn-providers/provider-whitelist"
import { getCustomerVerificationSettings } from "@/lib/mtn-providers/customer-verification"
import { normalizeGhanaPhone } from "@/lib/phone-format"

export type Cell = "allowed" | "refused" | "error"

export type AllProvidersRow = {
  phone: string
  results: Record<string, Cell>
  allowedByCheckout: boolean
  allowedOutsideCheckout: string[]
}

export type AllProvidersResult = {
  providers: string[]
  checkoutProviders: string[]
  rows: AllProvidersRow[]
}

export type AllProvidersDeps = {
  registry: WhitelistEntry[]
  getSettings: () => Promise<{ providers: string[] }>
  /** Per-provider bound. Default 45 s so the whole call stays under ~60 s. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 45_000

async function askProvider(entry: WhitelistEntry, phones: string[], timeoutMs: number): Promise<Map<string, Cell> | null> {
  const normalised = phones.map((p) => normalizeGhanaPhone(p) ?? p)
  const call = entry.checkBatchStrict ?? entry.checkBatch
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const answer = await Promise.race([
      call(normalised),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs)
      }),
    ])
    if (!Array.isArray(answer)) return null
    const map = new Map<string, Cell>()
    for (const r of answer) {
      const key = typeof r?.msisdn === "string" ? normalizeGhanaPhone(r.msisdn) ?? r.msisdn : null
      if (key) map.set(key, r.allowed === true ? "allowed" : "refused")
    }
    return map
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function checkAllProviders(
  phones: string[],
  deps?: Partial<AllProvidersDeps>
): Promise<AllProvidersResult> {
  const registry = deps?.registry ?? WHITELIST_REGISTRY
  const getSettings = deps?.getSettings ?? getCustomerVerificationSettings
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const configured = registry.filter((p) => p.configured())
  const providers = configured.map((p) => p.name)
  const settings = await getSettings().catch(() => ({ providers: [] as string[] }))
  const checkoutProviders = (settings.providers ?? []).filter((n) => providers.includes(n))

  const answers = await Promise.all(configured.map((e) => askProvider(e, phones, timeoutMs)))

  const rows: AllProvidersRow[] = phones.map((phone) => {
    const key = normalizeGhanaPhone(phone) ?? phone
    const results: Record<string, Cell> = {}
    configured.forEach((e, i) => {
      results[e.name] = answers[i]?.get(key) ?? "error"
    })
    return {
      phone,
      results,
      allowedByCheckout: checkoutProviders.some((n) => results[n] === "allowed"),
      allowedOutsideCheckout: providers.filter((n) => results[n] === "allowed" && !checkoutProviders.includes(n)),
    }
  })

  console.log(`[BLOCKED-ADMIN] check-all providers=${providers.length} phones=${phones.length} failedProviders=${answers.filter((a) => !a).length}`)
  return { providers, checkoutProviders, rows }
}
