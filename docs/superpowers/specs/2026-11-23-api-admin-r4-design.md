# API rebuild, Release 4: admin API console (design)

Date: 2026-11-23. Branch `feat/api-admin-r4` (from main `ee91cc94`). Roadmap: `2026-11-22-api-rebuild-roadmap.md` (Release 4 row,
Known constraints). Style model: `2026-11-22-api-approval-design.md` (Release 1). The owner is away and pre-approved the work end to end
(`feedback-autonomy-api-rebuild`); review gates and the prod change protocol still apply, and money live checks wait for the owner.

## 1. Why

`/admin/api-keys` grew by accretion: tiles, switches, a v1 retirement card, a stuck-orders panel and three tabs. There is no
per-developer view, no way to stop one developer or one product without the global kill (which permanently revokes every key), no
public status, no way to tell developers about maintenance, and no revenue/profit view. Release 4 turns the page into a tabbed
console and adds those four controls.

## 2. Decisions

Binding decisions from the controller (D1-D8) are kept as given. Anything the controller left open is marked **(call)** and listed again
in section 18.

| # | Decision |
|---|---|
| D1 | Tabbed console: Overview, Approvals (unchanged), Developers (new), Keys, Logs, Services and status (new), Announcements (new), Report (new), Legacy v1 (labelled "ends 30 Nov 2026", fully working until then). Navy accent, `lg:` multi-column, phone friendly. |
| D2 | Developer profile with a PAUSE switch. Paused: every v2 request of that person gets 403 "API access paused by Datagod". Nothing is revoked; unpause restores access. State in a new table. Audited. |
| D3 | Pause per service (data, airtime, bills, bundles, results, afa, sms), optional public message, 503. All start ON. Separate from global kill. Audited. Cached read. |
| D4 | Public `/developers/status`: per-service state + 24 h success rate. No per-user data. Cached. |
| D5 | Announcements (title, body, severity, start, end) on all `/developers` pages, the developer dashboard and the status page. Display only. Audited. |
| D6 | Business report by developer, product and month, CSV export, profit only where a cost exists. Read-only. |
| D7 | Every admin write needs a real admin user id; the CRON_SECRET path gets 403 (Release 1 R33). |
| D8 | Out of scope: fraud warnings, spend cap, webhooks, developer dashboard changes beyond one banner, any price change. |

## 3. Non-goals

SMS or email for announcements, per-key pause, scheduled pauses, a v2 contract change (success/error envelopes are untouched; only two
new error responses appear, section 6), retention clean-up (Release 3), any change to prices, roles or `package_costs`.

## 4. What the admin sees

Tabs use the existing `Segmented` control and `?tab=` links (old `approvals`, `keys`, `logs` links keep working). First tab: Approvals
while anything waits, else **Overview (call)** (it was Keys).

- **Overview**: the existing tiles (`OverviewTiles`), a 30-day trend (requests, failures, revenue per day, simple SVG bars, no new
  chart library), the existing `FeatureControls` card (v2 on/off, allowed roles, Global Kill) and `StuckV2Panel`. Global Kill stays here
  with its confirmation; the new pause controls are separate and say so ("reversible, revokes nothing").
- **Approvals**: `ApprovalsPanel` as is.
- **Developers**: search box + list (name, email, role, keys active/pending, 30-day calls, success %, spend, last used, grant badge,
  PAUSED badge). A row opens the profile (state in `?dev=<userId>`, so it is linkable and the back button works).
- **Developer profile**: header (name, email, role, grant status, paused state with who/when/why), PAUSE / UNPAUSE switch (confirm
  dialog with a 3-200 character internal reason on pause), four 30-day tiles (calls, success rate, spend, orders), daily bars, the
  person's keys each with 30-day activity (reuses `api_v2_key_activity`), and the 20 most recent orders (reference, network, size,
  price, status, time; recipient phone is masked to the last 4 digits). Links to Keys and Logs filtered to this person.
- **Keys**: the current `KeyList` for v2 keys.
- **Logs**: the current `RequestLogs`; the status filter also lists the two new log reasons (`developer_paused`, `service_paused`).
- **Services and status**: seven cards (data, airtime, bills, bundles, results, afa, sms), each with state, a 24 h success rate (same
  source as the public page), a switch, and an optional public message (max 200 characters, plain text). Pausing asks for confirmation
  and shows exactly what stops ("new purchases and sends stop; order lookups keep working").
