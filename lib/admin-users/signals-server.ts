// Server-side: activity and risk signals for a page of users (GET /api/admin/users) or one user (the drawer).
import type { SupabaseClient } from "@supabase/supabase-js"
import { findBlacklistedPhones } from "@/lib/blacklist"
import { parseSignalsResult, signalsRpcArgs, toSignalsView, type UserSignalsView } from "./risk-signals"

/** admin_user_signals' limit (and the list's page size limit). */
export const MAX_SIGNAL_USERS = 200

/**
 * Signals for at most 200 users, in one round trip: the admin_user_signals RPC (counts, last order, phone
 * verified) and the blacklist lookup (lib/blacklist.ts, the same matching the order routes use) run in parallel.
 * `phones` are the numbers the caller already has (the list rows); the RPC also returns each user's phone, which
 * is used when the caller has none. Throws when the RPC fails; a failed blacklist lookup only logs and shows
 * "not blacklisted", like isPhoneBlacklisted.
 */
export async function loadUserSignals(
  db: SupabaseClient,
  users: Array<{ id: string; phone?: string | null }>,
  now: number = Date.now(),
): Promise<Map<string, UserSignalsView>> {
  // Postgres prints uuids in lower case, so the RPC's keys are lower case whatever the caller passed.
  users = users.map((u) => ({ ...u, id: u.id.toLowerCase() }))
  const ids = [...new Set(users.map((u) => u.id))].slice(0, MAX_SIGNAL_USERS)
  if (ids.length === 0) return new Map()
  const knownPhones = users.map((u) => u.phone).filter((p): p is string => !!p)

  const [rpc, blacklisted] = await Promise.all([
    db.rpc("admin_user_signals", signalsRpcArgs(ids)),
    knownPhones.length
      ? findBlacklistedPhones(knownPhones, db).catch((e) => { console.warn("[ADMIN-USER-SIGNALS]", e?.message ?? e); return new Set<string>() })
      : Promise.resolve(null),
  ])
  if (rpc.error) throw new Error(`admin_user_signals failed: ${rpc.error.message}`)
  const raw = parseSignalsResult(rpc.data)

  // No phones from the caller (the drawer): look them up from the RPC's answer.
  let hits = blacklisted
  if (!hits) {
    const phones = [...raw.values()].map((r) => r.phone_number).filter((p): p is string => !!p)
    hits = phones.length
      ? await findBlacklistedPhones(phones, db).catch((e) => { console.warn("[ADMIN-USER-SIGNALS]", e?.message ?? e); return new Set<string>() })
      : new Set<string>()
  }

  const out = new Map<string, UserSignalsView>()
  const phoneOf = new Map(users.map((u) => [u.id, u.phone ?? null]))
  for (const id of ids) {
    const r = raw.get(id)
    const phone = phoneOf.get(id) || r?.phone_number || null
    const view = toSignalsView(r, !!phone && hits.has(phone), now)
    if (view) out.set(id, view)
  }
  return out
}
