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
      "The Datagod Developer API lets approved partners work with their Datagod account from their own software: check your wallet balance and account role, buy data bundles, buy airtime, pay utility bills, buy results checker vouchers (WASSCE, BECE and NOVDEC) and register customers for AFA, and send SMS to your customers with SMS credits. Every request is made over HTTPS to " +
      V2_BASE_URL +
      ", is authenticated with an API key, and returns JSON in a single consistent envelope. Version 1 of the API keeps working unchanged for existing integrations; v2 runs beside it.",
    endpoints: [],
  },
  {
    id: "authentication",
    label: "Authentication",
    group: "start",
    intro:
      "Send your API key on every request. The preferred form is the Authorization header containing the raw key. Two equivalent forms are also accepted: Authorization: Bearer <key>, and the X-API-Key header. If more than one is sent, Authorization wins. A missing, malformed or unknown key returns 401. The key's type decides which endpoints it can call: a standard key calls the data, wallet, account, results checker and AFA endpoints, a commission key calls the airtime and utility bill endpoints, and an SMS key calls the SMS endpoints (it spends SMS credits, not your wallet). A key of the wrong type returns 403.",
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
      "Each key has a type and works only with that type's endpoint group; calling another group returns 403. Standard keys unlock data, wallet, orders, the results checker and AFA registration. Commission Services keys unlock airtime and utility bill payments (the Commission endpoints, such as POST /airtime/purchase and POST /utilities/pay). SMS keys unlock the SMS endpoints (they spend SMS credits, not your wallet) and are generated on the same Developer API page when your account has SMS enabled. A key is also either live (real wallet, real orders) or test (sandbox). A key shows as pending, active or revoked; only active keys can call the API, and revoking a key disables it rather than deleting it.",
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
      "Every purchase endpoint takes a reference that you choose and that must be unique to the order on your side. Sending the same reference with the same request returns the existing order and charges nothing a second time, so it is always safe to retry after a timeout. Reusing a reference for a different order returns 409. Airtime and utility bill payments follow the stricter claim rules in Idempotency and references (airtime and bills): a reference is required and a request that is still unconfirmed is never run a second time. Results checker purchases and AFA registrations follow the same claim rules (see Idempotency and references (results checker and AFA)): a replay returns the existing order, and for the results checker the same PINs, with no second charge; their references are unique within your account. Live data order references share one namespace with orders placed through version 1 of the API: sending a v1 order's reference with the same network, size and recipient returns that order as a replay, and different content returns 409. SMS sends follow the same claim rules (see Idempotency and references (SMS)): a replay returns the stored send summary with nothing sent again, and SMS references are their own namespace. To check on an order, poll its order endpoint; Datagod does not send webhooks.",
    endpoints: [],
  },
  {
    id: "sandbox",
    label: "Sandbox",
    group: "start",
    intro:
      "Test keys (prefix dg2_test_) run against a sandbox: they never touch your real wallet or place real orders. Balance calls return a separate sandbox balance with sandbox: true, so you can build and verify your integration end to end before switching to a live key (prefix dg2_live_). The same holds for commission keys: a test commission key places airtime and bill orders against the sandbox wallet and never calls a provider, a sandbox verify_token from POST /utilities/lookup works only with test keys and a live verify_token only with live keys (any other pairing returns 400), and a sandbox replay behaves like a live one. A test standard key buys results checker vouchers with fake TEST- PINs against the sandbox wallet and registers AFA customers without anything being registered. A test SMS key sends nothing and spends no credits (see SMS sandbox). Sandbox references are unique per account across all order types (data, airtime, bills and the rest), while live references are unique per order type, so a reference reused for a different order type can conflict in the sandbox only: use a distinct prefix per order type. Test keys are active immediately and need no approval, so you can start building straight away; live keys start as pending and work only after Datagod approves them. Test and live keys are revoked independently, and each environment has its own rate-limit counters.",
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

// ---------------------------------------------------------------- Results checker and AFA (standard key)
//
// Client-safe like the commission block above: results.ts / afa.ts / standard-orders.ts pull in node
// crypto, so the strings below are literal copies. registry.test.ts imports the real constants,
// handlers and parsers and asserts there is no drift.

const RESULTS_BOARDS_TEXT = "WASSCE, BECE or NOVDEC"
const AFA_REGIONS = [
  "Ahafo",
  "Ashanti",
  "Bono",
  "Bono East",
  "Central",
  "Eastern",
  "Greater Accra",
  "North East",
  "Northern",
  "Oti",
  "Savannah",
  "Upper East",
  "Upper West",
  "Volta",
  "Western",
  "Western North",
]
const AFA_REGIONS_TEXT = AFA_REGIONS.join(", ")
const GHANA_CARD_EXAMPLE = "GHA-000000000-0"
const MAX_VOUCHER_QUANTITY = 15

const MSG_EXAM_BOARD = "exam_board must be one of: WASSCE, BECE, NOVDEC"
const MSG_QUANTITY = `quantity must be a whole number from 1 to ${MAX_VOUCHER_QUANTITY}`
const MSG_RECIPIENT_PHONE = "recipient_phone must be a valid Ghana mobile number"
const MSG_RECIPIENT_EMAIL = "recipient_email must be a valid email address"
const MSG_FULL_NAME = "full_name must be 3 to 100 characters and contain at least two letters"
const MSG_AFA_PHONE = "phone must be a valid Ghana mobile number"
const MSG_ID_TYPE = 'id_type must be "Ghana Card"'
const MSG_ID_NUMBER = "id_number must be a valid Ghana Card number"
const MSG_REGION = `region must be one of: ${AFA_REGIONS_TEXT}`
const MSG_LOCATION = "location must be 2 to 120 characters"
const MSG_OCCUPATION = "occupation must be at most 80 characters"

const RC_TAIL =
  "Do not place this order again under a new reference. Poll GET /resultschecker/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
const AFA_TAIL =
  "Do not place this registration again under a new reference. Poll GET /afa/orders/{reference}, whose claim.state reports it, or contact support quoting the reference"
const MSG_RC_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${RC_TAIL}`
const MSG_RC_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${RC_TAIL}`
const MSG_RC_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this purchase is not confirmed yet. ${RC_TAIL}`
const MSG_AFA_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${AFA_TAIL}`
const MSG_AFA_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${AFA_TAIL}`
const MSG_AFA_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this registration is not confirmed yet. ${AFA_TAIL}`
const MSG_RC_CLAIM_UNAVAILABLE = "UNAVAILABLE: could not reserve this reference; nothing was charged. Retry with the same reference"
const MSG_VOUCHERS_UNAVAILABLE =
  "VOUCHERS_UNAVAILABLE: your order was placed and charged; its vouchers could not be read right now. Retry with the same reference or contact support; do not place a new order."
const MSG_RC_PRICE_UNAVAILABLE = "UNAVAILABLE: the voucher price could not be confirmed; nothing was charged. Retry with the same reference"
const MSG_INSUFFICIENT_INVENTORY = `OUTCOME_UNKNOWN: the vouchers for this exam board ran out after the wallet was charged, and a refund to the wallet was attempted. Check your wallet balance and order history. ${RC_TAIL}`
const MSG_AFA_DUPLICATE =
  "DUPLICATE_REGISTRATION: a registration for this customer was just submitted. Look it up under its original reference; do not resubmit under a new reference"
const MSG_PRICE_UNAVAILABLE = "PRICE_UNAVAILABLE: AFA registration is temporarily unavailable"

const RC_ORDER_EXAMPLE = {
  reference: "RC-2026-0001",
  exam_board: "WASSCE",
  quantity: 2,
  unit_price: 25,
  total_paid: 50,
  status: "completed",
  created_at: TS,
}

// Obviously fake: the real API returns real PINs only to a live key; these are test-key style values.
const RC_VOUCHERS_EXAMPLE = [
  { pin: "TEST-00000001", serial_number: "SANDBOX-WASSCE-0001" },
  { pin: "TEST-00000002", serial_number: "SANDBOX-WASSCE-0002" },
]

const AFA_ORDER_EXAMPLE = {
  reference: "AFA-2026-0001",
  full_name: "Ama Serwaa Boateng",
  phone: "0244000001",
  region: "Greater Accra",
  amount: 10,
  status: "pending",
  fulfillment: "pending",
  created_at: TS,
}

const standardLookupNotes = (what: string, path: string, extra: string[]): string[] => [
  `A found ${what} returns HTTP 200 with { order, ... , claim: null }. ${COMMISSION_STATUS_NOTE}`,
  `If your own request with this reference is still unconfirmed, the answer is HTTP 200 with order: null and claim: { reference, state }, where claim.state is in_progress (still being processed) or outcome_unknown (not confirmed). An in_progress request older than 10 minutes reads outcome_unknown. Never place the ${what} again under a new reference; keep polling ${path}, or contact support quoting the reference.`,
  "A reference that does not exist, is malformed, or belongs to another account all return the same identical 404, so references cannot be probed. A 404 never proves nothing was charged after an unknown outcome.",
  ...extra,
  "With a test key this reads your sandbox orders and the response carries sandbox: true.",
]

const RC_TYPES_ENDPOINT: V2Endpoint = {
  id: "results-types",
  group: "results",
  method: "GET",
  path: "/resultschecker/types",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists the exam boards you can buy results checker vouchers for, the unit price your account pays and how many are in stock.",
  params: [],
  requestExample: null,
  successExample: {
    success: true,
    data: {
      types: [
        { exam_board: "WASSCE", price: 25, available: 240, enabled: true },
        { exam_board: "BECE", price: 20, available: 118, enabled: true },
        { exam_board: "NOVDEC", price: 22, available: 0, enabled: false },
      ],
    },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [...standardAccessErrors(), { status: 503, message: MSG_CATALOG_UNAVAILABLE }],
  notes: [
    "Always returns the three boards, WASSCE, BECE and NOVDEC. price is the unit price in GHS (the same price applies to every account); you never send a price when buying.",
    "enabled: false means the board is switched off right now and a purchase for it returns 503. available is how many vouchers are in stock; a purchase for more than that returns 409 OUT_OF_STOCK.",
    "A board whose price or stock could not be read right now shows price: null, available: 0 and enabled: false. If none of the boards can be read the call returns 503.",
    "No PINs are ever shown here.",
  ],
}

const RC_PURCHASE_ENDPOINT: V2Endpoint = {
  id: "results-purchase",
  group: "results",
  method: "POST",
  path: "/resultschecker/purchase",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group)`,
  summary:
    "Buys results checker vouchers for one exam board, charges your wallet and returns the PINs. Test keys use a sandbox wallet and return fake PINs.",
  params: [
    { name: "exam_board", type: "string", required: true, description: `${RESULTS_BOARDS_TEXT} (case-insensitive). GET /resultschecker/types shows which boards are on.` },
    {
      name: "quantity",
      type: "integer",
      required: true,
      description: `Number of vouchers, a whole number from 1 to your maximum per purchase. The maximum is set by Datagod and can change; it is currently ${MAX_VOUCHER_QUANTITY}. A number or a digits-only string.`,
    },
    { name: "reference", type: "string", required: true, description: "Your own unique id for this purchase: 3 to 100 characters, letters, digits and - _ . : only. Required: it makes retries safe." },
    { name: "recipient_phone", type: "string", required: false, description: "Ghana mobile number to receive the vouchers by SMS: 0244000001, 233244000001 or +233244000001. Leave it out to send nothing. See Voucher PINs." },
    { name: "recipient_email", type: "string", required: false, description: "Email address to receive the vouchers. Leave it out to send nothing. See Voucher PINs." },
  ],
  requestExample: { exam_board: "WASSCE", quantity: 2, reference: "RC-2026-0001", recipient_phone: "0244000001" },
  successExample: {
    success: true,
    data: { order: RC_ORDER_EXAMPLE, vouchers: RC_VOUCHERS_EXAMPLE, new_balance: 70.5 },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_EXAM_BOARD },
    { status: 400, message: MSG_QUANTITY },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_RECIPIENT_PHONE },
    { status: 400, message: MSG_RECIPIENT_EMAIL },
    { status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 50.00" },
    { status: 402, message: "INSUFFICIENT_BALANCE: test balance is too low; required 50.00" },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_RC_IN_PROGRESS },
    { status: 409, message: MSG_RC_PRIOR_UNKNOWN },
    { status: 409, message: "OUT_OF_STOCK: WASSCE vouchers are out of stock for this quantity; nothing was charged" },
    { status: 500, message: MSG_RC_UNKNOWN },
    { status: 500, message: MSG_INSUFFICIENT_INVENTORY },
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 500, message: MSG_SANDBOX_NOT_PLACED },
    ...standardAccessErrors(),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
    { status: 503, message: "WASSCE vouchers are currently unavailable" },
    { status: 503, message: MSG_RC_CLAIM_UNAVAILABLE },
    { status: 503, message: MSG_RC_PRICE_UNAVAILABLE },
    { status: 503, message: MSG_VOUCHERS_UNAVAILABLE },
  ],
  notes: [
    "A new purchase returns HTTP 201 with the order, the vouchers (pin and serial_number each) and your new wallet balance. The PINs are in this response; see Voucher PINs.",
    "Never send a price. The price is set by Datagod and is the same for every account; price, amount, total, status and similar fields are rejected with 400 Unexpected field.",
    "Resending the same reference with the same request is safe: it returns HTTP 200 with replayed: true and the existing order, and you are not charged a second time. The PINs are repeated to you on a replay (to the account owner only) and a replay never sends an SMS or email again. Reusing a reference for a different request returns 409 REFERENCE_REUSED.",
    "The reference is claimed before anything is charged. 409 REQUEST_IN_PROGRESS and 409 OUTCOME_UNKNOWN mean an earlier request with this reference is not confirmed yet: never place the order again under a new reference. Poll GET /resultschecker/orders/{reference} and read claim.state, or contact support quoting the reference.",
    "500 OUTCOME_UNKNOWN means this request may or may not have charged you. The reference is locked to that outcome and is never run a second time automatically. Do not retry under a new reference.",
    "A 500 whose message says the vouchers ran out after the wallet was charged is also OUTCOME_UNKNOWN: the engine charged the wallet, could not assign the vouchers and attempted a refund. It is never a 503 and it does not mean nothing was charged. The reference stays locked, so check your wallet balance and read the reference back with GET /resultschecker/orders/{reference}, and never place the order again under a new reference; contact support quoting the reference.",
    "409 OUT_OF_STOCK is returned before anything is charged: fewer vouchers are in stock than the quantity you asked for, so nothing was charged and the reference is free again. A board that is switched off returns 503 with nothing charged. A 503 whose message starts with UNAVAILABLE (could not reserve this reference, or could not confirm the voucher price) also means nothing was charged, so retry with the same reference.",
    "A 503 VOUCHERS_UNAVAILABLE is different: your order was placed and charged, but its vouchers could not be read right now. Retry the same request with the same reference (or read it with GET /resultschecker/orders/{reference}), or contact support; never place a new order.",
    "402 means the wallet cannot cover the purchase and nothing was charged; the message states the amount required.",
    "Live purchases require the phone number on your Datagod account to be verified. Until it is, a live key gets 403 PHONE_NOT_VERIFIED and nothing is charged; verify the number in the dashboard. Replays of an existing order are not blocked by this check.",
    "A test key uses a separate sandbox wallet and returns fake vouchers with TEST- PINs: the response carries sandbox: true, no provider is contacted, no real voucher is issued and no SMS or email is sent. A replay works the same way.",
  ],
}

const RC_LIST_ENDPOINT: V2Endpoint = {
  id: "results-orders",
  group: "results",
  method: "GET",
  path: "/resultschecker/orders",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists your most recent results checker orders under the references you chose. The list never contains PINs.",
  params: [],
  requestExample: null,
  successExample: { success: true, data: { orders: [RC_ORDER_EXAMPLE] }, meta: { timestamp: TS, version: "2" } },
  errors: [
    ...standardAccessErrors(),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "Returns up to 30 orders. Only purchases that were placed successfully are listed; a request that is still unconfirmed shows up through GET /resultschecker/orders/{reference} instead.",
    "Each order has the same shape as in POST /resultschecker/purchase, without the vouchers. To read the PINs of one order, look it up by reference. " + COMMISSION_STATUS_NOTE,
    "With a test key the list is your sandbox orders and the response carries sandbox: true.",
  ],
}

const RC_ORDER_ENDPOINT: V2Endpoint = {
  id: "results-order-lookup",
  group: "results",
  method: "GET",
  path: "/resultschecker/orders/{reference}",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one results checker order and its vouchers by the reference you chose, or tells you that your request is still unconfirmed.",
  params: [{ name: "reference", type: "string", required: true, description: "The reference you sent with POST /resultschecker/purchase (path parameter)." }],
  requestExample: null,
  successExample: {
    success: true,
    data: { order: RC_ORDER_EXAMPLE, vouchers: RC_VOUCHERS_EXAMPLE, claim: null },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 404, message: MSG_ORDER_MISSING },
    ...standardAccessErrors(),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 503, message: MSG_VOUCHERS_UNAVAILABLE },
  ],
  notes: standardLookupNotes("results checker order", "this endpoint", [
    "The vouchers are returned only to the account that owns the order. An order that has not completed yet returns vouchers: [] (an empty list); keep polling until its status is completed. If the vouchers cannot be read right now the call returns 503 instead of an empty list: retry the same request.",
  ]),
}

const AFA_REGISTER_ENDPOINT: V2Endpoint = {
  id: "afa-register",
  group: "results",
  method: "POST",
  path: "/afa/register",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group)`,
  summary: "Registers one customer for AFA and charges your wallet. Test keys use a sandbox wallet and register nothing.",
  params: [
    { name: "reference", type: "string", required: true, description: "Your own unique id for this registration: 3 to 100 characters, letters, digits and - _ . : only. Required: it makes retries safe." },
    { name: "full_name", type: "string", required: true, description: "The customer's full name as on their Ghana Card: 3 to 100 characters with at least two letters." },
    { name: "phone", type: "string", required: true, description: "The customer's Ghana mobile number: 0244000001, 233244000001 or +233244000001." },
    { name: "id_type", type: "string", required: true, description: 'Must be "Ghana Card" (case-insensitive). No other ID type is accepted.' },
    { name: "id_number", type: "string", required: true, description: `The customer's real Ghana Card number. ${GHANA_CARD_EXAMPLE} in the examples is a PLACEHOLDER that must be replaced with a real card number: the format is accepted, so a live key that sends the placeholder is charged and the registration then fails at fulfillment. The format is the letters GHA, 9 digits, a dash and 1 check digit; a number typed without the dashes or the GHA prefix is accepted if it has exactly 10 digits.` },
    { name: "region", type: "string", required: true, description: `One of: ${AFA_REGIONS_TEXT} (case-insensitive).` },
    { name: "location", type: "string", required: true, description: "The customer's town or area: 2 to 120 characters." },
    { name: "occupation", type: "string", required: false, description: "The customer's occupation: at most 80 characters." },
  ],
  requestExample: {
    reference: "AFA-2026-0001",
    full_name: "Ama Serwaa Boateng",
    phone: "0244000001",
    id_type: "Ghana Card",
    id_number: GHANA_CARD_EXAMPLE,
    region: "Greater Accra",
    location: "Madina, Accra",
    occupation: "Trader",
  },
  successExample: { success: true, data: { order: AFA_ORDER_EXAMPLE }, meta: { timestamp: TS, version: "2" } },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_FULL_NAME },
    { status: 400, message: MSG_AFA_PHONE },
    { status: 400, message: MSG_ID_TYPE },
    { status: 400, message: MSG_ID_NUMBER },
    { status: 400, message: MSG_REGION },
    { status: 400, message: MSG_LOCATION },
    { status: 400, message: MSG_OCCUPATION },
    { status: 402, message: "INSUFFICIENT_BALANCE: wallet balance is too low; required 10.00" },
    { status: 402, message: "INSUFFICIENT_BALANCE: test balance is too low; required 10.00" },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_AFA_IN_PROGRESS },
    { status: 409, message: MSG_AFA_PRIOR_UNKNOWN },
    { status: 409, message: MSG_AFA_DUPLICATE },
    { status: 500, message: MSG_AFA_UNKNOWN },
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 500, message: MSG_SANDBOX_NOT_PLACED },
    ...standardAccessErrors(),
    { status: 403, message: MSG_PHONE_GATE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
    { status: 503, message: MSG_RC_CLAIM_UNAVAILABLE },
    { status: 503, message: MSG_PRICE_UNAVAILABLE },
  ],
  notes: [
    "A new registration returns HTTP 201 with the order. The registration starts as pending; poll GET /afa/orders/{reference} to follow it. fulfillment reads pending, fulfilled or failed. See AFA registration.",
    "Never send a price. The AFA price is set by Datagod and charged with the registration; price, amount, status and similar fields are rejected with 400 Unexpected field. A date of birth is not required.",
    "Resending the same reference with the same request is safe: it returns HTTP 200 with replayed: true and the existing order, and you are not charged a second time. Reusing a reference for a different request returns 409 REFERENCE_REUSED.",
    "The reference is claimed before anything is charged. 409 REQUEST_IN_PROGRESS and 409 OUTCOME_UNKNOWN mean an earlier request with this reference is not confirmed yet: never register again under a new reference. Poll GET /afa/orders/{reference} and read claim.state, or contact support quoting the reference.",
    "500 OUTCOME_UNKNOWN means this request may or may not have charged you. The reference is locked to that outcome and is never run a second time automatically. Do not retry under a new reference.",
    "409 DUPLICATE_REGISTRATION means a registration for the same phone number or the same Ghana Card was made on your account in the last 10 minutes. Nothing was charged and the reference is free again; look the earlier one up under its original reference.",
    "The Ghana Card number is never returned, echoed or logged: it is not in any response, order, list or error message.",
    "Live registrations require the phone number on your Datagod account to be verified. Until it is, a live key gets 403 PHONE_NOT_VERIFIED and nothing is charged; verify the number in the dashboard. Replays of an existing order are not blocked by this check.",
    "A test key uses a separate sandbox wallet: the response carries sandbox: true, it reads the active AFA price and charges it to the sandbox wallet, nothing is registered, and a replay works the same way.",
  ],
}

