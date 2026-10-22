import type { Environment, KeyStatus } from "./keys"

// PLACEHOLDER: a later task verifies the real role values against the database
// and corrects this constant if needed. Keep it the single source of role names.
export const V2_ROLES: readonly string[] = ["user", "sub_agent", "dealer", "admin"]

export type KeyAction = "approve" | "revoke"

/** Live keys need admin approval; test keys work immediately. */
export function initialStatus(env: Environment): "pending" | "active" {
  return env === "live" ? "pending" : "active"
}

export function applyAction(
  from: KeyStatus,
  action: KeyAction
): { ok: true; to: KeyStatus } | { ok: false; error: string } {
  if (action === "approve") {
    if (from === "pending") return { ok: true, to: "active" }
    return { ok: false, error: `Cannot approve a ${from} key` }
  }
  if (from === "pending" || from === "active") return { ok: true, to: "revoked" }
  return { ok: false, error: `Cannot revoke a ${from} key` }
}

export function parseConfigUpdate(
  input: unknown
): { ok: true; value: { enabled?: boolean; allowed_roles?: string[] } } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Update must be an object" }
  }
  const src = input as Record<string, unknown>
  const value: { enabled?: boolean; allowed_roles?: string[] } = {}

  if (src.enabled !== undefined) {
    if (typeof src.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }
    value.enabled = src.enabled
  }
  if (src.allowed_roles !== undefined) {
    const roles = src.allowed_roles
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string")) {
      return { ok: false, error: "allowed_roles must be an array of strings" }
    }
    const unknown = (roles as string[]).find((r) => !V2_ROLES.includes(r))
    if (unknown !== undefined) return { ok: false, error: `Unknown role: ${unknown}` }
    value.allowed_roles = Array.from(new Set(roles as string[]))
  }
  if (value.enabled === undefined && value.allowed_roles === undefined) {
    return { ok: false, error: "Nothing to update" }
  }
  return { ok: true, value }
}
