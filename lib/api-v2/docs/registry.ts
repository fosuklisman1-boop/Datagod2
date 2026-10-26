import type { KeyType } from "../keys"
import {
  MSG_UNAUTHORIZED,
  MSG_UNAVAILABLE,
  MSG_SUSPENDED,
  MSG_PENDING,
  MSG_REVOKED,
  MSG_ROLE_NOT_ALLOWED,
  MSG_RATE_LIMITED,
  msgWrongKeyType,
} from "../access"
import { DEFAULT_LIMITS } from "../limits"
import {
  MSG_PACKAGE_NOT_FOUND,
  MSG_NETWORK_MISMATCH,
  MSG_REFERENCE_REUSED,
  MSG_NOT_REGISTERED,
  MSG_ORDER_FAILED,
  MSG_ORDER_NOT_FOUND,
  MSG_LOOKUP_FAILED,
  MSG_UNAVAILABLE as MSG_CATALOG_UNAVAILABLE,
  MSG_PHONE_GATE,
  MSG_NOT_ATTEMPTED,
  BULK_DEADLINE_MS,
} from "../endpoints/data"

export type DocLang = "curl" | "node" | "php" | "python"

export interface V2Param {
  name: string
  type: string
  required: boolean
  description: string
}

export interface V2Endpoint {
  id: string
  group: "start" | "data" | "commission" | "results" | "sms" | "sandbox"
  method: "GET" | "POST"
  path: string
  keyType: KeyType | null
  rateLimit: string
  summary: string
  params: V2Param[]
  requestExample: object | null
  successExample: object
  errors: { status: number; message: string }[]
  notes: string[]
}

export interface V2DocCallout {
  tone: "info" | "warning"
  title?: string
  body: string
}

export interface V2DocSection {
  id: string
  label: string
  group: V2Endpoint["group"]
  intro?: string
  steps?: string[]
  callouts?: V2DocCallout[]
  endpoints: V2Endpoint[]
}

// The api.datagod.store host rewrite ships in plan 8. Until then api.datagod.store
// serves the main app, so v2 is reached under /api/v2 on www. When the plan-8
// rewrite is live, flip this to "https://api.datagod.store/v2" (and its tests).
export const V2_BASE_URL = "https://www.datagod.store/api/v2"

const TS = "2026-10-22T09:30:00.000Z"

const START_SECTIONS: V2DocSection[] = [
  {
    id: "overview",
    label: "Overview",
    group: "start",
    intro:
      "The Datagod Developer API lets approved partners work with their Datagod account from their own software: check your wallet balance and account role, buy data bundles, buy airtime and pay utility bills. Results checkers, AFA registration and SMS are not part of this release. Every request is made over HTTPS to " +
      V2_BASE_URL +
      ", is authenticated with an API key, and returns JSON in a single consistent envelope. Version 1 of the API keeps working unchanged for existing integrations; v2 runs beside it.",
    endpoints: [],
  },
  {
    id: "authentication",
    label: "Authentication",
    group: "start",
    intro:
      "Send your API key on every request. The preferred form is the Authorization header containing the raw key. Two equivalent forms are also accepted: Authorization: Bearer <key>, and the X-API-Key header. If more than one is sent, Authorization wins. A missing, malformed or unknown key returns 401. The key's type decides which endpoints it can call: a standard key calls the data, wallet and account endpoints, and a commission key calls the airtime and utility bill endpoints. A key of the wrong type returns 403.",
    steps: [
      "Log in to your Datagod account with a role that is allowed to use the API (the allowed roles are set by Datagod and can change).",
      "Open Dashboard, then Developer API.",
      "Choose the key type and environment you need, then generate the key.",
      "Copy the key and store it somewhere safe, such as a secrets manager or an environment variable on your server.",
      "For a live key, wait for admin approval. Live keys start as pending and every call returns 403 until Datagod approves them; once approved the key becomes active and works immediately. Test (sandbox) keys are active immediately and need no approval.",
    ],
    callouts: [
      {
        tone: "warning",
        title: "Your key is shown only once",
        body: "Datagod stores only a one-way hash of your key, so it cannot be shown again. If you lose it, generate a replacement. Generating a new key of the same type and environment revokes the old one at once, so update your integration first.",
      },
      {
        tone: "info",
        title: "Keep keys on your server",
        body: "Never put a key in a mobile app, browser code or a public repository. Anyone holding the key can spend your wallet. If a key leaks, revoke it from the Developer API page immediately.",
      },
    ],
    endpoints: [],
  },
  {
    id: "key-types",
    label: "Key types",
    group: "start",
    intro:
      "Each key has a type and works only with that type's endpoint group; calling another group returns 403. Standard keys unlock data, wallet, orders, the results checker and AFA registration. Commission Services keys unlock airtime and utility bill payments (the Commission endpoints, such as POST /airtime/purchase and POST /utilities/pay). SMS keys unlock the SMS endpoints and are generated separately from the SMS dashboard. A key is also either live (real wallet, real orders) or test (sandbox). A key shows as pending, active or revoked; only active keys can call the API, and revoking a key disables it rather than deleting it.",
    endpoints: [],
  },
  {
    id: "response-format",
    label: "Response format",
    group: "start",
    intro:
      'Every successful response has the shape { "success": true, "data": { ... }, "meta": { "timestamp": "<ISO 8601>", "version": "2" } }. Every failure has the shape { "success": false, "error": { "code": <number>, "message": "<text>" } }, where code repeats the HTTP status. Responses are never cached, so you always read live state. Amounts are in Ghana cedis (GHS) with two decimal places.',
    endpoints: [],
  },
  {
    id: "errors-and-limits",
    label: "Errors and limits",
    group: "start",
    intro:
      "400 means bad input. 401 means the key is missing or invalid. 402 means an insufficient wallet balance (or, on SMS endpoints, insufficient SMS credits). 403 means the wrong key type, a pending or revoked key, a suspended account, or a role that is not allowed. 404 means not found. 409 means a duplicate reference or duplicate payment. 429 means you hit a rate limit; wait and retry. 500 is an internal error. 502 means an upstream provider could not be reached. 503 means the feature or a biller has been switched off by an administrator. Rate limits are counted per key per minute in four groups: purchase, bulk, balance and status. Default limits are 10, 3, 30 and 30 requests per minute, and Datagod can raise or lower them for an individual key; contact support to request a higher limit.",
    endpoints: [],
  },
  {
    id: "idempotency",
    label: "Idempotency",
    group: "start",
    intro:
      "Every purchase endpoint takes a reference that you choose and that must be unique to the order on your side. Sending the same reference with the same request returns the existing order and charges nothing a second time, so it is always safe to retry after a timeout. Reusing a reference for a different order returns 409. Airtime and utility bill payments follow the stricter claim rules in Idempotency and references (airtime and bills): a reference is required and a request that is still unconfirmed is never run a second time. AFA registration references are unique across all developers, so include your own prefix. Live data order references share one namespace with orders placed through version 1 of the API: sending a v1 order's reference with the same network, size and recipient returns that order as a replay, and different content returns 409. To check on an order, poll its order endpoint; Datagod does not send webhooks.",
    endpoints: [],
  },
  {
    id: "sandbox",
    label: "Sandbox",
    group: "start",
    intro:
      "Test keys (prefix dg2_test_) run against a sandbox: they never touch your real wallet or place real orders. Balance calls return a separate sandbox balance with sandbox: true, so you can build and verify your integration end to end before switching to a live key (prefix dg2_live_). The same holds for commission keys: a test commission key places airtime and bill orders against the sandbox wallet and never calls a provider, a sandbox verify_token from POST /utilities/lookup works only with test keys and a live verify_token only with live keys (any other pairing returns 400), and a sandbox replay behaves like a live one. Sandbox references are unique per account across all order types (data, airtime, bills and the rest), while live references are unique per order type, so a reference reused for a different order type can conflict in the sandbox only: use a distinct prefix per order type. Test keys are active immediately and need no approval, so you can start building straight away; live keys start as pending and work only after Datagod approves them. Test and live keys are revoked independently, and each environment has its own rate-limit counters.",
    endpoints: [],
  },
]

