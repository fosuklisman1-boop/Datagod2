# Hubtel Commission Services — Phase 3a design (Utility Bills on the dashboard + Telecel Broadband)

Date: 2026-10-13 · Status: draft for review · Builds on Phase 1 (live; first real Hubtel delivery 2026-10-13 17:34) and
Phase 2a (live on main `0209cbbb`, migrations 0115/0116 applied).
API source of truth: `docs/hubtel-commission-services/hubtel-docs-full-2026-10-12.md`.
UI references (follow these): `docs/hubtel-commission-services/ref/customer-utility-bills-home.png`,
`customer-utility-bills-verify-sheet.png`, `admin-utility-bills-orders.png`, `admin-utility-bills-settings.png`.

## 1. Purpose

Let logged-in customers pay ECG, Ghana Water, DSTV, GOtv, StarTimes and Telecel Broadband from their Datagod wallet,
earning Hubtel's commission. Bills are **zero markup**: the customer pays exactly the bill amount; Datagod's income is the
commission Hubtel returns.

Success: a customer verifies an account, pays from the wallet, and sees the payment move to Completed (or Failed → under
review) in Recent payments with an in-app/push notification; an admin sees every bill order, its commission and status on
`/admin/utility-bills`, can switch billers on/off, set limits, and refund failed payments manually — with no path that
charges twice, sends twice, or refunds automatically.

## 2. Decisions (user, 2026-10-13)

