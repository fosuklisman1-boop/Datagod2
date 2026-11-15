# Text-to-Buy Missed-Call Support SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A missed call to the main or shop number sends the caller one SMS pointing to help (main: WhatsApp support line; shop: the caller's shop owner, else the support line), shipped dark; plus a support pointer in the shop line's "not understood" reply.

**Architecture:** A new webhook `/api/webhooks/call-forward` shares the forwarder-secret line mapping with the SMS webhook. A pure decision module under `lib/text-to-buy/call/` uses injected deps (support number reader, shop resolution, shop payer via `sendReply`, daily marker via `ttb_notice_once`, hourly cap via a new `ttb_calls` table). One small additive migration.

**Tech Stack:** Next.js 15, TypeScript, Supabase (service role), Vitest with the fake-db helpers in `lib/text-to-buy`, Hubtel SMS via `sendReply`.

**Spec:** `docs/superpowers/specs/2026-11-15-text-to-buy-missed-call-support-design.md` (read first; section 4.7 holds the rulings). Parents: `2026-11-14-text-to-buy-stage3a-design.md`, `2026-11-13-sms-text-to-buy-design.md`.

## Global Constraints

- Run vitest from a shell whose cwd is spelled with an UPPERCASE drive letter (`C:/Users/...`) or PowerShell; a lowercase `c:/` cwd breaks `vi.mock` path matching.
- Main-line behaviour is byte-identical: lane golden main scenarios and main-line wording unchanged; adding `ttb_calls_*` to `TtbSettings` may only ADD default lines to snapshots that serialise the settings object (as the shop line did).
- The line comes only from the forwarder secret, never from the body. A call webhook never reaches the Send & Claim (MoMo) ingest and has no MoMo parsing.
- At most one SMS per caller per line per day (`ttb_notice_once`, kinds `call_main` / `call_shop`, shop id null), plus an hourly per-line cap; every reply is one GSM-7 segment through `sendReply`, which never throws.
- Shop-paid SMS only through the existing shop payer in `sendReply` (account via `shopAccountFor`, cap via `shopReplyCapReached`); an unpaid result falls back once to the Datagod-paid support SMS; no other Datagod fallback.
- A missing support number means skip and one admin alert, never a blank or wrong number. No phone numbers or customer text in logs or admin payloads (counts only).
- No direct credit updates; credits move only through the existing SQL functions. Edit/Write tools only (no sed, no node/shell string replaces, no heredoc file writes). Never read `.env*`. Never push, merge or apply SQL: the controller runs the production protocol.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Migration number: next free at execution (0181 at planning time; main has 0179, text-to-buy shop line is 0180).

## Review Focus

1. A caller flooding calls or many spoofed numbers: daily marker plus hourly cap hold; excess is logged `skipped_*`, no SMS (Task 3, 4).
2. Shop-linked caller whose shop has no credits, no account, is closed or at its hourly cap: exactly one Datagod support SMS, never silence and never two (Task 3).
3. A call webhook with the wrong, missing, equal or empty secret, or a MoMo-shaped body: 401 or ignored, never an ingest (Task 4).
4. Reply wording exceeding one GSM-7 segment because of a long shop name or support link; missing support number (Task 3, 5).
5. Switch off or migration missing: the call route answers 200 and records nothing; main SMS lane unaffected (Task 4).

---

### Task 1: Call settings

**Files:**
- Modify: `lib/text-to-buy/settings.ts`, `lib/text-to-buy/admin-validate.ts`, `app/api/admin/text-to-buy/route.ts` (`CONFIRM_KEYS`)
- Test: `lib/text-to-buy/settings.test.ts`, `lib/text-to-buy/admin-validate.test.ts`, `app/api/admin/text-to-buy/route.test.ts`; lane golden snapshot (additions only)

**Interfaces:**
- Produces: `TtbSettings` gains `callsEnabled: boolean` (key `ttb_calls_enabled`, default false, loaded `=== true`) and `callsPerHourPerLine: number` (key `ttb_calls_per_hour_per_line`, default 60, int 5..500). `ttb_calls_enabled` PUT needs `confirm: true` like the other switches.