const AFA_LIST_ENDPOINT: V2Endpoint = {
  id: "afa-orders",
  group: "results",
  method: "GET",
  path: "/afa/orders",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists your most recent AFA registrations under the references you chose.",
  params: [],
  requestExample: null,
  successExample: { success: true, data: { orders: [AFA_ORDER_EXAMPLE] }, meta: { timestamp: TS, version: "2" } },
  errors: [
    ...standardAccessErrors(),
    { status: 500, message: MSG_SANDBOX_UNAVAILABLE },
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    "Returns up to 30 registrations. Only registrations that were placed successfully are listed; a request that is still unconfirmed shows up through GET /afa/orders/{reference} instead.",
    "Each order has the same shape as in POST /afa/register. " + COMMISSION_STATUS_NOTE,
    "With a test key the list is your sandbox orders and the response carries sandbox: true.",
  ],
}

const AFA_ORDER_ENDPOINT: V2Endpoint = {
  id: "afa-order-lookup",
  group: "results",
  method: "GET",
  path: "/afa/orders/{reference}",
  keyType: "standard",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one AFA registration by the reference you chose, or tells you that your request is still unconfirmed.",
  params: [{ name: "reference", type: "string", required: true, description: "The reference you sent with POST /afa/register (path parameter)." }],
  requestExample: null,
  successExample: { success: true, data: { order: AFA_ORDER_EXAMPLE, claim: null }, meta: { timestamp: TS, version: "2" } },
  errors: [{ status: 404, message: MSG_ORDER_MISSING }, ...standardAccessErrors(), { status: 500, message: MSG_SANDBOX_UNAVAILABLE }],
  notes: standardLookupNotes("registration", "this endpoint", [
    "fulfillment is pending until the registration has been processed, then fulfilled or failed.",
  ]),
}

