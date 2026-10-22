export type LimitGroup = "purchase" | "bulk" | "balance" | "status"

// Requests per minute, per key, per group.
export const DEFAULT_LIMITS: Record<LimitGroup, number> = {
  purchase: 10,
  bulk: 3,
  balance: 30,
  status: 30,
}

const GROUPS = Object.keys(DEFAULT_LIMITS) as LimitGroup[]
const MAX_LIMIT = 10000

function isValidLimit(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LIMIT
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Resolve the effective limit; any corrupt stored override falls back to the default. */
export function resolveLimit(group: LimitGroup, overrides: unknown): number {
  if (isPlainObject(overrides) && Object.prototype.hasOwnProperty.call(overrides, group)) {
    const v = overrides[group]
    if (isValidLimit(v)) return v
  }
  return DEFAULT_LIMITS[group]
}

export function parseLimitOverrides(
  input: unknown
): { ok: true; value: Partial<Record<LimitGroup, number>> } | { ok: false; error: string } {
  if (!isPlainObject(input)) return { ok: false, error: "Limits must be an object" }
  const value: Partial<Record<LimitGroup, number>> = {}
  for (const [k, v] of Object.entries(input)) {
    if (!(GROUPS as string[]).includes(k)) return { ok: false, error: `Unknown limit group: ${k}` }
    if (!isValidLimit(v)) {
      return { ok: false, error: `Limit for ${k} must be an integer between 1 and ${MAX_LIMIT}` }
    }
    value[k as LimitGroup] = v
  }
  return { ok: true, value }
}
