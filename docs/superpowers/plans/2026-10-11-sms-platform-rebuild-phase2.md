# SMS Platform Rebuild — Phase 2 (Admin Console) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `/admin/sms` with one "SMS Platform" admin page (master switch, status banner, 6 stat cards, 7 tabs) on top of the Phase 1 backend, and make the master switch a real kill switch.

**Architecture:** A thin Next.js page shell with one component per tab; all data/logic in tested `lib/sms/admin-*.ts` services backed by a few SQL functions (exact sums/search/paging past PostgREST's row cap); routes are thin wrappers using one shared admin guard. UI logic that matters (formatting, masking, status tones, filtering) lives in pure `_lib/view.ts` helpers because the repo has no DOM test environment.

**Tech Stack:** Next.js 15 App Router, React 19, shadcn/ui (`components/ui/*`), Tailwind with the navy/clay utilities, Supabase (service-role client + SQL functions), Vitest (node env), sonner toasts.

**Spec:** `docs/superpowers/specs/2026-10-11-sms-platform-rebuild-phase2-design.md` (commits 96e26bf0, bee137cc). Phase 1 plan/spec in the same folders; Phase 1 is live.

---

## Scope notes (read first)

- **Kill switch = the only newly enforced rule** (user decision P2-1). Caps/keywords/flags/holds stay record-only (`sms_policy_enforced=false`, not writable from the UI).
- **No revenue backfill.** Investigation (2026-10-11): the 18 Paystack SMS purchases left no row in `payment_attempts` / `wallet_payments` / `transactions`, and the 37 wallet quantity purchases used a per-credit price with no history, so earlier amounts cannot be derived exactly. The card shows **Recorded revenue** plus a note "N earlier purchases (X credits) have no recorded amount" (56 purchases / 7,111 credits at time of writing). Never estimate.
- **Approve for tenant sender IDs is refused until Hubtel is the active provider** (Phase 1 final-review decision). The Sender IDs tab must show that, not just fail.
- Hubtel is **not yet primary** in production. The Supply strip must therefore handle both providers and explain a 0.
- `getWholesaleCredits()` (money-critical, Phase 1) stays **unchanged**; the admin view gets a separate read-only `getWholesaleSnapshot()` (no alerts, never throws) that reuses its helpers.
- Existing admin APIs are reused where they exist; new API routes live under `app/api/admin/sms-platform/`.

## Conventions

- Work in the worktree `C:\Users\User2\.gemini\antigravity-ide\scratch\Datagod2\.claude\worktrees\customer-ui-rebuild` (branch `worktree-customer-ui-rebuild`). Never `cd` elsewhere for git; never bare `git stash`.
- Tests: `npx vitest run <file>`; full: `npm run test:run`. Baseline: **9 known failures in `lib/order-health-service.test.ts`**; anything else failing is yours. Vitest includes `lib/**/*.test.ts` and `app/**/*.test.ts` (node env, no DOM). Modules that create a Supabase client at import time are fine (placeholder env from `vitest.setup.ts`), but mock `@supabase/supabase-js` with a chainable fake when the test needs query behaviour.
- Types: `npx tsc --noEmit`. Build: `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run build` (must reach exit 0 before anything goes to main — `tsc` + vitest do not catch Next route-export violations).
- Route files export **only** HTTP method handlers and Next config consts (`maxDuration`, `dynamic`, …). Next 15 dynamic params are a Promise: `{ params }: { params: Promise<{ id: string }> }`.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Live SQL (**controller only**): `node "C:/Users/User2/AppData/Local/Temp/claude/C--Users-User2--gemini-antigravity-ide-scratch-Datagod2--claude-worktrees-customer-ui-rebuild/721cad5d-5d11-431b-b656-61cc2ba3d10b/scratchpad/sq.js" "<SQL>" ["<SQL>" …]` (Supabase Management API, superuser). Never select PII values; use `count(*)`/aggregates.
- **Never log into the application.** Subagents never touch the live DB or external APIs.
- Admin routes: `verifyAdminAccess` accepts the `CRON_SECRET` bearer **without** a `userId`. Every admin route here goes through `adminGuard` (Task 3): reads need an admin; **writes need a real `userId`** and write an `admin_audit_log` row via `writeAuditLog(adminId, action, targetUserId, oldValue, newValue)` from `lib/sms/moderation-service.ts`.
- UI: use `DashboardLayout`, `PageHeaderBanner`, shadcn `Tabs/Card/Badge/Button/Dialog/AlertDialog/Table/Input/Textarea/Select/Switch/Checkbox/Skeleton`, `toast` from `sonner`, `lucide-react` icons. Badge variants: `default|secondary|destructive|outline`; Button variants: `default|destructive|outline|secondary|ghost|link`, sizes `default|sm|lg|icon|icon-sm`. Clay utilities (`.clay`, `.clay-sm`, `.clay-inset`, `.clay-surface`) exist in `app/globals.css`; `--primary` is navy. Pages must widen on desktop (`lg:` container + multi-column) from the start; tables become stacked cards on mobile.
- Fetch pattern: `api<T>(path, init?)` from `app/admin/sms-centre/_lib/api.ts` (attaches the Supabase bearer, resolves to `{success, data?, error?}`); Task 7 re-exports it for the new page.

## File structure

**Create**
| File | Responsibility |
|---|---|
| `migrations/20261011_sms_admin_console.sql` | `sms_admin_overview`, `sms_policy_preview`, `sms_admin_messages`, `sms_admin_accounts`, `sms_admin_flags` SQL functions |
| `lib/sms/kill-switch.ts` (+test) | `isSmsEnabled()`, `SMS_DISABLED_MESSAGE` |
| `lib/sms/admin-guard.ts` (+test) | One guard for admin routes (read vs write) |
| `lib/sms/admin-overview.ts` (+test) | `composeOverview` (pure) + `getOverview()` |
| `lib/sms/admin-lists.ts` (+test) | Messages / accounts / flags listing + flag actions |
| `lib/sms/admin-reviews.ts` (+test) | Business-review and sender-ID lists enriched with account user/mode |
| `lib/sms/admin-actions.ts` (+test) | Audited admin credit allocation |
| `lib/sms/admin-settings.ts` (+test) | Section-wise validate + save of SMS settings, audit, cache invalidation |
| `app/api/admin/sms-platform/{overview,messages,accounts,flags,flags/[id],sender-ids,settings}/route.ts` | Thin routes (`accounts/[id]` and `sender-ids/[id]` already exist from Phase 1) |
| `app/admin/sms/_lib/{api,view,useLoad}.ts` (+`view.test.ts`) | Typed fetch helpers, pure view helpers, load hook |
| `app/admin/sms/_components/ui-bits.tsx` | StatusBadge, CopyButton, Pager, ConfirmDialog, ChipsInput, empty/error/loading |
| `app/admin/sms/_components/{StatCards,SupplyStrip,StatusBanner}.tsx` | Header pieces |
| `app/admin/sms/_components/{BusinessReviews,SenderIds,Flagged,Messages,Accounts,Bundles,Settings}Tab.tsx` + `SettingsSections.tsx` | The 7 tabs |
| `app/admin/sms/_components/SmsPlatformPage.tsx` | Page body (switch, banner, cards, tabs, `?tab=`) |

**Modify**
| File | Change |
|---|---|
| `lib/sms/send-service.ts`, `bundle-service.ts`, `activation-service.ts` (+ tests) | `SMS_DISABLED` kill switch; guarded `deleteBundle` |
| `lib/sms/wholesale.ts` (+test) | export `queuedUnsentUnits`; add `getWholesaleSnapshot` + pure `composeHubtelSnapshot` |
| `lib/sms/platform-settings.ts` | export `normalizeDomain` |
| `app/api/sms/units/{purchase,purchase-wallet,purchase-paystack}/route.ts`, `app/api/sms/{activate,claim-bonus}/route.ts`, `app/api/shop/sms/send/route.ts`, `app/api/v1/sms/send/route.ts`, `app/dashboard/sms/page.tsx` | Map/handle `SMS_DISABLED` |
| `app/api/admin/sms/bundles/route.ts` | `DELETE` (guarded) |
| `app/api/admin/sms/allocate/route.ts` | Real-admin guard + audit |
| `app/api/admin/sms-platform/business-reviews/route.ts` | List with account info |
| `app/admin/sms/page.tsx` | Replaced by the new shell |

**Task list:** 1 SQL functions (controller) · 2 kill switch · 3 guard + supply snapshot + overview · 4 lists + flag actions · 5 settings service · 6 bundle delete · 7 review lists + allocation · 8 UI foundation · 9–15 the seven tabs (Business Reviews, Sender IDs, Flagged, Messages, Accounts, Bundles, Settings) · 16 page assembly · 17 verification + ship (controller).

---

### Task 1: SQL functions (controller-run, live)

**Files:**
- Create: `migrations/20261011_sms_admin_console.sql`

All five functions are `STABLE SECURITY DEFINER`, `search_path = public`, locked to `service_role` (the Phase 1 pattern). They exist because PostgREST caps responses at 1000 rows and times out at 8 s: sums/search/paging must be exact and server-side.

- [ ] **Step 1: Write the migration**

```sql
-- SMS admin console (Phase 2): exact overview numbers + searchable, paged lists.
BEGIN;

CREATE OR REPLACE FUNCTION sms_admin_overview()
RETURNS TABLE(
  revenue_bundles_ghs NUMERIC, revenue_activations_ghs NUMERIC,
  credits_sold BIGINT, purchases BIGINT,
  unrecorded_purchases BIGINT, unrecorded_credits BIGINT,
  pending_reviews BIGINT, pending_senders BIGINT,
  fraud_flags BIGINT, info_flags BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH b AS (
    SELECT COALESCE(sum(amount_ghs), 0)                                           AS rev,
           COALESCE(sum(delta), 0)::bigint                                        AS credits,
           count(*)::bigint                                                       AS n,
           count(*) FILTER (WHERE amount_ghs IS NULL)::bigint                     AS unrec_n,
           COALESCE(sum(delta) FILTER (WHERE amount_ghs IS NULL), 0)::bigint      AS unrec_credits
    FROM sms_unit_transactions
    WHERE reason IN ('bundle_wallet', 'bundle_paystack') AND delta > 0
  )
  SELECT
    b.rev,
    (SELECT COALESCE(sum(amount_paid), 0) FROM sms_accounts WHERE amount_paid > 0),
    b.credits, b.n, b.unrec_n, b.unrec_credits,
    (SELECT count(*) FROM sms_business_profiles WHERE status = 'submitted'),
    (SELECT count(*) FROM sms_sender_ids WHERE local_status = 'pending' AND sms_account_id IS NOT NULL),
    (SELECT count(*) FROM sms_flags WHERE severity = 'fraud' AND status = 'open')
      + (SELECT count(*) FROM sms_send_logs WHERE flagged AND status = 'blocked'),
    (SELECT count(*) FROM sms_flags WHERE severity = 'info' AND status = 'open')
      + (SELECT count(*) FROM sms_send_logs WHERE flagged AND status <> 'blocked')
  FROM b;
$$;

-- What the new (record-only) policy WOULD have done recently, from sms_send_logs.policy_shadow.
CREATE OR REPLACE FUNCTION sms_policy_preview(p_days INT DEFAULT 7)
RETURNS TABLE(decision TEXT, code TEXT, n BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(policy_shadow->>'decision', 'error'),
         COALESCE(policy_shadow->>'code', 'ERROR'),
         count(*)::bigint
  FROM sms_send_logs
  WHERE policy_shadow IS NOT NULL
    AND created_at >= now() - make_interval(days => GREATEST(p_days, 1))
  GROUP BY 1, 2
  ORDER BY 3 DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_messages(p_q TEXT, p_status TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id BIGINT, sms_account_id UUID, user_id UUID, mode TEXT, sender_id TEXT, status TEXT,
  recipients_count INT, segments INT, credits_used INT, message TEXT, created_at TIMESTAMPTZ,
  tracked BIGINT, delivered BIGINT, failed BIGINT, pending BIGINT, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH page AS (
    SELECT l.id, l.sms_account_id, a.user_id, COALESCE(l.mode, a.mode) AS mode, l.sender_id, l.status,
           l.recipients_count, l.segments, l.credits_used, l.message, l.created_at,
           count(*) OVER () AS total_count
    FROM sms_send_logs l
    JOIN sms_accounts a ON a.id = l.sms_account_id
    WHERE (p_status IS NULL OR p_status = '' OR l.status = p_status)
      AND (p_q IS NULL OR p_q = ''
           OR strpos(lower(l.message), lower(p_q)) > 0
           OR strpos(lower(COALESCE(l.sender_id, '')), lower(p_q)) > 0
           OR strpos(lower(l.status), lower(p_q)) > 0
           OR (CASE WHEN p_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN a.user_id = p_q::uuid ELSE false END))
    ORDER BY l.created_at DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.sms_account_id, p.user_id, p.mode, p.sender_id, p.status,
         p.recipients_count, p.segments, p.credits_used, p.message, p.created_at,
         COALESCE(d.tracked, 0), COALESCE(d.delivered, 0), COALESCE(d.failed, 0), COALESCE(d.pending, 0),
         p.total_count
  FROM page p
  LEFT JOIN LATERAL (
    -- Only Hubtel messages carry delivery reports; Moolre rows stay 'pending' forever, so don't count them.
    SELECT count(*) AS tracked,
           count(*) FILTER (WHERE m.delivery_status = 'delivered') AS delivered,
           count(*) FILTER (WHERE m.delivery_status = 'failed')    AS failed,
           count(*) FILTER (WHERE m.delivery_status = 'pending')   AS pending
    FROM sms_messages m
    WHERE m.send_log_id = p.id AND m.provider = 'hubtel'
  ) d ON true
  ORDER BY p.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_accounts(p_q TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id UUID, user_id UUID, email TEXT, owner_type TEXT, mode TEXT, status TEXT, unit_balance INT,
  bought BIGINT, used BIGINT, default_sender TEXT, api_rate_limit_override INT, review_hold BOOLEAN,
  fraud_flag_count INT, created_at TIMESTAMPTZ, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH page AS (
    SELECT a.id, a.user_id, u.email, a.owner_type, a.mode, a.status, a.unit_balance,
           a.default_sender_id, a.api_rate_limit_override, a.review_hold, a.fraud_flag_count, a.created_at,
           count(*) OVER () AS total_count
    FROM sms_accounts a
    LEFT JOIN users u ON u.id = a.user_id
    WHERE p_q IS NULL OR p_q = ''
       OR strpos(lower(COALESCE(u.email, '')), lower(p_q)) > 0
       OR strpos(lower(a.mode), lower(p_q)) > 0
       OR strpos(lower(a.status), lower(p_q)) > 0
       OR strpos(lower(a.owner_type), lower(p_q)) > 0
       OR (CASE WHEN p_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN a.user_id = p_q::uuid ELSE false END)
       OR EXISTS (SELECT 1 FROM sms_sender_ids s
                  WHERE s.sms_account_id = a.id AND strpos(lower(s.sender_id), lower(p_q)) > 0)
    ORDER BY a.created_at DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT p.id, p.user_id, p.email, p.owner_type, p.mode, p.status, p.unit_balance,
         (SELECT COALESCE(sum(t.delta), 0) FROM sms_unit_transactions t
           WHERE t.sms_account_id = p.id AND t.delta > 0 AND t.reason <> 'campaign_refund')::bigint,
         (SELECT COALESCE(sum(l.credits_used), 0) FROM sms_send_logs l
           WHERE l.sms_account_id = p.id AND l.status <> 'blocked')::bigint,
         (SELECT s.sender_id FROM sms_sender_ids s WHERE s.id = p.default_sender_id),
         p.api_rate_limit_override, p.review_hold, p.fraud_flag_count, p.created_at, p.total_count
  FROM page p
  ORDER BY p.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION sms_admin_flags(p_severity TEXT, p_status TEXT, p_limit INT, p_offset INT)
RETURNS TABLE(
  id TEXT, source TEXT, sms_account_id UUID, user_id UUID, severity TEXT, reason TEXT, matched TEXT,
  status TEXT, message TEXT, created_at TIMESTAMPTZ, total_count BIGINT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH merged AS (
    SELECT f.id::text AS id, 'flag'::text AS source, f.sms_account_id, f.severity, f.reason, f.matched,
           f.status, l.message, f.created_at
    FROM sms_flags f
    LEFT JOIN sms_send_logs l ON l.id = f.send_log_id
    UNION ALL
    -- Legacy content-filter flags live on the send log itself (dismissing clears the flag).
    SELECT l.id::text, 'legacy', l.sms_account_id,
           CASE WHEN l.status = 'blocked' THEN 'fraud' ELSE 'info' END,
           COALESCE(l.flag_reason, 'flagged'), NULL::text, 'open', l.message, l.created_at
    FROM sms_send_logs l
    WHERE l.flagged
  ), filtered AS (
    SELECT m.*, a.user_id, count(*) OVER () AS total_count
    FROM merged m
    JOIN sms_accounts a ON a.id = m.sms_account_id
    WHERE (p_severity IS NULL OR p_severity = '' OR m.severity = p_severity)
      AND (p_status IS NULL OR p_status = '' OR m.status = p_status)
    ORDER BY m.created_at DESC
    LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0)
  )
  SELECT f.id, f.source, f.sms_account_id, f.user_id, f.severity, f.reason, f.matched, f.status,
         f.message, f.created_at, f.total_count
  FROM filtered f
  ORDER BY f.created_at DESC;
$$;

REVOKE ALL ON FUNCTION sms_admin_overview()                            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_overview()                        TO service_role;
REVOKE ALL ON FUNCTION sms_policy_preview(INT)                         FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_policy_preview(INT)                     TO service_role;
REVOKE ALL ON FUNCTION sms_admin_messages(TEXT, TEXT, INT, INT)        FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_messages(TEXT, TEXT, INT, INT)    TO service_role;
REVOKE ALL ON FUNCTION sms_admin_accounts(TEXT, INT, INT)              FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_accounts(TEXT, INT, INT)          TO service_role;
REVOKE ALL ON FUNCTION sms_admin_flags(TEXT, TEXT, INT, INT)           FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION sms_admin_flags(TEXT, TEXT, INT, INT)       TO service_role;

COMMIT;
```

- [ ] **Step 2: Apply live** — `node <sq.js> "$(cat migrations/20261011_sms_admin_console.sql)"`. Expected: HTTP 201 `[]`.

- [ ] **Step 3: Verify against independent queries** (each pair must agree)

```
node <sq.js> "select * from sms_admin_overview()" "select (select sum(delta) from sms_unit_transactions where reason in ('bundle_wallet','bundle_paystack') and delta>0) credits, (select count(*) from sms_unit_transactions where reason in ('bundle_wallet','bundle_paystack') and delta>0) purchases, (select count(*) from sms_sender_ids where local_status='pending' and sms_account_id is not null) pending_senders, (select coalesce(sum(amount_paid),0) from sms_accounts where amount_paid>0) activation_rev"
```
Expected on 2026-10-11 data: `credits_sold = 7111`, `purchases = 56`, `unrecorded_purchases = 56`, `unrecorded_credits = 7111` (until new recorded purchases happen), `revenue_activations_ghs = 71`, `pending_reviews = 0`, flags 0 — and the second query's numbers equal the function's.
```
node <sq.js> "select count(*) from sms_admin_messages(null, null, 25, 0)" "select total_count, status, sender_id, tracked from sms_admin_messages('', null, 3, 0)" "select total_count from sms_admin_messages('zzzz-no-match', null, 25, 0)" "select count(*) from sms_admin_messages(null, 'sent', 25, 0)" "select total_count, user_id, email, mode, bought, used, default_sender from sms_admin_accounts('', 3, 0)" "select count(*) from sms_admin_accounts('business', 25, 0)" "select * from sms_admin_flags(null, 'open', 25, 0)" "select * from sms_policy_preview(7)"
```
Expected: messages return ≤25 rows with `total_count` = 114 (or more) and an unmatched `q` returns 0 rows; accounts `total_count` = 242, `mode='business'` search returns 1; flags and preview return 0 rows today. Also run a UUID search: pick one `user_id` from the accounts result and confirm `sms_admin_accounts('<that uuid>', 25, 0)` returns exactly that account (the CASE guard means a non-UUID `q` never errors — confirm `sms_admin_accounts('not-a-uuid', 5, 0)` returns without error).

- [ ] **Step 4: Commit**

```bash
git add migrations/20261011_sms_admin_console.sql
git commit -m "feat(sms): Phase 2 admin console SQL functions (applied live)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Kill switch

**Files:**
- Create: `lib/sms/kill-switch.ts`, `lib/sms/kill-switch.test.ts`
- Modify: `lib/sms/send-service.ts`, `lib/sms/bundle-service.ts`, `lib/sms/activation-service.ts` (+ their tests); `app/api/sms/units/purchase/route.ts`, `app/api/sms/units/purchase-wallet/route.ts`, `app/api/sms/units/purchase-paystack/route.ts`, `app/api/sms/activate/route.ts`, `app/api/sms/claim-bonus/route.ts`, `app/api/shop/sms/send/route.ts`, `app/api/v1/sms/send/route.ts`, `app/dashboard/sms/page.tsx`

Blocked when the switch is off: `enqueueSend` (so dashboard, shop route and `/api/v1/sms/send`), wallet bundle purchase, quantity purchase (wallet and Paystack), Paystack bundle checkout, activation (wallet / Paystack / direct charge) and welcome-bonus claim. **Never blocked** (must stay working, and tests must prove it): `creditUnitsForPaystack` and `finalizeActivationPaystack` (webhooks for payments already made), `allocateUnits` (admin), the drain, refunds, DLR polling. Fail **open**: if settings cannot be loaded the switch counts as on.

- [ ] **Step 1: Failing test** `lib/sms/kill-switch.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ enabled: true, throws: false }))
vi.mock("./platform-settings", () => ({
  loadSmsSettings: () => (h.throws ? Promise.reject(new Error("db down")) : Promise.resolve({ featureEnabled: h.enabled })),
}))

import { isSmsEnabled, SMS_DISABLED_MESSAGE } from "./kill-switch"

beforeEach(() => { h.enabled = true; h.throws = false })

