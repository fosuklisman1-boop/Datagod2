/**
 * Database access for phone-number login. Every function takes a service-role
 * client first. Security-relevant reads (lookup, lockout) THROW on a DB error so
 * the flow fails closed; only recordEvent swallows errors (best-effort audit).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { LIMITS, type Account } from "./core"

export type EventKind =
  | "fail"
  | "lockout"
  | "login_ok"
  | "login_unchallenged"
  | "attempt"
  | "challenge_sent"
  | "challenge_passed"
  | "password_changed"
  | "code_switch_off"

export type ChallengeRow = {
  id: string
  userId: string
  browserSecretHash: string
  otpPhone: string
  attempts: number
  lastSentAt: Date
  expiresAt: Date
  consumedAt: Date | null
}

const iso = (ms: number) => new Date(ms).toISOString()

export async function findAccount(db: SupabaseClient, sig: string): Promise<Account> {
  const { data, error } = await db.rpc("phone_login_find_account", { p_sig: sig })
  if (error) throw error
  const row = (Array.isArray(data) ? data[0] : data) as
    | {
        match_count: number
        verified_count: number
        user_id: string | null
        email: string | null
        phone_number: string | null
        phone_verified: boolean | null
        is_suspended: boolean | null
      }
    | null
    | undefined
  if (!row) {
    return { matchCount: 0, verifiedCount: 0, userId: null, email: null, phone: null, phoneVerified: false, isSuspended: false }
  }
  return {
    matchCount: Number(row.match_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    userId: row.user_id ?? null,
    email: row.email ?? null,
    phone: row.phone_number ?? null,
    phoneVerified: row.phone_verified === true,
    isSuspended: row.is_suspended === true,
  }
}

export async function isLocked(db: SupabaseClient, phoneHash: string): Promise<boolean> {
  const { data, error } = await db.rpc("phone_login_is_locked", { p_phone_hash: phoneHash })
  if (error) throw error
  return data === true
}

/**
 * Atomically reserves a password-check slot for this phone (per-phone advisory lock in the RPC). False = locked:
 * 5 recent failures plus in-flight attempts reached the cap. THROWS on an RPC error; anything but `true` is locked.
 */
export async function beginAttempt(db: SupabaseClient, phoneHash: string, ipHash: string): Promise<boolean> {
  const { data, error } = await db.rpc("phone_login_begin_attempt", { p_phone_hash: phoneHash, p_ip_hash: ipHash })
  if (error) throw error
  return data === true
}

/** Releases the slot taken by beginAttempt (called after a correct password). THROWS on an RPC error. */
export async function endAttempt(db: SupabaseClient, phoneHash: string): Promise<void> {
  const { error } = await db.rpc("phone_login_end_attempt", { p_phone_hash: phoneHash })
  if (error) throw error
}

export async function recordFailure(
  db: SupabaseClient,
  phoneHash: string,
  ipHash: string,
): Promise<{ locked: boolean }> {
  const { data, error } = await db.rpc("phone_login_record_failure", { p_phone_hash: phoneHash, p_ip_hash: ipHash })
  if (error) throw error
  return { locked: data === true }
}

/** Best-effort audit row. Never throws. */
export async function recordEvent(
  db: SupabaseClient,
  kind: EventKind,
  f: { userId?: string; phoneHash?: string; ipHash?: string },
): Promise<void> {
  try {
    await db.from("phone_login_events").insert({
      kind,
      user_id: f.userId ?? null,
      phone_hash: f.phoneHash ?? null,
      ip_hash: f.ipHash ?? null,
    })
  } catch {
    // swallowed on purpose
  }
}

export async function countDistinctPhonesFromIp(db: SupabaseClient, ipHash: string, sinceMs: number): Promise<number> {
  const { data, error } = await db
    .from("phone_login_events")
    .select("phone_hash")
    .eq("kind", "fail")
    .eq("ip_hash", ipHash)
    .gte("created_at", iso(Date.now() - sinceMs))
  if (error) throw error
  const set = new Set<string>()
  for (const r of (data ?? []) as Array<{ phone_hash: string | null }>) {
    if (r.phone_hash) set.add(r.phone_hash)
  }
  return set.size
}

export async function countEvents(db: SupabaseClient, kind: EventKind, sinceMs: number): Promise<number> {
  const { count, error } = await db
    .from("phone_login_events")
    .select("id", { count: "exact", head: true })
    .eq("kind", kind)
    .gte("created_at", iso(Date.now() - sinceMs))
  if (error) throw error
  return count ?? 0
}

