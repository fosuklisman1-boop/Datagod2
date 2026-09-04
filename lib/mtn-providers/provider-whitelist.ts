/**
 * MTN number whitelist verification — registry-based approach.
 *
 * To add a new provider with whitelist support:
 *   1. Implement check() and checkBatch() for it below
 *   2. Add an entry to WHITELIST_REGISTRY
 *   3. Set the provider's API key env var; configured() will auto-enable it
 *
 * All checks fail-open — a network/API error never blocks an order.
 */

const XPRESS_BASE = "https://labppmcqsdeuollwcgwu.supabase.co/functions/v1/agent-api"
const CODECRAFT_BASE = process.env.CODECRAFT_API_URL ?? "https://api.codecraftnetwork.com/api"

export type WhitelistResult = {
  allowed: boolean
  provider: string
  reason?: string
}

// ── Per-provider implementations ──────────────────────────────────────────────

async function checkXpress(msisdn: string): Promise<WhitelistResult> {
  try {
    const res = await fetch(
      `${XPRESS_BASE}/mtn-whitelist/verify?msisdn=${encodeURIComponent(msisdn)}`,
      { headers: { "X-API-Key": process.env.XPRESS_KEY! } }
    )
    if (!res.ok) return { allowed: true, provider: "xpress" }
    const data = await res.json()
    const r = data.results?.[0]
    return { allowed: r?.allowed !== false, provider: "xpress", reason: r?.reason }
  } catch {
    return { allowed: true, provider: "xpress" }
  }
}

async function checkXpressBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  for (let i = 0; i < msisdns.length; i += 1000) {
    const chunk = msisdns.slice(i, i + 1000)
    try {
      const res = await fetch(`${XPRESS_BASE}/mtn-whitelist/verify`, {
        method: "POST",
        headers: { "X-API-Key": process.env.XPRESS_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ msisdns: chunk }),
      })
      if (!res.ok) { chunk.forEach(m => results.push({ msisdn: m, allowed: true })); continue }
      const data = await res.json()
      results.push(...(data.results ?? chunk.map((m: string) => ({ msisdn: m, allowed: true }))))
    } catch {
      chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
    }
  }
  return results
}

async function checkCodecraft(msisdn: string): Promise<WhitelistResult> {
  try {
    const res = await fetch(`${CODECRAFT_BASE}/verify-phone.php`, {
      method: "POST",
      headers: { "x-api-key": process.env.CODECRAFT_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: msisdn }),
    })
    if (!res.ok) return { allowed: true, provider: "codecraft" }
    const data = await res.json()
    return { allowed: data.data?.verified === true, provider: "codecraft", reason: data.data?.message }
  } catch {
    return { allowed: true, provider: "codecraft" }
  }
}

async function checkCodecraftBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  for (let i = 0; i < msisdns.length; i += 100) {
    const chunk = msisdns.slice(i, i + 100)
    try {
      const res = await fetch(`${CODECRAFT_BASE}/verify-phone.php`, {
        method: "POST",
        headers: { "x-api-key": process.env.CODECRAFT_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ phone_numbers: chunk }),
      })
      if (!res.ok) { chunk.forEach(m => results.push({ msisdn: m, allowed: true })); continue }
      const data = await res.json()
      results.push(...(data.data?.results ?? []).map((r: { phone_number: string; verified: boolean; message?: string }) => ({
        msisdn: r.phone_number,
        allowed: r.verified === true,
        reason: r.message,
      })))
    } catch {
      chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
    }
  }
  return results
}

async function checkAgentPortalGH(msisdn: string): Promise<WhitelistResult> {
  try {
    const { AgentPortalGHProvider } = await import("./agentportalgh-provider")
    const data = await new AgentPortalGHProvider().verifyWhitelist([msisdn])
    const r = (data.data ?? data.results ?? [])[0]
    return { allowed: r?.allowed !== false, provider: "agentportalgh", reason: r?.reason }
  } catch {
    return { allowed: true, provider: "agentportalgh" }
  }
}