/** Every access/limit error a standard-key endpoint can return, using the real API strings. */
function standardAccessErrors(keyType: KeyType = "standard"): { status: number; message: string }[] {
  return [
    { status: 401, message: MSG_UNAUTHORIZED },
    { status: 403, message: MSG_SUSPENDED },
    { status: 403, message: MSG_PENDING },
    { status: 403, message: MSG_REVOKED },
    { status: 403, message: msgWrongKeyType(keyType) },
    { status: 403, message: MSG_ROLE_NOT_ALLOWED },
    { status: 429, message: MSG_RATE_LIMITED },
    { status: 503, message: MSG_UNAVAILABLE },
  ]
}

const ROLE_ENDPOINT: V2Endpoint = {
  id: "account-role",
  group: "data",
  method: "GET",
  path: "/account/role",
  keyType: "standard",
  rateLimit: "30 requests per minute (status group)",
  summary: "Returns the role of the account that owns the key, plus the key's type and environment.",
  params: [],
  requestExample: null,
  successExample: {
    success: true,
    data: { role: "dealer", key_type: "standard", environment: "live" },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [...standardAccessErrors()],
  notes: [
    "Role-specific pricing applies to your orders, so check the role here if your prices look unexpected.",
    "A cheap way to confirm a newly approved key works.",
  ],
}

const BALANCE_ENDPOINT: V2Endpoint = {
  id: "wallet-balance",
  group: "data",
  method: "GET",
  path: "/wallet/balance",
  keyType: "standard",
  rateLimit: "30 requests per minute (balance group)",
  summary: "Returns the wallet balance for the account that owns the key. Test keys read a separate sandbox balance.",
  params: [],
  requestExample: null,
  successExample: {
    success: true,
    data: { balance: 125.5, total_credited: 600, total_spent: 474.5, currency: "GHS" },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [...standardAccessErrors(), { status: 500, message: "Failed to fetch wallet balance" }],
  notes: [
    "Check the balance before a large purchase to avoid a 402 for insufficient funds.",
    "With a test key the response is { balance, currency, sandbox: true } and never reflects your real wallet.",
  ],
}

// Fixed strings from the data endpoints; the exported ones are imported so the docs cannot drift.
const MSG_BODY_OBJECT = "Request body must be a JSON object"
const MSG_NETWORK_LIST = "network must be one of: MTN, Telecel, AT-iShare, AT-BigTime"
const MSG_VOLUME = "volume_gb must be a positive number up to 1000 with at most 3 decimals"
const MSG_RECIPIENT = "recipient must be a valid Ghana mobile number"
const MSG_REFERENCE = "reference must be 3 to 100 characters: letters, digits, '-', '_', '.', ':'"
const MSG_INSUFFICIENT = "INSUFFICIENT_BALANCE: wallet balance is too low; required 4.50"
const MSG_BULK_SHAPE = "orders must be an array of 1 to 100 orders"
/** Built from the handler's constant so the docs cannot drift from the code. */
const BULK_DEADLINE_TEXT = `${BULK_DEADLINE_MS / 1000} seconds`

const ORDER_EXAMPLE = {
  reference: "ORD-2026-0001",
  network: "MTN",
  volume_gb: 1,
  recipient: "0244000001",
  price: 4.5,
  status: "pending",
  created_at: TS,
}

const NETWORK_PARAM =
  "One of MTN, Telecel, AT-iShare or AT-BigTime (case-insensitive). Which networks and sizes can be bought right now is returned by GET /packages; a network or size that is not listed there is unavailable."

const PACKAGES_ENDPOINT: V2Endpoint = {
  id: "data-packages",
  group: "data",
  method: "GET",
  path: "/packages",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists the data packages you can buy right now, with the price your account pays.",
  params: [
    { name: "network", type: "string", required: false, description: "Only return packages for this network. " + NETWORK_PARAM },
    { name: "size_gb", type: "number", required: false, description: "Only return packages of exactly this size in GB, for example 1 or 0.5." },
  ],
  requestExample: null,
  successExample: {
    success: true,
    data: {
      packages: [
        { network: "AT-iShare", size_gb: 1, price: 4.2 },
        { network: "MTN", size_gb: 1, price: 4.5 },
        { network: "MTN", size_gb: 2, price: 8.9 },
      ],
    },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_NETWORK_LIST },
    { status: 400, message: MSG_VOLUME.replace("volume_gb", "size_gb") },
    ...standardAccessErrors(),
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "This is the source of truth for availability: the list changes as networks and sizes are switched on or off, so a size that is missing here (for example an AT-BigTime size) is currently unavailable and a purchase for it returns 404.",
    "The price shown is what your account's role pays, in GHS. Role-specific pricing is applied by Datagod; you never send a price when ordering.",
    "Results are sorted by network and then by size.",
  ],
}

const PURCHASE_ENDPOINT: V2Endpoint = {
  id: "data-purchase",
  group: "data",
  method: "POST",
  path: "/data/purchase",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group)`,
  summary:
    "Buys one data bundle for one recipient and charges your wallet. Test keys use a sandbox wallet and never place real orders.",
  params: [
    { name: "network", type: "string", required: true, description: NETWORK_PARAM },
    { name: "volume_gb", type: "number", required: true, description: "Bundle size in GB, positive, up to 1000, at most 3 decimals. It must match a size listed by GET /packages." },
    { name: "recipient", type: "string", required: true, description: "Ghana mobile number in any of the forms 0244000001, 233244000001 or +233244000001 (spaces and hyphens are ignored)." },
    { name: "reference", type: "string", required: true, description: "Your own unique id for this order: 3 to 100 characters, letters, digits and - _ . : only. It makes retries safe." },
  ],
  requestExample: { network: "MTN", volume_gb: 1, recipient: "0244000001", reference: "ORD-2026-0001" },
  successExample: {
    success: true,
    data: { order: ORDER_EXAMPLE, new_balance: 120.5 },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_NETWORK_LIST },
    { status: 400, message: MSG_VOLUME },
    { status: 400, message: MSG_RECIPIENT },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_NETWORK_MISMATCH },
    { status: 402, message: MSG_INSUFFICIENT },
    { status: 404, message: MSG_PACKAGE_NOT_FOUND },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_NOT_REGISTERED },
    { status: 500, message: MSG_ORDER_FAILED },
    ...standardAccessErrors(),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "A new order returns HTTP 201 with the order and your new wallet balance. The order starts as pending and moves through the statuses described in Order statuses; poll GET /orders/{reference} to follow it.",
    "Never send a price. The price is set by Datagod from your account's role and charged atomically with the order; price, amount, package, status and similar fields are rejected with 400 Unexpected field.",
    "Resending the same reference with the same network, size and recipient is safe: it returns HTTP 200 with replayed: true and the existing order, and you are not charged a second time. Reusing a reference for different content returns 409.",
    "Live purchases require the phone number on your Datagod account to be verified. Until it is, a live key gets 403 PHONE_NOT_VERIFIED; verify the number in the dashboard. Replays of an existing order are not blocked by this check.",
    "An MTN recipient that is not registered for MTN data is rejected with 409 RECIPIENT_NOT_REGISTERED and nothing is charged. If the registration check itself is unavailable the order is accepted.",
    "The recipient number must belong to the chosen network, otherwise 400 NETWORK_MISMATCH.",
    "A test key uses a separate sandbox wallet: the response carries sandbox: true, no real order is placed and your real wallet is untouched.",
  ],
}

const BULK_ENDPOINT: V2Endpoint = {
  id: "data-bulk",
  group: "data",
  method: "POST",
  path: "/data/bulk",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.bulk} requests per minute (bulk group)`,
  summary:
    "Buys up to 100 data bundles in one request. Test keys use a sandbox wallet and never place real orders.",
  params: [
    { name: "orders", type: "array", required: true, description: "1 to 100 items, each with network, volume_gb, recipient and reference exactly as for POST /data/purchase. References must be unique within the batch." },
  ],
  requestExample: {
    orders: [
      { network: "MTN", volume_gb: 1, recipient: "0244000001", reference: "ORD-2026-0001" },
      { network: "MTN", volume_gb: 2, recipient: "0244000002", reference: "ORD-2026-0002" },
    ],
  },
  successExample: {
    success: true,
    data: {
      results: [
        { reference: "ORD-2026-0001", status: "placed", order: ORDER_EXAMPLE },
        { reference: "ORD-2026-0003", status: "failed", error: MSG_NOT_ATTEMPTED },
      ],
      skipped: [{ reference: "ORD-2026-0002", reason: "NOT_REGISTERED" }],
      total_charged: 4.5,
    },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BULK_SHAPE },
    { status: 400, message: "orders[i]: Duplicate reference in batch" },
    { status: 400, message: `orders[i]: ${MSG_RECIPIENT}` },
    { status: 400, message: `orders[i]: ${MSG_PACKAGE_NOT_FOUND}` },
    { status: 400, message: `orders[i]: ${MSG_NETWORK_MISMATCH}` },
    { status: 402, message: MSG_INSUFFICIENT },
    { status: 409, message: `orders[i]: ${MSG_REFERENCE_REUSED}` },
    { status: 500, message: MSG_LOOKUP_FAILED },
    ...standardAccessErrors(),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "The whole batch is validated first: one bad item (invalid field, unavailable package, wrong-network number, duplicate or conflicting reference) rejects the entire request with 400 or 409, names the item as orders[i], and nothing is charged. See Bulk orders.",
    "A successful request returns HTTP 200 with a results array (placed, replayed or failed per reference), a skipped array and total_charged. HTTP 200 does not mean every item was placed; always read each item's status.",
    "Unregistered MTN numbers are skipped, not failed: they appear in skipped with reason NOT_REGISTERED and nothing is charged for them.",
    "The wallet must cover every item that will be placed (402 otherwise, nothing charged). Live bulk purchases require a verified account phone number (403 PHONE_NOT_VERIFIED).",
    `Orders are placed one after another and a request stops starting new placements after ${BULK_DEADLINE_TEXT}. Items not reached come back failed with ${MSG_NOT_ATTEMPTED}; resend the same batch and the placed ones are replayed without a second charge.`,
    `A failed item carries an error value: INSUFFICIENT_BALANCE (the wallet ran short during the batch), REFERENCE_REUSED (the reference was taken by a different order in the meantime), FAILED (the order could not be placed) or ${MSG_NOT_ATTEMPTED} (the deadline was reached before it started). Resending the same batch is safe for all of them: an item that was in fact placed comes back replayed and is never charged twice.`,
    "Never send prices; the server prices every item from your role.",
    "A test key uses a sandbox wallet: the response carries sandbox: true and no real order is placed.",
  ],
}

