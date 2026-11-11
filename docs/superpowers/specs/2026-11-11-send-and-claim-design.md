# Send & Claim wallet funding: design

Date: 2026-11-11. Status: draft for owner approval.
Source material (verbatim, keep in sync): `docs/send-and-claim-wallet-topup-build-guide.txt`,
`docs/send-and-claim-fake-sms-defence-and-admin.txt`, `docs/send-and-claim-sms-formats.txt`
(regex patterns, fake samples, code-scan rules).

## 1. Intent

Give customers a cheap way to fund their Datagod wallet without a payment gateway. The customer
asks for a payment code, sends MoMo to Datagod's MTN number with that code in the reference, and the
confirmation SMS on the business phone is forwarded to Datagod, which credits the wallet. If the
customer forgot the code, they paste the MoMo transaction ID into a claim box.

Owner's framing: this is a **cheaper main option**, shown beside the existing Paystack/Hubtel Top Up,
not a hidden fallback. The gateway rail stays as it is.

## 2. Goals, non-goals, anti-goals

Goals
- A customer with a verified phone can fund their wallet by plain MoMo send, credited automatically
  within about a minute of the SMS arriving.
- Forgot-the-code payments are still recoverable by transaction ID, without support.
- An admin can see, void, flag/unflag and audit every forwarded SMS and every session.

Non-goals
- No change to the Paystack/Hubtel Top Up rail, its kill switch, or `components/wallet-top-up.tsx`
  beyond placing it under a tab.
- No Telecel or AirtelTigo receiving numbers (one MTN number only; see 5.2).
- No USSD/WhatsApp-bot surface for Send & Claim in this project.
- No automated MoMo statement API integration (reconciliation is an admin upload; see 6.8).

Anti-goals (failure even if it "works")
- Any path where a forged SMS, a guessed transaction ID, or a browser-supplied amount credits a wallet
  without landing in admin review.
- One payment credited twice, or credited to the wrong user.
- A customer's genuine payment silently lost (unparsed SMS must reach the admin queue, never dropped).
- Raw SMS bodies (payer name, phone, amount) in application logs.

## 3. Decisions made by the owner

| Topic | Decision |
| --- | --- |
| Role | Cheaper main option beside Top Up |
| Receiving numbers | One MTN MoMo number. Telecel/AT payers arrive as MTN "Payment received" SMS |
| Phone + forwarder | Owner has a dedicated phone; app is SmsForwarder (github.com/pppscn/SmsForwarder) |
| Who may use it | Users with a verified phone number only |
| Fee | Small % fee, admin-set, separate for customers and dealers; minimum is checked after the fee |
| Window / open payments | 60 minutes per payment code; at most 5 open per user; older open codes stay claimable until their own window ends |
| Limits | Minimum GHS 10 (net of fee), maximum GHS 2,000; above maximum = stored and flagged for review, never auto-credited |
| Unparsed SMS | Saved to an admin review queue, never dropped |
| Code shape | Crypto-random 3 letters + 4 digits (e.g. KXR4821), letters from an alphabet without lookalikes, no brand or product word |
| Amount typed | The amount the customer SENDS. Fee comes off: credited = sent - fee. Session `amount` = sent amount = what the SMS must show. Min GHS 10 checked on the credited amount; max GHS 2,000 on the sent amount |
| Amount mismatch | Exact match to the pesewa auto-credits. A valid code with any other amount is flagged for admin review |
| Admin credit | Admin can "Approve & credit" a flagged row to its matched user, and "Assign to user" any uncredited genuine row (unparsed, no code, over max). One audited DB function, reason required, idempotent on `MOMO-<txid>` |

## 4. Current state (2026-11-11)

- Wallet page `app/dashboard/wallet/page.tsx`: tabs Overview / Top Up / History; Top Up renders
  `WalletTopUp`; `wallet_topups_enabled` hides Top Up for non-dealers.
- Ledger table is `transactions` (not `wallet_transactions`); balance in `wallets`.
- One credit path: `credit_wallet_safely(p_user_id, p_amount, p_reference_id, p_description, p_source)`.
  As saved in `migrations/credit_wallet_safely.sql` it checks idempotency **before** taking the wallet
  row lock. Live definition must be read before building (see 7, step 0).
