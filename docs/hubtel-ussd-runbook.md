# Hubtel USSD — go-live runbook (Plans 1-2: data, airtime, results checker, AFA)

## 0. Prerequisites you do manually
- [ ] Hubtel merchant account; note the **Collection Account Number** and API credentials.
- [ ] DigitalOcean droplet running the relay (`scripts/hubtel-relay/README.md`); give its **public IPv4** to your Hubtel Retail Systems Engineer to whitelist for the callback + status-check endpoints. Deploy layout is repo-relative: copy only `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts` into `/opt/hubtel-relay/`, preserving those paths (the README has the full steps).
- [ ] Vercel env (production): `HUBTEL_WEBHOOK_SECRET` (long random), `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`. Optional `HUBTEL_ENFORCE_FULFILLMENT_IP=true` once the callbacks are confirmed arriving from `52.50.116.54 / 18.202.122.131 / 52.31.15.68`.
- [ ] **Migration `0106_hubtel_ussd.sql` MUST be applied to the PRODUCTION database BEFORE this branch is merged/deployed.** The two Hubtel crons (`hubtel-callbacks` every minute, `hubtel-status-check` every 2 minutes) start running on deploy and will error on every run until the `hubtel_transactions` table exists.
- [ ] **Migration `0107_hubtel_resolution.sql` MUST be applied to the PRODUCTION database BEFORE this branch is deployed (alongside `0106`; apply both, `0106` first).** It adds `resolution_note`, `resolved_by`, `resolved_at` to `hubtel_transactions`; without it the "Mark resolved" action fails (the page itself still loads).
- [ ] Crons (already in `vercel.json`, nothing to configure): `/api/cron/hubtel-callbacks` runs every minute; `/api/cron/hubtel-status-check` runs every 2 minutes.

## 1. Register the service in Hubtel
- Service Interaction URL: `https://<domain>/api/ussd-hubtel/interaction?secret=<HUBTEL_WEBHOOK_SECRET>`
- Service Fulfilment URL:  `https://<domain>/api/ussd-hubtel/fulfillment?secret=<HUBTEL_WEBHOOK_SECRET>`
- Request a USSD code and attach the service on the Merchant Dashboard.
- The app must be on the **apex or canonical host** that serves the API without a redirect (a www/apex redirect broke webhook delivery for Bundle Portal before).
- **Security note:** these URLs carry `?secret=`, and Vercel / proxy request logs may record the query string. If Hubtel can send a custom header, prefer `x-hubtel-secret: <HUBTEL_WEBHOOK_SECRET>` (both endpoints accept it) and drop the query secret.

## 2. Verify before enabling in production

