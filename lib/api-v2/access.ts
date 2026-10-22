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
}

export function decideAccess(
  i: AccessInput
): { ok: true } | { ok: false; status: 403 | 503; message: string } {
  if (!i.configEnabled) {
    return { ok: false, status: 503, message: "This API is currently unavailable" }
  }
  if (i.keyStatus === "pending") {
    return { ok: false, status: 403, message: "This API key is awaiting approval" }
  }
  if (i.keyStatus === "revoked") {
    return { ok: false, status: 403, message: "This API key has been revoked" }
  }
  if (i.keyType !== i.requiredType) {
    return {
      ok: false,
      status: 403,
      message: `This endpoint requires a ${i.requiredType} key`,
    }
  }
  if (!i.allowedRoles.includes(i.userRole)) {
    return { ok: false, status: 403, message: "Your account is not permitted to use this API" }
  }
  return { ok: true }
}
