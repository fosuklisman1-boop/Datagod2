// lib/api-docs-registry.ts

export interface ApiParam {
  name: string
  type: string
  required: boolean
  description: string
}

export interface ApiOperation {
  method: "GET" | "POST"
  path: string
  description: string
  params?: ApiParam[]
  curl: string
  successExample: string
  errorExamples: { status: number; body: string }[]
}

export interface ApiDocSection {
  id: string
  label: string
  operations: ApiOperation[]
}

export const BASE_URL = "https://www.datagod.store"

export const apiDocsRegistry: ApiDocSection[] = [
  {
    id: "balance",
    label: "Balance",
    operations: [{
      method: "GET",
      path: "/api/v1/balance",
      description: "Returns the authenticated key owner's wallet balance.",
      curl: `curl -X GET ${BASE_URL}/api/v1/balance \\\n  -H "X-API-Key: dg_live_your_key_here"`,
      successExample: `{\n  "success": true,\n  "balance": 45.00,\n  "total_credited": 165.50,\n  "total_spent": 120.50,\n  "currency": "GHS",\n  "user": { "name": "John", "role": "dealer" }\n}`,
      errorExamples: [{ status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` }],
    }],
  },
  {
    id: "products",
    label: "Products",
    operations: [{
      method: "GET",
      path: "/api/v1/products",
      description: "Read-only catalog of data bundles, airtime, results-checker vouchers, and AFA registration, with your role's current pricing.",
      curl: `curl -X GET ${BASE_URL}/api/v1/products \\\n  -H "X-API-Key: dg_live_your_key_here"`,
      successExample: `{\n  "success": true,\n  "data_bundles": [{ "network": "MTN", "size_gb": "1", "price": 6.5 }],\n  "airtime": [{ "network": "MTN", "min_amount": 1, "max_amount": 500, "fee_rate_percent": 5 }],\n  "results_checker": [{ "exam_board": "WASSCE", "unit_price": 15 }],\n  "afa": { "enabled": true, "price": 50 }\n}`,
      errorExamples: [{ status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` }],
    }],
  },
  {
    id: "orders",
    label: "Data Orders",
    operations: [
      {
        method: "POST",
        path: "/api/v1/orders",
        description: "Place a data bundle order for a recipient number.",
        params: [
          { name: "network", type: "string", required: true, description: "e.g. MTN, Telecel, AT - iShare" },
          { name: "volume_gb", type: "integer", required: true, description: "Bundle size in GB" },
          { name: "recipient", type: "string", required: true, description: "Recipient phone number" },
          { name: "reference", type: "string", required: true, description: "Your own unique idempotency reference (3-100 chars)" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/orders \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "network": "MTN",\n    "volume_gb": 5,\n    "recipient": "0541234567",\n    "reference": "your_unique_txn_id"\n  }'`,
        successExample: `{\n  "success": true,\n  "order": { "id": "...", "reference": "your_unique_txn_id", "network": "MTN", "volume_gb": 5, "status": "pending" }\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient balance", "required": 12.5 }` },
          { status: 409, body: `{ "success": false, "error": "Duplicate reference" }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/orders?reference=<ref>",
        description: "Check the status of a previously placed data order by your own reference.",
        curl: `curl -X GET "${BASE_URL}/api/v1/orders?reference=your_unique_txn_id" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "your_unique_txn_id", "status": "completed" }\n}`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "airtime",
    label: "Airtime",
    operations: [
      {
        method: "POST",
        path: "/api/v1/airtime",
        description: "Top up airtime for a recipient number.",
        params: [
          { name: "network", type: "string", required: true, description: "MTN, AirtelTigo, or Telecel" },
          { name: "recipient", type: "string", required: true, description: "10-digit recipient phone number" },
          { name: "amount", type: "number", required: true, description: "GHS amount (subject to the admin-configured min/max — check GET /api/v1/products for current limits)" },
          { name: "pay_separately", type: "boolean", required: false, description: "If true, the fee is added on top instead of deducted from amount" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/airtime \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "network": "MTN", "recipient": "0541234567", "amount": 5 }'`,
        successExample: `{\n  "success": true,\n  "order": { "reference_code": "AT-XXX-YYY", "status": "pending" },\n  "new_balance": 32.5\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance", "required": 5.25 }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/airtime?reference=<ref>",
        description: "Check the status of an airtime order by its reference_code.",
        curl: `curl -X GET "${BASE_URL}/api/v1/airtime?reference=AT-XXX-YYY" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "AT-XXX-YYY", "status": "processing" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "afa",
    label: "AFA",
    operations: [
      {
        method: "POST",
        path: "/api/v1/afa",
        description: "Submit an AFA (government scheme) registration order.",
        params: [
          { name: "full_name", type: "string", required: true, description: "Registrant's full name" },
          { name: "phone_number", type: "string", required: true, description: "Registrant's phone number" },
          { name: "gh_card_number", type: "string", required: true, description: "Ghana Card number" },
          { name: "location", type: "string", required: true, description: "Registrant's location" },
          { name: "region", type: "string", required: true, description: "Registrant's region" },
          { name: "occupation", type: "string", required: false, description: "Defaults to Farmer if omitted" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/afa \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "full_name": "Jane Doe",\n    "phone_number": "0541234567",\n    "gh_card_number": "GHA-123456789-0",\n    "location": "Accra",\n    "region": "Greater Accra"\n  }'`,
        successExample: `{ "success": true, "order": { "reference": "AFA-1234567", "status": "pending" } }`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient balance", "required": 50 }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/afa?reference=<ref>",
        description: "Check the status of an AFA order by its reference (order_code).",
        curl: `curl -X GET "${BASE_URL}/api/v1/afa?reference=AFA-1234567" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "AFA-1234567", "status": "completed", "fulfillment_status": "fulfilled" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "results-checker",
    label: "Results Checker",
    operations: [
      {
        method: "POST",
        path: "/api/v1/results-checker",
        description: "Buy one or more WASSCE/BECE/NOVDEC results-checker voucher PINs.",
        params: [
          { name: "exam_board", type: "string", required: true, description: "WASSCE, BECE, or NOVDEC" },
          { name: "quantity", type: "integer", required: true, description: "1-50" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/results-checker \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "exam_board": "WASSCE", "quantity": 1 }'`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "RC-XXX-YYY", "status": "completed" },\n  "vouchers": [{ "pin": "1234-5678-90", "serial_number": "WA0001234" }],\n  "new_balance": 30\n}`,
        errorExamples: [
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance", "required": 15 }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
          { status: 503, body: `{ "success": false, "error": "WASSCE vouchers are currently unavailable" }` },
          { status: 503, body: `{ "success": false, "error": "Insufficient voucher inventory" }` },
          { status: 409, body: `{ "success": false, "error": "Duplicate request detected. Please wait before trying again.", "reference": "RC-XXX-YYY" }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/results-checker?reference=<ref>",
        description: "Look up a previously purchased voucher order (does not re-return the PIN).",
        curl: `curl -X GET "${BASE_URL}/api/v1/results-checker?reference=RC-XXX-YYY" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{ "success": true, "order": { "reference": "RC-XXX-YYY", "exam_board": "WASSCE", "quantity": 1, "status": "completed" } }`,
        errorExamples: [{ status: 404, body: `{ "success": false, "error": "Order not found" }` }],
      },
    ],
  },
  {
    id: "sms",
    label: "SMS",
    operations: [{
      method: "POST",
      path: "/api/v1/sms/send",
      description: "Send an SMS to one or more recipients using your own SMS account credits. Requires a shop, sub-agent, or admin account.",
      params: [
        { name: "message", type: "string", required: true, description: "3-1000 characters" },
        { name: "recipients", type: "string[]", required: true, description: "Up to 5000 phone numbers" },
        { name: "sender_id", type: "string", required: false, description: "One of your account's active sender IDs; defaults to your first active one" },
      ],
      curl: `curl -X POST ${BASE_URL}/api/v1/sms/send \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "message": "Hello from the API", "recipients": ["0541234567"] }'`,
      successExample: `{\n  "success": true,\n  "total": 1,\n  "batches": 1,\n  "segments": 1,\n  "credits_reserved": 1,\n  "partial": false,\n  "stopped_reason": null,\n  "invalid_skipped": 0\n}`,
      errorExamples: [
        { status: 402, body: `{ "success": false, "error": "INSUFFICIENT_CREDITS" }` },
        { status: 403, body: `{ "success": false, "error": "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }` },
      ],
    }],
  },
]
