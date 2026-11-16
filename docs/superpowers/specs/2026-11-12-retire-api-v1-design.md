# Retire Developer API v1 (v2 becomes the only API) — Design

Date: 2026-11-12 · Status: draft for owner approval · Builds on: `docs/superpowers/specs/2026-10-22-developer-api-v2-design.md`

## Why

Datagod has two public developer APIs. v1 (`/api/v1/*`, `dg_live_`/`dg_test_` keys in `user_api_keys`) is the old one. v2 (`/api/v2/*` and `api.datagod.store/v2/*`, `dg2_*` keys in `api_v2_keys`) is complete: all 9 build plans shipped, public docs at `/developers`, Postman collection. v2 has been switched on for every role (`api_v2_config.enabled = true`, `allowed_roles = {user, sub_agent, dealer, admin}`) since 2026-10-27. The owner wants **one API: v2**, with v1 switched off.

### Production facts (read 2026-11-12)

| | v1 | v2 |
|---|---|---|
| Orders, last 30 days | **253 (GHS 3,832.41), all from ONE customer** | 0 (1 ever, 2026-10-28) |
| Orders, last 7 days | 72 | 0 |
| Keys | 57 total, 43 active, 13 used in 30d (10 users), 2 used in 7d | 34 active (live+test, all types) |
| Users holding both | 5 | |

v1 traffic, last 30 days (`user_api_logs`): `GET /orders` 6,259 · `POST /orders` 259 · `GET /balance` 166 · `POST /bills/verify` 18 · `GET /results-checker` 5 · `GET /afa` 5 · `GET /bundles` 4 · `GET /products` 1 · sandbox reset 1.

Retiring v1 is therefore mostly about **not losing the one customer who brings in all v1 revenue**, while giving about 9 lighter users a short, firm deadline.

## Goals

1. On a set date, v1 stops working for everyone **except allow-listed customers**. Rejected requests get a clear "retired, use v2" answer.
2. The one big v1 customer keeps v1 working through an allow-list until they have moved to v2. Then the exception is removed and v1 is fully off.
3. Every v1 user hears about it through four channels: WhatsApp channel post, direct SMS/email, warnings in API responses, and a dashboard banner.
4. **Before the cut-off**, v2 purchases keep working (still rate-limited) when Redis is down. Today they return 503, which is how the 2026-11-07..12 Upstash cap broke v2 purchases while v1 kept selling.

## Non-goals

- Deleting v1 code. That is a later, separate change, after the exception customer has moved.
- Moving or converting v1 keys into v2 keys. Developers generate v2 keys themselves on `/dashboard/developer`, because v2 keys have types (standard / commission / sms) that v1 keys don't map onto.
- Changing v2's endpoints, pricing or behaviour, apart from the limiter fallback (Goal 4).
- Moving all Redis users (USSD/WhatsApp sessions) to Postgres. That is a separate project.

## Anti-goals (failure even if it "works")

- The big customer's v1 integration breaks before they have moved, whether at the cut-off, through a config read error, or by accident.
- A v1 user is cut off without having been told, or gets a generic 401 "invalid key" and thinks their key was compromised.
- v2 purchases move money without any rate limit when Redis is down. The fallback must still limit.
- Charging anyone for a refused or failed call.

## Owner decisions (2026-11-12)

| Topic | Decision |
|---|---|
| End state | v2 on (already true), v1 switched off |
| The big v1 customer | **Keep v1 working for them only** (allow-list) until they move |
| Notice for everyone else | **2 weeks** |
| Cut-off mechanism | **Automatic on a set date** (admin sets it once; v1 refuses from that moment) |
| After cut-off response | **HTTP 410** with a clear "v1 retired, use v2" message and the docs link; keys stay in the DB, just refused |
| Notification channels | **All four:** WhatsApp channel post, direct SMS/email to v1 key holders, Deprecation/Sunset headers + notice field in v1 responses, dashboard banner |
| v2 resilience | **Yes, before the cut-off:** v2 purchases keep working, still rate-limited, when Redis is down |
| v2 readiness gaps (section 7) | **Part of this project**, shipped before the big customer is asked to move |

