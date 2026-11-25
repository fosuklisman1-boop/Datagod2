import {
  MSG_PENDING,
  MSG_REVOKED,
  MSG_SUSPENDED,
  MSG_ROLE_NOT_ALLOWED,
  MSG_UNAVAILABLE,
  MSG_PAUSED,
  MSG_SERVICE_PAUSED_DEFAULT,
  MSG_DAILY_LIMIT,
  MSG_DAILY_LIMIT_ADMIN,
  msgWrongKeyType,
} from "./access"
import type { KeyType } from "./keys"

/**
 * The `error_reason` stored on api_v2_logs. It is shown to developers on a dashboard, so it is ONLY ever a
 * short slug from a closed set: never message text, phones, emails, keys or bodies.
 */

/** Access denials, matched by exact message constant (never by substring). */
const ACCESS_REASONS: ReadonlyMap<string, string> = new Map([
  [MSG_PENDING, "key_pending"],
  [MSG_REVOKED, "key_revoked"],
  [MSG_SUSPENDED, "account_suspended"],
  [MSG_ROLE_NOT_ALLOWED, "not_eligible"],
  [MSG_UNAVAILABLE, "unavailable"],
  [MSG_PAUSED, "developer_paused"],
  // Release 5: one slug for both daily-limit messages; the risk scan counts it.
  [MSG_DAILY_LIMIT, "daily_limit"],
  [MSG_DAILY_LIMIT_ADMIN, "daily_limit"],
  [MSG_SERVICE_PAUSED_DEFAULT, "service_paused"],
])

const KEY_TYPES: readonly KeyType[] = ["standard", "commission", "sms"]
const WRONG_KEY_TYPE_MESSAGES: ReadonlySet<string> = new Set(KEY_TYPES.map((t) => msgWrongKeyType(t)))

/**
 * Closed set of the uppercase codes that begin API error messages ("OUTCOME_UNKNOWN: ..."). Sources:
 *  - literal MSG_* constants and fixed messages in bundles.ts and endpoints/{afa,airtime,bills,bundles,data,results,sms}.ts
 *  - `${r.code}: ...` messages built from sms-rules.ts smsErrorResponse and the airtime/AFA error responses
 *    in commission.ts and standard-orders.ts
 * A leading token that is not in this set is never turned into a slug.
 */
export const LOG_REASON_CODES: ReadonlySet<string> = new Set([
  // endpoint messages
  "BILLER_UNAVAILABLE",
  "BUNDLE_TOKEN_EXPIRED",
  "BUNDLE_UNAVAILABLE_FOR_NUMBER",
  "DUPLICATE_REGISTRATION",
  "INSUFFICIENT_BALANCE",
  "INTERNAL_ERROR",
  "INVALID_AMOUNT",
  "INVALID_REQUEST",
  "INVALID_TOKEN",
  "LOOKUP_FAILED",
  "NETWORK_MISMATCH",
  "NOT_ATTEMPTED",
  "NOT_AVAILABLE",
  "OUT_OF_STOCK",
  "OUTCOME_UNKNOWN",
  "PHONE_NOT_VERIFIED",
  "PRICE_CHANGED",
  "RECIPIENT_NOT_REGISTERED",
  "REFERENCE_REUSED",
  "REQUEST_IN_PROGRESS",
  "SMS_NOT_ENABLED",
  "UNAVAILABLE",
  "VERIFY_AGAIN",
  "VOUCHERS_UNAVAILABLE",
  // sms-rules.ts smsErrorResponse
  "BLOCKED",
  "EMPTY_MESSAGE",
  "INSUFFICIENT_CREDITS",
  "INVALID_SENDER_ID",
  "NO_VALID_RECIPIENTS",
  "NOT_ACTIVATED",
  "POLICY_REJECTED",
  "SEND_IN_PROGRESS",
  "SMS_DISABLED",
  "SUSPENDED",
  "TOO_MANY_RECIPIENTS",
  // commission.ts airtimeErrorResponse and standard-orders.ts afaErrorResponse
  "DUPLICATE_REQUEST",
  "INVALID_GHANA_CARD",
  "NETWORK_DISABLED",
  "ORDER_CREATE_FAILED",
  "PAYMENT_FAILED",
  "PRICE_UNAVAILABLE",
])

const LEADING_CODE = /^([A-Z][A-Z0-9_]*): /

export function logReason(status: number, message?: string): string | null {
  if (status >= 200 && status <= 299) return null
  if (typeof message === "string") {
    const access = ACCESS_REASONS.get(message)
    if (access) return access
    if (WRONG_KEY_TYPE_MESSAGES.has(message)) return "wrong_key_type"
    const code = LEADING_CODE.exec(message)?.[1]
    if (code && LOG_REASON_CODES.has(code)) return code.toLowerCase()
  }
  return `http_${status}`
}