- Phone gate: `lib/phone-verify-guard.ts` `checkPhoneVerified()` (fails closed, but honours a grace
  period and an admin kill switch).
- Admin auth: `verifyAdminAccess()` in `lib/admin-auth.ts` (admin only; there is no sub-admin role).
- Admin alerts: `lib/admin-actions/` notifier (push + email).
- Sidebar NEW tags: `lib/nav-new.ts` + hand-wired admin links in `sidebar.tsx`.
- Nothing exists for SMS forwarding, MoMo transactions, sessions or claims.

## 5. Design

### 5.1 Customer flow

1. Wallet page gets a fourth tab, **Send & Claim**, beside Top Up. Shown only when
   `momo_claim_enabled` is exactly `'true'` (missing or malformed = hidden; ships DARK).
2. Unverified phone: the tab shows a "verify your phone to use Send & Claim" prompt linking to the
   existing verification flow. The server enforces this; the UI only explains it.
3. Customer enters an amount. Server checks min/max (min applies to the amount after the fee) and the
   5-open cap, then creates a session: code, amount, fee, net, `expires_at = now() + 60 min`.
4. Payment modal leads with the code and the MTN number + account name, and says to type the code in
   the MoMo reference field. Shows net amount to be credited after the fee.
5. The page polls the session; on credit it shows the existing success modal.
6. While the modal is closed, each open session shows its own claim box: locked amount, own countdown,
   one transaction-ID field. "Generate" is disabled at 5 open, with a countdown to the next free slot.