describe("isSmsEnabled", () => {
  it("is true when the setting is on", async () => expect(await isSmsEnabled()).toBe(true))
  it("is false when the setting is off", async () => { h.enabled = false; expect(await isSmsEnabled()).toBe(false) })
  it("fails OPEN when settings cannot be loaded", async () => { h.throws = true; expect(await isSmsEnabled()).toBe(true) })
  it("exposes the customer-facing message", () => expect(SMS_DISABLED_MESSAGE).toBe("SMS is temporarily unavailable. Please try again later."))
})
```

- [ ] **Step 2: Run — FAIL** (`npx vitest run lib/sms/kill-switch.test.ts`: module not found).

- [ ] **Step 3: Implement `lib/sms/kill-switch.ts`**

```ts
/**
 * SMS master switch (Phase 2, spec §6). The only newly ENFORCED admin control; all other
 * policy rules stay record-only until Phase 3. Settings are cached (60 s per instance) by
 * loadSmsSettings, so a flip reaches every instance within about a minute. Fails OPEN: a
 * database blip must never stop sending.
 */
import { loadSmsSettings } from "./platform-settings"

export const SMS_DISABLED_MESSAGE = "SMS is temporarily unavailable. Please try again later."

export async function isSmsEnabled(): Promise<boolean> {
  try {
    return (await loadSmsSettings()).featureEnabled
  } catch {
    return true
  }
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: `enqueueSend`.** In `lib/sms/send-service.ts` add `import { isSmsEnabled } from "./kill-switch"`, add `| "SMS_DISABLED"` to the `EnqueueSendError["error"]` union, and make the first statement of `enqueueSend` (before the recipient cap):

```ts
  // 0. Master switch (Phase 2): refuse new customer sends while the platform switch is off.
  if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }
```
In `lib/sms/send-service.test.ts` add `vi.mock("./kill-switch", () => ({ isSmsEnabled: () => Promise.resolve(h.state.smsEnabled) }))` with `smsEnabled: true` in the hoisted state (reset it in the existing `beforeEach`). Add tests: with `smsEnabled=false`, `enqueueSend(...)` returns `{ ok:false, error:"SMS_DISABLED" }`, **no** `debit_sms_for_send` RPC and no inserts happen; with it on, existing behaviour unchanged. Check `runSequentialBatches` / `enqueueSendBatched` pass a first-batch `SMS_DISABLED` through as `{ ok:false, error:"SMS_DISABLED" }` (read them; if they map unknown errors to something else, add `SMS_DISABLED` to the pass-through) and add a test.

- [ ] **Step 6: Routes for sends.**
  - `app/api/shop/sms/send/route.ts`: add before `case "INSUFFICIENT_CREDITS"` in the switch:
    ```ts
      case "SMS_DISABLED":
        return NextResponse.json(
          { success: false, error: result.error, message: SMS_DISABLED_MESSAGE },
          { status: 503 }
        )
    ```
    and `import { SMS_DISABLED_MESSAGE } from "@/lib/sms/kill-switch"`.
  - `app/api/v1/sms/send/route.ts`: in the status mapping add `result.error === "SMS_DISABLED" ? 503 :` as the first branch, and include `message: SMS_DISABLED_MESSAGE` in the JSON when that error occurs.
  - `app/dashboard/sms/page.tsx` (read around lines 485-520 and 740-765 where error codes are mapped to friendly text): add `SMS_DISABLED` → the `SMS_DISABLED_MESSAGE` text (inline the same string; do not import a server module into a client component).

- [ ] **Step 7: Purchases and activation (services).** Import `isSmsEnabled` and make this the **first** statement of each function:
  - `lib/sms/bundle-service.ts`: `purchaseBundleViaWallet` and `purchaseUnitsByQuantity` → `if (!(await isSmsEnabled())) return { ok: false, error: "SMS_DISABLED" }`. Leave `allocateUnits`, `creditUnitsForPaystack`, `issueUnits` untouched.
  - `lib/sms/activation-service.ts`: `activateViaWallet`, `initActivationPaystack`, `initActivationDirectCharge` → `return { ok: false, error: "SMS_DISABLED" }`; `claimWelcomeBonus` → `return { ok: false, error: "SMS_DISABLED" }`. Leave `finalizeActivationPaystack` untouched.
  - Tests (`bundle-service.test.ts`, `activation-service.test.ts`): mock `./kill-switch` the same way; for each blocked function assert `error: "SMS_DISABLED"` **and** no wallet debit / RPC / Paystack call; for each never-blocked function (`creditUnitsForPaystack`, `allocateUnits`, `finalizeActivationPaystack`) assert it still works with the switch off.

- [ ] **Step 8: Purchase/activation routes.** Each returns HTTP 503 with `{ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }` (import the constant from `@/lib/sms/kill-switch`):
  - `purchase-wallet`, `purchase` (qty): when `result.error === "SMS_DISABLED"` (wallet service result); for `purchase`'s Paystack/direct-charge branch and for **`purchase-paystack`** (which calls Paystack directly, not through a service) add at the top after auth: `if (!(await isSmsEnabled())) return NextResponse.json({ error: SMS_DISABLED_MESSAGE, code: "SMS_DISABLED" }, { status: 503 })`.
  - `activate`, `claim-bonus`: map `result.error === "SMS_DISABLED"` the same way (read the routes; `activate` currently maps `INSUFFICIENT_BALANCE`→402 else 400 — add the 503 case first).

- [ ] **Step 9: Run** `npx vitest run lib/sms app` and `npx tsc --noEmit` — PASS / clean.

- [ ] **Step 10: Commit** — `feat(sms): master switch is a real kill switch (sends, purchases, activation)` + trailer.

---

### Task 3: Admin guard + wholesale snapshot + overview service + route

**Files:**
- Create: `lib/sms/admin-guard.ts` (+test), `lib/sms/admin-overview.ts` (+test), `app/api/admin/sms-platform/overview/route.ts`
- Modify: `lib/sms/wholesale.ts` (+test)

- [ ] **Step 1: Failing tests** `lib/sms/admin-guard.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ auth: { isAdmin: true, userId: "admin-1" } as any }))
vi.mock("@/lib/admin-auth", () => ({
  verifyAdminAccess: () => Promise.resolve(h.auth),
}))

import { adminGuard } from "./admin-guard"

const req = () => new NextRequest("http://localhost/api/x")
beforeEach(() => { h.auth = { isAdmin: true, userId: "admin-1" } })

describe("adminGuard", () => {
  it("passes an admin read and returns the admin id", async () => {
    expect(await adminGuard(req())).toEqual({ ok: true, adminId: "admin-1" })
  })
  it("passes a cron-secret read (no userId) with adminId null", async () => {
    h.auth = { isAdmin: true }
    expect(await adminGuard(req())).toEqual({ ok: true, adminId: null })
  })
  it("refuses a write without a real admin user (403)", async () => {
    h.auth = { isAdmin: true }
    const r = await adminGuard(req(), { write: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(403)
  })
  it("allows a write with a real admin user", async () => {
    expect(await adminGuard(req(), { write: true })).toEqual({ ok: true, adminId: "admin-1" })
  })
  it("returns the auth error response for non-admins", async () => {
    const { NextResponse } = await import("next/server")
    h.auth = { isAdmin: false, errorResponse: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
    const r = await adminGuard(req())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.response.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `lib/sms/admin-guard.ts`**

```ts
/**
 * One guard for every Phase 2 admin route. verifyAdminAccess also accepts the CRON_SECRET bearer,
 * which carries no userId — fine for reads, never for writes (every write must be attributable).
 */
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"

export type AdminGuardResult =
  | { ok: true; adminId: string | null }
  | { ok: false; response: NextResponse }

export async function adminGuard(request: NextRequest, opts: { write?: boolean } = {}): Promise<AdminGuardResult> {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return { ok: false, response: auth.errorResponse! }
  const adminId = (auth as { userId?: string }).userId ?? null
  if (opts.write && !adminId) {
    return { ok: false, response: NextResponse.json({ success: false, error: "Admin user required" }, { status: 403 }) }
  }
  return { ok: true, adminId }
}
```
Run — PASS.

- [ ] **Step 4: Wholesale snapshot — failing tests** (append to `lib/sms/wholesale.test.ts`; it already mocks routing/relay/hubtel/settings/supabase — reuse the file's `h` hoisted state and mocks; add what the snapshot needs):

```ts
import { composeHubtelSnapshot, getWholesaleSnapshot } from "./wholesale"

describe("composeHubtelSnapshot (pure)", () => {
  it("backed = floor(balance/rate) − queued", () => {
    expect(composeHubtelSnapshot({ balance: { ok: true, amountGhs: 35 }, rate: 0.035, queued: 300 }))
      .toEqual({ provider: "hubtel", backedCredits: 700, balanceGhs: 35, ratePerSms: 0.035, queuedUnsent: 300 })
  })
  it("never negative", () => {
    expect(composeHubtelSnapshot({ balance: { ok: true, amountGhs: 1 }, rate: 0.035, queued: 500 }).backedCredits).toBe(0)
  })
  it("balance unreadable → 0 with the reason", () => {
    const s = composeHubtelSnapshot({ balance: { ok: false, error: "relay not configured" }, rate: 0.035, queued: 0 })
    expect(s).toMatchObject({ backedCredits: 0, balanceGhs: null, error: "Hubtel balance unavailable: relay not configured" })
  })
  it("queued backlog unknown → 0 with the reason", () => {
    const s = composeHubtelSnapshot({ balance: { ok: true, amountGhs: 35 }, rate: 0.035, queued: null })
    expect(s).toMatchObject({ backedCredits: 0, queuedUnsent: null, error: "Queued-message count unavailable" })
  })
})

describe("getWholesaleSnapshot", () => {
  it("moolre primary → moolre balance minus queued, provider moolre", async () => {
    h.primary = "moolre"; h.moolre = 900; h.backlog = 250
    expect(await getWholesaleSnapshot()).toMatchObject({ provider: "moolre", backedCredits: 650, balanceGhs: null, queuedUnsent: 250 })
  })
  it("never throws: a failing source yields backedCredits 0 and an error", async () => {
    h.primary = "moolre"; h.backlog = "boom" as any
    const s = await getWholesaleSnapshot()
    expect(s.backedCredits).toBe(0)
    expect(s.error).toBeTruthy()
  })
})
```
(Adapt the field names `h.primary`, `h.moolre`, `h.backlog` to the existing hoisted state in `wholesale.test.ts` — read that file first; do **not** change existing tests.)

- [ ] **Step 5: Implement in `lib/sms/wholesale.ts`.** Export the existing backlog helper (`export async function queuedUnsentUnits()` — it is currently module-private; do not change its body) and append:

```ts
export interface WholesaleSnapshot {
  provider: "hubtel" | "moolre"
  backedCredits: number
  /** Hubtel Disbursement balance in GH₵ (null for Moolre or when unreadable). */
  balanceGhs: number | null
  /** Per-SMS rate used for the Hubtel calculation. */
  ratePerSms: number | null
  /** Units already deducted from customers but not yet sent. */
  queuedUnsent: number | null
  error?: string
}

/** Pure: assemble the Hubtel snapshot from already-fetched inputs. */
export function composeHubtelSnapshot(i: {
  balance: { ok: true; amountGhs: number } | { ok: false; error: string }
  rate: number
  queued: number | null
}): WholesaleSnapshot {
  const base = { provider: "hubtel" as const, ratePerSms: i.rate }
  if (!i.balance.ok) {
    return { ...base, backedCredits: 0, balanceGhs: null, queuedUnsent: i.queued, error: `Hubtel balance unavailable: ${i.balance.error}` }
  }
  if (i.queued === null) {
    return { ...base, backedCredits: 0, balanceGhs: i.balance.amountGhs, queuedUnsent: null, error: "Queued-message count unavailable" }
  }
  return {
    ...base,
    balanceGhs: i.balance.amountGhs,
    queuedUnsent: i.queued,
    backedCredits: Math.max(0, backedCredits(i.balance.amountGhs, i.rate) - i.queued),
  }
}

/**
 * Read-only view of the supply the solvency gate sees, for the admin Supply strip. Mirrors
 * getWholesaleCredits() but sends no alerts and NEVER throws; failures come back as
 * { backedCredits: 0, error } so the UI can explain a 0. (getWholesaleCredits stays authoritative.)
 */
export async function getWholesaleSnapshot(): Promise<WholesaleSnapshot> {
  try {
    const routing = await getRoutingConfig()
    if (routing.primary === "hubtel" && hubtelConfigFromEnv()) {
      const settings = await loadSmsSettings()
      const [balance, observed, queued] = await Promise.all([
        fetchDisbursementBalance(),
        maxObservedHubtelRate().catch(() => undefined),
        queuedUnsentUnits().catch(() => null),
      ])
      if (observed === undefined) {
        return { provider: "hubtel", backedCredits: 0, balanceGhs: balance.ok ? balance.amountGhs : null, ratePerSms: null, queuedUnsent: queued, error: "Rate lookup failed" }
      }
      return composeHubtelSnapshot({ balance, rate: observed ?? settings.hubtelCostPerSms, queued })
    }
    const [moolre, queued] = await Promise.all([queryMoolreSmsBalance(), queuedUnsentUnits()])
    return { provider: "moolre", backedCredits: Math.max(0, moolre - queued), balanceGhs: null, ratePerSms: null, queuedUnsent: queued }
  } catch (e) {
    return { provider: "moolre", backedCredits: 0, balanceGhs: null, ratePerSms: null, queuedUnsent: null, error: e instanceof Error ? e.message : "Supply check failed" }
  }
}
```
Run `npx vitest run lib/sms/wholesale.test.ts` — PASS (existing tests unchanged).

- [ ] **Step 6: Failing tests** `lib/sms/admin-overview.test.ts`

```ts
import { describe, it, expect } from "vitest"
import { composeOverview, type OverviewRow } from "./admin-overview"
import type { WholesaleSnapshot } from "./wholesale"

const row: OverviewRow = {
  revenue_bundles_ghs: "120.50", revenue_activations_ghs: "71", credits_sold: 7111, purchases: 56,
  unrecorded_purchases: 54, unrecorded_credits: 7000, pending_reviews: 2, pending_senders: 3, fraud_flags: 4, info_flags: 1,
}
const snap: WholesaleSnapshot = { provider: "moolre", backedCredits: 650, balanceGhs: null, ratePerSms: null, queuedUnsent: 250 }
const ctx = { featureEnabled: true, policyEnforced: false, provider: "moolre" }

describe("composeOverview", () => {
  it("sums recorded revenue and maps stats + tab counts", () => {
    const o = composeOverview(row, [], snap, ctx)
    expect(o.stats).toEqual({
      recordedRevenueGhs: 191.5, bundleRevenueGhs: 120.5, activationRevenueGhs: 71,
      creditsSold: 7111, purchases: 56, pendingReviews: 2, pendingSenders: 3, fraudFlags: 4,
    })
    expect(o.tabCounts).toEqual({ businessReviews: 2, senderIds: 3, flagged: 5 })
    expect(o.unrecorded).toEqual({ purchases: 54, credits: 7000 })
    expect(o.supply).toBe(snap)
    expect(o.featureEnabled).toBe(true)
    expect(o.policyEnforced).toBe(false)
  })
  it("treats a missing row as zeros (never NaN)", () => {
    const o = composeOverview(null, [], snap, ctx)
    expect(o.stats.recordedRevenueGhs).toBe(0)
    expect(o.stats.creditsSold).toBe(0)
    expect(o.tabCounts.flagged).toBe(0)
  })
  it("maps and orders the policy preview", () => {
    const o = composeOverview(row, [{ decision: "allow", code: "OK", n: "10" }, { decision: "block", code: "LINK_NOT_ALLOWED", n: 3 }], snap, ctx)
    expect(o.policyPreview).toEqual([
      { decision: "allow", code: "OK", count: 10 },
      { decision: "block", code: "LINK_NOT_ALLOWED", count: 3 },
    ])
  })
  it("rounds money to 2dp", () => {
    const o = composeOverview({ ...row, revenue_bundles_ghs: "0.1", revenue_activations_ghs: "0.2" }, [], snap, ctx)
    expect(o.stats.recordedRevenueGhs).toBe(0.3)
  })
})
```

- [ ] **Step 7: Run — FAIL. Step 8: Implement `lib/sms/admin-overview.ts`**

```ts
/** Admin overview (Phase 2 spec §4.1): stat cards, tab counts, supply snapshot, policy preview. */
import { createClient } from "@supabase/supabase-js"
import { getWholesaleSnapshot, type WholesaleSnapshot } from "./wholesale"
import { loadSmsSettings } from "./platform-settings"
import { getRoutingConfig } from "./routing"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

/** Row returned by sms_admin_overview(); numerics may arrive as strings. */
export interface OverviewRow {
  revenue_bundles_ghs: string | number
  revenue_activations_ghs: string | number
  credits_sold: string | number
  purchases: string | number
  unrecorded_purchases: string | number
  unrecorded_credits: string | number
  pending_reviews: string | number
  pending_senders: string | number
  fraud_flags: string | number
  info_flags: string | number
}
export interface PreviewRow { decision: string; code: string; n: string | number }

export interface Overview {
  stats: {
    recordedRevenueGhs: number; bundleRevenueGhs: number; activationRevenueGhs: number
    creditsSold: number; purchases: number; pendingReviews: number; pendingSenders: number; fraudFlags: number
  }
  tabCounts: { businessReviews: number; senderIds: number; flagged: number }
  unrecorded: { purchases: number; credits: number }
  supply: WholesaleSnapshot
  featureEnabled: boolean
  policyEnforced: boolean
  provider: string
  policyPreview: { decision: string; code: string; count: number }[]
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const money = (v: unknown) => Math.round(num(v) * 100) / 100

export function composeOverview(
  row: OverviewRow | null,
  preview: PreviewRow[],
  supply: WholesaleSnapshot,
  ctx: { featureEnabled: boolean; policyEnforced: boolean; provider: string }
): Overview {
  const bundles = money(row?.revenue_bundles_ghs)
  const activations = money(row?.revenue_activations_ghs)
  const fraud = num(row?.fraud_flags)
  return {
    stats: {
      recordedRevenueGhs: money(bundles + activations),
      bundleRevenueGhs: bundles,
      activationRevenueGhs: activations,
      creditsSold: num(row?.credits_sold),
      purchases: num(row?.purchases),
      pendingReviews: num(row?.pending_reviews),
      pendingSenders: num(row?.pending_senders),
      fraudFlags: fraud,
    },
    tabCounts: {
      businessReviews: num(row?.pending_reviews),
      senderIds: num(row?.pending_senders),
      flagged: fraud + num(row?.info_flags),
    },
    unrecorded: { purchases: num(row?.unrecorded_purchases), credits: num(row?.unrecorded_credits) },
    supply,
    featureEnabled: ctx.featureEnabled,
    policyEnforced: ctx.policyEnforced,
    provider: ctx.provider,
    policyPreview: preview.map((p) => ({ decision: p.decision, code: p.code, count: num(p.n) })),
  }
}

export async function getOverview(): Promise<Overview> {
  const [overview, preview, supply, settings, routing] = await Promise.all([
    supabaseAdmin.rpc("sms_admin_overview"),
    supabaseAdmin.rpc("sms_policy_preview", { p_days: 7 }),
    getWholesaleSnapshot(),
    loadSmsSettings(),
    getRoutingConfig(),
  ])
  if (overview.error) throw new Error(`overview failed: ${overview.error.message}`)
  if (preview.error) console.error("[SMS-ADMIN] policy preview failed:", preview.error.message)
  return composeOverview(
    ((overview.data as OverviewRow[] | null) ?? [])[0] ?? null,
    (preview.data as PreviewRow[] | null) ?? [],
    supply,
    { featureEnabled: settings.featureEnabled, policyEnforced: settings.policyEnforced, provider: String(routing.primary) }
  )
}
```
Run — PASS.

- [ ] **Step 9: Route** `app/api/admin/sms-platform/overview/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { getOverview } from "@/lib/sms/admin-overview"

export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await getOverview() })
  } catch (e) {
    console.error("[SMS-ADMIN] overview failed:", e)
    return NextResponse.json({ success: false, error: "Could not load the overview" }, { status: 500 })
  }
}
```

- [ ] **Step 10: Run** `npx vitest run lib/sms` and `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 11: Commit** — `feat(sms): admin guard, supply snapshot and overview service/route` + trailer.

---

### Task 4: Lists service (messages, accounts, flags) + flag actions + routes

**Files:**
- Create: `lib/sms/admin-lists.ts`, `lib/sms/admin-lists.test.ts`
- Create: `app/api/admin/sms-platform/messages/route.ts`, `app/api/admin/sms-platform/accounts/route.ts`, `app/api/admin/sms-platform/flags/route.ts`, `app/api/admin/sms-platform/flags/[id]/route.ts`

(`app/api/admin/sms-platform/accounts/[id]/route.ts` already exists from Phase 1 — it is the per-account PATCH; the new `accounts/route.ts` is the list.)

