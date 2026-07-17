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

// ── Registry ──────────────────────────────────────────────────────────────────
// Add new whitelist-capable providers here. Order matters: providers listed
// earlier are tried first when the active provider doesn't support whitelist.

type WhitelistEntry = {
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
  const configured = WHITELIST_REGISTRY.filter(p => p.configured())
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
