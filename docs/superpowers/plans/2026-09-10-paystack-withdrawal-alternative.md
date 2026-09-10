# Paystack as an Alternative Withdrawal Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin choose Paystack instead of Moolre when approving a shop withdrawal (single or bulk), so a Moolre outage or balance shortfall doesn't stall payouts.

**Architecture:** A new `lib/paystack-transfer.ts` module (parallel sibling to `lib/moolre-transfer.ts`, Ghana-specific: `mobile_money`/`ghipss` recipient types, pesewas amounts, OTP-gated transfers) is wired into the existing approve/bulk-approve/reset-processing/reject routes via a `provider` field, plus a new OTP-finalize route, new webhook branches, and cron polling. All existing Moolre behavior is unchanged (provider defaults to `"moolre"` everywhere).

**Tech Stack:** Next.js 15 API routes, Supabase (Postgres), Paystack Transfers API, Vitest.

## Global Constraints

- Paystack transfer OTP stays **enabled** (not disabled account-wide) — every Paystack transfer requires a follow-up `finalizeTransfer` call with an admin-entered OTP. Do not add any code path that disables or bypasses this.
- Bank-transfer-via-Paystack uses **exact, case-insensitive name matching only** against Paystack's bank list — never fuzzy-match. No match → Paystack is not offered for that withdrawal.
- No recipient caching — create a fresh Paystack recipient per withdrawal every time.
- All new DB columns are additive (`ADD COLUMN IF NOT EXISTS`) — no existing column is renamed or removed.
- Every existing call site that doesn't pass a `provider` field must keep behaving exactly as it does today (default `"moolre"`).
- Route-level handlers in this codebase (Supabase + external API calls) are not unit-tested directly — only `lib/*.ts` modules with extractable pure logic get `.test.ts` files, matching the existing convention (see `lib/digiwapy-provider.test.ts`, `lib/mtn-providers/apexprime-provider.test.ts`). Verify route changes with `npx tsc --noEmit` and manual/live checks, not new route test scaffolding.

---

### Task 1: Database migration

**Files:**
- Create: `migrations/add_paystack_transfer_fields.sql`

**Interfaces:**
- Produces: columns `payout_provider`, `paystack_recipient_code`, `paystack_transfer_code`, `paystack_fee` on `withdrawal_requests`, and the new status value `awaiting_transfer_otp` (informational only — `status` has no CHECK constraint in this table, confirmed against `migrations/0042_add_moolre_transfer_fields.sql`).

- [ ] **Step 1: Write the migration file**

```sql
-- Add Paystack transfer tracking columns to withdrawal_requests, mirroring
-- 0042_add_moolre_transfer_fields.sql. Paystack is an admin-selectable
-- alternative to Moolre, chosen per-withdrawal at approval time — these
-- columns only get populated when that withdrawal was routed through Paystack.

ALTER TABLE withdrawal_requests
  ADD COLUMN IF NOT EXISTS payout_provider          TEXT NOT NULL DEFAULT 'moolre', -- 'moolre' | 'paystack'
  ADD COLUMN IF NOT EXISTS paystack_recipient_code  TEXT,                           -- Paystack recipient_code (audit only, not reused)
  ADD COLUMN IF NOT EXISTS paystack_transfer_code   TEXT,                           -- needed by POST /transfer/finalize_transfer
  ADD COLUMN IF NOT EXISTS paystack_fee             DECIMAL(10,4);                  -- fee Paystack charged

-- New status value now in use (no CHECK constraint on this column, so this is
-- documentation only, matching how existing statuses are recorded):
--   awaiting_transfer_otp → Paystack /transfer called, status="otp", waiting on
--                           an admin to submit the code via POST
--                           /api/admin/withdrawals/submit-transfer-otp
```

- [ ] **Step 2: Apply the migration to the live Supabase database**

