import type { SupabaseLike } from "./store"

/**
 * Stuck v2 work: report-only. Nothing in this file updates, deletes or upserts
 * rows in api_v2_idempotency or api_orders. The only write is the dedupe marker
 * in admin_settings (the key/value store; app_settings is the singleton row).
 */

export const STUCK_AFTER_MINUTES = 10
export const STUCK_LIST_CAP = 200
/** Dedupe marker key (stored as { ids: string[] } in admin_settings.value). */
export const STUCK_LAST_IDS_KEY = "api_v2_stuck_last_ids"

export interface StuckClaim {
  id: string
  user_id: string
  kind: string
  reference: string | null
  status: string
  created_at: string
}

export interface StuckOrder {
  id: string
  user_id: string
  network: string | null
  api_reference: string | null
  status: string
  created_at: string
}

export interface StuckResult {
  claims: StuckClaim[]
  orders: StuckOrder[]
}

/** Claims or orders that could not be read are left out; the caller sees what loaded. */
export async function findStuckV2(client: SupabaseLike, now: Date): Promise<StuckResult> {
  const cutoff = new Date(now.getTime() - STUCK_AFTER_MINUTES * 60 * 1000).toISOString()

  const claimsRes = await client
    .from("api_v2_idempotency")
    .select("id, user_id, kind, reference, status, created_at")
    .neq("status", "done")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(STUCK_LIST_CAP)

  const ordersRes = await client
    .from("api_orders")
    .select("id, user_id, network, api_reference, status, created_at")
    .not("api_v2_key_id", "is", null)
    .in("status", ["pending", "processing"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(STUCK_LIST_CAP)

  if (claimsRes.error) console.error("[API-V2-STUCK] claims read failed:", claimsRes.error.message)
  if (ordersRes.error) console.error("[API-V2-STUCK] orders read failed:", ordersRes.error.message)

  return {
    claims: claimsRes.error ? [] : ((claimsRes.data ?? []) as StuckClaim[]),
    orders: ordersRes.error ? [] : ((ordersRes.data ?? []) as StuckOrder[]),
  }
}

/** Alert only when there is something stuck and the id set differs from the last alert. */
export function shouldAlert(prevIds: string[], ids: string[]): boolean {
  if (ids.length === 0) return false
  if (prevIds.length !== ids.length) return true
  const prev = new Set(prevIds)
  return ids.some((id) => !prev.has(id))
}

/** Sorted, prefixed ids so a claim and an order can never collide. */
export function stuckIdSet(r: StuckResult): string[] {
  return [...r.claims.map((c) => `c:${c.id}`), ...r.orders.map((o) => `o:${o.id}`)].sort()
}

/** Counts and oldest age only. No phones, user ids, references or emails. */
export function buildStuckMessage(r: StuckResult, now: Date): string {
  const oldest = [...r.claims, ...r.orders].reduce<number>((min, row) => {
    const t = Date.parse(row.created_at)
    return Number.isFinite(t) && t < min ? t : min
  }, Number.POSITIVE_INFINITY)
  const age = Number.isFinite(oldest) ? Math.max(0, Math.round((now.getTime() - oldest) / 60000)) : 0
  return `API v2 stuck work: ${r.claims.length} claim(s) and ${r.orders.length} order(s) pending over ${STUCK_AFTER_MINUTES} minutes. Oldest is ${age} minutes old. Review in /admin/api-v2.`
}

async function readLastIds(client: SupabaseLike): Promise<string[]> {
  const { data, error } = await client.from("admin_settings").select("value").eq("key", STUCK_LAST_IDS_KEY).maybeSingle()
  if (error) throw new Error(error.message)
  const ids = (data as { value?: { ids?: unknown } } | null)?.value?.ids
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []
}

async function writeLastIds(client: SupabaseLike, ids: string[], now: Date): Promise<void> {
  const { error } = await client.from("admin_settings").upsert(
    {
      key: STUCK_LAST_IDS_KEY,
      value: { ids },
      description: "API v2 stuck sweeper: id set of the last alert (dedupe).",
      updated_at: now.toISOString(),
    },
    { onConflict: "key" },
  )
  if (error) throw new Error(error.message)
}

/**
 * One sweep: find stuck work, alert once per distinct id set. The dedupe marker
 * is recorded after the alert, so a failed marker write may re-alert but never
 * hides an alert. When nothing is stuck the marker is cleared so a recurrence
 * alerts again.
 */
export async function runStuckSweep(
  client: SupabaseLike,
  now: Date,
  notify: (message: string) => Promise<void>,
): Promise<{ alerted: boolean; claims: number; orders: number }> {
  const result = await findStuckV2(client, now)
  const ids = stuckIdSet(result)
  const counts = { claims: result.claims.length, orders: result.orders.length }

  let prev: string[] = []
  try {
    prev = await readLastIds(client)
  } catch (e) {
    console.error("[API-V2-STUCK] dedupe read failed:", e instanceof Error ? e.message : "unknown")
  }

  if (!shouldAlert(prev, ids)) {
    if (ids.length === 0 && prev.length > 0) {
      try {
        await writeLastIds(client, [], now)
      } catch (e) {
        console.error("[API-V2-STUCK] dedupe clear failed:", e instanceof Error ? e.message : "unknown")
      }
    }
    return { alerted: false, ...counts }
  }

  await notify(buildStuckMessage(result, now))
  try {
    await writeLastIds(client, ids, now)
  } catch (e) {
    console.error("[API-V2-STUCK] dedupe write failed:", e instanceof Error ? e.message : "unknown")
  }
  return { alerted: true, ...counts }
}