### PHASE A — non-production (no live Hubtel traffic)
1. Relay: `curl -i https://relay.<domain>/status?clientReference=x` → 401; with the bearer → 400 (bad ref) proves auth + routing.
2. **Simulator.**

   > **WARNING: the simulator can hit PRODUCTION and cause REAL fulfilment.** The channel kill switch lives in the shared `admin_settings` row, and the simulator drives the real order handlers, so a simulated paid order can trigger real provider fulfilment to the recipient number.

   Rules (all mandatory):
   - (a) Run it ONLY against a local or preview server wired to a **non-production Supabase project**. If no staging project exists, **skip this step entirely** — do not run it against production.
   - (b) Before any simulated fulfilment, turn OFF MTN auto-fulfilment (setting `mtn_auto_fulfillment_enabled`, read by `isAutoFulfillmentEnabled` in `lib/mtn-fulfillment.ts`; toggle on `/admin/settings/mtn`) in that non-prod project, so simulated paid orders are not sent to a provider. Set `RECIPIENT` to a number the owner controls.
   - (c) Never point `BASE_URL` at production.

   Setup on the non-prod server: set `HUBTEL_WEBHOOK_SECRET` (export it in your shell, do not type it inline), plus **dummy** `HUBTEL_RELAY_URL` (e.g. `https://127.0.0.1:9`) and `HUBTEL_RELAY_SECRET`, so the channel can be enabled there (enabling is blocked server-side until all three are set). Enable the channel on that server's `/admin/ussd-hubtel`.

   Run `BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts USSD`, then `Webstore`, then `Hubtel-App`. Expect every reply to be a well-formed `response`/`AddToCart`, the fulfilment to return `outcome: "fulfilled"`, and the order to show `payment_status=completed`. Because the relay is a dummy, the callback attempt FAILS: the row stays `callback_status=pending` with a `callback_last_error`. That is the intended retry behaviour in this dry run.

   Then run each Plan 2 flow on the same non-production server (`USSD` platform is enough; repeat one flow on `Webstore` and `Hubtel-App`). The `FLOW=` variants obey every rule above: never against production, secret exported in the shell (sent in the `x-hubtel-secret` header), and `REPLAY=1` for the duplicate check. Menu digits are found by label, so they follow whatever the admin visibility toggles currently show.
   - `FLOW=airtime`: expect `AddToCart` "MTN Airtime to <RECIPIENT>" at the amount you entered (no fee added); after fulfilment the `airtime_orders` row is `payment_status=completed`. Make sure Digiwapy is OFF in that project (or has no live credentials) so no real airtime is sent. A `RECIPIENT` with an unknown prefix adds a network-pick screen the script does not answer.
   - `FLOW=rc`: needs at least one enabled board with vouchers in stock in that project. Expect "<BOARD> Checker x1"; after fulfilment the order is `status=completed` and the PIN SMS is attempted to the caller.
   - `FLOW=rccheck`: `MOBILE` must belong to a registered Datagod user in that project (the service requires an account; otherwise the session ends with "Please create a Datagod account"). Expect "<BOARD> Results Check" at the check fee (or "<BOARD> Voucher + Results Check" if the combo was chosen); after fulfilment the request is `payment_status=paid` and appears on `/admin/results-check-requests`. Override the voucher with `VOUCHER=PIN/Serial`.
   - `FLOW=afa`: `MOBILE` must be an MTN number (default `233244123456`; non-MTN callers get "AFA registration needs an MTN number"). Run it only if that project has NO live AFA provider credentials (Sykes / Apex Prime), otherwise a real registration is submitted. Expect "AFA Registration" at the `afa_registration_prices` default price. With no provider credentials the provider submission fails and the row lands in `needs_review` (see section 4): that is expected in a dry run.
   - `REPLAY=1` with any flow: second delivery `outcome: "duplicate"`, handler ran once.
3. **Duplicate-delivery check:** run `REPLAY=1 BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts USSD`. It posts the SAME fulfilment payload twice. Expect the first response `outcome: "fulfilled"` and the second `outcome: "duplicate"`, and that the order handler ran only once (one order, one fulfilment).

**Phase A has not yet been run live — still to do by you** (the build verified types and unit tests only). Also still to do: visual check of `/admin/ussd-hubtel` in a browser.

