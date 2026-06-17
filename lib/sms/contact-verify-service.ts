/**
 * Opt-in phone-name verification for tenant address-book contacts.
 *
 * Uses the SAME Moolre lookup the withdrawal flow uses to confirm a payee name
 * (validateAccountName -> /transact/validate), so a "verified" contact carries
 * the real registered MoMo account holder name. That lookup is SLOW (~12–25s
 * per number), so verification runs as an async drain over 'pending' contacts
 * (client-polled, with a cron backstop) — never inline on a large upload.
 *
 * Semantics (per product decision):
 *  - Fill BLANK names only: on success, populate first/last from the MoMo name
 *    ONLY when the contact has no name yet — never overwrite a typed name.
 *  - Keep & flag: a number Moolre can't confirm is marked 'invalid' (kept, not
 *    deleted) — Moolre verify has false-negatives (ported numbers, wrong-network
 *    detection). Transient failures (rate-limit/network) stay 'pending' to retry.
 *
 * Service-role only; tenant isolation enforced by constraining every query to
 * the caller's own groups.
 */

import { createClient } from "@supabase/supabase-js"
import { validateAccountName } from "@/lib/moolre-transfer"
import { detectGhanaNetwork } from "@/lib/phone-format"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Smaller than the admin batch (20): keeps one drain call inside the serverless
// budget given ~12–25s per Moolre call run concurrently.
const CHUNK = 12
const CALL_TIMEOUT_MS = 25_000

type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export interface VerifyProgress {
  total: number
  pending: number
  verified: number
  invalid: number
  unverified: number
  done: boolean // no rows left in 'pending'
}

export interface ChunkResult {
  processed: number
  verified: number
  invalid: number
  rateLimited: number
  remaining: number
}

/** Transient = retry later (don't mark invalid). Distinguishes a real "account
 *  not found" (definitive, HTTP 200 + status!=1) from a rate-limit / network /
 *  5xx blip. MUST match the exact strings validateAccountName emits on failure:
 *  "Could not reach payment provider (network error)" (fetch threw),
 *  "Unexpected response from payment provider (HTTP n)" (non-JSON), and any
 *  message suffixed "(HTTP 429|5xx)" (non-OK JSON). Missing these would
 *  permanently mislabel valid contacts 'invalid' during an outage. */
function isTransient(err?: string): boolean {
  if (!err) return false
  // NB: no bare "network" token — a definitive "Wrong network"/"Network mismatch"
  // (HTTP 200, real bad number) must classify as 'invalid', not loop forever as
  // pending. Genuine connectivity failures are covered by could-not-reach /
  // payment-provider / fetch-failed / econn / socket / unreachable.
  return /rate|limit|too many|throttl|quota|timeout|timed out|unreachable|econn|fetch failed|socket|temporarily|could not reach|payment provider|unexpected response|service (busy|unavailable)|try again|HTTP 5\d\d|HTTP 429/i.test(
    err
  )
}

/** The account's group ids (optionally just one, ownership-checked). Returns
 *  null when a specific groupId was given but isn't owned by the account. */
async function resolveGroupIds(accountId: string, groupId?: string): Promise<string[] | null> {
  if (groupId) {
    const { data } = await supabaseAdmin
      .from("sms_groups")
      .select("id")
      .eq("id", groupId)
      .eq("sms_account_id", accountId)
      .maybeSingle()
    return data ? [groupId] : null
  }
  const { data } = await supabaseAdmin
    .from("sms_groups")
    .select("id")
    .eq("sms_account_id", accountId)
  return (data ?? []).map((g: { id: string }) => g.id)
}

async function countWhere(groupIds: string[], status?: string): Promise<number> {
  if (groupIds.length === 0) return 0
  let q = supabaseAdmin
    .from("sms_contacts")
    .select("id", { count: "exact", head: true })
    .in("group_id", groupIds)
  if (status) q = q.eq("verify_status", status)
  const { count } = await q
  return count ?? 0
}