async function checkAgentPortalGHBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  const { AgentPortalGHProvider } = await import("./agentportalgh-provider")
  const provider = new AgentPortalGHProvider()
  for (let i = 0; i < msisdns.length; i += 1000) {
    const chunk = msisdns.slice(i, i + 1000)
    try {
      const data = await provider.verifyWhitelist(chunk)
      // Confirmed response shape (AgentPortalGH docs §5):
      // { network, results: [{ input, normalized, allowed }], allowed_count, total }
      const raw: any[] = data.results ?? data.data ?? []
      if (raw.length > 0) {
        results.push(...raw.map((r: any) => ({
          msisdn: r.normalized ?? r.input ?? r.msisdn,
          allowed: r.allowed === true,
          reason: r.reason,
        })))
      } else {
        chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
      }
    } catch {
      chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
    }
  }
  return results
}

async function checkApexPrime(msisdn: string): Promise<WhitelistResult> {
  try {
    const { ApexPrimeProvider } = await import("./apexprime-provider")
    const data = await new ApexPrimeProvider().verifyNumber(msisdn, "MTN")
    return { allowed: data?.is_valid === true, provider: "apexprime", reason: data?.message }
  } catch {
    return { allowed: true, provider: "apexprime" }
  }
}

async function checkApexPrimeBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  // No native batch endpoint on Apex Prime's side — verify sequentially.
  // Their docs describe verify-number as instant, so this is acceptable for
  // the bulk-verify tool's expected volumes.
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  const { ApexPrimeProvider } = await import("./apexprime-provider")
  const provider = new ApexPrimeProvider()
  for (const msisdn of msisdns) {
    try {
      const data = await provider.verifyNumber(msisdn, "MTN")
      results.push({ msisdn, allowed: data?.is_valid === true, reason: data?.message })
    } catch {
      results.push({ msisdn, allowed: true })
    }
  }
  return results
}

// ── Registry ──────────────────────────────────────────────────────────────────
// Add new whitelist-capable providers here. Order matters: providers listed
// earlier are tried first when the active provider doesn't support whitelist.

export type WhitelistEntry = {
  name: string
  configured: () => boolean
  check: (msisdn: string) => Promise<WhitelistResult>
  checkBatch: (msisdns: string[]) => Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>>
}

export const WHITELIST_REGISTRY: WhitelistEntry[] = [
  {
    name: "xpress",
    configured: () => !!process.env.XPRESS_KEY,
    check: checkXpress,
    checkBatch: checkXpressBatch,
  },
  {
    name: "codecraft",
    configured: () => !!process.env.CODECRAFT_API_KEY,
    check: checkCodecraft,
    checkBatch: checkCodecraftBatch,
  },
  {
    name: "agentportalgh",
    configured: () => !!process.env.AGENTPORTALGH_API_KEY,
    check: checkAgentPortalGH,
    checkBatch: checkAgentPortalGHBatch,
  },
  {
    name: "apexprime",
    configured: () => !!process.env.APEXPRIME_API_KEY,
    check: checkApexPrime,
    checkBatch: checkApexPrimeBatch,
  },
  // Add future whitelist providers here ↓
]

// ── Order-level check ─────────────────────────────────────────────────────────

/**
 * Check whether a number is allowed by any whitelist-capable provider.
 *
 * Always runs if ANY whitelist provider is configured — regardless of which
 * provider is currently selected for fulfillment. The active provider is
 * tried first (if it supports whitelist), then the rest in registry order.
 *
 * Returns { allowed, provider } where provider is the name of the one that
 * approved the number (so the caller can switch fulfillment to that provider),
 * or null if all providers blocked it.
 *
 * Fails open: if no whitelist providers are configured, returns allowed=true.
 */
export async function checkWhitelistForOrder(
  msisdn: string,
  activeProvider: string
): Promise<{ allowed: boolean; provider: string | null }> {
  const { getDisabledProviders } = await import("./factory")
  const disabled = await getDisabledProviders()
  // Exclude providers deactivated for fulfillment — this check exists to pick a
  // provider to fulfill the order via, so a provider that would never be used
  // for fulfillment must never be proposed here.
  const configured = WHITELIST_REGISTRY.filter(p => p.configured() && !disabled.has(p.name as any))
  if (configured.length === 0) return { allowed: true, provider: null }

  // Put the active provider first (if it supports whitelist), then the rest
  const ordered = [
    ...configured.filter(p => p.name === activeProvider),
    ...configured.filter(p => p.name !== activeProvider),
  ]

  for (const entry of ordered) {
    const result = await entry.check(msisdn)
    if (result.allowed) return { allowed: true, provider: entry.name }
  }

  return { allowed: false, provider: null }
}

