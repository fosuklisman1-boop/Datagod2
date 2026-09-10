# Paystack as an Alternative Withdrawal Provider — Design

## Goal

Give admins a second, manually-selectable payout rail alongside Moolre when approving shop withdrawal requests, so a Moolre outage or balance shortfall doesn't stall payouts. Paystack is chosen per-withdrawal (and per-batch in bulk-approve) — it is not a default or automatic failover.

## Background: current state

`withdrawal_requests` flows through `pending → processing → completed` (or back to `pending` on failure), driven entirely by `lib/moolre-transfer.ts`. The admin approves at `/admin/withdrawals` (single) or via `bulk-approve` (batch); a `manual` flag lets an admin mark a withdrawal `approved` without any automated transfer, for cases Moolre can't handle (legacy bank records with no `sublistid`, missing phone/network). A cron (`withdrawals-status-check`) polls Moolre for `processing` rows whose transfer came back pending/unknown at approval time.

`lib/paystack.ts` already contains an unused, incomplete transfer scaffold (`createTransferRecipient`, `initiateTransfer`) — it only supports Nigeria's `nuban` recipient type, doesn't convert amounts to pesewas, and has no idempotency reference. It is not reused as-is; the new Ghana-specific implementation lives in its own module (see below).

## Verified Paystack Ghana API shapes

Confirmed against Paystack's public docs (not assumed) since a prior incident (AgentPortalGH, CodeCraft) showed inferred third-party field names silently breaking things for months:

- **Recipient creation** — `POST /transferrecipient`: `{type, name, account_number, bank_code, currency: "GHS"}`.
  - Mobile money: `type: "mobile_money"`, `bank_code` one of `MTN` / `VOD` / `ATL`, `account_number` = the phone number.
  - Bank: `type: "ghipss"` (Ghana-specific — **not** `nuban`, which is Nigeria-only), `bank_code` from Paystack's own bank list, `account_number` = the bank account number.
  - Response includes `recipient_code`, used by the transfer call.
- **Bank list** — `GET /bank?currency=GHS` returns Ghana banks (and the MTN/VOD/ATL mobile-money entries) with their own `code` values — these do **not** match Moolre's `sublistid` scheme.
- **Amount unit** — pesewas (× 100), same convention as Paystack's charge API elsewhere in this codebase.
- **Transfer initiation** — `POST /transfer`: `{source: "balance", amount, recipient: recipient_code, reason, reference}`. `reference` is our idempotency key — set to the withdrawal's own UUID, mirroring Moolre's `externalref` convention.
- **OTP** — Paystack requires an OTP to complete every transfer unless OTP-for-transfers is disabled account-wide. This project keeps OTP **enabled** (explicit choice, trades automation speed for the 2FA safety net). `POST /transfer` returns `data.status === "otp"` and `data.transfer_code` when OTP is required — which, with OTP left on, is every time.
- **Finalize** — `POST /transfer/finalize_transfer`: `{transfer_code, otp}`. The OTP is sent by Paystack to the business's own registered phone/email (i.e., to whoever operates the Datagod Paystack account) — not to the shop owner.
- **Balance** — `GET /balance` returns `{data: [{currency, balance}]}` (array, one entry per currency the account holds) — find the `"GHS"` entry.
- **Webhooks** — `transfer.success`, `transfer.failed`, `transfer.reversed`, delivered to the same registered webhook URL as charge events, each carrying `data.reference` (= our withdrawal UUID) and `data.transfer_code`.

## Architecture

