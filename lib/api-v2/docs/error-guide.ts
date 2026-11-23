// Error guide data for the public /developers/errors page. Pure: no I/O.
// Every distinct (status, message) pair in the docs registry is grouped under a stable anchor and given
// advice. A pair with no advice throws, so a new registry error cannot ship without a documented fix.

import { v2DocsRegistry, type V2DocSection } from "./registry"
import { errorAnchor, errorCode } from "./error-key"
import { endpointHref } from "./pages"
import { MSG_UNAUTHORIZED, MSG_UNAVAILABLE, MSG_SUSPENDED, MSG_PENDING, MSG_REVOKED, MSG_ROLE_NOT_ALLOWED, MSG_RATE_LIMITED } from "../access"

export type ErrorGroup =
  | "Access and keys"
  | "Validation"
  | "Money"
  | "References and idempotency"
  | "Orders and lookups"
  | "Availability"
  | "Providers and upstream"

export interface GuideError {
  anchor: string
  status: number
  code: string | null
  group: ErrorGroup
  messages: string[]
  meaning: string
  fix: string
  endpoints: { id: string; method: "GET" | "POST"; path: string; href: string }[]
}

export const GROUP_ORDER: readonly ErrorGroup[] = [
  "Access and keys",
  "Validation",
  "Money",
  "References and idempotency",
  "Orders and lookups",
  "Availability",
  "Providers and upstream",
]

interface Advice {
  group: ErrorGroup
  meaning: string
  fix: string
}

const PREFIX = /^orders\[i\]:\s*/

const DO_NOT_REORDER =
  "Do not place the order again under a new reference. Poll the order by the same reference (its claim.state reports the outcome), or contact support quoting the reference."

