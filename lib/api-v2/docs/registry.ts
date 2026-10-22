import type { KeyType } from "../keys"

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

export const V2_BASE_URL = "https://api.datagod.store/v2"

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
      "Choose the key type and environment you need, then generate the key and accept the API usage policy.",
      "Copy the key and store it somewhere safe, such as a secrets manager or an environment variable on your server.",
      "Wait for admin approval. A new key starts as pending and every call returns 403 until Datagod approves it; once approved it becomes active and works immediately.",
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
      "Test keys (prefix dg2_test_) run against a sandbox: they never touch your real wallet or place real orders. Balance calls return a separate sandbox balance with sandbox: true, so you can build and verify your integration end to end before switching to a live key (prefix dg2_live_). Test and live keys are approved, rate limited and revoked independently, and each environment has its own rate-limit counters.",
    endpoints: [],
  },
]

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
  errors: [
    { status: 401, message: "Invalid or missing API key" },
    { status: 403, message: "This API key is pending approval" },
    { status: 429, message: "Rate limit exceeded" },
  ],
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
  errors: [
    { status: 401, message: "Invalid or missing API key" },
    { status: 403, message: "This API key is not permitted to use this endpoint" },
    { status: 429, message: "Rate limit exceeded" },
    { status: 500, message: "Failed to fetch wallet balance" },
  ],
  notes: [
    "Check the balance before a large purchase to avoid a 400 for insufficient funds.",
    "With a test key the response is { balance, currency, sandbox: true } and never reflects your real wallet.",
  ],
}

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
]
