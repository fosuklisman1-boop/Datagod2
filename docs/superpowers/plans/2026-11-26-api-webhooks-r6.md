# API Webhooks (Release 6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Signed, retried, logged webhooks for live API v2 orders, with a Send-test button, shipped dark.

**Architecture:** A once-a-minute SQL scan (migration 0200) turns final-status changes of live v2 orders into queued
events; a cron route claims due events and POSTs them through an SSRF-guarded, address-pinned HTTPS sender with an
HMAC signature. Developer dashboard tab and admin switch sit on top of SECURITY DEFINER functions.

**Tech Stack:** Next.js 15 route handlers, Supabase plpgsql, node:https / node:dns / node:crypto, Vitest + PGlite.

**Spec:** docs/superpowers/specs/2026-11-26-api-webhooks-r6-design.md

## Global Constraints

- Migration 0200: one transaction, `lock_timeout 2s`, `statement_timeout 15s`, new objects only, no ALTER of existing
  tables, no FK to existing tables, every function SECURITY DEFINER + `SET search_path = public, pg_temp`, revoked from
  PUBLIC/anon/authenticated, granted to service_role. Settings row starts `enabled = false`.
- Retry schedule after failed attempt n: 1 min, 5 min, 30 min, 2 h, 8 h, 24 h; max 7 attempts; test events 1 attempt.
- Final statuses: completed, failed, refunded. Window: 7 days and not before endpoint.created_at.
- Signature: `t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`. Secret `whsec_` + 32 bytes base64url.
- Sender: https only, port 443, 10 s timeout, no redirects, pinned vetted address, body snippet ≤ 200 chars.
- Developer routes: `getSessionUser` + `requireCapability(…, "account.api")` + rate limits from the spec; registered
  in `lib/roles/capability-routes.ts`. Admin route: verifyAdminAccess, real admin id for writes.
- Edit/Write only, no sed. No `git stash`.

## Review Focus

- A DNS name that resolves to both a public and a private address must be refused (any private → refuse).
- IPv4-mapped IPv6 (`::ffff:10.0.0.1`) and NAT64 (`64:ff9b::a00:1`) of private ranges must be refused.
- Two overlapping cron runs must not create duplicate events (advisory lock) or double-send (SKIP LOCKED lease).
- A late record from an expired lease must not overwrite a newer attempt's outcome (attempt-number guard).
- Switch off ⇒ scan creates nothing and claim returns nothing, even with enabled endpoints and due events.

---

### Task 1: Migration 0200 (GATE: fresh reviewer)

**Files:** Create `migrations/0200_api_webhooks.sql`, `migrations/0200_api_webhooks.selftest.sql`,
`lib/api-v2/migration-0200-run.ts`, `lib/api-v2/migration-0200.test.ts`.

**Produces (SQL):**
- `api_v2_webhook_get(uuid) → jsonb` {enabled_globally, endpoint: {url, enabled, created_at, updated_at, secret_hint} | null}
- `api_v2_webhook_set_endpoint(uuid, text url, boolean enabled, text new_secret) → jsonb` (secret used only on insert)
- `api_v2_webhook_rotate_secret(uuid, text) → jsonb`, `api_v2_webhook_reveal(uuid) → text`, `api_v2_webhook_delete_endpoint(uuid) → jsonb`
- `api_v2_webhook_scan(timestamptz, int) → int`
- `api_v2_webhook_claim(timestamptz, int) → jsonb` array of {id, user_id, type, payload, attempt, url, secret}
- `api_v2_webhook_claim_one(uuid, text, timestamptz) → jsonb | null`
- `api_v2_webhook_record(text, int, boolean, int, int, text, text, timestamptz) → jsonb`
- `api_v2_webhook_enqueue_test(uuid, timestamptz) → jsonb` {id} or {error}
- `api_v2_webhook_resend(uuid, text, timestamptz) → jsonb`
- `api_v2_webhook_deliveries(uuid, timestamptz, text, int) → jsonb`
- `api_v2_webhook_settings_get(timestamptz) → jsonb`, `api_v2_webhook_settings_set(boolean, uuid) → jsonb`
- `api_v2_webhook_retention(timestamptz) → jsonb`

Tests: privileges; switch off → scan 0 / claim []; scan emits once per final change, not for pending/processing,
not for orders older than the endpoint or 7 days; commission status read live; claim lease + per-user cap 10; record
schedule and max attempts; stale attempt ignored; test event single attempt; resend; delete endpoint fails pending
events; retention.

### Task 2: Signing, URL guard, sender, worker, cron (GATE: security reviewer)

**Files:** Create `lib/api-v2/webhooks/{sign.ts,url-guard.ts,send.ts,worker.ts}` with tests;
`app/api/cron/api-v2-webhooks/route.ts`; modify `lib/cron-migration/crons.json`, `jobs.ts` and pinned count tests.

**Produces:** `signPayload(secret, body, t) → string`, `newSecret() → string`, `checkUrlSyntax(url) → {ok, host} | {ok:false, error}`,
`isBlockedAddress(ip) → boolean`, `resolveSafe(host, lookup) → {ok, address, family} | {ok:false, error}`,
`sendWebhook(job, deps) → {ok, code, durationMs, error, snippet}`, `runWebhookCycle(client, deps) → {scanned, sent, delivered, failed}`.

### Task 3: Developer routes

**Files:** `lib/api-v2/webhooks/dev.ts` (+ test); `app/api/user/v2-dashboard/webhook/{route.ts,secret/route.ts,test/route.ts,deliveries/route.ts,deliveries/[id]/resend/route.ts}`;
`lib/roles/capability-routes.ts`.

### Task 4: Dashboard Webhooks tab

**Files:** `components/developer/dashboard/WebhooksTab.tsx`, `lib/api-v2/dev-dashboard-view.ts` (`DASH_TABS` adds
`webhooks`), `app/dashboard/developer/page.tsx`, UI test.

### Task 5: Admin switch

**Files:** `lib/api-v2/admin-console/webhooks.ts` (+ test), `app/api/admin/api-v2/webhook-settings/route.ts`,
`components/admin/api-keys/WebhooksCard.tsx`, Overview tab wiring, capability registry.

### Task 6: Docs behind `WEBHOOKS_PUBLISHED`

**Files:** `lib/api-v2/docs/flags.ts`, `lib/api-v2/docs/registry.ts` (no-webhooks sentences switch on the flag; a
Webhooks section appears only when true), docs tests.

### Task 7: Final

Opus whole-branch review → fix pass → placeholder `next build` → suite → 0200 precheck, dry run, apply, verify →
fetch + push main → watch deploy → 401/202 live checks → cron-job.org sync + enable → memory → channel post (Hold).