// 1. Advice by error code. A "CODE:status" key overrides the plain "CODE" key.
const ERROR_ADVICE: Record<string, Advice> = {
  // Validation
  BLOCKED: {
    group: "Validation",
    meaning: "The SMS content was refused because it contains content Datagod cannot send.",
    fix: "Change the message text and send again with a new reference.",
  },
  EMPTY_MESSAGE: {
    group: "Validation",
    meaning: "The SMS message has no text left after Datagod prepared it for sending.",
    fix: "Send a message with real text content.",
  },
  INVALID_AMOUNT: {
    group: "Validation",
    meaning: "The amount is outside the range, or has more decimals than, the biller or network allows.",
    fix: "Use an amount inside the documented range (see the biller list for utility bills) and resend. Nothing was charged.",
  },
  INVALID_REQUEST: {
    group: "Validation",
    meaning: "The request was refused: the account details or payment details are not valid for this biller or bundle.",
    fix: "Check the details against the biller list or the catalog and resend. Nothing was charged.",
  },
  INVALID_SENDER_ID: {
    group: "Validation",
    meaning: "The sender_id is not available for your account.",
    fix: "List your senders with GET /sms/senders and use one of them.",
  },
  INVALID_TOKEN: {
    group: "Validation",
    meaning:
      "The verify_token or bundle_token is invalid or expired, or it was made with the other key environment (a sandbox token with a live key, or the reverse).",
    fix: "Fetch a fresh token with the same kind of key you are paying with (lookup for bills, catalog for bundles) and resend. Nothing was charged.",
  },
  NETWORK_MISMATCH: {
    group: "Validation",
    meaning: "The recipient number does not belong to the network you selected.",
    fix: "Send the number to its own network, or correct the number. Nothing was charged.",
  },
  NO_VALID_RECIPIENTS: {
    group: "Validation",
    meaning: "None of the recipients is a valid phone number.",
    fix: "Send at least one valid Ghana mobile number.",
  },
  POLICY_REJECTED: {
    group: "Validation",
    meaning: "The send was not accepted by the sending policy.",
    fix: "Review the message and recipients, then try again with a new reference, or contact support.",
  },
  TOO_MANY_RECIPIENTS: {
    group: "Validation",
    meaning: "The send has more than 5000 recipients.",
    fix: "Split the list into sends of at most 5000 recipients, each with its own reference.",
  },

  // Money
  INSUFFICIENT_BALANCE: {
    group: "Money",
    meaning: "The wallet balance (or the sandbox test balance) is too low for this purchase.",
    fix: "Top up the wallet and resend with the same reference. Nothing was charged.",
  },
  INSUFFICIENT_CREDITS: {
    group: "Money",
    meaning: "Your account does not have enough SMS credits for this send.",
    fix: "Buy more SMS credits, then send again.",
  },
  PRICE_CHANGED: {
    group: "Money",
    meaning: "The price changed since you last looked, so it no longer matches your expected_pay.",
    fix: "Review the new price in the message and resend with the new expected_pay.",
  },

  // References and idempotency
  DUPLICATE_REGISTRATION: {
    group: "References and idempotency",
    meaning: "A registration for this customer was just submitted.",
    fix: "Look the registration up under its original reference. Do not resubmit under a new reference.",
  },
  DUPLICATE_REQUEST: {
    group: "References and idempotency",
    meaning: "An identical airtime order was just placed.",
    fix: "Look it up under its original reference. Resend under a new reference only if you intend a second identical order.",
  },
  "OUTCOME_UNKNOWN:409": {
    group: "References and idempotency",
    meaning: "An earlier request with this reference has no confirmed outcome yet.",
    fix: DO_NOT_REORDER,
  },
  "OUTCOME_UNKNOWN:500": {
    group: "References and idempotency",
    meaning: "The outcome of this request is not confirmed yet, so it may or may not have gone through.",
    fix: DO_NOT_REORDER,
  },
  REFERENCE_REUSED: {
    group: "References and idempotency",
    meaning: "This reference was already used for a different order, or this verification already paid another reference.",
    fix: "Use a new, unique reference for a new order. Only reuse a reference to retry the identical request.",
  },
  REQUEST_IN_PROGRESS: {
    group: "References and idempotency",
    meaning: "A request with this reference is still being processed and its outcome is not confirmed yet.",
    fix: DO_NOT_REORDER,
  },
  SEND_IN_PROGRESS: {
    group: "References and idempotency",
    meaning: "Another send from your account is still being processed.",
    fix: "Retry this same request with the same reference in a few seconds.",
  },

  // Orders and lookups
  BUNDLE_TOKEN_EXPIRED: {
    group: "Orders and lookups",
    meaning: "The bundle_token is invalid or has expired.",
    fix: "Fetch the catalog again with GET /bundles/catalog and use the new token. Nothing was charged.",
  },
  BUNDLE_UNAVAILABLE_FOR_NUMBER: {
    group: "Orders and lookups",
    meaning: "This bundle is not offered for that number right now.",
    fix: "Fetch the catalog again with GET /bundles/catalog and pick an offered bundle. Nothing was charged.",
  },
  OUT_OF_STOCK: {
    group: "Orders and lookups",
    meaning: "The vouchers are out of stock for the quantity you asked for.",
    fix: "Try a smaller quantity or try again later. Nothing was charged.",
  },
  RECIPIENT_NOT_REGISTERED: {
    group: "Orders and lookups",
    meaning: "The recipient number is not registered for MTN data.",
    fix: "Ask the customer to register the number, or use a number that is registered. Nothing was charged.",
  },
  VERIFY_AGAIN: {
    group: "Orders and lookups",
    meaning: "This verification can no longer be used.",
    fix: "Verify the account again with POST /utilities/lookup and pay with the new verify_token. Nothing was charged.",
  },

  // Availability
  BILLER_UNAVAILABLE: {
    group: "Availability",
    meaning: "This biller is currently unavailable.",
    fix: "Try again later, or try a different biller.",
  },
  NETWORK_DISABLED: {
    group: "Availability",
    meaning: "Airtime for this network is currently unavailable.",
    fix: "Try again later.",
  },
  NOT_AVAILABLE: {
    group: "Availability",
    meaning: "This service is not available on the API right now.",
    fix: "Try again later, or contact support.",
  },
  PRICE_UNAVAILABLE: {
    group: "Availability",
    meaning: "AFA registration is temporarily unavailable because the price could not be read.",
    fix: "Try again later.",
  },
  SMS_DISABLED: {
    group: "Availability",
    meaning: "SMS is temporarily unavailable.",
    fix: "Try again later.",
  },
  UNAVAILABLE: {
    group: "Availability",
    meaning: "A required service or the reference reservation is temporarily unavailable.",
    fix: "Retry the same request with the same reference after a short wait. Nothing was charged.",
  },
  VOUCHERS_UNAVAILABLE: {
    group: "Availability",
    meaning: "Your order was placed and charged, but its vouchers could not be read right now.",
    fix: "Retry with the same reference, or contact support. Do not place a new order.",
  },

  // Providers and upstream
  INTERNAL_ERROR: {
    group: "Providers and upstream",
    meaning: "Datagod could not complete the step on its side.",
    fix: "Retry the same request with the same reference. If it keeps failing, contact support quoting the reference.",
  },
  LOOKUP_FAILED: {
    group: "Providers and upstream",
    meaning: "The biller could not verify this account.",
    fix: "Check the account details and retry the lookup.",
  },

  // Access and keys (account-level codes)
  NOT_ACTIVATED: {
    group: "Access and keys",
    meaning: "SMS is not activated for this account.",
    fix: "Ask Datagod to activate SMS for your account.",
  },
  PHONE_NOT_VERIFIED: {
    group: "Access and keys",
    meaning: "The phone number on your account has not been verified.",
    fix: "Verify your account phone number in the dashboard, then resend.",
  },
  SMS_NOT_ENABLED: {
    group: "Access and keys",
    meaning: "SMS is not enabled for this account.",
    fix: "Enable SMS for your account on the Developer API page, or contact support.",
  },
  SUSPENDED: {
    group: "Access and keys",
    meaning: "SMS is suspended for this account.",
    fix: "Contact support to find out why and to lift the suspension.",
  },
}

