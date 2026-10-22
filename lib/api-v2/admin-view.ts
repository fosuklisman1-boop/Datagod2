import { DEFAULT_LIMITS, parseLimitOverrides, type LimitGroup } from "./limits"
import type { KeyType, Environment, KeyStatus } from "./keys"

interface OwnerUser {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  role?: string | null
  phone?: string | null
}

/** Row returned by GET /api/admin/api-keys (v1, enriched with `user`). */
export interface V1AdminKey {
  id: string
  name?: string | null
  key_prefix: string
  environment?: string | null
  is_active: boolean
  rate_limit_per_min?: number | null
  last_used_at?: string | null
  created_at: string
  user?: OwnerUser | null
  requests_24h?: number | null
}

/** Row returned by GET /api/admin/api-v2/keys (v2, with `owner`). */
export interface V2AdminKey {
  id: string
  user_id: string
  key_type: KeyType
  environment: Environment
  status: KeyStatus
  name?: string | null
  key_prefix: string
  rate_limits?: unknown
  last_used_at?: string | null
  created_at: string
  owner?: (OwnerUser & { id?: string }) | null
  requests_24h?: number | null
}

export interface ConsoleKey {
  id: string
  source: "v1" | "v2"
  ownerName: string
  ownerEmail: string
  ownerRole: string | null
  ownerPhone: string | null
  prefix: string
  status: KeyStatus
  keyType: KeyType | null
  environment: Environment
  requests24h: number | null
  lastUsedAt: string | null
  rateLimits: Partial<Record<LimitGroup, number>> | null
  v1RatePerMin: number | null
  createdAt: string
}

function ownerFields(u: OwnerUser | null | undefined) {
  if (!u) return { ownerName: "Deleted user", ownerEmail: "", ownerRole: null, ownerPhone: null }
  const name = [u.first_name, u.last_name].filter((p): p is string => !!p && p.trim() !== "").join(" ")
  return {
    ownerName: name || "Deleted user",
    ownerEmail: u.email ?? "",
    ownerRole: u.role ?? null,
    ownerPhone: u.phone ?? null,
  }
}

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null
}

/** Builds every field explicitly so nothing else on the input (e.g. key_hash) can leak. */
export function mergeKeys(v1: V1AdminKey[], v2: V2AdminKey[]): ConsoleKey[] {
  const a: ConsoleKey[] = v1.map((k) => ({
    id: k.id,
    source: "v1",
    ...ownerFields(k.user),
    prefix: k.key_prefix,
    status: k.is_active ? "active" : "revoked",
    keyType: null,
    environment: k.environment === "test" ? "test" : "live",
    requests24h: count(k.requests_24h),
    lastUsedAt: k.last_used_at ?? null,
    rateLimits: null,
    v1RatePerMin: count(k.rate_limit_per_min),
    createdAt: k.created_at,
  }))
  const b: ConsoleKey[] = v2.map((k) => {
    const parsed = k.rate_limits == null ? null : parseLimitOverrides(k.rate_limits)
    return {
      id: k.id,
      source: "v2",
      ...ownerFields(k.owner),
      prefix: k.key_prefix,
      status: k.status,
      keyType: k.key_type,
      environment: k.environment,
      requests24h: count(k.requests_24h),
      lastUsedAt: k.last_used_at ?? null,
      rateLimits: parsed && parsed.ok ? parsed.value : null,
      v1RatePerMin: null,
      createdAt: k.created_at,
    }
  })
  return [...a, ...b]
}

export interface KeyFilter {
  q: string
  status: "all" | KeyStatus
  role: string | "all"
  sort: "newest" | "oldest" | "most_used"
}

const time = (s: string) => {
  const t = Date.parse(s)
  return Number.isNaN(t) ? 0 : t
}

export function filterKeys(keys: ConsoleKey[], f: KeyFilter): ConsoleKey[] {
  const q = f.q.trim().toLowerCase()
  const out = keys.filter((k) => {
    if (f.status !== "all" && k.status !== f.status) return false
    if (f.role !== "all" && k.ownerRole !== f.role) return false
    if (!q) return true
    return [k.ownerName, k.ownerEmail, k.ownerPhone ?? "", k.prefix].some((s) => s.toLowerCase().includes(q))
  })
  const newest = (x: ConsoleKey, y: ConsoleKey) => time(y.createdAt) - time(x.createdAt)
  if (f.sort === "oldest") return out.sort((x, y) => -newest(x, y))
  if (f.sort === "most_used") {
    return out.sort((x, y) => {
      if (x.requests24h === null && y.requests24h === null) return newest(x, y)
      if (x.requests24h === null) return 1
      if (y.requests24h === null) return -1
      return y.requests24h - x.requests24h || newest(x, y)
    })
  }
  return out.sort(newest)
}

export function statusCounts(keys: ConsoleKey[]): { all: number; pending: number; active: number; revoked: number } {
  const c = { all: keys.length, pending: 0, active: 0, revoked: 0 }
  for (const k of keys) c[k.status]++
  return c
}

export function limitFormValues(
  rateLimits: Partial<Record<LimitGroup, number>> | null
): Record<LimitGroup, number> {
  return { ...DEFAULT_LIMITS, ...(rateLimits ?? {}) }
}

export function validateLimitForm(
  values: Record<LimitGroup, string>
):
  | { ok: true; value: Record<LimitGroup, number> }
  | { ok: false; errors: Partial<Record<LimitGroup, string>> } {
  const value = {} as Record<LimitGroup, number>
  const errors: Partial<Record<LimitGroup, string>> = {}
  for (const g of Object.keys(DEFAULT_LIMITS) as LimitGroup[]) {
    const raw = (values[g] ?? "").trim()
    const n = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(n) || n < 1 || n > 10000) errors[g] = `Enter a whole number from 1 to 10000`
    else value[g] = n
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, value }
}
