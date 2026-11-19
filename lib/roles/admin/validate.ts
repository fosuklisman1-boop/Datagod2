import { isCapability, type Capability } from "../capabilities"
import type { RoleRow } from "../ladder"

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export const BADGE_COLORS = ["navy", "purple", "emerald", "amber", "rose", "slate"] as const
export type BadgeColor = (typeof BADGE_COLORS)[number]
export const ROLE_ICONS = ["Crown", "Star", "Gem", "Rocket", "Shield", "Zap", "Award", "Briefcase"] as const
export type RoleIcon = (typeof ROLE_ICONS)[number]

export const HUB_SERVICE_KEYS: readonly { key: string; label: string }[] = [
  { key: "airtime_fee:mtn", label: "MTN airtime fee" },
  { key: "airtime_fee:telecel", label: "Telecel airtime fee" },
  { key: "airtime_fee:at", label: "AirtelTigo airtime fee" },
  { key: "cashback_share:airtime", label: "Airtime cashback share" },
  { key: "cashback_share:bundles", label: "Bundles cashback share" },
  { key: "cashback_share:bills", label: "Bills cashback share" },
]

const SLUG_RE = /^[a-z][a-z0-9_]{1,19}$/
const SYSTEM_SLUGS = new Set(["user", "dealer", "sub_agent", "admin"])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const err = <T>(error: string): Result<T> => ({ ok: false, error })
const round2 = (x: number) => Math.round(x * 100) / 100
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function validateReason(input: unknown): Result<string> {
  if (typeof input !== "string") return err("reason must be a string")
  const s = input.trim()
  if (s.length < 3 || s.length > 300) return err("reason must be 3-300 characters")
  return { ok: true, value: s }
}

function validateName(input: unknown): Result<string> {
  if (typeof input !== "string") return err("name must be a string")
  const s = input.trim()
  if (s.length < 2 || s.length > 40) return err("name must be 2-40 characters")
  return { ok: true, value: s }
}

export function validateNewRole(
  input: unknown,
  existing: readonly RoleRow[],
): Result<{ slug: string; name: string; rank: number; cloneFrom: string | null; reason: string }> {
  if (!isObj(input)) return err("body must be an object")
  const { slug, rank, cloneFrom } = input
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return err("slug must be lowercase letters, digits or _, 2-20 chars, starting with a letter")
  if (SYSTEM_SLUGS.has(slug)) return err("slug is reserved")
  if (existing.some((r) => r.slug === slug)) return err("slug already exists")
  const name = validateName(input.name)
  if (!name.ok) return name
  if (typeof rank !== "number" || !Number.isInteger(rank) || rank <= 0) return err("rank must be a positive integer")
  if (existing.some((r) => !r.archived_at && r.rank === rank)) return err("rank already in use")
  let clone: string | null = null
  if (cloneFrom !== null && cloneFrom !== undefined) {
    if (typeof cloneFrom !== "string") return err("cloneFrom must be a role slug or null")
    const src = existing.find((r) => r.slug === cloneFrom)
    if (!src || src.archived_at || src.slug === "admin") return err("cloneFrom must be an existing live non-admin role")
    clone = cloneFrom
  }
  const reason = validateReason(input.reason)
  if (!reason.ok) return reason
  return { ok: true, value: { slug, name: name.value, rank, cloneFrom: clone, reason: reason.value } }
}

export function validateRolePatch(
  input: unknown,
): Result<{ name?: string; description?: string | null; badge_color?: BadgeColor; icon?: RoleIcon; theme?: { skin: "default" | "dealer" } }> {
  if (!isObj(input)) return err("body must be an object")
  const keys = Object.keys(input)
  if (keys.length === 0) return err("empty patch")
  const allowed = new Set(["name", "description", "badge_color", "icon", "theme"])
  for (const k of keys) if (!allowed.has(k)) return err(`unknown key: ${k}`)
  const out: { name?: string; description?: string | null; badge_color?: BadgeColor; icon?: RoleIcon; theme?: { skin: "default" | "dealer" } } = {}
  if (has(input, "name")) {
    const n = validateName(input.name)
    if (!n.ok) return n
    out.name = n.value
  }
  if (has(input, "description")) {
    const d = input.description
    if (d !== null && (typeof d !== "string" || d.length > 200)) return err("description must be null or at most 200 characters")
    out.description = d as string | null
  }
  if (has(input, "badge_color")) {
    if (!(BADGE_COLORS as readonly unknown[]).includes(input.badge_color)) return err("invalid badge_color")
    out.badge_color = input.badge_color as BadgeColor
  }
  if (has(input, "icon")) {
    if (!(ROLE_ICONS as readonly unknown[]).includes(input.icon)) return err("invalid icon")
    out.icon = input.icon as RoleIcon
  }
  if (has(input, "theme")) {
    const t = input.theme
    if (!isObj(t) || (t.skin !== "default" && t.skin !== "dealer")) return err('theme.skin must be "default" or "dealer"')
    out.theme = { skin: t.skin }
  }
  return { ok: true, value: out }
}

