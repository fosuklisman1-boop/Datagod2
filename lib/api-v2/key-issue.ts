import type { KeyType } from "./keys"

const ISSUABLE_TYPES: readonly string[] = ["standard", "commission"]
const KNOWN_TYPES: readonly string[] = ["standard", "commission", "sms"]

export type CanIssueResult = { ok: true } | { ok: false; status: 400 | 403 | 503; message: string }

export const MSG_V2_NOT_OPEN = "The v2 API is not open yet, so keys cannot be generated right now"

/** Type guard so the route can narrow unvalidated input after canIssue says ok. */
export function isIssuableType(type: string): type is KeyType {
  return ISSUABLE_TYPES.includes(type)
}

/**
 * Pure eligibility decision for issuing a v2 key. Order: v2 switched off (503), then type
 * validity (400), then suspension (403), then role (403). The 503 matches what GET's access
 * answer says (`disabled` first), so a direct POST cannot mint keys while v2 is dark.
 * `sms` is a known type but not issuable until the SMS plan replaces this branch.
 */
export function canIssue(input: {
  enabled: boolean
  type: KeyType | string
  role: string
  allowedRoles: string[]
  suspended: boolean
}): CanIssueResult {
  if (!input.enabled) {
    return { ok: false, status: 503, message: MSG_V2_NOT_OPEN }
  }
  if (!KNOWN_TYPES.includes(input.type)) {
    return { ok: false, status: 400, message: "Invalid key_type" }
  }
  if (input.type === "sms") {
    return { ok: false, status: 400, message: "SMS keys are not available yet" }
  }
  if (input.suspended) {
    return { ok: false, status: 403, message: "This account is suspended" }
  }
  if (!input.allowedRoles.includes(input.role)) {
    return { ok: false, status: 403, message: "Your account is not eligible for API keys" }
  }
  return { ok: true }
}

export type AccessReason = "ok" | "disabled" | "suspended" | "role_not_allowed"
export interface AccessSummary {
  canGenerate: boolean
  reason: AccessReason
}

/**
 * What the developer dashboard shows before any generate attempt. Order: v2 disabled,
 * then suspension, then role. `canGenerate` is true exactly when `reason === "ok"`.
 */
export function accessSummary(input: {
  role: string
  suspended: boolean
  enabled: boolean
  allowedRoles: string[]
}): AccessSummary {
  if (!input.enabled) return { canGenerate: false, reason: "disabled" }
  if (input.suspended) return { canGenerate: false, reason: "suspended" }
  if (!input.allowedRoles.includes(input.role)) return { canGenerate: false, reason: "role_not_allowed" }
  return { canGenerate: true, reason: "ok" }
}

/** The dashboard's view of v2 access: the server's reason, or still loading, or the load failed. */
export type DashboardAccessState = AccessReason | "loading" | "error"

/**
 * Whether the Legacy v1 section starts open. While v2 is not open (or we do not know yet because
 * access is loading or failed to load) existing v1 integrators must see their working keys straight
 * away; once v2 is open the section starts collapsed. The user can toggle it either way afterwards.
 */
export function legacyDefaultOpen(state: DashboardAccessState): boolean {
  return state === "disabled" || state === "loading" || state === "error"
}
