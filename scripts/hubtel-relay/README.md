# Hubtel relay (DigitalOcean)

Forwards two calls so Hubtel sees one fixed, whitelisted IP: the fulfilment callback and the
transaction status check. No business logic, no queue. Retries live in Vercel crons.

## Deploy
1. Create a droplet (Ubuntu, smallest size). Note its public IPv4 — give this to your Hubtel
   Retail Systems Engineer for whitelisting (callback + status-check endpoints).
2. `ufw allow 22,80,443/tcp && ufw enable`; install Node 20+ and Caddy.
3. Copy `server.ts` and `../../lib/ussd-hubtel/relay-handler.ts` into `/opt/hubtel-relay/`
   (keep them side by side; the import `./relay-handler` then resolves).
4. Env (systemd `EnvironmentFile`): `RELAY_SECRET` (long random; same value as Vercel
   `HUBTEL_RELAY_SECRET`), `HUBTEL_COLLECTION_ACCOUNT`, `HUBTEL_STATUS_BASIC_AUTH`
   (base64 of `apikey:secret`, no "Basic " prefix), optional `PORT`/`HOST`.
5. systemd unit: `ExecStart=/usr/bin/npx tsx /opt/hubtel-relay/server.ts`, `Restart=always`.
6. Caddy reverse-proxy `relay.<your-domain>` → `127.0.0.1:8080` (automatic TLS).
7. Vercel env: `HUBTEL_RELAY_URL=https://relay.<your-domain>`, `HUBTEL_RELAY_SECRET=<same secret>`.
8. Smoke test (expect 401 without the secret, 400 with a bad reference):
   `curl -i https://relay.<domain>/status?clientReference=x` and with `-H "Authorization: Bearer $SECRET"`.