- [ ] **Step 1:** Failing tests: defaults, loader `=== true`, validator rejects non-bool and a cap of 4 or 501, PUT without `confirm: true` is refused.
- [ ] **Step 2:** Run `npx vitest run lib/text-to-buy/settings.test.ts lib/text-to-buy/admin-validate.test.ts app/api/admin/text-to-buy`; expect failures.
- [ ] **Step 3:** Implement fields, keys, defaults, loader, validation, `CONFIRM_KEYS`; regenerate only the added default lines in goldens.
- [ ] **Step 4:** Re-run those plus `lib/text-to-buy`; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): call settings`.

### Task 2: Migration 0181, call log table and store functions

**Files:**
- Create: `migrations/0181_text_to_buy_calls.sql`, `migrations/0181_text_to_buy_calls.selftest.sql`, `lib/text-to-buy/migration-0181.test.ts` (PGlite, pattern of `migration-0180.test.ts`)
- Modify: `lib/text-to-buy/store.ts`, `lib/text-to-buy/fake-db.test-helper.ts`
- Test: `lib/text-to-buy/store.test.ts` (or `store-calls.test.ts`)

**Interfaces:**
- Produces (SQL): table `ttb_calls(id uuid pk default gen_random_uuid(), line text not null check (line in ('main','shop')), sender text not null, shop_id uuid null, outcome text not null, created_at timestamptz not null default now())`; index on `(line, created_at)`; RLS on, no policies, no grants to anon/authenticated, service_role SELECT/INSERT only; `ttb_purge` replaced (same signature and grants as in 0180) to also delete `ttb_calls` older than the 30-day cut-off. Outcomes allowed by CHECK: `replied_main`, `replied_shop`, `replied_support`, `skipped_duplicate`, `skipped_cap`, `skipped_off`, `skipped_invalid`, `skipped_blocked`, `skipped_stale`, `error`. Safe to re-run; follows the 0180 pattern (BEGIN/COMMIT, selftest ends in `RAISE EXCEPTION 'SELFTEST_OK ...'`, run string built by code with asserts).
- Produces (TypeScript, all taking `db` first): `logCall(db, { line, sender, shopId, outcome })`, `repliedCallsLastHour(db, line): Promise<number>` (counts rows whose outcome starts with `replied_`), `callCountsToday(db): Promise<Record<Line, { replied: number; skipped: number }>>` (counts only, no senders).

- [ ] **Step 1:** Write the PGlite test, selftest and store tests first: table and CHECK, RLS on with zero policies, anon/authenticated denied, purge deletes old rows only, `repliedCallsLastHour` counts replied only and respects line and the hour, `callCountsToday` shape contains no sender values.
- [ ] **Step 2:** Run `npx vitest run lib/text-to-buy/migration-0181.test.ts lib/text-to-buy/store.test.ts`; expect failures.
- [ ] **Step 3:** Write the migration (read 0180's `ttb_purge` first and keep every existing behaviour), the store functions, and the fake-db mirror.
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): ttb_calls migration and store (dark, unapplied)`. Applying is the controller's protocol step.

### Task 3: Call decision module and reply copy

**Files:**
- Create: `lib/text-to-buy/call/decide.ts`, `lib/text-to-buy/call/replies.ts`, `lib/text-to-buy/call/support.ts`, `lib/text-to-buy/call/default-deps.ts`
- Test: `lib/text-to-buy/call/decide.test.ts`, `replies.test.ts`, `support.test.ts`