const VERIFY_ENDPOINT: V2Endpoint = {
  id: "data-verify-number",
  group: "data",
  method: "POST",
  path: "/data/verify-number",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Checks whether a number can receive MTN data before you order. Free, no charge.",
  params: [
    { name: "network", type: "string", required: true, description: NETWORK_PARAM },
    { name: "phone", type: "string", required: true, description: "Ghana mobile number: 0244000001, 233244000001 or +233244000001." },
  ],
  requestExample: { network: "MTN", phone: "0244000001" },
  successExample: { success: true, data: { allowed: true, checked: true }, meta: { timestamp: TS, version: "2" } },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: MSG_NETWORK_LIST },
    { status: 400, message: "phone must be a valid Ghana mobile number" },
    ...standardAccessErrors(),
  ],
  notes: [
    "checked: true means the number was looked up; allowed: false means an MTN number that is not registered for data, which a purchase would reject with no charge.",
    "checked: false (allowed: true) means no check was made: either the network is not MTN, or the registration check was unavailable. Treat it as permitted.",
    "A test key never contacts a provider: it always returns allowed: true, checked: false and sandbox: true.",
  ],
}

const ORDER_ENDPOINT: V2Endpoint = {
  id: "order-lookup",
  group: "data",
  method: "GET",
  path: "/orders/{reference}",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one of your data orders by the reference you chose, including its current status.",
  params: [{ name: "reference", type: "string", required: true, description: "The reference you sent when placing the order (path parameter)." }],
  requestExample: null,
  successExample: { success: true, data: { order: ORDER_EXAMPLE }, meta: { timestamp: TS, version: "2" } },
  errors: [{ status: 404, message: MSG_ORDER_NOT_FOUND }, ...standardAccessErrors()],
  notes: [
    "Poll this endpoint to follow an order; Datagod does not send webhooks. See Order statuses for what each status means.",
    "A reference that does not exist, is malformed, or belongs to another account all return the same 404, so references cannot be probed.",
    "With a test key this reads your sandbox orders and the response carries sandbox: true.",
  ],
}