- [ ] **Step 1: Failing tests** `lib/sms/admin-lists.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  rpcData: [] as any[], rpcError: null as null | { message: string }, rpcCalls: [] as { fn: string; args: any }[],
  tableResult: { data: null as any, error: null as null | { message: string } },
  ops: [] as { table: string; ops: { m: string; args: any[] }[] }[],
  dismiss: vi.fn(), suspend: vi.fn(), audit: vi.fn(() => Promise.resolve()),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: (fn: string, args: any) => { h.rpcCalls.push({ fn, args }); return Promise.resolve({ data: h.rpcData, error: h.rpcError }) },
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.ops.push({ table, ops })
      const c: any = {}
      for (const m of ["select", "update", "eq", "is", "in", "maybeSingle", "single"]) c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => Promise.resolve(h.tableResult).then(res, rej)
      return c
    },
  }),
}))
vi.mock("./moderation-service", () => ({ dismissFlag: h.dismiss, suspendSmsAccount: h.suspend, writeAuditLog: h.audit }))

import { PAGE_SIZE, parsePage, cleanQuery, listMessages, listAccounts, listFlags, actOnFlag } from "./admin-lists"

beforeEach(() => {
  h.rpcData = []; h.rpcError = null; h.rpcCalls = []; h.ops = []
  h.tableResult = { data: null, error: null }
  h.dismiss.mockReset(); h.suspend.mockReset(); h.audit.mockClear()
})

describe("parsePage / cleanQuery", () => {
  it("defaults to page 1 for junk", () => { for (const v of [null, "", "abc", "0", "-3", "1.5"]) expect(parsePage(v)).toBe(1) })
  it("parses a positive integer", () => expect(parsePage("4")).toBe(4))
  it("trims and caps the search text", () => {
    expect(cleanQuery("  hello  ")).toBe("hello")
    expect(cleanQuery("x".repeat(300))).toHaveLength(100)
    expect(cleanQuery(null)).toBe("")
  })
})

describe("listMessages", () => {
  it("passes search, status, limit and offset and returns rows + total", async () => {
    h.rpcData = [{ id: 1, message: "hi", total_count: "57" }, { id: 2, message: "yo", total_count: "57" }]
    const r = await listMessages({ q: " abc ", status: "sent", page: 3 })
    expect(h.rpcCalls[0]).toEqual({ fn: "sms_admin_messages", args: { p_q: "abc", p_status: "sent", p_limit: PAGE_SIZE, p_offset: 2 * PAGE_SIZE } })
    expect(r).toEqual({ rows: [{ id: 1, message: "hi" }, { id: 2, message: "yo" }], total: 57, page: 3, pageSize: PAGE_SIZE })
  })
  it("ignores an unknown status filter", async () => {
    await listMessages({ q: "", status: "drop table", page: 1 })
    expect(h.rpcCalls[0].args.p_status).toBe("")
  })
  it("returns total 0 for no rows", async () => expect((await listMessages({ q: "", status: "", page: 1 })).total).toBe(0))
  it("throws on an RPC error", async () => {
    h.rpcError = { message: "boom" }
    await expect(listMessages({ q: "", status: "", page: 1 })).rejects.toThrow("boom")
  })
})

describe("listAccounts / listFlags", () => {
  it("accounts: offset math and total", async () => {
    h.rpcData = [{ id: "a", total_count: 242 }]
    const r = await listAccounts({ q: "business", page: 2 })
    expect(h.rpcCalls[0]).toEqual({ fn: "sms_admin_accounts", args: { p_q: "business", p_limit: PAGE_SIZE, p_offset: PAGE_SIZE } })
    expect(r.total).toBe(242)
  })
  it("flags: only known severity/status pass through", async () => {
    await listFlags({ severity: "fraud", status: "open", page: 1 })
    await listFlags({ severity: "x", status: "y", page: 1 })
    expect(h.rpcCalls[0].args).toMatchObject({ p_severity: "fraud", p_status: "open" })
    expect(h.rpcCalls[1].args).toMatchObject({ p_severity: "", p_status: "" })
  })
})

describe("actOnFlag", () => {
  const UUID = "11111111-1111-4111-8111-111111111111"
  it("dismiss a legacy flag delegates to dismissFlag", async () => {
    h.dismiss.mockResolvedValue({ ok: true })
    expect(await actOnFlag("admin1", "legacy", "42", "dismiss")).toEqual({ ok: true })
    expect(h.dismiss).toHaveBeenCalledWith("admin1", "42")
  })
  it("dismiss a legacy flag surfaces the service error", async () => {
    h.dismiss.mockResolvedValue({ ok: false, error: "Log entry is not flagged", status: 404 })
    expect(await actOnFlag("admin1", "legacy", "42", "dismiss")).toEqual({ ok: false, error: "Log entry is not flagged" })
  })
  it("dismiss an sms_flags row updates it guarded on status=open and audits", async () => {
    h.tableResult = { data: [{ id: UUID }], error: null }
    expect(await actOnFlag("admin1", "flag", UUID, "dismiss")).toEqual({ ok: true })
    const o = h.ops[0]
    expect(o.table).toBe("sms_flags")
    expect(o.ops.find((x) => x.m === "update")!.args[0]).toMatchObject({ status: "dismissed", resolved_by: "admin1" })
    expect(o.ops.filter((x) => x.m === "eq").map((x) => x.args)).toEqual([["id", UUID], ["status", "open"]])
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_flag_dismiss", null, expect.anything(), expect.anything())
  })
  it("dismiss with no matching open row → error", async () => {
    h.tableResult = { data: [], error: null }
    expect((await actOnFlag("admin1", "flag", UUID, "dismiss")).ok).toBe(false)
  })
  it("suspend looks up the account, suspends it, then marks the flag actioned", async () => {
    h.tableResult = { data: { sms_account_id: "acct1" }, error: null }
    h.suspend.mockResolvedValue({ ok: true, newStatus: "suspended" })
    expect(await actOnFlag("admin1", "flag", UUID, "suspend")).toEqual({ ok: true })
    expect(h.suspend).toHaveBeenCalledWith("admin1", "acct1", true)
    const updates = h.ops.filter((o) => o.ops.some((x) => x.m === "update"))
    expect(updates[0].ops.find((x) => x.m === "update")!.args[0]).toMatchObject({ status: "actioned", resolved_by: "admin1" })
  })
  it("suspend failure is surfaced and the flag stays open", async () => {
    h.tableResult = { data: { sms_account_id: "acct1" }, error: null }
    h.suspend.mockResolvedValue({ ok: false, error: "SMS account not found" })
    expect(await actOnFlag("admin1", "flag", UUID, "suspend")).toEqual({ ok: false, error: "SMS account not found" })
    expect(h.ops.some((o) => o.ops.some((x) => x.m === "update"))).toBe(false)
  })
  it("rejects malformed ids, sources and actions before touching the DB", async () => {
    expect((await actOnFlag("a", "flag", "not-a-uuid", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "legacy", "12abc", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "nope" as any, "1", "dismiss")).ok).toBe(false)
    expect((await actOnFlag("a", "legacy", "1", "delete" as any)).ok).toBe(false)
    expect(h.ops).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `lib/sms/admin-lists.ts`**

```ts
/** Searchable, paged admin lists + flag actions (Phase 2 spec §4.2). Heavy lifting is in SQL functions. */
import { createClient } from "@supabase/supabase-js"
import { dismissFlag, suspendSmsAccount, writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const PAGE_SIZE = 25
const MESSAGE_STATUSES = new Set(["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"])
const FLAG_SEVERITIES = new Set(["fraud", "info"])
const FLAG_STATUSES = new Set(["open", "dismissed", "actioned"])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }

export function parsePage(raw: string | null | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : 1
}
export function cleanQuery(raw: string | null | undefined): string {
  return (raw ?? "").trim().slice(0, 100)
}

function toPage<T extends { total_count?: string | number }>(data: T[] | null, page: number): Page<Omit<T, "total_count">> {
  const list = data ?? []
  const total = list.length ? Number(list[0].total_count) || 0 : 0
  return { rows: list.map(({ total_count: _t, ...rest }) => rest), total, page, pageSize: PAGE_SIZE }
}

async function listVia<T>(fn: string, args: Record<string, unknown>, page: number) {
  const { data, error } = await supabaseAdmin.rpc(fn, { ...args, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE })
  if (error) throw new Error(error.message)
  return toPage(data as (T & { total_count?: string | number })[] | null, page)
}

export function listMessages(i: { q: string; status: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_messages", { p_q: cleanQuery(i.q), p_status: MESSAGE_STATUSES.has(i.status) ? i.status : "" }, i.page)
}
export function listAccounts(i: { q: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_accounts", { p_q: cleanQuery(i.q) }, i.page)
}
export function listFlags(i: { severity: string; status: string; page: number }) {
  return listVia<Record<string, unknown>>("sms_admin_flags", {
    p_severity: FLAG_SEVERITIES.has(i.severity) ? i.severity : "",
    p_status: FLAG_STATUSES.has(i.status) ? i.status : "",
  }, i.page)
}

export type FlagActionResult = { ok: true } | { ok: false; error: string }

/** Dismiss or suspend-from a flag. source "flag" = sms_flags row (uuid); "legacy" = flagged send log (numeric id). */
export async function actOnFlag(
  adminId: string,
  source: "flag" | "legacy",
  id: string,
  action: "dismiss" | "suspend"
): Promise<FlagActionResult> {
  if (source !== "flag" && source !== "legacy") return { ok: false, error: "Unknown flag source" }
  if (action !== "dismiss" && action !== "suspend") return { ok: false, error: "Unknown action" }
  if (source === "flag" && !UUID_RE.test(id)) return { ok: false, error: "Invalid flag id" }
  if (source === "legacy" && !/^\d+$/.test(id)) return { ok: false, error: "Invalid flag id" }

  const now = new Date().toISOString()

  if (action === "dismiss") {
    if (source === "legacy") {
      const r = await dismissFlag(adminId, id)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    }
    const { data, error } = await supabaseAdmin.from("sms_flags")
      .update({ status: "dismissed", resolved_by: adminId, resolved_at: now })
      .eq("id", id).eq("status", "open").select("id")
    if (error) return { ok: false, error: error.message }
    if (!data || data.length === 0) return { ok: false, error: "Flag not found or already resolved" }
    await writeAuditLog(adminId, "sms_flag_dismiss", null, { id, status: "open" }, { id, status: "dismissed" }).catch(() => {})
    return { ok: true }
  }

  // suspend: find the account behind the flag
  const lookup = source === "flag"
    ? await supabaseAdmin.from("sms_flags").select("sms_account_id").eq("id", id).maybeSingle()
    : await supabaseAdmin.from("sms_send_logs").select("sms_account_id").eq("id", Number(id)).maybeSingle()
  const accountId = (lookup.data as { sms_account_id?: string } | null)?.sms_account_id
  if (lookup.error || !accountId) return { ok: false, error: "Flag not found" }

  const s = await suspendSmsAccount(adminId, accountId, true)
  if (!s.ok) return { ok: false, error: s.error }
  if (source === "flag") {
    await supabaseAdmin.from("sms_flags")
      .update({ status: "actioned", resolved_by: adminId, resolved_at: now }).eq("id", id).eq("status", "open")
  }
  return { ok: true }
}
```
Run — PASS.

- [ ] **Step 4: Routes** (all thin; reads use `adminGuard(request)`, the flag action uses `{ write: true }`)

`app/api/admin/sms-platform/messages/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listMessages, parsePage } from "@/lib/sms/admin-lists"

// GET ?q=&status=&page=
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const sp = request.nextUrl.searchParams
  try {
    const data = await listMessages({ q: sp.get("q") ?? "", status: sp.get("status") ?? "", page: parsePage(sp.get("page")) })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-ADMIN] messages failed:", e)
    return NextResponse.json({ success: false, error: "Could not load messages" }, { status: 500 })
  }
}
```
`accounts/route.ts` — identical shape with `listAccounts({ q: sp.get("q") ?? "", page: parsePage(sp.get("page")) })` and error text "Could not load accounts". `flags/route.ts` — identical with `listFlags({ severity: sp.get("severity") ?? "", status: sp.get("status") ?? "open", page: parsePage(sp.get("page")) })`, error text "Could not load flags".

`flags/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { actOnFlag } from "@/lib/sms/admin-lists"

// POST { source: "flag" | "legacy", action: "dismiss" | "suspend" }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const { id } = await params
  let body: { source?: string; action?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const r = await actOnFlag(g.adminId!, body.source as "flag" | "legacy", id, body.action as "dismiss" | "suspend")
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: Run** `npx vitest run lib/sms/admin-lists.test.ts` + `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 6: Commit** — `feat(sms): admin lists (messages/accounts/flags) with search, paging and flag actions` + trailer.

---

### Task 5: Settings service (section-wise) + route

**Files:**
- Create: `lib/sms/admin-settings.ts`, `lib/sms/admin-settings.test.ts`, `app/api/admin/sms-platform/settings/route.ts`
- Modify: `lib/sms/platform-settings.ts` (export `normalizeDomain`)

Sections save independently. `sms_policy_enforced` is **never** writable here. Values are stored in `tenant_global_settings` in the shapes Phase 1 and the legacy readers expect (pricing keys keep their `{amount}` / `{units}` wrappers).

- [ ] **Step 1:** In `lib/sms/platform-settings.ts` change `function normalizeDomain(` to `export function normalizeDomain(` (no other change).

- [ ] **Step 2: Failing tests** `lib/sms/admin-settings.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  oldRows: [] as { key: string; value: unknown }[], upserts: [] as any[], upsertError: null as null | { message: string },
  audit: vi.fn(() => Promise.resolve()), invalidate: vi.fn(),
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: h.oldRows, error: null }) }),
      upsert: (rows: any) => { h.upserts.push(rows); return Promise.resolve({ error: h.upsertError }) },
    }),
  }),
}))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))
vi.mock("./platform-settings", async (orig) => ({ ...(await orig<typeof import("./platform-settings")>()), invalidateSmsSettingsCache: h.invalidate }))

import { validateSection, saveSection, parsePricing } from "./admin-settings"

beforeEach(() => { h.oldRows = []; h.upserts = []; h.upsertError = null; h.audit.mockClear(); h.invalidate.mockClear() })

const rows = (r: any) => (r.ok ? r.rows : null)

describe("validateSection", () => {
  it("switch", () => {
    expect(rows(validateSection("switch", { featureEnabled: false }))).toEqual([{ key: "sms_feature_enabled", value: false }])
    expect(validateSection("switch", { featureEnabled: "no" }).ok).toBe(false)
  })
  it("caps: both modes, integers in range", () => {
    const ok = { platform: { per_send: 300, per_hour: 20, per_day: 500 }, business: { per_send: 1000, per_hour: 2000, per_day: 1000000 } }
    expect(rows(validateSection("caps", ok))).toEqual([{ key: "sms_caps", value: ok }])
    expect(validateSection("caps", { ...ok, platform: { per_send: 0, per_hour: 20, per_day: 500 } }).ok).toBe(false)
    expect(validateSection("caps", { ...ok, business: { per_send: 1.5, per_hour: 1, per_day: 1 } }).ok).toBe(false)
    expect(validateSection("caps", { platform: ok.platform }).ok).toBe(false)
  })
  it("moderation thresholds", () => {
    expect(rows(validateSection("moderation", { autoSuspendFlags: 2, flagReviewThreshold: 5 }))).toEqual([
      { key: "sms_auto_suspend_flags", value: 2 }, { key: "sms_flag_review_threshold", value: 5 },
    ])
    expect(validateSection("moderation", { autoSuspendFlags: 101, flagReviewThreshold: 5 }).ok).toBe(false)
    expect(validateSection("moderation", { autoSuspendFlags: 2, flagReviewThreshold: 501 }).ok).toBe(false)
  })
  it("api_limit 1..10000", () => {
    expect(rows(validateSection("api_limit", { apiRateLimitDefault: 30 }))).toEqual([{ key: "sms_api_rate_limit_default", value: 30 }])
    expect(validateSection("api_limit", { apiRateLimitDefault: 0 }).ok).toBe(false)
    expect(validateSection("api_limit", { apiRateLimitDefault: 10001 }).ok).toBe(false)
  })
  it("roles: known roles only, de-duplicated", () => {
    expect(rows(validateSection("roles", { allowedRoles: ["shop_owner", "dealer", "dealer"] }))).toEqual([{ key: "sms_allowed_roles", value: ["shop_owner", "dealer"] }])
    expect(validateSection("roles", { allowedRoles: ["admin"] }).ok).toBe(false)
  })
  it("sender_pool: validated, upper-cased, de-duplicated", () => {
    expect(rows(validateSection("sender_pool", { senderPool: ["alerts", "ALERTS", "Pay Co"] }))).toEqual([{ key: "sms_sender_pool", value: ["ALERTS", "PAY CO"] }])
    expect(validateSection("sender_pool", { senderPool: ["ab"] }).ok).toBe(false)
    expect(validateSection("sender_pool", { senderPool: ["bad-name!"] }).ok).toBe(false)
  })
  it("platform_keywords: trimmed, de-duplicated case-insensitively, no empties", () => {
    expect(rows(validateSection("platform_keywords", { blockedKeywords: [" Loan ", "loan", "", "win big"] }))).toEqual([{ key: "sms_blocked_keywords", value: ["Loan", "win big"] }])
    expect(validateSection("platform_keywords", { blockedKeywords: ["x".repeat(61)] }).ok).toBe(false)
  })
  it("business_lists: keywords + normalised domains", () => {
    const r = validateSection("business_lists", {
      businessBlockedKeywords: ["casino"], businessFlaggedKeywords: ["bonus"], businessAllowedDomains: ["https://WWW.Bit.ly/x", "example.com"],
    })
    expect(rows(r)).toEqual([
      { key: "sms_business_blocked_keywords", value: ["casino"] },
      { key: "sms_business_flagged_keywords", value: ["bonus"] },
      { key: "sms_business_allowed_domains", value: ["bit.ly", "example.com"] },
    ])
    expect(validateSection("business_lists", { businessBlockedKeywords: [], businessFlaggedKeywords: [], businessAllowedDomains: ["not a domain"] }).ok).toBe(false)
  })
  it("pricing keeps the legacy wrappers", () => {
    expect(rows(validateSection("pricing", { activationFee: 20, welcomeBonusCredits: 10, pricePerCredit: 0.025 }))).toEqual([
      { key: "sms_activation_fee", value: { amount: 20 } },
      { key: "sms_welcome_bonus_credits", value: { units: 10 } },
      { key: "sms_price_per_credit", value: { amount: 0.025 } },
    ])
    expect(validateSection("pricing", { activationFee: -1, welcomeBonusCredits: 10, pricePerCredit: 0.025 }).ok).toBe(false)
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 1.5, pricePerCredit: 0.025 }).ok).toBe(false)
    expect(validateSection("pricing", { activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0 }).ok).toBe(false)
  })
  it("hubtel cost + low-balance threshold", () => {
    expect(rows(validateSection("hubtel", { hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: 50 }))).toEqual([
      { key: "sms_hubtel_cost_per_sms", value: 0.035 }, { key: "sms_hubtel_low_balance_ghs", value: 50 },
    ])
    expect(validateSection("hubtel", { hubtelCostPerSms: 0, hubtelLowBalanceGhs: 50 }).ok).toBe(false)
  })
  it("refuses unknown sections, including the enforcement flag", () => {
    expect(validateSection("enforcement", { policyEnforced: true }).ok).toBe(false)
    expect(validateSection("nope", {}).ok).toBe(false)
    expect(validateSection("switch", null).ok).toBe(false)
  })
})

describe("saveSection", () => {
  it("validates, upserts, audits old/new, invalidates the cache", async () => {
    h.oldRows = [{ key: "sms_feature_enabled", value: true }]
    const r = await saveSection("admin1", "switch", { featureEnabled: false })
    expect(r).toEqual({ ok: true, updated: ["sms_feature_enabled"] })
    expect(h.upserts[0]).toEqual([{ key: "sms_feature_enabled", value: false }])
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_settings_update", null,
      { section: "switch", values: { sms_feature_enabled: true } }, { section: "switch", values: { sms_feature_enabled: false } })
    expect(h.invalidate).toHaveBeenCalledOnce()
  })
  it("invalid input writes nothing", async () => {
    const r = await saveSection("admin1", "api_limit", { apiRateLimitDefault: 0 })
    expect(r.ok).toBe(false)
    expect(h.upserts).toHaveLength(0)
    expect(h.audit).not.toHaveBeenCalled()
  })
  it("a database error is reported, not audited, cache untouched", async () => {
    h.upsertError = { message: "db down" }
    const r = await saveSection("admin1", "switch", { featureEnabled: true })
    expect(r).toEqual({ ok: false, error: "Could not save settings" })
    expect(h.audit).not.toHaveBeenCalled()
    expect(h.invalidate).not.toHaveBeenCalled()
  })
  it("refuses a missing admin id", async () => {
    expect((await saveSection("", "switch", { featureEnabled: true })).ok).toBe(false)
    expect(h.upserts).toHaveLength(0)
  })
})

describe("parsePricing", () => {
  it("reads wrapped and bare values, with safe defaults", () => {
    expect(parsePricing([
      { key: "sms_activation_fee", value: { amount: 20 } }, { key: "sms_welcome_bonus_credits", value: { units: 10 } }, { key: "sms_price_per_credit", value: 0.04 },
    ])).toEqual({ activationFee: 20, welcomeBonusCredits: 10, pricePerCredit: 0.04 })
    expect(parsePricing([])).toEqual({ activationFee: 0, welcomeBonusCredits: 0, pricePerCredit: 0.04 })
  })
})
```

- [ ] **Step 3: Run — FAIL. Step 4: Implement `lib/sms/admin-settings.ts`**

```ts
/**
 * Admin SMS settings (Phase 2 spec §4.3): one SECTION per save, validated server-side with the same
 * ranges Phase 1's parseSmsSettings enforces, written to tenant_global_settings, audited (old/new)
 * and the 60 s settings cache invalidated. sms_policy_enforced is deliberately NOT writable here.
 */
import { createClient } from "@supabase/supabase-js"
import { writeAuditLog } from "./moderation-service"
import { invalidateSmsSettingsCache, loadSmsSettings, normalizeDomain, type SmsPlatformSettings } from "./platform-settings"
import { validateSenderName } from "./sender-name"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const ALLOWED_ROLES = ["shop_owner", "sub_agent", "dealer", "user"] as const
const MAX_LIST = 500
const MAX_KEYWORD = 60

type Row = { key: string; value: unknown }
export type ValidationResult = { ok: true; rows: Row[] } | { ok: false; error: string }

const fail = (error: string): ValidationResult => ({ ok: false, error })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max
const isNum = (v: unknown, min: number, max: number, minExclusive = false): v is number =>
  typeof v === "number" && Number.isFinite(v) && (minExclusive ? v > min : v >= min) && v <= max

function cleanKeywords(raw: unknown, label: string): { ok: true; list: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: `${label} must be a list` }
  const seen = new Set<string>(); const list: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, error: `${label} must contain text only` }
    const t = item.trim()
    if (!t) continue
    if (t.length > MAX_KEYWORD) return { ok: false, error: `${label}: "${t.slice(0, 20)}…" is longer than ${MAX_KEYWORD} characters` }
    if (seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase()); list.push(t)
  }
  if (list.length > MAX_LIST) return { ok: false, error: `${label} can hold at most ${MAX_LIST} entries` }
  return { ok: true, list }
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/

