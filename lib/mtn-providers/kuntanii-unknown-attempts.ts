// Watches Kuntanii attempts whose placement outcome was unknown (timeout / network
// error). If such an attempt turns out to exist and is not cancelled, the order may
// have been delivered twice (a later attempt was placed) -> alert an admin.
// Never logs or alerts with phone numbers.

import { supabaseAdmin } from "@/lib/supabase"
import { createKuntaniiClient, type KuntaniiClient } from "./kuntanii-client"
import { aggregateOrdersStatus } from "./kuntanii-core"
import { defaultKuntaniiAlert, entriesOf } from "./kuntanii-provider"
import type { SupabaseLike } from "./kuntanii-disputes"

const TABLE = "kuntanii_unknown_attempts"
const BATCH_LIMIT = 20
const NOT_FOUND_GIVE_UP_MS = 24 * 3_600_000

export interface UnknownAttemptDeps {
  db?: SupabaseLike
  client?: KuntaniiClient
  alert?: (type: string, title: string, message: string) => Promise<void>
  now?: () => number
}

type Row = { id: string; external_order_id: string; order_id: string | null; created_at: string }

export async function checkUnknownAttempts(deps: UnknownAttemptDeps = {}): Promise<{ checked: number; alerted: number }> {
  const db = deps.db ?? (supabaseAdmin as SupabaseLike)
  const client = deps.client ?? createKuntaniiClient()
  const alert = deps.alert ?? defaultKuntaniiAlert
  const now = deps.now ?? Date.now

  const { data, error } = await db
    .from(TABLE)
    .select("id, external_order_id, order_id, created_at")
    .is("resolved_at", null)
    .order("created_at", { ascending: true })
    .limit(BATCH_LIMIT)
  if (error) throw new Error(`checkUnknownAttempts lookup failed: ${error.message}`)

  const out = { checked: 0, alerted: 0 }
  for (const row of (data ?? []) as Row[]) {
    out.checked++
    try {
      const res = await client.getOrder(row.external_order_id)
      if (!res.ok) {
        if (res.status === 404 && now() - new Date(row.created_at).getTime() > NOT_FOUND_GIVE_UP_MS) {
          await resolve(db, row.id, "not_found", now)
        }
        continue // young 404 or any other error: look again next run
      }
      const status = aggregateOrdersStatus(entriesOf(res.data))
      if (status !== "failed") {
        // Per-attempt type so the hourly throttle never swallows a second attempt's alert.
        try {
          await alert(
            `kuntanii_possible_double_delivery_${row.external_order_id}`,
            "Kuntanii: possible double delivery",
            `order ${row.order_id} attempt ${row.external_order_id} is ${status} at Kuntanii`,
          )
        } catch (e) {
          // Leave the row unresolved: the next run retries the alert.
          console.error(`[KUNTANII-UNKNOWN] alert failed for ${row.external_order_id}:`, (e as Error).message)
          continue
        }
        out.alerted++
      }
      await resolve(db, row.id, status, now)
    } catch (e) {
      console.error(`[KUNTANII-UNKNOWN] check failed for ${row.external_order_id}:`, (e as Error).message)
    }
  }
  return out
}

async function resolve(db: SupabaseLike, id: string, lastStatus: string, now: () => number): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .update({ last_status: lastStatus, resolved_at: new Date(now()).toISOString() })
    .eq("id", id)
  if (error) throw new Error(`could not resolve unknown attempt ${id}: ${error.message}`)
}
