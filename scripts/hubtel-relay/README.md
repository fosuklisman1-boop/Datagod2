# Hubtel relay (DigitalOcean)

Forwards two calls so Hubtel sees one fixed, whitelisted IP: the fulfilment callback and the
transaction status check. No business logic, no queue. Retries live in Vercel crons.

## Deploy
1. Create a droplet (Ubuntu, smallest size). Note its public IPv4 — give this to your Hubtel
   Retail Systems Engineer for whitelisting (callback + status-check endpoints).
2. `ufw allow 22,80,443/tcp && ufw enable`; install Node 20+ and Caddy.
3. Copy (or clone) ONLY `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts`
   into `/opt/hubtel-relay/`, preserving those repo-relative paths (the import
   `../../lib/ussd-hubtel/relay-handler` then resolves). `relay-handler.ts` only imports
   node's `crypto`, so nothing else is needed.
4. Env (systemd `EnvironmentFile`): `RELAY_SECRET` (long random; same value as Vercel
   `HUBTEL_RELAY_SECRET`), `HUBTEL_COLLECTION_ACCOUNT`, `HUBTEL_STATUS_BASIC_AUTH`
   (base64 of `apikey:secret`, no "Basic " prefix), optional `PORT`/`HOST`.
5. systemd unit (`StartLimitIntervalSec=0` stops systemd from giving up after repeated quick
   restarts; the relay exits non-zero on an uncaught exception so systemd restarts it):
   ```ini
   [Unit]
   Description=Hubtel relay
   After=network-online.target
   StartLimitIntervalSec=0

   [Service]
   EnvironmentFile=/opt/hubtel-relay/.env
   WorkingDirectory=/opt/hubtel-relay
   ExecStart=/usr/bin/npx tsx /opt/hubtel-relay/scripts/hubtel-relay/server.ts
   Restart=always
   RestartSec=2

   [Install]
   WantedBy=multi-user.target
   ```
6. Caddy reverse-proxy `relay.<your-domain>` → `127.0.0.1:8080` (automatic TLS).
7. Vercel env: `HUBTEL_RELAY_URL=https://relay.<your-domain>`, `HUBTEL_RELAY_SECRET=<same secret>`.
8. Smoke test (expect 401 without the secret, 400 with a bad reference):
   `curl -i https://relay.<domain>/status?clientReference=x` and with `-H "Authorization: Bearer $SECRET"`.

## Balance route (SMS solvency gate)
`GET /balance` (Bearer RELAY_SECRET) → Hubtel Disbursement balance. Env on the droplet:
- `HUBTEL_DISBURSEMENT_ACCOUNT` — the Disbursement (prepaid) account number (required for /balance; without it the route answers 501)
- `HUBTEL_CS_BASIC_AUTH` — base64 `clientId:secret` for Hubtel Commission Services. Optional; only needed for `mode: relay` (the `/cs/<serviceId>` passthrough to cs.hubtel.com, using `HUBTEL_DISBURSEMENT_ACCOUNT`). Without it `/cs` answers 501. In the default `direct` mode Vercel calls cs.hubtel.com itself.
- `HUBTEL_BALANCE_BASIC_AUTH` — optional base64 `user:pass`; defaults to `HUBTEL_STATUS_BASIC_AUTH`
- `POST /refund` (Bearer RELAY_SECRET, body `{orderId, callbackUrl}`) → Hubtel refund API for `HUBTEL_COLLECTION_ACCOUNT`. `HUBTEL_REFUND_BASIC_AUTH` — optional base64 `user:pass`; defaults to `HUBTEL_STATUS_BASIC_AUTH`

Confirm with the Hubtel Retail Systems Engineer that this droplet's IP is whitelisted for trnf.hubtel.com.