- **Announcements**: list (active, scheduled, ended) and a form (title <= 80, body <= 1000, severity info/warning/critical, start,
  end). Edit and delete. A preview shows the banner exactly as developers see it.
- **Report**: month range picker (default last 3 months, max 24), group-by tabs (Developer, Product, Month), a table, totals and an
  "Export CSV" button. Profit column shows a number only when a supplier cost exists, else "no cost set".
- **Legacy v1**: `V1RetirementCard` and the v1 key controls (`KeyList` restricted to v1 keys plus `V1Controls`), heading "Legacy API v1,
  ends 30 Nov 2026". Behaviour is unchanged. After 30 Nov the tab is removed by Release 3's clean-up, not by this release.

Every tab loads its own data lazily when first opened (the shell no longer loads everything), so a slow tab cannot blank the page.
Each panel has its own error state with Retry (existing `InlineError`). Layout: single column on a phone, `lg:grid-cols-12` split
(list left, detail right) where a list has a detail.

## 5. Data: one additive migration, `0196_api_admin_console.sql`

Next free number: `0195` exists on 5 refs (`api_approval`); no ref holds anything above it (checked with `git ls-tree` over every ref,
2026-11-23). Re-check before Task 1 and before applying; if taken, rename the file, selftest, run builder and test together.

New tables, all service-role only (RLS on, no policies, all client privileges revoked, as 0128/0195):

| Table | Columns | Notes |
|---|---|---|
| `api_v2_developer_pauses` | `user_id uuid primary key references auth.users on delete cascade`, `paused_at timestamptz not null default now()`, `paused_by uuid not null`, `reason text not null check (char_length(reason) between 3 and 200)` | A row means paused. Unpause deletes the row; the audit row keeps history (same shape as grants). |
| `api_v2_service_controls` | `service text primary key check (service in ('data','airtime','bills','bundles','results','afa','sms'))`, `paused boolean not null default false`, `message text null check (message is null or char_length(message) <= 200)`, `updated_at`, `updated_by uuid` | Seeded with seven rows, `paused = false`, so deploy changes nothing. |
| `api_v2_announcements` | `id uuid pk default gen_random_uuid()`, `title text check 1..80`, `body text check 1..1000`, `severity text check in ('info','warning','critical')`, `starts_at timestamptz not null`, `ends_at timestamptz not null check (ends_at > starts_at)`, `created_by uuid not null`, `created_at`, `updated_at` | Index on `(ends_at, starts_at)`. At most 50 rows enforced by the save function. |

New functions (SECURITY DEFINER, `search_path = public, pg_temp`, `lock_timeout 5s`, EXECUTE revoked from PUBLIC/anon/authenticated and
granted to service_role, pinned like 0195). No existing function is changed and no existing table is altered, so the migration takes no
lock on a live request table (new tables only; the FK to `auth.users` takes a brief SHARE ROW EXCLUSIVE on `auth.users`, documented in
the header with the 0195 wording).

Writes (each refuses a NULL actor with `raise exception 'actor is required'`, validates, writes the `admin_audit_log` row in the same
transaction on a real change only, returns jsonb `{"ok":true,"changed":bool,...}` or `{"ok":false,"code":...}`):

- `api_v2_set_developer_pause(p_user, p_paused, p_reason, p_actor)`. Codes: `not_found` (no such `users` row), `bad_reason` (pause only,
  3-200 trimmed). Locks nothing but the pause row (`INSERT ... ON CONFLICT DO NOTHING`/`DELETE ... RETURNING`), so it never touches
  `api_v2_keys` (the log-insert key-share lock is irrelevant). Pausing an already-paused person, or unpausing an unpaused one, returns
  `changed:false`, audits nothing. Audit actions `api_developer_pause` / `api_developer_unpause`, `target_user_id` = the developer.