const RESULTS_SECTIONS: V2DocSection[] = [
  {
    id: "voucher-pins",
    label: "Voucher PINs",
    group: "results",
    intro:
      "A results checker voucher is a pin and a serial_number. The PINs are returned in the purchase response, and they can be read again later through GET /resultschecker/orders/{reference}, which returns them to the account owner only. Treat every PIN like a password: never log them or store them in plain text on your side, and do not put them in URLs or analytics events. The list endpoint never returns PINs, only orders. If you give recipient_phone or recipient_email, Datagod also sends the vouchers by SMS or email to that recipient only, as a best effort that never changes the purchase result; a message is never sent to your own account's contact details, and if you give neither, nothing is sent. A replay never re-sends an SMS or email. Test keys return obviously fake PINs that start with TEST- and cannot be used on any exam site.",
    callouts: [
      {
        tone: "warning",
        title: "PINs are secrets",
        body: "Anyone holding a PIN can use the voucher. Pass PINs straight to your customer over a secure channel and keep only the order reference. If you need a PIN again, read it back with GET /resultschecker/orders/{reference}.",
      },
    ],
    endpoints: [],
  },
  {
    id: "results-idempotency",
    label: "Idempotency and references (results checker and AFA)",
    group: "results",
    intro:
      "Every results checker purchase and every AFA registration needs a reference that you choose: 3 to 100 characters, letters, digits and - _ . : only, unique to the order on your side. The reference is required. Datagod reserves it before anything is charged, and a request can end in one of four ways. A new request is charged once and returns HTTP 201. The same reference with the same request returns HTTP 200 with replayed: true and the existing order (and, for the results checker, its PINs), with no second charge. The same reference with a different request returns 409 REFERENCE_REUSED. A reference whose earlier request is not confirmed yet returns 409 REQUEST_IN_PROGRESS while it is running, or 409 OUTCOME_UNKNOWN once it has been unconfirmed for more than 10 minutes or ended without a clear result. If the reference cannot be reserved at all you get 503 and nothing was charged; retry with the same reference. Live references are unique per order type within your account (a results reference and an AFA reference can be the same string), but sandbox references are unique per account across all order types, so reusing one reference for different order types can conflict in the sandbox: use a distinct prefix per order type (for example RC- and AFA-).",
    steps: [
      "Create one reference per order and store it before you send the request.",
      "On a timeout or a network error, resend the same request with the same reference: you get the existing order back, never a second charge.",
      "On 409 REQUEST_IN_PROGRESS or 409 OUTCOME_UNKNOWN, or a 500 OUTCOME_UNKNOWN, never resend under a new reference. Poll GET /resultschecker/orders/{reference} or GET /afa/orders/{reference} and read claim.state: in_progress means it is still running, outcome_unknown means it is not confirmed.",
      "If claim.state stays outcome_unknown, contact support quoting the reference. Support will investigate the reference you quote; do not place the order again meanwhile.",
    ],
    callouts: [
      {
        tone: "warning",
        title: "A 404 is not proof that nothing was charged",
        body: 'After an unknown outcome, a missing order is not a safe answer: a 404 never means "not charged". The order lookup answers HTTP 200 with order: null and claim.state for your own unconfirmed request, and a plain 404 only when the reference was never used by your account. Never place the order again under a new reference to "fix" an unknown outcome; that is how customers are charged twice.',
      },
    ],
    endpoints: [],
  },
  {
    id: "results-types",
    label: "Exam boards",
    group: "results",
    intro: "See which exam boards are on, the unit price your account pays and the stock.",
    endpoints: [RC_TYPES_ENDPOINT],
  },
  {
    id: "results-purchase",
    label: "Buy results checker vouchers",
    group: "results",
    intro: "Buy WASSCE, BECE or NOVDEC vouchers. Purchases are paid from your wallet and are safe to retry with the same reference.",
    endpoints: [RC_PURCHASE_ENDPOINT],
  },
  {
    id: "results-orders",
    label: "Results checker orders",
    group: "results",
    intro: "List your orders, or look one up by reference to read its vouchers.",
    endpoints: [RC_LIST_ENDPOINT, RC_ORDER_ENDPOINT],
  },
  {
    id: "afa-registration",
    label: "AFA registration",
    group: "results",
    intro: `An AFA registration needs the customer's name, phone number, Ghana Card, region and location; occupation is optional. id_type must be "Ghana Card", the only ID type accepted, and id_number must be a valid Ghana Card number in the format ${GHANA_CARD_EXAMPLE} (the letters GHA, 9 digits, a dash and 1 check digit). ${GHANA_CARD_EXAMPLE} is a placeholder used in the examples only: replace it with the customer's real card number, because the format is accepted and a live key that sends the placeholder is charged and then fails at fulfillment. A date of birth is not required, and nothing about one is stored or checked. The region must be one of the 16 official regions: ${AFA_REGIONS_TEXT}. To protect your customers and your wallet, a new registration is refused with 409 DUPLICATE_REGISTRATION when a registration for the same phone number or the same Ghana Card was made on your account in the last 10 minutes and has not failed. Nothing is charged for a refused request and the reference is free again; look the earlier registration up under its original reference instead of submitting it again. The Ghana Card number is used only to register the customer and is never returned by the API.`,
    endpoints: [],
  },
  {
    id: "afa-register",
    label: "Register for AFA",
    group: "results",
    intro: "Register one customer for AFA. Registrations are paid from your wallet and are safe to retry with the same reference.",
    endpoints: [AFA_REGISTER_ENDPOINT],
  },
  {
    id: "afa-orders",
    label: "AFA registrations",
    group: "results",
    intro: "List your registrations, or look one up by reference to follow it to completion.",
    endpoints: [AFA_LIST_ENDPOINT, AFA_ORDER_ENDPOINT],
  },
]