const DATA_SECTIONS: V2DocSection[] = [
  {
    id: "packages",
    label: "Packages",
    group: "data",
    intro: "See which networks and sizes you can buy and what your account pays for them.",
    endpoints: [PACKAGES_ENDPOINT],
  },
  {
    id: "data-purchase",
    label: "Buy data",
    group: "data",
    intro: "Place a single data order. Orders are paid from your wallet and are safe to retry with the same reference.",
    endpoints: [PURCHASE_ENDPOINT],
  },
  {
    id: "data-bulk",
    label: "Buy data in bulk",
    group: "data",
    intro: "Place up to 100 orders in one request.",
    endpoints: [BULK_ENDPOINT],
  },
  {
    id: "data-verify",
    label: "Verify a number",
    group: "data",
    intro: "Check an MTN number before ordering to avoid a rejected purchase.",
    endpoints: [VERIFY_ENDPOINT],
  },
  {
    id: "data-orders",
    label: "Orders",
    group: "data",
    intro: "Look up an order and follow it to completion.",
    endpoints: [ORDER_ENDPOINT],
  },
  {
    id: "order-statuses",
    label: "Order statuses",
    group: "data",
    intro:
      "An order's status is one of six values. pending: accepted and charged, waiting to be sent to the network. processing: being delivered; an order under review or with a refund in progress also reads processing. completed: the data was delivered. failed: delivery did not happen and will not (a cancelled order also reads failed). refunded: the order did not complete and the amount was credited back to your wallet. queued: an MTN number that is waiting for its registration to finish before the order is sent; it moves on automatically. Statuses can change over time, so poll the order endpoint until you reach completed, failed or refunded.",
    endpoints: [],
  },
  {
    id: "bulk-orders",
    label: "Bulk orders",
    group: "data",
    intro:
      "A bulk request takes 1 to 100 orders. Datagod validates the whole batch first: if any item is invalid, names an unavailable package, has a number that does not match its network, or reuses a reference for different content, the whole request is rejected with the failing orders[i] position and nothing is charged. Once validation passes, MTN numbers that are not registered are skipped (listed in skipped with reason NOT_REGISTERED, never charged) and the rest are placed one at a time, so the result can be partial: read each item in results (placed, replayed or failed) and total_charged. A failed item carries an error value (INSUFFICIENT_BALANCE, REFERENCE_REUSED, FAILED or NOT_ATTEMPTED); the bulk endpoint notes explain each one.",
    callouts: [
      {
        tone: "info",
        title: "Deadline and NOT_ATTEMPTED",
        body: `A request stops starting new placements after ${BULK_DEADLINE_TEXT}. Items not reached are returned as failed with ${MSG_NOT_ATTEMPTED}. Nothing was charged for them.`,
      },
      {
        tone: "info",
        title: "Resending is safe",
        body: "Resend the same batch with the same references: orders already placed come back as replayed without a second charge and only the remaining ones are placed. Keep within the bulk rate limit when you resend.",
      },
    ],
    endpoints: [],
  },
]

// ---------------------------------------------------------------- Commission (airtime and utility bills)
//
// This module is imported by client components, so it must not import commission.ts or the
// endpoint files (server-only modules at module scope). The strings below are copies of the real
// messages; registry.test.ts imports the exported constants and asserts every documented message.

const MSG_AIRTIME_NETWORK = "network must be one of: MTN, Telecel, AT, AirtelTigo"
const MSG_AIRTIME_AMOUNT = "amount must be greater than 0 and at most 1000, with at most 2 decimals"
const MSG_BILL_AMOUNT = "amount must be greater than 0 and at most 10000, with at most 2 decimals"
const MSG_EXPECTED_PAY = "expected_pay must be a positive amount with at most 2 decimals"
const MSG_TOKEN_REQUIRED = "verify_token is required"
const MSG_BILLER_LIST = "biller must be one of: ecg, ghana_water, dstv, gotv, startimes, telecel_broadband"

const PENDING_TAIL_AIRTIME =
  "Do not place this order again under a new reference. Poll GET /airtime/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
const PENDING_TAIL_BILL =
  "Do not place this payment again under a new reference. Poll GET /utilities/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
const MSG_AIR_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL_AIRTIME}`
const MSG_AIR_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL_AIRTIME}`
const MSG_AIR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this purchase is not confirmed yet. ${PENDING_TAIL_AIRTIME}`
const MSG_BILL_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${PENDING_TAIL_BILL}`
const MSG_BILL_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${PENDING_TAIL_BILL}`
const MSG_BILL_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this payment is not confirmed yet. ${PENDING_TAIL_BILL}`
const MSG_CLAIM_UNAVAILABLE =
  "UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference"
const MSG_SANDBOX_UNAVAILABLE = "Sandbox is temporarily unavailable"
const MSG_SANDBOX_NOT_PLACED = "Order could not be placed"
const MSG_ORDER_MISSING = "Order not found"

const AIRTIME_ORDER_EXAMPLE = {
  reference: "AIR-2026-0001",
  network: "MTN",
  recipient: "0244000001",
  airtime_amount: 10,
  // Standard pricing (no cashback): the recipient gets the full 10.00 and the 0.50 fee is charged on top.
  fee_amount: 0.5,
  total_paid: 10.5,
  cashback: 0,
  status: "pending",
  created_at: TS,
}

