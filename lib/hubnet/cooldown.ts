// Shared "Hubnet is rate-limiting us" cooldown.
//
// Live 2026-11-21: Hubnet answers ~10 quick status checks, then 429 with Retry-After 25-60s.
// A 429 says nothing about an order, so callers must neither place nor hold on it; instead the
// first 429 trips this cooldown and every Hubnet call (any serverless instance) skips Hubnet
// until it ends, instead of burning more requests that will only be refused.
//
// Stored in admin_settings (key unique) so all instances share it; an in-memory copy avoids a
// DB read per call. The stored value is untrusted (admin_settings is writable by authenticated
// users under the 0060 grant model), so any read is capped to MAX_COOLDOWN_SEC from now.

import { createClient } from "@supabase/supabase-js"

const SETTING_KEY = "hubnet_rate_limited_until"
const MAX_COOLDOWN_SEC = 300
const READ_CACHE_MS = 3_000

export interface HubnetCooldown {
  /** Seconds left in the cooldown (0 = Hubnet may be called). Never throws. */
  remainingSec(): Promise<number>
  /** Start or extend the cooldown. Never shortens an existing one. Never throws. */
  trip(seconds: number): Promise<void>
}

function clampUntil(untilMs: number, nowMs: number): number {
  if (!Number.isFinite(untilMs)) return 0
  return Math.min(untilMs, nowMs + MAX_COOLDOWN_SEC * 1000)
}

function secondsLeft(untilMs: number, nowMs: number): number {
  return untilMs > nowMs ? Math.ceil((untilMs - nowMs) / 1000) : 0
}

/** Per-process only. Used by tests and as the fast path of the shared cooldown. */
export function memoryCooldown(now: () => number = Date.now): HubnetCooldown {
  let until = 0
  return {
    async remainingSec() {
      return secondsLeft(until, now())
    },
    async trip(seconds) {
      const t = now()
      until = Math.max(until, clampUntil(t + Math.max(0, seconds) * 1000, t))
    },
  }
}

type Db = { from: (table: string) => any }

/** Cooldown shared through admin_settings. `getDb` returning null degrades to per-process only. */
export function sharedCooldown(getDb: () => Db | null, now: () => number = Date.now): HubnetCooldown {
  let until = 0
  let readAt = -Infinity

  async function readShared(): Promise<number> {
    const db = getDb()
    if (!db) return 0
    const { data, error } = await db.from("admin_settings").select("value").eq("key", SETTING_KEY).maybeSingle()
    if (error) throw new Error(error.message)
    const raw = data?.value?.until
    const ms = typeof raw === "string" ? Date.parse(raw) : NaN
    return Number.isFinite(ms) ? ms : 0
  }

  return {
    async remainingSec() {
      const t = now()
      if (until > t) return secondsLeft(until, t)
      if (t - readAt >= READ_CACHE_MS) {
        readAt = t
        try {
          until = Math.max(until, clampUntil(await readShared(), t))
        } catch {
          // Unreadable: fall back to what this process knows. Hubnet's own 429 is the backstop.
        }
      }
      return secondsLeft(until, t)
    },
    async trip(seconds) {
      const t = now()
      const next = clampUntil(t + Math.max(0, seconds) * 1000, t)
      if (next <= until) return
      until = next
      readAt = t
      try {
        const db = getDb()
        if (!db) return
        await db
          .from("admin_settings")
          .upsert(
            { key: SETTING_KEY, value: { until: new Date(next).toISOString() }, description: "Hubnet 429 cooldown (auto)", updated_at: new Date(t).toISOString() },
            { onConflict: "key" },
          )
      } catch {
        // Best effort: this process still honours it.
      }
    },
  }
}

let defaultCooldown: HubnetCooldown | null = null

/** Process-wide shared cooldown backed by the service-role client (lazy: no client at import time). */
export function defaultHubnetCooldown(): HubnetCooldown {
  if (!defaultCooldown) {
    let db: Db | null = null
    defaultCooldown = sharedCooldown(() => {
      if (db) return db
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY
      if (!url || !key) return null
      db = createClient(url, key, { auth: { persistSession: false } })
      return db
    })
  }
  return defaultCooldown
}