**Interfaces:**
- Produces: `readSupportWhatsapp(db): Promise<string | null>` in `support.ts` (reads `support_settings.support_whatsapp`, digits only, null when empty or unreadable). `callSupportReply(waDigits: string): string` and `callShopReply(shopName: string, ownerNumber: string): string` in `replies.ts`, each one GSM-7 segment (shop name truncated with the existing `gsm7`/segment helpers from `lib/text-to-buy/replies.ts`; support link `https://wa.me/<digits>`). `export async function handleMissedCall(deps: CallDeps, input: { line: Line; fromRaw: string; receivedMs: number | null; nowMs: number }): Promise<{ outcome: CallOutcome }>` where `CallDeps` injects: settings, `normalizeSender`, `isBlocked`, `noticeOnce`, `repliedCallsLastHour`, `getShopPref`, `lastBoughtShopCodeId`, `shopCodeById`/`resolveShopCode` (as in `shop/default-deps.ts`), `shopAccountFor`, `shopReplyCapReached`, `sendReply`, `readSupportWhatsapp`, `logCall`, `alertAdmin`.
- Behaviour (spec 4.3, in this order): switch off -> `skipped_off`; invalid caller (not a Ghana mobile) -> `skipped_invalid`; stale (`nowMs - receivedMs > 15 min`; null `receivedMs` uses `nowMs`) -> `skipped_stale`; blocked -> `skipped_blocked`; daily marker `noticeOnce(kind, sender, null, day)` false -> `skipped_duplicate`; hourly cap reached -> `skipped_cap`; support number missing -> skip with one `alertAdmin` and outcome `error`. Main line: Datagod support SMS (`replied_main`). Shop line: resolve the caller's shop (pref, else last bought, verified `active`); linked and not at the shop hourly cap -> shop-owner SMS through the shop payer (`replied_shop`, shop id logged); unpaid, no account, closed, not linked or at cap -> Datagod support SMS once (`replied_support`). A thrown or `sent:false` send logs `error` and does not retry. Every path calls `logCall`.

- [ ] **Step 1:** Failing tests for each ordering rule and outcome above, including: main never touches shop deps; shop-linked caller with credits sends the shop-owner copy with `payer: shop`; unpaid result then exactly one support SMS and one marker; closed shop falls to support; caller at daily marker sends nothing; both caps; support missing alerts once; reply copy is one GSM-7 segment for a 60-character accented shop name; no phone number or text appears in any `alertAdmin` argument or console output.
- [ ] **Step 2:** Run the three test files; expect failures.
- [ ] **Step 3:** Implement with injected deps only; `default-deps.ts` wires the real clients lazily (copy the pattern of `shop/default-deps.ts`).
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy`; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): missed-call decision and replies`.

### Task 4: Call webhook route

**Files:**
- Create: `app/api/webhooks/call-forward/route.ts`
- Modify: `lib/text-to-buy/forward-secrets.ts` (extract a shared `resolveForwardLine(env, header)` returning `"main" | "shop" | null`, used by the call route; the SMS route keeps its exact behaviour and tests)
- Test: `app/api/webhooks/call-forward/route.test.ts`, `lib/text-to-buy/forward-secrets.test.ts`

**Interfaces:**
- `POST /api/webhooks/call-forward`: header `x-sms-forward-secret` (timing-safe, same comparisons as SMS); form or JSON body fields `from` and `received` (parsed with the existing `parseReceived`); wrong or missing secret -> 401; valid -> `touchHeartbeat(db, line)`, then `handleMissedCall` with real deps, always answering 200 after the secret check; errors are caught and logged without numbers. Only exports handlers (Next rule). Primary secret = main line, shop secret = shop line, an equal or unset shop secret follows the existing rules; there is no MoMo ingest on this route.

- [ ] **Step 1:** Failing route tests: 401 for wrong, empty and missing secret; shop secret -> line shop and heartbeat shop; primary secret -> line main; MoMo-shaped body never calls any ingest (assert the ingest mock is never imported or called); switch off answers 200 and records nothing; body fields missing answers 200; handler throws are swallowed (200); SMS route tests unchanged and green.
- [ ] **Step 2:** Run `npx vitest run app/api/webhooks lib/text-to-buy/forward-secrets.test.ts`; expect failures.
- [ ] **Step 3:** Implement the shared helper and the route.
- [ ] **Step 4:** Run `npx vitest run app/api/webhooks lib/text-to-buy`; expect pass; lane golden unchanged.
- [ ] **Step 5:** Commit `feat(text-to-buy): call-forward webhook`.

### Task 5: Support pointer in shop-line "not understood" replies

**Files:**
- Modify: `lib/text-to-buy/replies.ts` (new `notUnderstoodShopReply(waDigits | null)`), the shop lane wiring in `lib/text-to-buy/shop/lane.ts` / `handle-inbound.ts` where the shop-line not-understood reply is chosen, `lib/text-to-buy/call/support.ts` (reuse `readSupportWhatsapp`)
- Test: `lib/text-to-buy/replies.test.ts`, `lib/text-to-buy/handle-inbound.shop.test.ts`; lane golden (shop scenarios may change, main scenarios must not)

