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
          { name: "expected_pay", type: "number", required: false, description: "The GHS amount you expect to be charged. If the current price differs, nothing is charged and you get a 409 with the current `quote`" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/airtime \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "network": "MTN", "recipient": "0541234567", "amount": 5 }'`,
        successExample: `{\n  "success": true,\n  "order": { "reference_code": "AT-XXX-YYY", "status": "pending" },\n  "new_balance": 32.5\n}`,
        errorExamples: [
          { status: 400, body: `{ "success": false, "error": "0201234567 looks like a Telecel number - check the number or switch to Telecel." }` },
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance", "required": 5.25 }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
          { status: 409, body: `{ "success": false, "error": "price_changed", "message": "Price updated — please review", "quote": { "face_amount": 10, "pay_amount": 10, "customer_cashback": 0 } }` },
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
    id: "bundles",
    label: "Standard Bundles",
    operations: [
      {
        method: "GET",
        path: "/api/v1/bundles?network=<network>",
        description: "List the Standard Bundles catalog for one network, priced for your account (pay_amount already includes any instant cashback). Returns 403 not_available while the API channel is switched off. Test keys get a static sandbox catalog (sbx_* tokens, face-value prices).",
        params: [
          { name: "network", type: "string", required: true, description: "MTN, TELECEL or AT" },
        ],
        curl: `curl -X GET "${BASE_URL}/api/v1/bundles?network=MTN" \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{\n  "success": true,\n  "network": "MTN",\n  "categories": [\n    {\n      "name": "Data",\n      "bundles": [{ "bundle_token": "tok_abc123", "display": "1GB", "face_amount": 5, "pay_amount": 4.8, "customer_cashback": 0.2 }]\n    }\n  ]\n}`,
        errorExamples: [
          { status: 400, body: `{ "success": false, "error": "network must be MTN, TELECEL or AT" }` },
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 403, body: `{ "success": false, "error": "not_available" }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded." }` },
        ],
      },
      {
        method: "POST",
        path: "/api/v1/bundles",
        description: "Buy a bundle for a phone number, paid from your wallet. Tokens come from GET /api/v1/bundles and expire, so fetch the catalog shortly before buying. idempotency_key makes retries safe: re-sending the same key returns the original order and never charges twice. Test keys (sandbox) debit a sandbox wallet at face price, simulate no cashback and complete instantly; use the sbx_* tokens from the sandbox catalog.",
        params: [
          { name: "bundle_token", type: "string", required: true, description: "bundle_token from GET /api/v1/bundles" },
          { name: "phone", type: "string", required: true, description: "10-digit beneficiary phone number" },
          { name: "idempotency_key", type: "string", required: true, description: "Your unique key for this purchase; reuse it when retrying" },
          { name: "expected_pay", type: "number", required: false, description: "The GHS amount you expect to be charged (the pay_amount you saw). If the current price differs, nothing is charged and you get a 409 price_changed with the current quote" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/bundles \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "bundle_token": "tok_abc123", "phone": "0541234567", "idempotency_key": "order-1001", "expected_pay": 4.8 }'`,
        successExample: `{\n  "success": true,\n  "order": {\n    "reference": "BND-XXX-YYY",\n    "status": "pending",\n    "payment_status": "paid",\n    "face_amount": 5,\n    "paid_amount": 4.8,\n    "cashback": 0.2,\n    "network": "MTN",\n    "bundle": "1GB",\n    "phone": "0541234567",\n    "created_at": "2026-10-14T10:00:00Z"\n  }\n}`,
        errorExamples: [
          { status: 400, body: `{ "success": false, "error": "Missing required fields: bundle_token, phone, idempotency_key" }` },
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance" }` },
          { status: 403, body: `{ "success": false, "error": "not_available" }` },
          { status: 409, body: `{ "success": false, "error": "price_changed", "message": "Price updated — please review", "quote": { "face_amount": 5, "pay_amount": 5, "customer_cashback": 0 } }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded. Your current limit is 20 requests/minute." }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/bundles/{reference}",
        description: "Check the status of one of your own bundle orders by its reference. Works for test keys against sandbox orders.",
        curl: `curl -X GET ${BASE_URL}/api/v1/bundles/BND-XXX-YYY \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "BND-XXX-YYY", "status": "completed", "payment_status": "paid", "face_amount": 5, "paid_amount": 4.8, "cashback": 0.2, "network": "MTN", "bundle": "1GB", "phone": "0541234567", "created_at": "2026-10-14T10:00:00Z" }\n}`,
        errorExamples: [
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 404, body: `{ "success": false, "error": "Order not found" }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded." }` },
        ],
      },
    ],
  },
  {
    id: "bills",
    label: "Utility Bills",
    operations: [
      {
        method: "POST",
        path: "/api/v1/bills/verify",
        description: "Look up a bill account before paying. Returns a short-lived verify_token to pass to POST /api/v1/bills. For ECG without add_meter the response lists the meters on the account, each with its own verify_token. Billers: ecg, ghana_water, dstv, gotv, startimes, telecel_broadband. Test keys return a fake \"Sandbox Customer\" with GHS 50 due and a sandbox verify_token (only valid with the same test key).",
        params: [
          { name: "biller", type: "string", required: true, description: "ecg, ghana_water, dstv, gotv, startimes or telecel_broadband" },
          { name: "account", type: "string", required: false, description: "Meter, smartcard or account number (prepaid meters and postpaid accounts both go here)" },
          { name: "phone", type: "string", required: false, description: "Phone number, where the biller needs one" },
          { name: "email", type: "string", required: false, description: "Email address, where the biller needs one" },
          { name: "broadband_account", type: "string", required: false, description: "Broadband account (telecel_broadband)" },
          { name: "meter_type", type: "string", required: false, description: "prepaid or postpaid. Informational: the number still goes in account" },
          { name: "add_meter", type: "boolean", required: false, description: "ECG: true to verify a single meter number and get one verify_token back" },
          { name: "consent", type: "boolean", required: false, description: "true where the biller requires customer consent for the lookup" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/bills/verify \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "biller": "dstv", "account": "1234567890" }'`,
        successExample: `{\n  "success": true,\n  "customer_name": "JANE DOE",\n  "amount_due": 50,\n  "suggested_amount": 50,\n  "verify_token": "vt_abc123"\n}`,
        errorExamples: [
          { status: 400, body: `{ "success": false, "error": "Unknown biller" }` },
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded." }` },
        ],
      },
      {
        method: "POST",
        path: "/api/v1/bills",
        description: "Pay a verified bill from your wallet. Use the verify_token from POST /api/v1/bills/verify. If the price changed since you looked, nothing is charged and you get a 409 price_changed with the current quote (pass expected_pay to opt in). Test keys debit a sandbox wallet at face price with no cashback; a sandbox verify_token is required.",
        params: [
          { name: "verify_token", type: "string", required: true, description: "verify_token from POST /api/v1/bills/verify" },
          { name: "amount", type: "number", required: true, description: "GHS face amount to pay" },
          { name: "expected_pay", type: "number", required: false, description: "The GHS amount you expect to be charged. If the current price differs, nothing is charged and you get a 409 price_changed" },
        ],
        curl: `curl -X POST ${BASE_URL}/api/v1/bills \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "verify_token": "vt_abc123", "amount": 50, "expected_pay": 49 }'`,
        successExample: `{\n  "success": true,\n  "order": {\n    "reference": "BILL-XXX-YYY",\n    "biller": "dstv",\n    "account": "1234567890",\n    "customer_name": "JANE DOE",\n    "status": "pending",\n    "payment_status": "paid",\n    "face_amount": 50,\n    "paid_amount": 49,\n    "cashback": 1\n  }\n}`,
        errorExamples: [
          { status: 400, body: `{ "success": false, "error": "verify_token and a numeric amount are required" }` },
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 402, body: `{ "success": false, "error": "Insufficient wallet balance" }` },
          { status: 403, body: `{ "success": false, "error": "Please verify your phone number to continue. Visit your dashboard to complete verification." }` },
          { status: 409, body: `{ "success": false, "error": "price_changed", "message": "Price updated — please review", "quote": { "face_amount": 50, "pay_amount": 50, "customer_cashback": 0 } }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded. Your current limit is 20 requests/minute." }` },
        ],
      },
      {
        method: "GET",
        path: "/api/v1/bills/{reference}",
        description: "Check the status of one of your own bill orders by its reference. Works for test keys against sandbox orders.",
        curl: `curl -X GET ${BASE_URL}/api/v1/bills/BILL-XXX-YYY \\\n  -H "X-API-Key: dg_live_your_key_here"`,
        successExample: `{\n  "success": true,\n  "order": { "reference": "BILL-XXX-YYY", "biller": "dstv", "account": "1234567890", "customer_name": "JANE DOE", "status": "completed", "payment_status": "paid", "face_amount": 50, "paid_amount": 49, "cashback": 1, "created_at": "2026-10-14T10:00:00Z" }\n}`,
        errorExamples: [
          { status: 401, body: `{ "success": false, "error": "Invalid or missing API key" }` },
          { status: 404, body: `{ "success": false, "error": "Order not found" }` },
          { status: 429, body: `{ "success": false, "error": "Rate limit exceeded." }` },
        ],
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
        description: "Buy one or more WASSCE/BECE/NOVDEC results-checker voucher PINs. The voucher is returned in this response and, if a phone/email is available, also delivered via SMS/email.",
        params: [
          { name: "exam_board", type: "string", required: true, description: "WASSCE, BECE, or NOVDEC" },
          { name: "quantity", type: "integer", required: true, description: "1-50" },
          { name: "phone_number", type: "string", required: false, description: "10-digit phone number to SMS the voucher PIN to. Defaults to your account's own registered phone number if omitted." },
          { name: "email", type: "string", required: false, description: "Email address to send the voucher PIN to. Defaults to your account's own registered email if omitted." },
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
      description: "Send an SMS to one or more recipients using your own SMS account credits. Requires a shop, sub-agent, or admin account. A send held for a quick review still returns 200, with \"status\": \"held\" and \"held\": true (it goes out once approved). send_log_id is the send's log id; a send of more than 500 recipients is split into batches of 500 and send_log_id is the FIRST batch's log. Pass scheduled_at to send later (2 minutes to 30 days ahead): credits are reserved immediately, the response has \"status\": \"scheduled\", \"scheduled\": true and scheduled_for, and the messages go out automatically at that time.",
      params: [
        { name: "message", type: "string", required: true, description: "3-1000 characters" },
        { name: "recipients", type: "string[]", required: true, description: "Up to 5000 phone numbers" },
        { name: "sender_id", type: "string", required: false, description: "One of your account's active sender IDs; defaults to your first active one" },
        { name: "scheduled_at", type: "string", required: false, description: "Send later: ISO 8601 date-time with a timezone offset or Z (e.g. 2026-10-20T09:30:00Z), 2 minutes to 30 days from now. Omit to send immediately" },
      ],
      curl: `curl -X POST ${BASE_URL}/api/v1/sms/send \\\n  -H "X-API-Key: dg_live_your_key_here" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "message": "Hello from the API", "recipients": ["0541234567"] }'`,
      successExample: `{\n  "success": true,\n  "status": "queued",\n  "held": false,\n  "scheduled": false,\n  "scheduled_for": null,\n  "send_log_id": 123,\n  "total": 1,\n  "batches": 1,\n  "segments": 1,\n  "credits_reserved": 1,\n  "partial": false,\n  "stopped_reason": null,\n  "invalid_skipped": 0\n}`,
      errorExamples: [
        { status: 402, body: `{ "success": false, "error": "INSUFFICIENT_CREDITS" }` },
        { status: 400, body: `{ "success": false, "error": "INVALID_SCHEDULE", "message": "Pick a time at least 2 minutes from now" }` },
        { status: 400, body: `{ "success": false, "error": "POLICY_REJECTED", "code": "CAP_PER_HOUR", "reason": "You've reached 20 sends this hour. Try again within the hour." }` },
        { status: 400, body: `{ "success": false, "error": "BLOCKED", "reason": "This message contains content we can't send." }` },
        { status: 429, body: `{ "success": false, "error": "SEND_IN_PROGRESS", "reason": "Another send from your account is still being processed. Please try again in a few seconds." }` },
        { status: 503, body: `{ "success": false, "error": "POLICY_REJECTED", "code": "POLICY_UNAVAILABLE", "reason": "We couldn't check this send right now. Nothing was charged — please try again in a minute." }` },
        { status: 503, body: `{ "success": false, "error": "POLICY_REJECTED", "code": "FEATURE_DISABLED", "reason": "SMS sending is temporarily unavailable. Please try again later." }` },
        { status: 503, body: `{ "success": false, "error": "SMS_DISABLED", "message": "SMS is temporarily unavailable. Please try again later." }` },
        { status: 403, body: `{ "success": false, "error": "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }` },
      ],
    }],
  },
]