A new module, `lib/paystack-transfer.ts`, shaped like `lib/moolre-transfer.ts` (parallel sibling, not a shared interface — matches this codebase's existing pattern for provider modules, e.g. the MTN fulfillment providers):

```typescript
export interface PaystackBank { name: string; code: string; type: "ghipss" | "mobile_money" }
export async function fetchGhanaBankList(): Promise<PaystackBank[]>

export interface PaystackTransferResult {
  status: "success" | "otp" | "pending" | "failed"
  transferCode: string
  transactionReference: string   // = our externalref, echoed back
  fee: number
  errorMessage?: string
}
export async function createRecipient(params: {
  name: string
  accountNumber: string          // phone (mobile money) or bank account number
  bankCode: string                // MTN/VOD/ATL, or a Paystack bank code
  type: "mobile_money" | "ghipss"
}): Promise<{ recipientCode: string } | null>

export async function initiateTransfer(params: {
  recipientCode: string
  amount: number                  // GHS, converted to pesewas internally
  reference: string               // withdrawal UUID
  reason?: string
}): Promise<PaystackTransferResult | null>

export async function finalizeTransfer(transferCode: string, otp: string): Promise<PaystackTransferResult | null>
export async function getTransferStatus(reference: string): Promise<PaystackTransferResult | null>

export interface PaystackBalance { balance: number; currency: string }
export async function getPaystackTransferBalance(): Promise<PaystackBalance | null>
```

No recipient caching — a fresh recipient is created per withdrawal. Simpler than caching, and avoids serving a stale recipient if a shop owner changes their MoMo number or bank between withdrawals; Paystack does not charge for or meaningfully limit recipient creation.

## Bank-transfer safety rule

`account_details.bank_name` (already collected and stored at withdrawal-request time via Moolre's bank list) is matched **case-insensitively, exact-string only** against Paystack's `GET /bank?currency=GHS` list to resolve the `bank_code`. No fuzzy matching — a wrong bank match on a money transfer is unacceptable. If no exact match is found, Paystack is not offered as an option for that withdrawal (the admin UI disables it with a reason shown); Moolre or manual remain available.

## DB schema changes

New columns on `withdrawal_requests` (migration, additive only — no existing column renamed or removed):

| Column | Type | Purpose |
|---|---|---|
| `payout_provider` | text, default `'moolre'` | Which rail handled this withdrawal |
| `paystack_recipient_code` | text, nullable | For debugging/audit |
| `paystack_transfer_code` | text, nullable | Needed by `finalize_transfer` |
| `paystack_fee` | numeric, nullable | Mirrors `moolre_fee` |

New status value: `awaiting_transfer_otp` (alongside existing `pending`/`processing`/`completed`/`approved`/`rejected`/`failed`).

## Approve route (`/api/admin/withdrawals/approve`) changes

Accepts a new `provider: "moolre" | "paystack"` field (default `"moolre"` — every existing call site keeps working unchanged). All the existing lock/cooling-off/overdraft-guard logic runs first and is untouched; it doesn't know or care which provider is used. The provider branch only replaces the "which transfer API do we call" section:

- **Bank withdrawal + Paystack**: resolve `bank_code` via the exact-match rule above; if no match, respond 400 with a clear "bank not found on Paystack" error (mirrors the existing legacy-bank fallback pattern) rather than silently switching providers.
- **Mobile money + Paystack**: `bank_code` is a direct network lookup (MTN/VOD/ATL), no ambiguity.
- Create the recipient, then call `initiateTransfer`. On `status === "otp"`: set `status = "awaiting_transfer_otp"`, store `paystack_transfer_code`, respond `{success: true, status: "awaiting_transfer_otp", transferCode}`. On `"success"` (in case OTP is ever disabled later): behaves like Moolre's `txstatus===1` (complete immediately, sync balance, notify). On `"failed"` or a null/unreachable result: revert to `pending`, same as Moolre's failure path.

## New route: submit-transfer-otp

`POST /api/admin/withdrawals/submit-transfer-otp` — `{withdrawalId, otp}`. Looks up the withdrawal's `paystack_transfer_code`, calls `finalizeTransfer(transferCode, otp)`. On success: `status = "completed"`, sync shop balance, notify shop owner (identical notification path to the existing immediate-success case). On failure (wrong/expired code): return the error; the withdrawal stays `awaiting_transfer_otp` so the admin can retry with a fresh code, or use `reset-processing` (see below) to abandon it back to `pending`.

## Bulk-approve changes

Accepts the same `provider` field for the whole batch. With `provider: "paystack"`: loop initiates every selected withdrawal's transfer exactly like the single-approve path (each ends up `awaiting_transfer_otp` with its own `transfer_code`), returning a `BulkResult` per item same as today. An item that fails the bank-name exact-match rule (or is missing phone/network) is reported as a failed `BulkResult` entry with that reason and left `pending` — it does not block or fail the rest of the batch. No separate "queue" UI — the existing `/admin/withdrawals` list, which already shows status, gets an inline "Enter OTP" action on any row in `awaiting_transfer_otp`, and the admin works through them one at a time via `submit-transfer-otp`. The batch-level Moolre balance pre-check is mirrored with `getPaystackTransferBalance()` when the batch provider is Paystack.

## Webhook (`/api/webhooks/paystack/route.ts`) changes

Two new branches alongside the existing `charge.success`/`charge.failed` handling, dispatched the same way (`event.event === "transfer.success"` / `"transfer.failed"` / `"transfer.reversed"`). Each looks up `withdrawal_requests` by `id = event.data.reference` (our own UUID, echoed back by Paystack) and updates status/`transfer_completed_at`/balance sync — this is the safety net for the rare case where `initiateTransfer`'s synchronous response doesn't reflect final status (e.g., "success" comes back later than the API call, or a transfer is reversed after appearing to succeed).

## Cron (`withdrawals-status-check`) changes

Currently polls Moolre only. Extended to also select `processing` **and** `awaiting_transfer_otp` rows where `payout_provider = 'paystack'` and poll `getTransferStatus(reference)` — this catches transfers that completed via webhook timing gaps, but does **not** auto-complete an `awaiting_transfer_otp` row (only a submitted OTP can do that); the cron only reconciles rows that somehow reached a terminal Paystack status without our webhook/OTP-submit path already having caught it.

## Existing route extensions

- **`reset-processing`**: currently only resets `status === "processing"`. Extended to also accept `"awaiting_transfer_otp"` (an admin who can't get the OTP, or wants to switch provider, can abandon the Paystack attempt back to `pending`) — clears `paystack_recipient_code`/`paystack_transfer_code`/`paystack_fee` alongside the existing Moolre-field clears.
- **`reject`**: `rejectableStatuses` gains `"awaiting_transfer_otp"` for the same reason.

## Admin UI changes (`/admin/withdrawals`)

- The existing "manual" checkbox is folded into a single "Payout method" selector per withdrawal: **Moolre / Paystack / Manual** (three mutually exclusive choices, replacing the checkbox + implicit-Moolre-otherwise pattern). Same selector shape appears in bulk-approve for the whole batch.
- Paystack is visually disabled (with a tooltip reason) when: a bank withdrawal has no exact bank-name match, or a mobile-money withdrawal is missing phone/network (same guard as Moolre's existing fallback case).
- Rows in `awaiting_transfer_otp` show an inline "Enter OTP" action (small input + submit, matching the pattern just built for customer-facing MoMo OTP entry) instead of the normal Approve/Reject actions.

## Explicitly out of scope

- No automatic failover between providers — this is manual, admin-driven selection only (per the confirmed decision).
- No recipient caching/reuse across withdrawals.
- No change to how shop owners submit withdrawal requests or which account details they provide — Paystack routing is decided entirely at approval time from data already collected.
- Disabling Paystack's transfer OTP account-wide is explicitly rejected — OTP stays on.