**Interfaces:** On the shop line only, the existing not-understood reply gains `For help WhatsApp: https://wa.me/<digits>` when the whole reply still fits one GSM-7 segment; otherwise (or when the support number is unavailable) the current wording is kept. Main-line wording is untouched.

- [ ] **Step 1:** Failing tests: shop-line not-understood includes the link and is one segment; falls back to the old text when it would not fit or no support number; main line reply is byte-identical.
- [ ] **Step 2:** Run those test files; expect failures.
- [ ] **Step 3:** Implement; read the support number once per message (injected dep, never throws).
- [ ] **Step 4:** Run `npx vitest run lib/text-to-buy lib/ussd app/api/admin/text-to-buy app/api/webhooks`; expect pass; main golden scenarios unchanged.
- [ ] **Step 5:** Commit `feat(text-to-buy): support pointer in shop-line not-understood replies`.

### Task 6: Admin (Overview and Settings)

**Files:**
- Modify: `lib/text-to-buy/admin-view.ts`, `app/api/admin/text-to-buy/route.ts`, `app/admin/text-to-buy/_components/{api.ts,SettingsTab.tsx,OverviewTab.tsx}`
- Test: `lib/text-to-buy/admin-view.test.ts`, `app/api/admin/text-to-buy/route.test.ts`

**Interfaces:** Overview payload gains `calls: { enabled: boolean; today: Record<Line, { replied: number; skipped: number }> }` from `callCountsToday` (counts only; degrade to zeros if the query throws, as the service counts do). Settings tab gets the call switch (confirm dialog, `confirm: true`) and the hourly cap field. Overview shows "Missed calls today" per line and a one-line note that the shop number is also the public support phone. Existing admin auth, layout conventions, `lg:` widening and 500px/1280px behaviour unchanged.

- [ ] **Step 1:** Failing tests: payload shape contains no sender values; zeros on query failure; PUT of `callsEnabled` without confirm refused; cap validation.
- [ ] **Step 2:** Run the two test files; expect failures.
- [ ] **Step 3:** Implement API and UI.
- [ ] **Step 4:** Run `npx vitest run app/api/admin/text-to-buy lib/text-to-buy`; expect pass.
- [ ] **Step 5:** Commit `feat(text-to-buy): admin missed-call card and settings`.

### Task 7: Runbook, verification

**Files:** Modify `docs/text-to-buy/runbook.md` (new section "14. Missed-call support SMS (OWNER runbook)").

- [ ] **Step 1:** Write section 14 in plain words: what it does and does not do; deploy order (apply migration 0181 BEFORE the code); the phone steps (unlock the phone, Settings -> Forward Calls Log on with Missed only, grant the call-log permission, two call senders cloned from the text senders with the URL `/api/webhooks/call-forward` and the matching secrets, params with the call-template tags confirmed on the phone, two call rules on SIM-1 and SIM-2, the SIM SubId Refresh check); the supervised test (call the shop number from a shop-linked number, an unlinked number, and the main number; confirm each SMS and the admin counts); switch-on and rollback (switch off; the migration is additive and stays); caps and abuse notes; the shared support-phone note.
- [ ] **Step 2:** Run `npx vitest run lib/text-to-buy lib/ussd lib/ussd-shop lib/shop-commerce lib/whatsapp-bot lib/payments app/api/admin app/api/cron app/api/webhooks`, `npx tsc --noEmit` (baseline only: `lib/leaderboard/delivery.test.ts`, `app/api/admin/broadcast/route.shop-buyers.test.ts`), and report exact numbers. Do not run `git checkout` on `lib/ussd/bots/__snapshots__/uzo-golden.test.ts.snap`; report if a run modifies it.
- [ ] **Step 3:** Commit `docs(text-to-buy): missed-call runbook`.

### Task 8: Production protocol (controller only)

Gated on the final opus review and the owner's explicit OK at each step: precheck (table absent), run the selftest as a self-rolling-back dry run, owner OK, apply 0181 (before any code deploy), verify, merge latest `origin/main`, real `next build` with placeholder env, push, watch the deploy, live check (`/api/webhooks/call-forward` answers 401 for a bad secret and 200 for a good one with the switch off). Ships dark: `ttb_calls_enabled` stays off. Phone steps need the owner to unlock the phone.