const BILL_ORDER_EXAMPLE = {
  reference: "BILL-2026-0001",
  biller: "dstv",
  account: "7012345678",
  customer_name: "Kwame Mensah",
  face_amount: 120,
  paid_amount: 120,
  cashback: 1.2,
  status: "pending",
  created_at: TS,
}

const COMMISSION_STATUS_NOTE =
  "status is one of pending, processing, completed, failed or refunded, and it can change, so poll until it is completed, failed or refunded."

const claimLookupNotes = (what: string, path: string): string[] => [
  `A found ${what} order returns HTTP 200 with { order, claim: null }. ${COMMISSION_STATUS_NOTE}`,
  `If your own request with this reference is still unconfirmed, the answer is HTTP 200 with order: null and claim: { reference, state }, where claim.state is in_progress (still being processed) or outcome_unknown (not confirmed). An in_progress request older than 10 minutes reads outcome_unknown. Never place the ${what} again under a new reference; keep polling ${path}, or contact support quoting the reference.`,
  "A reference that does not exist, is malformed, or belongs to another account all return the same identical 404, so references cannot be probed. A 404 never proves nothing was charged after an unknown outcome; see Idempotency and references (airtime and bills).",
  "With a test key this reads your sandbox orders and the response carries sandbox: true.",
]

const replayNote = (what: string) =>
  `Resending the same reference with the same request is safe: it returns HTTP 200 with replayed: true and the existing ${what}, and you are not charged a second time. Reusing a reference for a different request returns 409 REFERENCE_REUSED.`

