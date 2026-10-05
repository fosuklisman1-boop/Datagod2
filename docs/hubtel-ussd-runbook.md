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

## 2. Verify before enabling (all with the kill switch OFF unless stated)
1. Relay: `curl -i https://relay.<domain>/status?clientReference=x` → 401; with the bearer → 400 (bad ref) proves auth + routing.
2. Simulator (dev or preview, channel enabled there): `npx tsx scripts/hubtel-simulate.ts USSD`, then `Webstore`, then `Hubtel-App` → every reply is a well-formed `response`/`AddToCart`; the order shows `payment_status=completed` after the simulated fulfilment; a second identical fulfilment POST returns `outcome: "duplicate"` and does not fulfil twice. **Not yet run live — still to do by you** (the build verified types and unit tests only). On a dev server with the relay unconfigured, expect `outcome: "fulfilled"` with `callback_status=pending`.
3. **Fee assumption (money-critical):** with Hubtel sandbox / a GHS 1 live test, confirm the fulfilment payload's `AmountAfterCharges` equals the AddToCart `Price` (customer pays Hubtel's charge on top). If it equals `AmountPaid` instead, STOP — orders will be flagged `needs_review`; adjust `decidePayment` before enabling.
4. **Callback OrderId (status-check path):** ask Hubtel whether the status-check `transactionId` is accepted as the callback `OrderId` when the fulfilment webhook never arrived. Until confirmed, orders recovered by the status-check cron may show `callback_failed`; use the admin "Retry callback" button.
5. Confirm the relay IP is whitelisted: a real callback returns `ok:true` (check `callback_status=sent` on `/admin/ussd-hubtel`).
6. USSD length: dial on a real handset; confirm no screen is cut mid-word (limit 182 chars).
7. Visual check of `/admin/ussd-hubtel` in a browser — still to do.

## 3. Enable
`/admin/ussd-hubtel` → toggle **Hubtel USSD enabled**. Enabling is blocked server-side until `HUBTEL_WEBHOOK_SECRET`, `HUBTEL_RELAY_URL` and `HUBTEL_RELAY_SECRET` are all set. Make one real GHS purchase end to end; confirm: order completed, SMS received, `callback_status=sent`, no `needs_review`.

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
- Still to do: live visual check of `/admin/ussd-hubtel` and the live end-to-end simulator run (dev server, relay unconfigured: expect `outcome: "fulfilled"` with `callback_status=pending`, and `outcome: "duplicate"` on a repeat).