Use whichever Supabase access method is live in your session (the `mcp__supabase` MCP tool if connected, or the Management API SQL-execution fallback documented in this project's `reference-supabase-access` memory/notes) to run the SQL from Step 1 against the production database. Confirm afterward with:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'withdrawal_requests' AND column_name LIKE 'paystack_%' OR column_name = 'payout_provider';
```

Expected: 4 rows (`payout_provider`, `paystack_recipient_code`, `paystack_transfer_code`, `paystack_fee`).

- [ ] **Step 3: Commit**

```bash
git add migrations/add_paystack_transfer_fields.sql
git commit -m "feat(withdrawals): add Paystack transfer tracking columns"
```

---

### Task 2: `lib/paystack-transfer.ts` — Paystack Ghana transfer client

**Files:**
- Create: `lib/paystack-transfer.ts`
- Test: `lib/paystack-transfer.test.ts`

**Interfaces:**
- Consumes: `process.env.PAYSTACK_SECRET_KEY` (already set — used by the existing `lib/paystack.ts`).
- Produces (used by Tasks 3-8):
  - `mapNetworkToPaystackBankCode(network: string): string | undefined`
  - `toPesewas(amountGHS: number): number`
  - `interface PaystackBank { name: string; code: string }`
  - `matchBankByName(bankName: string, banks: PaystackBank[]): PaystackBank | undefined`
  - `fetchGhanaBankList(): Promise<PaystackBank[]>`
  - `interface CreateRecipientParams { name: string; accountNumber: string; bankCode: string; type: "mobile_money" | "ghipss" }`
  - `createRecipient(params: CreateRecipientParams): Promise<{ recipientCode: string } | null>`
  - `interface PaystackTransferResult { status: "success" | "otp" | "pending" | "failed"; transferCode: string; transactionReference: string; fee: number; errorMessage?: string }`
  - `interface InitiateTransferParams { recipientCode: string; amount: number; reference: string; reason?: string }`
  - `initiateTransfer(params: InitiateTransferParams): Promise<PaystackTransferResult | null>`
  - `finalizeTransfer(transferCode: string, otp: string): Promise<PaystackTransferResult | null>`
  - `getTransferStatus(reference: string): Promise<PaystackTransferResult | null>`
  - `interface PaystackBalance { balance: number; currency: string }`
  - `getPaystackTransferBalance(): Promise<PaystackBalance | null>`

- [ ] **Step 1: Write failing tests for the pure helpers**

```typescript
// lib/paystack-transfer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mapNetworkToPaystackBankCode, toPesewas, matchBankByName, type PaystackBank } from "@/lib/paystack-transfer"

describe("mapNetworkToPaystackBankCode", () => {
  it("maps MTN", () => expect(mapNetworkToPaystackBankCode("MTN")).toBe("MTN"))
  it("maps Telecel and Vodafone to VOD", () => {
    expect(mapNetworkToPaystackBankCode("Telecel")).toBe("VOD")
    expect(mapNetworkToPaystackBankCode("Vodafone")).toBe("VOD")
  })
  it("maps AT and AirtelTigo to ATL", () => {
    expect(mapNetworkToPaystackBankCode("AT")).toBe("ATL")
    expect(mapNetworkToPaystackBankCode("AirtelTigo")).toBe("ATL")
  })
  it("is case-insensitive", () => expect(mapNetworkToPaystackBankCode("mtn")).toBe("MTN"))
  it("returns undefined for an unknown network", () => expect(mapNetworkToPaystackBankCode("XYZ")).toBeUndefined())
})

describe("toPesewas", () => {
  it("converts GHS to pesewas", () => expect(toPesewas(50)).toBe(5000))
  it("rounds fractional pesewas", () => expect(toPesewas(10.005)).toBe(1001))
})

describe("matchBankByName", () => {
  const banks: PaystackBank[] = [
    { name: "GCB Bank", code: "GCB" },
    { name: "Ecobank Ghana", code: "ECO" },
  ]
  it("matches an exact name", () => expect(matchBankByName("GCB Bank", banks)).toEqual(banks[0]))
  it("is case-insensitive", () => expect(matchBankByName("gcb bank", banks)).toEqual(banks[0]))
  it("trims whitespace", () => expect(matchBankByName("  GCB Bank  ", banks)).toEqual(banks[0]))
  it("does not fuzzy-match a partial name", () => expect(matchBankByName("GCB", banks)).toBeUndefined())
  it("returns undefined when no bank matches", () => expect(matchBankByName("Unknown Bank", banks)).toBeUndefined())
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/paystack-transfer.test.ts`
Expected: FAIL — `lib/paystack-transfer.ts` does not exist yet.

- [ ] **Step 3: Implement the module**

```typescript
// lib/paystack-transfer.ts
/**
 * Paystack Transfer API client for Ghana payouts — an admin-selectable
 * alternative to Moolre (lib/moolre-transfer.ts), chosen per withdrawal.
 * Ghana-specific recipient types, amount units, and the OTP/finalize flow
 * were verified against Paystack's public docs (2026-09-10) rather than
 * assumed — a wrong assumption about a third-party API has broken things
 * silently before in this project (AgentPortalGH, CodeCraft).
 *
 * Deliberately does NOT reuse the existing createTransferRecipient/
 * initiateTransfer in lib/paystack.ts: those only support Nigeria's `nuban`
 * recipient type and don't convert amounts to pesewas.
 *
 * Transfer OTP is left ENABLED (a deliberate choice, not a bug) — every
 * transfer needs a finalizeTransfer() call with an admin-entered code.
 */

const PAYSTACK_BASE_URL = "https://api.paystack.co"

function getPaystackHeaders() {
  const key = process.env.PAYSTACK_SECRET_KEY
  if (!key) throw new Error("PAYSTACK_SECRET_KEY environment variable is required")
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  }
}

const NETWORK_TO_BANK_CODE: Record<string, string> = {
  MTN: "MTN",
  TELECEL: "VOD",
  VODAFONE: "VOD",
  AT: "ATL",
  AIRTELTIGO: "ATL",
}

export function mapNetworkToPaystackBankCode(network: string): string | undefined {
  return NETWORK_TO_BANK_CODE[network.toUpperCase()]
}

/** Paystack expects GHS amounts in pesewas (× 100), same convention as its charge API. */
export function toPesewas(amountGHS: number): number {
  return Math.round(amountGHS * 100)
}

export interface PaystackBank {
  name: string
  code: string
}

/**
 * Case-insensitive EXACT match only — a wrong bank match on a money transfer
 * is unacceptable, so this never fuzzy-matches. Returns undefined on no match.
 */
export function matchBankByName(bankName: string, banks: PaystackBank[]): PaystackBank | undefined {
  const normalized = bankName.trim().toLowerCase()
  return banks.find(b => b.name.trim().toLowerCase() === normalized)
}

/**
 * Fetch Ghana's bank list (used to resolve `ghipss` bank-transfer recipients).
 * Returns [] on error — callers treat that the same as "no match found".
 */
export async function fetchGhanaBankList(): Promise<PaystackBank[]> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/bank?currency=GHS`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json.status || !Array.isArray(json.data)) {
      console.error("[PAYSTACK-TRANSFER] Bank list error:", json)
      return []
    }
    return json.data.map((b: any) => ({ name: String(b.name), code: String(b.code) }))
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Bank list fetch error:", error)
    return []
  }
}

export interface CreateRecipientParams {
  name: string
  accountNumber: string   // phone (mobile money) or bank account number
  bankCode: string        // MTN/VOD/ATL, or a Paystack bank `code`
  type: "mobile_money" | "ghipss"
}

/** Creates a fresh recipient every call — no caching/reuse (see plan's Global Constraints). */
export async function createRecipient(params: CreateRecipientParams): Promise<{ recipientCode: string } | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transferrecipient`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({
        type: params.type,
        name: params.name,
        account_number: params.accountNumber,
        bank_code: params.bankCode,
        currency: "GHS",
      }),
    })
    const json = await response.json()
    if (!response.ok || !json.status || !json.data?.recipient_code) {
      console.error("[PAYSTACK-TRANSFER] Recipient creation error:", json)
      return null
    }
    return { recipientCode: String(json.data.recipient_code) }
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Recipient creation fetch error:", error)
    return null
  }
}

export interface PaystackTransferResult {
  status: "success" | "otp" | "pending" | "failed"
  transferCode: string
  transactionReference: string
  fee: number             // GHS
  errorMessage?: string
}

function parseTransferResponse(json: any, fallbackReference: string): PaystackTransferResult {
  const data = json?.data
  const rawStatus = String(data?.status ?? "")
  const status: PaystackTransferResult["status"] =
    rawStatus === "success" || rawStatus === "otp" || rawStatus === "pending" ? rawStatus : "failed"
  return {
    status,
    transferCode: String(data?.transfer_code ?? ""),
    transactionReference: String(data?.reference ?? fallbackReference),
    fee: Number(data?.fee ?? 0) / 100,
    errorMessage: status === "failed" ? String(json?.message ?? "Transfer rejected by provider") : undefined,
  }
}

export interface InitiateTransferParams {
  recipientCode: string
  amount: number           // GHS — converted to pesewas internally
  reference: string        // withdrawal UUID — our idempotency key
  reason?: string
}

/**
 * Initiate a transfer. With OTP enabled (see module doc), this comes back
 * status:"otp" — call finalizeTransfer() with the admin-entered code next.
 */
export async function initiateTransfer(params: InitiateTransferParams): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({
        source: "balance",
        amount: toPesewas(params.amount),
        recipient: params.recipientCode,
        reference: params.reference,
        reason: params.reason || `Datagod withdrawal ${params.reference.slice(0, 8)}`,
      }),
    })
    const json = await response.json()
    if (!response.ok && !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Transfer error:", json)
      return { status: "failed", transferCode: "", transactionReference: params.reference, fee: 0, errorMessage: String(json?.message ?? `HTTP ${response.status}`) }
    }
    return parseTransferResponse(json, params.reference)
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Transfer fetch error:", error)
    return null
  }
}

/** Completes a transfer that came back status:"otp", using the admin-entered code. */
export async function finalizeTransfer(transferCode: string, otp: string): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer/finalize_transfer`, {
      method: "POST",
      headers: getPaystackHeaders(),
      body: JSON.stringify({ transfer_code: transferCode, otp }),
    })
    const json = await response.json()
    if (!response.ok && !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Finalize error:", json)
      return { status: "failed", transferCode, transactionReference: "", fee: 0, errorMessage: String(json?.message ?? `HTTP ${response.status}`) }
    }
    return parseTransferResponse(json, "")
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Finalize fetch error:", error)
    return null
  }
}

/** Checks a previously-initiated transfer's current status by its reference. */
export async function getTransferStatus(reference: string): Promise<PaystackTransferResult | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/transfer/verify/${encodeURIComponent(reference)}`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json?.data) {
      console.error("[PAYSTACK-TRANSFER] Status check error:", json)
      return null
    }
    return parseTransferResponse(json, reference)
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Status check fetch error:", error)
    return null
  }
}

