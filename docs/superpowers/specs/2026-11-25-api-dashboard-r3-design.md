# Release 3: developer dashboard — design

Date: 2026-11-25. Branch `feat/api-dashboard-r3` (from main 70d1b071). Roadmap: `2026-11-22-api-rebuild-roadmap.md`, row 3.
Owner instruction 2026-11-25 10:51 GST: "off v1 ans start". v1 was switched off at 11:14 UTC that day (sunset moved from
2026-11-30 to now; one user had 4 v1 calls in 7 days, last on 2026-11-20, no v1 orders; 0 active v1 keys). Standing
pre-approval for R2-R6 (memory `feedback-autonomy-api-rebuild`): the builder makes the design calls and records them,
ships dark where money or messages are involved, never invents prices, and leaves real-money checks to the owner.

## 1. Why

`/dashboard/developer` today is two tabs (keys, docs) plus a legacy v1 section. A developer cannot see whether their
calls are failing, why, or what happened to one order, without asking support. Release 3 gives them that, and the
low-balance warning stops integrations failing silently with `INSUFFICIENT_BALANCE`.

## 2. Goals, non-goals, anti-goals

Goals
- G1. Redesign: one page with tabs Overview, Keys, Usage, Logs, Orders, Docs. Navy accent, phone layout, `lg:` multi-column.
- G2. Usage: requests per day (ok vs failed) for 7 or 30 days, per-endpoint totals, top failure reasons, orders per product.
- G3. Request logs: the developer's own v2 log rows with filters, reason in plain words, keyset paging.
- G4. Order finder: find one order by reference or recipient phone, or list by date range, product and status, across data
  and the commission products; CSV export of the same filters.
- G5. Low-balance alert: the developer sets a GHS threshold; one email + in-app + push notice when the wallet drops below
  it, re-armed when the balance goes back above it.
- G6. Remove the legacy v1 section and its components from the dashboard.
- G7. Log retention: a scheduled clean-up of `api_v2_logs` that never breaks the admin report's totals.

Non-goals
- No change to `/api/v2` request or response contracts, prices, money engines or the R5 spend guard.
- No SMS for the balance alert in this release (SMS spends Datagod credits; free channels only). Recorded follow-up.
- No GHS spend chart (spend lives in several product tables and wallet history; a partial number would mislead).
  The wallet history page already shows money moves.
- Deleting the `/api/v1` routes (they now answer 410) is not part of this release.

Anti-goals
- One developer ever seeing another developer's logs or orders.
- A CSV that runs formulas in a spreadsheet.
- An alert that repeats on every cron pass.
- A slow query on the hot log table (no ALTER or index on `api_v2_logs`, `api_orders` or `api_v2_keys`).

## 3. Approaches

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | SECURITY DEFINER read functions per view (usage, logs, orders), called by session routes that pass the verified user id | One migration; queries use existing indexes via the user's key ids | **Chosen** |
| B | Session routes querying tables with the service client in TypeScript | No migration, but unions and grouping in JS over many rows; harder to bound | Rejected |
| C | Reuse the public `/api/v2` GET endpoints from the browser with a key | Needs the secret key in the browser | Rejected (security) |

## 4. Data and functions (migration 0199; re-check the number before writing)

New table `api_v2_balance_alerts` (service_role only, RLS on, no policies): `user_id uuid pk`, `threshold numeric(12,2)
check > 0 and <= 100000`, `enabled bool default true`, `armed bool default true`, `last_sent_at timestamptz`,
`updated_at timestamptz`. No foreign keys (no lock on existing tables).

Functions (SECURITY DEFINER, pinned search_path, service_role EXECUTE only, `statement_timeout` set):
- `api_v2_dev_usage(p_user, p_days)` → per-day `{day, ok, failed}` (failed = status >= 400), per-endpoint totals,
  top 10 `error_reason` counts, orders per product (data from `api_orders`, commission from `api_v2_idempotency`).
  `p_days` in (7, 30). Reads logs through `key_id = ANY(user's key ids)` so the existing `(key_id, created_at)` index serves it.