/** Verification counts across the account's groups (or one group). */
export async function getContactVerifyProgress(
  accountId: string,
  groupId?: string
): Promise<Result<VerifyProgress>> {
  const groupIds = await resolveGroupIds(accountId, groupId)
  if (groupIds === null) return { ok: false, error: "Group not found" }
  if (groupIds.length === 0) {
    return { ok: true, data: { total: 0, pending: 0, verified: 0, invalid: 0, unverified: 0, done: true } }
  }
  const [total, pending, verified, invalid] = await Promise.all([
    countWhere(groupIds),
    countWhere(groupIds, "pending"),
    countWhere(groupIds, "verified"),
    countWhere(groupIds, "invalid"),
  ])
  return {
    ok: true,
    data: {
      total,
      pending,
      verified,
      invalid,
      unverified: Math.max(0, total - pending - verified - invalid),
      done: pending === 0,
    },
  }
}

/** Mark a group's (or all the account's) contacts for (re)verification. */
export async function markContactsForVerification(
  accountId: string,
  groupId?: string
): Promise<Result<{ queued: number }>> {
  const groupIds = await resolveGroupIds(accountId, groupId)
  if (groupIds === null) return { ok: false, error: "Group not found" }
  if (groupIds.length === 0) return { ok: true, data: { queued: 0 } }

  const { data, error } = await supabaseAdmin
    .from("sms_contacts")
    .update({ verify_status: "pending", verify_claimed_at: null })
    .in("group_id", groupIds)
    .neq("verify_status", "pending")
    .select("id")
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: { queued: (data ?? []).length } }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false
    const t = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve(onTimeout)
      }
    }, ms)
    p.then((v) => {
      if (!settled) {
        settled = true
        clearTimeout(t)
        resolve(v)
      }
    }).catch(() => {
      if (!settled) {
        settled = true
        clearTimeout(t)
        resolve(onTimeout)
      }
    })
  })
}

interface PendingRow {
  id: string
  first_name: string | null
  last_name: string | null
  phone_number: string
}

/** Verify a batch of pending rows in parallel and write results back. Verified
 *  rows get verified_name + (blank-only) name fill; definitive failures become
 *  'invalid'; transient failures stay 'pending'. Shared by the account-scoped
 *  drain and the global cron drain. */
async function verifyRows(rows: PendingRow[]): Promise<{ verified: number; invalid: number; rateLimited: number }> {
  let verified = 0
  let invalid = 0
  let rateLimited = 0
  const now = new Date().toISOString()

  await Promise.all(
    rows.map(async (row) => {
      const detected = detectGhanaNetwork(row.phone_number)
      const network = detected === "UNKNOWN" ? "MTN" : detected
      const res = await withTimeout(
        validateAccountName(row.phone_number, network).catch((e) => ({
          accountName: null as string | null,
          error: e instanceof Error ? e.message : "lookup failed",
        })),
        CALL_TIMEOUT_MS,
        { accountName: null as string | null, error: "timeout" }
      )

      const name = (res.accountName ?? "").trim()
      if (name) {
        const update: Record<string, unknown> = {
          verify_status: "verified",
          verified_name: name,
          verified_at: now,
        }
        // Fill BLANK names only — never overwrite a name the tenant typed.
        if (!row.first_name && !row.last_name) {
          const parts = name.split(/\s+/)
          update.first_name = parts[0] ?? null
          update.last_name = parts.slice(1).join(" ") || null
        }
        await supabaseAdmin.from("sms_contacts").update(update).eq("id", row.id)
        verified++
      } else if (isTransient(res.error)) {
        // Transient: leave 'pending' AND release our claim so the very next poll/cron
        // tick can retry it immediately. The 90s lease then only guards a crash that
        // claimed-but-never-wrote-back (claim left set) — a deliberate leave-pending
        // shouldn't lock the row out of its own drainer for 90s.
        await supabaseAdmin.from("sms_contacts").update({ verify_claimed_at: null }).eq("id", row.id)
        rateLimited++
      } else {
        await supabaseAdmin
          .from("sms_contacts")
          .update({ verify_status: "invalid", verified_name: null, verified_at: now })
          .eq("id", row.id)
        invalid++
      }
    })
  )
  return { verified, invalid, rateLimited }
}