| Topic | Decision |
|---|---|
| Phase 3 split | **3a** = dashboard bills + Telecel Broadband + admin page (this spec). **3b** = storefront bills, 30% partner split, Commission Wallets, Hubtel Direct Pay rail. USSD/WhatsApp = Phase 4. |
| Pricing | Zero markup; customer pays the bill amount. |
| ECG flow | Phone first → pick a linked meter (from Hubtel's lookup) or "Add another meter"; adding a new meter requires a tick: "This links meter X to phone Y with ECG". |
| Limits | Admin-set **per-biller** min/max (defaults GHS 5–10,000). Note: the admin reference shows one global pair; the user chose per-biller. |
| Notifications | In-app + push on delivered/failed; no SMS. |
| Telecel Broadband | Own sidebar link and page. |
| Refunds | Manual only (admin), never automatic. Never resent automatically. |
| Logos | Fetched from official / Wikimedia sources into `public/billers/` during the build (user may replace). |

## 3. Billers (engine definitions)

One shared engine; each biller is a definition in `lib/bills/billers.ts`:

| Biller key | Hubtel service | Customer inputs | Lookup | POST |
|---|---|---|---|---|
| `ecg` | `bill_ecg` | phone; then pick meter or type meter/account no. | `?destination=<phone 233…>` → list of `{Display:"NAME (meter)", Value:" meter", Amount: outstanding}` (leading spaces, Amount may be negative) | Destination = phone (233…), `Extradata.bundle` = meter/account no. (trimmed) |
| `ghana_water` | `bill_ghana_water` | meter no., phone, email | `?destination=<meter>&mobile=<phone 233…>` → `name`, `amountDue`, `sessionId` (unique per query) | Destination = phone, `Extradata` = `{bundle: meter, Email, SessionId}` |
| `dstv` | `bill_dstv` | smartcard no. | `?destination=<smartcard>` → `name`, `amountDue`, `account` | Destination = smartcard, no Extradata |
| `gotv` | `bill_gotv` | smartcard no. | same as DSTV (`amountDue` may be negative = credit) | same as DSTV |
| `startimes` | `bill_startimes` | account no. | `?destination=<acct>` → `Name`, `Account Number`, `Bouquet` (different key casing!) | Destination = account no. |
| `telecel_broadband` | `bill_telecel_broadband` | landline (e.g. 0302450262) + broadband account no. (e.g. P0444101) | `?destination=<landline>` → `name`, `amountDue`, `account` | Destination = landline, `Extradata.bundle` = broadband account no. |

Lookup parsing is case-insensitive on `Display` keys and trims values. A negative `amountDue` means credit → suggested
amount 0 (customer must enter an amount within limits). Telecel Postpaid Bills has no docs and stays out of scope.

## 4. Data model (migration = next free number at plan time, e.g. 0117; additive, service-role only like 0113)

`hubtel_bill_orders`:
`id uuid pk, reference_code text unique, user_id uuid not null, channel text check ('dashboard') default 'dashboard'`
(3b adds 'storefront'), `biller text check in (the 6 keys), account_number text not null, phone text (233 form, null for TV),
email text null, customer_name text null, verified boolean not null default true` (false = ECG meter typed manually),
`amount numeric(12,2) not null check (amount > 0), status text check ('pending','processing','completed','failed','refunded')
default 'pending', payment_status text check ('unpaid','paid','refunded') default 'unpaid', hubtel_client_reference text unique,
commission numeric(12,6) null, failure_reason text null, notes text null, created_at, updated_at`.
Indexes: `(user_id, created_at desc)`, `(status, created_at)`, `(biller, created_at)`.

Settings: `admin_settings` key `utility_bills_config` = `{ enabled: false, autoFulfil: true, billers: { <key>: { enabled: false,
min: 5, max: 10000 } } }` — read via a pure `resolveBillsConfig` (safe defaults, everything off), written atomically with a
`utility_bills_config_patch(jsonb)` RPC (same pattern as 0115). `billers` merged per biller key.

## 5. Customer flow — `/dashboard/bills` (matches `customer-utility-bills-home.png`)

- Header "Utility bills", wallet balance card, "PAY A BILL" grid of enabled billers (logo, name, input hint), "RECENT
  PAYMENTS" with filters (biller, status, source, date range) and live statuses; empty state as in the reference.
- Tapping a biller opens the verify sheet (matches `customer-utility-bills-verify-sheet.png`): biller logo + name +
  "Pay with your wallet · GHS min–max", the biller's inputs, **Verify account →**.
- **Verify** = `POST /api/bills/verify { biller, inputs }`: validates inputs (phones via `isValidGhanaMobile` → 233 form;
  email format for Ghana Water), calls Phase 1 `client.query(service, destination, extra)`, parses, and returns
  `{ customerName, amountDue, options? (ECG meters), token }`. `token` = HMAC-signed `(userId, biller, accountNumber, phone,
  email, sessionId, verified, issuedAt)`, valid 10 minutes, using an existing server secret.
  - ECG: returns the linked meters as options; "Add another meter" lets the customer type a meter/account number → a token
    with `verified: false` is issued without a name, only after the customer ticks the link-consent box.
- Confirm step shows name, account, amount due (suggested, editable), limits, wallet balance → **Pay**.
- **Pay** = `POST /api/bills/pay { token, amount }` (auth): in this order —
  1. verify token (signature, age, same user); biller enabled, master enabled, Hubtel config enabled & not paused;
     amount 2-dp within the biller's min/max;
  2. insert `hubtel_bill_orders` (status pending, payment_status unpaid);
  3. debit wallet with `deduct_wallet` (insufficient ⇒ order `failed`, payment `unpaid`, nothing sent);
     set `payment_status: paid`;
  4. if `autoFulfil` on: `hubtelCs.purchase({ serviceKey, destination, amount, bundle, extra, orderTable:
     "hubtel_bill_orders", orderId })` → order `processing` (+ `hubtel_client_reference`); if off: order stays `pending` paid
     for an admin to dispatch from the admin page.
  Errors raised before the POST (Hubtel disabled/paused/validation) ⇒ order stays `pending` + paid, admin alerted (review
  on the admin page); `HubtelOutcomeUnknownError` ⇒ `processing`, review queue. Never resent, never auto-refunded.
- Ghana Water's `sessionId` always comes from the token (fresh lookup ≤10 min); a stale token ⇒ "verify again".
- Notifications: adapter hooks write an in-app notification and send a push (existing notifications table + push helper)
  for completed / failed ("under review; a refund follows if nothing was delivered").

## 6. Telecel Broadband — `/dashboard/broadband`

Same engine and components, single biller `telecel_broadband` (landline + broadband account no.). Own sidebar link.

## 7. Order adapter `hubtel_bill_orders`

Registered statically in `lib/hubtel-cs/runtime.ts` (like `airtime_orders`).
- `onFulfilled`: from `pending|processing` → `completed`, store commission; notify customer. Idempotent.
- `onFailed`: from `pending|processing` → `failed` + reason; notify customer; admin sees it in the Refund Queue. Idempotent.
- `refundToWallet(tx, adminId)`: only for `failed` + `paid` orders; `credit_wallet_safely` with `p_reference_id =
  "bill-refund-<order id>"` (idempotent by reference) → order `refunded`, `payment_status: refunded`. Used through the
  Phase 1 refund claim, so it can never run twice.
- Never moves a `completed` or `refunded` order.

## 8. Admin — `/admin/utility-bills` (matches the two admin references)

Tabs **Orders | Settings | Refund Queue** (Commission Wallets tab arrives in 3b).
- **Orders:** stat cards (Total sales, Orders: completed · in flight, Hubtel commission earned, Failed / Refunded) for the
  filtered window; filters (search ref/account/name, status, biller, source, paid-only, date range); rows with biller logo,
  account (verified name, or "Unverified — entered manually" + number), purchaser (+ source tag), Paid/status pills, time,
  amount (+ commission), view, and **Sync** (Phase 1 check-status) on in-flight rows; **Dispatch** on paid `pending` orders
  when auto-fulfil is off.
- **Settings:** Feature gates (master switch, auto-fulfilment), enabled billers with logos, per-biller min/max (1 ≤ min ≤ max
  ≤ 10,000); Surfaces/rail/partner-split sections shown as "Coming in 3b".
- **Refund Queue:** `failed` + `paid` orders with a **Refund to wallet** action (confirm dialog, note required) through
  `adminRefund`; refunded rows listed.
- Admin nav link "Utility Bills" with NEW tag.

## 9. Sidebar (customer)

"Utility Bills" and "Telecel Broadband" links with NEW tags (`lib/nav-new.ts`); each hidden unless the master switch and at
least one of its billers are enabled. Ships dark (all off by default).

## 10. Error handling summary

| Situation | Customer sees | System |
|---|---|---|
| Lookup fails / account not found | "Couldn't verify this account" | nothing charged |
| Token expired / tampered | "Please verify again" | nothing charged |
| Amount outside limits | inline error | nothing charged |
| Insufficient wallet | existing message | order failed, nothing sent |
| Bills / Hubtel off or paused | "Temporarily unavailable" (checked before debit) | nothing charged |
| Hubtel definite failure | "Failed — under review, refund follows if not delivered" | order failed, Refund Queue |
| Unknown outcome | "Processing — under review" | review queue, never resent |

## 11. Testing

Unit (Vitest): per-biller lookup parsers against the documented responses (key casing, leading spaces, negative amounts,
ECG list, Ghana Water sessionId); token sign/verify/expiry/tamper/user-binding; pay orchestration order (no Hubtel call
before a successful debit; one POST max; disabled/paused ⇒ nothing charged; auto-fulfil off ⇒ pending); config resolve +
patch builder; adapter transitions + idempotency + refund idempotency; limit validation. Real `next build` before pushing.
Live: one cheap payment per biller the user can test (e.g. GHS 5 to a known account), after the user picks accounts.

## 12. Rollout

Migration applied before merge; everything off by default; admin enables the master switch and one biller, runs one live
payment, then enables the rest.