- `api_v2_set_service_pause(p_service, p_paused, p_message, p_actor)`. Codes: `not_found` (unknown service), `bad_message`. The message is
  trimmed, control characters refused, empty becomes NULL, and it is cleared when resuming. Audit `api_service_pause` / `api_service_resume`
  with before/after `{paused, message}`.
- `api_v2_announcement_save(p_id, p_title, p_body, p_severity, p_starts, p_ends, p_actor)` (NULL id = create). Codes `bad_input`, `not_found`,
  `too_many`. Audit `api_announcement_save`. `api_v2_announcement_delete(p_id, p_actor)`: audit `api_announcement_delete`.
  Audit rows store title and severity and dates only (the body is public anyway but not duplicated).

Reads (STABLE, service-role only, bounded):

- `api_v2_developers(p_since, p_search, p_limit, p_offset)` -> `{total, items[]}`; "developer" = has any `api_v2_keys` row, a grant, or
  a pause row. `p_limit` clamped to 100; `p_search` is matched with `ilike` after escaping `%`, `_`, `\`, max 60 characters.
- `api_v2_developer_profile(p_user, p_since)` -> user, totals, daily buckets, per-key activity, 20 recent orders, grant, pause.
- `api_v2_overview_trend(p_since)` -> per-day requests, ok, failed and revenue (same money rule as 0131).
- `api_v2_business_report(p_from, p_to)` -> grouped rows, see section 9. The supplier-cost join lives only here.
- `api_v2_public_health(p_since)` -> `[{endpoint, total, failed}]` grouped by endpoint (live environment only), no user ids.

Money rule everywhere (identical to 0131): an order counts when `status NOT IN ('failed','refunded')`, attributed by
`api_orders.api_v2_key_id IS NOT NULL`. Existing stats functions (`api_v2_admin_stats`, `api_v2_key_activity`) are reused unchanged for
tiles and per-key numbers; new functions exist only where a grouping the old ones lack is needed.

The migration header lists pre-checks (the three tables and nine functions absent; `admin_audit_log` exists; the actions are not
constrained by a CHECK; `package_costs` exists; the seven service names), the verify queries (privileges false/true, RLS true, zero
policies, seven control rows all `paused = false`), the lock list, "apply in a quiet window", and "a lock timeout is harmless, retry".
`migrations/0196_api_admin_console.selftest.sql` exercises every function and ends `RAISE EXCEPTION 'SELFTEST_OK 0196'`; the dry-run
string is built by code (`lib/api-v2/migration-0196-run.ts`, a copy of 0195's builder with the checks renamed), never by hand.

## 6. The request path (the part that must not break)

### 6.1 Where the checks go

In `runV2` (lib/api-v2/handler.ts), after `decideAccess` succeeds (so a denied or unauthenticated caller learns nothing about pauses) and
before the endpoint handler:

1. **Developer pause**: `deps.controls.isPaused(user_id)`; true -> `failLogged(403, MSG_PAUSED)`, `MSG_PAUSED = "API access paused by Datagod"`.
2. **Service pause**: `service = serviceForEndpoint(opts.endpoint)`; if the service is paused and the method is not GET/HEAD ->
   503 with the admin message or the default `"This service is temporarily unavailable"`.

The check order is therefore: 1-3 unchanged (key, rate limit, owner) > `decideAccess` (config disabled 503 > suspended > key status > key type
> eligibility) > developer pause 403 > service pause 503 > handler. Global config-off (503) and a suspension still win, and the global kill
is untouched.

### 6.2 No query per request: a short-TTL snapshot

`lib/api-v2/controls.ts` keeps one module-level snapshot per server instance: the set of paused user ids and the map of paused services
(with messages). Both come from two tiny reads (`select user_id` from the pauses table, limit 5001; `select service,paused,message`
from the seven-row controls table) run in parallel by one function `refreshControls(client)`.

- **TTL 10 s.** Requests inside the window read memory (zero queries, zero awaits beyond a resolved promise). The first request after
  expiry refreshes; concurrent requests during a refresh share the in-flight promise (single flight), so at most 2 queries per instance per
  10 s no matter the traffic. Compare: today every request already makes 3-4 queries.
- **Why a snapshot and not a join.** An embedded `api_v2_developer_pauses(...)` select on `users` or `api_v2_keys` would be zero extra queries
  but needs a foreign-key relationship and a PostgREST schema-cache reload, and **fails the whole select (every request 503) if the code
  ships before the migration**. That violates the deploy-order constraint. The snapshot degrades safely instead (6.3).
- **Effect time.** A pause or resume takes effect on each instance within 10 s; the instance that served the admin write drops its snapshot
  immediately (best effort; other instances wait out the TTL). In-flight requests and already-accepted orders are not interrupted (stated in the
  admin confirmation and in the docs).

### 6.3 Failure behaviour (decided, with reasons)

| Situation | Behaviour | Why |
|---|---|---|
| Tables missing (code shipped before migration, or after a rollback): PostgREST error code `42P01` / `PGRST205` / message "does not exist" or "schema cache" | Treated as "nothing paused" and cached for the TTL | Nothing can be paused before the tables exist, so this is the true state, not a guess. This is the only fail-open case. |
| Any other read error, and a snapshot younger than 5 minutes exists | Keep serving the last known snapshot, retry at the next TTL expiry | A DB blip must not block unpaused people nor release paused ones. Bounded staleness. |
| Any other read error and no snapshot, or the snapshot is older than 5 minutes | **503 `MSG_UNAVAILABLE`** (logged, slug `unavailable`) | A pause is a safety control; with no knowledge of it we do not guess "open". The same outage already makes the key lookup fail with 503, so no extra user-visible downtime. |
| Pause list is 5001+ rows (cap) | Treated as a read error | A truncated list would silently release people (same rule as `listActiveRoles`). The admin UI refuses to create the 5000th pause. |

### 6.4 Endpoint to service

`lib/api-v2/services.ts` maps `opts.endpoint` by prefix, so none of the 30 route files change: `/api/v2/data/*`, `/api/v2/packages`,
`/api/v2/orders/*` -> data; `/airtime/*` -> airtime; `/utilities/*` -> bills; `/bundles/*` -> bundles; `/resultschecker/*` -> results;
`/afa/*` -> afa; `/sms/*` -> sms; `/account/*` and `/wallet/*` -> none (never pausable: a developer must always be able to see their
balance and role). A test walks every `app/api/v2/**/route.ts`, extracts the `endpoint:` literal and fails when one maps to nothing and is
not in the explicit exempt list, so a new endpoint cannot ship un-pausable by accident. Service ids equal `DocSlug` (`lib/api-v2/docs/pages.ts`).

**(call) Reads stay up.** A service pause blocks every method except GET/HEAD. Blocking order lookups would stop developers reconciling
the orders that are still being fulfilled, and would turn "we paused purchases" into a support storm. The owner said "switch off an
endpoint group"; if a hard stop of reads is wanted it is a one-line change (`PAUSE_BLOCKS_READS`), flagged to the controller.

### 6.5 Logging and slugs

Both new denials are logged (they are real attempts the admin may want to see). `error_reason` must stay a closed slug set:
`developer_paused` and `service_paused` are added to `lib/api-v2/log-reason.ts`; the admin message text is never logged and the service
message is passed to `finish` only as the response body, never as the log message (the log message is the fixed marker). Rate-limit
bucket and `last_used_at` behave as for any other 403/503 (touched, as `failLogged` does today).

### 6.6 Docs and error guide

`lib/api-v2/docs/error-guide.ts` gets two entries (403 "API access paused by Datagod": contact support, nothing was revoked, retry later;
503 service message: check the status page, retry with the same reference, idempotency makes it safe). `changelog.ts` gets one entry.
Both flow into OpenAPI/Postman/search because those are generated from the same sources; the docs tests keep them in sync.

## 7. Public status page and announcements

### 7.1 Status

`GET /api/developers/status` (public, no auth, no cookies) returns:

```json
{ "generatedAt": "...", "services": [
  { "id": "data", "title": "Data and wallet", "state": "operational|paused|degraded|no_data",
    "message": null, "successRate24h": 99.7 } ] }