export function validatePriceChanges(
  input: unknown,
  costs: ReadonlyMap<string, number | null>,
): Result<{ changes: { package_id: string; price: number | null }[]; belowCost: string[] }> {
  if (!Array.isArray(input)) return err("changes must be an array")
  if (input.length > 1000) return err("at most 1000 changes")
  const seen = new Set<string>()
  const changes: { package_id: string; price: number | null }[] = []
  const belowCost: string[] = []
  for (const row of input) {
    if (!isObj(row) || typeof row.package_id !== "string" || !row.package_id) return err("package_id required")
    const id = row.package_id
    if (seen.has(id)) return err(`duplicate package_id: ${id}`)
    seen.add(id)
    if (!costs.has(id)) return err(`unknown package: ${id}`)
    if (!has(row, "price")) return err(`price key required: ${id}`)
    const p = row.price
    if (p === null) {
      changes.push({ package_id: id, price: null })
      continue
    }
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return err(`invalid price for ${id}`)
    const price = round2(p)
    if (price <= 0) return err(`price must be above 0 after rounding: ${id}`)
    const cost = costs.get(id)
    if (cost !== null && cost !== undefined && price < cost) belowCost.push(id)
    changes.push({ package_id: id, price })
  }
  return { ok: true, value: { changes, belowCost } }
}

export function validateRateChanges(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
): Result<{ service_key: string; value: number | null }[]> {
  if (!Array.isArray(input)) return err("rates must be an array")
  if (input.length > 100) return err("too many rate changes")
  const seen = new Set<string>()
  const out: { service_key: string; value: number | null }[] = []
  for (const row of input) {
    if (!isObj(row) || typeof row.service_key !== "string") return err("service_key required")
    const key = row.service_key
    if (!allowedKeys.has(key)) return err(`unknown service_key: ${key}`)
    if (seen.has(key)) return err(`duplicate service_key: ${key}`)
    seen.add(key)
    if (!has(row, "value")) return err(`value key required: ${key}`)
    const v = row.value
    if (v === null) {
      out.push({ service_key: key, value: null })
      continue
    }
    if (typeof v !== "number" || !Number.isFinite(v)) return err(`invalid value for ${key}`)
    const value = round2(v)
    if (value < 0 || value > 100) return err(`value for ${key} must be 0-100`)
    out.push({ service_key: key, value })
  }
  return { ok: true, value: out }
}

export function validateCapabilities(input: unknown): Result<Capability[]> {
  if (!Array.isArray(input)) return err("capabilities must be an array")
  const out: Capability[] = []
  for (const c of input) {
    if (!isCapability(c)) return err("unknown capability")
    if (!out.includes(c)) out.push(c)
  }
  return { ok: true, value: out }
}

export function validateMove(
  input: unknown,
  roles: readonly RoleRow[],
): Result<{ userIds: string[]; toRole: string; reason: string }> {
  if (!isObj(input)) return err("body must be an object")
  const { userIds, toRole } = input
  if (!Array.isArray(userIds) || userIds.length < 1 || userIds.length > 200) return err("userIds must be 1-200 ids")
  const ids: string[] = []
  for (const u of userIds) {
    if (typeof u !== "string" || !UUID_RE.test(u)) return err("userIds must be uuids")
    if (!ids.includes(u)) ids.push(u)
  }
  if (typeof toRole !== "string") return err("toRole required")
  const target = roles.find((r) => r.slug === toRole)
  if (!target || target.archived_at) return err("target role not found")
  if (toRole === "admin" || toRole === "sub_agent") return err("cannot move users to that role")
  const reason = validateReason(input.reason)
  if (!reason.ok) return reason
  return { ok: true, value: { userIds: ids, toRole, reason: reason.value } }
}