/**
 * True if ANY configured provider in the registry supports whitelist.
 * Use this to decide whether to run the check at all.
 */
export function hasWhitelistProviders(): boolean {
  return WHITELIST_REGISTRY.some(p => p.configured())
}

/**
 * Check a batch of numbers against every configured whitelist provider,
 * stopping at the first provider that allows each number (mirrors
 * checkWhitelistForOrder's precedence, batched for bulk use).
 *
 * Unlike checkWhitelistForOrder, this does NOT filter out fulfillment-disabled
 * providers — it answers "is this number allowed by ANY whitelist-capable
 * provider we have credentials for," independent of which provider
 * fulfillment currently prefers.
 *
 * Callers must ensure at least one provider is configured first (see
 * hasWhitelistProviders()) — with none configured this returns every number
 * as not allowed rather than failing open, since bulk reporting must never
 * claim a check happened when it didn't.
 */
export async function checkWhitelistBatch(
  msisdns: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): Promise<Map<string, { allowed: boolean; allowedBy?: string }>> {
  const result = new Map<string, { allowed: boolean; allowedBy?: string }>()
  msisdns.forEach(m => result.set(m, { allowed: false }))

  const configured = registry.filter(p => p.configured())
  for (const entry of configured) {
    const toCheck = msisdns.filter(m => !result.get(m)!.allowed)
    if (toCheck.length === 0) break
    const batchResults = await entry.checkBatch(toCheck)
    for (const r of batchResults) {
      if (r.allowed) result.set(r.msisdn, { allowed: true, allowedBy: entry.name })
    }
  }

  return result
}

// ── Batch helpers (used by retry cron + admin endpoint) ───────────────────────

export async function checkXpressWhitelist(msisdn: string): Promise<WhitelistResult> {
  return checkXpress(msisdn)
}

export async function checkCodecraftWhitelist(msisdn: string): Promise<WhitelistResult> {
  return checkCodecraft(msisdn)
}

export async function checkXpressWhitelistBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  return checkXpressBatch(msisdns)
}

export async function checkCodecraftWhitelistBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  return checkCodecraftBatch(msisdns)
}

/** @deprecated Use checkWhitelistForOrder instead */
export async function checkWhitelistWithFallback(
  msisdn: string,
  primaryProvider: string
): Promise<{ allowed: boolean; provider: string | null }> {
  return checkWhitelistForOrder(msisdn, primaryProvider)
}

export function isWhitelistProvider(providerName: string): boolean {
  return WHITELIST_REGISTRY.some(p => p.name === providerName && p.configured())
}

// ── Provider selection (bulk admin tools) ──────────────────────────────────────

/**
 * Per-provider configuration snapshot — used by the phone-verification
 * upload UI to show which providers a bulk whitelist check can use.
 */
export function listWhitelistProviders(
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): Array<{ name: string; configured: boolean }> {
  return registry.map(p => ({ name: p.name, configured: p.configured() }))
}

/**
 * Validates an admin-chosen subset of provider names for a bulk whitelist
 * run: every name must be a real registry entry AND currently configured.
 * Returns the validated names deduped and normalized to registry order, or
 * an error message naming exactly what's wrong.
 */
export function validateProviderSelection(
  names: string[],
  registry: WhitelistEntry[] = WHITELIST_REGISTRY
): { valid: true; providers: string[] } | { valid: false; error: string } {
  if (names.length === 0) return { valid: false, error: "At least one provider must be selected" }
  const unknown = names.filter(n => !registry.some(p => p.name === n))
  if (unknown.length > 0) return { valid: false, error: `Unknown provider(s): ${unknown.join(", ")}` }
  const configuredNames = new Set(registry.filter(p => p.configured()).map(p => p.name))
  const unconfigured = names.filter(n => !configuredNames.has(n))
  if (unconfigured.length > 0) return { valid: false, error: `Provider(s) not configured: ${unconfigured.join(", ")}` }
  const selected = new Set(names)
  return { valid: true, providers: registry.filter(p => selected.has(p.name)).map(p => p.name) }
}

/** Union of two provider-name lists, deduped, order-preserving on first occurrence. */
export function unionProviders(existing: string[], added: string[]): string[] {
  return Array.from(new Set([...existing, ...added]))
}
