import type { Environment, KeyStatus } from "./keys"
import { parseApprovalContact } from "./approval-contact"

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

export interface ConfigUpdate {
  enabled?: boolean
  allowed_roles?: string[]
  /** Digits, or null to clear. Present only when the request carried an approval_whatsapp property. */
  approval_whatsapp?: string | null
}

/**
 * Shape-checks a config update. `activeRoles` is every slug a requested role may be (the caller decides
 * what that means: the slugs already stored plus, when the set changes, the active rows in `roles`).
 * approval_whatsapp is parsed ONLY when the property is present: parseApprovalContact(undefined) means
 * "clear", so an enabled-only or roles-only save must never reach it.
 */
export function parseConfigUpdate(
  input: unknown,
  activeRoles: readonly string[]
): { ok: true; value: ConfigUpdate } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Update must be an object" }
  }
  const src = input as Record<string, unknown>
  const value: ConfigUpdate = {}

  if (src.enabled !== undefined) {
    if (typeof src.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" }
    value.enabled = src.enabled
  }
  if (src.allowed_roles !== undefined) {
    const roles = src.allowed_roles
    if (!Array.isArray(roles) || !roles.every((r) => typeof r === "string")) {
      return { ok: false, error: "allowed_roles must be an array of strings" }
    }
    const unknown = (roles as string[]).find((r) => !activeRoles.includes(r))
    if (unknown !== undefined) return { ok: false, error: `Unknown role: ${unknown}` }
    value.allowed_roles = Array.from(new Set(roles as string[]))
  }
  if (Object.prototype.hasOwnProperty.call(src, "approval_whatsapp")) {
    const c = parseApprovalContact(src.approval_whatsapp)
    if (!c.ok) return { ok: false, error: c.error }
    value.approval_whatsapp = c.digits
  }
  if (value.enabled === undefined && value.allowed_roles === undefined && value.approval_whatsapp === undefined) {
    return { ok: false, error: "Nothing to update" }
  }
  return { ok: true, value }
}