- `api_v2_dev_logs(p_user, p_filters jsonb, p_before_at, p_before_id, p_limit)` → rows newest first, keyset on
  `(created_at, id)` (the R4 tie-breaker lesson). Filters: key id (must be the user's), environment, status class
  (ok / client / server), endpoint, from/to (max 31 days apart). `p_limit` <= 100.
- `api_v2_dev_orders(p_user, p_filters jsonb, p_before_at, p_before_ref, p_limit)` → unified rows `{product, reference,
  recipient, amount, status, created_at, key_env}`: data rows from `api_orders` (v2 keys only), commission rows from
  `api_v2_idempotency` with status read live from the product table via `order_ref` where present. Filters: reference
  (exact), recipient (exact, normalised to local form), product, status, from/to (max 31 days). `p_limit` <= 100 for the
  page, <= 5000 for CSV (route asks with the CSV flag).
- `api_v2_balance_alert_scan(p_now)` → rows to notify; flips `armed=false` for them and re-arms rows whose balance is
  back at or above the threshold, in one statement under row locks (no double send across overlapping cron runs).
- `api_v2_logs_retention(p_now)` → deletes `api_v2_logs` rows older than 25 months, at most 20 000 per call. 25 months is
  one month past the admin report's 24-month maximum range, so every range the report can be asked for today stays whole.

Self-rolling-back selftest + PGlite tests + code-built dry-run string, as 0197/0198.

## 5. Routes (session auth; the user id comes only from the verified session)

All under `/api/user/v2-dashboard/`: `usage` (GET), `logs` (GET), `orders` (GET), `orders/csv` (GET), `balance-alert`
(GET, PUT). Each checks v2 eligibility like `/api/user/v2-keys` and `requireCapability(client, userId, "account.api")`, and
is listed in `lib/roles/capability-routes.ts`. Rate limit on the CSV route (it is the heavy one). Cron routes
`/api/cron/api-v2-balance-alerts` (every 15 min) and `/api/cron/api-v2-log-retention` (daily), CRON_SECRET, registered
on cron-job.org through `crons.json` + the sync script.

## 6. The page

- Overview: wallet balance + low-balance alert form, today's requests / failures / orders, 7-day bars, service status
  (existing `StatusBoard`), announcement banner on top (existing).
- Keys: the existing `V2KeysPanel` (with the R5 daily-limit control), unchanged in behaviour.
- Usage: 7/30-day switch, bars, endpoint table, failure reasons in plain words (`log-reason.ts` labels).
- Logs: filter bar + table (phone: stacked cards), "Load more".
- Orders: search box (reference or phone), filters, table/cards, "Download CSV" (same filters, 31-day window).
- Docs: the existing compact `DocsPage`.
- Tab kept in the URL (`?tab=`), like the admin console.
- The legacy v1 section, `DeveloperKeysCard`, `LegacyV1Section`, `V1RetirementBanner` are removed once nothing imports them.

## 7. Abuse cases
1. IDOR: every function takes the user id from the route (session) and filters by it; a key-id filter that is not the
   user's returns nothing. Tested.
2. CSV injection: reuse `lib/api-v2/admin-console/csv.ts` (formula-escaped).
3. Heavy queries: 31-day windows, row caps, statement timeouts, CSV rate limit.
4. Alert spam: armed flag; one send per crossing; free channels only.
5. Data exposure: logs show the developer's own IP and endpoint only; no request bodies exist in the log table.

## 8. Rollout
Migration 0199 (precheck, self-rolling-back dry run, apply, verify), then code, then crons. The balance alert only sends
to people who set a threshold, so nothing is sent at launch. Live check: open the dashboard as a test developer, load each
tab, set and clear a threshold. Channel post drafted after; Post now / Hold asked.

## 9. Left to the builder (correctable)
Visual layout, empty states, copy, the exact chart component (reuse R4 `TrendBars`), cron minutes.