7. Collapsible how-it-works guide (open by default until the user's first successful claim);
   permanent min/max/fee panel. Desktop two-column, mobile stacked.

### 5.2 SMS webhook `POST /api/webhooks/sms-forward`

Under `/api/webhooks/` so it inherits the existing Vercel firewall bypass for webhook paths.

1. Auth: header `x-sms-forward-secret` compared with `SMS_FORWARD_SECRET` in constant time. Secret
   unset = reject everything. Wrong/missing = 401. Never accepted from the query string.
2. Body: JSON `{ text|body|message|sms, from, timestamp }` or form-encoded with the same names.
   The SmsForwarder template sends `[org_content]`, `[from]`, `[timestamp]`.
3. Sender allowlist (Layer 3a): `from` must exactly equal one entry of admin setting
   `momo_sms_sender_allowlist` (default `["MobileMoney"]`). Not on it = stored as `rejected_sender`
   for audit (body kept server-side only), never parsed for credit.
4. Pre-filter: must contain `GHS` and `Transaction ID`; otherwise ignored (promos, balance alerts).
5. Parse with the pure function in `lib/momo-claim/parse-sms.ts`: patterns in the source doc's order
   (MTN Cash In, MTN Payment, Telecel, AirtelTigo). Extract amount, sender name, transaction ID
   (8-15 digits), network, and the `Current Balance` figure when present.
6. No pattern matches but pre-filter passed = store as `unparsed` in the review queue, alert admins.
7. Store `momo_transactions` row with `ON CONFLICT (transaction_id) DO NOTHING`. Duplicate = done.
8. Intake checks (Layer 3b/3c, need no user) run at insert; a hit stores the row as `flagged` with a
   reason and alerts admins. A flagged row can never be credited by the customer, on either path:
   - Transaction-ID sanity: ID lower than the newest accepted MTN ID by more than
     `momo_txid_regression_threshold` (admin setting, default 1,000,000).
   - Balance continuity: `Current Balance` equals a balance already seen on a different transaction ID.
   - Amount above `momo_max_claimable`.
9. Auto-match: uppercase the body, extract code candidates matching our code shape, look up live
   sessions (pending, unexpired). One match = call `claim_via_wallet_topup_session`. No match =
   row stays `pending` for the claim box. A matched session whose amount differs from the SMS amount
   (not exact to the pesewa) = row `flagged` (`amount_mismatch`), session linked for admin approval.
10. Per-user checks (Layer 3d) live inside the shared `claim_momo_transaction`, so they apply to the
    webhook AND the claim box. A hit flags the row (linked to the user) instead of crediting:
    - First ever Send & Claim credit for this user.
    - Credited amount above `momo_auto_claim_review_threshold` (admin setting, default GHS 500).
    - Today's Send & Claim credited total for this user would exceed `momo_auto_claim_daily_cap`
      (admin setting, default GHS 3,000).
11. Always answer 200 after auth (so the forwarder doesn't retry and a probe learns nothing).
    Never log the raw body; log only transaction ID suffix, status and reason.

### 5.3 Manual claim `POST /api/wallet/momo-claim`

Body: `{ transaction_id, session_id? }`. Any amount field is ignored. Rate limit 3 per 30 s per user.
Calls `claim_momo_via_session(user, txid, session_id)`, which requires the caller's own pending,
unexpired session created at or before the SMS `received_at`; uses that session's amount; answers
`not_found` for unknown IDs and for payments that predate every session (no existence leak).
Customer-facing results (no existence leak): `credited`, `under_review` (the claim matched but a
per-user check flagged it; admins notified), `already_credited` (only when credited to this same
user), and one generic `not_matched` ("we couldn't match this ID to your payment") for unknown,
pre-session, wrong amount, flagged, voided, or claimed by someone else.
Failed attempts: 20 per user per 24 h; 5 per transaction ID (any user) flags the transaction.
Early rejections (no session, rate limited) are logged under a placeholder transaction ID so they
cannot poison another user's per-ID cap.

### 5.4 Sessions API `GET/POST/DELETE /api/wallet/momo-sessions`

Create (5 per minute per user, cap 5 open, verified phone, feature on), list own open sessions,
cancel own pending session. Code generation: `crypto.randomInt`, retry on unique conflict.

### 5.5 Data model (all RLS on, no client policies or grants; server/service-role only)

- `momo_transactions`: transaction_id (unique), network, amount, fee, net_amount, sender_name,
  sms_sender, sms_balance, raw_sms, status (`pending|claimed|flagged|voided|unparsed|rejected_sender`),
  flag_reason, claimed_by, claimed_at, session_id, received_at, attempts_reset_at, unflagged_by/at/reason.
- `wallet_topup_sessions`: user_id, code (unique), amount, fee, net_amount, status
  (`pending|claimed|expired|cancelled`), created_at, expires_at, claimed_transaction_id.
- `momo_claim_attempts`: user_id, transaction_id (or placeholder), result with a CHECK listing every
  value the functions can write.
- `momo_reconciliation_runs`: admin upload of an MTN statement; counts of matched / missing IDs.
- Admin settings keys (in `admin_settings`): `momo_claim_enabled`, `momo_payment_accounts`,
  `momo_account_name`, `momo_claim_fee_customer`, `momo_claim_fee_dealer`, `momo_min_claimable`,
  `momo_max_claimable`, `momo_sms_sender_allowlist`, `momo_txid_regression_threshold`,
  `momo_auto_claim_review_threshold`, `momo_auto_claim_daily_cap`.

### 5.6 Database functions (SECURITY DEFINER, `search_path = ''`, EXECUTE revoked from public/anon/authenticated, granted to service_role, verified with `has_function_privilege`)

- `claim_momo_transaction(txid, user, expected_amount?, mode)`: lock transaction row, check status,
  then credit through the same locked-wallet path as `credit_wallet_safely` with reference
  `MOMO-<txid>` and source `momo_claim`, mark claimed, all in one DB transaction.
- `claim_via_wallet_topup_session(session_code, txid)`: webhook path. Lock session, then the above.
- `claim_momo_via_session(user, txid, session_id?)`: manual path. Lock session, then the above with
  the amount check on.
- `admin_unflag_momo_transaction(txid, admin, reason)`: flagged back to pending (no credit).
- `admin_credit_momo_transaction(txid, target_user, admin, reason)`: "Approve & credit" (target =
  the linked session's user) and "Assign to user". Locks transaction then wallet; only from
  `pending|flagged|unparsed`; credits sent amount minus that user's fee; records admin, reason, time;
  closes the linked session if any. Same `MOMO-<txid>` ledger reference, so it can never double credit.
- Wallet credit inside these functions: a lock-first credit (lock wallet row, then check the ledger
  for `MOMO-<txid>`, then update + insert). See section 7 step 0.
- Lock order on every path: session, transaction, wallet.

### 5.7 Admin page `/admin/momo-claims` (sidebar "MoMo Claims" with NEW tag)

Tabs: Monitoring (stat cards, search/filter, latest 200, void/restore/unflag with confirm, raw SMS
dialog, suspicious-users list of 5+ attempts in 24 h, unparsed queue, "Approve & credit" and
"Assign to user" with reason + confirm), Payment Sessions (list, force-expire via one conditional
UPDATE; a force-expired session is a hard stop for both auto-match and the claim box, and the admin
uses "Assign to user" for any genuine payment behind it), Reconciliation (upload statement, show claimed IDs missing
from it), Settings (all keys above, validated server-side). Admin only (no sub-admin role exists).
Claimed rows can never be voided. Every auto-claim, flag and unparsed SMS alerts admins via
`lib/admin-actions`.

### 5.8 Reconciliation (Layer 3e)

Admin uploads an MTN statement export (CSV) on the Reconciliation tab. Server matches every
`claimed` transaction ID in the statement's date range; any claimed ID missing from the statement is
listed in red and alerts admins. No automatic reversal.

## 6. Constraints

- Follows `docs/send-and-claim-wallet-topup-build-guide.txt` security rules 1-15 and the
  Datagod money-change protocol (precheck, rolled-back dry run, owner OK, apply, verify, build, push).
- Work in a git worktree off origin/main; migrations applied before code that needs them.
- Ships DARK: `momo_claim_enabled` absent = feature hidden and every route refuses.

## 7. Build order (for the plan)

0. Read the live `credit_wallet_safely` and `transactions` constraints. The new functions do NOT call
   `credit_wallet_safely`; they use their own lock-first credit (5.6), so existing Paystack/Hubtel/
   refund callers are untouched. If the live `credit_wallet_safely` still checks before locking,
   record it as a separate follow-up under the full money protocol; it does not block this project.
1. Migration + PGlite/rolled-back tests (claim under own session, pre-session payment, wrong amount,
   no session, daily cap, first-claim flag, flagged rows unclaimable, admin credit idempotency,
   concurrent webhook + manual claim, CHECK values).
2. `lib/momo-claim/` pure logic + Vitest: parser (from the fake samples in the source doc),
   code generation/scan, window/cap/boxes, fee/amount maths, fraud checks.
2b. Parser rework: when the owner's real SMS arrive, add each as a test case and fix patterns.
    Must be done before launch (section 8), may happen after the rest is built.
3. Webhook, sessions and claim routes.
4. Wallet page tab + components.
5. Admin page + APIs + sidebar.
6. Security-review agent, typecheck, lint, tests, real `next build`.
7. Phone setup and supervised live test (see 8).

## 8. Launch gates (owner, before switching on)

- Real SMS from the business MTN number: one MTN-to-MTN, one Telecel-to-MTN, one AT-to-MTN, one with
  no reference. Each pasted into the parser test suite.
- Confirm exact sender name ("MobileMoney"?) and that SmsForwarder delivers the custom header.
- Forwarder rule: `PHONE_NUM EQUALS MobileMoney` + contains `GHS`, `received for`, `Transaction ID`.
- Fake-SMS test from another phone must not reach the webhook.
- `SMS_FORWARD_SECRET` set in Vercel; first supervised real payment end to end.

## 9. Left to the builder

Component structure, polling cadence, exact copy, admin table layout, CSV column mapping (from a real
statement sample), and the code alphabet (must exclude O, 0, I, 1, L).

## 10. Calls made by Claude (owner to check)

- Phone gate for Send & Claim is strict: verified phone required even during the grace period or when
  the global phone-gate kill switch is on.
- Telecel and AirtelTigo patterns are kept but only reachable if a non-MTN sender is ever allowlisted.
- Fraud thresholds defaults (GHS 500 review, GHS 3,000 daily cap, 1,000,000 ID regression) are
  admin-editable starting points, not tuned values.
- Dealers pay the dealer fee; there is no separate "agent" role.
- Per-user fraud checks run on both the webhook and the claim box (inside the shared function), so a
  codeless forged SMS can't dodge them through the claim box.
- New claim functions get their own lock-first wallet credit instead of calling or rewriting
  `credit_wallet_safely`; existing credit paths are not touched by this project.
- One generic "couldn't match" message for every failed claim (closes the ID-existence leak).
- Admin force-expire is a hard stop (unlike the source build); "Assign to user" covers genuine payers.
- Fee rounding: credited amount rounds the fee UP to the pesewa (customer never credited a fraction).