// ---------------------------------------------------------------- Bulk SMS (SMS key)
//
// Client-safe like the blocks above: sms.ts / sms-rules.ts pull in node crypto, so the strings below are
// literal copies. registry.test.ts imports the real constants, handlers and mappers and asserts there is
// no drift.

const SMS_MAX_RECIPIENTS_DOC = 5000
const SMS_BATCH_SIZE_DOC = 500
const SMS_PAGE_SIZE_DOC = 25
const SMS_PENDING_TAIL_DOC =
  "Do not send this again under a new reference. Check GET /sms/campaigns and GET /sms/balance, or contact support quoting the reference"
const SMS_FILTER_STATUSES_TEXT = "queued, sending, sent, partial, failed, blocked, held, scheduled"

const MSG_SMS_MESSAGE = "message must be a string between 3 and 1000 characters"
const MSG_SMS_RECIPIENTS = `recipients must be a non-empty array of strings, at most ${SMS_MAX_RECIPIENTS_DOC} unique numbers`
const MSG_SMS_SENDER_SHAPE = "sender_id must be a non-empty string"
const MSG_SMS_SCHEDULE_FORMAT = "Send a valid date and time with a timezone (ISO 8601, e.g. 2026-10-12T14:30:00Z)"
const MSG_SMS_SCHEDULE_SOON = "Pick a time at least 2 minutes from now"
const MSG_SMS_SCHEDULE_FAR = "You can schedule up to 30 days ahead"
const MSG_SMS_BLOCKED = "BLOCKED: This message contains content we can't send."
const MSG_SMS_POLICY = "POLICY_REJECTED: This send was not accepted by the sending policy."
const MSG_SMS_NOT_ENABLED = "SMS_NOT_ENABLED: SMS isn't enabled for this account"
const MSG_SMS_IN_PROGRESS = `REQUEST_IN_PROGRESS: a request with this reference is still being processed; its outcome is not confirmed yet. ${SMS_PENDING_TAIL_DOC}`
const MSG_SMS_PRIOR_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of an earlier request with this reference is not confirmed yet. ${SMS_PENDING_TAIL_DOC}`
const MSG_SMS_OUTCOME_UNKNOWN = `OUTCOME_UNKNOWN: the outcome of this send is not confirmed yet, so credits may have been reserved. ${SMS_PENDING_TAIL_DOC}`
const MSG_SMS_CLAIM_UNAVAILABLE = "UNAVAILABLE: could not reserve this reference; nothing was sent or charged. Retry with the same reference"
const MSG_SMS_CAMPAIGN_MISSING = "Campaign not found"
const MSG_SMS_PAGE = "page must be a whole number from 1 to 999999"
const MSG_SMS_STATUS_FILTER = `status must be one of: ${SMS_FILTER_STATUSES_TEXT}`

/** The engine's no-charge answers, as the API words them: "CODE: message". */
const SMS_ENGINE_ERRORS: { status: number; message: string }[] = [
  { status: 400, message: "INVALID_SENDER_ID: sender_id is not available for this account" },
  { status: 400, message: MSG_SMS_BLOCKED },
  { status: 400, message: MSG_SMS_POLICY },
  { status: 400, message: "EMPTY_MESSAGE: message is empty after preparation" },
  { status: 400, message: `TOO_MANY_RECIPIENTS: At most ${SMS_MAX_RECIPIENTS_DOC} recipients per send` },
  { status: 400, message: "NO_VALID_RECIPIENTS: None of the recipients is a valid phone number" },
  { status: 402, message: "INSUFFICIENT_CREDITS: Not enough SMS credits for this send" },
  { status: 403, message: "NOT_ACTIVATED: SMS is not activated for this account" },
  { status: 403, message: "SUSPENDED: SMS is suspended for this account" },
  {
    status: 429,
    message:
      "SEND_IN_PROGRESS: Another send from your account is still being processed. Retry this same request with the same reference in a few seconds",
  },
  { status: 503, message: "SMS_DISABLED: SMS is temporarily unavailable. Please try again later." },
]

const SMS_SEND_EXAMPLE = {
  campaign_id: "1042",
  status: "queued",
  total: 2,
  batches: 1,
  segments: 1,
  credits_reserved: 2,
  invalid_skipped: 0,
  partial: false,
  stopped_reason: null,
  held: false,
  scheduled: false,
  scheduled_for: null,
}

const SMS_CAMPAIGN_EXAMPLE = {
  campaign_id: "1042",
  status: "sent",
  sender_id: "ACMEBRAND",
  recipient_count: 2,
  segments: 1,
  credits_reserved: 2,
  credits_used: 2,
  scheduled_for: null,
  created_at: TS,
  completed_at: TS,
}

const SMS_CAMPAIGN_DETAIL_EXAMPLE = {
  ...SMS_CAMPAIGN_EXAMPLE,
  delivery: { delivered: 1, failed: 1, pending: 0, refunded: 1 },
  recipients: [
    { phone: "+233244000001", status: "delivered", refunded: false },
    { phone: "+233244000002", status: "failed", refunded: true },
  ],
}

const SMS_SANDBOX_NOTE = "A test key never sends a message and spends no credits: the response carries sandbox: true. See SMS sandbox."

const SMS_SEND_ENDPOINT: V2Endpoint = {
  id: "sms-send",
  group: "sms",
  method: "POST",
  path: "/sms/send",
  keyType: "sms",
  rateLimit: `${DEFAULT_LIMITS.purchase} requests per minute (purchase group)`,
  summary:
    "Sends one message to up to 5000 recipients and spends SMS credits (not your wallet). Safe to retry with the same reference. Test keys send nothing.",
  params: [
    { name: "reference", type: "string", required: true, description: "Your own unique id for this send: 3 to 100 characters, letters, digits and - _ . : only. Required: it makes retries safe." },
    { name: "message", type: "string", required: true, description: "The message text, 3 to 1000 characters. How many segments (and so credits) it uses is decided by Datagod." },
    { name: "recipients", type: "string[]", required: true, description: `Ghana mobile numbers (0244000001, 233244000001, +233244000001 or the 9-digit form), 1 to ${SMS_MAX_RECIPIENTS_DOC} unique numbers. Duplicates are ignored; a number that is not valid is skipped and reported in invalid_skipped.` },
    { name: "sender_id", type: "string", required: false, description: "A sender ID your account owns (see GET /sms/senders). Leave it out to use your default sender, or your first active one; if you have none, Datagod's platform sender is used when it is available." },
    { name: "scheduled_at", type: "string", required: false, description: "Send later: an ISO 8601 date and time with a timezone, from 2 minutes to 30 days ahead, such as 2026-12-01T09:00:00Z. Leave it out to send now." },
  ],
  requestExample: {
    reference: "SMS-2026-0001",
    message: "Hello from Acme: your order is ready for pickup.",
    recipients: ["0244000001", "0244000002"],
    sender_id: "ACMEBRAND",
  },
  successExample: { success: true, data: { send: SMS_SEND_EXAMPLE }, meta: { timestamp: TS, version: "2" } },
  errors: [
    { status: 400, message: MSG_BODY_OBJECT },
    { status: 400, message: "Unexpected field" },
    { status: 400, message: MSG_REFERENCE },
    { status: 400, message: MSG_SMS_MESSAGE },
    { status: 400, message: MSG_SMS_RECIPIENTS },
    { status: 400, message: MSG_SMS_SENDER_SHAPE },
    { status: 400, message: MSG_SMS_SCHEDULE_FORMAT },
    { status: 400, message: MSG_SMS_SCHEDULE_SOON },
    { status: 400, message: MSG_SMS_SCHEDULE_FAR },
    { status: 403, message: MSG_SMS_NOT_ENABLED },
    { status: 409, message: MSG_REFERENCE_REUSED },
    { status: 409, message: MSG_SMS_IN_PROGRESS },
    { status: 409, message: MSG_SMS_PRIOR_UNKNOWN },
    { status: 500, message: MSG_SMS_OUTCOME_UNKNOWN },
    ...SMS_ENGINE_ERRORS,
    ...standardAccessErrors("sms"),
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
    { status: 503, message: MSG_SMS_CLAIM_UNAVAILABLE },
  ],
  notes: [
    "A new send returns HTTP 201 with { send }. send.status is queued (accepted and being delivered), scheduled (accepted for scheduled_at) or held (accepted but held for review before it goes out). credits_reserved is what the send cost in SMS credits; you never send a price.",
    "Resending the same reference with the same request is safe: it returns HTTP 200 with { send, replayed: true } (the stored summary, no new send, no second charge). Reusing a reference for a different request returns 409 REFERENCE_REUSED. The request is compared by message, recipients, sender_id and scheduled_at; the reference itself is not part of the comparison.",
    `Large sends are split into batches of ${SMS_BATCH_SIZE_DOC} recipients and delivered one after another. send.batches says how many were queued. campaign_id is the id of the FIRST batch only, and GET /sms/campaigns/{campaign_id} describes that first batch only (up to ${SMS_BATCH_SIZE_DOC} recipients); later batches are not addressable by id, but GET /sms/campaigns lists every batch.`,
    "partial: true means the send stopped part-way, typically on INSUFFICIENT_CREDITS, after one or more batches had already been accepted. stopped_reason says why. For a partial send, the first batches batches of 500 recipients (in your list order after duplicates are removed; entries that are not valid phone numbers still occupy a position) were accepted and charged and will be delivered; the rest were not charged. Do not blindly re-send the whole list: work out which recipients come after those first batches and send only those, under a new reference. total counts only the valid numbers that were accepted, so it can be smaller than the number of list positions those batches cover.",
    "held: true means the send was accepted but is held for review; its credits are reserved while it is reviewed, and its status in GET /sms/campaigns shows held until a decision is made. scheduled: true means it will go out at scheduled_for; scheduled_for is null otherwise.",
    "invalid_skipped counts numbers that were not valid phone numbers; they are not sent and not charged. A send in which no number is valid returns 400 NO_VALID_RECIPIENTS.",
    "The reference is claimed before anything is sent. 409 REQUEST_IN_PROGRESS and 409 OUTCOME_UNKNOWN mean an earlier request with this reference is not confirmed yet: never send again under a new reference. Check GET /sms/campaigns and GET /sms/balance, or contact support quoting the reference. 500 OUTCOME_UNKNOWN means credits may have been reserved (this includes a send that could not be queued, because the refund of its credits is not guaranteed); the reference is locked to that outcome and is never run a second time automatically.",
    "A 400, 402, 403, 429 or 503 from the sending rules means nothing was sent or charged and the reference is free again. 429 SEND_IN_PROGRESS means another send from your account is still being accepted: retry the same request with the same reference in a few seconds. BLOCKED and POLICY_REJECTED carry a plain reason in their message.",
    "Message text and phone numbers are never written to logs or alerts on Datagod's side and never appear in error messages.",
    SMS_SANDBOX_NOTE,
  ],
}

const SMS_BALANCE_ENDPOINT: V2Endpoint = {
  id: "sms-balance",
  group: "sms",
  method: "GET",
  path: "/sms/balance",
  keyType: "sms",
  rateLimit: `${DEFAULT_LIMITS.balance} requests per minute (balance group)`,
  summary: "Returns your SMS credit balance. SMS credits are separate from your wallet.",
  params: [],
  requestExample: null,
  successExample: {
    success: true,
    data: { balance: { credits: 480, pending_credits: 0, status: "active" } },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [{ status: 403, message: MSG_SMS_NOT_ENABLED }, ...standardAccessErrors("sms"), { status: 503, message: MSG_CATALOG_UNAVAILABLE }],
  notes: [
    "credits is what you can spend now. pending_credits is credits you have paid for that are not usable yet. status is inactive, active or suspended (or unknown if it cannot be read); only an active account can send.",
    "Top up SMS credits from the SMS dashboard. The API does not charge your wallet for SMS.",
    "With a test key the balance is fixed at 1000 credits and the response carries sandbox: true.",
  ],
}

const SMS_SENDERS_ENDPOINT: V2Endpoint = {
  id: "sms-senders",
  group: "sms",
  method: "GET",
  path: "/sms/senders",
  keyType: "sms",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists the sender IDs on your account and which one is the default.",
  params: [],
  requestExample: null,
  successExample: {
    success: true,
    data: { senders: [{ sender_id: "ACMEBRAND", status: "active", is_default: true, created_at: TS }] },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [{ status: 403, message: MSG_SMS_NOT_ENABLED }, ...standardAccessErrors("sms"), { status: 503, message: MSG_CATALOG_UNAVAILABLE }],
  notes: [
    "status is pending, active, paused, rejected or revoked. Only an active sender can be used to send; only an active sender can be the default (is_default).",
    "Sender IDs are requested and managed in the SMS dashboard, not through the API.",
    "With a test key the list holds one sender, SANDBOX, and the response carries sandbox: true.",
  ],
}

const SMS_CAMPAIGNS_ENDPOINT: V2Endpoint = {
  id: "sms-campaigns",
  group: "sms",
  method: "GET",
  path: "/sms/campaigns",
  keyType: "sms",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Lists your sends (campaigns), newest first, one page at a time.",
  params: [
    { name: "page", type: "integer", required: false, description: "Page number, from 1 (the default) to 999999." },
    { name: "status", type: "string", required: false, description: `Only campaigns with this status: ${SMS_FILTER_STATUSES_TEXT}. A cancelled campaign shows status cancelled in the results but cannot be used as a filter.` },
  ],
  requestExample: null,
  successExample: {
    success: true,
    data: { campaigns: [SMS_CAMPAIGN_EXAMPLE], page: 1, page_size: SMS_PAGE_SIZE_DOC, total: 1, has_more: false },
    meta: { timestamp: TS, version: "2" },
  },
  errors: [
    { status: 400, message: MSG_SMS_PAGE },
    { status: 400, message: MSG_SMS_STATUS_FILTER },
    ...standardAccessErrors("sms"),
    { status: 503, message: MSG_CATALOG_UNAVAILABLE },
  ],
  notes: [
    `Each page holds ${SMS_PAGE_SIZE_DOC} campaigns (page_size). has_more is true when a later page exists; total is the number of campaigns that match.`,
    `A send of more than ${SMS_BATCH_SIZE_DOC} recipients appears as one campaign per batch. The campaign_id returned by POST /sms/send is the first of them.`,
    "status is queued, sending, sent, partial, failed, blocked, held, scheduled or cancelled (unknown if it cannot be read). The message text is not returned.",
    "An account with no SMS account yet returns an empty list rather than an error. With a test key the list is always empty and the response carries sandbox: true.",
  ],
}

const SMS_CAMPAIGN_ENDPOINT: V2Endpoint = {
  id: "sms-campaign-detail",
  group: "sms",
  method: "GET",
  path: "/sms/campaigns/{campaign_id}",
  keyType: "sms",
  rateLimit: `${DEFAULT_LIMITS.status} requests per minute (status group)`,
  summary: "Returns one campaign with its delivery counts and per-recipient status.",
  params: [{ name: "campaign_id", type: "string", required: true, description: "The campaign_id from POST /sms/send or GET /sms/campaigns (path parameter)." }],
  requestExample: null,
  successExample: { success: true, data: { campaign: SMS_CAMPAIGN_DETAIL_EXAMPLE }, meta: { timestamp: TS, version: "2" } },
  errors: [{ status: 404, message: MSG_SMS_CAMPAIGN_MISSING }, ...standardAccessErrors("sms"), { status: 503, message: MSG_CATALOG_UNAVAILABLE }],
  notes: [
    `For a send of more than ${SMS_BATCH_SIZE_DOC} recipients the campaign_id from POST /sms/send is the FIRST batch, so this endpoint covers that batch only (up to ${SMS_BATCH_SIZE_DOC} recipients). Use GET /sms/campaigns to see the other batches.`,
    "Each recipient has a status of delivered, failed, sent (handed to the network, not yet confirmed) or pending, and refunded: true when the credit for that message was returned. delivery totals the same counts.",
    "Recipient numbers are returned only to the account that owns the campaign. A campaign that does not exist, is malformed or belongs to another account all return the same 404.",
    "With a test key this always returns 404, because a test send creates no campaign.",
  ],
}

const SMS_SECTIONS: V2DocSection[] = [
  {
    id: "sms-overview",
    label: "SMS: keys and credits",
    group: "sms",
    intro:
      "The SMS endpoints need an SMS key (prefix dg2_sms_live_ or dg2_sms_test_), generated on the Developer API page by an account that has SMS enabled. A standard or commission key cannot call them, and an SMS key cannot call the other endpoints; the wrong type returns 403. SMS sends spend SMS credits, not your wallet: top up credits in the SMS dashboard and read the balance with GET /sms/balance. A send that needs more credits than you have returns 402 INSUFFICIENT_CREDITS and nothing is sent.",
    callouts: [
      {
        tone: "info",
        title: "Credits, not wallet",
        body: "Wallet balance and SMS credits are two separate balances. GET /wallet/balance never shows SMS credits, and GET /sms/balance never shows your wallet.",
      },
    ],
    endpoints: [],
  },
  {
    id: "sms-send",
    label: "Send SMS",
    group: "sms",
    intro: "Send a message to one or many recipients, now or at a scheduled time. Sends are safe to retry with the same reference.",
    endpoints: [SMS_SEND_ENDPOINT],
  },
  {
    id: "sms-balance",
    label: "SMS balance",
    group: "sms",
    intro: "Read your SMS credit balance.",
    endpoints: [SMS_BALANCE_ENDPOINT],
  },
  {
    id: "sms-senders",
    label: "Sender IDs",
    group: "sms",
    intro: "See which sender IDs you can send from.",
    endpoints: [SMS_SENDERS_ENDPOINT],
  },
  {
    id: "sms-campaigns",
    label: "Campaigns",
    group: "sms",
    intro: "List your sends, or open one to see how each recipient's message went.",
    endpoints: [SMS_CAMPAIGNS_ENDPOINT, SMS_CAMPAIGN_ENDPOINT],
  },
  {
    id: "sms-idempotency",
    label: "Idempotency and references (SMS)",
    group: "sms",
    intro:
      "Every send needs a reference that you choose: 3 to 100 characters, letters, digits and - _ . : only, unique to the send on your side. Datagod reserves it before anything is sent, and a request ends in one of four ways. A new request is sent once and returns HTTP 201. The same reference with the same request returns HTTP 200 with replayed: true and the stored summary, with nothing sent or charged again. The same reference with a different request returns 409 REFERENCE_REUSED. A reference whose earlier request is not confirmed yet returns 409 REQUEST_IN_PROGRESS while it is running, or 409 OUTCOME_UNKNOWN once it has been unconfirmed for more than 10 minutes or ended without a clear result. If the reference cannot be reserved at all you get 503 and nothing was sent; retry with the same reference. SMS has no order lookup by reference: after an unknown outcome, check GET /sms/campaigns and GET /sms/balance, and contact support quoting the reference. Never send again under a new reference to fix an unknown outcome; that is how recipients get the message twice. SMS references are their own namespace: a data order and an SMS send can use the same string.",
    steps: [
      "Create one reference per send and store it before you send the request.",
      "On a timeout or a network error, resend the same request with the same reference: you get the stored summary back, never a second send.",
      "On 409 REQUEST_IN_PROGRESS, 409 OUTCOME_UNKNOWN or 500 OUTCOME_UNKNOWN, never resend under a new reference. Check GET /sms/campaigns and GET /sms/balance; if it stays unclear, contact support quoting the reference.",
      "On a 400, 402, 403, 429 or 503 listed for the send, nothing was sent or charged, so you can fix the problem and send again, with the same reference.",
    ],
    endpoints: [],
  },
  {
    id: "sms-sandbox",
    label: "SMS sandbox",
    group: "sms",
    intro:
      "A test SMS key (prefix dg2_sms_test_) is active immediately and needs no approval. The SMS sandbox is stateless: nothing is sent, no credits are spent and nothing is stored. POST /sms/send checks your request exactly like a live send (the same 400 errors) and answers 201 with { send, sandbox: true } where campaign_id is null, credits_reserved equals the number of recipients, and scheduled follows scheduled_at; the sandbox validates the request shape and limits only, and does NOT check recipient validity, sender ownership or credits: a list with no valid phone number is accepted in the sandbox but returns 400 NO_VALID_RECIPIENTS with a live key, and a sender_id you do not own or a balance that is too low is not caught either, so test those cases with care on a live key; there is no replay in the sandbox, so the same reference can be sent again and is never compared. GET /sms/balance always shows 1000 credits, GET /sms/senders lists one active default sender, SANDBOX, GET /sms/campaigns is always an empty list, and GET /sms/campaigns/{campaign_id} always returns 404. Every sandbox response carries sandbox: true except that 404.",
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
  ...COMMISSION_SECTIONS,
  ...RESULTS_SECTIONS,
  ...SMS_SECTIONS,
]
