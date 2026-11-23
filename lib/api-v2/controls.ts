import { getAdminClient, type SupabaseLike } from "./store"
import type { ServiceId } from "./services"

/**
 * Short-TTL snapshot of the two pause controls (spec 6.2/6.3): the set of paused developers and the paused
 * services with their messages. Two tiny reads, refreshed at most once per TTL per instance (single flight).
 * Injected client and clock, like store.ts.
 */

export interface ControlsSnapshot {
  pausedUsers: ReadonlySet<string>
  services: ReadonlyMap<ServiceId, { message: string | null }>
  at: number
}

export interface ControlsDeps {
  client: SupabaseLike
  now(): number
}

export const CONTROLS_TTL_MS = 10_000
export const CONTROLS_STALE_LIMIT_MS = 300_000
export const PAUSED_USERS_CAP = 5000

interface QueryError {
  code?: string
  message?: string
}

/** Tables missing (code shipped before the migration or after a rollback): the true state is "nothing paused". */
function isTableMissing(err: unknown): boolean {
  const e = (err ?? {}) as QueryError
  if (e.code === "42P01" || e.code === "PGRST205") return true
  const msg = (e.message ?? "").toLowerCase()
  return msg.includes("schema cache") || msg.includes("does not exist")
}

type Refreshed = ControlsSnapshot | "error"

async function refresh(client: SupabaseLike, now: number): Promise<Refreshed> {
  try {
    const [pauses, controls] = (await Promise.all([
      client.from("api_v2_developer_pauses").select("user_id").limit(PAUSED_USERS_CAP + 1),
      client.from("api_v2_service_controls").select("service, paused, message"),
    ])) as { data: unknown; error: unknown }[]
    if (isTableMissing(pauses.error) || isTableMissing(controls.error)) {
      return { pausedUsers: new Set(), services: new Map(), at: now }
    }
    if (pauses.error || controls.error) return "error"
    const pauseRows = (pauses.data ?? []) as { user_id: string }[]
    // A truncated list would silently release people: treat the cap as a read error.
    if (pauseRows.length > PAUSED_USERS_CAP) return "error"
    const services = new Map<ServiceId, { message: string | null }>()
    for (const r of (controls.data ?? []) as { service: ServiceId; paused: boolean; message: string | null }[]) {
      if (r.paused) services.set(r.service, { message: r.message ?? null })
    }
    return { pausedUsers: new Set(pauseRows.map((r) => r.user_id)), services, at: now }
  } catch {
    return "error"
  }
}

export function createControls(deps: ControlsDeps): {
  read(): Promise<ControlsSnapshot | "error">
  invalidate(): void
} {
  let snapshot: ControlsSnapshot | null = null
  let inflight: Promise<ControlsSnapshot | "error"> | null = null
  // The time of the last refresh attempt (success or failure): bounds retries to once per TTL.
  let lastAttempt = Number.NEGATIVE_INFINITY
  let lastFailure = false

  async function doRefresh(): Promise<ControlsSnapshot | "error"> {
    const now = deps.now()
    const result = await refresh(deps.client, now)
    lastAttempt = now
    if (result !== "error") {
      snapshot = result
      lastFailure = false
      return result
    }
    lastFailure = true
    if (snapshot && now - snapshot.at < CONTROLS_STALE_LIMIT_MS) return snapshot
    return "error"
  }

  return {
    async read() {
      const now = deps.now()
      if (now - lastAttempt < CONTROLS_TTL_MS) {
        if (!lastFailure && snapshot) return snapshot
        if (snapshot && now - snapshot.at < CONTROLS_STALE_LIMIT_MS) return snapshot
        if (lastFailure) return "error"
      }
      if (!inflight) {
        inflight = doRefresh().finally(() => {
          inflight = null
        })
      }
      return inflight
    },
    invalidate() {
      lastAttempt = Number.NEGATIVE_INFINITY
      inflight = null
    },
  }
}

let defaultControls: ReturnType<typeof createControls> | null = null

/** Module-level instance, built lazily so importing this file never touches the real client. */
export function getControls(): ReturnType<typeof createControls> {
  if (!defaultControls) defaultControls = createControls({ client: getAdminClient(), now: () => Date.now() })
  return defaultControls
}
