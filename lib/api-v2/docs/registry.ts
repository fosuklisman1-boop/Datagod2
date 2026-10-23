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
      "The Datagod Developer API lets approved partners work with their Datagod account from their own software: check wallet balance and account role today, with data, airtime, utility bills, results checkers, AFA registration and SMS arriving in later releases. Every request is made over HTTPS to " +
      V2_BASE_URL +
      ", is authenticated with an API key, and returns JSON in a single consistent envelope. Version 1 of the API keeps working unchanged for existing integrations; v2 runs beside it.",
    endpoints: [],
  },
  {
    id: "authentication",
    label: "Authentication",
    group: "start",
    intro:
      "Send your API key on every request. The preferred form is the Authorization header containing the raw key. Two equivalent forms are also accepted: Authorization: Bearer <key>, and the X-API-Key header. If more than one is sent, Authorization wins. A missing, malformed or unknown key returns 401.",
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
      "Each key has a type and works only with that type's endpoint group; calling another group returns 403. Standard keys unlock data, wallet, orders, the results checker and AFA registration. Commission Services keys unlock airtime and utility bill payments. SMS keys unlock the SMS endpoints and are generated separately from the SMS dashboard. A key is also either live (real wallet, real orders) or test (sandbox). A key shows as pending, active or revoked; only active keys can call the API, and revoking a key disables it rather than deleting it.",
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
      "400 means bad input or an insufficient wallet balance. 401 means the key is missing or invalid. 402 means insufficient SMS credits. 403 means the wrong key type, a pending or revoked key, a suspended account, or a role that is not allowed. 404 means not found. 409 means a duplicate reference or duplicate payment. 429 means you hit a rate limit; wait and retry. 500 is an internal error. 502 means an upstream provider could not be reached. 503 means the feature or a biller has been switched off by an administrator. Rate limits are counted per key per minute in four groups: purchase, bulk, balance and status. Default limits are 10, 3, 30 and 30 requests per minute, and Datagod can raise or lower them for an individual key; contact support to request a higher limit.",
    endpoints: [],
  },
  {
    id: "idempotency",
    label: "Idempotency",
    group: "start",
    intro:
      "Every purchase endpoint takes a reference that you choose and that must be unique to the order on your side. Sending the same reference with the same request returns the existing order and charges nothing a second time, so it is always safe to retry after a timeout. Reusing a reference for a different order returns 409. Utility payments return the original order when a reference is reused, even if other values changed. AFA registration references are unique across all developers, so include your own prefix. To check on an order, poll its order endpoint; Datagod does not send webhooks.",
    endpoints: [],
  },
  {
    id: "sandbox",
    label: "Sandbox",
    group: "start",
    intro:
      "Test keys (prefix dg2_test_) run against a sandbox: they never touch your real wallet or place real orders. Balance calls return a separate sandbox balance with sandbox: true, so you can build and verify your integration end to end before switching to a live key (prefix dg2_live_). Test keys are active immediately and need no approval, so you can start building straight away; live keys start as pending and work only after Datagod approves them. Test and live keys are revoked independently, and each environment has its own rate-limit counters.",
    endpoints: [],
  },
]

/** Every access/limit error a standard-key endpoint can return, using the real API strings. */
function standardAccessErrors(): { status: number; message: string }[] {
  return [
    { status: 401, message: MSG_UNAUTHORIZED },
    { status: 403, message: MSG_SUSPENDED },
    { status: 403, message: MSG_PENDING },
    { status: 403, message: MSG_REVOKED },
    { status: 403, message: msgWrongKeyType("standard") },
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
    "Check the balance before a large purchase to avoid a 400 for insufficient funds.",
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
    "Orders are placed one after another and a request stops starting new placements after 35 seconds. Items not reached come back failed with " + MSG_NOT_ATTEMPTED + "; resend the same batch and the placed ones are replayed without a second charge.",
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
      "An order's status is one of six values. pending: accepted and charged, waiting to be sent to the network. processing: being delivered. completed: the data was delivered. failed: delivery did not happen. refunded: the order did not complete and the amount was credited back to your wallet. queued: an MTN number that is waiting for its registration to finish before the order is sent; it moves on automatically. Statuses can change over time, so poll the order endpoint until you reach completed, failed or refunded.",
    endpoints: [],
  },
  {
    id: "bulk-orders",
    label: "Bulk orders",
    group: "data",
    intro:
      "A bulk request takes 1 to 100 orders. Datagod validates the whole batch first: if any item is invalid, names an unavailable package, has a number that does not match its network, or reuses a reference for different content, the whole request is rejected with the failing orders[i] position and nothing is charged. Once validation passes, MTN numbers that are not registered are skipped (listed in skipped with reason NOT_REGISTERED, never charged) and the rest are placed one at a time, so the result can be partial: read each item in results (placed, replayed or failed) and total_charged.",
    callouts: [
      {
        tone: "info",
        title: "Deadline and NOT_ATTEMPTED",
        body: "A request stops starting new placements after 35 seconds. Items not reached are returned as failed with NOT_ATTEMPTED: retry this item. Nothing was charged for them.",
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
]
