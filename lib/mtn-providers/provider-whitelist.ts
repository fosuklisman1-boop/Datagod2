/**
 * MTN number whitelist verification for Xpress and Codecraft.
 * Both providers check whether a number is enabled for data delivery
 * before placing an order. Blocked numbers are auto-submitted to MTN
 * by the provider and typically become available within 24 hours.
 *
 * All functions fail-open — a network/API error never blocks an order.
 */

const XPRESS_BASE = "https://labppmcqsdeuollwcgwu.supabase.co/functions/v1/agent-api"
const CODECRAFT_BASE = process.env.CODECRAFT_API_URL ?? "https://api.codecraftnetwork.com/api"

export type WhitelistResult = {
  allowed: boolean
  provider: string
  reason?: string
}

// ── Single-number checks ──────────────────────────────────────────────────────

export async function checkXpressWhitelist(msisdn: string): Promise<WhitelistResult> {
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

export async function checkCodecraftWhitelist(msisdn: string): Promise<WhitelistResult> {
  try {
    const res = await fetch(`${CODECRAFT_BASE}/verify-phone.php`, {
      method: "POST",
      headers: { "x-api-key": process.env.CODECRAFT_API_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: msisdn }),
    })
    if (!res.ok) return { allowed: true, provider: "codecraft" }
    const data = await res.json()
    return {
      allowed: data.data?.verified === true,
      provider: "codecraft",
      reason: data.data?.message,
    }
  } catch {
    return { allowed: true, provider: "codecraft" }
  }
}

// ── Batch checks ──────────────────────────────────────────────────────────────

export async function checkXpressWhitelistBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  // Xpress: up to 1000 per request
  for (let i = 0; i < msisdns.length; i += 1000) {
    const chunk = msisdns.slice(i, i + 1000)
    try {
      const res = await fetch(`${XPRESS_BASE}/mtn-whitelist/verify`, {
        method: "POST",
        headers: { "X-API-Key": process.env.XPRESS_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ msisdns: chunk }),
      })
      if (!res.ok) {
        chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
        continue
      }
      const data = await res.json()
      results.push(...(data.results ?? chunk.map((m: string) => ({ msisdn: m, allowed: true }))))
    } catch {
      chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
    }
  }
  return results
}

export async function checkCodecraftWhitelistBatch(
  msisdns: string[]
): Promise<Array<{ msisdn: string; allowed: boolean; reason?: string }>> {
  const results: Array<{ msisdn: string; allowed: boolean; reason?: string }> = []
  // Codecraft: up to 100 per request
  for (let i = 0; i < msisdns.length; i += 100) {
    const chunk = msisdns.slice(i, i + 100)
    try {
      const res = await fetch(`${CODECRAFT_BASE}/verify-phone.php`, {
        method: "POST",
        headers: { "x-api-key": process.env.CODECRAFT_API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ phone_numbers: chunk }),
      })
      if (!res.ok) {
        chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
        continue
      }
      const data = await res.json()
      const batchResults: Array<{ msisdn: string; allowed: boolean; reason?: string }> =
        (data.data?.results ?? []).map((r: { phone_number: string; verified: boolean; message?: string }) => ({
          msisdn: r.phone_number,
          allowed: r.verified === true,
          reason: r.message,
        }))
      results.push(...batchResults)
    } catch {
      chunk.forEach(m => results.push({ msisdn: m, allowed: true }))
    }
  }
  return results
}

// ── Fallback logic ────────────────────────────────────────────────────────────

const WHITELIST_PROVIDERS = new Set(["xpress", "codecraft"])

/**
 * Check the primary provider's whitelist. If blocked, try the other provider
 * as a fallback (so the order can fulfil via that provider instead).
 * Returns { allowed, provider } — provider is which one allowed it (or null if
 * both blocked), and is used by the caller to switch fulfillment provider.
 */
export async function checkWhitelistWithFallback(
  msisdn: string,
  primaryProvider: string
): Promise<{ allowed: boolean; provider: string | null }> {
  if (!WHITELIST_PROVIDERS.has(primaryProvider)) {
    return { allowed: true, provider: primaryProvider }
  }

  const primary = primaryProvider === "xpress"
    ? await checkXpressWhitelist(msisdn)
    : await checkCodecraftWhitelist(msisdn)

  if (primary.allowed) return { allowed: true, provider: primaryProvider }

  // Primary blocked — try the other provider as fallback
  const fallbackName = primaryProvider === "xpress" ? "codecraft" : "xpress"
  const fallbackKey = fallbackName === "xpress" ? process.env.XPRESS_KEY : process.env.CODECRAFT_API_KEY
  if (!fallbackKey) return { allowed: false, provider: null }

  const fallback = fallbackName === "xpress"
    ? await checkXpressWhitelist(msisdn)
    : await checkCodecraftWhitelist(msisdn)

  if (fallback.allowed) return { allowed: true, provider: fallbackName }
  return { allowed: false, provider: null }
}

export function isWhitelistProvider(providerName: string): boolean {
  return WHITELIST_PROVIDERS.has(providerName)
}
