import type { Environment, KeyStatus, KeyType } from "./keys"

/** A v2 key as the developer dashboard sees it (GET /api/user/v2-keys). Never carries the hash or full key. */
export interface V2KeySummary {
  id: string
  key_type: KeyType
  environment: Environment
  status: KeyStatus
  key_prefix: string
  last_used_at: string | null
  created_at: string
  /** Live keys only: the code the developer quotes when messaging the admin. */
  request_code?: string | null
}

export type SlotState = "none" | "pending" | "active" | "revoked"

/**
 * The key shown in one (type, environment) slot of the dashboard. An active key wins (it is the one that
 * works); a pending key waiting to replace it is returned as `replacement`. Otherwise a pending key, then the
 * newest one. Only an exact `active` status reads as active: a pending live key must never look usable, and
 * an unknown status is treated as revoked.
 */
export function slotFor(
  keys: V2KeySummary[],
  type: KeyType,
  env: Environment
): { state: SlotState; key: V2KeySummary | null; replacement: V2KeySummary | null } {
  const mine = keys
    .filter((k) => k.key_type === type && k.environment === env)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const active = mine.find((k) => k.status === "active") ?? null
  const pending = mine.find((k) => k.status === "pending") ?? null
  if (active) return { state: "active", key: active, replacement: pending }
  if (pending) return { state: "pending", key: pending, replacement: null }
  const key = mine[0] ?? null
  if (!key) return { state: "none", key: null, replacement: null }
  return { state: "revoked", key, replacement: null }
}