export async function hadPasswordChangeSince(db: SupabaseClient, userId: string, sinceMs: number): Promise<boolean> {
  const { data, error } = await db
    .from("phone_login_events")
    .select("id")
    .eq("kind", "password_changed")
    .eq("user_id", userId)
    .gte("created_at", iso(sinceMs))
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

export async function createChallenge(
  db: SupabaseClient,
  c: { id: string; userId: string; browserSecretHash: string; otpPhone: string; now: Date },
): Promise<void> {
  const { error } = await db.from("phone_login_challenges").insert({
    id: c.id,
    user_id: c.userId,
    browser_secret_hash: c.browserSecretHash,
    otp_phone: c.otpPhone,
    attempts: 0,
    last_sent_at: c.now.toISOString(),
    expires_at: iso(c.now.getTime() + LIMITS.challengeTtlMs),
  })
  if (error) throw error
}

export async function getChallenge(db: SupabaseClient, id: string): Promise<ChallengeRow | null> {
  const { data, error } = await db
    .from("phone_login_challenges")
    .select("id, user_id, browser_secret_hash, otp_phone, attempts, last_sent_at, expires_at, consumed_at")
    .eq("id", id)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const r = data as Record<string, string | number | null>
  return {
    id: r.id as string,
    userId: r.user_id as string,
    browserSecretHash: r.browser_secret_hash as string,
    otpPhone: r.otp_phone as string,
    attempts: Number(r.attempts),
    lastSentAt: new Date(r.last_sent_at as string),
    expiresAt: new Date(r.expires_at as string),
    consumedAt: r.consumed_at ? new Date(r.consumed_at as string) : null,
  }
}

/** Optimistic increment (compare-and-set on attempts); returns the new count. */
export async function bumpChallengeAttempt(db: SupabaseClient, id: string): Promise<number> {
  for (let i = 0; i < 5; i++) {
    const { data, error } = await db.from("phone_login_challenges").select("attempts").eq("id", id).maybeSingle()
    if (error) throw error
    if (!data) throw new Error("challenge not found")
    const cur = Number((data as { attempts: number }).attempts)
    const { data: upd, error: uerr } = await db
      .from("phone_login_challenges")
      .update({ attempts: cur + 1 })
      .eq("id", id)
      .eq("attempts", cur)
      .select("id")
    if (uerr) throw uerr
    if ((upd ?? []).length === 1) return cur + 1
  }
  throw new Error("could not bump challenge attempts")
}

/** Single conditional UPDATE: true iff this call consumed the challenge. */
export async function consumeChallenge(db: SupabaseClient, id: string, now: Date): Promise<boolean> {
  const { data, error } = await db
    .from("phone_login_challenges")
    .update({ consumed_at: now.toISOString() })
    .eq("id", id)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("id")
  if (error) throw error
  return (data ?? []).length === 1
}

export async function killChallenge(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("phone_login_challenges")
    .update({ expires_at: new Date().toISOString() })
    .eq("id", id)
  if (error) throw error
}

export async function touchChallengeSent(db: SupabaseClient, id: string, now: Date): Promise<void> {
  const { error } = await db
    .from("phone_login_challenges")
    .update({ last_sent_at: now.toISOString() })
    .eq("id", id)
  if (error) throw error
}

export async function findTrustedDevice(
  db: SupabaseClient,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<{ id: string } | null> {
  const { data, error } = await db
    .from("trusted_devices")
    .select("id")
    .eq("token_hash", tokenHash)
    .eq("user_id", userId)
    .is("revoked_at", null)
    .gt("expires_at", now.toISOString())
    .maybeSingle()
  if (error) throw error
  return data ? { id: (data as { id: string }).id } : null
}

export async function trustDevice(
  db: SupabaseClient,
  d: { userId: string; tokenHash: string; uaLabel: string; now: Date },
): Promise<void> {
  const { error } = await db.from("trusted_devices").insert({
    user_id: d.userId,
    token_hash: d.tokenHash,
    ua_label: d.uaLabel,
    created_at: d.now.toISOString(),
    last_used_at: d.now.toISOString(),
    expires_at: iso(d.now.getTime() + LIMITS.deviceTtlMs),
  })
  if (error) throw error

  const { data, error: lerr } = await db
    .from("trusted_devices")
    .select("id")
    .eq("user_id", d.userId)
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
  if (lerr) throw lerr
  const excess = ((data ?? []) as Array<{ id: string }>).slice(LIMITS.maxDevices).map((r) => r.id)
  if (excess.length === 0) return
  const { error: rerr } = await db
    .from("trusted_devices")
    .update({ revoked_at: d.now.toISOString() })
    .in("id", excess)
  if (rerr) throw rerr
}

export async function touchDevice(db: SupabaseClient, id: string, now: Date): Promise<void> {
  const { error } = await db.from("trusted_devices").update({ last_used_at: now.toISOString() }).eq("id", id)
  if (error) throw error
}