const AIRTIME_PURCHASE_ENDPOINT: V2Endpoint = {
  id: "airtime-purchase",
  group: "commission",
  method: "POST",
  path: "/airtime/purchase",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group)`,
  summary: "Buys airtime for one recipient and charges your wallet. Test keys use a sandbox wallet and never call a provider.",
  params: [
    { name: "network", type: "string", required: true, description: "One of MTN, Telecel, AT or AirtelTigo (case-insensitive; AirtelTigo is the same network as AT)." },
    { name: "recipient", type: "string", required: true, description: "Ghana mobile number in any of the forms 0244000001, 233244000001 or +233244000001. It must belong to the chosen network." },
    { name: "amount", type: "number", required: true, description: "Airtime face value in GHS: greater than 0 and at most 1000, with at most 2 decimals. A plain decimal number or numeric string; no exponent or sign." },
    { name: "reference", type: "string", required: true, description: "Your own unique id for this order: 3 to 100 characters, letters, digits and - _ . : only. Required: it makes retries safe." },
    { name: "expected_pay", type: "number", required: false, description: "The total you expect to be charged: face value plus the fee, or face value minus cashback when cashback applies. Positive, up to 20000, at most 2 decimals. If the real price differs, the purchase is refused with 409 PRICE_CHANGED and nothing is charged." },
  ],
  requestExample: { network: "MTN", recipient: "0244000001", amount: 10, reference: "AIR-2026-0001", expected_pay: 10.5 },
  successExample: {
    success: true,
    data: { order: AIRTIME_ORDER_EXAMPLE, new_balance: 89.5 },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_AIRTIME_NETWORK },
    { status: 400, message: MSG_RECIPIENT },
    { status: 400, message: MSG_AIRTIME_AMOUNT },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_EXPECTED_PAY },
    { status: 400, message: "NETWORK_MISMATCH: The recipient number does not belong to the selected network" },
    { status: 400, message: "INVALID_AMOUNT: The amount is outside the allowed range" },
    { status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 10.50" },
    { status: 402, message: "INSUFFICIENT_BALANCE: test balance is too low; required 10.00" },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_AIR_IN_PROGRESS },
    { status: 409, message: MSG_AIR_PRIOR_UNKNOWN },
    {
      status: 409,
      message:
        "DUPLICATE_REQUEST: An identical airtime order was just placed. Look it up under its original reference; do not resend it under a new reference unless you intend a second identical order.",
    },
    {
      // Cashback path: pay_amount = face_amount - customer_cashback.
      status: 409,
      message:
        "PRICE_CHANGED: the price has changed; face_amount 10.00, pay_amount 9.90, customer_cashback 0.10. Review the price and resend with expected_pay",
    },
    { status: 500, message: MSG_AIR_UNKNOWN },
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 500, message: MSG_SANDBOX_NOT_PLACED },
    ...standardAccessErrors("commission"),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 503, message: "NETWORK_DISABLED: Airtime for this network is currently unavailable" },
    { status: 503, message: MSG_CLAIM_UNAVAILABLE },
  ],
  notes: [
    "A new order returns HTTP 201 with the order and your new wallet balance. See Airtime pricing for what total_paid, fee_amount and cashback mean.",
    "Never send a price. Fields such as price, fee, fee_amount, total_paid, cashback, status and user_id are rejected with 400 Unexpected field; the amount you send is only the airtime face value. To guard against a price change, send expected_pay with the total you expect.",
    replayNote("order"),
    "The reference is claimed before anything is charged. 409 REQUEST_IN_PROGRESS and 409 OUTCOME_UNKNOWN mean an earlier request with this reference is not confirmed yet: never place the order again under a new reference. Poll GET /airtime/orders/{reference} and read claim.state, or contact support quoting the reference.",
    "500 OUTCOME_UNKNOWN means this request may or may not have charged you. The reference is locked to that outcome and is never run a second time automatically. Do not retry under a new reference.",
    "A 503 with UNAVAILABLE means the reference could not be reserved and nothing was charged; retry with the same reference.",
    "Live purchases require the phone number on your Datagod account to be verified. Until it is, a live key gets 403 PHONE_NOT_VERIFIED and nothing is charged; verify the number in the dashboard. Replays of an existing order are not blocked by this check.",
    "A test key uses a separate sandbox wallet: the response carries sandbox: true, no provider is contacted, the order is charged at face value with no fee and no cashback, and a replay works the same way.",
  ],
}

const AIRTIME_LIST_ENDPOINT: V2Endpoint = {
  id: "airtime-orders",
  group: "commission",
  method: "GET",
  path: "/airtime/orders",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists your most recent airtime orders under the references you chose.",
  params: [],
  requestExample: null,
  successExample: { success: true, data: { orders: [AIRTIME_ORDER_EXAMPLE] }, meta: { timestamp: TS, version: "2" } },
  errors: [
    ...standardAccessErrors("commission"),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "Returns up to 30 orders. Only orders that were placed successfully are listed; a request that is still unconfirmed shows up through GET /airtime/orders/{reference} instead.",
    "Each order has the same shape as in POST /airtime/purchase. " + COMMISSION_STATUS_NOTE,
    "With a test key the list is your sandbox orders and the response carries sandbox: true.",
  ],
}

const AIRTIME_ORDER_ENDPOINT: V2Endpoint = {
  id: "airtime-order-lookup",
  group: "commission",
  method: "GET",
  path: "/airtime/orders/{reference}",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one airtime order by the reference you chose, or tells you that your request is still unconfirmed.",
  params: [{ name: "reference", type: "string", required: true, description: "The reference you sent with POST /airtime/purchase (path parameter)." }],
  requestExample: null,
  successExample: { success: true, data: { order: AIRTIME_ORDER_EXAMPLE, claim: null }, meta: { timestamp: TS, version: "2" } },
  errors: [
    { status: 404, message: MSG_ORDER_MISSING },
    ...standardAccessErrors("commission"),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
  ],
  notes: claimLookupNotes("airtime", "this endpoint"),
}

const BILLER_EXAMPLES = (
  [
    { key: "ecg", label: "ECG Prepaid & Postpaid", inputs: [["phone", true], ["account", false], ["add_meter", false], ["consent", false]] },
    { key: "ghana_water", label: "Ghana Water", inputs: [["account", true], ["phone", true], ["email", true]] },
    { key: "dstv", label: "DSTV", inputs: [["account", true]] },
    { key: "gotv", label: "GOtv", inputs: [["account", true]] },
    { key: "startimes", label: "StarTimes TV", inputs: [["account", true]] },
    { key: "telecel_broadband", label: "Telecel Broadband", inputs: [["account", true], ["broadband_account", true]] },
  ] as { key: string; label: string; inputs: [string, boolean][] }[]
).map((b) => ({
  key: b.key,
  label: b.label,
  enabled: true,
  min_amount: 1,
  max_amount: 5000,
  inputs: b.inputs.map(([name, required]) => ({ name, required })),
}))

const BILLERS_ENDPOINT: V2Endpoint = {
  id: "utility-billers",
  group: "commission",
  method: "GET",
  path: "/utilities/billers",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists the utility billers, whether each is switched on, its amount limits and the inputs its lookup needs.",
  params: [],
  requestExample: null,
  successExample: { success: true, data: { billers: BILLER_EXAMPLES }, meta: { timestamp: TS, version: "2" } },
  errors: [
    ...standardAccessErrors("commission"),
    { status: 503, message: "UNAVAILABLE: the biller list is temporarily unavailable" },
  ],
  notes: [
    "Use key as the biller value in POST /utilities/lookup. enabled: false means the biller (or utility bills as a whole) is switched off right now; do not attempt it.",
    "min_amount and max_amount are the limits in GHS an amount must fall within when you pay; they can change, so read them before you collect an amount.",
    "inputs lists the lookup fields for the biller and whether each is required. See POST /utilities/lookup for what they mean.",
  ],
}

const LOOKUP_ENDPOINT: V2Endpoint = {
  id: "utility-lookup",
  group: "commission",
  method: "POST",
  path: "/utilities/lookup",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group); lookup and pay share this limit`,
  summary: "Verifies a customer's account with the biller and returns a single-use verify_token you pay with. Moves no money.",
  params: [
    { name: "biller", type: "string", required: true, description: "A biller key from GET /utilities/billers: ecg, ghana_water, dstv, gotv, startimes or telecel_broadband." },
    { name: "account", type: "string", required: false, description: "The meter, smartcard or account number (letters, digits and hyphens, 4 to 30 characters). For telecel_broadband this is the landline number. Required for every biller except ecg." },
    { name: "phone", type: "string", required: false, description: "A Ghana mobile number. Required for ecg and ghana_water." },
    { name: "email", type: "string", required: false, description: "The customer's email address. Required for ghana_water." },
    { name: "broadband_account", type: "string", required: false, description: "The broadband account. Required for telecel_broadband." },
    { name: "add_meter", type: "boolean", required: false, description: "ecg only: true to look up the one specific meter given in account. Omit it to list the meters linked to phone." },
  ],
  requestExample: { biller: "dstv", account: "7012345678" },
  successExample: {
    success: true,
    data: { customer_name: "Kwame Mensah", amount_due: 120, suggested_amount: 120, verify_token: "vt_8f3c2a91b7e04d56a1c9f0e2d4b6a8c0" },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: MSG_BILLER_LIST },
    { status: 400, message: "INVALID_REQUEST: the account details are not valid for this biller (see GET /utilities/billers for the required inputs)" },
    { status: 500, message: "INTERNAL_ERROR: the account could not be verified" },
    { status: 502, message: "LOOKUP_FAILED: the biller could not verify this account; check the details and retry" },
    ...standardAccessErrors("commission"),
    { status: 403, message: "NOT_AVAILABLE: utility bills are not available on the API right now" },
    { status: 503, message: "BILLER_UNAVAILABLE: this biller is currently unavailable" },
    { status: 503, message: "UNAVAILABLE: utility bills are temporarily unavailable" },
  ],
  notes: [
    "A lookup moves no money and creates no order. It returns the customer name, the amount due (null when the biller does not report one), a suggested_amount and a verify_token. Pass the token to POST /utilities/pay.",
    "For ecg without add_meter the response lists the meters linked to the phone instead: { customer_name: null, amount_due: null, suggested_amount: 0, meters: [...] }, where each meter has meter (for example 8000000701), name, outstanding and its own verify_token. Pay with the verify_token of the meter you want.",
    "Inputs by biller: ecg needs phone (account is optional, and add_meter true looks up the one meter in account); ghana_water needs account, phone and email; dstv and gotv need the smartcard number as account; startimes needs the account number as account; telecel_broadband needs the landline as account plus broadband_account.",
    "A verify_token is single-use: one verification pays one reference. Look the account up again for every payment.",
    "Lookup shares the purchase limit with pay, so a key makes about five complete bill payments per minute by default (each uses one lookup and one pay request).",
    "A test key returns a sandbox verify_token and sandbox: true without calling the biller. A sandbox token works only with test keys; a live key that sends it gets 400 on pay.",
  ],
}