## Payment routes (collection)
Both `POST`, Bearer RELAY_SECRET, JSON body. Every field is validated before anything is sent
(400 otherwise); unknown fields are dropped.
- `POST /receive` body `{reference, msisdn, channel, amount, description, callbackUrl}` → Hubtel Direct
  Receive Money `https://rmp.hubtel.com/merchantaccount/merchants/{HUBTEL_COLLECTION_ACCOUNT}/receive/mobilemoney`.
- `POST /checkout` body `{reference, amount, description, callbackUrl, returnUrl, cancellationUrl}` → Hubtel
  Online Checkout `https://payproxyapi.hubtel.com/items/initiate` (merchantAccountNumber = `HUBTEL_COLLECTION_ACCOUNT`).
- Rules: reference 32 lowercase hex; msisdn `233` + 9 digits; channel `mtn-gh` | `vodafone-gh` | `tigo-gh`;
  amount a number that is exactly a 2-decimal value (`Math.round(v*100)/100 === v`; callers round), 0.10–10,000;
  description `[A-Za-z0-9 .,-]`, 1–60 chars; every URL (callbackUrl, returnUrl, cancellationUrl) `https:`,
  ≤500 chars, no credentials, host equal to `HUBTEL_RELAY_APP_HOST`, and forwarded as the parsed, normalised href.
  Upstream fetches use `redirect: "error"`, so a redirect is never followed with the credential.
- Reply: `{ok, upstreamStatus, body, sent}`. `upstreamStatus: 0` = no HTTP response from Hubtel.
  `sent: false` only when the request provably never left the droplet (DNS, connect refused/unreachable,
  connect timeout, TLS certificate failure); timeouts, resets and anything unrecognised are `sent: true`.

Env on the droplet:
- `HUBTEL_RELAY_APP_HOST` — e.g. `www.datagod.store` (host only, no scheme). Without it both routes answer 501.
- `HUBTEL_RECEIVE_BASIC_AUTH` — optional base64 `apikey:secret` for Receive Money + Checkout; defaults to `HUBTEL_STATUS_BASIC_AUTH`.

**Whitelisting:** confirm with the Hubtel Retail Systems Engineer that this droplet's IP is whitelisted
for `rmp.hubtel.com` (Receive Money) and `payproxyapi.hubtel.com` (Online Checkout). Non-whitelisted
calls come back as 403 or time out.
Redeploy: copy `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts` (same paths), set env, `systemctl restart hubtel-relay`.
Check: `curl -s -H "Authorization: Bearer $RELAY_SECRET" https://<relay-host>/balance`

## Send Money routes (refund payouts)
Both Bearer RELAY_SECRET. Answer 501 unless `HUBTEL_DISBURSEMENT_ACCOUNT` and `HUBTEL_RELAY_APP_HOST` are set.
- `POST /send` body `{reference, msisdn, channel, amount, callbackUrl}` -> Hubtel Direct Send Money
  `https://smp.hubtel.com/api/merchants/{HUBTEL_DISBURSEMENT_ACCOUNT}/send/mobilemoney`. `Description` is fixed to
  `Refund` and `RecipientName` is the msisdn. Same field rules as `/receive`; the callback must also be on the app host
  at exactly `/api/webhooks/hubtel-send`. Reply `{ok, upstreamStatus, body, sent}` (`sent` as for `/receive`).
- `GET /send-status?clientReference=<32 hex>` -> `https://smrsc.hubtel.com/api/merchants/{HUBTEL_DISBURSEMENT_ACCOUNT}/transactions/status`.
  Reply `{ok, upstreamStatus, body}`. Hubtel answers HTTP 400 `{"ResponseCode":"error","Data":"Your status check did not match any records..."}` for an unknown reference.
- `HUBTEL_SEND_BASIC_AUTH` - optional base64 `user:pass`; defaults to `HUBTEL_STATUS_BASIC_AUTH`.
- Whitelisting: confirm the droplet IP is whitelisted for `smp.hubtel.com` and that the key may send.
Redeploy: copy `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts` (same paths), keep a dated backup, `systemctl restart hubtel-relay`.
