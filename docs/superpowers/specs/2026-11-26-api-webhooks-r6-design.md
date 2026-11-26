# API rebuild Release 6: webhooks

Date: 2026-11-26. Base: main `86723baf`. Roadmap: [2026-11-22-api-rebuild-roadmap.md](2026-11-22-api-rebuild-roadmap.md).
Status: built under the owner's standing pre-approval of Releases 2-6 (2026-11-23). Every call below is the builder's,
recorded as a ruling. Ships DARK: switch off, docs unpublished.

## Intent

Developers today poll `GET /api/v2/.../orders/{reference}` to learn when an order finishes. The roadmap asks for
"signed events, retries, delivery log, send-test button". Success: a developer saves one HTTPS URL, presses
"Send test event", sees it arrive signed, and from then on gets a POST when each live order completes, fails or is
refunded, with retries when their server is down and a log they can read.

## Goals

- One webhook endpoint per developer, set on the developer dashboard (new **Webhooks** tab).
- Signed POSTs (HMAC-SHA256, timestamped) for `order.updated` and `webhook.test`.
- Automatic retries with backoff, a delivery log with every attempt, a Resend button.
- Admin on/off switch (Overview tab), off at ship.

## Non-goals

- Several endpoints, per-event subscriptions, test-mode (sandbox) order events. The Send-test button is the sandbox.
- Guaranteed ordering or exactly-once delivery. At-least-once; the payload says which status, the GET is the truth.
- Any change to the v2 request/response contract, to the order tables, or to how purchases run.

## Anti-goals

- A webhook fault slowing or failing a purchase. Nothing on the purchase path changes.
- Our servers fetching internal addresses for someone (SSRF).
- Flooding a developer with their whole history the day they save a URL.

## Approaches (how status changes are found)

| | Approach | Trade-off | Decision |
|---|---|---|---|
| A | Triggers on the six product tables write an outbox row | Instant; but adds code to every status write on the busiest money tables, and a bug there breaks orders site-wide | Not chosen |
| B | A once-a-minute SQL scan of recent live v2 orders compares the mapped status with the last status notified | Up to ~1-2 min delay; zero change to order tables; easy to switch off | **Chosen** |
| C | Call a notifier from each provider webhook / cron that moves status | Many code paths (12 providers, admin tools); easy to miss one | Not chosen |

Ruling R6-1: B. Cost if wrong: delivery is a minute or two slower than triggers would be.

## Design

### Events

- `order.updated`: a live v2 order (data via `api_orders.api_v2_key_id`, commission claims via `api_v2_idempotency`)
  whose mapped status is final (`completed`, `failed`, `refunded`) and differs from the last one notified. The status
  mapping is the one `api_v2_dev_orders` (0199) uses, so the webhook, order finder and GET agree.
  Moves between `pending`/`processing` are not notified (R6-2: final states are what integrations act on; a
  completed → failed reversal or failed → refunded is notified because it changes the final state).
- `webhook.test`: from the Send-test button; fixed sample data, `"test": true`.
- Only orders created after the endpoint was first saved are considered, within the last 7 days (R6-3: no history
  flood; late refunds inside 7 days still notify). The baseline is `endpoint.created_at`; editing the URL keeps it.

Payload (JSON, built in SQL, stored per event, re-signed per attempt):

```json
{ "id": "evt_<24 hex>", "type": "order.updated", "created_at": "<ISO>", "livemode": true,
  "data": { "product": "data", "reference": "ORDER-1042", "status": "completed", "previous_status": null,
            "recipient": "0241234567", "amount": 12.5, "item": "MTN 2 GB", "order_created_at": "<ISO>" } }
```

### Signing

Headers: `Content-Type: application/json`, `User-Agent: Datagod-Webhooks/1`, `Datagod-Event-Id`,
`Datagod-Event-Type`, `Datagod-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
Secret `whsec_` + 32 random bytes (base64url), generated server-side, stored in a service-role-only table (needed in
clear to sign). Dashboard shows it masked with Reveal and Rotate; rotation is immediate, no overlap (R6-4; cost: a few
failed verifications during the swap, which retries absorb). Docs tell receivers to reject `t` older than 5 minutes.

### Delivery

- Cron `/api/cron/api-v2-webhooks`, cron-job.org every minute, `maxDuration` 60. Each run: scan (≤ 500 new events),
  then claim ≤ 50 due events (`FOR UPDATE SKIP LOCKED`, lease 3 min), send 10 at a time, record results.
- POST, 10 s timeout, no redirects (3xx is a failure), success = any 2xx. Keep status code, duration, and the first
  200 printable characters of the response body.
- Schedule after a failure: 1 min, 5 min, 30 min, 2 h, 8 h, 24 h (7 attempts total), then `failed`. Resend re-queues
  a delivered or failed event for one more full cycle.
- Disabling the endpoint or switching webhooks off leaves events queued; they are skipped, not sent, while off.

### SSRF defence (roadmap constraint)

- URL: `https:` only, no credentials, no port other than 443, hostname not an IP literal, not `localhost`, not ending
  in `.local`, `.internal`, `.localhost`, ≤ 500 chars.
- At save and at every send, resolve all addresses; refuse if any is private, loopback, link-local, CGNAT, multicast,
  reserved, documentation, benchmark, IPv6 ULA / link-local, or an IPv4-mapped / NAT64 form of those.
- The connection is pinned to the vetted address (custom `lookup` on `https.request`), so DNS rebinding between check
  and connect does not work. TLS still verifies the hostname.

### Data (migration 0200)

- `api_v2_webhook_settings` (id = 1): `enabled` false.
- `api_v2_webhook_endpoints`: `user_id` pk, `url`, `secret`, `enabled`, `created_at`, `updated_at`.
- `api_v2_webhook_state`: (`user_id`, `product`, `reference`) pk, `last_status`, `updated_at`.
- `api_v2_webhook_events`: id, user_id, type, payload, state (`pending`/`delivered`/`failed`), attempts,
  next_attempt_at, last_code, last_error, delivered_at, created_at. Index on (state, next_attempt_at).
- `api_v2_webhook_attempts`: event_id, at, code, duration_ms, error, response_snippet.
- Functions (SECURITY DEFINER, service_role only): set/get/delete endpoint, rotate secret, scan, claim, record attempt,
  resend, list deliveries (keyset), enqueue test, settings get/set, retention (events and attempts > 30 days).
- RLS on, no policies.

### Surfaces

- Developer dashboard tab **Webhooks** (account.api): URL form, enable toggle, secret reveal/rotate, Send test event,
  delivery list (newest first, Load more) with attempts and Resend. Hidden behind "Coming soon" while the switch is off.
- Admin Overview card **Webhooks**: on/off switch, counts today (delivered, failed, pending). Admin writes need a real
  admin id (CRON path 403), as in R5.
- Docs: `WEBHOOKS_PUBLISHED=false`. When true, the "Datagod does not send webhooks" lines change and a Webhooks
  section (events, signing with Node/PHP verification snippets, retries) appears. Flip with the announcement.
- Rate limits: endpoint save 20/h, test 10 per 10 min, reveal 30/h, resend 30/h, reads 120/min.

## Left to the builder

File layout, UI details, exact SQL. Follow existing R3/R5 patterns (session routes, `callWrite`/`callRead`,
`latestGate`, PGlite selftests, capability-route registry, cron registry counts).

## Owner live check (after deploy, before announcing)

Switch webhooks on, save an HTTPS URL you control (e.g. a request-bin), press Send test event and check the signature;
buy one small live data order and watch `order.updated` arrive; then set `WEBHOOKS_PUBLISHED=true` and announce.
