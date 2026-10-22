import type { KeyType } from "./keys"

const ISSUABLE_TYPES: readonly string[] = ["standard", "commission"]
const KNOWN_TYPES: readonly string[] = ["standard", "commission", "sms"]

export type CanIssueResult = { ok: true } | { ok: false; status: 400 | 403; message: string }

/** Type guard so the route can narrow unvalidated input after canIssue says ok. */
export function isIssuableType(type: string): type is KeyType {
  return ISSUABLE_TYPES.includes(type)
}

/**
 * Pure eligibility decision for issuing a v2 key. Order: type validity (400),
 * then suspension (403), then role (403).
 * `sms` is a known type but not issuable until the SMS plan replaces this branch.
 */
export function canIssue(input: {
  type: KeyType | string
  role: string
  allowedRoles: string[]
  suspended: boolean
}): CanIssueResult {
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
