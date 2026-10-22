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

export type KillStep = { ok: true; count?: number } | { ok: false }

export interface KillSummary {
  status: 200 | 500
  body: {
    success: boolean
    message: string
    v1Disabled: boolean
    v2Revoked: number | null
    v2Disabled: boolean
  }
}

/**
 * Pure aggregation for the global kill switch. Each step was attempted independently;
 * the summary reports exactly which succeeded and which did not. Any failure => 500.
 */
export function summarizeKill(r: { v1: KillStep; v2Keys: KillStep; v2Config: KillStep }): KillSummary {
  const v2Count = r.v2Keys.ok ? r.v2Keys.count ?? 0 : null
  const body = {
    v1Disabled: r.v1.ok,
    v2Revoked: v2Count,
    v2Disabled: r.v2Config.ok,
  }
  if (r.v1.ok && r.v2Keys.ok && r.v2Config.ok) {
    return {
      status: 200,
      body: {
        success: true,
        message: `All API keys have been disabled successfully (v1 keys and ${v2Count} v2 keys); the v2 API is now turned off.`,
        ...body,
      },
    }
  }
  const steps: Array<[boolean, string]> = [
    [r.v1.ok, "v1 keys disabled"],
    [r.v2Keys.ok, r.v2Keys.ok ? `${v2Count} v2 keys revoked` : "v2 keys revoked"],
    [r.v2Config.ok, "v2 API turned off"],
  ]
  const succeeded = steps.filter(([ok]) => ok).map(([, label]) => label)
  const failed = steps.filter(([ok]) => !ok).map(([, label]) => label)
  return {
    status: 500,
    body: {
      success: false,
      message:
        `Global kill INCOMPLETE. Succeeded: ${succeeded.length ? succeeded.join(", ") : "nothing"}. ` +
        `Failed: ${failed.join(", ")}. Retry the kill switch.`,
      ...body,
    },
  }
}