// Claim lease: a pending row claimed within this window won't be re-claimed by
// the other drainer. Comfortably longer than one chunk's worst-case run
// (CALL_TIMEOUT_MS), so the client poll and the cron never call Moolre on the
// same row concurrently; expired claims are reclaimable so nothing gets stuck.
const LEASE_MS = 90_000

/**
 * Atomically claim up to `limit` pending rows (scoped to groupIds, or all tenant
 * groups when groupIds is null) so concurrent drainers (client poll + cron) don't
 * both run the slow Moolre lookup on the same contact. The conditional UPDATE is
 * the lock: two drainers racing the same candidates both run `UPDATE ... WHERE
 * pending AND (claim IS NULL OR claim < stale)`, and Postgres serialises them so
 * only the first sees the rows match — the second's predicate is already false.
 */
async function claimPending(groupIds: string[] | null, limit: number): Promise<PendingRow[]> {
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const staleIso = new Date(nowMs - LEASE_MS).toISOString()
  const orClaim = `verify_claimed_at.is.null,verify_claimed_at.lt.${staleIso}`

  // 1. Candidate ids: pending + (unclaimed or stale claim).
  let sel = supabaseAdmin
    .from("sms_contacts")
    .select(groupIds ? "id" : "id, sms_groups!inner(sms_account_id)")
    .eq("verify_status", "pending")
    .or(orClaim)
    .order("created_at", { ascending: true })
    .limit(limit)
  sel = groupIds ? sel.in("group_id", groupIds) : sel.not("sms_groups.sms_account_id", "is", null)
  const { data: candidates } = await sel
  // The conditional select string defeats PostgREST's static type inference; we
  // only ever read `id`, so narrow explicitly.
  const ids = ((candidates ?? []) as unknown as { id: string }[]).map((c) => c.id)
  if (ids.length === 0) return []

  // 2. Atomically claim — only rows still pending + still unclaimed/stale return.
  const { data: claimed } = await supabaseAdmin
    .from("sms_contacts")
    .update({ verify_claimed_at: nowIso })
    .in("id", ids)
    .eq("verify_status", "pending")
    .or(orClaim)
    .select("id, first_name, last_name, phone_number")
  return (claimed ?? []) as PendingRow[]
}

/**
 * Verify up to `limit` pending contacts (within the account's groups), in
 * parallel. Call repeatedly (poll) until remaining hits 0.
 */
export async function processContactVerifyChunk(
  accountId: string,
  groupId?: string,
  limit = CHUNK
): Promise<Result<ChunkResult>> {
  const groupIds = await resolveGroupIds(accountId, groupId)
  if (groupIds === null) return { ok: false, error: "Group not found" }
  if (groupIds.length === 0) {
    return { ok: true, data: { processed: 0, verified: 0, invalid: 0, rateLimited: 0, remaining: 0 } }
  }

  const rows = await claimPending(groupIds, limit)
  if (rows.length === 0) {
    // Nothing to claim — either truly done, or everything is leased by the other
    // drainer right now. remaining tells the poller which.
    const remaining = await countWhere(groupIds, "pending")
    return { ok: true, data: { processed: 0, verified: 0, invalid: 0, rateLimited: 0, remaining } }
  }

  const { verified, invalid, rateLimited } = await verifyRows(rows)
  const remaining = await countWhere(groupIds, "pending")
  return { ok: true, data: { processed: rows.length, verified, invalid, rateLimited, remaining } }
}

/**
 * Cron backstop: drain pending contacts across ALL tenant groups (so a verify
 * job survives the tenant closing their tab mid-run). Only touches tenant rows
 * (sms_account_id IS NOT NULL) — admin-global address-book contacts are not
 * verified through this path. Returns how many it processed this tick.
 */
export async function processGlobalContactVerifyChunk(limit = CHUNK): Promise<ChunkResult> {
  const rows = await claimPending(null, limit)
  if (rows.length === 0) return { processed: 0, verified: 0, invalid: 0, rateLimited: 0, remaining: 0 }

  const { verified, invalid, rateLimited } = await verifyRows(rows)
  return { processed: rows.length, verified, invalid, rateLimited, remaining: -1 }
}