export interface PaystackBalance {
  balance: number   // GHS
  currency: string
}

/** Fetches the GHS balance of the Paystack account (multiple currencies possible). */
export async function getPaystackTransferBalance(): Promise<PaystackBalance | null> {
  try {
    const response = await fetch(`${PAYSTACK_BASE_URL}/balance`, {
      headers: getPaystackHeaders(),
    })
    const json = await response.json()
    if (!response.ok || !json?.status || !Array.isArray(json.data)) {
      console.error("[PAYSTACK-TRANSFER] Balance error:", json)
      return null
    }
    const ghs = json.data.find((b: any) => b.currency === "GHS")
    if (!ghs) return null
    return { balance: Number(ghs.balance) / 100, currency: "GHS" }
  } catch (error) {
    console.error("[PAYSTACK-TRANSFER] Balance fetch error:", error)
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify the pure-helper tests pass**

Run: `npx vitest run lib/paystack-transfer.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Write failing tests for the API-calling functions (fetch-mocked)**

Append to `lib/paystack-transfer.test.ts` — this mirrors the `fetchMock`/`jsonResponse` pattern already used in `lib/digiwapy-provider.test.ts`:

```typescript
import {
  fetchGhanaBankList, createRecipient, initiateTransfer, finalizeTransfer,
  getTransferStatus, getPaystackTransferBalance,
} from "@/lib/paystack-transfer"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  process.env.PAYSTACK_SECRET_KEY = "sk_test_123"
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchGhanaBankList", () => {
  it("maps the bank list response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ name: "GCB Bank", code: "GCB" }] }))
    const banks = await fetchGhanaBankList()
    expect(banks).toEqual([{ name: "GCB Bank", code: "GCB" }])
    expect(String(fetchMock.mock.calls[0][0])).toContain("/bank?currency=GHS")
  })
  it("returns [] on an error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: false, message: "error" }, 500))
    expect(await fetchGhanaBankList()).toEqual([])
  })
})

describe("createRecipient", () => {
  it("returns the recipient code on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: { recipient_code: "RCP_abc" } }))
    const result = await createRecipient({ name: "Jane Doe", accountNumber: "0241234567", bankCode: "MTN", type: "mobile_money" })
    expect(result).toEqual({ recipientCode: "RCP_abc" })
  })
  it("returns null when Paystack rejects the recipient", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: false, message: "Invalid account" }, 400))
    const result = await createRecipient({ name: "Jane Doe", accountNumber: "bad", bankCode: "MTN", type: "mobile_money" })
    expect(result).toBeNull()
  })
})

describe("initiateTransfer", () => {
  const params = { recipientCode: "RCP_abc", amount: 50, reference: "wd-123" }

  it("converts amount to pesewas in the request body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "otp", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    await initiateTransfer(params)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.amount).toBe(5000)
  })
  it("parses an OTP-required response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "otp", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    const result = await initiateTransfer(params)
    expect(result).toEqual({ status: "otp", transferCode: "TRF_1", transactionReference: "wd-123", fee: 50, errorMessage: undefined })
  })
  it("parses an immediate success response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_2", reference: "wd-123", fee: 0 } }))
    const result = await initiateTransfer(params)
    expect(result?.status).toBe("success")
  })
  it("returns a failed result on an error response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Insufficient balance" }, 400))
    const result = await initiateTransfer(params)
    expect(result).toMatchObject({ status: "failed", errorMessage: "Insufficient balance" })
  })
  it("returns null on a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"))
    expect(await initiateTransfer(params)).toBeNull()
  })
})

describe("finalizeTransfer", () => {
  it("parses a successful finalize response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_1", reference: "wd-123", fee: 5000 } }))
    const result = await finalizeTransfer("TRF_1", "123456")
    expect(result?.status).toBe("success")
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toEqual({ transfer_code: "TRF_1", otp: "123456" })
  })
  it("returns a failed result on a rejected OTP", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "Invalid OTP" }, 400))
    const result = await finalizeTransfer("TRF_1", "000000")
    expect(result).toMatchObject({ status: "failed", errorMessage: "Invalid OTP" })
  })
})

describe("getTransferStatus", () => {
  it("looks up by reference and parses the status", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success", transfer_code: "TRF_1", reference: "wd-123", fee: 0 } }))
    const result = await getTransferStatus("wd-123")
    expect(result?.status).toBe("success")
    expect(String(fetchMock.mock.calls[0][0])).toContain("/transfer/verify/wd-123")
  })
})

describe("getPaystackTransferBalance", () => {
  it("finds the GHS entry among multiple currencies", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ currency: "NGN", balance: 100000 }, { currency: "GHS", balance: 250000 }] }))
    expect(await getPaystackTransferBalance()).toEqual({ balance: 2500, currency: "GHS" })
  })
  it("returns null when there is no GHS balance", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: true, data: [{ currency: "NGN", balance: 100000 }] }))
    expect(await getPaystackTransferBalance()).toBeNull()
  })
})
```

- [ ] **Step 6: Run all tests to verify they pass**

Run: `npx vitest run lib/paystack-transfer.test.ts`
Expected: PASS (all tests, ~26 total).

- [ ] **Step 7: Run full type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add lib/paystack-transfer.ts lib/paystack-transfer.test.ts
git commit -m "feat(withdrawals): add Paystack Ghana transfer client"
```

---

### Task 3: Extend the approve route with a Paystack provider branch

**Files:**
- Modify: `app/api/admin/withdrawals/approve/route.ts`

**Interfaces:**
- Consumes: everything from Task 2 (`lib/paystack-transfer.ts`).
- Produces: the approve route now accepts `provider?: "moolre" | "paystack"` in its POST body (default `"moolre"`).

- [ ] **Step 1: Add the import and read the new field**

In `app/api/admin/withdrawals/approve/route.ts`, add the import alongside the existing Moolre one:

```typescript
import { initiateTransfer } from "@/lib/moolre-transfer"
import {
  createRecipient, initiateTransfer as initiatePaystackTransfer,
  mapNetworkToPaystackBankCode, matchBankByName, fetchGhanaBankList,
} from "@/lib/paystack-transfer"
```

Change the request-body destructure:

```typescript
const { withdrawalId, manual, provider = "moolre" } = await request.json()
```

- [ ] **Step 2: Branch the transfer-initiation section on `provider`**

Replace the existing block that starts at `// Initiate Moolre transfer — mobile money or bank (channel=2)` and calls `initiateTransfer(...)` through its three outcome branches (`txstatus === 1` / `=== 2` / else) with:

```typescript
    if (provider === "paystack") {
      const recipientName = accountDetails?.account_name || accountDetails?.name || "Datagod Merchant"
      let bankCode: string | undefined
      let recipientAccountNumber: string | undefined
      let recipientType: "mobile_money" | "ghipss" = "mobile_money"

      if (isBankTransfer) {
        const banks = await fetchGhanaBankList()
        const match = matchBankByName(String(accountDetails?.bank_name ?? ""), banks)
        if (!match) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", withdrawalId)
          return NextResponse.json(
            { error: `No matching bank found on Paystack for "${accountDetails?.bank_name}". Use Moolre or manual approval.` },
            { status: 400 }
          )
        }
        bankCode = match.code
        recipientAccountNumber = accountDetails?.account_number
        recipientType = "ghipss"
      } else {
        bankCode = mapNetworkToPaystackBankCode(String(network ?? ""))
        recipientAccountNumber = phone
        recipientType = "mobile_money"
        if (!bankCode) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", withdrawalId)
          return NextResponse.json({ error: `Unsupported network for Paystack: ${network}` }, { status: 400 })
        }
      }

      const recipient = await createRecipient({
        name: recipientName,
        accountNumber: recipientAccountNumber!,
        bankCode,
        type: recipientType,
      })
      if (!recipient) {
        await supabase
          .from("withdrawal_requests")
          .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
          .eq("id", withdrawalId)
        return NextResponse.json({ error: "Could not create Paystack transfer recipient." }, { status: 503 })
      }

      const paystackResult = await initiatePaystackTransfer({
        recipientCode: recipient.recipientCode,
        amount: Number(transferAmount),
        reference: withdrawalId,
      })

      if (!paystackResult) {
        await supabase
          .from("withdrawal_requests")
          .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
          .eq("id", withdrawalId)
        return NextResponse.json({ error: "Could not reach Paystack. Please try again." }, { status: 503 })
      }

      if (paystackResult.status === "failed") {
        await supabase
          .from("withdrawal_requests")
          .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
          .eq("id", withdrawalId)
        return NextResponse.json({ error: `Transfer rejected: ${paystackResult.errorMessage}` }, { status: 400 })
      }

      if (paystackResult.status === "success") {
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "completed",
            payout_provider: "paystack",
            paystack_recipient_code: recipient.recipientCode,
            paystack_transfer_code: paystackResult.transferCode,
            paystack_fee: paystackResult.fee,
            transfer_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawalId)
        await syncShopBalance(withdrawal.shop_id)
        await notifyShopOwner(withdrawal, withdrawalId)
        return NextResponse.json({ success: true, message: "Withdrawal approved and transferred successfully" })
      }

      // status "otp" (the expected path — OTP stays enabled) or "pending"
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "awaiting_transfer_otp",
          payout_provider: "paystack",
          paystack_recipient_code: recipient.recipientCode,
          paystack_transfer_code: paystackResult.transferCode,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      return NextResponse.json({
        success: true,
        status: "awaiting_transfer_otp",
        message: "Transfer initiated — enter the OTP sent to complete it.",
      })
    }

    // Initiate Moolre transfer — mobile money or bank (channel=2)
    const result = await initiateTransfer(
      isBankTransfer ? {
        accountNumber: accountDetails?.account_number,
        sublistid,
        network: "BANK",
        amount: Number(transferAmount),
        externalref: withdrawalId,
        reference: `Datagod withdrawal ${withdrawalId.slice(0, 8)}`,
      } : {
        phone,
        network,
        amount: Number(transferAmount),
        externalref: withdrawalId,
        reference: `Datagod withdrawal ${withdrawalId.slice(0, 8)}`,
      }
    )

    if (!result) {
      // API unreachable — revert to pending, admin can retry
      await supabase
        .from("withdrawal_requests")
        .update({
          status: "pending",
          transfer_attempted_at: null,
          moolre_external_ref: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", withdrawalId)

      return NextResponse.json(
        { error: "Could not reach payment provider. Please try again." },
        { status: 503 }
      )
    }
```

The three existing `if (result.txstatus === 1)` / `=== 2` / trailing "pending/unknown" blocks stay exactly as they are below this — they're the Moolre-only continuation of the same function and are unreachable when `provider === "paystack"` returned early above.

- [ ] **Step 3: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors. (No new automated tests for this route per Global Constraints — the branching logic itself is a thin dispatcher over Task 2's already-tested module.)

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/withdrawals/approve/route.ts
git commit -m "feat(withdrawals): wire Paystack into the single-approve route"
```

---

### Task 4: New route — submit-transfer-otp

**Files:**
- Create: `app/api/admin/withdrawals/submit-transfer-otp/route.ts`

**Interfaces:**
- Consumes: `finalizeTransfer` from Task 2.
- Produces: `POST /api/admin/withdrawals/submit-transfer-otp` — `{withdrawalId, otp}` → `{success, message}` or `{error}`.

- [ ] **Step 1: Implement the route**

```typescript
// app/api/admin/withdrawals/submit-transfer-otp/route.ts
import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { finalizeTransfer } from "@/lib/paystack-transfer"
import { notificationTemplates } from "@/lib/notification-service"
import { sendSMS } from "@/lib/sms-service"
import { sendPushToUser } from "@/lib/push-service"

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

async function syncShopBalance(shopId: string) {
  try {
    const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: shopId })
    if (!breakdown) return
    const creditedProfit = Number(breakdown.credited_p) || 0
    const totalWithdrawn = Number(breakdown.total_w) || 0
    await supabase.from("shop_available_balance").upsert({
      shop_id: shopId,
      available_balance: creditedProfit - totalWithdrawn,
      total_profit: Number(breakdown.total_p) || 0,
      withdrawn_amount: totalWithdrawn,
      credited_profit: creditedProfit,
      withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: "shop_id" })
  } catch (err) {
    console.error("[SUBMIT-TRANSFER-OTP] Balance sync error:", err)
  }
}

async function notifyShopOwner(shopId: string, amount: number, withdrawalId: string) {
  try {
    const { data: shop } = await supabase.from("user_shops").select("user_id").eq("id", shopId).single()
    if (!shop) return
    const notificationData = notificationTemplates.withdrawalApproved(amount, withdrawalId)
    await supabase.from("notifications").insert([{
      user_id: shop.user_id,
      title: notificationData.title,
      message: notificationData.message,
      type: notificationData.type,
      reference_id: notificationData.reference_id,
      action_url: "/dashboard/shop-dashboard",
      read: false,
    }])
    sendPushToUser(shop.user_id, {
      title: notificationData.title,
      body: notificationData.message,
      data: { url: "/dashboard/shop-dashboard" },
    }).catch(() => {})

    const { data: userData } = await supabase.from("users").select("phone_number").eq("id", shop.user_id).single()
    if (userData?.phone_number) {
      await sendSMS({
        phone: userData.phone_number,
        message: `✓ Your withdrawal of GHS ${amount.toFixed(2)} has been transferred.`,
        type: "withdrawal_approved",
        reference: withdrawalId,
      }).catch(() => {})
    }
  } catch (err) {
    console.warn("[SUBMIT-TRANSFER-OTP] Notification error (non-fatal):", err)
  }
}

