import type { KeyType, KeyStatus } from "./keys"

const MAX_KEY_LENGTH = 512

/**
 * Pull the raw key from the request headers. Authorization (raw or "Bearer <key>")
 * takes precedence over X-API-Key. Returns null for missing, blank or oversize values.
 */
export function extractKey(headers: { get(name: string): string | null }): string | null {
  let value = headers.get("authorization") ?? headers.get("x-api-key")
  if (value === null) return null
  value = value.trim()
  if (/^bearer(\s|$)/i.test(value)) value = value.slice(6).trim()
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) return null
  return value
}

export interface AccessInput {
  keyStatus: KeyStatus
  keyType: KeyType
  requiredType: KeyType
  configEnabled: boolean
  allowedRoles: string[]
  userRole: string
  suspended: boolean
}

export const MSG_UNAUTHORIZED = "Invalid or missing API key"
export const MSG_UNAVAILABLE = "This API is currently unavailable"
export const MSG_SUSPENDED = "This account is suspended"
export const MSG_PENDING = "This API key is awaiting approval"
export const MSG_REVOKED = "This API key has been revoked"
export const MSG_ROLE_NOT_ALLOWED = "Your account is not permitted to use this API"
export const MSG_RATE_LIMITED = "Rate limit exceeded"
export const msgWrongKeyType = (required: string) => `This endpoint requires a ${required} key`

/**
 * Order: config disabled (503) > account suspended > key status (pending, revoked)
 * > key type > role. All denials except the first are 403.
 */
export function decideAccess(
  i: AccessInput
): { ok: true } | { ok: false; status: 403 | 503; message: string } {
  if (!i.configEnabled) {
    return { ok: false, status: 503, message: MSG_UNAVAILABLE }
  }
  if (i.suspended) {
    return { ok: false, status: 403, message: MSG_SUSPENDED }
  }
  if (i.keyStatus === "pending") {
    return { ok: false, status: 403, message: MSG_PENDING }
  }
  if (i.keyStatus === "revoked") {
    return { ok: false, status: 403, message: MSG_REVOKED }
  }
  if (i.keyType !== i.requiredType) {
    return {
      ok: false,
      status: 403,
      message: msgWrongKeyType(i.requiredType),
    }
  }
  if (!i.allowedRoles.includes(i.userRole)) {
    return { ok: false, status: 403, message: MSG_ROLE_NOT_ALLOWED }
  }
  return { ok: true }
}
