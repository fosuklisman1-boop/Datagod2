// Hubnet reference reservations.
//
// Hubnet was proven live NOT to reject a reused reference, so a reference is reserved in our own DB
// (migration 0192, primary key on ref) BEFORE the Hubnet POST. The second reserve of the same ref
// loses atomically (PG 23505 => "held"). Anything we cannot confirm fails closed ("error").

import { createClient } from "@supabase/supabase-js"

export type ReserveResult = "reserved" | "held" | "error"

export interface HubnetReservations {
  reserve(r: { ref: string; kind: "data" | "airtime"; orderId: string }): Promise<ReserveResult>
  /** Best effort; never throws. */
  release(ref: string): Promise<void>
}

type Db = { from(t: string): any }

const TABLE = "hubnet_ref_reservations"

export function dbReservations(getDb: () => Db | null): HubnetReservations {
  const safeDb = (): Db | null => {
    try {
      return getDb()
    } catch {
      return null
    }
  }
  return {
    async reserve({ ref, kind, orderId }) {
      try {
        const db = safeDb()
        if (!db) return "error"
        const { error } = await db.from(TABLE).insert({ ref, kind, order_id: orderId })
        if (!error) return "reserved"
        return error.code === "23505" ? "held" : "error"
      } catch {
        return "error"
      }
    },
    async release(ref) {
      try {
        const db = safeDb()
        if (!db) return
        await db.from(TABLE).delete().eq("ref", ref)
      } catch {
        // best effort
      }
    },
  }
}

/** Per-process reservations, for tests. */
export function memoryReservations(): HubnetReservations {
  const held = new Set<string>()
  return {
    async reserve({ ref }) {
      if (held.has(ref)) return "held"
      held.add(ref)
      return "reserved"
    },
    async release(ref) {
      held.delete(ref)
    },
  }
}

let defaultReservations: HubnetReservations | null = null

/** Process-wide reservations backed by the service-role client (lazy: no client at import time). */
export function defaultHubnetReservations(): HubnetReservations {
  if (!defaultReservations) {
    let db: Db | null = null
    defaultReservations = dbReservations(() => {
      if (db) return db
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return null
      db = createClient(url, key, { auth: { persistSession: false } })
      return db
    })
  }
  return defaultReservations
}