export async function POST(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  try {
    const { withdrawalId, otp } = await request.json()
    if (!withdrawalId || typeof withdrawalId !== "string" || !otp || typeof otp !== "string") {
      return NextResponse.json({ error: "withdrawalId and otp are required" }, { status: 400 })
    }

    const { data: withdrawal, error: fetchError } = await supabase
      .from("withdrawal_requests")
      .select("id, shop_id, amount, paystack_transfer_code, status")
      .eq("id", withdrawalId)
      .maybeSingle()

    if (fetchError || !withdrawal) {
      return NextResponse.json({ error: "Withdrawal not found" }, { status: 404 })
    }
    if (withdrawal.status !== "awaiting_transfer_otp" || !withdrawal.paystack_transfer_code) {
      return NextResponse.json({ error: `Withdrawal is not awaiting an OTP (status: ${withdrawal.status})` }, { status: 400 })
    }

    const result = await finalizeTransfer(withdrawal.paystack_transfer_code, otp)

    if (!result) {
      return NextResponse.json({ error: "Could not reach Paystack. Please try again." }, { status: 503 })
    }

    if (result.status === "failed") {
      return NextResponse.json({ error: result.errorMessage || "That code was rejected. Please try again." }, { status: 400 })
    }

    // "success" or "pending" — Paystack accepted the OTP; the transfer.success
    // webhook (Task 7) is the authoritative completion signal for "pending",
    // but mark completed immediately on "success" for the same UX as Moolre.
    await supabase
      .from("withdrawal_requests")
      .update({
        status: result.status === "success" ? "completed" : "processing",
        paystack_fee: result.fee,
        transfer_completed_at: result.status === "success" ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)

    if (result.status === "success") {
      await syncShopBalance(withdrawal.shop_id)
      await notifyShopOwner(withdrawal.shop_id, Number(withdrawal.amount), withdrawalId)
    }

    return NextResponse.json({ success: true, status: result.status === "success" ? "completed" : "processing" })
  } catch (error) {
    console.error("[SUBMIT-TRANSFER-OTP] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 2: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/admin/withdrawals/submit-transfer-otp/route.ts
git commit -m "feat(withdrawals): add route to finalize a Paystack transfer OTP"
```

---

### Task 5: Bulk-approve Paystack branch + Paystack balance route

**Files:**
- Modify: `app/api/admin/withdrawals/bulk-approve/route.ts`
- Create: `app/api/admin/withdrawals/paystack-balance/route.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `bulk-approve` accepts `provider?: "moolre" | "paystack"`; new `GET /api/admin/withdrawals/paystack-balance` mirroring the existing `moolre-balance` route, for Task 9's UI balance banner.

- [ ] **Step 1: Add the Paystack balance route**

```typescript
// app/api/admin/withdrawals/paystack-balance/route.ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { getPaystackTransferBalance } from "@/lib/paystack-transfer"

export async function GET(request: NextRequest) {
  const { isAdmin, errorResponse } = await verifyAdminAccess(request)
  if (!isAdmin) return errorResponse

  const balance = await getPaystackTransferBalance()
  if (!balance) {
    return NextResponse.json(
      { error: "Could not reach Paystack to fetch balance" },
      { status: 503 }
    )
  }

  return NextResponse.json(balance)
}
```

- [ ] **Step 2: Add the import and read `provider` in bulk-approve**

In `app/api/admin/withdrawals/bulk-approve/route.ts`:

```typescript
import { initiateTransfer, getMoolreTransferBalance } from "@/lib/moolre-transfer"
import {
  createRecipient, initiateTransfer as initiatePaystackTransfer,
  mapNetworkToPaystackBankCode, matchBankByName, fetchGhanaBankList,
  getPaystackTransferBalance,
} from "@/lib/paystack-transfer"
```

```typescript
const { withdrawalIds, manual = false, provider = "moolre" } = await request.json()
```

- [ ] **Step 3: Branch the solvency check on `provider`**

Replace the existing `if (!manual) { ... getMoolreTransferBalance() ... }` block with:

```typescript
    if (!manual) {
      const totalNet = found.reduce((sum, w) => sum + Number(w.net_amount ?? w.amount), 0)
      const wallet = provider === "paystack" ? await getPaystackTransferBalance() : await getMoolreTransferBalance()
      const providerLabel = provider === "paystack" ? "Paystack" : "Moolre"

      if (!wallet) {
        return NextResponse.json(
          { error: `Could not verify ${providerLabel} wallet balance. Use manual approval or try again.` },
          { status: 503 }
        )
      }

      if (wallet.balance < totalNet) {
        return NextResponse.json({
          error: `Insufficient ${providerLabel} balance. Need GHS ${totalNet.toFixed(2)} but wallet has GHS ${wallet.balance.toFixed(2)}.`,
          walletBalance: wallet.balance,
          totalRequired: totalNet,
          shortfall: totalNet - wallet.balance,
        }, { status: 400 })
      }

      console.log(`[BULK-APPROVE] Solvency OK (${providerLabel}): wallet=GHS ${wallet.balance.toFixed(2)}, needed=GHS ${totalNet.toFixed(2)}`)
    }
```

- [ ] **Step 4: Branch the per-item transfer inside the loop**

Replace the existing block starting at `// Auto transfer via Moolre` through the three `transferResult.txstatus` branches with:

```typescript
        // Auto transfer
        const details = locked.account_details as any
        const isBankTransfer = locked.withdrawal_method === "bank_transfer"
        const transferAmount = Number(locked.net_amount ?? locked.amount)

        if (!isFinite(transferAmount) || transferAmount <= 0) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Invalid transfer amount" })
          continue
        }

        if (provider === "paystack") {
          const recipientName = details?.account_name || details?.name || "Datagod Merchant"
          let bankCode: string | undefined
          let recipientAccountNumber: string | undefined
          let recipientType: "mobile_money" | "ghipss" = "mobile_money"

          if (isBankTransfer) {
            const banks = await fetchGhanaBankList()
            const match = matchBankByName(String(details?.bank_name ?? ""), banks)
            if (!match) {
              await supabase
                .from("withdrawal_requests")
                .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
                .eq("id", locked.id)
              results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: `No matching bank found on Paystack for "${details?.bank_name}"` })
              continue
            }
            bankCode = match.code
            recipientAccountNumber = details?.account_number
            recipientType = "ghipss"
          } else {
            bankCode = mapNetworkToPaystackBankCode(String(details?.network ?? ""))
            recipientAccountNumber = details?.phone
            if (!bankCode) {
              await supabase
                .from("withdrawal_requests")
                .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
                .eq("id", locked.id)
              results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: `Unsupported network for Paystack: ${details?.network}` })
              continue
            }
          }

          const recipient = await createRecipient({ name: recipientName, accountNumber: recipientAccountNumber!, bankCode, type: recipientType })
          if (!recipient) {
            await supabase
              .from("withdrawal_requests")
              .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
              .eq("id", locked.id)
            results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Could not create Paystack recipient" })
            continue
          }

          const paystackResult = await initiatePaystackTransfer({ recipientCode: recipient.recipientCode, amount: transferAmount, reference: locked.id })

          if (!paystackResult) {
            await supabase
              .from("withdrawal_requests")
              .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
              .eq("id", locked.id)
            results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Paystack unreachable" })
            continue
          }

          if (paystackResult.status === "failed") {
            await supabase
              .from("withdrawal_requests")
              .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
              .eq("id", locked.id)
            results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: paystackResult.errorMessage || "Transfer rejected" })
            continue
          }

          if (paystackResult.status === "success") {
            await supabase
              .from("withdrawal_requests")
              .update({
                status: "completed", payout_provider: "paystack",
                paystack_recipient_code: recipient.recipientCode, paystack_transfer_code: paystackResult.transferCode,
                paystack_fee: paystackResult.fee, transfer_completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
              })
              .eq("id", locked.id)
            notifyOwner(locked.shop_id, amount, locked.id, true).catch(() => {})
            results.push({ id: locked.id, shopName, amount, success: true, status: "completed", message: `Sent — TX: ${paystackResult.transferCode}` })
            continue
          }

          // status "otp" (expected — OTP stays enabled) or "pending"
          await supabase
            .from("withdrawal_requests")
            .update({
              status: "awaiting_transfer_otp", payout_provider: "paystack",
              paystack_recipient_code: recipient.recipientCode, paystack_transfer_code: paystackResult.transferCode,
              updated_at: new Date().toISOString(),
            })
            .eq("id", locked.id)
          results.push({ id: locked.id, shopName, amount, success: true, status: "awaiting_transfer_otp", message: "Awaiting OTP — enter it on the withdrawals list" })
          continue
        }

        const transferResult = await initiateTransfer(
          isBankTransfer
            ? { accountNumber: details?.account_number, sublistid: details?.sublistid, network: "BANK", amount: transferAmount, externalref: locked.id, reference: `Datagod withdrawal ${locked.id.slice(0, 8)}` }
            : { phone: details?.phone, network: details?.network, amount: transferAmount, externalref: locked.id, reference: `Datagod withdrawal ${locked.id.slice(0, 8)}` }
        )

        if (!transferResult) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: "Payment provider unreachable" })
          continue
        }

        if (transferResult.txstatus === 1) {
          await supabase
            .from("withdrawal_requests")
            .update({ status: "completed", moolre_transfer_id: transferResult.transactionId, moolre_fee: transferResult.fee, transfer_completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          notifyOwner(locked.shop_id, amount, locked.id, true).catch(() => {})
          results.push({ id: locked.id, shopName, amount, success: true, status: "completed", message: `Sent — TX: ${transferResult.transactionId}` })

        } else if (transferResult.txstatus === 2) {
          const reason = transferResult.insufficientBalance
            ? "Insufficient Moolre balance (check wallet)"
            : transferResult.errorMessage || "Transfer rejected by provider"
          await supabase
            .from("withdrawal_requests")
            .update({ status: "pending", transfer_attempted_at: null, moolre_external_ref: null, updated_at: new Date().toISOString() })
            .eq("id", locked.id)
          notifyOwner(locked.shop_id, amount, locked.id, false).catch(() => {})
          results.push({ id: locked.id, shopName, amount, success: false, status: "pending", message: reason })

        } else {
          if (transferResult.transactionId) {
            await supabase
              .from("withdrawal_requests")
              .update({ moolre_transfer_id: transferResult.transactionId, updated_at: new Date().toISOString() })
              .eq("id", locked.id)
          }
          const msg = transferResult.txstatus === 0
            ? "Transfer pending MoMo confirmation — monitoring automatically"
            : "Transfer status unknown — monitoring automatically"
          results.push({ id: locked.id, shopName, amount, success: true, status: "processing", message: msg })
        }
```

- [ ] **Step 5: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/api/admin/withdrawals/bulk-approve/route.ts app/api/admin/withdrawals/paystack-balance/route.ts
git commit -m "feat(withdrawals): wire Paystack into bulk-approve + add balance route"
```

---

### Task 6: Extend reset-processing and reject for awaiting_transfer_otp

**Files:**
- Modify: `app/api/admin/withdrawals/reset-processing/route.ts`
- Modify: `app/api/admin/withdrawals/reject/route.ts`

**Interfaces:**
- Produces: an admin can abandon a stuck `awaiting_transfer_otp` withdrawal back to `pending` (reset) or `rejected` (reject).

- [ ] **Step 1: Widen reset-processing's accepted status**

In `app/api/admin/withdrawals/reset-processing/route.ts`, replace:

```typescript
    if (withdrawal.status !== "processing") {
      return NextResponse.json(
        { error: `Only processing withdrawals can be reset (current: ${withdrawal.status})` },
        { status: 400 }
      )
    }

    await supabase
      .from("withdrawal_requests")
      .update({
        status: "pending",
        moolre_transfer_id: null,
        moolre_external_ref: null,
        moolre_fee: null,
        transfer_attempted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)
```

with:

```typescript
    if (withdrawal.status !== "processing" && withdrawal.status !== "awaiting_transfer_otp") {
      return NextResponse.json(
        { error: `Only processing or awaiting-OTP withdrawals can be reset (current: ${withdrawal.status})` },
        { status: 400 }
      )
    }

    await supabase
      .from("withdrawal_requests")
      .update({
        status: "pending",
        moolre_transfer_id: null,
        moolre_external_ref: null,
        moolre_fee: null,
        paystack_recipient_code: null,
        paystack_transfer_code: null,
        paystack_fee: null,
        transfer_attempted_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", withdrawalId)
```

- [ ] **Step 2: Widen reject's rejectable statuses**

In `app/api/admin/withdrawals/reject/route.ts`, replace:

```typescript
    const rejectableStatuses = ["pending", "failed", "approved"]
```

with:

```typescript
    const rejectableStatuses = ["pending", "failed", "approved", "awaiting_transfer_otp"]
```

- [ ] **Step 3: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/admin/withdrawals/reset-processing/route.ts app/api/admin/withdrawals/reject/route.ts
git commit -m "feat(withdrawals): allow resetting/rejecting a stuck awaiting_transfer_otp withdrawal"
```

---

### Task 7: Paystack webhook — transfer.success / transfer.failed / transfer.reversed

**Files:**
- Modify: `app/api/webhooks/paystack/route.ts`

**Interfaces:**
- Produces: the existing webhook dispatcher (already branches on `event.event`) gains handling for the three transfer events, as a safety net alongside the synchronous `submit-transfer-otp` completion path from Task 4.

- [ ] **Step 1: Read the dispatcher's existing structure**

Before editing, run `grep -n "event.event ===" app/api/webhooks/paystack/route.ts` to find the exact `if (event.event === "charge.success") { ... } else if (event.event === "charge.failed") { ... }` structure and its closing brace, since the new branches append after the last `else if` in that same chain.

- [ ] **Step 2: Add the transfer event branches**

Add, as a new `else if` branch appended after the existing `charge.failed` handling (same dispatch chain, same signature-verification code above it that every branch already relies on):

```typescript
    } else if (
      event.event === "transfer.success" ||
      event.event === "transfer.failed" ||
      event.event === "transfer.reversed"
    ) {
      const withdrawalId = event.data?.reference
      if (!withdrawalId) {
        console.warn("[PAYSTACK-WEBHOOK] Transfer event with no reference:", event.event)
      } else {
        const { data: withdrawal } = await supabase
          .from("withdrawal_requests")
          .select("id, shop_id, amount, status")
          .eq("id", withdrawalId)
          .maybeSingle()

        if (withdrawal && withdrawal.status !== "completed") {
          if (event.event === "transfer.success") {
            await supabase
              .from("withdrawal_requests")
              .update({
                status: "completed",
                paystack_fee: Number(event.data?.fee ?? 0) / 100,
                transfer_completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", withdrawalId)

            try {
              const { data: breakdown } = await supabase.rpc("get_shop_balance_breakdown", { p_shop_id: withdrawal.shop_id })
              if (breakdown) {
                const creditedProfit = Number(breakdown.credited_p) || 0
                const totalWithdrawn = Number(breakdown.total_w) || 0
                await supabase.from("shop_available_balance").upsert({
                  shop_id: withdrawal.shop_id,
                  available_balance: creditedProfit - totalWithdrawn,
                  total_profit: Number(breakdown.total_p) || 0,
                  withdrawn_amount: totalWithdrawn,
                  credited_profit: creditedProfit,
                  withdrawn_profit: Number(breakdown.withdrawn_p) || 0,
                  updated_at: new Date().toISOString(),
                }, { onConflict: "shop_id" })
              }
            } catch (err) {
              console.error("[PAYSTACK-WEBHOOK] Balance sync error:", err)
            }
            console.log(`[PAYSTACK-WEBHOOK] Transfer completed via webhook: ${withdrawalId}`)
          } else {
            // transfer.failed or transfer.reversed — funds did not reach the recipient
            await supabase
              .from("withdrawal_requests")
              .update({
                status: "pending",
                transfer_attempted_at: null,
                moolre_external_ref: null,
                paystack_transfer_code: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", withdrawalId)
            console.warn(`[PAYSTACK-WEBHOOK] Transfer ${event.event}, reverted to pending: ${withdrawalId}`)
          }
        }
      }
```

- [ ] **Step 3: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/webhooks/paystack/route.ts
git commit -m "feat(withdrawals): handle Paystack transfer webhook events"
```

---

### Task 8: Cron — poll Paystack transfer status

**Files:**
- Modify: `app/api/cron/withdrawals-status-check/route.ts`

**Interfaces:**
- Consumes: `getTransferStatus` from Task 2.
- Produces: the cron now also reconciles `payout_provider = 'paystack'` rows.

- [ ] **Step 1: Read the cron's existing Moolre-polling loop**

Before editing, read the full file to find where it selects `processing` rows and calls `getTransferStatus` from `lib/moolre-transfer.ts`, and how it applies the result (completes/reverts) — the Paystack branch mirrors this exactly, just against a different table filter and module.

- [ ] **Step 2: Add the Paystack import and polling branch**

Add the import:

```typescript
import { getTransferStatus as getPaystackTransferStatus } from "@/lib/paystack-transfer"
```

After the existing Moolre polling loop (which selects `.eq("payout_provider", "moolre")` or, if the existing query has no such filter, add one so it doesn't also pick up Paystack rows — check the existing query first), add a parallel loop:

```typescript
  // Reconcile Paystack transfers stuck in "processing" (rare — most complete
  // synchronously via submit-transfer-otp or asynchronously via the
  // transfer.success webhook; this only catches a timing gap between the two).
  const { data: paystackProcessing } = await supabase
    .from("withdrawal_requests")
    .select("id, shop_id, amount")
    .eq("status", "processing")
    .eq("payout_provider", "paystack")

  for (const withdrawal of paystackProcessing ?? []) {
    try {
      const result = await getPaystackTransferStatus(withdrawal.id)
      if (!result) continue

      if (result.status === "success") {
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "completed",
            paystack_fee: result.fee,
            transfer_completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)
        await syncShopBalance(withdrawal.shop_id)
        await notifyCompletion(withdrawal)
        console.log(`[CRON-WITHDRAWALS] Paystack transfer completed: ${withdrawal.id}`)
      } else if (result.status === "failed") {
        await supabase
          .from("withdrawal_requests")
          .update({
            status: "pending",
            transfer_attempted_at: null,
            paystack_transfer_code: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", withdrawal.id)
        console.warn(`[CRON-WITHDRAWALS] Paystack transfer failed, reverted to pending: ${withdrawal.id}`)
      }
      // "otp" or "pending" — leave as-is, still resolving
    } catch (err) {
      console.error(`[CRON-WITHDRAWALS] Error polling Paystack transfer ${withdrawal.id}:`, err)
    }
  }
```

Use this file's own existing `syncShopBalance` and `notifyCompletion` helpers (already defined near the top of the file) — do not redefine them.

- [ ] **Step 3: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/cron/withdrawals-status-check/route.ts
git commit -m "feat(withdrawals): poll Paystack transfer status in the reconciliation cron"
```

---

### Task 9: Admin UI — Paystack approve button, OTP entry, balance banner

**Files:**
- Modify: `app/admin/withdrawals/page.tsx`

**Interfaces:**
- Produces: a third "Approve & Transfer (Paystack)" button alongside the existing Auto/Manual buttons (single + bulk), an inline OTP-entry block for `awaiting_transfer_otp` rows, and a Paystack balance line next to the existing Moolre one.

- [ ] **Step 1: Extend the WithdrawalRequest type and status helpers**

```typescript
interface WithdrawalRequest {
  id: string
  shop_id: string
  user_id: string
  amount: number
  fee_amount?: number
  net_amount?: number
  withdrawal_method: string
  account_details: any
  status: "pending" | "approved" | "rejected" | "completed" | "processing" | "failed" | "awaiting_transfer_otp"
  moolre_transfer_id?: string
  payout_provider?: string
  paystack_transfer_code?: string
  reference_code: string
  rejection_reason?: string
  created_at: string
  updated_at: string
  user_shops?: { shop_name: string; shop_slug: string }
  current_available_balance?: number
}
```

Update `getStatusIcon` and `getStatusBadgeColor` (both already switch on `status` with `if` chains) by adding one branch to each, before their final fallback:

```typescript
  const getStatusIcon = (status: string) => {
    if (status === "approved" || status === "completed") return <CheckCircle className="h-4 w-4 text-success" />
    if (status === "rejected" || status === "failed") return <XCircle className="h-4 w-4 text-destructive" />
    if (status === "processing" || status === "awaiting_transfer_otp") return <Loader2 className="h-4 w-4 text-primary animate-spin" />
    return <Clock className="h-4 w-4 text-warning" />
  }

  const getStatusBadgeColor = (status: string) => {
    if (status === "pending")    return "bg-warning/15 text-warning"
    if (status === "approved")   return "bg-success/15 text-success"
    if (status === "rejected" || status === "failed") return "bg-destructive/15 text-destructive"
    if (status === "completed")  return "bg-primary/10 text-primary"
    if (status === "processing" || status === "awaiting_transfer_otp") return "bg-primary/5 text-primary"
    return "bg-muted text-foreground"
  }
```

- [ ] **Step 2: Add Paystack balance state + loader, mirroring the existing Moolre one**

Find the existing `moolreBalance`/`loadingMoolreBalance` state declarations and `loadMoolreBalance` function; add alongside:

```typescript
  const [paystackBalance, setPaystackBalance] = useState<number | null>(null)
  const [loadingPaystackBalance, setLoadingPaystackBalance] = useState(false)
```

```typescript
  const loadPaystackBalance = async () => {
    try {
      setLoadingPaystackBalance(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/paystack-balance", { headers })
      if (!res.ok) return
      const data = await res.json()
      setPaystackBalance(typeof data.balance === "number" ? data.balance : null)
    } catch {
      // Non-fatal — banner just won't show balance
    } finally {
      setLoadingPaystackBalance(false)
    }
  }
```

Call `loadPaystackBalance()` everywhere `loadMoolreBalance()` is already called (the `filterStatus === "pending"` effect/trigger sites) so both balances refresh together.

- [ ] **Step 3: Extend `approveWithdrawal` and `bulkApprove` to accept a provider**

Replace:

```typescript
  const approveWithdrawal = async (withdrawalId: string, manual = false) => {
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId, manual }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to approve withdrawal")

      if (manual) {
        toast.success("Withdrawal manually approved — remember to transfer funds.")
      } else if (data.status === "processing") {
        toast.success("Transfer initiated — awaiting MoMo confirmation.")
      } else {
        toast.success("Withdrawal approved and transferred successfully")
      }
```

with:

```typescript
  const approveWithdrawal = async (withdrawalId: string, manual = false, provider: "moolre" | "paystack" = "moolre") => {
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId, manual, provider }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to approve withdrawal")

      if (manual) {
        toast.success("Withdrawal manually approved — remember to transfer funds.")
      } else if (data.status === "awaiting_transfer_otp") {
        toast.success("Transfer initiated — enter the OTP below to complete it.")
      } else if (data.status === "processing") {
        toast.success("Transfer initiated — awaiting MoMo confirmation.")
      } else {
        toast.success("Withdrawal approved and transferred successfully")
      }
```

Replace:

```typescript
  const bulkApprove = async (manual: boolean) => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    try {
      setBulkLoading(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/bulk-approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalIds: ids, manual }),
      })
```

with:

```typescript
  const bulkApprove = async (manual: boolean, provider: "moolre" | "paystack" = "moolre") => {
    if (selectedIds.size === 0) return
    const ids = [...selectedIds]
    try {
      setBulkLoading(true)
      const headers = await authHeaders()
      const res = await fetch("/api/admin/withdrawals/bulk-approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalIds: ids, manual, provider }),
      })
```

- [ ] **Step 4: Add a submitTransferOtp function and per-row OTP draft state**

Add near `resetProcessing`:

```typescript
  const [otpDrafts, setOtpDrafts] = useState<Record<string, string>>({})

  const submitTransferOtp = async (withdrawalId: string) => {
    const otp = (otpDrafts[withdrawalId] || "").trim()
    if (!otp) { toast.error("Enter the OTP first"); return }
    try {
      setActionLoadingId(withdrawalId)
      const headers = await authHeaders()
      const response = await fetch("/api/admin/withdrawals/submit-transfer-otp", {
        method: "POST",
        headers,
        body: JSON.stringify({ withdrawalId, otp }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to submit OTP")
      toast.success(data.status === "completed" ? "Transfer completed" : "OTP accepted — monitoring for completion")
      setOtpDrafts(prev => { const next = { ...prev }; delete next[withdrawalId]; return next })
      loadWithdrawals()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to submit OTP")
    } finally {
      setActionLoadingId(null)
    }
  }
```

- [ ] **Step 5: Add the Paystack balance line to the existing Moolre balance banner**

Find the JSX rendering `loadingMoolreBalance`/`moolreBalance` (the balance banner shown when `filterStatus === "pending"`) and add a sibling line for Paystack immediately after it, using the same conditional structure and styling already there:

```tsx
{loadingPaystackBalance ? (
  <p className="text-xs text-muted-foreground mt-1">Checking Paystack balance…</p>
) : paystackBalance !== null ? (
  <p className="text-xs text-muted-foreground mt-1">Paystack balance: GHS {paystackBalance.toFixed(2)}</p>
) : null}
```

- [ ] **Step 6: Add the bulk "Approve via Paystack" button**

Find the existing bulk buttons:

```tsx
                  onClick={() => bulkApprove(false)}
```
```tsx
                  Approve Auto ({selectedIds.size})
```

and

```tsx
                  onClick={() => bulkApprove(true)}
```
```tsx
                  Manual Approve ({selectedIds.size})
```

Add a third button between them:

```tsx
<Button
  onClick={() => bulkApprove(false, "paystack")}
  disabled={bulkLoading || selectedIds.size === 0}
  className="bg-primary hover:bg-primary/90 text-primary-foreground"
>
  {bulkLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
  Approve via Paystack ({selectedIds.size})
</Button>
```

(Match the exact `Button` props/classNames of its Moolre sibling above it — read the surrounding JSX before inserting so spacing/wrapper `div`s stay consistent.)

- [ ] **Step 7: Add the per-row "Approve via Paystack" button and the awaiting-OTP block**

In the single-item action buttons block (guarded by `withdrawal.status === "pending" || withdrawal.status === "failed"`), add a Paystack button right after the existing Moolre "Approve & Transfer (Auto)" button, inside the same eligibility condition:

```tsx
                            {(withdrawal.withdrawal_method === "mobile_money" || (withdrawal.withdrawal_method === "bank_transfer" && (withdrawal.account_details as any)?.sublistid)) && (
                              <Button
                                onClick={() => approveWithdrawal(withdrawal.id, false, "paystack")}
                                disabled={actionLoadingId === withdrawal.id}
                                variant="outline"
                                className="w-full text-sm border-primary text-primary hover:bg-primary/5"
                              >
                                {actionLoadingId === withdrawal.id
                                  ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Processing...</>
                                  : withdrawal.status === "failed" ? "↺ Retry via Paystack" : "Approve via Paystack"}
                              </Button>
                            )}
```

Add a new block for `awaiting_transfer_otp`, alongside the existing `withdrawal.status === "processing"` notice block:

```tsx
                        {withdrawal.status === "awaiting_transfer_otp" && (
                          <div className="mb-3 bg-primary/5 p-3 rounded border border-primary/20 space-y-2">
                            <p className="text-xs text-primary">Enter the OTP Paystack sent to complete this transfer.</p>
                            <div className="flex gap-2">
                              <Input
                                value={otpDrafts[withdrawal.id] || ""}
                                onChange={(e) => setOtpDrafts(prev => ({ ...prev, [withdrawal.id]: e.target.value }))}
                                placeholder="Enter OTP"
                                className="text-sm"
                                disabled={actionLoadingId === withdrawal.id}
                              />
                              <Button
                                size="sm"
                                onClick={() => submitTransferOtp(withdrawal.id)}
                                disabled={actionLoadingId === withdrawal.id || !(otpDrafts[withdrawal.id] || "").trim()}
                                className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
                              >
                                {actionLoadingId === withdrawal.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Submit"}
                              </Button>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={actionLoadingId === withdrawal.id}
                              onClick={() => resetProcessing(withdrawal.id)}
                              className="w-full text-xs border-border text-warning hover:bg-warning/10"
                            >
                              ↺ Abandon & reset to pending
                            </Button>
                          </div>
                        )}
```

- [ ] **Step 8: Verify with the type-checker**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Manual verification in the browser**

Start the dev server (`npm run dev`) and, on `/admin/withdrawals` with `filterStatus="pending"`:
- Confirm the Paystack balance line appears next to the Moolre one.
- Confirm a pending mobile-money withdrawal shows all three buttons (Moolre auto, Paystack, Manual) plus Reject.
- Approve one via Paystack (test/sandbox credentials) and confirm the row switches to the `awaiting_transfer_otp` block with an OTP input.
- Confirm "Abandon & reset to pending" returns it to `pending` with the three buttons again.

- [ ] **Step 10: Commit**

```bash
git add app/admin/withdrawals/page.tsx
git commit -m "feat(withdrawals): add Paystack approve buttons, OTP entry, and balance banner to admin UI"
```

---

## Self-Review Notes

- **Spec coverage:** every section of `2026-09-10-paystack-withdrawal-alternative-design.md` maps to a task — DB schema (Task 1), the transfer client + verified API shapes (Task 2), approve (Task 3), OTP finalize (Task 4), bulk-approve + balance route (Task 5), reset-processing/reject (Task 6), webhook (Task 7), cron (Task 8), admin UI (Task 9).
- **Bank-matching safety rule** (exact match only, block Paystack on no match) is implemented identically in both Task 3 (single) and Task 5 (bulk) — verified the two blocks use the same `matchBankByName` call and the same "no match → revert/skip with reason" behavior.
- **OTP-stays-enabled decision** is reflected in Task 2's `initiateTransfer` (always expects to branch on `"otp"`), Task 3/5's handling of that status, and Task 4's dedicated finalize route — no code path anywhere disables Paystack's transfer OTP.
- Type names are consistent across tasks: `PaystackTransferResult`, `PaystackBank`, `CreateRecipientParams` (Task 2) are imported with those exact names in Tasks 3, 4, and 5 — no renaming drift.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-10-paystack-withdrawal-alternative.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
