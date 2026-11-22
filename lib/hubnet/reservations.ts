// Hubnet reference reservations.
//
// Hubnet was proven live NOT to reject a reused reference, so a reference is reserved in our own DB
// (migration 0192, primary key on ref) BEFORE the Hubnet POST. The second reserve of the same ref
// loses atomically (PG 23505 => "held"). Anything we cannot confirm fails closed ("error").

import { createClient } from "@supabase/supabase-js"

export type ReserveResult = "reserved" | "held" | "error"

export interface HubnetReservations {
  reserve(r: { ref: string; kind: "data" | "airtime"; orderId: string }): Promise<ReserveResult>
  /** Best effort; never throws. Only the owning order's reservation is removed (ref AND orderId must match). */
  release(ref: string, orderId: string): Promise<void>
}

type Db = { from(t: string): any }

const TABLE = "hubnet_ref_reservations"

/** A blank ref would collide for every order; refuse it before any DB call (0192 also CHECKs it). */
const blankRef = (ref: unknown): boolean => typeof ref !== "string" || ref.trim().length === 0

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
      if (blankRef(ref)) return "error"
      try {
        const db = safeDb()
        if (!db) return "error"
        const res = await db.from(TABLE).insert({ ref, kind, order_id: orderId })
        // Only an explicit `error: null` is a confirmed insert; anything else fails closed.
        if (res && res.error === null) return "reserved"
        return res?.error?.code === "23505" ? "held" : "error"
      } catch {
        return "error"
      }
    },
    async release(ref, orderId) {
      try {
        const db = safeDb()
        if (!db) return
        await db.from(TABLE).delete().eq("ref", ref).eq("order_id", orderId)
      } catch {
        // best effort
      }
    },
  }
}

/** Per-process reservations, for tests. */
export function memoryReservations(): HubnetReservations {
  const held = new Map<string, string>() // ref -> owning orderId
  return {
    async reserve({ ref, orderId }) {
      if (blankRef(ref)) return "error"
      if (held.has(ref)) return "held"
      held.set(ref, orderId)
      return "reserved"
    },
    async release(ref, orderId) {
      if (held.get(ref) === orderId) held.delete(ref)
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