## How it works

### 1. Retirement config (single source of truth)

Admin-editable settings stored in the database (builder picks the table; extending the single-row `api_v2_config` is the natural home):

- `v1_sunset_at timestamptz null`: null means no retirement scheduled (today's behaviour).
- `v1_exempt_user_ids uuid[] not null default '{}'`: users whose v1 keys keep working after the sunset. *(My call: per user rather than per key, so a customer who rotates or holds several v1 keys stays covered.)*

States derived from the time:
- **Before notice** (`v1_sunset_at` null): v1 unchanged.
- **Notice period** (`now < v1_sunset_at`): v1 works, but carries warnings (section 3), and new v1 keys can't be created (section 4).
- **Retired** (`now >= v1_sunset_at`): every v1 request from a non-exempt user gets 410 (section 2). Exempt users work as before, still with warnings.

**Fail-safe rule:** if the config can't be read, v1 behaves as **not retired**: it serves the request and logs a warning. A DB blip must never cut off the big customer. *(This is the opposite of v2's fail-closed purchases, on purpose. Refusing here doesn't protect money, it just breaks a paying integration.)* Cache the config briefly in memory (about 60 s) so v1 doesn't add a DB read to every request.

### 2. The 410 gate

One shared check, run on every `/api/v1/*` route right after the API key is authenticated. All 13 routes go through `authenticateApiKey` in `lib/api-auth.ts`, so the gate belongs next to it. The check sees which user owns the key, so it can honour the allow-list. Order:

1. No or invalid key → 401, as today. Retirement doesn't change unauthenticated behaviour.
2. Valid key, retired, user not exempt → **410**:
   ```json
   { "success": false, "error": "api_v1_retired",
     "message": "API v1 was retired on <date>. Please move to API v2: https://www.datagod.store/developers" }
   ```
   No charge, no order, nothing else runs. The refusal is logged to `user_api_logs` (status 410) so the admin can see who is still calling v1.
3. Otherwise → the route runs as today.

Applies to live and test (sandbox) keys alike.

### 3. Warnings in v1 responses (notice period and for exempt users)

From the moment `v1_sunset_at` is set, every v1 response carries:
- `Deprecation: true` and `Sunset: <HTTP-date of v1_sunset_at>` headers, plus `Link: <https://www.datagod.store/developers>; rel="successor-version"`.
- For **non-exempt** users only: a top-level JSON field `"notice": "API v1 will be retired on <date>. Move to v2: https://www.datagod.store/developers"`. Builder confirms no v1 response is a bare array or non-JSON.
- **Exempt users get the headers only, never the body field**, before or after the date. Their response bodies stay byte-for-byte as today. *(My call: the big customer's JSON parser is unknown, and a strict client could reject an unexpected field. That would cause exactly the outage the anti-goals forbid. Headers are invisible to ordinary JSON parsing.)*

### 4. Dashboard and admin console

- **Developer dashboard** (`/dashboard/developer`): users with an active v1 key see a banner with the date, what happens on it (410), and a button to the v2 docs and key generation. The "Legacy v1" section shows the same date. During the notice period and after, **v1 key creation is disabled** (`/api/user/keys` POST refuses with a clear message). Exempt users keep the ability to *view* their v1 keys, but can't create new ones either. *(My call: the exception covers existing keys only.)*
- **Admin console** (`/admin/api-keys`): a "v1 retirement" card to set or clear the sunset date (date-time picker, shown in Ghana time), manage the exempt-user list (search by email/phone, add/remove), and see a live table of **v1 users still calling in the last 7 days** (user, last call, calls, orders), so the admin can chase stragglers. Setting a date earlier than 14 days from now asks for confirmation. *(My call: the owner chose 2 weeks, so the UI nudges but doesn't hard-block.)*

### 5. Direct notice to v1 key holders

When the admin sets the sunset date, offer a one-click "Notify v1 users" action. It sends one SMS and/or email to every user with an **active** v1 key, through the existing broadcast/notification system. Every message includes the date, the 410 consequence and the docs link. Exempt users get a different, personal message. Sending is explicit (a button), never automatic on date-save, and records that it was sent so a second click warns. The ready-to-paste WhatsApp channel post is written by the assistant at release time, not by the product.

### 6. v2 limiter fallback (must ship before the cut-off date)

Today `lib/rate-limiter.ts` `applyRateLimit` returns `degraded: true` when Redis is unreachable. `lib/api-v2/handler.ts` then answers 503 for every route marked `failClosedWhenLimiterDegraded` (data purchase/bulk, airtime, bundles, utilities lookup/pay, results checker, AFA, SMS send).

Required behaviour: when Redis fails, v2 purchase routes use a **Postgres-backed limit** instead of refusing:
- Same bucket key and the same per-minute limit as the Redis limiter.
- Atomic in the database (one statement or RPC; no read-then-write race).
- If Postgres **also** fails, keep today's behaviour: 503 and no money moves.
- Read-only routes keep today's fail-open behaviour.
- Never used while Redis is healthy (no extra DB load in the normal case). Old counter rows get cleaned up.

*(Builder's choice: where the fallback lives, i.e. inside `applyRateLimit` behind an opt-in flag or in the v2 handler, plus table shape and cleanup. Opt-in is strongly preferred so v1, USSD and page limiters don't change.)*

### 7. Readiness of v2 for the big customer (in scope: owner decision 2026-11-12)

**Part of this project.** Not a blocker for the 2-week cut-off of other users, but it must all be shipped before the exception customer is asked to switch, because they will put all of today's v1 volume on v2. Each is a known open item from the v2 build:
- Sweeper and admin view for stuck v2 orders and idempotency claims (pending/unknown rows older than about 10 minutes). Nothing surfaces them today.
- Per-key (not per-user) rate-limit bucket for non-active keys. Revoked or pending keys currently drain the owner's shared bucket (`handler.ts` keys the limit on `row.user_id`).
- MTN bulk cap (about 20 new MTN items per call) so a 100-item bulk can't exceed the function time budget.
- Outage vs bad key: a DB error must not tell developers their key is invalid.

**Sequencing:** the per-key bucket and outage-vs-bad-key items touch the same limiter path in `lib/api-v2/handler.ts` as the section 6 fallback. Build them together so that code is rewritten once, and choose the fallback's bucket key to match the final per-key scheme.

## Rollout

1. Ship the code with `v1_sunset_at` null. Nothing changes for anyone.
2. Ship the v2 limiter fallback (section 6) and verify it live: simulate a Redis failure in a test or preview and confirm v2 purchases still work and are limited.
3. Admin adds the big customer to the exempt list, sets `v1_sunset_at` = announcement day + 14 days, clicks "Notify v1 users", and the owner posts the WhatsApp channel message. The dashboard banner and response headers start automatically.
4. During the 2 weeks, the admin watches the "still calling v1" table.
5. Sunset passes and non-exempt v1 calls get 410. Check the logs: no errors, and the exempt customer is still served.
6. Later: the customer moves to v2, the admin removes their exemption, and v1 is fully off. Deleting v1 code is a separate change.

**Rollback at any point:** clear `v1_sunset_at`, and v1 works for everyone again immediately (within the config cache time).

## Testing expectations

- Unit: retirement state derivation (null / before / after / exempt / config read error ⇒ serve). 410 body. Headers present only once a date is set. Key-creation refusal.
- Every `/api/v1/*` route covered by a drift test, so a new v1 route can't skip the gate.
- Limiter fallback: Redis down ⇒ Postgres limit enforced (allow up to N, then 429); both down ⇒ 503; Redis healthy ⇒ no Postgres call.
- Live checks after each rollout step, using the project's prod change protocol for any migration (dry run, owner OK, apply, verify).

## Left to the builder

Table and column placement, the cache mechanism, how the gate is wired into the 13 routes (wrapper vs call), the fallback's storage shape and cleanup schedule, admin UI layout within the existing console style, and the message wording (keep the facts above).

## Open questions

None. Section 7 scope was settled by the owner on 2026-11-12 (in scope).
