import type { SupabaseClient } from "@supabase/supabase-js"

export const WHITELIST_FRESHNESS_MS = 24 * 60 * 60 * 1000

/**
 * Numbers already seen in a PRIOR Moolre session (from ANY session, no time
 * limit — a MoMo account name doesn't go stale), mapped to the best account
 * name previously seen for that number (null if only ever invalid/pending).
 */
export async function findExistingMoolreNumbers(
  supabase: SupabaseClient,
  candidates: string[]
): Promise<Map<string, string | null>> {
  const existing = new Map<string, string | null>()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("phone_verification_results")
        .select("phone_number, account_name")
        .in("phone_number", chunk)
        .order("id", { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`Duplicate lookup failed: ${error.message}`)
      if (!data || data.length === 0) break
      for (const row of data) {
        if (!existing.has(row.phone_number) || (row.account_name && existing.get(row.phone_number) == null)) {
          existing.set(row.phone_number, row.account_name ?? null)
        }
      }
      if (data.length < 1000) break
      from += 1000
    }
  }
  return existing
}

/**
 * True if a stored whitelist result for a number is "covered" by a run's
 * selected provider set — i.e. re-checking wouldn't ask anything genuinely
 * new. An allowed row is covered only if the allowing provider is itself
 * selected; a blocked row is covered only if every selected provider has
 * already been tried against this number (checkedProviders is a superset
 * of selectedProviders). Narrowing or changing the provider selection
 * between runs can un-cover a previously "known" result on purpose.
 */
export function isWhitelistResultCovered(
  row: { status: "allowed" | "blocked"; allowedBy: string | null; checkedProviders: string[] },
  selectedProviders: string[]
): boolean {
  if (row.status === "allowed") {
    return row.allowedBy !== null && selectedProviders.includes(row.allowedBy)
  }
  const checked = new Set(row.checkedProviders)
  return selectedProviders.every(p => checked.has(p))
}

/**
 * Numbers whose MTN whitelist status was checked within the last 24h AND
 * whose stored result is covered (see isWhitelistResultCovered) by this
 * run's selected provider set. Unlike Moolre account names, whitelist status
 * is time-varying (that's why the 24h retry cron exists) AND now also
 * selection-dependent (narrowing which providers are asked can make a
 * previously-known result no longer "known enough" to skip) — either
 * condition failing means treat the number as unchecked.
 * mtn_number_registry.phone is unique, so unlike findExistingMoolreNumbers
 * this never needs inner pagination per chunk.
 */
export async function findRecentWhitelistChecks(
  supabase: SupabaseClient,
  candidates: string[],
  selectedProviders: string[]
): Promise<Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>> {
  const result = new Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>()
  const cutoff = new Date(Date.now() - WHITELIST_FRESHNESS_MS).toISOString()
  const CHUNK = 500
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK)
    const { data, error } = await supabase
      .from("mtn_number_registry")
      .select("phone, whitelist_status, whitelist_allowed_by, whitelist_checked_providers, whitelist_last_checked")
      .in("phone", chunk)
      .gte("whitelist_last_checked", cutoff)
      .range(0, 999) // phone is unique, chunk size is well under a page
    if (error) throw new Error(`Whitelist freshness lookup failed: ${error.message}`)
    for (const row of data ?? []) {
      if (row.whitelist_status !== "allowed" && row.whitelist_status !== "blocked") continue
      const covered = isWhitelistResultCovered(
        { status: row.whitelist_status, allowedBy: row.whitelist_allowed_by, checkedProviders: row.whitelist_checked_providers ?? [] },
        selectedProviders
      )
      if (covered) {
        result.set(row.phone, { status: row.whitelist_status, allowedBy: row.whitelist_allowed_by })
      }
    }
  }
  return result
}

export interface VerificationRowInput {
  phone: string
  network: string
}

export interface VerificationRow {
  phone_number: string
  network: string
  account_name: string | null
  status: "pending" | "duplicate"
  whitelist_provider: string | null
}

/** Builds insertable phone_verification_results rows for a Moolre session. */
export function buildMoolreRows(
  phones: VerificationRowInput[],
  existing: Map<string, string | null>
): VerificationRow[] {
  return phones.map(({ phone, network }) => {
    const isDuplicate = existing.has(phone)
    return {
      phone_number: phone,
      network,
      account_name: isDuplicate ? (existing.get(phone) ?? null) : null,
      status: isDuplicate ? "duplicate" : "pending",
      whitelist_provider: null,
    }
  })
}

/**
 * Builds insertable phone_verification_results rows for an MTN-whitelist
 * session. Network filtering (MTN vs not_applicable) happens later, during
 * processing — every non-duplicate number is queued "pending" here,
 * regardless of network.
 */
export function buildWhitelistRows(
  phones: VerificationRowInput[],
  recent: Map<string, { status: "allowed" | "blocked"; allowedBy: string | null }>
): VerificationRow[] {
  return phones.map(({ phone, network }) => {
    const recentCheck = recent.get(phone)
    if (recentCheck) {
      return {
        phone_number: phone,
        network,
        account_name: null,
        status: "duplicate",
        whitelist_provider: recentCheck.allowedBy,
      }
    }
    return {
      phone_number: phone,
      network,
      account_name: null,
      status: "pending",
      whitelist_provider: null,
    }
  })
}
