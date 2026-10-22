import type { KeyStatus } from "./keys"
import { applyAction } from "./lifecycle"
import { parseLimitOverrides } from "./limits"

export type KeyPatchPlan =
  | { ok: true; update: Record<string, unknown> }
  | { ok: false; status: 400 | 409; error: string }

/**
 * Pure decision for an admin PATCH on a v2 key. The route adds approved_by /
 * revoked_by from the authenticated admin; everything else is decided here.
 */
export function planKeyPatch(current: { status: KeyStatus }, body: unknown, now: Date): KeyPatchPlan {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Body must be an object" }
  }
  const src = body as Record<string, unknown>
  const ts = now.toISOString()

  switch (src.action) {
    case "approve": {
      const r = applyAction(current.status, "approve")
      if (!r.ok) return { ok: false, status: 409, error: r.error }
      return { ok: true, update: { status: r.to, approved_at: ts, updated_at: ts } }
    }
    case "revoke": {
      const r = applyAction(current.status, "revoke")
      if (!r.ok) return { ok: false, status: 409, error: r.error }
      return { ok: true, update: { status: r.to, revoked_at: ts, updated_at: ts } }
    }
    case "set_limits": {
      const parsed = parseLimitOverrides(src.limits)
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
      if (current.status === "revoked") {
        return { ok: false, status: 409, error: "Cannot change limits on a revoked key" }
      }
      return { ok: true, update: { rate_limits: parsed.value, updated_at: ts } }
    }
    case "reset_limits": {
      if (current.status === "revoked") {
        return { ok: false, status: 409, error: "Cannot change limits on a revoked key" }
      }
      return { ok: true, update: { rate_limits: null, updated_at: ts } }
    }
    default:
      return { ok: false, status: 400, error: "Unknown action" }
  }
}
