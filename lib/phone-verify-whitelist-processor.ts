import type { SupabaseClient } from "@supabase/supabase-js"
import { checkWhitelistBatch, hasWhitelistProviders } from "@/lib/mtn-providers/provider-whitelist"

// CodeCraft's own batch endpoint caps at 100 numbers per call — the binding
// constraint among the three whitelist-capable providers (Xpress allows up to
// 1000; AgentPortalGH is effectively unbounded). checkWhitelistBatch chunks
// internally per-provider regardless, but capping how many "pending" rows we
// pull per tick keeps a single processing tick bounded.
const CHUNK_SIZE = 100

export interface WhitelistChunkResult {
  processed: number
  remaining: number
  verified: number
  invalid: number
  rateLimited: number
  status: "completed" | "in_progress"
}

export interface WhitelistRegistryUpsert {
  phone: string
  whitelist_status: "allowed" | "blocked"
  whitelist_allowed_by: string | null
  whitelist_last_checked: string
  whitelist_retry_count: number
}

export interface WhitelistDecision {
  notApplicableIds: number[]
  verifiedByProvider: Map<string, number[]>
  invalidIds: number[]
  registryUpserts: WhitelistRegistryUpsert[]
}

/**
 * Pure decision logic: given a chunk of pending rows and each MTN number's
 * whitelist result, decides the new status bucket for every row and the
 * mtn_number_registry upsert payload. Non-MTN rows always become
 * not_applicable without needing a whitelist result. An MTN row missing from
 * whitelistResults (shouldn't normally happen — checkWhitelistBatch always
 * returns an entry for every input) defaults to blocked, matching
 * checkWhitelistBatch's own "unconfigured/no answer = not allowed" stance.
 */
export function decideWhitelistOutcomes(
  pending: Array<{ id: number; phone_number: string; network: string }>,
  whitelistResults: Map<string, { allowed: boolean; allowedBy?: string }>,
  now: string
): WhitelistDecision {
  const notApplicableIds: number[] = []
  const verifiedByProvider = new Map<string, number[]>()
  const invalidIds: number[] = []
  const registryUpserts: WhitelistRegistryUpsert[] = []

  for (const row of pending) {
    if (row.network !== "MTN") {
      notApplicableIds.push(row.id)
      continue
    }
    const result = whitelistResults.get(row.phone_number)
    const allowed = result?.allowed === true
    if (allowed) {
      const provider = result?.allowedBy ?? "unknown"
      if (!verifiedByProvider.has(provider)) verifiedByProvider.set(provider, [])
      verifiedByProvider.get(provider)!.push(row.id)
    } else {
      invalidIds.push(row.id)
    }
    registryUpserts.push({
      phone: row.phone_number,
      whitelist_status: allowed ? "allowed" : "blocked",
      whitelist_allowed_by: allowed ? (result?.allowedBy ?? null) : null,
      whitelist_last_checked: now,
      whitelist_retry_count: 0,
    })
  }

  return { notApplicableIds, verifiedByProvider, invalidIds, registryUpserts }
}

export async function processWhitelistChunk(
  supabase: SupabaseClient,
  sessionId: string
): Promise<WhitelistChunkResult> {
  const { data: session, error: sessionErr } = await supabase
    .from("phone_verification_sessions")
    .select("id, status, verified_count, invalid_count")
    .eq("id", sessionId)
    .single()

  if (sessionErr || !session) throw new Error("Session not found")

  if (session.status === "completed") {
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, rateLimited: 0, status: "completed" }
  }

  const { data: pending, error: fetchError } = await supabase
    .from("phone_verification_results")
    .select("id, phone_number, network")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .limit(CHUNK_SIZE)

  if (fetchError) throw fetchError

  const now = new Date().toISOString()

  if (!pending || pending.length === 0) {
    await supabase.from("phone_verification_sessions").update({ status: "completed", completed_at: now }).eq("id", sessionId)
    return { processed: 0, remaining: 0, verified: session.verified_count, invalid: session.invalid_count, rateLimited: 0, status: "completed" }
  }

  const mtnPhones = pending.filter(r => r.network === "MTN").map(r => r.phone_number)
  if (mtnPhones.length > 0 && !hasWhitelistProviders()) {
    // Should be unreachable: the upload route already refuses to start an
    // mtn_whitelist session when no provider is configured.
    throw new Error("No MTN whitelist provider is configured")
  }
  const whitelistResults = mtnPhones.length > 0
    ? await checkWhitelistBatch(mtnPhones)
    : new Map<string, { allowed: boolean; allowedBy?: string }>()

  const decision = decideWhitelistOutcomes(pending, whitelistResults, now)

  if (decision.notApplicableIds.length > 0) {
    await supabase.from("phone_verification_results")
      .update({ status: "not_applicable", verified_at: now })
      .in("id", decision.notApplicableIds)
  }
  for (const [provider, ids] of decision.verifiedByProvider) {
    await supabase.from("phone_verification_results")
      .update({ status: "verified", whitelist_provider: provider, verified_at: now })
      .in("id", ids)
  }
  if (decision.invalidIds.length > 0) {
    await supabase.from("phone_verification_results")
      .update({ status: "invalid", whitelist_provider: null, verified_at: now })
      .in("id", decision.invalidIds)
  }
  for (let i = 0; i < decision.registryUpserts.length; i += 500) {
    const { error: upsertError } = await supabase
      .from("mtn_number_registry")
      .upsert(decision.registryUpserts.slice(i, i + 500), { onConflict: "phone" })
    if (upsertError) console.error("[PHONE-VERIFY-WHITELIST] registry upsert failed:", upsertError.message)
  }

  const [{ count: verifiedCount }, { count: invalidCount }, { count: notApplicableCount }, { count: remaining }] =
    await Promise.all([
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "verified"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "invalid"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "not_applicable"),
      supabase.from("phone_verification_results").select("id", { count: "exact", head: true }).eq("session_id", sessionId).eq("status", "pending"),
    ])

  const newVerified = verifiedCount ?? 0
  const newInvalid = invalidCount ?? 0
  const newNotApplicable = notApplicableCount ?? 0
  const isDone = (remaining ?? 0) === 0

  await supabase.from("phone_verification_sessions").update({
    verified_count: newVerified,
    invalid_count: newInvalid,
    not_applicable_count: newNotApplicable,
    ...(isDone ? { status: "completed", completed_at: now } : {}),
  }).eq("id", sessionId)

  return {
    processed: pending.length,
    remaining: remaining ?? 0,
    verified: newVerified,
    invalid: newInvalid,
    rateLimited: 0,
    status: isDone ? "completed" : "in_progress",
  }
}
