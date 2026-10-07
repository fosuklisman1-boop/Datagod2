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