// 2. The eight standard access messages (the wrong-key-type message exists once per key type).
const ACCESS_ADVICE: Record<string, { meaning: string; fix: string }> = {
  [MSG_UNAUTHORIZED]: {
    meaning: "The key is missing, malformed or unknown.",
    fix: "Send your API key in the Authorization header (or X-API-Key) exactly as it was shown when generated.",
  },
  [MSG_SUSPENDED]: {
    meaning: "The account that owns the key is suspended.",
    fix: "Contact support to find out why and to lift the suspension.",
  },
  [MSG_PENDING]: {
    meaning: "A live key stays pending until Datagod approves it, and every call returns 403 until then.",
    fix: "Use the Message admin button on the Developer API page so the admin can approve it. Test keys need no approval.",
  },
  [MSG_REVOKED]: {
    meaning: "The key was revoked, either by you or because a replacement key took over.",
    fix: "Generate a new key on the Developer API page and update your integration.",
  },
  [MSG_ROLE_NOT_ALLOWED]: {
    meaning: "Your account type is not allowed to use the API.",
    fix: "Use Request API access on the dashboard, then message the admin with the code shown.",
  },
  [MSG_RATE_LIMITED]: {
    meaning: "You sent more requests than the rate limit allows for this key.",
    fix: "Slow down and retry after a short wait. Test and live keys have separate counters.",
  },
  [MSG_UNAVAILABLE]: {
    meaning: "The API is switched off right now.",
    fix: "Try again later.",
  },
}

const WRONG_KEY = /^This endpoint requires a (standard|commission|sms) key$/
const WRONG_KEY_ADVICE = {
  meaning: "The key's type cannot call this endpoint group.",
  fix: "Use a key of the type named in the message: standard for data, wallet, results checker and AFA, commission for airtime, utility bills and Standard Bundles, sms for SMS.",
}

// Code-less messages with their own wording. Looked up by exact text (orders[i]: prefix removed).
const MESSAGE_ADVICE: Record<string, Advice> = {
  "Unexpected field": {
    group: "Validation",
    meaning: "The request body contains a field this endpoint does not accept.",
    fix: "Remove the extra field and resend. Nothing was charged.",
  },
  "Request body must be a JSON object": {
    group: "Validation",
    meaning: "The request body is missing, is not valid JSON, or is not a JSON object.",
    fix: "Send a JSON object as the body with the Content-Type: application/json header and resend. Nothing was charged.",
  },
  "Duplicate reference in batch": {
    group: "Validation",
    meaning: "Two orders in the same bulk call use the same reference.",
    fix: "Give every order in the batch its own unique reference and resend. Nothing was charged.",
  },
  "Package not found or unavailable": {
    group: "Validation",
    meaning: "The package named in the bulk order does not exist or is not available.",
    fix: "List packages with GET /packages and use an available one. Nothing was charged.",
  },
  "Pick a time at least 2 minutes from now": {
    group: "Validation",
    meaning: "scheduled_at is too close to now.",
    fix: "Schedule the send at least 2 minutes ahead, or leave scheduled_at out to send now.",
  },
  "Send a valid date and time with a timezone (ISO 8601, e.g. 2026-10-12T14:30:00Z)": {
    group: "Validation",
    meaning: "scheduled_at is not a valid date and time with a timezone.",
    fix: "Send an ISO 8601 date and time with a timezone, for example 2026-10-12T14:30:00Z.",
  },
  "You can schedule up to 30 days ahead": {
    group: "Validation",
    meaning: "scheduled_at is more than 30 days away.",
    fix: "Schedule the send within 30 days.",
  },
}