function validateCaps(v: unknown): ValidationResult {
  if (!isObj(v)) return fail("caps must be an object")
  const out: Record<string, { per_send: number; per_hour: number; per_day: number }> = {}
  for (const mode of ["platform", "business"] as const) {
    const m = v[mode]
    if (!isObj(m)) return fail(`caps.${mode} is required`)
    if (!isInt(m.per_send, 1, 1_000_000)) return fail(`${mode}: recipients per send must be a whole number from 1 to 1,000,000`)
    if (!isInt(m.per_hour, 1, 1_000_000)) return fail(`${mode}: sends per hour must be a whole number from 1 to 1,000,000`)
    if (!isInt(m.per_day, 1, 100_000_000)) return fail(`${mode}: recipients per day must be a whole number from 1 to 100,000,000`)
    out[mode] = { per_send: m.per_send, per_hour: m.per_hour, per_day: m.per_day }
  }
  return { ok: true, rows: [{ key: "sms_caps", value: out }] }
}

export function validateSection(section: string, values: unknown): ValidationResult {
  if (!isObj(values)) return fail("Invalid values")
  switch (section) {
    case "switch":
      return typeof values.featureEnabled === "boolean" ? { ok: true, rows: [{ key: "sms_feature_enabled", value: values.featureEnabled }] } : fail("featureEnabled must be true or false")
    case "caps":
      return validateCaps(values)
    case "moderation":
      if (!isInt(values.autoSuspendFlags, 1, 100)) return fail("Auto-suspend threshold must be a whole number from 1 to 100")
      if (!isInt(values.flagReviewThreshold, 1, 500)) return fail("Flag-review threshold must be a whole number from 1 to 500")
      return { ok: true, rows: [{ key: "sms_auto_suspend_flags", value: values.autoSuspendFlags }, { key: "sms_flag_review_threshold", value: values.flagReviewThreshold }] }
    case "api_limit":
      return isInt(values.apiRateLimitDefault, 1, 10_000) ? { ok: true, rows: [{ key: "sms_api_rate_limit_default", value: values.apiRateLimitDefault }] } : fail("API rate limit must be a whole number from 1 to 10,000")
    case "roles": {
      if (!Array.isArray(values.allowedRoles)) return fail("allowedRoles must be a list")
      const roles = [...new Set(values.allowedRoles)]
      if (!roles.every((r) => typeof r === "string" && (ALLOWED_ROLES as readonly string[]).includes(r))) return fail(`Roles must be among: ${ALLOWED_ROLES.join(", ")}`)
      return { ok: true, rows: [{ key: "sms_allowed_roles", value: roles }] }
    }
    case "sender_pool": {
      if (!Array.isArray(values.senderPool)) return fail("senderPool must be a list")
      const names: string[] = []
      for (const raw of values.senderPool) {
        if (typeof raw !== "string") return fail("Sender names must be text")
        const c = validateSenderName(raw, [])
        if (!c.ok) return fail(`"${raw}": ${c.reason}`)
        if (!names.includes(c.name)) names.push(c.name)
      }
      if (names.length > 200) return fail("The sender pool can hold at most 200 names")
      return { ok: true, rows: [{ key: "sms_sender_pool", value: names }] }
    }
    case "platform_keywords": {
      const k = cleanKeywords(values.blockedKeywords, "Blocked keywords")
      return k.ok ? { ok: true, rows: [{ key: "sms_blocked_keywords", value: k.list }] } : fail(k.error)
    }
    case "business_lists": {
      const blocked = cleanKeywords(values.businessBlockedKeywords, "Business blocked keywords")
      if (!blocked.ok) return fail(blocked.error)
      const flagged = cleanKeywords(values.businessFlaggedKeywords, "Business flagged keywords")
      if (!flagged.ok) return fail(flagged.error)
      if (!Array.isArray(values.businessAllowedDomains)) return fail("businessAllowedDomains must be a list")
      const domains: string[] = []
      for (const raw of values.businessAllowedDomains) {
        if (typeof raw !== "string") return fail("Domains must be text")
        if (!raw.trim()) continue
        const d = normalizeDomain(raw)
        if (!DOMAIN_RE.test(d)) return fail(`"${raw}" is not a valid domain`)
        if (!domains.includes(d)) domains.push(d)
      }
      if (domains.length > MAX_LIST) return fail(`Allowed domains can hold at most ${MAX_LIST} entries`)
      return { ok: true, rows: [
        { key: "sms_business_blocked_keywords", value: blocked.list },
        { key: "sms_business_flagged_keywords", value: flagged.list },
        { key: "sms_business_allowed_domains", value: domains },
      ] }
    }
    case "pricing":
      if (!isNum(values.activationFee, 0, 10_000)) return fail("Activation fee must be between 0 and 10,000")
      if (!isInt(values.welcomeBonusCredits, 0, 100_000)) return fail("Welcome bonus must be a whole number from 0 to 100,000")
      if (!isNum(values.pricePerCredit, 0, 100, true)) return fail("Price per credit must be greater than 0 and at most 100")
      return { ok: true, rows: [
        { key: "sms_activation_fee", value: { amount: Math.round(values.activationFee * 100) / 100 } },
        { key: "sms_welcome_bonus_credits", value: { units: values.welcomeBonusCredits } },
        { key: "sms_price_per_credit", value: { amount: values.pricePerCredit } },
      ] }
    case "hubtel":
      if (!isNum(values.hubtelCostPerSms, 0.0001, 10)) return fail("Hubtel cost per SMS must be between 0.0001 and 10")
      if (!isNum(values.hubtelLowBalanceGhs, 0, 1_000_000)) return fail("Low-balance alert must be between 0 and 1,000,000")
      return { ok: true, rows: [{ key: "sms_hubtel_cost_per_sms", value: values.hubtelCostPerSms }, { key: "sms_hubtel_low_balance_ghs", value: values.hubtelLowBalanceGhs }] }
    default:
      return fail("Unknown settings section")
  }
}

export type SaveResult = { ok: true; updated: string[] } | { ok: false; error: string }

export async function saveSection(adminId: string, section: string, values: unknown): Promise<SaveResult> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  const v = validateSection(section, values)
  if (!v.ok) return { ok: false, error: v.error }
  const keys = v.rows.map((r) => r.key)

  const { data: oldRows } = await supabaseAdmin.from("tenant_global_settings").select("key, value").in("key", keys)
  const oldValues = Object.fromEntries(((oldRows ?? []) as Row[]).map((r) => [r.key, r.value]))

  const { error } = await supabaseAdmin.from("tenant_global_settings").upsert(v.rows, { onConflict: "key" })
  if (error) {
    console.error("[SMS-ADMIN] settings save failed:", error.message)
    return { ok: false, error: "Could not save settings" }
  }
  await writeAuditLog(
    adminId, "sms_settings_update", null,
    { section, values: oldValues },
    { section, values: Object.fromEntries(v.rows.map((r) => [r.key, r.value])) }
  ).catch((e) => console.error("[SMS-ADMIN] audit failed:", e))
  invalidateSmsSettingsCache()
  return { ok: true, updated: keys }
}

export interface Pricing { activationFee: number; welcomeBonusCredits: number; pricePerCredit: number }

export function parsePricing(rows: Row[]): Pricing {
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const pick = (key: string, field: string, d: number) => {
    const v = m.get(key)
    const n = isObj(v) ? Number(v[field]) : typeof v === "number" ? v : NaN
    return Number.isFinite(n) ? n : d
  }
  return {
    activationFee: pick("sms_activation_fee", "amount", 0),
    welcomeBonusCredits: pick("sms_welcome_bonus_credits", "units", 0),
    pricePerCredit: pick("sms_price_per_credit", "amount", 0.04),
  }
}

export interface AdminSettings { settings: SmsPlatformSettings; pricing: Pricing }

export async function getAdminSettings(): Promise<AdminSettings> {
  const [settings, pricingRows] = await Promise.all([
    loadSmsSettings(),
    supabaseAdmin.from("tenant_global_settings").select("key, value")
      .in("key", ["sms_activation_fee", "sms_welcome_bonus_credits", "sms_price_per_credit"]),
  ])
  return { settings, pricing: parsePricing((pricingRows.data ?? []) as Row[]) }
}
```
Run — PASS.

- [ ] **Step 5: Route** `app/api/admin/sms-platform/settings/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { getAdminSettings, saveSection } from "@/lib/sms/admin-settings"

export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await getAdminSettings() })
  } catch (e) {
    console.error("[SMS-ADMIN] settings load failed:", e)
    return NextResponse.json({ success: false, error: "Could not load settings" }, { status: 500 })
  }
}

// PATCH { section: string, values: object } — one section per call.
export async function PATCH(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  let body: { section?: string; values?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const r = await saveSection(g.adminId!, String(body.section ?? ""), body.values)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: await getAdminSettings() })
}
```

- [ ] **Step 6: Run** `npx vitest run lib/sms` + `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 7: Commit** — `feat(sms): section-wise admin settings service + route (audited, validated)` + trailer.

---

### Task 6: Guarded bundle delete

**Files:**
- Modify: `lib/sms/bundle-service.ts` (+test), `app/api/admin/sms/bundles/route.ts`

A Paystack checkout started for a bundle that is then deleted would be paid but uncreditable (the webhook loads the bundle by id), so hard delete is only allowed for a bundle that has been **inactive for at least 48 hours**.

- [ ] **Step 1: Failing tests** (append to `lib/sms/bundle-service.test.ts`; reuse its fake client — read the file first and extend the fake with `delete().eq().eq()` support, keeping every existing assertion)

```ts
import { canDeleteBundle, BUNDLE_DELETE_MIN_INACTIVE_MS, deleteBundle } from "./bundle-service"

describe("canDeleteBundle (pure)", () => {
  const now = Date.parse("2026-10-11T12:00:00Z")
  it("refuses an active bundle", () => {
    expect(canDeleteBundle({ active: true, updated_at: "2026-01-01T00:00:00Z" }, now))
      .toEqual({ ok: false, error: "Deactivate the bundle first" })
  })
  it("refuses a bundle deactivated less than 48 h ago", () => {
    const r = canDeleteBundle({ active: false, updated_at: new Date(now - 47 * 3600_000).toISOString() }, now)
    expect(r.ok).toBe(false)
  })
  it("allows a bundle inactive for 48 h or more", () => {
    expect(canDeleteBundle({ active: false, updated_at: new Date(now - BUNDLE_DELETE_MIN_INACTIVE_MS).toISOString() }, now)).toEqual({ ok: true })
  })
})
```
Plus service tests with the fake: `deleteBundle("admin1", id)` → not found → `{ok:false,error:"Bundle not found"}`; active → refused and **no delete issued**; old-inactive → delete issued for that id + audit row `sms_bundle_delete` written; empty admin id → refused.

- [ ] **Step 2: Run — FAIL. Step 3: Implement** (append to `lib/sms/bundle-service.ts`; add `import { writeAuditLog } from "./moderation-service"` — `moderation-service` only imports `type Bundle` from this file, so there is no runtime cycle)

```ts
export const BUNDLE_DELETE_MIN_INACTIVE_MS = 48 * 3600_000

export function canDeleteBundle(
  b: { active: boolean; updated_at: string },
  now = Date.now()
): { ok: true } | { ok: false; error: string } {
  if (b.active) return { ok: false, error: "Deactivate the bundle first" }
  const inactiveFor = now - Date.parse(b.updated_at)
  if (!Number.isFinite(inactiveFor) || inactiveFor < BUNDLE_DELETE_MIN_INACTIVE_MS) {
    return { ok: false, error: "A bundle can be deleted 48 hours after it was deactivated (so in-flight payments can still be credited)" }
  }
  return { ok: true }
}

/** Hard-delete an inactive bundle (admin). Purchases already credited are unaffected (they live in the ledger by ref). */
export async function deleteBundle(adminId: string, id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  const { data: b } = await supabaseAdmin.from("sms_bundles").select("id, name, active, updated_at, units, price_ghs").eq("id", id).maybeSingle()
  if (!b) return { ok: false, error: "Bundle not found" }
  const can = canDeleteBundle(b as { active: boolean; updated_at: string })
  if (!can.ok) return can
  const { error } = await supabaseAdmin.from("sms_bundles").delete().eq("id", id).eq("active", false)
  if (error) return { ok: false, error: "Could not delete the bundle" }
  await writeAuditLog(adminId, "sms_bundle_delete", null, { id, name: (b as { name: string }).name }, null).catch(() => {})
  return { ok: true }
}
```

- [ ] **Step 4: Route.** Append to `app/api/admin/sms/bundles/route.ts` (add `import { adminGuard } from "@/lib/sms/admin-guard"` and `deleteBundle` to the existing bundle-service import):

```ts
// DELETE ?id=<bundle id> — guarded hard delete (inactive for ≥ 48 h)
export async function DELETE(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  const id = request.nextUrl.searchParams.get("id")
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })
  const r = await deleteBundle(g.adminId!, id)
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: Run** `npx vitest run lib/sms` + `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 6: Commit** — `feat(sms): guarded bundle delete (inactive ≥ 48h)` + trailer.

---

### Task 7: Review lists (with account info) and hardened credit allocation

**Files:**
- Create: `lib/sms/admin-reviews.ts`, `lib/sms/admin-reviews.test.ts`, `lib/sms/admin-actions.ts`, `lib/sms/admin-actions.test.ts`
- Create: `app/api/admin/sms-platform/sender-ids/route.ts`
- Modify: `app/api/admin/sms-platform/business-reviews/route.ts`, `app/api/admin/sms/allocate/route.ts`

Why: the Business Reviews and Sender IDs cards must show the **user** (id/email) and the account's **mode**, which neither existing list returns. Separately, the existing `POST /api/admin/sms/allocate` creates credits with no real-admin requirement and no audit row; the Accounts tab will call it, so it is hardened here.

- [ ] **Step 1: Failing tests** `lib/sms/admin-reviews.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  accounts: [] as any[], users: [] as any[], senders: [] as any[], reviews: [] as any[], calls: [] as { table: string; ops: { m: string; args: any[] }[] }[],
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const ops: { m: string; args: any[] }[] = []
      h.calls.push({ table, ops })
      const c: any = {}
      for (const m of ["select", "eq", "in", "order", "limit"]) c[m] = (...args: any[]) => { ops.push({ m, args }); return c }
      c.then = (res: any, rej: any) => {
        const data = table === "sms_accounts" ? h.accounts : table === "users" ? h.users : table === "sms_sender_ids" ? h.senders : h.reviews
        return Promise.resolve({ data, error: null }).then(res, rej)
      }
      return c
    },
  }),
}))
vi.mock("./kyc-service", () => ({ listKycForAdmin: (status: string) => Promise.resolve(h.reviews.filter((r) => status === "all" || r.status === status)) }))

import { attachAccounts, loadAccountInfo, listBusinessReviews, listSenderIdsForAdmin, type AccountInfo } from "./admin-reviews"

beforeEach(() => { h.accounts = []; h.users = []; h.senders = []; h.reviews = []; h.calls = [] })

const info: AccountInfo = { user_id: "u1", email: "a@b.com", mode: "platform", owner_type: "shop" }

describe("attachAccounts (pure)", () => {
  it("adds the account, or null when unknown / ownerless", () => {
    const out = attachAccounts([{ sms_account_id: "a1" }, { sms_account_id: "zz" }, { sms_account_id: null }], new Map([["a1", info]]))
    expect(out.map((r) => r.account)).toEqual([info, null, null])
  })
})

describe("loadAccountInfo", () => {
  it("joins accounts to user emails", async () => {
    h.accounts = [{ id: "a1", user_id: "u1", mode: "business", owner_type: "shop" }]
    h.users = [{ id: "u1", email: "x@y.com" }]
    const m = await loadAccountInfo(["a1"])
    expect(m.get("a1")).toEqual({ user_id: "u1", email: "x@y.com", mode: "business", owner_type: "shop" })
  })
  it("returns an empty map without querying for no ids", async () => {
    expect((await loadAccountInfo([])).size).toBe(0)
    expect(h.calls).toHaveLength(0)
  })
  it("queries in chunks of 100 ids", async () => {
    await loadAccountInfo(Array.from({ length: 250 }, (_, i) => `a${i}`))
    expect(h.calls.filter((c) => c.table === "sms_accounts")).toHaveLength(3)
  })
})

describe("listBusinessReviews", () => {
  it("enriches reviews and falls back to 'submitted' on a bad status", async () => {
    h.reviews = [{ id: "r1", sms_account_id: "a1", status: "submitted" }, { id: "r2", sms_account_id: "a1", status: "approved" }]
    h.accounts = [{ id: "a1", user_id: "u1", mode: "platform", owner_type: "shop" }]
    h.users = [{ id: "u1", email: "x@y.com" }]
    const out = await listBusinessReviews("bogus")
    expect(out.map((r) => r.id)).toEqual(["r1"])
    expect(out[0].account?.email).toBe("x@y.com")
  })
})

describe("listSenderIdsForAdmin", () => {
  it("filters by status and scope and attaches accounts", async () => {
    h.senders = [{ id: "s1", sender_id: "KINGS", local_status: "pending", sms_account_id: "a1" }, { id: "s2", sender_id: "DATAGOD", local_status: "active", sms_account_id: null }]
    h.accounts = [{ id: "a1", user_id: "u1", mode: "platform", owner_type: "shop" }]
    await listSenderIdsForAdmin("pending", "tenant")
    const q = h.calls.find((c) => c.table === "sms_sender_ids")!
    expect(q.ops.filter((o) => o.m === "eq").map((o) => o.args)).toContainEqual(["local_status", "pending"])
  })
  it("ignores unknown status values (no filter)", async () => {
    await listSenderIdsForAdmin("nonsense" as any, "all")
    const q = h.calls.find((c) => c.table === "sms_sender_ids")!
    expect(q.ops.some((o) => o.m === "eq" && o.args[0] === "local_status")).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `lib/sms/admin-reviews.ts`**

```ts
/** Admin review lists enriched with each account's user and mode (Phase 2 spec §4.4 / §7). */
import { createClient } from "@supabase/supabase-js"
import { listKycForAdmin, type PublicKyc } from "./kyc-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export interface AccountInfo { user_id: string; email: string | null; mode: "platform" | "business"; owner_type: string }

const CHUNK = 100
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function attachAccounts<T extends { sms_account_id: string | null }>(
  rows: T[], info: Map<string, AccountInfo>
): (T & { account: AccountInfo | null })[] {
  return rows.map((r) => ({ ...r, account: r.sms_account_id ? info.get(r.sms_account_id) ?? null : null }))
}

export async function loadAccountInfo(accountIds: string[]): Promise<Map<string, AccountInfo>> {
  const ids = [...new Set(accountIds.filter(Boolean))]
  const map = new Map<string, AccountInfo>()
  if (ids.length === 0) return map
  const accounts: { id: string; user_id: string; mode: "platform" | "business"; owner_type: string }[] = []
  for (const part of chunks(ids, CHUNK)) {
    const { data } = await supabaseAdmin.from("sms_accounts").select("id, user_id, mode, owner_type").in("id", part)
    accounts.push(...((data ?? []) as typeof accounts))
  }
  const emails = new Map<string, string | null>()
  for (const part of chunks([...new Set(accounts.map((a) => a.user_id))], CHUNK)) {
    const { data } = await supabaseAdmin.from("users").select("id, email").in("id", part)
    for (const u of (data ?? []) as { id: string; email: string | null }[]) emails.set(u.id, u.email)
  }
  for (const a of accounts) {
    map.set(a.id, { user_id: a.user_id, email: emails.get(a.user_id) ?? null, mode: a.mode, owner_type: a.owner_type })
  }
  return map
}

const REVIEW_STATUSES = new Set(["submitted", "approved", "rejected", "draft", "all"])
export type ReviewRow = PublicKyc & { account: AccountInfo | null }

export async function listBusinessReviews(status: string): Promise<ReviewRow[]> {
  const s = (REVIEW_STATUSES.has(status) ? status : "submitted") as Parameters<typeof listKycForAdmin>[0]
  const rows = await listKycForAdmin(s)
  const info = await loadAccountInfo(rows.map((r) => r.sms_account_id))
  return attachAccounts(rows, info)
}

const SENDER_STATUSES = new Set(["pending", "active", "paused", "rejected", "revoked"])
export interface SenderRow {
  id: string; sender_id: string; local_status: string; kyc_free: boolean; is_pool: boolean
  approved_at: string | null; revoked_at: string | null; rejection_reason: string | null
  submitted_at: string | null; created_at: string; sms_account_id: string | null
}

export async function listSenderIdsForAdmin(
  status: string, scope: "tenant" | "global" | "all" = "all"
): Promise<(SenderRow & { account: AccountInfo | null })[]> {
  let q = supabaseAdmin.from("sms_sender_ids")
    .select("id, sender_id, local_status, kyc_free, is_pool, approved_at, revoked_at, rejection_reason, submitted_at, created_at, sms_account_id")
    .order("created_at", { ascending: false }).limit(500)
  if (SENDER_STATUSES.has(status)) q = q.eq("local_status", status)
  const { data } = await q
  let rows = (data ?? []) as SenderRow[]
  if (scope === "tenant") rows = rows.filter((r) => r.sms_account_id)
  if (scope === "global") rows = rows.filter((r) => !r.sms_account_id)
  const info = await loadAccountInfo(rows.map((r) => r.sms_account_id ?? ""))
  return attachAccounts(rows, info)
}
```
Run — PASS.

- [ ] **Step 4: Failing tests** `lib/sms/admin-actions.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({ allocate: vi.fn(), audit: vi.fn(() => Promise.resolve()), user: { data: { user_id: "owner1" } as any } }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(h.user) }) }) }) }),
}))
vi.mock("./bundle-service", () => ({ allocateUnits: h.allocate }))
vi.mock("./moderation-service", () => ({ writeAuditLog: h.audit }))

import { allocateCredits, MAX_ALLOCATION } from "./admin-actions"

const ACCT = "11111111-1111-4111-8111-111111111111"
beforeEach(() => { h.allocate.mockReset(); h.audit.mockClear(); h.user = { data: { user_id: "owner1" } } })

