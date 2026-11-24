/**
 * Public developer status (spec 7.1). Per-service state from the service controls (paused wins) and the live 24 h
 * success rate from api_v2_public_health. Nothing per user, key, IP or endpoint leaves the server, and no exact
 * request count is ever returned (fewer than 20 requests -> no_data, rate null).
 *
 * Two cache layers: the route sends a CDN Cache-Control, and this module keeps a 60 s in-memory copy so query
 * strings that bypass the CDN key still cost at most one query set per instance per minute. On a DB error the
 * last good payload is served while it is under 10 minutes old.
 */
import { createControls, type ControlsSnapshot } from "./controls"
import { SERVICES, serviceForEndpoint, type ServiceId } from "./services"
import { getAdminClient, type SupabaseLike } from "./store"

export type ServiceState = "operational" | "paused" | "degraded" | "no_data"

export interface PublicStatus {
  generatedAt: string
  services: { id: ServiceId; title: string; state: ServiceState; message: string | null; successRate24h: number | null }[]
}

export const STATUS_CACHE_MS = 60_000
export const STATUS_LAST_GOOD_MS = 10 * 60_000
export const MIN_REQUESTS = 20
export const DEGRADED_BELOW = 95

interface HealthRow {
  endpoint: string
  total: number
  failed: number
}

export function shapeStatus(p: { controls: ControlsSnapshot; health: HealthRow[]; now: Date }): PublicStatus {
  const sums = new Map<ServiceId, { total: number; failed: number }>()
  for (const h of p.health) {
    const id = serviceForEndpoint(h.endpoint)
    if (!id) continue // account and wallet: never part of a service's status
    const s = sums.get(id) ?? { total: 0, failed: 0 }
    s.total += Number(h.total) || 0
    s.failed += Number(h.failed) || 0
    sums.set(id, s)
  }
  return {
    generatedAt: p.now.toISOString(),
    services: SERVICES.map(({ id, title }) => {
      const s = sums.get(id) ?? { total: 0, failed: 0 }
      const rate = s.total >= MIN_REQUESTS ? Math.round(((s.total - s.failed) / s.total) * 1000) / 10 : null
      const pause = p.controls.services.get(id)
      if (pause) return { id, title, state: "paused" as const, message: pause.message, successRate24h: rate }
      if (rate === null) return { id, title, state: "no_data" as const, message: null, successRate24h: null }
      return { id, title, state: rate < DEGRADED_BELOW ? ("degraded" as const) : ("operational" as const), message: null, successRate24h: rate }
    }),
  }
}

interface RpcLike extends SupabaseLike {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>
}

function asHealth(data: unknown): HealthRow[] | null {
  if (!Array.isArray(data)) return null
  return data
    .filter((r): r is HealthRow => !!r && typeof r === "object" && typeof (r as HealthRow).endpoint === "string")
    .map((r) => ({ endpoint: r.endpoint, total: Number(r.total) || 0, failed: Number(r.failed) || 0 }))
}

export function createStatusService(deps: { client: SupabaseLike; now(): number }): { get(): Promise<PublicStatus | "error"> } {
  const controls = createControls({ client: deps.client, now: deps.now })
  let good: { payload: PublicStatus; at: number } | null = null
  let lastAttempt = -Infinity
  let inflight: Promise<PublicStatus | "error"> | null = null

  const lastGood = (now: number): PublicStatus | "error" => (good && now - good.at < STATUS_LAST_GOOD_MS ? good.payload : "error")

  async function refresh(now: number): Promise<PublicStatus | "error"> {
    try {
      const [snap, health] = await Promise.all([
        controls.read(),
        (deps.client as RpcLike).rpc("api_v2_public_health", { p_since: new Date(now - 24 * 3600_000).toISOString() }),
      ])
      const rows = health && !health.error ? asHealth(health.data) : null
      if (snap === "error" || !rows) return lastGood(now)
      good = { payload: shapeStatus({ controls: snap, health: rows, now: new Date(now) }), at: now }
      return good.payload
    } catch {
      return lastGood(now)
    }
  }

  return {
    async get() {
      const now = deps.now()
      if (good && now - good.at < STATUS_CACHE_MS) return good.payload
      // A failed attempt inside the last minute: answer from memory instead of hammering a failing DB.
      if (now - lastAttempt < STATUS_CACHE_MS && !inflight) return lastGood(now)
      if (!inflight) {
        lastAttempt = now
        inflight = refresh(now).finally(() => {
          inflight = null
        })
      }
      return inflight
    },
  }
}

let defaultService: ReturnType<typeof createStatusService> | null = null

/** Lazily built so `next build` with placeholder env never touches the database. */
export async function getPublicStatus(): Promise<PublicStatus | "error"> {
  if (!defaultService) defaultService = createStatusService({ client: getAdminClient(), now: () => Date.now() })
  return defaultService.get()
}
