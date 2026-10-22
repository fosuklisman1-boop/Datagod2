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
}

export type SlotState = "none" | "pending" | "active" | "revoked"

/**
 * The key shown in one (type, environment) slot of the dashboard. A pending or active key wins over
 * a revoked one; otherwise newest first. Only an exact `active` status reads as active: a pending
 * live key must never look usable, and an unknown status is treated as revoked.
 */
export function slotFor(
  keys: V2KeySummary[],
  type: KeyType,
  env: Environment
): { state: SlotState; key: V2KeySummary | null } {
  const mine = keys
    .filter((k) => k.key_type === type && k.environment === env)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const live = mine.find((k) => k.status === "pending" || k.status === "active")
  const key = live ?? mine[0] ?? null
  if (!key) return { state: "none", key: null }
  const state: SlotState = key.status === "active" ? "active" : key.status === "pending" ? "pending" : "revoked"
  return { state, key }
}