describe("allocateCredits", () => {
  it("allocates, audits with the account owner as target, and reports pending", async () => {
    h.allocate.mockResolvedValue({ ok: true, pending: true, unitsCredited: 0 })
    expect(await allocateCredits("admin1", ACCT, 500)).toEqual({ ok: true, pending: true, unitsCredited: 0 })
    expect(h.allocate).toHaveBeenCalledWith(ACCT, 500)
    expect(h.audit).toHaveBeenCalledWith("admin1", "sms_credits_allocate", "owner1", null, { accountId: ACCT, units: 500, pending: true })
  })
  it("refuses a missing admin id, bad account id and bad unit counts without allocating", async () => {
    expect((await allocateCredits("", ACCT, 5)).ok).toBe(false)
    expect((await allocateCredits("a", "nope", 5)).ok).toBe(false)
    for (const u of [0, -1, 1.5, NaN, MAX_ALLOCATION + 1]) expect((await allocateCredits("a", ACCT, u as number)).ok).toBe(false)
    expect(h.allocate).not.toHaveBeenCalled()
  })
  it("surfaces an allocation failure and writes no audit row", async () => {
    h.allocate.mockResolvedValue({ ok: false, error: "units must be a positive integer" })
    expect(await allocateCredits("admin1", ACCT, 5)).toEqual({ ok: false, error: "units must be a positive integer" })
    expect(h.audit).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run — FAIL. Step 6: Implement `lib/sms/admin-actions.ts`**

```ts
/** Admin account actions that move money-like state (Phase 2). Credits are solvency-gated via allocateUnits. */
import { createClient } from "@supabase/supabase-js"
import { allocateUnits } from "./bundle-service"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
export const MAX_ALLOCATION = 1_000_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AllocateResult = { ok: true; pending: boolean; unitsCredited: number } | { ok: false; error: string }

export async function allocateCredits(adminId: string, accountId: string, units: number): Promise<AllocateResult> {
  if (!adminId) return { ok: false, error: "Admin user required" }
  if (!UUID_RE.test(accountId)) return { ok: false, error: "Invalid account id" }
  if (!Number.isInteger(units) || units < 1 || units > MAX_ALLOCATION) {
    return { ok: false, error: `Credits must be a whole number from 1 to ${MAX_ALLOCATION.toLocaleString("en-US")}` }
  }
  const r = await allocateUnits(accountId, units)
  if (!r.ok) return { ok: false, error: r.error ?? "Allocation failed" }
  const { data } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
  await writeAuditLog(adminId, "sms_credits_allocate", (data as { user_id?: string } | null)?.user_id ?? null, null,
    { accountId, units, pending: r.pending ?? false }).catch(() => {})
  return { ok: true, pending: r.pending ?? false, unitsCredited: r.unitsCredited ?? 0 }
}
```
Run — PASS.

- [ ] **Step 7: Routes**

Replace `app/api/admin/sms/allocate/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { allocateCredits } from "@/lib/sms/admin-actions"

// POST { accountId, units } — admin credit allocation (solvency-gated; may land as pending). Requires a real admin user; audited.
export async function POST(request: NextRequest) {
  const g = await adminGuard(request, { write: true })
  if (!g.ok) return g.response
  let body: { accountId?: string; units?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }) }
  const r = await allocateCredits(g.adminId!, String(body.accountId ?? ""), Number(body.units))
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, pending: r.pending, unitsCredited: r.unitsCredited })
}
```
Replace `app/api/admin/sms-platform/business-reviews/route.ts` GET with:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listBusinessReviews } from "@/lib/sms/admin-reviews"

// GET ?status=submitted|approved|rejected|draft|all (default submitted) — rows include { account: { user_id, email, mode } }
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  try {
    return NextResponse.json({ success: true, data: await listBusinessReviews(request.nextUrl.searchParams.get("status") ?? "submitted") })
  } catch (e) {
    console.error("[SMS-ADMIN] business reviews failed:", e)
    return NextResponse.json({ success: false, error: "Could not load applications" }, { status: 500 })
  }
}
```
Create `app/api/admin/sms-platform/sender-ids/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { adminGuard } from "@/lib/sms/admin-guard"
import { listSenderIdsForAdmin } from "@/lib/sms/admin-reviews"

// GET ?status=pending|active|paused|rejected|revoked|all&scope=tenant|global|all
export async function GET(request: NextRequest) {
  const g = await adminGuard(request)
  if (!g.ok) return g.response
  const sp = request.nextUrl.searchParams
  const scope = sp.get("scope")
  try {
    const data = await listSenderIdsForAdmin(sp.get("status") ?? "all", scope === "tenant" || scope === "global" ? scope : "all")
    return NextResponse.json({ success: true, data })
  } catch (e) {
    console.error("[SMS-ADMIN] sender ids failed:", e)
    return NextResponse.json({ success: false, error: "Could not load sender IDs" }, { status: 500 })
  }
}
```
(The existing `sender-ids/[id]/route.ts` POST stays; Next allows `sender-ids/route.ts` alongside the dynamic segment folder.)

- [ ] **Step 8: Run** `npx vitest run lib/sms app` + `npx tsc --noEmit` — PASS / clean.
- [ ] **Step 9: Commit** — `feat(sms): enriched review lists and audited credit allocation` + trailer.

---

### Task 8: UI foundation — API helper, view helpers, hooks, shared pieces, header components

**Files:**
- Create: `app/admin/sms/_lib/api.ts`, `app/admin/sms/_lib/view.ts`, `app/admin/sms/_lib/view.test.ts`, `app/admin/sms/_lib/useLoad.ts`
- Create: `app/admin/sms/_components/ui-bits.tsx`, `StatCards.tsx`, `SupplyStrip.tsx`, `StatusBanner.tsx`

The old `app/admin/sms/page.tsx` stays untouched until Task 16 (the page shell is assembled last); everything here compiles on its own.

- [ ] **Step 1: Failing tests** `app/admin/sms/_lib/view.test.ts`

```ts
import { describe, it, expect } from "vitest"
import {
  formatCount, formatGhs, formatPerSms, maskIdCard, waLink, statusTone, toneClass, statusLabel, timeAgo, pageInfo,
  messageBreakdown, accountCredits, groupReviews, bannerFor, previewTotals, tabFromParam, TAB_IDS, parseList, providerLabel, supplyHeadline,
} from "./view"

describe("numbers and money", () => {
  it("formatCount", () => {
    expect(formatCount(7111)).toBe("7,111")
    expect(formatCount("1234567")).toBe("1,234,567")
    expect(formatCount(null)).toBe("0")
    expect(formatCount(12.9)).toBe("12")
  })
  it("formatGhs", () => {
    expect(formatGhs(191.5)).toBe("GH₵191.50")
    expect(formatGhs("1234.567")).toBe("GH₵1,234.57")
    expect(formatGhs(undefined)).toBe("GH₵0.00")
    expect(formatGhs(-5)).toBe("-GH₵5.00")
  })
  it("formatPerSms trims trailing zeros and guards zero units", () => {
    expect(formatPerSms(35, 1000)).toBe("GH₵0.035")
    expect(formatPerSms(150, 5000)).toBe("GH₵0.03")
    expect(formatPerSms(10, 10)).toBe("GH₵1")
    expect(formatPerSms(10, 0)).toBe("—")
  })
})

describe("ID card and WhatsApp", () => {
  it("maskIdCard shows only the last 4", () => {
    expect(maskIdCard("7890")).toBe("ID ending 7890")
    expect(maskIdCard(null)).toBe("—")
    expect(maskIdCard("12")).toBe("—")
  })
  it("waLink normalises Ghana numbers", () => {
    expect(waLink("0241234567")).toBe("https://wa.me/233241234567")
    expect(waLink("233241234567")).toBe("https://wa.me/233241234567")
    expect(waLink("+233 24 123 4567")).toBe("https://wa.me/233241234567")
    expect(waLink("123")).toBeNull()
    expect(waLink(null)).toBeNull()
  })
})

describe("status helpers", () => {
  it("statusTone", () => {
    expect(statusTone("sent")).toBe("success")
    expect(statusTone("Active")).toBe("success")
    expect(statusTone("submitted")).toBe("warning")
    expect(statusTone("failed")).toBe("danger")
    expect(statusTone("whatever")).toBe("neutral")
  })
  it("toneClass returns distinct classes", () => {
    const set = new Set((["success", "warning", "danger", "neutral"] as const).map(toneClass))
    expect(set.size).toBe(4)
  })
  it("statusLabel", () => {
    expect(statusLabel("submitted")).toBe("Under review")
    expect(statusLabel("inactive")).toBe("Not activated")
    expect(statusLabel("partial")).toBe("Partial")
    expect(statusLabel("kyc_free")).toBe("Kyc free")
  })
})

describe("timeAgo / pageInfo", () => {
  const now = Date.parse("2026-10-11T12:00:00Z")
  it("timeAgo", () => {
    expect(timeAgo("2026-10-11T11:59:50Z", now)).toBe("just now")
    expect(timeAgo("2026-10-11T11:55:00Z", now)).toBe("5 min ago")
    expect(timeAgo("2026-10-11T09:00:00Z", now)).toBe("3 h ago")
    expect(timeAgo("2026-10-09T12:00:00Z", now)).toBe("2 d ago")
    expect(timeAgo("2026-05-01T12:00:00Z", now)).toBe("2026-05-01")
    expect(timeAgo(null, now)).toBe("—")
    expect(timeAgo("junk", now)).toBe("—")
  })
  it("pageInfo", () => {
    expect(pageInfo(1, 25, 0)).toEqual({ pages: 1, from: 0, to: 0 })
    expect(pageInfo(2, 25, 57)).toEqual({ pages: 3, from: 26, to: 50 })
    expect(pageInfo(3, 25, 57)).toEqual({ pages: 3, from: 51, to: 57 })
  })
})

describe("row summaries", () => {
  it("messageBreakdown only when delivery is tracked", () => {
    expect(messageBreakdown({ tracked: 0, delivered: 0, failed: 0, pending: 0 })).toBeNull()
    expect(messageBreakdown({ tracked: "10", delivered: "7", failed: "1", pending: "2" })).toBe("7 delivered · 1 failed · 2 pending")
  })
  it("accountCredits", () => expect(accountCredits({ bought: 2000, used: "345" })).toBe("2,000 bought · 345 used"))
  it("groupReviews", () => {
    const g = groupReviews([{ status: "submitted" }, { status: "approved" }, { status: "rejected" }, { status: "draft" }, { status: "submitted" }])
    expect(g.pending).toHaveLength(2); expect(g.approved).toHaveLength(1); expect(g.rejected).toHaveLength(1)
  })
})

describe("banner / supply / preview", () => {
  const ok = { featureEnabled: true, provider: "moolre", supply: { backedCredits: 100 } }
  it("bannerFor: live, paused, supply-warning", () => {
    expect(bannerFor(ok)).toEqual({ tone: "success", text: "Live — customers can buy credits and send SMS" })
    expect(bannerFor({ ...ok, featureEnabled: false }).tone).toBe("danger")
    const w = bannerFor({ ...ok, supply: { backedCredits: 0, error: "Hubtel balance unavailable: x" } })
    expect(w.tone).toBe("warning")
    expect(w.text).toContain("Hubtel balance unavailable: x")
  })
  it("supplyHeadline + providerLabel", () => {
    expect(providerLabel("hubtel")).toBe("Hubtel")
    expect(providerLabel("moolre")).toBe("Moolre")
    expect(supplyHeadline({ backedCredits: 1200 })).toBe("1,200 credits backed")
    expect(supplyHeadline({ backedCredits: 0, error: "relay down" })).toBe("Supply unknown — relay down")
  })
  it("previewTotals sums by decision", () => {
    const t = previewTotals([{ decision: "allow", code: "OK", count: 10 }, { decision: "block", code: "LINK_NOT_ALLOWED", count: 3 }, { decision: "reject", code: "CAP_PER_SEND", count: 2 }, { decision: "error", code: "ERROR", count: 1 }])
    expect(t.total).toBe(16)
    expect(t.byDecision).toEqual({ allow: 10, block: 3, reject: 2, error: 1 })
  })
})

describe("tabs and lists", () => {
  it("tabFromParam", () => {
    expect(TAB_IDS).toHaveLength(7)
    expect(tabFromParam("accounts")).toBe("accounts")
    expect(tabFromParam("nope")).toBe("business-reviews")
    expect(tabFromParam(null)).toBe("business-reviews")
  })
  it("parseList splits on commas/newlines, trims, de-dupes case-insensitively", () => {
    expect(parseList("loan, Win Big\nLOAN ,, promo ")).toEqual(["loan", "Win Big", "promo"])
    expect(parseList("")).toEqual([])
  })
})
```

- [ ] **Step 2: Run — FAIL. Step 3: Implement `app/admin/sms/_lib/view.ts`**

```ts
/** Pure view helpers for the admin SMS Platform page (no React, no I/O — unit-tested). */

export type Tone = "success" | "warning" | "danger" | "neutral"

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const withCommas = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")

export function formatCount(v: unknown): string {
  return withCommas(Math.trunc(num(v)).toString())
}

export function formatGhs(v: unknown): string {
  const n = Math.round(num(v) * 100) / 100
  const [whole, dec] = Math.abs(n).toFixed(2).split(".")
  return `${n < 0 ? "-" : ""}GH₵${withCommas(whole)}.${dec}`
}

export function formatPerSms(priceGhs: unknown, units: unknown): string {
  const u = num(units)
  if (u <= 0) return "—"
  return `GH₵${(num(priceGhs) / u).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`
}

/** Only the last 4 digits of a Ghana Card number are ever stored. */
export function maskIdCard(last4: string | null | undefined): string {
  return last4 && /^\d{4}$/.test(last4) ? `ID ending ${last4}` : "—"
}

export function waLink(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "")
  if (d.startsWith("0") && d.length === 10) d = `233${d.slice(1)}`
  return /^233\d{9}$/.test(d) ? `https://wa.me/${d}` : null
}

const TONES: Record<string, Tone> = {
  sent: "success", active: "success", approved: "success", delivered: "success", completed: "success",
  pending: "warning", submitted: "warning", queued: "warning", sending: "warning", paused: "warning",
  held: "warning", scheduled: "warning", partial: "warning", open: "warning", inactive: "warning", info: "warning",
  failed: "danger", rejected: "danger", revoked: "danger", blocked: "danger", suspended: "danger", fraud: "danger",
  draft: "neutral", dismissed: "neutral", actioned: "neutral",
}
export function statusTone(status: string): Tone {
  return TONES[(status ?? "").toLowerCase()] ?? "neutral"
}
export function toneClass(t: Tone): string {
  switch (t) {
    case "success": return "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
    case "warning": return "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300"
    case "danger": return "border-transparent bg-red-500/15 text-red-700 dark:text-red-300"
    default: return "border-transparent bg-muted text-muted-foreground"
  }
}
const LABELS: Record<string, string> = { submitted: "Under review", inactive: "Not activated" }
export function statusLabel(status: string): string {
  const s = (status ?? "").toLowerCase()
  if (LABELS[s]) return LABELS[s]
  const t = s.replace(/_/g, " ")
  return t.charAt(0).toUpperCase() + t.slice(1)
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return "—"
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return "just now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} d ago`
  return new Date(t).toISOString().slice(0, 10)
}

export function pageInfo(page: number, pageSize: number, total: number) {
  return {
    pages: Math.max(1, Math.ceil(total / pageSize)),
    from: total === 0 ? 0 : (page - 1) * pageSize + 1,
    to: Math.min(total, page * pageSize),
  }
}

export function messageBreakdown(r: { tracked: unknown; delivered: unknown; failed: unknown; pending: unknown }): string | null {
  if (num(r.tracked) <= 0) return null
  return `${formatCount(r.delivered)} delivered · ${formatCount(r.failed)} failed · ${formatCount(r.pending)} pending`
}
export function accountCredits(r: { bought: unknown; used: unknown }): string {
  return `${formatCount(r.bought)} bought · ${formatCount(r.used)} used`
}
export function groupReviews<T extends { status: string }>(rows: T[]) {
  return {
    pending: rows.filter((r) => r.status === "submitted"),
    approved: rows.filter((r) => r.status === "approved"),
    rejected: rows.filter((r) => r.status === "rejected"),
  }
}

export function providerLabel(p: string): string {
  return p === "hubtel" ? "Hubtel" : p === "moolre" ? "Moolre" : p
}
export function supplyHeadline(s: { backedCredits: number; error?: string }): string {
  return s.error ? `Supply unknown — ${s.error}` : `${formatCount(s.backedCredits)} credits backed`
}
export function bannerFor(o: { featureEnabled: boolean; provider: string; supply: { backedCredits: number; error?: string } }): { tone: Tone; text: string } {
  if (!o.featureEnabled) return { tone: "danger", text: "Paused — customers cannot send SMS or buy credits" }
  if (o.supply.error) return { tone: "warning", text: `Live — but credit sales may be paused: ${o.supply.error}` }
  return { tone: "success", text: "Live — customers can buy credits and send SMS" }
}
export function previewTotals(rows: { decision: string; code: string; count: number }[]) {
  const byDecision: Record<string, number> = {}
  let total = 0
  for (const r of rows) { byDecision[r.decision] = (byDecision[r.decision] ?? 0) + r.count; total += r.count }
  return { total, byDecision }
}

export const TAB_IDS = ["business-reviews", "sender-ids", "flagged", "messages", "accounts", "bundles", "settings"] as const
export type TabId = (typeof TAB_IDS)[number]
export function tabFromParam(p: string | null | undefined): TabId {
  return (TAB_IDS as readonly string[]).includes(p ?? "") ? (p as TabId) : "business-reviews"
}

/** Comma/newline separated text → trimmed, de-duplicated (case-insensitive), no empties. */
export function parseList(text: string): string[] {
  const seen = new Set<string>(); const out: string[] = []
  for (const part of (text ?? "").split(/[,\n]/)) {
    const t = part.trim()
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t) }
  }
  return out
}
```
Run — PASS.

- [ ] **Step 4: `app/admin/sms/_lib/api.ts`** (types mirror the server shapes; no server imports, so the client bundle stays clean)

```ts
/** Admin fetch helpers + response shapes for the SMS Platform page. */
import { authToken } from "../../sms-centre/_lib/api"
export { api, authToken } from "../../sms-centre/_lib/api"
export type { ApiResult } from "../../sms-centre/_lib/api"

/** For legacy admin routes that don't use the {success,data} envelope (bundles, allocate). */
export async function apiRaw<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T | null }> {
  const t = await authToken()
  try {
    const res = await fetch(path, {
      ...init,
      headers: { Authorization: `Bearer ${t}`, ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers || {}) },
    })
    let body: T | null = null
    try { body = (await res.json()) as T } catch { body = null }
    return { ok: res.ok, status: res.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

export interface Page<T> { rows: T[]; total: number; page: number; pageSize: number }
export interface AccountInfo { user_id: string; email: string | null; mode: "platform" | "business"; owner_type: string }

export interface Supply { provider: "hubtel" | "moolre"; backedCredits: number; balanceGhs: number | null; ratePerSms: number | null; queuedUnsent: number | null; error?: string }
export interface OverviewData {
  stats: { recordedRevenueGhs: number; bundleRevenueGhs: number; activationRevenueGhs: number; creditsSold: number; purchases: number; pendingReviews: number; pendingSenders: number; fraudFlags: number }
  tabCounts: { businessReviews: number; senderIds: number; flagged: number }
  unrecorded: { purchases: number; credits: number }
  supply: Supply
  featureEnabled: boolean
  policyEnforced: boolean
  provider: string
  policyPreview: { decision: string; code: string; count: number }[]
}

export interface ReviewRow {
  id: string; sms_account_id: string; business_name: string | null; description: string | null; website: string | null
  whatsapp_number: string | null; ghana_card_last4: string | null; status: "draft" | "submitted" | "approved" | "rejected"
  submitted_at: string | null; reviewed_at: string | null; rejection_reason: string | null; created_at: string
  has_ghana_card_doc: boolean; has_registration_doc: boolean; account: AccountInfo | null
}
export type ReviewDetail = Omit<ReviewRow, "account"> & { ghana_card_doc_url: string | null; registration_doc_url: string | null }

export interface SenderRow {
  id: string; sender_id: string; local_status: string; kyc_free: boolean; is_pool: boolean
  approved_at: string | null; revoked_at: string | null; rejection_reason: string | null
  submitted_at: string | null; created_at: string; sms_account_id: string | null; account: AccountInfo | null
}
export interface MessageRow {
  id: number; sms_account_id: string; user_id: string; mode: string | null; sender_id: string | null; status: string
  recipients_count: number; segments: number; credits_used: number; message: string; created_at: string
  tracked: number | string; delivered: number | string; failed: number | string; pending: number | string
}
export interface AccountRow {
  id: string; user_id: string; email: string | null; owner_type: string; mode: "platform" | "business"; status: string
  unit_balance: number; bought: number | string; used: number | string; default_sender: string | null
  api_rate_limit_override: number | null; review_hold: boolean; fraud_flag_count: number; created_at: string
}
export interface FlagRow {
  id: string; source: "flag" | "legacy"; sms_account_id: string; user_id: string; severity: "fraud" | "info"
  reason: string; matched: string | null; status: string; message: string | null; created_at: string
}
export interface BundleRow {
  id: string; name: string; units: number; price_ghs: number | string; owner_type_scope: string
  active: boolean; mode: "platform" | "business"; sort_order: number; updated_at?: string
}
export interface SettingsData {
  settings: {
    featureEnabled: boolean; policyEnforced: boolean; allowedRoles: string[]; senderPool: string[]
    caps: Record<"platform" | "business", { per_send: number; per_hour: number; per_day: number }>
    blockedKeywords: string[]; businessBlockedKeywords: string[]; businessFlaggedKeywords: string[]; businessAllowedDomains: string[]
    autoSuspendFlags: number; flagReviewThreshold: number; apiRateLimitDefault: number
    hubtelCostPerSms: number; hubtelLowBalanceGhs: number
  }
  pricing: { activationFee: number; welcomeBonusCredits: number; pricePerCredit: number }
}
```

- [ ] **Step 5: `app/admin/sms/_lib/useLoad.ts`**

```ts
"use client"
import { useCallback, useEffect, useRef, useState } from "react"

/** Load data on mount and whenever `deps` change; ignores out-of-order responses. */
export function useLoad<T>(
  loader: () => Promise<{ success: boolean; data?: T; error?: string }>,
  deps: unknown[]
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    const res = await loader()
    if (mine !== seq.current) return
    if (res.success && res.data !== undefined) { setData(res.data); setError(null) }
    else setError(res.error ?? "Could not load")
    setLoading(false)
  }, deps)

  useEffect(() => { void reload() }, [reload])
  return { data, error, loading, reload }
}
```

- [ ] **Step 6: `app/admin/sms/_components/ui-bits.tsx`**

```tsx
"use client"
import { useEffect, useState, type ReactNode } from "react"
import { Check, Copy, Loader2, X } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { pageInfo, parseList, statusLabel, statusTone, toneClass } from "../_lib/view"

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge variant="outline" className={toneClass(statusTone(status))}>{label ?? statusLabel(status)}</Badge>
}