### PHASE B — production live checks
Phase B **REQUIRES briefly enabling the channel on production**. Safe procedure:
0. **Prove the status-check path BEFORE trusting any expiry decision.** From your machine (export the secret in your shell first, do not type it inline):
   `curl -s -H "Authorization: Bearer $HUBTEL_RELAY_SECRET" "https://relay.<domain>/status?clientReference=<SessionId>"`
   using the SessionId of a known paid session (or of the owner's test session after step 3). Expect `{"ok":true,"upstreamStatus":200,"body":{...,"data":{...,"status":"Paid"}}}` (or `"Unpaid"` for an abandoned session). This proves the Hubtel Basic-auth credentials, the whitelisted relay IP, and the response shape (`body.data.status`) the status-check cron depends on. `ok:false`/`upstreamStatus` 401/403 means credentials or IP whitelisting are wrong; a 200 without `data.status` means the response shape differs from what the code reads — STOP and fix before going live.
   Note: when the final status check at expiry cannot determine the status (relay down, 401, IP not whitelisted, timeout, unexpected shape), the row is NOT expired: it lands in `needs_review` with `callback_last_error` starting "status check indeterminate at expiry". A burst of these means this path is broken.
1. Enable only after Phase A passes and the three env vars (`HUBTEL_WEBHOOK_SECRET`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`) are set to real values. Enable via `/admin/ussd-hubtel` → toggle **Hubtel USSD enabled**.
2. Attach the Hubtel code to a test/restricted audience, or ensure the owner is the only caller during the window.
3. Make exactly ONE small owner-made purchase (e.g. GHS 1).
4. Inspect the row on `/admin/ussd-hubtel`: state `fulfilled`, `callback_status=sent`, amounts match, no `needs_review`; order completed and SMS received.
5. If ANYTHING looks wrong, toggle the channel OFF immediately (always allowed server-side) and do not re-enable until fixed.
6. **Plan 2 services:** after the data purchase passes, make ONE small owner purchase per service and check the row on `/admin/ussd-hubtel` (state `fulfilled`, `callback_status=sent`, amounts match) plus the service's own record: airtime received (or the manual-airtime admin SMS if Digiwapy is off); results-checker PIN SMS received; check-results request listed on `/admin/results-check-requests` (the owner's number must be a registered Datagod account); AFA order `payment_status=completed` with `fulfillment_status` `fulfilled` or `pending` (the owner must dial from an MTN line). Turn any service you cannot verify OFF in the visibility toggles before widening the audience.

What Phase B checks:
- **Fee assumption (money-critical):** confirm the fulfilment payload's `AmountAfterCharges` equals the AddToCart `Price` (customer pays Hubtel's charge on top). If it equals `AmountPaid` instead, STOP — orders will be flagged `needs_review`; adjust `decidePayment` before enabling further.
- **Callback OrderId (status-check path):** ask Hubtel whether the status-check `transactionId` is accepted as the callback `OrderId` when the fulfilment webhook never arrived. Until confirmed, orders recovered by the status-check cron may show `callback_failed`; use the admin "Retry callback" button.
- **Relay IP whitelisted:** a real callback returns `ok:true` (`callback_status=sent` on `/admin/ussd-hubtel`).
- **USSD length:** dial on a real handset; confirm no screen is cut mid-word (limit 182 chars).

## 3. Go live
After Phase B passes cleanly, leave the channel enabled and widen the audience (remove any restriction on the Hubtel code). Watch `/admin/ussd-hubtel` for `needs_review` and `callback_failed` rows over the first hours.

## 4. Operate
- `needs_review` rows: fulfil/refund manually (existing `/admin/orders` manual fulfilment; refunds via `/admin/refunds`). The callback is still sent as `success` (policy: always success). A row lands here for:
  - under-payment (`AmountAfterCharges` below the expected amount);
  - a failing order handler;
  - a non-payable order (e.g. the order had already failed);
  - **an expired airtime / results-checker order paid late**: the `expire-stale-airtime` cron (`app/api/cron/expire-stale-airtime/route.ts`, 30-minute cutoff) expires `airtime_orders` and `results_checker_orders` still `pending_payment`, which includes Hubtel-created ones. If Hubtel confirms the payment after that, the handler refuses the no-longer-payable order and the row lands in `needs_review` for manual delivery (airtime or vouchers). Loud, not silent: the customer paid, so deliver or refund. (`results_check_requests` and `ussd_afa_orders` are not touched by that cron.);
  - **results-checker vouchers out of stock after payment** (`results_checker_orders` paid, `status=pending`): deliver the vouchers manually, then Mark resolved;
  - **a combo "Check Results" request paid with no voucher left** (`results_check_requests`, `mode=combo`, paid, no `voucher_pin`): assign a voucher to the request on `/admin/results-check-requests`, then Mark resolved. The same state is raised if the request did not reach `paid` after fulfilment;
  - **an AFA provider submission failure**: the library records the outcome in `ussd_afa_orders.fulfillment_status`; when it is `failed`/`unfulfilled` (anything other than `fulfilled` or `pending`) the row goes to `needs_review` and the payer is NOT sent the "registration received" SMS. There is no separate AFA retry queue for `ussd_afa_orders`: re-submit or register manually with the provider, then Mark resolved. (`fulfilled` = Sykes accepted; `pending` = Apex Prime accepted, confirmed later by the AFA sync cron.);
  - **a shop-scoped AFA row** (should never happen on the main menu; shop mode is Plan 3): handle manually;
  - a stale `processing` row (stuck >10 minutes, swept by the status-check cron; `callback_last_error` says "recovered from stale processing");
  - an **indeterminate status check at expiry** (`callback_status=not_due`, `callback_last_error` "status check indeterminate at expiry: ..."): we could not ask Hubtel whether the customer paid. Check the transaction on the Hubtel dashboard (or the relay `/status` call above): if paid, fulfil manually; if not, mark the order failed. The status-check cron re-checks these rows every ~5 minutes, but they usually arrive with ~6 status-check attempts already used and re-checking stops at 12 total attempts, so automatic re-checks cover only roughly the first 30-40 minutes after expiry (never more than 24h). A relay outage longer than that window leaves the row parked until Hubtel's late webhook arrives or an admin resolves it. If Hubtel's success webhook arrives or a re-check says Paid, the payment is recorded and the callback becomes due automatically (`callback_status=pending`), but the order is still NOT auto-fulfilled;
  - a **late payment**: Hubtel reports a successful payment for a session we had already expired (state `failed`, never paid). The customer was told it failed; an admin must fulfil or refund manually — it is never auto-fulfilled.
- Status-check cron (every 2 min): processes up to 50 awaiting-payment rows per run, oldest first; sweeps `processing` rows older than 10 minutes into `needs_review`; makes one final status check before expiring an unpaid row, and expires only when Hubtel definitely says not paid (otherwise `needs_review`). Both Hubtel crons stop starting new rows after ~4 minutes (maxDuration 300s); the next run continues.
- Clearing a worked `needs_review` row: use **Mark resolved** on `/admin/ussd-hubtel` (only offered on `needs_review` rows). A note of 5-500 characters is required; it is stored on the row (`resolution_note`, `resolved_by`, `resolved_at`) and in `admin_audit_log` (`hubtel_resolve_needs_review`). Two outcomes:
  - **Fulfilled manually (customer paid)**: row becomes `fulfilled`. If the row has no callback due yet (`callback_status=not_due`) and a Hubtel order id is on record, the success callback is queued (`pending`, window bounded from now) and the callbacks cron sends it. If there is no Hubtel order id, no callback can be sent (the result says so). If a callback was already pending/failed/sent it is left as is (use Retry callback if needed).
  - **Customer did not pay** (`not_paid`): only enabled for rows with NO recorded payment (`paid_at` empty) AND no callback due (`callback_status=not_due`), i.e. the indeterminate-expiry rows you have verified as unpaid on the Hubtel dashboard. The row becomes `failed`, no callback is sent, and the linked order is failed exactly like an expiry (only if it is still unpaid; a paid order is never touched). A later Hubtel success webhook still recovers it: the payment is recorded, the row returns to `needs_review` with the callback due, and an admin must fulfil or refund. It is never auto-fulfilled.
  - A row that changed while you were resolving it (late webhook, second admin) is refused with a conflict; reload and retry.
- `/admin/ussd-hubtel` always lists every `needs_review` / callback-failed row (plus the 50 most recent); use the "Needs attention" filter. Session, order and Hubtel order ids are shown short — hover for the full value, click to copy.
- Airtime: paid airtime goes to Digiwapy when enabled for the network, otherwise admins get the manual-airtime SMS (same as Uzo). Check-results requests are worked on `/admin/results-check-requests`. AFA registrations follow the normal AFA provider/sync flow once submitted successfully.
- Callbacks cron (every minute) retries pending callbacks.
- `callback_failed`: Retry callback button (re-arms a fresh window; Hubtel may reject after 1 hour).
- Rollback: toggle the channel OFF; Uzo codes are unaffected.

## 5. Known limitations (after Plan 2)
- Shop mode is not on the Hubtel channel yet (Plan 3); `mode=shop` answers "Service unavailable".
- Check Results requires a registered Datagod account (same rule as the Uzo code). AFA is only offered to MTN callers.
- Own-voucher check requests are charged the check fee rounded to 2 decimals; the combo is the single-voucher price plus the fee (no bulk pricing).
- Hubtel orders use `channel='ussd'` like Uzo orders; to report Hubtel separately, join `hubtel_transactions (order_table, order_id)`.
- The status-check cron handles at most 50 awaiting rows per run (oldest first); a large backlog drains over several runs.
- Still to do: live visual check of `/admin/ussd-hubtel` (incl. the Mark resolved dialog) and the live simulator runs on a non-production environment (Phase A).