const BILL_PAY_ENDPOINT: V2Endpoint = {
  id: "utility-pay",
  group: "commission",
  method: "POST",
  path: "/utilities/pay",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group); lookup and pay share this limit`,
  summary: "Pays a utility bill with a verify_token from POST /utilities/lookup and charges your wallet. Test keys use the sandbox wallet.",
  params: [
    { name: "verify_token", type: "string", required: true, description: "The verify_token from POST /utilities/lookup. Single-use: it pays one reference, once." },
    { name: "amount", type: "number", required: true, description: "The bill amount in GHS: greater than 0 and at most 10000, with at most 2 decimals, and inside the biller's min_amount and max_amount." },
    { name: "reference", type: "string", required: true, description: "Your own unique id for this payment: 3 to 100 characters, letters, digits and - _ . : only. Required: it makes retries safe." },
    { name: "expected_pay", type: "number", required: false, description: "The total you expect to be charged, positive, up to 20000, at most 2 decimals. If the real price differs, the payment is refused with 409 PRICE_CHANGED and nothing is charged." },
  ],
  requestExample: {
    verify_token: "vt_8f3c2a91b7e04d56a1c9f0e2d4b6a8c0",
    amount: 120,
    reference: "BILL-2026-0001",
    expected_pay: 120,
  },
  successExample: {
    success: true,
    data: { order: BILL_ORDER_EXAMPLE },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_TOKEN_REQUIRED },
    { status: 400, message: MSG_BILL_AMOUNT },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_EXPECTED_PAY },
    { status: 400, message: "INVALID_TOKEN: the verify_token is invalid or expired; nothing was charged. Verify the account again" },
    { status: 400, message: "INVALID_TOKEN: this is a sandbox verify_token; a live key needs a token from POST /utilities/lookup made with a live key" },
    { status: 400, message: "INVALID_TOKEN: a test key needs a sandbox verify_token from POST /utilities/lookup made with a test key" },
    { status: 400, message: "INVALID_AMOUNT: the amount is outside this biller's allowed range or precision (see GET /utilities/billers); nothing was charged" },
    { status: 400, message: "INVALID_REQUEST: the payment was refused; nothing was charged" },
    {
      status: 402,
      message:
        "INSUFFICIENT_BALANCE: wallet balance is too low; nothing was charged. Verify the account again after topping up, then pay with the new verify_token",
    },
    { status: 402, message: "INSUFFICIENT_BALANCE: test balance is too low; required 120.00" },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_BILL_IN_PROGRESS },
    { status: 409, message: MSG_BILL_PRIOR_UNKNOWN },
    { status: 409, message: "REFERENCE_REUSED: this verification already paid another reference" },
    {
      status: 409,
      message: "VERIFY_AGAIN: this verification can no longer be used; nothing was charged. Verify the account again with POST /utilities/lookup",
    },
    {
      status: 409,
      message:
        "PRICE_CHANGED: expected 120.00, current 120.50 (face_amount 120.00, customer_cashback 1.20). Review the price and resend with expected_pay",
    },
    { status: 500, message: MSG_BILL_UNKNOWN },
    { status: 500, message: "INTERNAL_ERROR: the payment could not be started; nothing was charged" },
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 500, message: MSG_SANDBOX_NOT_PLACED },
    ...standardAccessErrors("commission"),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 403, message: "NOT_AVAILABLE: utility bills are not available on the API right now" },
    { status: 503, message: "BILLER_UNAVAILABLE: this biller is currently unavailable; nothing was charged" },
    { status: 503, message: "UNAVAILABLE: utility bills are temporarily unavailable; nothing was charged" },
    { status: 503, message: MSG_CLAIM_UNAVAILABLE },
    { status: 503, message: "UNAVAILABLE: could not check earlier test payments; nothing was charged" },
  ],
  notes: [
    "A new payment returns HTTP 201 with the order. paid_amount is what you were charged and cashback is the cashback credited for it. See Bill payment flow.",
    "Never send a price. Fields such as price, fee, total_paid, cashback, status and user_id are rejected with 400 Unexpected field; the amount you send is the bill amount.",
    replayNote("order"),
    "One verification pays one reference. Reusing a verify_token for a second reference returns 409 REFERENCE_REUSED when it already paid, or 409 VERIFY_AGAIN when it can no longer be used and nothing was charged: look the account up again.",
    "A refused payment can still use up the token. If the wallet is short you get 402 and nothing is charged, but the token is spent: after topping up the wallet, look the account up again for a new verify_token before paying.",
    "If the price moved between lookup and payment, you get 409 PRICE_CHANGED with the current pay_amount in the message and nothing is charged. Resend with the new expected_pay (verify again if the amount changed).",
    "409 REQUEST_IN_PROGRESS and 409 OUTCOME_UNKNOWN mean an earlier request with this reference is not confirmed yet; 500 OUTCOME_UNKNOWN means this request may or may not have paid. Never pay again under a new reference. Poll GET /utilities/orders/{reference} and read claim.state, or contact support quoting the reference.",
    "Live payments require the phone number on your Datagod account to be verified (403 PHONE_NOT_VERIFIED otherwise) and utility bills to be open on the API (403 NOT_AVAILABLE otherwise). Both leave the reference free and nothing is charged.",
    "Lookup shares the purchase limit with pay, so a key makes about five complete bill payments per minute by default.",
    "A test key needs a sandbox verify_token from a test-key lookup, and a live key needs a live one; a live key that sends a sandbox verify_token gets 400. Test keys use the sandbox wallet, pay face value with no cashback, never call the biller, return sandbox: true, and replay the same way.",
  ],
}

const BILL_ORDER_ENDPOINT: V2Endpoint = {
  id: "utility-order-lookup",
  group: "commission",
  method: "GET",
  path: "/utilities/orders/{reference}",
  keyType: "commission",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one utility bill order by the reference you chose, or tells you that your payment is still unconfirmed.",
  params: [{ name: "reference", type: "string", required: true, description: "The reference you sent with POST /utilities/pay (path parameter)." }],
  requestExample: null,
  successExample: { success: true, data: { order: BILL_ORDER_EXAMPLE, claim: null }, meta: { timestamp: TS, version: "2" } },
  errors: [
    { status: 404, message: MSG_ORDER_MISSING },
    ...standardAccessErrors("commission"),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
  ],
  notes: claimLookupNotes("payment", "this endpoint"),
}

const COMMISSION_SECTIONS: V2DocSection[] = [
  {
    id: "commission-idempotency",
    label: "Idempotency and references (airtime and bills)",
    group: "commission",
    intro:
      "Every airtime purchase and every bill payment needs a reference that you choose: 3 to 100 characters, letters, digits and - _ . : only, unique to the order on your side. The reference is required. Datagod reserves it before anything is charged, and a request can end in one of four ways. A new request is charged once and returns HTTP 201. The same reference with the same request returns HTTP 200 with replayed: true and the existing order, with no second charge. The same reference with a different request returns 409 REFERENCE_REUSED. A reference whose earlier request is not confirmed yet returns 409 REQUEST_IN_PROGRESS while it is running, or 409 OUTCOME_UNKNOWN once it has been unconfirmed for more than 10 minutes or ended without a clear result. If the reference cannot be reserved at all you get 503 and nothing was charged; retry with the same reference. Live references are unique per order type within your account (an airtime reference and a bill reference can be the same string), but sandbox references are unique per account across all order types, so reusing one reference for different order types can conflict in the sandbox: use a distinct prefix per order type (for example AIR- and BILL-).",
    steps: [
      "Create one reference per order and store it before you send the request.",
      "On a timeout or a network error, resend the same request with the same reference: you get the existing order back, never a second charge.",
      "On 409 REQUEST_IN_PROGRESS or 409 OUTCOME_UNKNOWN, or a 500 OUTCOME_UNKNOWN, never resend under a new reference. Poll GET /airtime/orders/{reference} or GET /utilities/orders/{reference} and read claim.state: in_progress means it is still running, outcome_unknown means it is not confirmed.",
      "If claim.state stays outcome_unknown, contact support quoting the reference. Support will investigate the reference you quote; do not place the order again meanwhile.",
    ],
    callouts: [
      {
        tone: "warning",
        title: "A 404 is not proof that nothing was charged",
        body: "After an unknown outcome, a missing order is not a safe answer: a 404 never means \"not charged\". The order lookup answers HTTP 200 with order: null and claim.state for your own unconfirmed request, and a plain 404 only when the reference was never used by your account. Never place the order again under a new reference to \"fix\" an unknown outcome; that is how customers are charged twice.",
      },
    ],
    endpoints: [],
  },
  {
    id: "airtime-pricing",
    label: "Airtime pricing",
    group: "commission",
    intro:
      "You send the airtime face value in amount, and the recipient always gets the full face value. Datagod prices the order from the role of the account that owns the key, on one of two paths. When cashback is applied, you pay the face value minus your cashback: a 10.00 order with 0.10 cashback charges 9.90 (fee_amount 0, cashback 0.10). Otherwise you pay the face value plus the fee: a 10.00 order with a 0.50 fee charges 10.50 (fee_amount 0.50, cashback 0). Which path applies, the fee rate and the cashback can change between requests, so there is no fixed price: read total_paid, fee_amount and cashback from the order rather than assuming a rate. To protect yourself, send expected_pay with the total you expect to be charged (10.50 or 9.90 in the examples). If the real price differs, the purchase is refused with 409 PRICE_CHANGED, nothing is charged, and the message carries the current face_amount, pay_amount and customer_cashback so you can show the customer and resend. In the sandbox (test keys) an order is charged at face value with no fee and no cashback.",
    endpoints: [],
  },
  {
    id: "airtime-purchase",
    label: "Buy airtime",
    group: "commission",
    intro: "Buy airtime for a Ghana mobile number. Orders are paid from your wallet and are safe to retry with the same reference.",
    endpoints: [AIRTIME_PURCHASE_ENDPOINT],
  },
  {
    id: "airtime-orders",
    label: "Airtime orders",
    group: "commission",
    intro: "List your airtime orders, or look one up by reference to follow it to completion.",
    endpoints: [AIRTIME_LIST_ENDPOINT, AIRTIME_ORDER_ENDPOINT],
  },
  {
    id: "bill-payment-flow",
    label: "Bill payment flow",
    group: "commission",
    intro:
      "A utility bill is paid in two requests: you verify the customer's account to get a verify_token, then pay with it. One verification pays one reference, so verify again for every payment.",
    steps: [
      "GET /utilities/billers: check that the biller is enabled, its min_amount and max_amount, and the inputs its lookup needs.",
      "POST /utilities/lookup: send the biller and its inputs. You get the customer name, amount due, suggested_amount and a single-use verify_token.",
      "POST /utilities/pay: send the verify_token, the amount and your own reference. The payment returns HTTP 201 with the order; poll GET /utilities/orders/{reference} to follow it.",
      "If anything is unclear, read the reference back with GET /utilities/orders/{reference} before doing anything else.",
    ],
    callouts: [
      {
        tone: "info",
        title: "VERIFY_AGAIN",
        body: "409 VERIFY_AGAIN means the verify_token can no longer be used and nothing was charged. Call POST /utilities/lookup again and pay with the new token.",
      },
      {
        tone: "info",
        title: "The price changed (409 PRICE_CHANGED)",
        body: "If you send expected_pay and the real price differs, the payment is refused with 409 PRICE_CHANGED and nothing is charged. The message shows the current price; resend with the new expected_pay.",
      },
      {
        tone: "info",
        title: "Wallet too low (402)",
        body: "A 402 charges nothing, but the refused attempt uses up the verify_token. Top up your wallet, verify the account again, then pay with the new verify_token.",
      },
    ],
    endpoints: [],
  },
  {
    id: "utility-billers",
    label: "Billers",
    group: "commission",
    intro: "See which billers are on, their amount limits and the inputs each lookup needs.",
    endpoints: [BILLERS_ENDPOINT],
  },
  {
    id: "utility-lookup",
    label: "Verify an account",
    group: "commission",
    intro: "Look up the customer's account with the biller. Free; no money moves.",
    endpoints: [LOOKUP_ENDPOINT],
  },
  {
    id: "utility-pay",
    label: "Pay a bill",
    group: "commission",
    intro: "Pay a bill with a verify_token. Payments are safe to retry with the same reference.",
    endpoints: [BILL_PAY_ENDPOINT],
  },
  {
    id: "utility-orders",
    label: "Bill orders",
    group: "commission",
    intro: "Look up a utility bill order by reference.",
    endpoints: [BILL_ORDER_ENDPOINT],
  },
]

export const v2DocsRegistry: V2DocSection[] = [
  ...START_SECTIONS,
  {
    id: "account",
    label: "Account",
    group: "data",
    intro: "Identify the account behind a key.",
    endpoints: [ROLE_ENDPOINT],
  },
  {
    id: "wallet",
    label: "Wallet",
    group: "data",
    intro: "Read your wallet balance.",
    endpoints: [BALANCE_ENDPOINT],
  },
  ...DATA_SECTIONS,
  ...COMMISSION_SECTIONS,
]