// 3. A 400 message that starts with a field name, or orders[i]:, is a field-validation error.
const FIELD_MESSAGE = /^(?:orders\[i\]:|[a-z][a-z0-9_]*\s+(?:must|is)\b)/

const VALIDATION_ADVICE: Advice = {
  group: "Validation",
  meaning: "The field named in the message is missing or malformed.",
  fix: "Correct the named field and resend; nothing was charged.",
}

// 4. Status rules, only for 404 "not found" messages and code-less 500, 502 and 503 messages.
const RETRY_FIX =
  "Retry the same request (with the same reference for a purchase). If it keeps failing, contact support quoting the reference."

function statusAdvice(status: number, message: string): Advice | null {
  if (status === 404 && /not found/i.test(message)) {
    return {
      group: "Orders and lookups",
      meaning: "The order, package or campaign named in the message was not found.",
      fix: "Check the reference, id or package you sent and use a valid one.",
    }
  }
  if (status === 500 || status === 502) {
    return {
      group: "Providers and upstream",
      meaning: "Datagod or an upstream provider could not complete the request, so its outcome may not be confirmed.",
      fix: RETRY_FIX,
    }
  }
  if (status === 503) {
    return {
      group: "Availability",
      meaning: "The service is temporarily unavailable.",
      fix: RETRY_FIX,
    }
  }
  return null
}

function adviceFor(status: number, message: string): Advice {
  const code = errorCode(message)
  if (code) {
    const found = ERROR_ADVICE[`${code}:${status}`] ?? ERROR_ADVICE[code]
    if (found) return found
  } else {
    const access = ACCESS_ADVICE[message] ?? (WRONG_KEY.test(message) ? WRONG_KEY_ADVICE : undefined)
    if (access) return { group: "Access and keys", ...access }
    const bare = message.replace(PREFIX, "")
    const specific = MESSAGE_ADVICE[bare]
    if (specific) return specific
    if (status === 400 && FIELD_MESSAGE.test(message)) return VALIDATION_ADVICE
    const byStatus = statusAdvice(status, message)
    if (byStatus) return byStatus
  }
  throw new Error(`No advice for ${status} ${message}`)
}

export function buildErrorGuide(registry: V2DocSection[] = v2DocsRegistry): GuideError[] {
  const byAnchor = new Map<string, GuideError>()
  for (const section of registry) {
    for (const endpoint of section.endpoints) {
      for (const err of endpoint.errors) {
        const advice = adviceFor(err.status, err.message)
        const anchor = errorAnchor(err.status, err.message)
        let entry = byAnchor.get(anchor)
        if (!entry) {
          entry = {
            anchor,
            status: err.status,
            code: errorCode(err.message),
            group: advice.group,
            messages: [],
            meaning: advice.meaning,
            fix: advice.fix,
            endpoints: [],
          }
          byAnchor.set(anchor, entry)
        }
        if (!entry.messages.includes(err.message)) entry.messages.push(err.message)
        if (!entry.endpoints.some((e) => e.id === endpoint.id)) {
          entry.endpoints.push({
            id: endpoint.id,
            method: endpoint.method,
            path: endpoint.path,
            href: endpointHref(registry, endpoint.id),
          })
        }
      }
    }
  }
  return [...byAnchor.values()].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.status - b.status ||
      (a.code ?? "~").localeCompare(b.code ?? "~") ||
      a.anchor.localeCompare(b.anchor),
  )
}

export function filterErrorGuide(entries: readonly GuideError[], query: string): GuideError[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter((e) =>
    [String(e.status), e.code ?? "", ...e.messages, e.meaning, e.fix].some((s) => s.toLowerCase().includes(q)),
  )
}
