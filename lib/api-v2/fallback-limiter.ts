/**
 * In-process fixed-window limiter used only when the shared (Upstash Redis)
 * limiter is degraded. It needs no external store, so an endpoint that opts in
 * keeps working without Redis while still capping each key.
 *
 * The count is per server instance, so the effective cap across instances can
 * be higher than `max`; it bounds abuse rather than enforcing an exact quota.
 */
export interface FallbackLimiter {
  /** Counts one request for `key`; true when it is within `max` per `windowMs`. */
  hit(key: string, max: number, windowMs: number, nowMs: number): boolean
}

const MAX_KEYS = 10000

export function createMemoryLimiter(): FallbackLimiter {
  const windows = new Map<string, { start: number; count: number }>()

  const prune = (nowMs: number) => {
    for (const [k, w] of windows) {
      if (nowMs - w.start >= 60 * 60 * 1000) windows.delete(k)
    }
    // Still full: drop the oldest entries (Map keeps insertion order).
    while (windows.size >= MAX_KEYS) {
      const oldest = windows.keys().next().value
      if (oldest === undefined) break
      windows.delete(oldest)
    }
  }

  return {
    hit(key, max, windowMs, nowMs) {
      let w = windows.get(key)
      if (!w || nowMs - w.start >= windowMs) {
        if (!w && windows.size >= MAX_KEYS) prune(nowMs)
        windows.delete(key)
        w = { start: nowMs, count: 0 }
        windows.set(key, w)
      }
      w.count += 1
      return w.count <= max
    },
  }
}

/** Shared per-instance limiter for the v2 routes. */
export const v2FallbackLimiter: FallbackLimiter = createMemoryLimiter()