```

- `state` comes from the service controls (paused wins). `degraded` when not paused, `>= 20` requests in 24 h and the success rate is
  below 95 %. `no_data` (< 20 requests): the rate is `null`, never an exact small count.
- Success rate = (requests with status < 500) / requests, live environment only, over 24 h. 4xx are developer mistakes, not outages. Per-service
  numbers sum `api_v2_public_health` rows through `serviceForEndpoint`; unmapped (account, wallet) are ignored.
- No user ids, keys, IPs, request counts or endpoints leave the server. Only the closed fields above.
- **Caching (two layers):** `Cache-Control: public, s-maxage=60, stale-while-revalidate=300` for the CDN, plus a 60 s in-memory cache in
  `lib/api-v2/status-public.ts` so that `?x=random` query strings (which bypass the CDN key) still cost at most one query pair per instance per
  minute. Query parameters are ignored. A DB error returns the last good payload if younger than 10 minutes, else a 503 with
  `{ "error": "Status is temporarily unavailable" }` and no-store.
- The page `app/developers/status/page.tsx` stays static (a client component fetches the route) so the docs layout remains statically
  generated and `next build` with placeholder env needs no database. Linked from the docs header and the sidebar.

### 7.2 Announcements

`GET /api/developers/announcements` (public, same two-layer cache) returns active ones (`starts_at <= now < ends_at`, newest first, max 5):
`{ id, title, body, severity, endsAt }`. A client component `AnnouncementBanner` (`components/developer/AnnouncementBanner.tsx`) fetches it
and renders title and body as **plain text only** (React escapes; no markdown, no links, no HTML), severity colours (info navy, warning
amber, critical red) with an icon and text label (not colour alone), dismissible per announcement id in `sessionStorage` (wrapped in
try/catch; critical ones are not dismissible). It mounts in `app/developers/layout.tsx` (so every docs page and the status page),
and once in `app/dashboard/developer/page.tsx` (one import and one element; no other change to the dashboard, so Release 3 can merge).
Failure to load renders nothing (an announcement must never break a docs page).

## 8. Admin routes (all under `/api/admin/api-v2/`, all call `verifyAdminAccess` first)

| Route | Methods | Notes |
|---|---|---|
| `developers` | GET `?q=&page=` | list |
| `developers/[userId]` | GET | profile |
| `developers/[userId]/pause` | POST `{paused, reason}` | **write: real admin id required** |
| `services` | GET | controls + 24 h rates |
| `services/[service]` | PUT `{paused, message}` | **write** |
| `announcements` | GET, POST | POST **write** |
| `announcements/[id]` | PUT, DELETE | **write** |
| `trend` | GET | overview trend |
| `report` | GET `?from=&to=&by=&format=csv` | read-only; CSV is a download |

R33 rule (as `global-kill` and `decide()`): `verifyAdminAccess` returns `userId` undefined on the CRON_SECRET path; every write route returns
403 "Sign in with an admin account to do this." when `userId` is missing, and the lib function also refuses (`NO_ADMIN`), so the rule holds
even if a route forgets. Reads work with either. `route.ts` files export only handlers and config; logic lives in
`lib/api-v2/admin-console/*.ts` (pure shaping + RPC wrappers taking an injected client, like `approvals.ts`). Ids are validated as UUIDs
and services against the closed list before any RPC. Unexpected errors return a generic message and log only the code, never PII.

## 9. Business report

Dimensions: developer (user), product, month (UTC, = Ghana time). Source of truth for money is `api_orders` (the only table that carries
`api_v2_key_id`), same filter as 0131.

- **Product** = the order's `network` for data orders (MTN, AT, Telecel, ...), so the Product tab is "by network".
- **Revenue** = sum of `api_orders.price` (what the developer paid). **Orders** = count.
- **Profit** only where a supplier cost exists: `api_v2_business_report` left-joins the admin-only cost table on `api_orders.package_id`.
  Per group it returns `orders`, `revenue`, `costed_orders`, `costed_revenue`, `cost_total`. TypeScript computes
  `profit = costed_revenue - cost_total` and shows it only when `costed_orders > 0`; when `costed_orders < orders` the cell reads
  "GHS 120.00 on 40 of 55 orders" and the row is badged "partial"; when `costed_orders = 0` it reads **"no cost set"**. A cost is never
  guessed, defaulted, averaged or inferred from another package or role price. Orders whose `package_id` is NULL (package deleted) count as
  not costed.
- The TS shaper never contains the cost table or column name (the `package-costs.guard.test.ts` allow-list stays unchanged); it only
  sees `cost_total`/`costed_*`. Admin-only route, admin-only page.
- **(call) Other products are counted, not valued.** Airtime, bills, bundles, results, afa and sms are not attributed to a v2 key in a money
  table (their orders live in engine tables keyed by user, with the v2 claim in `api_v2_idempotency`). The report adds one section
  "Commission and other products" counting completed claims (`status = 'done'`) by `kind`, user and month, with revenue shown as
  "not tracked". Task 1 records a pre-check of what the claim `response` carries; revenue for these kinds is a follow-up, never an estimate.
- **CSV** (`format=csv`, same route, `Content-Disposition: attachment`, `Cache-Control: no-store`, UTF-8 BOM so Excel reads it): columns
  `month, developer, email, product, orders, revenue_ghs, profit_ghs, profit_note`. Cells are quoted; a cell starting with `=`, `+`, `-`, `@`,
  tab or CR is prefixed with `'` (formula injection: developer names are user-controlled and an admin opens this in Excel). Row cap 20000;
  range cap 24 months; beyond that the route returns 400 "Narrow the range".

## 10. Developer pause: semantics

Pause applies to the **person**, so every key (live and test) and every endpoint returns 403 `MSG_PAUSED`. Keys, grants, requests, limits and
orders are untouched; unpause deletes the row and the next snapshot refresh (<= 10 s) restores access. A paused person's pending approvals and
key requests still work in the dashboard (the dashboard uses session routes, not v2 keys). Pause does not stop orders already accepted
or fulfilment in progress. Suspension (`users.is_suspended`) is unrelated and still wins in the check order. The reason is internal (admin
audit and profile only) and is never sent to the developer: the 403 message is fixed.

## 11. Audit

Writes go through the SQL functions, which write the audit row in the same transaction (5 actions above). The existing `auditApi` helper
(non-RPC) is not used for these. Reads are not audited. The Developers tab shows the last 5 audit rows for a person in the profile
(`admin_audit_log` where `target_user_id` = the person and `action like 'api\_%'`).

## 12. Abuse cases (checked by tests or review)

1. Non-admin or anonymous hits any admin route -> 401/403 (route tests for each).
2. CRON_SECRET bearer attempts a pause, a service switch or an announcement write -> 403, no row, no audit.
3. Pause bypass: use another key of the same person, a test key, or `X-API-Key` instead of `Authorization` -> all blocked (user-level check).
4. A developer learns whether a service is paused without a valid key -> not possible via v2 (checked after access); the status page is public by design and
   shows state only.
5. Announcement XSS: `<script>`, `<img onerror>`, `javascript:` links in title/body -> rendered as text; CSV/formula injection via names -> prefixed.
6. Status page as an oracle/DoS: `?x=random` flood -> in-memory 60 s cache bounds DB use; no per-user or per-count data.
7. Pause table or controls outage -> section 6.3, never "everyone blocked" for an unpaused user with a recent snapshot, never "paused user released" without a snapshot.
8. Stale snapshot after unpause: a paused person remains blocked up to 10 s per instance; documented.
9. Service message used to phish ("send your key to ...") -> plain text, max 200, control characters refused, admin-authored and audited; no links rendered.
10. A pause row for a deleted user -> cascade removes it; a pause for a user who is also admin is allowed.
11. Mass pause to fish personal data -> the profile endpoint is admin-only and masks phone numbers to the last 4 digits.

## 13. Testing (failing test first, per task in the plan)

- PGlite migration test with a code-built selftest dry run (as 0195): constraints, seed rows, every function (success, each failure code,
  NULL actor, audit rows written once and only on change, privileges via `has_function_privilege`).
- Handler tests with injected fake controls: paused 403 (live, test key, GET and POST), service 503 for POST and pass-through for GET, order
  vs `decideAccess`, error branches of 6.3, zero control reads inside the TTL (counted), single flight, table-missing treated as open, log slug
  never contains the admin message.
- Pure tests: `serviceForEndpoint` (including the route-file walk), status shaping (thresholds, `no_data`, no leaked fields), report shaping
  ("no cost set", partial), CSV escaping, tab selection, report range cap.
- Route tests for R33 (admin id missing -> 403), validation, error mapping.
- UI tests in the style of `admin-view-ui.test.ts` (render to string, no network) for each new panel.
- Existing suites stay green; only the 9 known order-health failures are accepted.

## 14. Deploy order and rollback

1. Migration applied first (prod protocol, section 15). It is additive; **old code keeps working** (nothing reads the new objects).
2. Code deployed after. If code ever runs first, the controls read sees a missing table and treats it as "nothing paused" (6.3); the new admin
   routes return a clear 500 "not set up yet" for the new tabs; the hot path is unaffected.
3. Rollback: revert the code and leave the schema (an extra empty table is harmless). **Before reverting, list paused developers and paused
   services** (`select * from api_v2_developer_pauses; select * from api_v2_service_controls where paused;`): reverted code would silently
   release them, so the admin resumes services and decides about developers first.

## 15. Review and rollout (gates)

1. Fresh reviewer on the **migration** (Task 1: schema, security definer functions, privileges, audit, locks). Mandatory; findings fixed with failing tests.
2. Fresh reviewer on the **request path** (Task 3: handler order, cache, failure table, logging, deploy-order). Mandatory; same rule.
3. Final whole-branch review with the section 12 abuse-case pass (Task 11).
4. Prod protocol: pre-check -> code-built self-rolling-back dry run (must raise `SELFTEST_OK 0196`) -> owner OK -> apply -> verify ->
   placeholder-env `next build` -> check local main for other sessions' commits -> push -> live check (admin routes 401 without login; v2 envelope
   unchanged; status route serves; unpause/pause tested on a probe account, never a real developer).
5. Channel announcement with how-to steps (Post now / Hold) after implementation.

## 16. Files (overview)

New: `migrations/0196_api_admin_console.sql` + `.selftest.sql`; `lib/api-v2/{migration-0196-run,services,controls,status-public,announcements}.ts`;
`lib/api-v2/admin-console/{developers,services,announcements,report,csv}.ts`; `app/api/admin/api-v2/{developers,services,announcements,trend,report}/**`;
`app/api/developers/{status,announcements}/route.ts`; `app/developers/status/page.tsx`; `components/developer/{AnnouncementBanner,StatusBoard}.tsx`;
`components/admin/api-keys/{OverviewTab,DevelopersTab,DeveloperProfile,ServicesTab,AnnouncementsTab,ReportTab,LegacyTab,TrendBars}.tsx`.
Changed: `lib/api-v2/{handler,access,log-reason,console-tabs}.ts`, `lib/api-v2/docs/{error-guide,changelog}.ts`, `components/admin/api-keys/ConsoleView.tsx`,
`app/admin/api-keys/page.tsx`, `app/developers/layout.tsx`, `lib/api-v2/docs/nav.ts` (status link), `app/dashboard/developer/page.tsx` (banner only).

## 17. Left to the builder

Exact column order of the report CSV beyond the list above; chart sizing; the confirm-dialog copy (must name the effect and reversibility);
how `KeyList` is told to show only v1 keys in the Legacy tab (a prop, not a fork).

## 18. Calls made, and risks

Calls: Overview as default tab; reads (GET/HEAD) stay up during a service pause; account and wallet endpoints are never pausable; pause applies to
test keys as well as live; snapshot cache TTL 10 s with a 5 minute stale limit; table-missing is the only fail-open case; pause reason required (3-200),
internal only; status `degraded` threshold 95 % with >= 20 requests, 4xx not counted as failures; non-data products counted, not valued, in the report;
announcement banner loaded client-side so docs stay static; phones masked to last 4 in profiles; admin-set service message is plain text.

Risks for the controller: (1) the report cannot value airtime/bills/bundles/results/afa/sms yet (no v2 attribution in a money table); (2) "pause per
service" keeps reads up, narrower than "switch off" if read literally; (3) the 10 s propagation window and per-instance memory mean a pause is
not instantaneous across instances; (4) the one-line banner in the developer dashboard may conflict with Release 3's redesign (small merge).
