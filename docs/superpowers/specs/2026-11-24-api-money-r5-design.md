# Release 5: API money protection (daily spend caps and fraud warnings) — design

Date: 2026-11-24. Branch `feat/api-money-r5` (from main 838e1a1f). Roadmap: `2026-11-22-api-rebuild-roadmap.md`, row 5.
Owner decisions (2026-11-24, in conversation): caps set by **both** the developer and admins (the stricter wins);
suspicious usage **warns admins with a one-tap path to Pause**, nothing automatic; enforcement by a **spend ledger**
(approach A). Standing rule: ship dark (switches off), never invent prices or fees, real-money checks wait for the owner.

## 1. Why

A leaked live key or a looping script can drain a developer's wallet within minutes, and today nothing limits how much
one key or one person spends in a day. Admins also have no early warning: the R4 pause exists, but someone has to notice
first. Release 5 adds a daily spending ceiling and an early-warning feed so a theft is small and short.

## 2. Goals, non-goals, anti-goals

Goals
- G1. A developer can set a daily spending limit per **live** key (protects their own wallet).
- G2. An admin can set a daily limit per **person** across all their live keys (protects Datagod and the developer).
- G3. The stricter applicable limit is enforced **atomically**: parallel requests can never together pass it.
- G4. Admins get deduplicated alerts on suspicious patterns, each linking to the developer's profile (Pause is one tap there).
- G5. Everything ships dark: two switches (caps, alerts), both off. With caps off, the request path does no extra DB work.