export function CopyButton({ value, title = "Copy" }: { value: string; title?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button" title={title} aria-label={title}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 1200) }
        catch { toast.error("Couldn't copy") }
      }}
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="clay-inset rounded-2xl px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
      <span>{message}</span>
      {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>}
    </div>
  )
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-24 w-full rounded-2xl" />)}</div>
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { pages, from, to } = pageInfo(page, pageSize, total)
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between gap-3 pt-2 text-sm text-muted-foreground">
      <span>{from}–{to} of {total}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</Button>
      </div>
    </div>
  )
}

/** Confirmation dialog; with `reasonLabel` it also collects a required reason (min length enforced). */
export function ConfirmDialog(props: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode
  confirmLabel: string; destructive?: boolean; busy?: boolean
  reasonLabel?: string; minReason?: number; children?: ReactNode
  onConfirm: (reason: string) => void | Promise<void>
}) {
  const [reason, setReason] = useState("")
  useEffect(() => { if (!props.open) setReason("") }, [props.open])
  const min = props.minReason ?? 3
  const needsReason = !!props.reasonLabel
  const invalid = needsReason && reason.trim().length < min
  return (
    <Dialog open={props.open} onOpenChange={(o) => { if (!props.busy) { props.onOpenChange(o); if (!o) setReason("") } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description && <DialogDescription>{props.description}</DialogDescription>}
        </DialogHeader>
        {props.children}
        {needsReason && (
          <div className="space-y-1.5">
            <label className="text-sm font-medium">{props.reasonLabel}</label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
            {invalid && reason.length > 0 && <p className="text-xs text-red-600">At least {min} characters.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={props.busy} onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button variant={props.destructive ? "destructive" : "default"} disabled={props.busy || invalid} onClick={() => void props.onConfirm(reason.trim())}>
            {props.busy && <Loader2 className="size-4 animate-spin" />}{props.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Chip list editor: type or paste comma/newline separated values; Backspace-free removal via ×. */
export function ChipsInput({ value, onChange, placeholder, transform }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; transform?: (s: string) => string
}) {
  const [text, setText] = useState("")
  function add() {
    const incoming = parseList(text).map((s) => (transform ? transform(s) : s))
    if (incoming.length === 0) return
    const seen = new Set(value.map((v) => v.toLowerCase()))
    const next = [...value]
    for (const i of incoming) if (!seen.has(i.toLowerCase())) { seen.add(i.toLowerCase()); next.push(i) }
    onChange(next); setText("")
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.length === 0 && <span className="text-sm text-muted-foreground">None</span>}
        {value.map((v) => (
          <Badge key={v} variant="secondary" className="gap-1 font-mono">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}><X className="size-3" /></button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add() } }} />
        <Button type="button" variant="outline" onClick={add}>Add</Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Header components**

`StatCards.tsx`:
```tsx
"use client"
import type { ReactNode } from "react"
import { BadgeDollarSign, Coins, ShieldAlert, ShoppingCart, Tag, UserCheck } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import type { OverviewData } from "../_lib/api"
import { formatCount, formatGhs } from "../_lib/view"

function Stat({ icon, label, value, note }: { icon: ReactNode; label: string; value: string; note?: string }) {
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="clay-icon flex size-10 shrink-0 items-center justify-center bg-primary/10 text-primary">{icon}</div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-xl font-semibold tabular-nums">{value}</p>
          {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export default function StatCards({ overview }: { overview: OverviewData }) {
  const s = overview.stats
  const u = overview.unrecorded
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <Stat icon={<BadgeDollarSign className="size-5" />} label="Recorded revenue" value={formatGhs(s.recordedRevenueGhs)}
        note={u.purchases > 0 ? `${formatCount(u.purchases)} earlier purchases (${formatCount(u.credits)} credits) have no recorded amount` : undefined} />
      <Stat icon={<Coins className="size-5" />} label="Credits sold" value={formatCount(s.creditsSold)} />
      <Stat icon={<ShoppingCart className="size-5" />} label="Purchases" value={formatCount(s.purchases)} />
      <Stat icon={<UserCheck className="size-5" />} label="Pending reviews" value={formatCount(s.pendingReviews)} />
      <Stat icon={<Tag className="size-5" />} label="Pending senders" value={formatCount(s.pendingSenders)} />
      <Stat icon={<ShieldAlert className="size-5" />} label="Fraud flags" value={formatCount(s.fraudFlags)} />
    </div>
  )
}
```
`SupplyStrip.tsx`:
```tsx
"use client"
import type { OverviewData } from "../_lib/api"
import { formatCount, formatGhs, providerLabel, supplyHeadline } from "../_lib/view"

export default function SupplyStrip({ overview }: { overview: OverviewData }) {
  const s = overview.supply
  return (
    <div className="clay-inset flex flex-wrap items-center gap-x-6 gap-y-1 rounded-2xl px-4 py-3 text-sm">
      <span className="font-medium">Supply · {providerLabel(overview.provider)}</span>
      <span className={s.error ? "text-amber-700 dark:text-amber-300" : ""}>{supplyHeadline(s)}</span>
      {s.balanceGhs !== null && <span className="text-muted-foreground">Balance {formatGhs(s.balanceGhs)}</span>}
      {s.ratePerSms !== null && <span className="text-muted-foreground">Rate GH₵{s.ratePerSms}/SMS</span>}
      {s.queuedUnsent !== null && <span className="text-muted-foreground">{formatCount(s.queuedUnsent)} queued, not yet sent</span>}
    </div>
  )
}
```
`StatusBanner.tsx`:
```tsx
"use client"
import type { OverviewData } from "../_lib/api"
import { bannerFor, toneClass } from "../_lib/view"

export default function StatusBanner({ overview }: { overview: OverviewData }) {
  const b = bannerFor(overview)
  return <div className={`rounded-2xl px-4 py-2.5 text-sm font-medium ${toneClass(b.tone)}`} role="status">{b.text}</div>
}
```

- [ ] **Step 8: Run** `npx vitest run app/admin/sms` + `npx tsc --noEmit` — PASS / clean (components must type-check; check the exact `Skeleton`, `Textarea`, `Badge` import names exist in `components/ui`).
- [ ] **Step 9: Commit** — `feat(sms): admin console UI foundation — helpers, shared pieces, header cards` + trailer.

---

### Task 9: Business Reviews tab

**Files:**
- Create: `app/admin/sms/_components/BusinessReviewsTab.tsx`

Behaviour (spec §4 / reference): one card per application (name, "Under review" badge, user email + id with copy, submitted time, current mode badge, website link, description, ID ending xxxx, "Chat 233…" WhatsApp button); buttons **View documents**, **Approve**, **Reject** (reason ≥ 5 chars). "Previously approved (n)" / "Previously rejected (n)" are collapsed and load on open. An approved application whose account is **not** in Business mode shows **Retry mode switch**. Documents open through short-lived signed links returned by the detail endpoint (which writes the audit row) — never construct links client-side.

- [ ] **Step 1: Implement `BusinessReviewsTab.tsx`**

```tsx
"use client"
import { useState } from "react"
import { ChevronDown, ChevronRight, FileText, Globe, MessageCircle } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api, type ReviewDetail, type ReviewRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { maskIdCard, timeAgo, waLink } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const BASE = "/api/admin/sms-platform/business-reviews"

function ReviewCard({ row, onChanged }: { row: ReviewRow; onChanged: () => void }) {
  const [action, setAction] = useState<null | "approve" | "reject">(null)
  const [busy, setBusy] = useState(false)
  const [docs, setDocs] = useState<ReviewDetail | null>(null)
  const wa = waLink(row.whatsapp_number)

  async function post(body: Record<string, unknown>, success: string) {
    setBusy(true)
    const res = await api(`${BASE}/${row.id}`, { method: "POST", body: JSON.stringify(body) })
    setBusy(false)
    if (res.success) toast.success(success)
    else toast.error(res.error ?? "Something went wrong")
    setAction(null)
    onChanged() // reload even on failure: an approval can be recorded while the mode switch failed
  }

  async function viewDocs() {
    setBusy(true)
    const res = await api<ReviewDetail>(`${BASE}/${row.id}`)
    setBusy(false)
    if (res.success && res.data) setDocs(res.data)
    else toast.error(res.error ?? "Could not open the documents")
  }

  const needsModeRetry = row.status === "approved" && row.account?.mode !== "business"

  return (
    <Card className="clay border-0 py-0">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{row.business_name ?? "Untitled business"}</h3>
          <StatusBadge status={row.status} />
          {row.account && <Badge variant="outline">{row.account.mode === "business" ? "Business mode" : "Platform mode"}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{row.status === "submitted" ? `Submitted ${timeAgo(row.submitted_at)}` : `Decided ${timeAgo(row.reviewed_at)}`}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1">{row.account?.email ?? "Unknown user"}{row.account && <CopyButton value={row.account.user_id} title="Copy user ID" />}</span>
          <span>{maskIdCard(row.ghana_card_last4)}</span>
          {row.website && (
            <a href={row.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
              <Globe className="size-3.5" />{row.website.replace(/^https?:\/\//, "")}
            </a>
          )}
        </div>
        {row.description && <p className="clay-inset rounded-xl px-3 py-2 text-sm">{row.description}</p>}
        {row.rejection_reason && <p className="text-sm text-red-600 dark:text-red-300">Rejected: {row.rejection_reason}</p>}

        <div className="flex flex-wrap gap-2">
          {wa && <Button asChild size="sm" variant="outline"><a href={wa} target="_blank" rel="noopener noreferrer"><MessageCircle className="size-4" />Chat {row.whatsapp_number}</a></Button>}
          {(row.has_ghana_card_doc || row.has_registration_doc) && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void viewDocs()}><FileText className="size-4" />View documents</Button>
          )}
          {row.status === "submitted" && (
            <>
              <Button size="sm" disabled={busy} onClick={() => setAction("approve")}>Approve</Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("reject")}>Reject</Button>
            </>
          )}
          {needsModeRetry && <Button size="sm" disabled={busy} onClick={() => void post({ action: "retry_mode" }, "Account switched to Business mode")}>Retry mode switch</Button>}
        </div>
      </CardContent>

      <ConfirmDialog open={action === "approve"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title={`Approve ${row.business_name ?? "this business"}?`} confirmLabel="Approve"
        description="Switches the account to Business mode (higher limits, up to 200 sender IDs) and re-activates its paused sender IDs."
        onConfirm={() => post({ action: "approve" }, "Approved")} />
      <ConfirmDialog open={action === "reject"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={5}
        title="Reject this application?" confirmLabel="Reject" reasonLabel="Reason (shown to the customer)"
        onConfirm={(reason) => post({ action: "reject", reason }, "Rejected")} />

      <Dialog open={!!docs} onOpenChange={(o) => !o && setDocs(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Documents — {row.business_name}</DialogTitle>
            <DialogDescription>Private links that expire in 5 minutes. Viewing is recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {docs?.ghana_card_doc_url
              ? <Button asChild variant="outline"><a href={docs.ghana_card_doc_url} target="_blank" rel="noopener noreferrer">Open Ghana Card</a></Button>
              : <p className="text-sm text-muted-foreground">No Ghana Card document.</p>}
            {docs?.registration_doc_url
              ? <Button asChild variant="outline"><a href={docs.registration_doc_url} target="_blank" rel="noopener noreferrer">Open registration document</a></Button>
              : <p className="text-sm text-muted-foreground">No registration document.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function ReviewList({ status, emptyTitle, onChanged }: { status: "submitted" | "approved" | "rejected"; emptyTitle: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad<ReviewRow[]>(() => api<ReviewRow[]>(`${BASE}?status=${status}`), [status])
  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  if (!data || data.length === 0) return <EmptyState title={emptyTitle} />
  return <div className="space-y-3">{data.map((r) => <ReviewCard key={r.id} row={r} onChanged={() => { void reload(); onChanged() }} />)}</div>
}

function Fold({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}{title}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  )
}

export default function BusinessReviewsTab({ onChanged }: { onChanged: () => void }) {
  return (
    <div className="space-y-5">
      <ReviewList status="submitted" emptyTitle="No applications waiting for review" onChanged={onChanged} />
      <Fold title="Previously approved"><ReviewList status="approved" emptyTitle="Nothing approved yet" onChanged={onChanged} /></Fold>
      <Fold title="Previously rejected"><ReviewList status="rejected" emptyTitle="Nothing rejected" onChanged={onChanged} /></Fold>
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean (this task has no new pure logic beyond Task 8's tested helpers).
- [ ] **Step 3: Commit** — `feat(sms): admin Business Reviews tab` + trailer.

---

### Task 10: Sender IDs tab

**Files:**
- Create: `app/admin/sms/_components/SenderIdsTab.tsx`

Behaviour: "Under review (n)" rows (name in monospace + copy, user email/id, account mode, requested time, **Approve** / **Reject**), "Approved (n)" with **Revoke**, "Paused until verified (n)", collapsed "Rejected / revoked". Approve is disabled with an explanation unless the active provider is Hubtel (the server refuses regardless). Admin-global senders (no account) are listed read-only under "Platform senders" and managed in SMS Centre.

- [ ] **Step 1: Implement `SenderIdsTab.tsx`**

```tsx
"use client"
import { useMemo, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { api, type SenderRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { timeAgo } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const ACT = "/api/admin/sms-platform/sender-ids"

function SenderLine({ row, approvalsReady, onChanged }: { row: SenderRow; approvalsReady: boolean; onChanged: () => void }) {
  const [action, setAction] = useState<null | "approve" | "reject" | "revoke">(null)
  const [busy, setBusy] = useState(false)

  async function run(act: "approve" | "reject" | "revoke", reason?: string) {
    setBusy(true)
    const res = await api(`${ACT}/${row.id}`, { method: "POST", body: JSON.stringify({ action: act, reason }) })
    setBusy(false)
    if (res.success) toast.success(act === "approve" ? "Sender ID approved" : act === "reject" ? "Request rejected" : "Sender ID revoked")
    else toast.error(res.error ?? "Something went wrong")
    setAction(null)
    onChanged()
  }

  const tenant = !!row.sms_account_id
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <div className="flex min-w-0 items-center gap-1">
          <span className="font-mono text-base font-semibold">{row.sender_id}</span>
          <CopyButton value={row.sender_id} title="Copy sender ID" />
        </div>
        <StatusBadge status={row.local_status} />
        {row.kyc_free && <Badge variant="secondary">Free ID</Badge>}
        {row.is_pool && <Badge variant="secondary">Pool</Badge>}
        <div className="min-w-0 text-sm text-muted-foreground">
          {tenant ? (
            <span className="inline-flex items-center gap-1">{row.account?.email ?? "Unknown user"}{row.account && <CopyButton value={row.account.user_id} title="Copy user ID" />}
              {row.account && <span>· {row.account.mode === "business" ? "Business" : "Platform"}</span>}</span>
          ) : <span>Platform sender (managed in SMS Centre)</span>}
        </div>
        <span className="text-xs text-muted-foreground">
          {row.local_status === "pending" ? `Requested ${timeAgo(row.submitted_at ?? row.created_at)}`
            : row.local_status === "active" ? `Approved ${timeAgo(row.approved_at)}`
            : row.revoked_at ? `Revoked ${timeAgo(row.revoked_at)}` : ""}
        </span>
        {row.rejection_reason && <span className="text-xs text-red-600 dark:text-red-300">{row.rejection_reason}</span>}

        {tenant && (
          <div className="ml-auto flex gap-2">
            {row.local_status === "pending" && (
              <>
                <Button size="sm" disabled={busy || !approvalsReady} onClick={() => setAction("approve")}>Approve</Button>
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("reject")}>Reject</Button>
              </>
            )}
            {(row.local_status === "active" || row.local_status === "paused") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction("revoke")}>Revoke</Button>
            )}
          </div>
        )}
      </CardContent>

      <ConfirmDialog open={action === "approve"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title={`Approve ${row.sender_id}?`} confirmLabel="Approve"
        description="The name becomes active immediately for this account. No two accounts can hold the same active name."
        onConfirm={() => run("approve")} />
      <ConfirmDialog open={action === "reject"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={3}
        title={`Reject ${row.sender_id}?`} confirmLabel="Reject" reasonLabel="Reason (shown to the customer)"
        onConfirm={(reason) => run("reject", reason)} />
      <ConfirmDialog open={action === "revoke"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive minReason={3}
        title={`Revoke ${row.sender_id}?`} confirmLabel="Revoke" reasonLabel="Reason (kept in the audit log)"
        description="The customer can no longer send with this name. If it was their default, they fall back to the platform sender."
        onConfirm={(reason) => run("revoke", reason)} />
    </Card>
  )
}

function Group({ title, rows, approvalsReady, onChanged, empty }: { title: string; rows: SenderRow[]; approvalsReady: boolean; onChanged: () => void; empty?: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title} ({rows.length})</h3>
      {rows.length === 0 ? (empty ? <EmptyState title={empty} /> : null) : rows.map((r) => <SenderLine key={r.id} row={r} approvalsReady={approvalsReady} onChanged={onChanged} />)}
    </section>
  )
}

export default function SenderIdsTab({ provider, onChanged }: { provider: string; onChanged: () => void }) {
  const { data, error, loading, reload } = useLoad<SenderRow[]>(() => api<SenderRow[]>(`${ACT}?status=all&scope=all`), [])
  const [showOld, setShowOld] = useState(false)
  const changed = () => { void reload(); onChanged() }
  const g = useMemo(() => {
    const rows = data ?? []
    return {
      pending: rows.filter((r) => r.local_status === "pending" && r.sms_account_id),
      active: rows.filter((r) => r.local_status === "active" && r.sms_account_id),
      paused: rows.filter((r) => r.local_status === "paused"),
      old: rows.filter((r) => (r.local_status === "rejected" || r.local_status === "revoked") && r.sms_account_id),
      platform: rows.filter((r) => !r.sms_account_id),
    }
  }, [data])
  const approvalsReady = provider === "hubtel"

  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  return (
    <div className="space-y-6">
      {!approvalsReady && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
          Approving new sender IDs is available once Hubtel is the active SMS provider — Moolre and mNotify wouldn&apos;t recognise a newly approved name, so campaigns using it would fail. Requests stay safely in the queue until then.
        </div>
      )}
      <Group title="Under review" rows={g.pending} approvalsReady={approvalsReady} onChanged={changed} empty="No sender IDs waiting for review" />
      <Group title="Approved" rows={g.active} approvalsReady={approvalsReady} onChanged={changed} />
      <Group title="Paused until verified" rows={g.paused} approvalsReady={approvalsReady} onChanged={changed} />
      {g.platform.length > 0 && <Group title="Platform senders" rows={g.platform} approvalsReady={approvalsReady} onChanged={changed} />}
      {g.old.length > 0 && (
        <div>
          <button type="button" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" onClick={() => setShowOld((o) => !o)}>
            {showOld ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}Rejected / revoked ({g.old.length})
          </button>
          {showOld && <div className="mt-3"><Group title="Rejected / revoked" rows={g.old} approvalsReady={approvalsReady} onChanged={changed} /></div>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean.
- [ ] **Step 3: Commit** — `feat(sms): admin Sender IDs tab` + trailer.

---

### Task 11: Flagged tab (with Policy preview)

**Files:**
- Create: `app/admin/sms/_components/FlaggedTab.tsx`

Behaviour: top card **Policy preview — last 7 days** (record-only; what the new rules *would* have done, from `overview.policyPreview`); below it severity chips **All / Fraud / Info** with counts and the open-flag list (message bubble, reason, matched text, user, time) with **Dismiss** and **Suspend account** (both confirm). Phase 1 creates no new flags, so today this shows legacy content-filter flags and an empty "Nothing flagged — all clear". Held-campaign release/reject is Phase 3.

- [ ] **Step 1: Implement `FlaggedTab.tsx`**

```tsx
"use client"
import { useState } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { api, type FlagRow, type OverviewData, type Page } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, previewTotals, timeAgo, toneClass } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

const DECISION_TEXT: Record<string, string> = {
  allow: "would pass", hold: "would be held", reject: "would be rejected", block: "would be blocked",
  unavailable: "would be refused (switch off)", error: "could not be scored",
}
const DECISION_ORDER = ["allow", "hold", "reject", "block", "unavailable", "error"]

function PolicyPreview({ rows }: { rows: OverviewData["policyPreview"] }) {
  const t = previewTotals(rows)
  const attention = rows.filter((r) => r.code !== "OK")
  return (
    <Card className="clay border-0 py-0">
      <CardHeader className="pb-2 pt-4">
        <CardTitle className="text-base">Policy preview — last 7 days</CardTitle>
        <CardDescription>
          What the new sending rules <em>would</em> have done. Record-only: nothing was blocked, capped or flagged. Use it to tune limits and keyword lists before enforcement ships.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pb-4">
        {t.total === 0 ? (
          <p className="text-sm text-muted-foreground">No sends recorded yet — this fills in as customers send.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{formatCount(t.total)} sends evaluated</Badge>
              {DECISION_ORDER.filter((d) => t.byDecision[d]).map((d) => (
                <Badge key={d} variant="outline" className={toneClass(d === "allow" ? "success" : d === "hold" || d === "unavailable" ? "warning" : "danger")}>
                  {formatCount(t.byDecision[d])} {DECISION_TEXT[d] ?? d}
                </Badge>
              ))}
            </div>
            {attention.length > 0 && (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {attention.map((r) => <li key={`${r.decision}-${r.code}`}><span className="font-mono">{r.code}</span> — {formatCount(r.count)}</li>)}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

type Severity = "" | "fraud" | "info"

function FlagCard({ row, onChanged }: { row: FlagRow; onChanged: () => void }) {
  const [action, setAction] = useState<null | "dismiss" | "suspend">(null)
  const [busy, setBusy] = useState(false)
  async function run(kind: "dismiss" | "suspend") {
    setBusy(true)
    const res = await api(`/api/admin/sms-platform/flags/${row.id}`, { method: "POST", body: JSON.stringify({ source: row.source, action: kind }) })
    setBusy(false)
    if (res.success) toast.success(kind === "dismiss" ? "Flag dismissed" : "Account suspended")
    else toast.error(res.error ?? "Something went wrong")
    setAction(null)
    onChanged()
  }
  return (
    <Card className="clay border-0 py-0">
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={row.severity} label={row.severity === "fraud" ? "Fraud" : "Info"} />
          <span className="text-sm font-medium">{row.reason}</span>
          {row.matched && <Badge variant="secondary" className="font-mono">{row.matched}</Badge>}
          <span className="ml-auto text-xs text-muted-foreground">{timeAgo(row.created_at)}</span>
        </div>
        {row.message && <p className="clay-inset line-clamp-4 rounded-xl px-3 py-2 text-sm">{row.message}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">User <span className="font-mono">{row.user_id.slice(0, 8)}…</span><CopyButton value={row.user_id} title="Copy user ID" /></span>
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAction("dismiss")}>Dismiss</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => setAction("suspend")}>Suspend account</Button>
          </div>
        </div>
      </CardContent>
      <ConfirmDialog open={action === "dismiss"} onOpenChange={(o) => !o && setAction(null)} busy={busy}
        title="Dismiss this flag?" confirmLabel="Dismiss" description="Marks it reviewed; the account is not changed."
        onConfirm={() => run("dismiss")} />
      <ConfirmDialog open={action === "suspend"} onOpenChange={(o) => !o && setAction(null)} busy={busy} destructive
        title="Suspend this account?" confirmLabel="Suspend"
        description="The customer can't send SMS until you unsuspend them in the Accounts tab. The flag is marked as actioned."
        onConfirm={() => run("suspend")} />
    </Card>
  )
}

export default function FlaggedTab({ overview, onChanged }: { overview: OverviewData; onChanged: () => void }) {
  const [severity, setSeverity] = useState<Severity>("")
  const [page, setPage] = useState(1)
  const { data, error, loading, reload } = useLoad<Page<FlagRow>>(
    () => api<Page<FlagRow>>(`/api/admin/sms-platform/flags?severity=${severity}&status=open&page=${page}`), [severity, page])
  const fraud = overview.stats.fraudFlags
  const all = overview.tabCounts.flagged
  const chips: { id: Severity; label: string; n: number }[] = [
    { id: "", label: "All", n: all }, { id: "fraud", label: "Fraud", n: fraud }, { id: "info", label: "Info", n: Math.max(0, all - fraud) },
  ]
  return (
    <div className="space-y-4">
      <PolicyPreview rows={overview.policyPreview} />
      <div className="flex flex-wrap gap-2">
        {chips.map((c) => (
          <Button key={c.label} size="sm" variant={severity === c.id ? "default" : "outline"} onClick={() => { setSeverity(c.id); setPage(1) }}>
            {c.label} <span className="opacity-70">{formatCount(c.n)}</span>
          </Button>
        ))}
      </div>
      {loading && !data ? <LoadingRows /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || data.rows.length === 0 ? <EmptyState title="Nothing flagged — all clear" />
        : (<>
          <div className="space-y-3">{data.rows.map((r) => <FlagCard key={`${r.source}-${r.id}`} row={r} onChanged={() => { void reload(); onChanged() }} />)}</div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>)}
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean. **Step 3: Commit** — `feat(sms): admin Flagged tab with policy preview` + trailer.

---

### Task 12: Messages tab

**Files:**
- Create: `app/admin/sms/_components/MessagesTab.tsx`

Behaviour: search box (sender, message text, user id; debounced 350 ms) + status filter; one card per send: sender (monospace, or "Platform sender"), mode badge, status badge, recipients + time, user id (copy), message in a bubble, and — **only for Hubtel-tracked sends** — the delivery breakdown. Paged 25, newest first.

- [ ] **Step 1: Implement `MessagesTab.tsx`**

```tsx
"use client"
import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { api, type MessageRow, type Page } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, messageBreakdown, timeAgo } from "../_lib/view"
import { CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

const STATUSES = ["queued", "sending", "sent", "partial", "failed", "blocked", "held", "scheduled"]

export default function MessagesTab() {
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  const [status, setStatus] = useState("")
  const [page, setPage] = useState(1)

  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [text])

  const { data, error, loading, reload } = useLoad<Page<MessageRow>>(
    () => api<Page<MessageRow>>(`/api/admin/sms-platform/messages?q=${encodeURIComponent(q)}&status=${status}&page=${page}`), [q, status, page])

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search sender, message or user ID" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <Select value={status || "all"} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1) }}>
          <SelectTrigger className="sm:w-44"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUSES.map((s) => <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {loading && !data ? <LoadingRows rows={4} /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || data.rows.length === 0 ? <EmptyState title="No messages found" hint={q || status ? "Try a different search or filter." : undefined} />
        : (<>
          <div className="space-y-3">
            {data.rows.map((m) => {
              const breakdown = messageBreakdown(m)
              return (
                <Card key={m.id} className="clay border-0 py-0">
                  <CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold">{m.sender_id ?? "Platform sender"}</span>
                      {m.mode && <Badge variant="outline">{m.mode === "business" ? "Business" : "Platform"}</Badge>}
                      <StatusBadge status={m.status} />
                      <span className="ml-auto text-xs text-muted-foreground">{formatCount(m.recipients_count)} recipients · {timeAgo(m.created_at)}</span>
                    </div>
                    <p className="clay-inset line-clamp-5 whitespace-pre-wrap rounded-xl px-3 py-2 text-sm">{m.message}</p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">User <span className="font-mono">{m.user_id.slice(0, 8)}…</span><CopyButton value={m.user_id} title="Copy user ID" /></span>
                      <span>{formatCount(m.credits_used)} credits used · {m.segments} segment{m.segments === 1 ? "" : "s"}</span>
                      {breakdown && <span>{breakdown}</span>}
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>)}
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean. **Step 3: Commit** — `feat(sms): admin Messages tab` + trailer.

---

### Task 13: Accounts tab

**Files:**
- Create: `app/admin/sms/_components/AccountsTab.tsx`

Behaviour: search (user id, email, sender, mode, status); a table on `md+` and stacked cards on mobile showing User (copy) · Mode · Status · Credits ("X bought · Y used") · Default sender · API-limit override; per-row actions: **Suspend / Unsuspend**, **Change mode** (dialog explains what happens to sender IDs), **API limit** (number, empty = platform default), **Allocate credits** (integer 1–1,000,000; may land as pending when supply is short). All actions refresh the list and the page overview.

- [ ] **Step 1: Implement `AccountsTab.tsx`**

```tsx
"use client"
import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { api, apiRaw, type AccountRow, type Page } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { accountCredits, formatCount } from "../_lib/view"
import { ConfirmDialog, CopyButton, EmptyState, ErrorBox, LoadingRows, Pager, StatusBadge } from "./ui-bits"

type Dialog = null | { kind: "suspend" | "mode" | "limit" | "allocate"; row: AccountRow }

function Actions({ row, open }: { row: AccountRow; open: (d: Dialog) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.status !== "inactive" && (
        <Button size="sm" variant={row.status === "suspended" ? "default" : "outline"} onClick={() => open({ kind: "suspend", row })}>
          {row.status === "suspended" ? "Unsuspend" : "Suspend"}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => open({ kind: "mode", row })}>Change mode</Button>
      <Button size="sm" variant="outline" onClick={() => open({ kind: "limit", row })}>API limit</Button>
      <Button size="sm" variant="outline" onClick={() => open({ kind: "allocate", row })}>Allocate credits</Button>
    </div>
  )
}

function UserCell({ row }: { row: AccountRow }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-sm font-medium">{row.email ?? "No email"}</div>
      <div className="flex items-center gap-1 text-xs text-muted-foreground"><span className="font-mono">{row.user_id.slice(0, 8)}…</span><CopyButton value={row.user_id} title="Copy user ID" /></div>
    </div>
  )
}

export default function AccountsTab({ onChanged }: { onChanged: () => void }) {
  const [text, setText] = useState("")
  const [q, setQ] = useState("")
  const [page, setPage] = useState(1)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [input, setInput] = useState("")

  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [text])

  const { data, error, loading, reload } = useLoad<Page<AccountRow>>(
    () => api<Page<AccountRow>>(`/api/admin/sms-platform/accounts?q=${encodeURIComponent(q)}&page=${page}`), [q, page])

  function open(d: Dialog) {
    setInput(d?.kind === "limit" ? String(d.row.api_rate_limit_override ?? "") : "")
    setDialog(d)
  }
  function done(message: string) { toast.success(message); setDialog(null); void reload(); onChanged() }

  async function confirm() {
    if (!dialog) return
    const { kind, row } = dialog
    setBusy(true)
    try {
      if (kind === "suspend") {
        const res = await api("/api/admin/shop-sms", { method: "POST", body: JSON.stringify({ action: "set_suspended", accountId: row.id, suspended: row.status !== "suspended" }) })
        if (!res.success) return void toast.error(res.error ?? "Could not update the account")
        done(row.status === "suspended" ? "Account unsuspended" : "Account suspended")
      } else if (kind === "mode") {
        const res = await api(`/api/admin/sms-platform/accounts/${row.id}`, { method: "PATCH", body: JSON.stringify({ mode: row.mode === "business" ? "platform" : "business" }) })
        if (!res.success) return void toast.error(res.error ?? "Could not change the mode")
        done(`Account is now in ${row.mode === "business" ? "Platform" : "Business"} mode`)
      } else if (kind === "limit") {
        const trimmed = input.trim()
        const value = trimmed === "" ? null : Number(trimmed)
        if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 10000)) return void toast.error("Enter a whole number from 1 to 10,000, or leave empty for the default")
        const res = await api(`/api/admin/sms-platform/accounts/${row.id}`, { method: "PATCH", body: JSON.stringify({ api_rate_limit_override: value }) })
        if (!res.success) return void toast.error(res.error ?? "Could not save the limit")
        done(value === null ? "Using the platform default limit" : `Limit set to ${value} requests/minute`)
      } else {
        const units = Number(input)
        if (!Number.isInteger(units) || units < 1 || units > 1_000_000) return void toast.error("Enter a whole number from 1 to 1,000,000")
        const res = await apiRaw<{ success?: boolean; pending?: boolean; unitsCredited?: number; error?: string }>("/api/admin/sms/allocate", { method: "POST", body: JSON.stringify({ accountId: row.id, units }) })
        if (!res.ok || !res.body?.success) return void toast.error(res.body?.error ?? "Could not allocate credits")
        done(res.body.pending ? "Queued as pending — SMS supply is short, it will be credited when supply allows" : `Allocated ${formatCount(res.body.unitsCredited ?? units)} credits`)
      }
    } finally { setBusy(false) }
  }

  const row = dialog?.row
  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" placeholder="Search user ID, email, sender, mode or status" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      {loading && !data ? <LoadingRows rows={4} /> : error && !data ? <ErrorBox message={error} onRetry={reload} />
        : !data || data.rows.length === 0 ? <EmptyState title="No accounts found" />
        : (<>
          <div className="clay hidden overflow-hidden md:block">
            <Table>
              <TableHeader><TableRow>
                <TableHead>User</TableHead><TableHead>Mode</TableHead><TableHead>Status</TableHead><TableHead>Credits</TableHead><TableHead>Default sender</TableHead><TableHead>Actions</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell><UserCell row={r} /></TableCell>
                    <TableCell><Badge variant="outline">{r.mode === "business" ? "Business" : "Platform"}</Badge></TableCell>
                    <TableCell><StatusBadge status={r.status} />{r.review_hold && <Badge variant="destructive" className="ml-1">Review hold</Badge>}</TableCell>
                    <TableCell className="text-sm"><div className="font-medium tabular-nums">{formatCount(r.unit_balance)}</div><div className="text-xs text-muted-foreground">{accountCredits(r)}</div></TableCell>
                    <TableCell className="font-mono text-sm">{r.default_sender ?? "—"}{r.api_rate_limit_override != null && <div className="font-sans text-xs text-muted-foreground">API {r.api_rate_limit_override}/min</div>}</TableCell>
                    <TableCell><Actions row={r} open={open} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="space-y-3 md:hidden">
            {data.rows.map((r) => (
              <Card key={r.id} className="clay border-0 py-0"><CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2"><UserCell row={r} /><div className="flex shrink-0 gap-1"><Badge variant="outline">{r.mode === "business" ? "Business" : "Platform"}</Badge><StatusBadge status={r.status} /></div></div>
                <div className="text-sm"><span className="font-semibold tabular-nums">{formatCount(r.unit_balance)}</span> credits <span className="text-xs text-muted-foreground">· {accountCredits(r)}</span></div>
                <div className="text-xs text-muted-foreground">Sender <span className="font-mono">{r.default_sender ?? "—"}</span>{r.api_rate_limit_override != null && ` · API ${r.api_rate_limit_override}/min`}</div>
                <Actions row={r} open={open} />
              </CardContent></Card>
            ))}
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </>)}

      <ConfirmDialog open={dialog?.kind === "suspend"} onOpenChange={(o) => !o && setDialog(null)} busy={busy} destructive={row?.status !== "suspended"}
        title={row?.status === "suspended" ? "Unsuspend this account?" : "Suspend this account?"} confirmLabel={row?.status === "suspended" ? "Unsuspend" : "Suspend"}
        description={row?.status === "suspended" ? "The customer can send SMS again." : "The customer can't send SMS or buy credits until you unsuspend them."}
        onConfirm={confirm} />
      <ConfirmDialog open={dialog?.kind === "mode"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title={row?.mode === "business" ? "Switch to Platform mode?" : "Switch to Business mode?"} confirmLabel="Switch mode"
        description={row?.mode === "business"
          ? "Keeps the account's one free sender ID active and pauses the rest; lowers sending limits and restricts links to the customer's Datagod store."
          : "Re-activates paused sender IDs and raises sending limits (up to 200 sender IDs). Normally done by approving the customer's business verification."}
        onConfirm={confirm} />
      <ConfirmDialog open={dialog?.kind === "limit"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="API rate limit" confirmLabel="Save" description="Requests per minute for this account on the public SMS API. Leave empty to use the platform default."
        onConfirm={confirm}>
        <Input inputMode="numeric" placeholder="Platform default" value={input} onChange={(e) => setInput(e.target.value)} />
      </ConfirmDialog>
      <ConfirmDialog open={dialog?.kind === "allocate"} onOpenChange={(o) => !o && setDialog(null)} busy={busy}
        title="Allocate credits" confirmLabel="Allocate" description="Adds credits to this account. It is checked against real SMS supply and recorded in the audit log."
        onConfirm={confirm}>
        <Input inputMode="numeric" placeholder="Number of credits (1–1,000,000)" value={input} onChange={(e) => setInput(e.target.value)} />
      </ConfirmDialog>
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean. **Step 3: Commit** — `feat(sms): admin Accounts tab` + trailer.

---

### Task 14: Bundles tab

**Files:**
- Create: `app/admin/sms/_components/BundlesTab.tsx`

Behaviour: grouped **Platform (n)** and **Business (n)**; a card per bundle with name, Active/Inactive badge, credits, price, **per-SMS price**, sort order, scope; **Edit**, **Deactivate/Activate**, **Delete** (the server only allows it after 48 h inactive and says why otherwise), and **New bundle**. The bundle routes are legacy (`{ bundles }` / `{ error }` envelopes), so this tab uses `apiRaw`.

- [ ] **Step 1: Implement `BundlesTab.tsx`**

```tsx
"use client"
import { useState } from "react"
import { Plus } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { apiRaw, type BundleRow } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { formatCount, formatGhs, formatPerSms } from "../_lib/view"
import { ConfirmDialog, EmptyState, ErrorBox, LoadingRows, StatusBadge } from "./ui-bits"

const URL = "/api/admin/sms/bundles"
const SCOPES = ["all", "shop", "sub_agent", "individual", "platform"]
interface Draft { id?: string; name: string; units: string; price: string; sort: string; mode: "platform" | "business"; scope: string }
const blank = (mode: "platform" | "business"): Draft => ({ name: "", units: "", price: "", sort: "0", mode, scope: "all" })

export default function BundlesTab() {
  const { data, error, loading, reload } = useLoad<BundleRow[]>(async () => {
    const r = await apiRaw<{ bundles?: BundleRow[]; error?: string }>(URL)
    return r.ok && r.body?.bundles ? { success: true, data: r.body.bundles } : { success: false, error: r.body?.error ?? "Could not load bundles" }
  }, [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [del, setDel] = useState<BundleRow | null>(null)
  const [busy, setBusy] = useState(false)

  async function call(path: string, init: RequestInit, ok: string) {
    setBusy(true)
    const r = await apiRaw<{ error?: string }>(path, init)
    setBusy(false)
    if (r.ok) { toast.success(ok); void reload(); return true }
    toast.error(r.body?.error ?? "Something went wrong")
    return false
  }

  async function save() {
    if (!draft) return
    const units = Number(draft.units), price = Number(draft.price), sort = Number(draft.sort)
    if (!draft.name.trim()) return void toast.error("Give the bundle a name")
    if (!Number.isInteger(units) || units < 1) return void toast.error("Credits must be a whole number above 0")
    if (!Number.isFinite(price) || price < 0) return void toast.error("Enter a valid price")
    if (!Number.isInteger(sort)) return void toast.error("Sort order must be a whole number")
    const body = { name: draft.name.trim(), units, price_ghs: price, sort_order: sort, mode: draft.mode, owner_type_scope: draft.scope }
    const ok = draft.id
      ? await call(URL, { method: "PATCH", body: JSON.stringify({ id: draft.id, ...body }) }, "Bundle updated")
      : await call(URL, { method: "POST", body: JSON.stringify(body) }, "Bundle created")
    if (ok) setDraft(null)
  }

  if (loading && !data) return <LoadingRows />
  if (error && !data) return <ErrorBox message={error} onRetry={reload} />
  const groups: { mode: "platform" | "business"; title: string }[] = [{ mode: "platform", title: "Platform" }, { mode: "business", title: "Business" }]

  return (
    <div className="space-y-6">
      <div className="flex justify-end"><Button onClick={() => setDraft(blank("platform"))}><Plus className="size-4" />New bundle</Button></div>
      {groups.map(({ mode, title }) => {
        const rows = (data ?? []).filter((b) => b.mode === mode)
        return (
          <section key={mode} className="space-y-2">
            <h3 className="text-sm font-semibold">{title} ({rows.length})</h3>
            {rows.length === 0 ? <EmptyState title={`No ${title.toLowerCase()} bundles`} /> : (
              <div className="grid gap-3 lg:grid-cols-2">
                {rows.map((b) => (
                  <Card key={b.id} className="clay border-0 py-0"><CardContent className="space-y-2 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold">{b.name}</h4>
                      <StatusBadge status={b.active ? "active" : "inactive"} label={b.active ? "Active" : "Inactive"} />
                      {b.owner_type_scope !== "all" && <Badge variant="secondary">{b.owner_type_scope}</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {formatCount(b.units)} credits · {formatGhs(b.price_ghs)} · {formatPerSms(b.price_ghs, b.units)}/SMS · sort {b.sort_order}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setDraft({ id: b.id, name: b.name, units: String(b.units), price: String(b.price_ghs), sort: String(b.sort_order), mode: b.mode, scope: b.owner_type_scope })}>Edit</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void call(URL, { method: "PATCH", body: JSON.stringify({ id: b.id, active: !b.active }) }, b.active ? "Bundle deactivated" : "Bundle activated")}>
                        {b.active ? "Deactivate" : "Activate"}
                      </Button>
                      {!b.active && <Button size="sm" variant="destructive" onClick={() => setDel(b)}>Delete</Button>}
                    </div>
                  </CardContent></Card>
                ))}
              </div>
            )}
          </section>
        )
      })}

      <Dialog open={!!draft} onOpenChange={(o) => !o && !busy && setDraft(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{draft?.id ? "Edit bundle" : "New bundle"}</DialogTitle><DialogDescription>Customers only see bundles for their own mode.</DialogDescription></DialogHeader>
          {draft && (
            <div className="grid gap-3">
              <Input placeholder="Name, e.g. Starter - 1,000 SMS" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <div className="grid grid-cols-2 gap-3">
                <Input inputMode="numeric" placeholder="Credits" value={draft.units} onChange={(e) => setDraft({ ...draft, units: e.target.value })} />
                <Input inputMode="decimal" placeholder="Price (GH₵)" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Input inputMode="numeric" placeholder="Sort" value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: e.target.value })} />
                <Select value={draft.mode} onValueChange={(v) => setDraft({ ...draft, mode: v as "platform" | "business" })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="platform">Platform</SelectItem><SelectItem value="business">Business</SelectItem></SelectContent>
                </Select>
                <Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{SCOPES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {Number(draft.units) > 0 && Number(draft.price) >= 0 && draft.price !== "" && <p className="text-xs text-muted-foreground">≈ {formatPerSms(draft.price, draft.units)} per SMS</p>}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button>
            <Button disabled={busy} onClick={() => void save()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={!!del} onOpenChange={(o) => !o && setDel(null)} busy={busy} destructive
        title={`Delete ${del?.name ?? "bundle"}?`} confirmLabel="Delete"
        description="Only possible 48 hours after a bundle was deactivated, so payments already in progress can still be credited. Past purchases are not affected."
        onConfirm={async () => { if (del && (await call(`${URL}?id=${encodeURIComponent(del.id)}`, { method: "DELETE" }, "Bundle deleted"))) setDel(null) }} />
    </div>
  )
}
```

- [ ] **Step 2: Run** `npx tsc --noEmit` — clean. **Step 3: Commit** — `feat(sms): admin Bundles tab` + trailer.

---

### Task 15: Settings tab (section components)

**Files:**
- Create: `app/admin/sms/_components/SettingsSections.tsx`, `app/admin/sms/_components/SettingsTab.tsx`

Each section is its own card that **saves independently** through `PATCH /api/admin/sms-platform/settings` `{ section, values }` (Task 5) and shows the server's validation message on failure. Sections: Sender ID pool, Allowed roles, Sending caps (per mode), Blocked keywords (platform), Business lists, Moderation thresholds, SMS API rate limit, Pricing & activation, Hubtel supply thresholds, plus read-only Provider and Enforcement notes. The master switch lives in the page header (Task 16), not here.

- [ ] **Step 1: Implement `SettingsSections.tsx`**

```tsx
"use client"
import { useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { api, type SettingsData } from "../_lib/api"
import { ChipsInput } from "./ui-bits"

type S = SettingsData["settings"]
type Saved = (d: SettingsData) => void

function useSectionSave(section: string, onSaved: Saved) {
  const [saving, setSaving] = useState(false)
  async function save(values: unknown) {
    setSaving(true)
    const res = await api<SettingsData>("/api/admin/sms-platform/settings", { method: "PATCH", body: JSON.stringify({ section, values }) })
    setSaving(false)
    if (res.success && res.data) { toast.success("Saved"); onSaved(res.data) }
    else toast.error(res.error ?? "Could not save")
  }
  return { saving, save }
}

function SectionCard({ title, description, saving, onSave, children }: { title: string; description: string; saving: boolean; onSave: () => void; children: ReactNode }) {
  return (
    <Card className="clay border-0 py-0">
      <CardHeader className="pb-2 pt-4"><CardTitle className="text-base">{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
      <CardContent className="space-y-4 pb-4">
        {children}
        <Button size="sm" disabled={saving} onClick={onSave}>{saving && <Loader2 className="size-4 animate-spin" />}Save</Button>
      </CardContent>
    </Card>
  )
}

function NumField({ label, value, onChange, hint, step }: { label: string; value: string; onChange: (v: string) => void; hint?: string; step?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <Input inputMode="decimal" step={step} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function SenderPoolSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("sender_pool", onSaved)
  const [pool, setPool] = useState(s.senderPool)
  return (
    <SectionCard title="Sender ID pool" description="Shared names verified businesses can send as, without registering their own (3–11 letters/numbers)." saving={saving} onSave={() => void save({ senderPool: pool })}>
      <ChipsInput value={pool} onChange={setPool} placeholder="e.g. DATAGOD, ALERTS" transform={(x) => x.toUpperCase()} />
    </SectionCard>
  )
}

const ROLE_LABELS: Record<string, string> = { shop_owner: "Shop owners", sub_agent: "Sub-agents", dealer: "Dealers without a shop", user: "Other users without a shop" }
export function RolesSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("roles", onSaved)
  const [roles, setRoles] = useState(s.allowedRoles)
  const toggle = (r: string) => setRoles((cur) => (cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]))
  return (
    <SectionCard title="Allowed roles" description="Who can use SMS. Admins always can. Removing a role doesn't delete existing accounts." saving={saving} onSave={() => void save({ allowedRoles: roles })}>
      <div className="grid gap-2 sm:grid-cols-2">
        {Object.entries(ROLE_LABELS).map(([r, label]) => (
          <label key={r} className="flex items-center gap-2 text-sm"><Checkbox checked={roles.includes(r)} onCheckedChange={() => toggle(r)} />{label}</label>
        ))}
      </div>
      {roles.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">No roles selected — only admins would be able to use SMS once enforcement is on.</p>}
    </SectionCard>
  )
}

export function CapsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("caps", onSaved)
  const init = (m: "platform" | "business") => ({ per_send: String(s.caps[m].per_send), per_hour: String(s.caps[m].per_hour), per_day: String(s.caps[m].per_day) })
  const [v, setV] = useState({ platform: init("platform"), business: init("business") })
  const set = (m: "platform" | "business", k: "per_send" | "per_hour" | "per_day", val: string) => setV((p) => ({ ...p, [m]: { ...p[m], [k]: val } }))
  const nums = (m: "platform" | "business") => ({ per_send: Number(v[m].per_send), per_hour: Number(v[m].per_hour), per_day: Number(v[m].per_day) })
  return (
    <SectionCard title="Sending caps" description="Per-mode limits. Recorded in the policy preview now; enforced from Phase 3." saving={saving} onSave={() => void save({ platform: nums("platform"), business: nums("business") })}>
      <div className="grid gap-6 lg:grid-cols-2">
        {(["platform", "business"] as const).map((m) => (
          <div key={m} className="space-y-3">
            <h4 className="text-sm font-semibold capitalize">{m} mode</h4>
            <NumField label="Max recipients per send" value={v[m].per_send} onChange={(x) => set(m, "per_send", x)} />
            <NumField label="Max sends per hour" value={v[m].per_hour} onChange={(x) => set(m, "per_hour", x)} />
            <NumField label="Max recipients per day" value={v[m].per_day} onChange={(x) => set(m, "per_day", x)} />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

export function PlatformKeywordsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("platform_keywords", onSaved)
  const [list, setList] = useState(s.blockedKeywords)
  return (
    <SectionCard title="Blocked keywords (Platform mode)" description="Messages containing these are blocked and flagged as fraud in Platform mode. Matching ignores case and common disguises like p.i.n." saving={saving} onSave={() => void save({ blockedKeywords: list })}>
      <ChipsInput value={list} onChange={setList} placeholder="Add a keyword or phrase" />
    </SectionCard>
  )
}

export function BusinessListsSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("business_lists", onSaved)
  const [blocked, setBlocked] = useState(s.businessBlockedKeywords)
  const [flagged, setFlagged] = useState(s.businessFlaggedKeywords)
  const [domains, setDomains] = useState(s.businessAllowedDomains)
  return (
    <SectionCard title="Business mode lists" description="Business accounts may send ordinary links; these lists tighten that." saving={saving}
      onSave={() => void save({ businessBlockedKeywords: blocked, businessFlaggedKeywords: flagged, businessAllowedDomains: domains })}>
      <div className="space-y-4">
        <div className="space-y-1"><h4 className="text-sm font-semibold">Blocked keywords</h4><ChipsInput value={blocked} onChange={setBlocked} placeholder="Block messages containing…" /></div>
        <div className="space-y-1"><h4 className="text-sm font-semibold">Flagged keywords</h4><ChipsInput value={flagged} onChange={setFlagged} placeholder="Allow but flag for review…" /></div>
        <div className="space-y-1"><h4 className="text-sm font-semibold">Allowed domains</h4><ChipsInput value={domains} onChange={setDomains} placeholder="e.g. example.com (subdomains included)" /></div>
      </div>
    </SectionCard>
  )
}

export function ModerationSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("moderation", onSaved)
  const [a, setA] = useState(String(s.autoSuspendFlags))
  const [b, setB] = useState(String(s.flagReviewThreshold))
  return (
    <SectionCard title="Moderation thresholds" description="How many fraud flags suspend an account, and how many open flags put its sends on hold for review." saving={saving}
      onSave={() => void save({ autoSuspendFlags: Number(a), flagReviewThreshold: Number(b) })}>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumField label="Auto-suspend after N fraud flags" value={a} onChange={setA} hint="1–100" />
        <NumField label="Hold for review at N open flags" value={b} onChange={setB} hint="1–500" />
      </div>
    </SectionCard>
  )
}

export function ApiLimitSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("api_limit", onSaved)
  const [v, setV] = useState(String(s.apiRateLimitDefault))
  return (
    <SectionCard title="SMS API rate limit" description="Default requests per minute per account on the public SMS API. Override per account in the Accounts tab." saving={saving} onSave={() => void save({ apiRateLimitDefault: Number(v) })}>
      <NumField label="Requests per minute" value={v} onChange={setV} hint="1–10,000" />
    </SectionCard>
  )
}

export function PricingSection({ d, onSaved }: { d: SettingsData; onSaved: Saved }) {
  const { saving, save } = useSectionSave("pricing", onSaved)
  const [fee, setFee] = useState(String(d.pricing.activationFee))
  const [bonus, setBonus] = useState(String(d.pricing.welcomeBonusCredits))
  const [price, setPrice] = useState(String(d.pricing.pricePerCredit))
  return (
    <SectionCard title="Pricing & activation" description="The one-time activation fee, the welcome bonus, and the per-credit price used by quantity purchases." saving={saving}
      onSave={() => void save({ activationFee: Number(fee), welcomeBonusCredits: Number(bonus), pricePerCredit: Number(price) })}>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumField label="Activation fee (GH₵)" value={fee} onChange={setFee} hint="0 = free" />
        <NumField label="Welcome bonus (credits)" value={bonus} onChange={setBonus} />
        <NumField label="Price per credit (GH₵)" value={price} onChange={setPrice} />
      </div>
    </SectionCard>
  )
}

export function HubtelSection({ s, onSaved }: { s: S; onSaved: Saved }) {
  const { saving, save } = useSectionSave("hubtel", onSaved)
  const [cost, setCost] = useState(String(s.hubtelCostPerSms))
  const [low, setLow] = useState(String(s.hubtelLowBalanceGhs))
  return (
    <SectionCard title="Hubtel supply" description="Used only when Hubtel is the active provider: the per-SMS cost assumed until real rates are seen, and the balance below which admins are alerted." saving={saving}
      onSave={() => void save({ hubtelCostPerSms: Number(cost), hubtelLowBalanceGhs: Number(low) })}>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumField label="Assumed cost per SMS (GH₵)" value={cost} onChange={setCost} hint="0.0001–10" />
        <NumField label="Low-balance alert below (GH₵)" value={low} onChange={setLow} />
      </div>
    </SectionCard>
  )
}
```

- [ ] **Step 2: Implement `SettingsTab.tsx`**

```tsx
"use client"
import Link from "next/link"
import { useState } from "react"
import { api, type SettingsData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { providerLabel } from "../_lib/view"
import { ErrorBox, LoadingRows } from "./ui-bits"
import { ApiLimitSection, BusinessListsSection, CapsSection, HubtelSection, ModerationSection, PlatformKeywordsSection, PricingSection, RolesSection, SenderPoolSection } from "./SettingsSections"

export default function SettingsTab({ provider }: { provider: string }) {
  const { data, error, loading, reload } = useLoad<SettingsData>(() => api<SettingsData>("/api/admin/sms-platform/settings"), [])
  // Sections keep their own draft state; bumping `rev` after a save re-mounts them with the saved values.
  const [rev, setRev] = useState(0)
  const [fresh, setFresh] = useState<SettingsData | null>(null)
  const d = fresh ?? data
  const saved = (next: SettingsData) => { setFresh(next); setRev((r) => r + 1) }

  if (loading && !d) return <LoadingRows rows={4} />
  if (error && !d) return <ErrorBox message={error} onRetry={reload} />
  if (!d) return null
  const s = d.settings
  return (
    <div className="space-y-4" key={rev}>
      <div className="clay-inset rounded-2xl px-4 py-3 text-sm">
        <p><span className="font-medium">Provider:</span> {providerLabel(provider)} is the active SMS provider. Change providers (with the Hubtel readiness checks) in <Link className="text-primary hover:underline" href="/admin/sms-centre">SMS Centre → Providers</Link>.</p>
        <p className="mt-1 text-muted-foreground"><span className="font-medium text-foreground">Enforcement:</span> {s.policyEnforced ? "On" : "Record-only"} — caps, keywords, flags and holds are measured but not enforced until Phase 3. The master switch (page header) is enforced now.</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <SenderPoolSection s={s} onSaved={saved} />
        <RolesSection s={s} onSaved={saved} />
        <CapsSection s={s} onSaved={saved} />
        <PlatformKeywordsSection s={s} onSaved={saved} />
        <BusinessListsSection s={s} onSaved={saved} />
        <ModerationSection s={s} onSaved={saved} />
        <ApiLimitSection s={s} onSaved={saved} />
        <PricingSection d={d} onSaved={saved} />
        <HubtelSection s={s} onSaved={saved} />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Run** `npx tsc --noEmit` — clean (verify `Checkbox` `onCheckedChange` signature and that `Input` accepts `step`). **Step 4: Commit** — `feat(sms): admin Settings tab (section-wise)` + trailer.

---

### Task 16: Assemble the page and replace the old `/admin/sms`

**Files:**
- Create: `app/admin/sms/_components/SmsPlatformPage.tsx`
- Replace: `app/admin/sms/page.tsx`

`useSearchParams` requires a Suspense boundary to build, so `page.tsx` is a thin server wrapper and the logic lives in `SmsPlatformPage` (also lets the throwaway preview in Task 17 mount it without the auth-gated layout).

- [ ] **Step 1: Create `SmsPlatformPage.tsx`**

```tsx
"use client"
import { useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { PageHeaderBanner } from "@/components/shared/page-header-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { api, type OverviewData } from "../_lib/api"
import { useLoad } from "../_lib/useLoad"
import { tabFromParam, type TabId } from "../_lib/view"
import { ConfirmDialog, ErrorBox, LoadingRows } from "./ui-bits"
import StatCards from "./StatCards"
import SupplyStrip from "./SupplyStrip"
import StatusBanner from "./StatusBanner"
import BusinessReviewsTab from "./BusinessReviewsTab"
import SenderIdsTab from "./SenderIdsTab"
import FlaggedTab from "./FlaggedTab"
import MessagesTab from "./MessagesTab"
import AccountsTab from "./AccountsTab"
import BundlesTab from "./BundlesTab"
import SettingsTab from "./SettingsTab"

const TAB_LABELS: Record<TabId, string> = {
  "business-reviews": "Business Reviews", "sender-ids": "Sender IDs", flagged: "Flagged", messages: "Messages",
  accounts: "Accounts", bundles: "Bundles", settings: "Settings",
}

export default function SmsPlatformPage() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const tab = tabFromParam(sp.get("tab"))
  const { data: overview, error, loading, reload } = useLoad<OverviewData>(() => api<OverviewData>("/api/admin/sms-platform/overview"), [])
  const [confirmOff, setConfirmOff] = useState(false)
  const [switching, setSwitching] = useState(false)

  function selectTab(next: string) {
    const p = new URLSearchParams(sp.toString())
    p.set("tab", next)
    router.replace(`${pathname}?${p.toString()}`, { scroll: false })
  }

  async function setEnabled(featureEnabled: boolean) {
    setSwitching(true)
    const res = await api("/api/admin/sms-platform/settings", { method: "PATCH", body: JSON.stringify({ section: "switch", values: { featureEnabled } }) })
    setSwitching(false)
    setConfirmOff(false)
    if (res.success) toast.success(featureEnabled ? "SMS is live" : "SMS paused — takes effect within a minute")
    else toast.error(res.error ?? "Could not change the switch")
    void reload()
  }

  const counts: Partial<Record<TabId, number>> = overview
    ? { "business-reviews": overview.tabCounts.businessReviews, "sender-ids": overview.tabCounts.senderIds, flagged: overview.tabCounts.flagged }
    : {}

  return (
    <div className="space-y-5 p-4 md:p-6 lg:mx-auto lg:max-w-7xl">
      <PageHeaderBanner title="SMS Platform" subtitle="Reviews, sender IDs, messages, accounts, bundles and rules for the SMS product.">
        <div className="flex flex-wrap items-center gap-3">
          <Badge className={overview?.featureEnabled === false ? "bg-red-500/90 text-white" : "bg-emerald-500/90 text-white"}>{overview?.featureEnabled === false ? "PAUSED" : "LIVE"}</Badge>
          <label className="flex items-center gap-2 text-sm text-white">
            <Switch checked={overview?.featureEnabled ?? true} disabled={!overview || switching}
              onCheckedChange={(on) => (on ? void setEnabled(true) : setConfirmOff(true))} />
            Accepting SMS
          </label>
          <Button size="sm" variant="secondary" className="ml-auto" disabled={loading} onClick={() => void reload()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Refresh
          </Button>
        </div>
      </PageHeaderBanner>

      {error && !overview ? <ErrorBox message={error} onRetry={reload} /> : !overview ? <LoadingRows rows={2} /> : (
        <>
          <StatusBanner overview={overview} />
          <StatCards overview={overview} />
          <SupplyStrip overview={overview} />
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList className="h-auto flex-wrap">
              {(Object.keys(TAB_LABELS) as TabId[]).map((id) => (
                <TabsTrigger key={id} value={id}>
                  {TAB_LABELS[id]}
                  {!!counts[id] && <Badge variant="secondary" className="ml-1.5 px-1.5">{counts[id]}</Badge>}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="pt-1">
            {tab === "business-reviews" && <BusinessReviewsTab onChanged={() => void reload()} />}
            {tab === "sender-ids" && <SenderIdsTab provider={overview.provider} onChanged={() => void reload()} />}
            {tab === "flagged" && <FlaggedTab overview={overview} onChanged={() => void reload()} />}
            {tab === "messages" && <MessagesTab />}
            {tab === "accounts" && <AccountsTab onChanged={() => void reload()} />}
            {tab === "bundles" && <BundlesTab />}
            {tab === "settings" && <SettingsTab provider={overview.provider} />}
          </div>
        </>
      )}

      <ConfirmDialog open={confirmOff} onOpenChange={setConfirmOff} busy={switching} destructive
        title="Pause SMS for all customers?" confirmLabel="Pause SMS"
        description="New sends and credit purchases are refused with a friendly message. Payments already made are still credited, queued messages still go out, and OTP/transactional messages are unaffected. Takes effect within a minute."
        onConfirm={() => setEnabled(false)} />
    </div>
  )
}
```

- [ ] **Step 2: Replace `app/admin/sms/page.tsx`** with the whole file:

```tsx
import { Suspense } from "react"
import { DashboardLayout } from "@/components/layout/dashboard-layout"
import SmsPlatformPage from "./_components/SmsPlatformPage"

export default function AdminSmsPage() {
  return (
    <DashboardLayout>
      <Suspense fallback={null}>
        <SmsPlatformPage />
      </Suspense>
    </DashboardLayout>
  )
}
```
(If `DashboardLayout` requires a client boundary that a server `page.tsx` can't import, add `"use client"` at the top of `page.tsx` instead; check how `app/admin/sms-centre/page.tsx` does it — it is a client page.)

- [ ] **Step 3: Run** `npx tsc --noEmit` — clean; `npx vitest run app lib/sms` — PASS. Grep for leftovers: nothing else imports the old page's removed types (`rg "admin/sms/page" app components lib`).
- [ ] **Step 4: Commit** — `feat(sms): SMS Platform admin page replaces /admin/sms` + trailer.

---

### Task 17: Verification, ship, notes (controller-run)

- [ ] **Step 1: Visual check with fixtures (never commits, never logs in).** Create a throwaway `app/preview-sms-admin/page.tsx` (client) that patches `window.fetch` in a `useEffect` with fixture JSON for `/api/admin/sms-platform/{overview,business-reviews,sender-ids,flags,messages,accounts,settings}`, `/api/admin/sms/bundles` and `/api/admin/sms-centre-ish` calls (any other URL → `{success:true,data:[]}`), then renders `<Suspense><SmsPlatformPage /></Suspense>` once patched. Fixtures must cover: overview with `unrecorded.purchases > 0`, a Hubtel supply error variant and a PAUSED variant (`?variant=` query), one pending business application with documents, pending/active/paused/revoked sender IDs, a fraud and an info flag + non-empty policy preview, messages with and without Hubtel delivery counts, business and platform accounts (one suspended, one with an API override), bundles in both modes (one inactive), full settings. Run `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder SUPABASE_SERVICE_ROLE_KEY=placeholder npm run dev -- -p 4300` in the background, then use the headless-Chrome recipe from memory (`reference-headless-screenshots`: window width **500** for phone, ~1400 for desktop) to capture every tab at both widths (+ one dark-mode shot). Check: no horizontal scroll at 500 px, tables become cards, clay styling, readable badges, long messages truncate, counts on tab triggers, switch + banner states.
- [ ] **Step 2: Delete the preview** (`app/preview-sms-admin/`), stop the dev server, `git status` must show nothing under `app/preview-sms-admin`.
- [ ] **Step 3: Full gates.** `npx tsc --noEmit`; `npm run test:run` (only the 9 known `order-health-service` failures); placeholder-env `npm run build` → exit 0 (route files export only handlers/config; new `?tab=` page needs the Suspense wrapper).
- [ ] **Step 4: Whole-implementation review** — dispatch the final code reviewer over `git diff <Task-1-commit>^..HEAD` against the spec; fix Critical/Important findings and re-review. Specifically ask it to check: every admin route uses `adminGuard` (writes with `{ write: true }`); the kill switch blocks every listed entry point and none of the never-block paths; no document path/signed URL/card data reaches logs or non-admin responses; searches can't be abused (UUID cast guarded by CASE, `strpos` not LIKE); no client component imports a server-only module.
- [ ] **Step 5: Ship.** `git fetch origin main` → merge if `HEAD..origin/main` is non-empty → re-run Step 3 gates after any merge → `git push origin worktree-customer-ui-rebuild` → `git push origin HEAD:main`. Confirm the Vercel deployment reaches Ready (ask the user for a token for this session if it should be watched; auto-deploy on `main` has been flaky).
- [ ] **Step 6: Notes.** Update `docs/superpowers/plans/2026-10-10-sms-phase1-rollout-runbook.md` with a "Phase 2 added" section (new page, kill switch semantics + 60 s propagation, recorded-revenue caveat with the unrecorded counts, allocation now audited/admin-only, bundle delete rule) and update the memory file `project-sms-platform-rebuild.md` (Phase 2 status + lessons) and `MEMORY.md` if its one-line hook changes.
- [ ] **Step 7: Report** with % complete (Phase 2 of 4 done) and the open user actions (Hubtel go-live list from the runbook).

