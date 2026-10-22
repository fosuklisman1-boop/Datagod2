export interface AdminStats {
  totalKeys: number
  pendingKeys: number
  activeKeys: number
  requests24h: number
  successRate: number | null
  failed24h: number
  avgLatencyMs: number | null
  top: { userId: string; name: string | null; email: string | null; requests: number } | null
  revenue24h: null
  revenueLifetime: null
}

export interface KeyActivity {
  requests: number
  ok: number
  failed: number
  successRate: number | null
  avgLatencyMs: number | null
  lastUsedAt: string | null
  spent: null
  orders: null
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0
}

function latency(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null
}

function rate(ok: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((ok / total) * 1000) / 10
}

export function shapeStats(
  raw: unknown,
  owner: { name: string | null; email: string | null } | null
): AdminStats {
  const r = obj(raw)
  const keys = obj(r.keys)
  const requests = count(r.requests)
  const ok = count(r.ok)
  const top = obj(r.top)
  const topId = typeof top.user_id === "string" && top.user_id.length > 0 ? top.user_id : null
  return {
    totalKeys: count(keys.total),
    pendingKeys: count(keys.pending),
    activeKeys: count(keys.active),
    requests24h: requests,
    successRate: rate(ok, requests),
    failed24h: count(r.failed),
    avgLatencyMs: latency(r.avg_latency_ms),
    top: topId
      ? { userId: topId, name: owner?.name ?? null, email: owner?.email ?? null, requests: count(top.requests) }
      : null,
    revenue24h: null,
    revenueLifetime: null,
  }
}

export function shapeKeyActivity(raw: unknown): KeyActivity {
  const r = obj(raw)
  const requests = count(r.requests)
  return {
    requests,
    ok: count(r.ok),
    failed: count(r.failed),
    successRate: rate(count(r.ok), requests),
    avgLatencyMs: latency(r.avg_latency_ms),
    lastUsedAt: typeof r.last_used_at === "string" ? r.last_used_at : null,
    spent: null,
    orders: null,
  }
}

export interface LogQuery {
  keyId?: string
  userId?: string
  statusClass?: "success" | "client_error" | "server_error"
  since?: string
  until?: string
  endpoint?: string
  limit: number
  offset: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/
const CLASSES = ["success", "client_error", "server_error"] as const
const MAX_LIMIT = 200
const MAX_ENDPOINT = 200

export function parseLogQuery(
  sp: URLSearchParams
): { ok: true; value: LogQuery } | { ok: false; error: string } {
  const value: LogQuery = { limit: 100, offset: 0 }

  for (const f of ["keyId", "userId"] as const) {
    const v = sp.get(f)
    if (v === null || v === "") continue
    if (!UUID_RE.test(v)) return { ok: false, error: `${f} must be a UUID` }
    value[f] = v
  }

  const sc = sp.get("statusClass")
  if (sc) {
    if (!(CLASSES as readonly string[]).includes(sc)) return { ok: false, error: "Invalid statusClass" }
    value.statusClass = sc as LogQuery["statusClass"]
  }

  for (const f of ["since", "until"] as const) {
    const v = sp.get(f)
    if (v === null || v === "") continue
    if (!ISO_RE.test(v) || Number.isNaN(Date.parse(v))) return { ok: false, error: `${f} must be an ISO date` }
    value[f] = v
  }

  const endpoint = sp.get("endpoint")
  if (endpoint) {
    if (endpoint.length > MAX_ENDPOINT) return { ok: false, error: "endpoint is too long" }
    value.endpoint = endpoint
  }

  const limit = sp.get("limit")
  if (limit !== null && limit !== "") {
    if (!/^\d+$/.test(limit) || Number(limit) < 1) return { ok: false, error: "limit must be a positive integer" }
    value.limit = Math.min(Number(limit), MAX_LIMIT)
  }

  const offset = sp.get("offset")
  if (offset !== null && offset !== "") {
    if (!/^\d+$/.test(offset)) return { ok: false, error: "offset must be a non-negative integer" }
    value.offset = Number(offset)
  }

  return { ok: true, value }
}
