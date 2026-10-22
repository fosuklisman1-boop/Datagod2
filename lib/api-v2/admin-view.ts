import { DEFAULT_LIMITS, parseLimitOverrides, type LimitGroup } from "./limits"
import type { KeyType, Environment, KeyStatus } from "./keys"
import { V2_ROLES } from "./lifecycle"

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

const ROLE_LABELS: Record<string, string> = {
  user: "Customer",
  sub_agent: "Subagent",
  dealer: "Dealer",
  admin: "Admin",
}

export function roleLabel(role: string | null): string {
  if (!role) return "No role"
  if (ROLE_LABELS[role]) return ROLE_LABELS[role]
  const words = role.replace(/[_-]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const TYPE_LABELS: Record<KeyType, string> = {
  standard: "Standard",
  commission: "Commission · Utilities",
  sms: "SMS",
}

export function keyTypeLabel(k: ConsoleKey): string {
  if (k.source === "v1" || !k.keyType) return "v1"
  return TYPE_LABELS[k.keyType]
}

export interface KeyActionSet {
  approve: boolean
  revoke: boolean
  activity: boolean
  limits: boolean
  v1Toggle: boolean
  v1Delete: boolean
  v1Rate: boolean
}

/** Which controls a row offers. v1 keys only get the controls the v1 admin routes support. */
export function keyActions(k: ConsoleKey): KeyActionSet {
  if (k.source === "v1") {
    return { approve: false, revoke: false, activity: false, limits: false, v1Toggle: true, v1Delete: true, v1Rate: true }
  }
  return {
    approve: k.status === "pending",
    revoke: k.status !== "revoked",
    activity: true,
    limits: k.status !== "revoked",
    v1Toggle: false,
    v1Delete: false,
    v1Rate: false,
  }
}

/** Same rule as PATCH /api/admin/api-keys: integer 1-10000. */
export function parseV1RateLimit(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const s = raw.trim()
  const n = /^\d+$/.test(s) ? Number(s) : NaN
  if (!Number.isInteger(n) || n < 1 || n > 10000) return { ok: false, error: "Enter a whole number from 1 to 10000" }
  return { ok: true, value: n }
}

export function roleOptions(keys: ConsoleKey[]): string[] {
  const roles = Array.from(new Set(keys.map((k) => k.ownerRole).filter((r): r is string => !!r)))
  return roles.sort((a, b) => roleLabel(a).localeCompare(roleLabel(b)))
}

/** Toggle a role in the allowed list, keeping V2_ROLES order and no duplicates. */
export function toggleRole(selected: readonly string[], role: string): string[] {
  const set = new Set(selected)
  if (set.has(role)) set.delete(role)
  else set.add(role)
  const order = V2_ROLES
  return Array.from(set).sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
  })
}

/**
 * Stopgap for GET /api/admin/api-logs, which interpolates `search` unescaped into a PostgREST
 * `.or()` filter: removing `,`, `(` and `)` keeps a typed search from adding filter clauses.
 */
export function sanitizeV1Search(raw: string): string {
  return raw.replace(/[,()]/g, "").trim()
}

export interface ConsoleConfig {
  enabled: boolean
  allowed_roles: string[]
}

/** Value equality for the v2 API config (role order does not matter). */
export function sameConfig(a: ConsoleConfig | null, b: ConsoleConfig | null): boolean {
  if (!a || !b) return a === b
  if (a.enabled !== b.enabled) return false
  const x = [...a.allowed_roles].sort()
  const y = [...b.allowed_roles].sort()
  return x.length === y.length && x.every((r, i) => r === y[i])
}

const DASH = "—"
const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n)

export function formatCount(n: number | null | undefined): string {
  return finite(n) ? n.toLocaleString("en-US") : DASH
}

export function formatPercent(n: number | null | undefined): string {
  return finite(n) ? `${n}%` : DASH
}

export function formatLatency(ms: number | null | undefined): string {
  if (!finite(ms)) return DASH
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${Math.round(ms / 10) / 100} s`
}