Non-goals
- SMS (spends credits, not GHS) is not capped in this release. Recorded as a follow-up.
- Test (sandbox) keys are never capped or alerted on.
- No automatic pause, block or key revocation (owner's choice).
- Refunds do not free cap space (see 5.4).
- No change to any money engine, to `place_api_v2_order`, or to prices.

Anti-goals
- Breaking or slowing a working live integration while the switches are off.
- A cap that ever charges a customer, or refuses a request after the money moved.
- A cap error that leaks the admin limit's value or another person's data.
- Alerts that fire on every request (alert fatigue makes them useless).

## 3. Approaches considered

| | Approach | Trade-off | Verdict |
|---|---|---|---|
| A | Spend ledger: reserve the amount in one locked SQL step before any engine runs; release on a known no-charge result; mark spent on success | One extra fast DB call per live purchase; new tables | **Chosen by the owner** |
| B | Sum today's orders at request time | Not atomic: a burst passes before charges land, exactly the leaked-key case | Rejected (roadmap constraint) |
| C | Counter updated inside each engine's debit | Touches five live money engines and the copy-drift-guarded data function | Rejected (risk) |

Fraud detection (my call): a cron job every 5 minutes reading logs, orders and the ledger. Inline checks would slow
every request.

## 4. Data model (migration 0198; re-check the number on every ref before writing it)

All new tables are service-role only (RLS on, no policies, client privileges revoked), as 0195/0197. No ALTER of any
existing table (no hot-table lock); caps live in their own table, not on `api_v2_keys`.

- `api_v2_money_settings` (singleton, `id = 1`): `caps_enabled bool default false`, `alerts_enabled bool default false`,
  `thresholds jsonb` (section 7 defaults), `updated_at`, `updated_by`. Seeded with both switches **false**.
- `api_v2_spend_caps`: `scope text check in ('key','user')`, `scope_id uuid`, `daily_cap numeric(12,2) check > 0 and
  <= 1000000`, `set_by uuid not null`, `updated_at`; PK `(scope, scope_id)`. `key` rows are written by the key's owner,
  `user` rows by admins. No row = no limit at that level.
- `api_v2_spend_ledger`: `id uuid pk`, `user_id uuid not null`, `key_id uuid not null`, `day date not null` (UTC; Ghana is
  GMT), `kind text` (data, data_bulk, airtime, bill, bundle, results, afa), `reference text not null`,
  `amount numeric(12,2) check >= 0`, `state text check in ('reserved','spent','released')`, `created_at`, `updated_at`;
  UNIQUE `(key_id, kind, reference)`; indexes `(user_id, day)` and `(key_id, day)`.
- `api_v2_risk_alerts`: `id`, `user_id`, `signal text`, `bucket timestamptz` (start of the dedup window), `details jsonb`
  (counts and amounts only, never phones or keys), `created_at`; UNIQUE `(user_id, signal, bucket)`.

Functions (SECURITY DEFINER, pinned search_path, service_role EXECUTE only, plpgsql):
- `api_v2_spend_reserve(p_user, p_key, p_kind, p_reference, p_amount)` → jsonb. Takes `pg_advisory_xact_lock` on the
  user (serialises one person's reserves, nobody else's). Caps disabled → `{ok:true, skipped:true}`. A ledger row for
  `(key, kind, reference)` already exists → returns it unchanged (idempotent retry, never double-reserves). Otherwise sums
  today's `reserved + spent` for the key and for the user; refuses with `{ok:false, code:'cap_reached', scope:'key'|'user'}`
  when `sum + p_amount` exceeds the applicable cap; else inserts a `reserved` row and returns `{ok:true, ledger_id}`.
  Amount must be > 0.
- `api_v2_spend_settle(p_key, p_kind, p_reference, p_state, p_amount)`: `reserved → spent` (optionally the actual
  amount, never above the reserved amount) or `reserved → released`. A missing or already-settled row is a no-op.
- `api_v2_set_spend_cap(p_scope, p_scope_id, p_cap, p_actor)` (null cap = remove), audited in `admin_audit_log`
  (`api_spend_cap_set` / `api_spend_cap_removed`) for developer and admin writes. For `key` scope it verifies the key
  belongs to `p_actor` and is a live key; for `user` scope the route has verified an admin.
- `api_v2_set_money_settings(...)`: admin-only, audited.
- `api_v2_spend_today(p_user)` → per-key and per-user totals and caps, for the dashboard and the admin profile.

Self-rolling-back selftest + PGlite tests + code-built dry-run string, as 0197.

## 5. Request path

### 5.1 Where the reserve sits
Only on live keys, only for purchases (requests that can charge), only when the money-settings snapshot says caps are on
(10 s in-memory snapshot, same pattern and failure rules as `controls.ts`: missing table → "off").

- Commission products (airtime, bill, bundle, results, afa): **after the claim succeeds** (so a replay never reserves)
  and **before the engine**. Reference = the client reference; kind = the claim kind.
- Data single: after price and validation, before `place_api_v2_order`. Amount = the server-side price already computed
  in `priceAndValidate`.
- Data bulk: one reserve for the sum of the **new** (non-replayed) items, kind `data_bulk`, reference = a stable hash of
  the sorted new references; settle with the actually charged total.

### 5.2 Outcomes
- Cap reached → **402**, code `DAILY_LIMIT_REACHED`, message "Daily spending limit reached. Try again after 00:00 GMT or
  raise the limit." When the binding limit is the admin's, the response says only that a Datagod limit applies, never its
  value. For commission products the claim is **released** first, so the same reference can be retried later. No money
  moves.
- Engine success → settle `spent`.
- Engine no-charge error (`classifyEngineError` = `no_charge`, or the data function's known pre-debit refusals) →
  settle `released`.
- Ambiguous or throw → leave `reserved` (counted: the safe side), matching the claim's "unknown" state.
- Reserve call fails (DB error) while caps are on → **503 unavailable**, nothing charged (fail closed for money; the same
  database would serve the charge anyway).

### 5.3 Logging
New log reason slug `daily_limit` (log-reason.ts), so admin Logs and the alerts can count refusals.

### 5.4 Ruling: refunds do not free cap space
A failed data order that is later refunded stays `spent` for the day. Simple and conservative, and a refund wave is itself
a signal. Revisit only if real developers hit it.

## 6. Interfaces for people

Developer (dashboard `V2KeysPanel`, one control per live key; Release 3 restyles it later):
- "Daily spending limit (GHS)" field (empty = no limit) and "Spent today: GHS x". Saved through
  `PUT /api/user/v2-keys/[id]/spend-cap` (session auth, owner-only; someone else's key → 404; test key → 400).
- When an admin limit exists: "A Datagod daily limit also applies" (no value shown).
- While the caps switch is off, the field is shown but labelled "Not active yet".

Admin (R4 console):
- Developers profile: admin daily limit (set or remove, audited), today's spend against each limit, cap refusals today,
  the person's recent risk alerts with time and signal.
- Overview: "Money protection" card with the two switches (caps, alerts; each needs a confirm, audited), the thresholds
  editor and today's alert count. The switch-on copy states what changes for developers.
- Docs: error-guide entry for `DAILY_LIMIT_REACHED` (402) on purchase endpoints and one changelog entry, both behind a
  registry flag so they appear only once caps are switched on.

## 7. Fraud warnings

Cron every 5 minutes (`/api/cron/api-v2-risk`, CRON_SECRET, scheduled on cron-job.org like other non-money crons). Live
keys only; does nothing while `alerts_enabled` is false. Signals (defaults are operational thresholds the owner can edit
on the Overview card; they are not prices):

| Signal | Default trigger | Dedup |
|---|---|---|
| `spend_spike` | today's spend > 3x the trailing 7-day daily average and > GHS 200 | 1 per person per day |
| `new_key_big_spend` | a key under 24 h old has spent > GHS 100 | 1 per key per day |
| `recipient_fanout` | > 30 distinct recipients in 10 min (data + airtime) | 1 per person per hour |
| `cap_hits` | >= 3 `daily_limit` refusals in 1 h | 1 per person per hour |
| `failure_burst` | >= 20 purchases in 15 min with > 50% failed | 1 per person per hour |

Each alert: insert into `api_v2_risk_alerts` (UNIQUE dedup), then notify admins through `lib/admin-actions` (WhatsApp
and email) with the developer's name, the signal, the numbers and the link `/admin/api-keys?tab=developers&dev=<id>`.
No phone numbers or keys in the message. One pass reads only the last 24 h (8 days for the spike baseline, aggregated in
SQL).

## 8. Abuse cases (fraud first)
1. A leaked key bursts 50 parallel purchases → the per-user advisory lock serialises reserves; at most the cap is spent.
2. A thief raises the developer cap with the stolen key → impossible: caps are set from the dashboard session, never with
   an API key; the admin cap still binds.
3. A developer probes the admin cap value → never returned to them.
4. IDOR on `/v2-keys/[id]/spend-cap` → ownership checked in SQL and in the route; 404 for someone else's key.
5. Replay of a completed reference → the replay path returns before the reserve; no double count.
6. Reserve succeeds, engine charges, settle fails → the row stays `reserved` (counted), the safe side. A daily sweep marks
   reserved rows whose claim or order completed as `spent` (housekeeping only; it never releases).
7. Caps off → no reserve call at all (one cached settings read per 10 s per instance).
8. Alert spam → UNIQUE dedup buckets; one notification per inserted alert.

## 9. Rollout
Migration 0198 first (dry run, apply, verify), then code (switches off, so no behaviour change), then the owner's
supervised real-money check: a GHS 5 cap on a probe live key, buy until refused, confirm the 402 and no charge; turn alerts
on and confirm one alert for a forced `cap_hits`. Then the owner decides when to switch caps on.

## 10. Left to the builder (my calls, correctable)
- Layout details in the dashboard and console (R4 styles: navy accent, `lg:` multi-column, works at 500 px).
- The bulk reference hash, and how a partly charged bulk settles (the actually charged total).
- Cron registration (cron-job.org sync script).
- SMS credit cap: a follow-up release.
