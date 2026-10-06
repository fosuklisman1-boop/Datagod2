# Hubtel USSD — go-live runbook (Plan 1: main-mode data bundles)

## 0. Prerequisites you do manually
- [ ] Hubtel merchant account; note the **Collection Account Number** and API credentials.
- [ ] DigitalOcean droplet running the relay (`scripts/hubtel-relay/README.md`); give its **public IPv4** to your Hubtel Retail Systems Engineer to whitelist for the callback + status-check endpoints. Deploy layout is repo-relative: copy only `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts` into `/opt/hubtel-relay/`, preserving those paths (the README has the full steps).
- [ ] Vercel env (production): `HUBTEL_WEBHOOK_SECRET` (long random), `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`. Optional `HUBTEL_ENFORCE_FULFILLMENT_IP=true` once the callbacks are confirmed arriving from `52.50.116.54 / 18.202.122.131 / 52.31.15.68`.
- [ ] Migration `0106_hubtel_ussd.sql` applied.
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
3. **Duplicate-delivery check:** run `REPLAY=1 BASE_URL=http://localhost:3000 npx tsx scripts/hubtel-simulate.ts USSD`. It posts the SAME fulfilment payload twice. Expect the first response `outcome: "fulfilled"` and the second `outcome: "duplicate"`, and that the order handler ran only once (one order, one fulfilment).

**Phase A has not yet been run live — still to do by you** (the build verified types and unit tests only). Also still to do: visual check of `/admin/ussd-hubtel` in a browser.

### PHASE B — production live checks
Phase B **REQUIRES briefly enabling the channel on production**. Safe procedure:
1. Enable only after Phase A passes and the three env vars (`HUBTEL_WEBHOOK_SECRET`, `HUBTEL_RELAY_URL`, `HUBTEL_RELAY_SECRET`) are set to real values. Enable via `/admin/ussd-hubtel` → toggle **Hubtel USSD enabled**.
2. Attach the Hubtel code to a test/restricted audience, or ensure the owner is the only caller during the window.
3. Make exactly ONE small owner-made purchase (e.g. GHS 1).
4. Inspect the row on `/admin/ussd-hubtel`: state `fulfilled`, `callback_status=sent`, amounts match, no `needs_review`; order completed and SMS received.
5. If ANYTHING looks wrong, toggle the channel OFF immediately (always allowed server-side) and do not re-enable until fixed.

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
  - a stale `processing` row (stuck >10 minutes, swept by the status-check cron);
  - a **late payment**: Hubtel reports a successful payment for a session we had already expired (state `failed`, never paid). The customer was told it failed; an admin must fulfil or refund manually — it is never auto-fulfilled.
- Status-check cron (every 2 min): processes up to 50 awaiting-payment rows per run, oldest first; sweeps `processing` rows older than 10 minutes into `needs_review`; makes one final status check before expiring an unpaid row.
- Callbacks cron (every minute) retries pending callbacks.
- `callback_failed`: Retry callback button (re-arms a fresh window; Hubtel may reject after 1 hour).
- Rollback: toggle the channel OFF; Uzo codes are unaffected.

## 5. Known limitations (Plan 1)
- AFA, airtime, results checker and shop mode are not on the Hubtel menu yet (Plans 2 and 3).
- The status-check cron handles at most 50 awaiting rows per run (oldest first); a large backlog drains over several runs.
- Still to do: live visual check of `/admin/ussd-hubtel` and the live end-to-end simulator run on a non-production environment (Phase A).
