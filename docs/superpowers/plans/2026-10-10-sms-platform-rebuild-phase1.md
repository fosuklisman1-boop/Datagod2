# SMS Platform Rebuild — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the backend foundation of the rebuilt SMS platform: Platform/Business modes, KYC, sender-ID rules, per-mode bundles + revenue, Hubtel as a primary-capable provider with delivery-report refunds, a Disbursement-balance solvency gate, and a send-policy engine that runs in **record-only** mode.

**Architecture:** Extend the existing SMS system (migrations 0061–0074, `lib/sms/**`). Every rule that can be pure is a pure module with exhaustive unit tests (`policy.ts`, `sender-name.ts`, `kyc-rules.ts`, `platform-settings.ts`, `providers/hubtel.ts` classifiers, `wholesale.ts` maths, mode-change planner); I/O lives in thin services and routes. One self-asserting SQL migration does all schema + data changes in a single transaction and rolls back if any invariant fails.

**Tech Stack:** Next.js 15 App Router route handlers, Supabase (Postgres 17, service-role client, Storage), Vitest, Hubtel SMS REST API, DigitalOcean relay (`scripts/hubtel-relay`).

**Spec:** `docs/superpowers/specs/2026-10-10-sms-platform-rebuild-phase1-design.md` (commits b60beb02, 2622b6d1).

---

## Scope notes (read first)

- **Record-only policy.** `enqueueSend` evaluates the policy and stores the would-be decision in `sms_send_logs.policy_shadow`; the send proceeds exactly as today. The enforcement branch (rejecting sends, `held` campaigns, `record_sms_flag` RPC, auto-suspend, drain skipping held campaigns, admin release/reject) ships in **Phase 3** together with the customer UI. The columns/tables it needs (`review_hold`, `fraud_flag_count`, `sms_flags`, status `held`) are created now so Phase 3 is code-only.
- **Small, deliberate deviations from the spec** (all recorded here so reviewers don't flag them):
  1. `provider_batch_id` is stored on **`sms_messages`** as well as `sms_send_logs` — one 500-recipient send produces up to five Hubtel batches (100 per request), so the per-message value is what the poller needs. `sms_send_logs.provider_batch_id` holds the first batch for display.
  2. `HUBTEL_DISBURSEMENT_ACCOUNT` lives on the **relay droplet only**, not in Vercel — the relay builds the upstream URL, so Vercel never sends an account number. The relay may also take `HUBTEL_BALANCE_BASIC_AUTH`; if absent it reuses `HUBTEL_STATUS_BASIC_AUTH` (the docs say "Basic auth" without naming which key pair — confirm with Hubtel during rollout, Task 15).
  3. Protected sender names of **3 characters or fewer** (ADB, GRA, ECG, NIA…) match a whole word only; longer names match as a space-insensitive substring. A pure substring rule would block "GRACE", "GLORY", "BOGOSO".
  4. `sms_unit_transactions` gains `send_log_id` so delivery refunds link to their campaign (the existing `campaign_id` column is a UUID and send logs use BIGINT ids).
  5. Platform owner accounts (`owner_type = 'platform'`, the admin's own account) are migrated to `mode = 'business'` and keep all sender IDs — that is platform traffic.
- **Allowed Roles semantics.** Values: `shop_owner`, `sub_agent`, `dealer`, `user` (admins are always allowed). Default `["shop_owner","sub_agent"]` reproduces today's entitlement exactly. Adding `dealer`/`user` lets those users get an `individual` account. Removing `shop_owner` does not delete accounts; the policy reports `ROLE_NOT_ALLOWED` (record-only until Phase 3).
- **No UI in this phase.** New admin/customer routes are JSON APIs consumed by Phases 2–3.

## Conventions

- Work in the worktree `C:\Users\User2\.gemini\antigravity-ide\scratch\Datagod2\.claude\worktrees\customer-ui-rebuild` (branch `worktree-customer-ui-rebuild`). Never `cd` elsewhere for git.
- Tests: `npx vitest run <file>` for one file; `npm run test:run` for all. Baseline: **9 known failures in `lib/order-health-service.test.ts`** — any other failure is yours.
- Types: `npx tsc --noEmit`. Build: `npm run build` (must pass before anything reaches main — tsc + vitest do not catch Next route-export violations).
- Route files may export **only** HTTP method handlers and Next config consts. Put helpers in `lib/`.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Live SQL (controller only, never from a subagent unless the task says so): `node "C:/Users/User2/AppData/Local/Temp/claude/C--Users-User2--gemini-antigravity-ide-scratch-Datagod2--claude-worktrees-customer-ui-rebuild/721cad5d-5d11-431b-b656-61cc2ba3d10b/scratchpad/sq.js" "<SQL>"` (Supabase Management API, superuser). Never select PII columns; use `count(*)`.
- **Never log into the application.** Verify through tests, SQL and curl only.
- Supabase admin client pattern used everywhere in `lib/sms`:
  ```ts
  const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  ```
- Next 15 dynamic route params are a Promise: `{ params }: { params: Promise<{ id: string }> }`.

## File structure

**Create**
| File | Responsibility |
|---|---|
| `migrations/20261010_sms_platform_foundation.sql` | All Phase 1 schema, data migration, settings seed, SQL functions, self-asserted invariants |
| `lib/sms/platform-settings.ts` (+test) | Typed SMS platform settings: defaults, tolerant parser, cached loader, `apiRateLimitFor` |
| `lib/sms/sender-name.ts` (+test) | Pure sender-name normalise/validate incl. protected names |
| `lib/sms/policy.ts` (+test) | Pure `evaluateSendPolicy` |
| `lib/sms/policy-context.ts` (+test) | I/O for the policy: settings, own domains, usage, account audience, sender resolution, `shadowPolicy` |
| `lib/sms/providers/hubtel.ts` (+test) | Every Hubtel SMS detail: auth, single/batch/personalized send, response classification, status checks |
| `lib/sms/campaign-dispatch.ts` (+test) | Instant campaign dispatch: Hubtel batches when primary, Moolre fallback for platform-sender only |
| `lib/sms/delivery-poll.ts` (+test) | Hubtel DLR polling, 72 h close, idempotent refunds, campaign recompute |
| `lib/sms/wholesale.ts` (+test) | Backed-credit supply for the solvency gate (Hubtel Disbursement or Moolre) + low-balance alert |
| `lib/sms/sender-rules-service.ts` (+test) | Sender-ID request/approve/reject/revoke, account mode changes (pure planner + I/O) |
| `lib/sms/kyc-rules.ts` (+test) | Pure KYC validation + status transitions |
| `lib/sms/kyc-service.ts` | KYC drafts, document upload, submit, admin review, purge |
| `app/api/cron/sms-hubtel-dlr/route.ts` | Cron: poll Hubtel delivery reports |
| `app/api/cron/sms-kyc-purge/route.ts` | Cron: delete KYC documents 30 days after decision |
| `app/api/sms/business/route.ts` | GET profile / PUT draft |
| `app/api/sms/business/documents/route.ts` | POST document upload |
| `app/api/sms/business/submit/route.ts` | POST submit for review |
| `app/api/admin/sms-platform/business-reviews/route.ts` | GET list |
| `app/api/admin/sms-platform/business-reviews/[id]/route.ts` | GET detail (+signed URLs) / POST approve·reject |
| `app/api/admin/sms-platform/sender-ids/[id]/route.ts` | POST approve·reject·revoke |
| `app/api/admin/sms-platform/accounts/[id]/route.ts` | PATCH mode / API rate-limit override |

**Modify**
| File | Change |
|---|---|
| `lib/sms/content-filter.ts` (+test) | Export `matchBlockedContent`, `suspiciousHostReason`, `extractLinkHosts` (filterSmsContent behaviour unchanged) |
| `lib/sms/send-service.ts` (+test) | Sender resolution via policy-context, shadow policy + mode snapshot, dispatch via campaign-dispatch |
| `lib/sms/send-drain.ts` (+test) | Store Hubtel message id; refund via `refund_sms_message` RPC |
| `lib/sms-service.ts` | `sendSMSViaHubtel`, register `hubtel` provider, sender narrowing via `narrowProvidersForSender` |
| `lib/sms/routing.ts` (+test) | `hubtel` valid provider; pure `narrowProvidersForSender` |
| `app/admin/sms-centre/_components/ProvidersTab.tsx` | Add `hubtel` to provider list |
| `lib/ussd-hubtel/relay-handler.ts` (+test), `scripts/hubtel-relay/server.ts`, `scripts/hubtel-relay/README.md` | `GET /balance` route |
| `lib/ussd-hubtel/relay.ts` (+test) | `fetchDisbursementBalance()` |
| `lib/sms/bundle-service.ts` (+test), `lib/sms/activation-service.ts` (+test), `app/api/cron/sms-pending-credits/route.ts`, `app/api/admin/sms-supply/route.ts` | Solvency gate via `getWholesaleCredits`; bundles per mode; `amount_ghs` |
| `app/api/webhooks/paystack/route.ts` | Pass paid amount to `creditUnitsForPaystack` |
| `lib/sms/notify.ts` | Generic throttled admin alert |
| `lib/sms/foundation-rules.ts` (+test), `lib/sms/account-service.ts` | `individual` owner type via Allowed Roles; bundle visibility per mode |
| `lib/sms/moderation-service.ts` | Export `writeAuditLog` |
| `app/api/sms/sender-ids/route.ts` | Use `requestSenderId` |
| `app/api/v1/sms/send/route.ts` | Rate limit = account override ?? setting |
| `vercel.json` | Two crons |

---

### Task 1: Foundation migration (schema, data, settings, SQL functions)

**Files:**
- Create: `migrations/20261010_sms_platform_foundation.sql`

This task is executed by the **controller** (it touches the live DB).

- [ ] **Step 1: Pre-flight checks against live data**

Run (each must return the shown value; stop and report if not):
```
node <sq.js> "select count(*) from (select upper(sender_id) from sms_sender_ids where local_status='active' group by 1 having count(*)>1) x"
```
Expected: `[{"count":0}]` (otherwise the active-name unique index would fail — resolve duplicates with the user first).
```
node <sq.js> "select count(*) accts, sum(unit_balance) bal, (select count(*) from sms_sender_ids) sids, (select count(*) from sms_sender_ids where local_status='active') active from sms_accounts"
```
Record the four numbers in the task report (2026-10-10 values: 242 / 2388 / 67 / 38).

- [ ] **Step 2: Write the migration**

```sql
-- SMS platform rebuild — Phase 1 foundation.
-- Spec: docs/superpowers/specs/2026-10-10-sms-platform-rebuild-phase1-design.md (§5.1, §5.2, §5.5, §5.5a)
-- One transaction. Ends with invariant assertions: any failure rolls the whole thing back.
BEGIN;

CREATE TEMP TABLE _sms_mig_before ON COMMIT DROP AS
SELECT (SELECT count(*) FROM sms_accounts)                                   AS accts,
       (SELECT COALESCE(sum(unit_balance), 0) FROM sms_accounts)             AS bal,
       (SELECT count(*) FROM sms_sender_ids)                                 AS sids,
       (SELECT count(*) FROM sms_sender_ids WHERE local_status = 'active')   AS active_ids;

-- ── sms_accounts ─────────────────────────────────────────────────────────────
ALTER TABLE sms_accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS mode_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fraud_flag_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS review_hold BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS api_rate_limit_override INT,
  ADD COLUMN IF NOT EXISTS default_sender_id UUID REFERENCES sms_sender_ids(id) ON DELETE SET NULL;
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_mode_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_mode_check CHECK (mode IN ('platform','business'));
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_api_rate_limit_override_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_api_rate_limit_override_check
  CHECK (api_rate_limit_override IS NULL OR api_rate_limit_override BETWEEN 1 AND 10000);
ALTER TABLE sms_accounts DROP CONSTRAINT IF EXISTS sms_accounts_owner_type_check;
ALTER TABLE sms_accounts ADD CONSTRAINT sms_accounts_owner_type_check
  CHECK (owner_type IN ('platform','shop','sub_agent','individual'));

-- ── sms_business_profiles (KYC) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_business_profiles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_account_id        UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  business_name         TEXT CHECK (business_name IS NULL OR char_length(business_name) BETWEEN 2 AND 120),
  description           TEXT CHECK (description IS NULL OR char_length(description) BETWEEN 10 AND 2000),
  website               TEXT,
  whatsapp_number       TEXT,
  ghana_card_last4      CHAR(4),
  ghana_card_doc_path   TEXT,
  registration_doc_path TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected')),
  submitted_at          TIMESTAMPTZ,
  reviewed_by           UUID,
  reviewed_at           TIMESTAMPTZ,
  rejection_reason      TEXT,
  docs_purge_after      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_business_profiles_open
  ON sms_business_profiles(sms_account_id) WHERE status IN ('draft','submitted');
CREATE INDEX IF NOT EXISTS idx_sms_business_profiles_status ON sms_business_profiles(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_sms_business_profiles_purge
  ON sms_business_profiles(docs_purge_after) WHERE docs_purge_after IS NOT NULL;
ALTER TABLE sms_business_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_business_profiles FROM anon, authenticated;

-- ── sms_sender_ids ───────────────────────────────────────────────────────────
ALTER TABLE sms_sender_ids DROP CONSTRAINT IF EXISTS sms_sender_ids_local_status_check;
ALTER TABLE sms_sender_ids ADD CONSTRAINT sms_sender_ids_local_status_check
  CHECK (local_status IN ('pending','active','rejected','paused','revoked'));
ALTER TABLE sms_sender_ids
  ADD COLUMN IF NOT EXISTS kyc_free BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_pool BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS approved_by UUID,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ── sms_bundles ──────────────────────────────────────────────────────────────
ALTER TABLE sms_bundles
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'platform',
  ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE sms_bundles DROP CONSTRAINT IF EXISTS sms_bundles_mode_check;
ALTER TABLE sms_bundles ADD CONSTRAINT sms_bundles_mode_check CHECK (mode IN ('platform','business'));
ALTER TABLE sms_bundles DROP CONSTRAINT IF EXISTS sms_bundles_owner_type_scope_check;
ALTER TABLE sms_bundles ADD CONSTRAINT sms_bundles_owner_type_scope_check
  CHECK (owner_type_scope IN ('all','shop','sub_agent','platform','individual'));

-- ── ledger: revenue + campaign link ──────────────────────────────────────────
ALTER TABLE sms_unit_transactions
  ADD COLUMN IF NOT EXISTS amount_ghs NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS send_log_id BIGINT REFERENCES sms_send_logs(id) ON DELETE SET NULL;
ALTER TABLE sms_pending_credits ADD COLUMN IF NOT EXISTS amount_ghs NUMERIC(12,2);

-- A pending purchase settles later via adjust_sms_units with the same ref; copy its amount.
CREATE OR REPLACE FUNCTION sms_unit_tx_copy_pending_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ref IS NOT NULL AND NEW.amount_ghs IS NULL THEN
    SELECT pc.amount_ghs INTO NEW.amount_ghs FROM sms_pending_credits pc WHERE pc.ref = NEW.ref LIMIT 1;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_sms_unit_tx_pending_amount ON sms_unit_transactions;
CREATE TRIGGER trg_sms_unit_tx_pending_amount BEFORE INSERT ON sms_unit_transactions
  FOR EACH ROW EXECUTE FUNCTION sms_unit_tx_copy_pending_amount();

-- ── sms_flags ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sms_flags (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sms_account_id UUID NOT NULL REFERENCES sms_accounts(id) ON DELETE CASCADE,
  send_log_id    BIGINT REFERENCES sms_send_logs(id) ON DELETE SET NULL,
  severity       TEXT NOT NULL CHECK (severity IN ('fraud','info')),
  reason         TEXT NOT NULL,
  matched        TEXT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','actioned')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by    UUID,
  resolved_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sms_flags_account_status ON sms_flags(sms_account_id, status);
CREATE INDEX IF NOT EXISTS idx_sms_flags_status_time ON sms_flags(status, created_at DESC);
ALTER TABLE sms_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_flags FROM anon, authenticated;

-- ── sms_send_logs ────────────────────────────────────────────────────────────
ALTER TABLE sms_send_logs DROP CONSTRAINT IF EXISTS sms_send_logs_status_check;
ALTER TABLE sms_send_logs ADD CONSTRAINT sms_send_logs_status_check
  CHECK (status IN ('queued','sending','sent','partial','failed','blocked','held','scheduled'));
ALTER TABLE sms_send_logs
  ADD COLUMN IF NOT EXISTS mode TEXT,
  ADD COLUMN IF NOT EXISTS policy_shadow JSONB,
  ADD COLUMN IF NOT EXISTS provider_batch_id TEXT;

-- ── sms_messages ─────────────────────────────────────────────────────────────
ALTER TABLE sms_messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_batch_id TEXT,
  ADD COLUMN IF NOT EXISTS cost_ghs NUMERIC(8,4),
  ADD COLUMN IF NOT EXISTS refunded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_delivery_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_delivery_status_check
  CHECK (delivery_status IN ('pending','delivered','failed'));
CREATE INDEX IF NOT EXISTS idx_sms_messages_provider_msg
  ON sms_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_messages_dlr_pending
  ON sms_messages(processed_at) WHERE provider = 'hubtel' AND status = 'sent' AND delivery_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_sms_messages_hubtel_rate
  ON sms_messages(processed_at) WHERE provider = 'hubtel' AND cost_ghs IS NOT NULL;

-- ── private KYC bucket ───────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('sms-kyc', 'sms-kyc', false, 5242880, ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- ── data migration (§5.2) ────────────────────────────────────────────────────
-- Platform owner (admin) accounts are platform traffic: business mode, keep every sender ID.
UPDATE sms_accounts SET mode = 'business', mode_changed_at = now() WHERE owner_type = 'platform';

-- Per tenant account: oldest active sender ID stays usable as the one KYC-free ID; others pause.
WITH ranked AS (
  SELECT s.id, row_number() OVER (PARTITION BY s.sms_account_id ORDER BY s.created_at, s.id) AS rn
  FROM sms_sender_ids s JOIN sms_accounts a ON a.id = s.sms_account_id
  WHERE s.local_status = 'active' AND a.owner_type <> 'platform'
)
UPDATE sms_sender_ids s
SET kyc_free     = (r.rn = 1),
    local_status = CASE WHEN r.rn = 1 THEN 'active' ELSE 'paused' END,
    updated_at   = now()
FROM ranked r WHERE s.id = r.id;

UPDATE sms_sender_ids SET approved_at = COALESCE(approved_at, updated_at)
WHERE local_status IN ('active','paused');

UPDATE sms_accounts a SET default_sender_id = s.id
FROM sms_sender_ids s
WHERE s.sms_account_id = a.id AND s.kyc_free AND s.local_status = 'active' AND a.default_sender_id IS NULL;

-- Global uniqueness of ACTIVE names (created after pausing).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sms_sender_ids_active_name
  ON sms_sender_ids (upper(sender_id)) WHERE local_status = 'active';

UPDATE sms_bundles b SET sort_order = r.rn
FROM (SELECT id, row_number() OVER (ORDER BY price_ghs, id) AS rn FROM sms_bundles) r
WHERE b.id = r.id;

-- Messages the drain already refunded (ref = message id).
UPDATE sms_messages m SET refunded = true, delivery_status = 'failed'
WHERE EXISTS (SELECT 1 FROM sms_unit_transactions t WHERE t.ref = m.id::text);

-- ── settings seed (tenant_global_settings, jsonb) ────────────────────────────
INSERT INTO tenant_global_settings (key, value) VALUES
  ('sms_feature_enabled',           'true'::jsonb),
  ('sms_policy_enforced',           'false'::jsonb),
  ('sms_allowed_roles',             '["shop_owner","sub_agent"]'::jsonb),
  ('sms_sender_pool',               '[]'::jsonb),
  ('sms_caps',                      '{"platform":{"per_send":300,"per_hour":20,"per_day":500},"business":{"per_send":1000,"per_hour":2000,"per_day":1000000}}'::jsonb),
  ('sms_blocked_keywords',          '[]'::jsonb),
  ('sms_business_blocked_keywords', '[]'::jsonb),
  ('sms_business_flagged_keywords', '[]'::jsonb),
  ('sms_business_allowed_domains',  '[]'::jsonb),
  ('sms_auto_suspend_flags',        '2'::jsonb),
  ('sms_flag_review_threshold',     '5'::jsonb),
  ('sms_api_rate_limit_default',    '30'::jsonb),
  ('sms_protected_sender_names',    '["MTN","TELECEL","VODAFONE","AIRTELTIGO","AIRTEL","TIGO","GLO","MOMO","MOBILEMONEY","HUBTEL","PAYSTACK","EXPRESSPAY","ZEEPAY","GCB","ECOBANK","STANBIC","ABSA","FIDELITY","CALBANK","ZENITH","ACCESSBANK","GTBANK","UBA","SOCGEN","REPUBLICBANK","PRUDENTIAL","ADB","NIB","CBG","OMNIBSIC","FIRSTBANK","BANKOFGHANA","BOG","GRA","ECG","GWCL","NHIS","NIA","DVLA","GHANAPOST","POLICE","GHANAGOV","WAEC","DATAGOD"]'::jsonb),
  ('sms_hubtel_cost_per_sms',       '0.035'::jsonb),
  ('sms_hubtel_low_balance_ghs',    '50'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── SQL functions (§5.5) ─────────────────────────────────────────────────────
-- Mark dispatched rows sent, with provider ids, in one round trip.
CREATE OR REPLACE FUNCTION mark_sms_messages_sent(p_provider TEXT, p_rows JSONB)
RETURNS INT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (
    UPDATE sms_messages m
    SET status = 'sent', provider = p_provider, processed_at = now(),
        provider_message_id = x.mid, provider_batch_id = x.bid
    FROM jsonb_to_recordset(p_rows) AS x(id UUID, mid TEXT, bid TEXT)
    WHERE m.id = x.id AND m.status IN ('pending','claimed')
    RETURNING 1
  )
  SELECT count(*)::int FROM u;
$$;

-- Refund one message's credits exactly once (ref = message id, shared with the drain).
CREATE OR REPLACE FUNCTION refund_sms_message(p_message_id UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  m RECORD;
  v_ref TEXT := p_message_id::text;
BEGIN
  SELECT id, sms_account_id, segments, send_log_id, refunded INTO m
  FROM sms_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND OR m.refunded THEN RETURN false; END IF;

  IF EXISTS (SELECT 1 FROM sms_unit_transactions WHERE ref = v_ref) THEN
    UPDATE sms_messages SET refunded = true, delivery_status = 'failed' WHERE id = p_message_id;
    RETURN false;
  END IF;

  PERFORM adjust_sms_units(m.sms_account_id, m.segments, 'campaign_refund', v_ref);
  UPDATE sms_unit_transactions SET send_log_id = m.send_log_id WHERE ref = v_ref;
  UPDATE sms_messages SET refunded = true, delivery_status = 'failed' WHERE id = p_message_id;
  RETURN true;
END $$;

-- Apply polled delivery reports. p_rows: [{mid, state: delivered|failed|pending, rate, at}]
CREATE OR REPLACE FUNCTION apply_sms_delivery_reports(p_rows JSONB)
RETURNS TABLE(out_message_id UUID, out_send_log_id BIGINT, out_outcome TEXT, out_refunded BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  x RECORD;
  m RECORD;
BEGIN
  FOR x IN SELECT * FROM jsonb_to_recordset(p_rows) AS t(mid TEXT, state TEXT, rate NUMERIC, at TIMESTAMPTZ) LOOP
    IF x.state NOT IN ('delivered','failed') THEN
      UPDATE sms_messages SET cost_ghs = COALESCE(x.rate, cost_ghs)
      WHERE provider_message_id = x.mid AND delivery_status = 'pending';
      CONTINUE;
    END IF;
    FOR m IN SELECT id, send_log_id FROM sms_messages
             WHERE provider_message_id = x.mid AND delivery_status = 'pending' FOR UPDATE LOOP
      UPDATE sms_messages
      SET delivery_status = x.state,
          delivered_at = CASE WHEN x.state = 'delivered' THEN COALESCE(x.at, now()) END,
          cost_ghs = COALESCE(x.rate, cost_ghs)
      WHERE id = m.id;
      out_message_id := m.id;
      out_send_log_id := m.send_log_id;
      out_outcome := x.state;
      out_refunded := CASE WHEN x.state = 'failed' THEN refund_sms_message(m.id) ELSE false END;
      RETURN NEXT;
    END LOOP;
  END LOOP;
END $$;

-- Delivery-aware campaign rollup. Never touches held/scheduled/blocked logs.
CREATE OR REPLACE FUNCTION recompute_sms_send_result(p_send_log_id BIGINT, max_attempts INT DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ok INT; v_failed_final INT; v_outstanding INT; v_used INT;
BEGIN
  SELECT
    count(*) FILTER (WHERE status = 'sent' AND delivery_status <> 'failed'),
    count(*) FILTER (WHERE (status = 'failed' AND attempts >= max_attempts) OR delivery_status = 'failed'),
    count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'failed' AND attempts < max_attempts)),
    COALESCE(sum(segments) FILTER (WHERE status = 'sent' AND NOT refunded), 0)
  INTO v_ok, v_failed_final, v_outstanding, v_used
  FROM sms_messages WHERE send_log_id = p_send_log_id;

  UPDATE sms_send_logs
  SET credits_used = v_used,
      status = CASE
        WHEN v_outstanding > 0  THEN 'sending'
        WHEN v_ok = 0           THEN 'failed'
        WHEN v_failed_final > 0 THEN 'partial'
        ELSE 'sent'
      END,
      completed_at = CASE WHEN v_outstanding = 0 THEN now() ELSE NULL END
  WHERE id = p_send_log_id AND status NOT IN ('held','scheduled','blocked');
END $$;

REVOKE ALL ON FUNCTION mark_sms_messages_sent(TEXT, JSONB)       FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION mark_sms_messages_sent(TEXT, JSONB)   TO service_role;
REVOKE ALL ON FUNCTION refund_sms_message(UUID)                  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION refund_sms_message(UUID)              TO service_role;
REVOKE ALL ON FUNCTION apply_sms_delivery_reports(JSONB)         FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION apply_sms_delivery_reports(JSONB)     TO service_role;
REVOKE ALL ON FUNCTION recompute_sms_send_result(BIGINT, INT)    FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION recompute_sms_send_result(BIGINT, INT) TO service_role;

-- ── invariants (§5.2) — any failure aborts the whole migration ───────────────
DO $$
DECLARE b RECORD;
BEGIN
  SELECT * INTO b FROM _sms_mig_before;
  IF (SELECT count(*) FROM sms_accounts) <> b.accts THEN
    RAISE EXCEPTION 'invariant: sms_accounts count changed'; END IF;
  IF (SELECT COALESCE(sum(unit_balance), 0) FROM sms_accounts) <> b.bal THEN
    RAISE EXCEPTION 'invariant: total unit_balance changed'; END IF;
  IF (SELECT count(*) FROM sms_sender_ids) <> b.sids THEN
    RAISE EXCEPTION 'invariant: sender id rows changed'; END IF;
  IF (SELECT count(*) FROM sms_sender_ids WHERE local_status IN ('active','paused')) <> b.active_ids THEN
    RAISE EXCEPTION 'invariant: active ids not all kept or paused'; END IF;
  IF EXISTS (SELECT 1 FROM sms_sender_ids s JOIN sms_accounts a ON a.id = s.sms_account_id
             WHERE a.owner_type <> 'platform' AND s.local_status = 'active' AND NOT s.kyc_free) THEN
    RAISE EXCEPTION 'invariant: tenant has an active non-kyc_free sender id'; END IF;
  IF EXISTS (SELECT sms_account_id FROM sms_sender_ids WHERE kyc_free GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'invariant: more than one kyc_free id per account'; END IF;
  IF EXISTS (SELECT 1 FROM sms_accounts WHERE owner_type <> 'platform' AND mode <> 'platform') THEN
    RAISE EXCEPTION 'invariant: tenant account not in platform mode'; END IF;
  IF (SELECT value FROM tenant_global_settings WHERE key = 'sms_policy_enforced') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'invariant: sms_policy_enforced must be false'; END IF;
END $$;

COMMIT;
```

- [ ] **Step 3: Dry-run inside a rolled-back transaction**

Copy the file to the scratchpad with the final `COMMIT;` replaced by `ROLLBACK;` and run it:
```
node <sq.js> "$(cat <scratchpad>/mig_dryrun.sql)"
```
Expected: HTTP 201 and `[]` (no exception). Any `invariant:` exception → stop and report.

- [ ] **Step 4: Apply for real**

```
node <sq.js> "$(cat migrations/20261010_sms_platform_foundation.sql)"
```
Expected: 201.

- [ ] **Step 5: Verify live**

```
node <sq.js> "select mode, count(*) from sms_accounts group by 1" "select local_status, kyc_free, count(*) from sms_sender_ids group by 1,2 order by 1" "select count(*) accts, sum(unit_balance) bal from sms_accounts" "select key from tenant_global_settings where key like 'sms_%' order by 1" "select proname from pg_proc where proname in ('mark_sms_messages_sent','refund_sms_message','apply_sms_delivery_reports')" "select id, public from storage.buckets where id='sms-kyc'"
```
Expected: one `business` (platform owner) and the rest `platform`; active ≤ one per tenant all `kyc_free=true`; paused = (38 − kept); balances equal Step 1; 18 `sms_*` keys; 3 functions; bucket `public=false`.

- [ ] **Step 6: Commit**

```bash
git add migrations/20261010_sms_platform_foundation.sql
git commit -m "feat(sms): Phase 1 foundation migration — modes, KYC, flags, delivery tracking, settings

Applied live 2026-10-10; invariants asserted inside the transaction.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Content-filter helpers

**Files:**
- Modify: `lib/sms/content-filter.ts`
- Test: `lib/sms/content-filter.test.ts` (append)

- [ ] **Step 1: Write failing tests** (append to the existing file)

```ts
import { matchBlockedContent, suspiciousHostReason, extractLinkHosts } from "./content-filter"

describe("matchBlockedContent", () => {
  it("returns the keyword reason for a custom keyword, case/obfuscation-insensitive", () => {
    expect(matchBlockedContent("Win a free L.O.A.N today", ["loan"])).toBe('blocked keyword: "loan"')
  })
  it("returns a built-in phishing reason", () => {
    expect(matchBlockedContent("Send your PIN to confirm", [])).toBe("credential-harvest: pin")
  })
  it("ignores empty keywords", () => {
    expect(matchBlockedContent("Hello there", ["", "  "])).toBeNull()
  })
  it("returns null for clean text", () => {
    expect(matchBlockedContent("Your order is ready", ["loan"])).toBeNull()
  })
})

describe("suspiciousHostReason", () => {
  it("flags shorteners", () => expect(suspiciousHostReason("bit.ly")).toBe("suspicious link: known shortener"))
  it("flags digit-letter lookalikes", () => expect(suspiciousHostReason("paypa1.com")).toBe("suspicious link: homoglyph domain"))
  it("passes normal hosts", () => expect(suspiciousHostReason("datagod.store")).toBeNull())
})

describe("extractLinkHosts", () => {
  it("finds http(s) hosts, lowercased, www stripped", () => {
    expect(extractLinkHosts("Visit https://WWW.Shop.DataGod.store/x now")).toEqual(["shop.datagod.store"])
  })
  it("finds bare and www domains on common TLDs", () => {
    expect(extractLinkHosts("go to www.example.com or kings.shop/abc.")).toEqual(["example.com", "kings.shop"])
  })
  it("finds shorteners without a scheme", () => expect(extractLinkHosts("tap bit.ly/abc")).toEqual(["bit.ly"]))
  it("ignores emails, prices and names", () => {
    expect(extractLinkHosts("mail a@b.com · 5GB for GHS 10.50 · Mr.Smith")).toEqual([])
  })
  it("dedupes and keeps uncommon TLDs when a scheme is present", () => {
    expect(extractLinkHosts("https://evil.ru/x and https://evil.ru/y")).toEqual(["evil.ru"])
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`npx vitest run lib/sms/content-filter.test.ts`: "matchBlockedContent is not a function").

- [ ] **Step 3: Implement.** In `lib/sms/content-filter.ts`, add below `isHomoglyphHost` and rewrite `filterSmsContent` to use the helpers (its behaviour and existing tests stay the same):

```ts
/** First custom keyword or built-in phishing rule the message trips, or null.
 *  The exact matching filterSmsContent uses; shared with the send policy. */
export function matchBlockedContent(message: string, blockedKeywords: string[] = []): string | null {
  const plain = message.toLowerCase()
  const normalized = normalizeCopy(message)
  for (const kw of blockedKeywords) {
    if (!kw || !kw.trim()) continue
    if (plain.includes(kw.toLowerCase()) || normalized.includes(normalizeCopy(kw))) {
      return `blocked keyword: "${kw}"`
    }
  }
  for (const rule of BLOCK_RULES) {
    if (rule.pattern.test(plain) || rule.pattern.test(normalized)) return rule.reason
  }
  return null
}

/** Why a link host is suspicious (shortener / digit-letter lookalike), or null. */
export function suspiciousHostReason(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "")
  if (SHORTENER_HOSTS.has(h)) return "suspicious link: known shortener"
  if (isHomoglyphHost(h)) return "suspicious link: homoglyph domain"
  return null
}

// TLDs recognised for scheme-less links ("kings.shop/abc"). Kept to common ones so
// ordinary text ("Mr.Smith", "10.50") is never mistaken for a link.
const BARE_LINK_TLDS = "com|net|org|store|shop|app|io|co|gh|xyz|info|biz|me|link|site|online|top|click|live|ly|to|gl|gd|gy"
const BARE_LINK_RE = new RegExp(
  `(?<![@\\w.-])(?:www\\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${BARE_LINK_TLDS}))(?=$|[\\/\\s:?#.,!)'"])`,
  "gi"
)

/** Every link host in the message — http(s) URLs, www hosts and bare domains on common
 *  TLDs — lowercased, without a leading "www.", de-duplicated, in order of appearance. */
export function extractLinkHosts(message: string): string[] {
  const out: string[] = []
  const add = (h: string) => {
    const host = h.toLowerCase().replace(/^www\./, "")
    if (!out.includes(host)) out.push(host)
  }
  const withoutSchemes = message.replace(/https?:\/\/([^/\s?#]+)/gi, (_m, host: string) => {
    add(host)
    return " "
  })
  for (const m of withoutSchemes.matchAll(BARE_LINK_RE)) add(m[1])
  return out
}

export function filterSmsContent(message: string, options: FilterOptions = {}): FilterResult {
  const { blockedKeywords = [], allowedDomains = [] } = options

  const blockedReason = matchBlockedContent(message, blockedKeywords)
  if (blockedReason) return { blocked: true, flagged: false, reason: blockedReason }

  for (const host of extractHosts(message)) {
    const suspicious = suspiciousHostReason(host)
    if (suspicious) return { blocked: true, flagged: false, reason: suspicious }
    if (allowedDomains.length > 0) {
      const allowed = allowedDomains.some(
        (d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`)
      )
      if (!allowed) return { blocked: false, flagged: true, reason: `link to non-allowed domain: ${host}` }
    }
  }
  return { blocked: false, flagged: false }
}
```
Delete the old body of `filterSmsContent` (it is fully replaced above). Note `suspiciousHostReason` strips `www.` before the shortener lookup — "www.bit.ly" is now caught too; that is the only behaviour change.

- [ ] **Step 4: Run — expect PASS** for the whole file (old + new tests).

- [ ] **Step 5: Commit** — `git add lib/sms/content-filter.ts lib/sms/content-filter.test.ts` · message `feat(sms): export content-filter helpers for the send policy` + trailer.

---

### Task 3: Sender-name validator

**Files:**
- Create: `lib/sms/sender-name.ts`, `lib/sms/sender-name.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest"
import { normalizeSenderName, validateSenderName } from "./sender-name"

const PROTECTED = ["MTN", "TELECEL", "MOBILE MONEY", "GRA", "DATAGOD"]

describe("normalizeSenderName", () => {
  it("trims, collapses spaces, uppercases", () => expect(normalizeSenderName("  kings   shop ")).toBe("KINGS SHOP"))
})

describe("validateSenderName", () => {
  const ok = (raw: string) => validateSenderName(raw, PROTECTED)
  it("accepts a normal name", () => expect(ok("Kings Shop")).toEqual({ ok: true, name: "KINGS SHOP" }))
  it("rejects shorter than 3", () => expect(ok("AB").ok).toBe(false))
  it("rejects longer than 11", () => expect(ok("ABCDEFGHIJKL").ok).toBe(false))
  it("rejects symbols", () => expect(ok("KINGS-SHOP").ok).toBe(false))
  it("requires a letter", () => expect(ok("12345").ok).toBe(false))
  it("blocks a protected name inside a word", () => expect(ok("MYMTNDEALS").ok).toBe(false))
  it("blocks a protected name ignoring spaces", () => expect(ok("TELE CEL GH").ok).toBe(false))
  it("blocks multi-word protected names written together", () => expect(ok("MOBILEMONEY").ok).toBe(false))
  it("short protected names only match whole words", () => {
    expect(ok("GRACE SHOP").ok).toBe(true)
    expect(ok("GRA ALERTS").ok).toBe(false)
    expect(ok("GRA").ok).toBe(false)
  })
  it("reason names the protected brand", () => {
    const r = validateSenderName("DATAGOD GH", PROTECTED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("DATAGOD")
  })
})
```

- [ ] **Step 2: Run — FAIL** (module not found).

- [ ] **Step 3: Implement `lib/sms/sender-name.ts`**

```ts
/**
 * Sender-ID name rules (spec §5.7). Hubtel passes any sender through, so these rules are
 * our only impersonation safeguard. Global uniqueness of ACTIVE names is enforced by the
 * DB (uq_sms_sender_ids_active_name) and checked in sender-rules-service.
 */
export const SENDER_NAME_MIN = 3
export const SENDER_NAME_MAX = 11

export type SenderNameCheck = { ok: true; name: string } | { ok: false; reason: string }

export function normalizeSenderName(raw: string): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toUpperCase()
}

const squash = (s: string) => s.replace(/\s+/g, "").toUpperCase()

/** Protected names of 3 chars or fewer match a whole word only (so "GRACE" ≠ "GRA");
 *  longer ones match anywhere, ignoring spaces ("MY MTN" ≠ ok, "TELE CEL" ≠ ok). */
function protectedHit(name: string, protectedNames: string[]): string | null {
  const flat = squash(name)
  const words = name.split(" ")
  for (const p of protectedNames) {
    const pf = squash(p)
    if (!pf) continue
    if (pf.length <= 3 ? words.includes(pf) || flat === pf : flat.includes(pf)) return p
  }
  return null
}

export function validateSenderName(raw: string, protectedNames: string[]): SenderNameCheck {
  const name = normalizeSenderName(raw)
  if (name.length < SENDER_NAME_MIN || name.length > SENDER_NAME_MAX) {
    return { ok: false, reason: `Sender ID must be ${SENDER_NAME_MIN}–${SENDER_NAME_MAX} characters.` }
  }
  if (!/^[A-Z0-9 ]+$/.test(name)) return { ok: false, reason: "Use letters, numbers and spaces only." }
  if (!/[A-Z]/.test(name)) return { ok: false, reason: "Sender ID must contain at least one letter." }
  const hit = protectedHit(name, protectedNames)
  if (hit) {
    return {
      ok: false,
      reason: `"${name}" contains a protected name (${hit}). Pick a name that doesn't imitate a bank, telco, government body or DATAGOD.`,
    }
  }
  return { ok: true, name }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(sms): sender-name validator with protected-brand rules` + trailer.

---

### Task 4: Platform settings module

**Files:**
- Create: `lib/sms/platform-settings.ts`, `lib/sms/platform-settings.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest"
import { parseSmsSettings, DEFAULT_SMS_SETTINGS, apiRateLimitFor } from "./platform-settings"

describe("parseSmsSettings", () => {
  it("returns defaults for no rows", () => expect(parseSmsSettings([])).toEqual(DEFAULT_SMS_SETTINGS))
  it("reads scalars, arrays and caps", () => {
    const s = parseSmsSettings([
      { key: "sms_feature_enabled", value: false },
      { key: "sms_policy_enforced", value: true },
      { key: "sms_allowed_roles", value: ["shop_owner", "dealer"] },
      { key: "sms_caps", value: { platform: { per_send: 50 } } },
      { key: "sms_api_rate_limit_default", value: 12 },
      { key: "sms_hubtel_cost_per_sms", value: 0.031 },
    ])
    expect(s.featureEnabled).toBe(false)
    expect(s.policyEnforced).toBe(true)
    expect(s.allowedRoles).toEqual(["shop_owner", "dealer"])
    expect(s.caps.platform).toEqual({ per_send: 50, per_hour: 20, per_day: 500 })
    expect(s.caps.business).toEqual(DEFAULT_SMS_SETTINGS.caps.business)
    expect(s.apiRateLimitDefault).toBe(12)
    expect(s.hubtelCostPerSms).toBe(0.031)
  })
  it("tolerates legacy shapes: {enabled}, {value}, comma strings", () => {
    const s = parseSmsSettings([
      { key: "sms_feature_enabled", value: { enabled: false } },
      { key: "sms_auto_suspend_flags", value: { value: 3 } },
      { key: "sms_blocked_keywords", value: "loan, Win Big ,," },
    ])
    expect(s.featureEnabled).toBe(false)
    expect(s.autoSuspendFlags).toBe(3)
    expect(s.blockedKeywords).toEqual(["loan", "Win Big"])
  })
  it("falls back on garbage", () => {
    const s = parseSmsSettings([
      { key: "sms_api_rate_limit_default", value: -4 },
      { key: "sms_caps", value: "nope" },
      { key: "sms_sender_pool", value: 7 },
    ])
    expect(s.apiRateLimitDefault).toBe(30)
    expect(s.caps).toEqual(DEFAULT_SMS_SETTINGS.caps)
    expect(s.senderPool).toEqual([])
  })
})

describe("apiRateLimitFor", () => {
  it("prefers the account override", () => expect(apiRateLimitFor(500, 30)).toBe(500))
  it("uses the default when no override", () => expect(apiRateLimitFor(null, 30)).toBe(30))
  it("ignores out-of-range overrides", () => expect(apiRateLimitFor(0, 30)).toBe(30))
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/platform-settings.ts`**

```ts
/**
 * SMS platform settings (spec §5.1 "Settings"), stored as jsonb rows in
 * tenant_global_settings. The parser is tolerant: older admin screens saved some keys as
 * objects ({enabled}, {value}) or comma strings, and a bad value must never break sending.
 */
import { createClient } from "@supabase/supabase-js"

export type SmsMode = "platform" | "business"
export interface ModeCaps { per_send: number; per_hour: number; per_day: number }

export interface SmsPlatformSettings {
  featureEnabled: boolean
  policyEnforced: boolean
  allowedRoles: string[]
  senderPool: string[]
  caps: Record<SmsMode, ModeCaps>
  blockedKeywords: string[]
  businessBlockedKeywords: string[]
  businessFlaggedKeywords: string[]
  businessAllowedDomains: string[]
  autoSuspendFlags: number
  flagReviewThreshold: number
  apiRateLimitDefault: number
  protectedSenderNames: string[]
  hubtelCostPerSms: number
  hubtelLowBalanceGhs: number
}

export const DEFAULT_SMS_SETTINGS: SmsPlatformSettings = {
  featureEnabled: true,
  policyEnforced: false,
  allowedRoles: ["shop_owner", "sub_agent"],
  senderPool: [],
  caps: {
    platform: { per_send: 300, per_hour: 20, per_day: 500 },
    business: { per_send: 1000, per_hour: 2000, per_day: 1_000_000 },
  },
  blockedKeywords: [],
  businessBlockedKeywords: [],
  businessFlaggedKeywords: [],
  businessAllowedDomains: [],
  autoSuspendFlags: 2,
  flagReviewThreshold: 5,
  apiRateLimitDefault: 30,
  protectedSenderNames: ["MTN", "TELECEL", "AIRTELTIGO", "MOMO", "DATAGOD"],
  hubtelCostPerSms: 0.035,
  hubtelLowBalanceGhs: 50,
}

export const SMS_SETTING_KEYS = [
  "sms_feature_enabled", "sms_policy_enforced", "sms_allowed_roles", "sms_sender_pool", "sms_caps",
  "sms_blocked_keywords", "sms_business_blocked_keywords", "sms_business_flagged_keywords",
  "sms_business_allowed_domains", "sms_auto_suspend_flags", "sms_flag_review_threshold",
  "sms_api_rate_limit_default", "sms_protected_sender_names", "sms_hubtel_cost_per_sms",
  "sms_hubtel_low_balance_ghs",
] as const

function unwrap(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if ("enabled" in o) return o.enabled
    if ("value" in o) return o.value
    if ("amount" in o) return o.amount
  }
  return v
}
const bool = (v: unknown, d: boolean) => (typeof unwrap(v) === "boolean" ? (unwrap(v) as boolean) : d)
const num = (v: unknown, d: number, min: number, max: number) => {
  const n = typeof unwrap(v) === "number" ? (unwrap(v) as number) : NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : d
}
const int = (v: unknown, d: number, min: number, max: number) => {
  const n = num(v, d, min, max)
  return Number.isInteger(n) ? n : d
}
function list(v: unknown, d: string[]): string[] {
  const u = unwrap(v)
  const raw = Array.isArray(u) ? u : typeof u === "string" ? u.split(",") : null
  if (!raw) return d
  return raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean)
}
function caps(v: unknown): Record<SmsMode, ModeCaps> {
  const d = DEFAULT_SMS_SETTINGS.caps
  if (!v || typeof v !== "object" || Array.isArray(v)) return d
  const o = v as Record<string, Record<string, unknown> | undefined>
  const one = (m: SmsMode): ModeCaps => ({
    per_send: int(o[m]?.per_send, d[m].per_send, 1, 1_000_000),
    per_hour: int(o[m]?.per_hour, d[m].per_hour, 1, 1_000_000),
    per_day: int(o[m]?.per_day, d[m].per_day, 1, 100_000_000),
  })
  return { platform: one("platform"), business: one("business") }
}

export function parseSmsSettings(rows: { key: string; value: unknown }[]): SmsPlatformSettings {
  const m = new Map(rows.map((r) => [r.key, r.value]))
  const d = DEFAULT_SMS_SETTINGS
  return {
    featureEnabled: bool(m.get("sms_feature_enabled"), d.featureEnabled),
    policyEnforced: bool(m.get("sms_policy_enforced"), d.policyEnforced),
    allowedRoles: list(m.get("sms_allowed_roles"), d.allowedRoles),
    senderPool: list(m.get("sms_sender_pool"), d.senderPool).map((s) => s.toUpperCase()),
    caps: caps(m.get("sms_caps")),
    blockedKeywords: list(m.get("sms_blocked_keywords"), d.blockedKeywords),
    businessBlockedKeywords: list(m.get("sms_business_blocked_keywords"), d.businessBlockedKeywords),
    businessFlaggedKeywords: list(m.get("sms_business_flagged_keywords"), d.businessFlaggedKeywords),
    businessAllowedDomains: list(m.get("sms_business_allowed_domains"), d.businessAllowedDomains).map((s) => s.toLowerCase()),
    autoSuspendFlags: int(m.get("sms_auto_suspend_flags"), d.autoSuspendFlags, 1, 100),
    flagReviewThreshold: int(m.get("sms_flag_review_threshold"), d.flagReviewThreshold, 1, 500),
    apiRateLimitDefault: int(m.get("sms_api_rate_limit_default"), d.apiRateLimitDefault, 1, 10_000),
    protectedSenderNames: list(m.get("sms_protected_sender_names"), d.protectedSenderNames),
    hubtelCostPerSms: num(m.get("sms_hubtel_cost_per_sms"), d.hubtelCostPerSms, 0.0001, 10),
    hubtelLowBalanceGhs: num(m.get("sms_hubtel_low_balance_ghs"), d.hubtelLowBalanceGhs, 0, 1_000_000),
  }
}

/** Per-minute API limit for /api/v1/sms/send: account override, else the platform default. */
export function apiRateLimitFor(override: number | null | undefined, platformDefault: number): number {
  return typeof override === "number" && Number.isInteger(override) && override >= 1 && override <= 10_000
    ? override
    : platformDefault
}

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const CACHE_MS = 60_000
let cache: { at: number; value: SmsPlatformSettings } | null = null

/** Cached (60 s) settings. Falls back to defaults if the read fails — never throws. */
export async function loadSmsSettings(): Promise<SmsPlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const { data, error } = await supabaseAdmin
    .from("tenant_global_settings").select("key, value").in("key", [...SMS_SETTING_KEYS])
  if (error) {
    console.error("[SMS-SETTINGS] load failed, using defaults:", error.message)
    return cache?.value ?? DEFAULT_SMS_SETTINGS
  }
  const value = parseSmsSettings((data ?? []) as { key: string; value: unknown }[])
  cache = { at: Date.now(), value }
  return value
}

export function invalidateSmsSettingsCache(): void {
  cache = null
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(sms): typed platform settings with tolerant parser` + trailer.

---

### Task 5: Send-policy engine (pure)

**Files:**
- Create: `lib/sms/policy.ts`, `lib/sms/policy.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from "vitest"
import { evaluateSendPolicy, isOwnDomain, type PolicyInput } from "./policy"
import { DEFAULT_SMS_SETTINGS } from "./platform-settings"

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: false },
    settings: DEFAULT_SMS_SETTINGS,
    ownDomains: ["datagod.store", "kingsdata.com"],
    usage: { sendsLastHour: 0, recipientsLast24h: 0 },
    sender: { kind: "platform", name: null, kycFree: false },
    recipientCount: 10,
    message: "Hello, your data is ready",
    ...over,
  }
}
const withSettings = (s: Partial<typeof DEFAULT_SMS_SETTINGS>) => ({ ...DEFAULT_SMS_SETTINGS, ...s })

describe("evaluateSendPolicy — gates", () => {
  it("allows a clean platform send", () => {
    expect(evaluateSendPolicy(input())).toMatchObject({ decision: "allow", code: "OK", flags: [] })
  })
  it("master switch off → unavailable", () => {
    expect(evaluateSendPolicy(input({ settings: withSettings({ featureEnabled: false }) })).code).toBe("FEATURE_DISABLED")
  })
  it("role not allowed → reject", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "dealer", status: "active", mode: "platform", reviewHold: false } }))
    expect(r).toMatchObject({ decision: "reject", code: "ROLE_NOT_ALLOWED" })
  })
  it("admin audience is always allowed", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "admin", status: "active", mode: "business", reviewHold: false }, settings: withSettings({ allowedRoles: [] }) }))
    expect(r.decision).toBe("allow")
  })
  it("suspended → reject", () => {
    expect(evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "suspended", mode: "platform", reviewHold: false } })).code).toBe("SUSPENDED")
  })
})

describe("evaluateSendPolicy — senders", () => {
  it("platform mode: own kyc_free ok", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "own", name: "KINGS", kycFree: true } })).decision).toBe("allow")
  })
  it("platform mode: own non-kyc_free rejected", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "own", name: "KINGS2", kycFree: false } })).code).toBe("SENDER_NOT_ALLOWED")
  })
  it("platform mode: pool rejected", () => {
    expect(evaluateSendPolicy(input({ sender: { kind: "pool", name: "ALERTS", kycFree: false } })).code).toBe("SENDER_NOT_ALLOWED")
  })
  it("business mode: any own and pool ok", () => {
    const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
    expect(evaluateSendPolicy(input({ account: acct, sender: { kind: "own", name: "X", kycFree: false } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ account: acct, sender: { kind: "pool", name: "ALERTS", kycFree: false } })).decision).toBe("allow")
  })
})

describe("evaluateSendPolicy — caps", () => {
  it("per-send cap", () => {
    const r = evaluateSendPolicy(input({ recipientCount: 301 }))
    expect(r.code).toBe("CAP_PER_SEND")
    expect(r.reason).toContain("300")
  })
  it("per-hour cap counts this send", () => {
    expect(evaluateSendPolicy(input({ usage: { sendsLastHour: 19, recipientsLast24h: 0 } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ usage: { sendsLastHour: 20, recipientsLast24h: 0 } })).code).toBe("CAP_PER_HOUR")
  })
  it("per-day cap includes this send's recipients", () => {
    expect(evaluateSendPolicy(input({ recipientCount: 10, usage: { sendsLastHour: 0, recipientsLast24h: 490 } })).decision).toBe("allow")
    expect(evaluateSendPolicy(input({ recipientCount: 11, usage: { sendsLastHour: 0, recipientsLast24h: 490 } })).code).toBe("CAP_PER_DAY")
  })
  it("business caps are separate", () => {
    const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
    expect(evaluateSendPolicy(input({ account: acct, recipientCount: 900 })).decision).toBe("allow")
  })
})

describe("evaluateSendPolicy — platform content", () => {
  it("platform blocked keyword → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ settings: withSettings({ blockedKeywords: ["loan"] }), message: "Quick loan today" }))
    expect(r).toMatchObject({ decision: "block", code: "CONTENT_BLOCKED" })
    expect(r.flags).toEqual([{ severity: "fraud", reason: 'blocked keyword: "loan"', matched: "loan" }])
  })
  it("built-in phishing → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ message: "Send your PIN now" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
    expect(r.flags[0].severity).toBe("fraud")
  })
  it("own-domain store slugs with digits are not treated as lookalikes", () => {
    expect(evaluateSendPolicy(input({ message: "Order at kofi233.datagod.store/x" })).decision).toBe("allow")
  })
  it("own domain links allowed incl. subdomains and custom domains", () => {
    expect(evaluateSendPolicy(input({ message: "Shop at kings.datagod.store/x or https://kingsdata.com" })).decision).toBe("allow")
  })
  it("other links → block without a flag", () => {
    const r = evaluateSendPolicy(input({ message: "See example.com" }))
    expect(r).toMatchObject({ decision: "block", code: "LINK_NOT_ALLOWED", flags: [] })
    expect(r.reason).toContain("example.com")
  })
  it("shortener → block + fraud flag", () => {
    const r = evaluateSendPolicy(input({ message: "tap bit.ly/x" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
    expect(r.flags[0]).toMatchObject({ severity: "fraud", matched: "bit.ly" })
  })
})

describe("evaluateSendPolicy — business content", () => {
  const acct = { audience: "shop_owner", status: "active", mode: "business" as const, reviewHold: false }
  it("business blocked keyword → block + fraud", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessBlockedKeywords: ["casino"] }), message: "casino night" }))
    expect(r.code).toBe("CONTENT_BLOCKED")
  })
  it("platform keyword list does not apply to business", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ blockedKeywords: ["promo"] }), message: "big promo" }))
    expect(r.decision).toBe("allow")
  })
  it("flagged keyword → allow + info flag", () => {
    const r = evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessFlaggedKeywords: ["bonus"] }), message: "Bonus inside" }))
    expect(r.decision).toBe("allow")
    expect(r.flags).toEqual([{ severity: "info", reason: 'flagged keyword: "bonus"', matched: "bonus" }])
  })
  it("normal external links allowed", () => {
    expect(evaluateSendPolicy(input({ account: acct, message: "see example.com" })).flags).toEqual([])
  })
  it("suspicious link → info flag unless allow-listed", () => {
    expect(evaluateSendPolicy(input({ account: acct, message: "bit.ly/x" })).flags[0]).toMatchObject({ severity: "info", matched: "bit.ly" })
    expect(evaluateSendPolicy(input({ account: acct, settings: withSettings({ businessAllowedDomains: ["bit.ly"] }), message: "bit.ly/x" })).flags).toEqual([])
  })
})

describe("evaluateSendPolicy — review hold", () => {
  it("passing sends from a held account → hold, keeping flags", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: true } }))
    expect(r).toMatchObject({ decision: "hold", code: "REVIEW_HOLD" })
  })
  it("a block still wins over hold", () => {
    const r = evaluateSendPolicy(input({ account: { audience: "shop_owner", status: "active", mode: "platform", reviewHold: true }, message: "example.com" }))
    expect(r.decision).toBe("block")
  })
})

describe("isOwnDomain", () => {
  it("matches exact, subdomain and www", () => {
    expect(isOwnDomain("datagod.store", ["datagod.store"])).toBe(true)
    expect(isOwnDomain("a.b.datagod.store", ["datagod.store"])).toBe(true)
    expect(isOwnDomain("www.kingsdata.com", ["kingsdata.com"])).toBe(true)
    expect(isOwnDomain("notdatagod.store", ["datagod.store"])).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/policy.ts`**

```ts
/**
 * Send policy (spec §5.3). Pure: the caller supplies account, settings, usage, sender and
 * message; nothing here does I/O. Checks run in a fixed order and the first failure wins,
 * so the customer always gets the single most relevant message. In Phase 1 the result is
 * only RECORDED (sms_send_logs.policy_shadow); enforcement arrives with Phase 3.
 */
import { extractLinkHosts, matchBlockedContent, suspiciousHostReason } from "./content-filter"
import type { SmsMode, SmsPlatformSettings } from "./platform-settings"

export type PolicyDecision = "allow" | "hold" | "reject" | "block" | "unavailable"
export type PolicyCode =
  | "OK" | "FEATURE_DISABLED" | "ROLE_NOT_ALLOWED" | "SUSPENDED" | "SENDER_NOT_ALLOWED"
  | "CAP_PER_SEND" | "CAP_PER_HOUR" | "CAP_PER_DAY" | "CONTENT_BLOCKED" | "LINK_NOT_ALLOWED" | "REVIEW_HOLD"

export interface PolicyFlag { severity: "fraud" | "info"; reason: string; matched: string }
export interface PolicyAccount {
  /** "admin" for platform owner accounts; otherwise shop_owner | sub_agent | dealer | user */
  audience: string
  status: string
  mode: SmsMode
  reviewHold: boolean
}
export interface PolicySender { kind: "platform" | "own" | "pool"; name: string | null; kycFree: boolean }
export interface PolicyUsage { sendsLastHour: number; recipientsLast24h: number }

export interface PolicyInput {
  account: PolicyAccount
  settings: SmsPlatformSettings
  ownDomains: string[]
  usage: PolicyUsage
  sender: PolicySender
  recipientCount: number
  message: string
}
export interface PolicyResult { decision: PolicyDecision; code: PolicyCode; reason: string; flags: PolicyFlag[] }

const result = (decision: PolicyDecision, code: PolicyCode, reason: string, flags: PolicyFlag[] = []): PolicyResult =>
  ({ decision, code, reason, flags })

export function isOwnDomain(host: string, ownDomains: string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "")
  return ownDomains.some((raw) => {
    const d = raw.toLowerCase().replace(/^www\./, "")
    return !!d && (h === d || h.endsWith(`.${d}`))
  })
}

const keywordOf = (reason: string) => /^blocked keyword: "(.*)"$/.exec(reason)?.[1] ?? reason
const fmt = (n: number) => n.toLocaleString("en-US")

export function evaluateSendPolicy(p: PolicyInput): PolicyResult {
  const { account, settings, usage, sender } = p

  // 1. Master switch
  if (!settings.featureEnabled) {
    return result("unavailable", "FEATURE_DISABLED", "SMS sending is temporarily unavailable. Please try again later.")
  }

  // 2. Role + account status
  if (account.audience !== "admin" && !settings.allowedRoles.includes(account.audience)) {
    return result("reject", "ROLE_NOT_ALLOWED", "SMS isn't available for your account type. Contact support if you need it.")
  }
  if (account.status === "suspended") {
    return result("reject", "SUSPENDED", "Your SMS account is suspended. Contact support to restore it.")
  }

  // 3. Sender allowed for mode
  if (account.mode === "platform") {
    if (sender.kind === "pool") {
      return result("reject", "SENDER_NOT_ALLOWED", "Shared sender names are for verified businesses. Use the platform sender or your own sender ID.")
    }
    if (sender.kind === "own" && !sender.kycFree) {
      return result("reject", "SENDER_NOT_ALLOWED", `In Platform mode you can send as the platform sender or your one free sender ID. Verify your business to use ${sender.name ?? "this sender ID"}.`)
    }
  }

  // 4. Caps (this send counts toward the hour and the day)
  const cap = settings.caps[account.mode]
  if (p.recipientCount > cap.per_send) {
    return result("reject", "CAP_PER_SEND", `This send has ${fmt(p.recipientCount)} recipients; your limit is ${fmt(cap.per_send)} per send. Split it into smaller sends.`)
  }
  if (usage.sendsLastHour + 1 > cap.per_hour) {
    return result("reject", "CAP_PER_HOUR", `You've reached ${fmt(cap.per_hour)} sends this hour. Try again within the hour.`)
  }
  if (usage.recipientsLast24h + p.recipientCount > cap.per_day) {
    return result("reject", "CAP_PER_DAY", `This would pass your daily limit of ${fmt(cap.per_day)} recipients (${fmt(usage.recipientsLast24h)} used in the last 24 hours). Reduce recipients or try again later.`)
  }

  // 5. Content
  const flags: PolicyFlag[] = []
  const hosts = extractLinkHosts(p.message)
  if (account.mode === "platform") {
    const blocked = matchBlockedContent(p.message, settings.blockedKeywords)
    if (blocked) {
      return result("block", "CONTENT_BLOCKED", "This message contains content we can't send. Edit it and try again.",
        [{ severity: "fraud", reason: blocked, matched: keywordOf(blocked) }])
    }
    for (const host of hosts) {
      // Own domains first: shop slugs may contain digits (kofi233.datagod.store), which the
      // lookalike check would otherwise flag as fraud.
      if (isOwnDomain(host, p.ownDomains)) continue
      const suspicious = suspiciousHostReason(host)
      if (suspicious) {
        return result("block", "CONTENT_BLOCKED", `The link ${host} isn't allowed. Remove it and try again.`,
          [{ severity: "fraud", reason: suspicious, matched: host }])
      }
      return result("block", "LINK_NOT_ALLOWED", `Platform mode only allows links to your Datagod store. Remove ${host}, or verify your business to send other links.`)
    }
  } else {
    const blocked = matchBlockedContent(p.message, settings.businessBlockedKeywords)
    if (blocked) {
      return result("block", "CONTENT_BLOCKED", "This message contains content we can't send. Edit it and try again.",
        [{ severity: "fraud", reason: blocked, matched: keywordOf(blocked) }])
    }
    const lower = p.message.toLowerCase()
    for (const kw of settings.businessFlaggedKeywords) {
      if (kw.trim() && lower.includes(kw.toLowerCase())) {
        flags.push({ severity: "info", reason: `flagged keyword: "${kw}"`, matched: kw })
      }
    }
    for (const host of hosts) {
      const suspicious = suspiciousHostReason(host)
      if (suspicious && !isOwnDomain(host, [...p.ownDomains, ...settings.businessAllowedDomains])) {
        flags.push({ severity: "info", reason: suspicious, matched: host })
      }
    }
  }

  // 6. Review hold: everything passed, but an admin must release it.
  if (account.reviewHold) {
    return result("hold", "REVIEW_HOLD", "Your account is under review. This send will go out once an admin approves it.", flags)
  }
  return result("allow", "OK", "", flags)
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(sms): pure send-policy engine` + trailer.

---

### Task 6: Policy context + record-only wiring into `enqueueSend`

**Files:**
- Create: `lib/sms/policy-context.ts`, `lib/sms/policy-context.test.ts`
- Modify: `lib/sms/send-service.ts`, `lib/sms/send-service.test.ts`

- [ ] **Step 1: Failing tests for the pure parts** (`lib/sms/policy-context.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest"
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
import { audienceFor, buildShadow, PLATFORM_ROOT_DOMAIN } from "./policy-context"

describe("audienceFor", () => {
  it("maps owner types", () => {
    expect(audienceFor("platform", "admin")).toBe("admin")
    expect(audienceFor("shop", "dealer")).toBe("shop_owner")
    expect(audienceFor("sub_agent", "sub_agent")).toBe("sub_agent")
    expect(audienceFor("individual", "dealer")).toBe("dealer")
    expect(audienceFor("individual", null)).toBe("user")
  })
})

describe("buildShadow", () => {
  it("records the decision, record-only", () => {
    const s = buildShadow({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [] }, false, new Date("2026-10-10T00:00:00Z"))
    expect(s).toEqual({ decision: "block", code: "LINK_NOT_ALLOWED", reason: "r", flags: [], enforced: false, evaluated_at: "2026-10-10T00:00:00.000Z" })
  })
})

it("root domain is datagod.store", () => expect(PLATFORM_ROOT_DOMAIN).toBe("datagod.store"))
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/policy-context.ts`**

```ts
/**
 * I/O around the pure send policy: loads settings, our own link domains, recent usage and
 * the account's audience, resolves the chosen sender, and produces the record-only shadow.
 * shadowPolicy() never throws — a policy hiccup must not stop a send in Phase 1.
 */
import { createClient } from "@supabase/supabase-js"
import { evaluateSendPolicy, type PolicyResult, type PolicySender, type PolicyUsage } from "./policy"
import { loadSmsSettings, type SmsMode } from "./platform-settings"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const PLATFORM_ROOT_DOMAIN = "datagod.store"

export function audienceFor(ownerType: string, role: string | null | undefined): string {
  if (ownerType === "platform") return "admin"
  if (ownerType === "shop") return "shop_owner"
  if (ownerType === "sub_agent") return "sub_agent"
  return role || "user"
}

export interface PolicyShadow extends PolicyResult { enforced: boolean; evaluated_at: string }
export function buildShadow(r: PolicyResult, enforced: boolean, now = new Date()): PolicyShadow {
  return { ...r, enforced, evaluated_at: now.toISOString() }
}

let domainCache: { at: number; value: string[] } | null = null
/** datagod.store (+ subdomains via isOwnDomain) and every active custom domain. 5-min cache. */
export async function loadOwnDomains(): Promise<string[]> {
  if (domainCache && Date.now() - domainCache.at < 5 * 60_000) return domainCache.value
  const { data } = await supabaseAdmin.from("custom_domains").select("domain").eq("is_active", true)
  const value = [PLATFORM_ROOT_DOMAIN, ...((data ?? []) as { domain: string | null }[]).map((r) => (r.domain ?? "").toLowerCase()).filter(Boolean)]
  domainCache = { at: Date.now(), value }
  return value
}

/** Sends in the last hour and recipients in the last 24 h (blocked sends don't count). */
export async function loadUsage(accountId: string, now = Date.now()): Promise<PolicyUsage> {
  const hourAgo = new Date(now - 3_600_000).toISOString()
  const dayAgo = new Date(now - 86_400_000).toISOString()
  const [hour, day] = await Promise.all([
    supabaseAdmin.from("sms_send_logs").select("id", { count: "exact", head: true })
      .eq("sms_account_id", accountId).neq("status", "blocked").gte("created_at", hourAgo),
    supabaseAdmin.from("sms_send_logs").select("recipients_count")
      .eq("sms_account_id", accountId).neq("status", "blocked").gte("created_at", dayAgo),
  ])
  const recipientsLast24h = ((day.data ?? []) as { recipients_count: number | null }[])
    .reduce((s, r) => s + (r.recipients_count ?? 0), 0)
  return { sendsLastHour: hour.count ?? 0, recipientsLast24h }
}

export interface AccountSnapshot { mode: SmsMode; status: string; ownerType: string; reviewHold: boolean; audience: string }
export async function loadAccountSnapshot(accountId: string): Promise<AccountSnapshot | null> {
  const { data: a } = await supabaseAdmin.from("sms_accounts")
    .select("mode, status, owner_type, review_hold, user_id").eq("id", accountId).maybeSingle()
  if (!a) return null
  const { data: u } = await supabaseAdmin.from("users").select("role").eq("id", a.user_id).maybeSingle()
  return {
    mode: (a.mode as SmsMode) ?? "platform",
    status: a.status,
    ownerType: a.owner_type,
    reviewHold: !!a.review_hold,
    audience: audienceFor(a.owner_type, (u as { role?: string } | null)?.role),
  }
}

/**
 * Resolve a requested sender name for this account. Omitted → platform sender.
 * Own ACTIVE IDs (paused/revoked never resolve), else a pool name for business accounts.
 * Returns null when the name is not usable (→ INVALID_SENDER_ID).
 */
export async function resolveCampaignSender(accountId: string, senderId?: string | null): Promise<PolicySender | null> {
  const sid = (senderId ?? "").trim().toUpperCase()
  if (!sid) return { kind: "platform", name: null, kycFree: false }
  const { data: own } = await supabaseAdmin.from("sms_sender_ids")
    .select("sender_id, kyc_free").eq("sms_account_id", accountId).eq("sender_id", sid)
    .eq("local_status", "active").maybeSingle()
  if (own) return { kind: "own", name: sid, kycFree: !!(own as { kyc_free?: boolean }).kyc_free }
  const [settings, account] = await Promise.all([loadSmsSettings(), loadAccountSnapshot(accountId)])
  if (account?.mode === "business" && settings.senderPool.includes(sid)) return { kind: "pool", name: sid, kycFree: false }
  return null
}

/** Evaluate the policy for a send and return { mode, shadow }. Never throws. */
export async function shadowPolicy(args: {
  accountId: string; sender: PolicySender; recipientCount: number; message: string
}): Promise<{ mode: SmsMode | null; shadow: PolicyShadow | { error: string; evaluated_at: string } }> {
  try {
    const [settings, ownDomains, usage, account] = await Promise.all([
      loadSmsSettings(), loadOwnDomains(), loadUsage(args.accountId), loadAccountSnapshot(args.accountId),
    ])
    if (!account) return { mode: null, shadow: { error: "account not found", evaluated_at: new Date().toISOString() } }
    const r = evaluateSendPolicy({
      account: { audience: account.audience, status: account.status, mode: account.mode, reviewHold: account.reviewHold },
      settings, ownDomains, usage, sender: args.sender, recipientCount: args.recipientCount, message: args.message,
    })
    if (settings.policyEnforced) {
      console.warn("[SMS-POLICY] sms_policy_enforced=true but enforcement ships in Phase 3 — recording only")
    }
    return { mode: account.mode, shadow: buildShadow(r, false) }
  } catch (e) {
    console.error("[SMS-POLICY] shadow evaluation failed:", e)
    return { mode: null, shadow: { error: String((e as Error)?.message ?? e), evaluated_at: new Date().toISOString() } }
  }
}
```

- [ ] **Step 4: Run policy-context tests — PASS.**

- [ ] **Step 5: Wire into `lib/sms/send-service.ts`**

1. Imports: add
```ts
import { resolveCampaignSender, shadowPolicy } from "./policy-context"
```
2. Replace step **1b** (the whole `let resolvedSenderId … if (senderId && senderId.trim()) { … }` block) with:
```ts
  // 1b. Resolve the chosen sender (before any debit): own ACTIVE IDs only (paused/revoked
  //     never resolve), or a pool name for business accounts. Omitted → platform default.
  const sender = await resolveCampaignSender(accountId, senderId)
  if (!sender) return { ok: false, error: "INVALID_SENDER_ID" }
  const resolvedSenderId: string | null = sender.name
```
3. Directly after the `EMPTY_MESSAGE` checks of step 2, add:
```ts
  // 2b. Send policy — RECORD-ONLY in Phase 1 (spec §5.3): the would-be decision is stored
  //     on the send log; the send proceeds exactly as before.
  const { mode, shadow } = await shadowPolicy({ accountId, sender, recipientCount: recipients.length, message: prepared })
```
4. Add `mode, policy_shadow: shadow,` to **both** `sms_send_logs` inserts (the `blocked` one in step 3 and the `queued` one in step 6).

- [ ] **Step 6: Update `lib/sms/send-service.test.ts`**

The fake's `sms_sender_ids` handling is no longer reached. Add a module mock next to the existing `vi.mock` calls (keep `h.state.senderRow` as the driver so existing sender tests keep their meaning):
```ts
vi.mock("./policy-context", () => ({
  resolveCampaignSender: (_acct: string, sid?: string | null) => {
    const s = (sid ?? "").trim().toUpperCase()
    if (!s) return Promise.resolve({ kind: "platform", name: null, kycFree: false })
    const row = h.state.senderRow
    return Promise.resolve(row && row.local_status === "active" ? { kind: "own", name: s, kycFree: true } : null)
  },
  shadowPolicy: () => Promise.resolve({ mode: "platform", shadow: { decision: "allow", code: "OK", reason: "", flags: [], enforced: false, evaluated_at: "t" } }),
}))
```
Any existing test that set `senderRow` to `{ local_status: "pending", mnotify_local_status: "active" }` and expected success must now expect `INVALID_SENDER_ID` (mNotify-only activation no longer counts — sender approval is ours, `local_status` is canonical). Update those expectations and add one assertion that the queued `sms_send_logs` insert includes `mode: "platform"` and a `policy_shadow` object.

- [ ] **Step 7: Run** `npx vitest run lib/sms/send-service.test.ts lib/sms/policy-context.test.ts lib/sms/policy.test.ts` — PASS; `npx tsc --noEmit` — clean.

- [ ] **Step 8: Commit** — `feat(sms): record-only send policy on every customer send` + trailer.

---

### Task 7: Hubtel SMS adapter

**Files:**
- Create: `lib/sms/providers/hubtel.ts`, `lib/sms/providers/hubtel.test.ts`

Built strictly from the Hubtel SMS docs the user supplied 2026-10-10 (quoted in the spec §5.4). Key facts: Basic auth with the SMS client id/secret; recipients as `233XXXXXXXXX`; success = 2xx **and** body `status === 0`; HTTP 201 can carry `status` 1/2/100 (rejections); 402 or body status 12 = out of funds; batch responses `{batchId, status, data:[{recipient, content, messageId}]}`; batch status `GET /v1/messages/batch/{batchId}` → `{batchId, data:[{rate, messageId, status, updateTime, to, …}]}`; single status `GET /v1/messages/{messageId}` → `{rate, messageId, status, updateTime, …}`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect, vi } from "vitest"
import {
  classifyHubtelResponse, mapHubtelStatus, toHubtelMsisdn, hubtelSendSingle, hubtelSendBatchSimple,
  hubtelSendBatchPersonalized, hubtelGetBatchStatus, hubtelGetMessageStatus, type HubtelConfig,
} from "./hubtel"

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))
}
const cfg = (f: ReturnType<typeof fakeFetch>): HubtelConfig => ({ clientId: "id", clientSecret: "secret", fetchImpl: f as unknown as typeof fetch })

describe("toHubtelMsisdn", () => {
  it("normalises Ghana numbers", () => {
    expect(toHubtelMsisdn("+233241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("0241234567")).toBe("233241234567")
    expect(toHubtelMsisdn("233241234567")).toBe("233241234567")
  })
})

describe("classifyHubtelResponse", () => {
  it("2xx + status 0 → accepted", () => expect(classifyHubtelResponse(201, { status: 0 }).outcome).toBe("accepted"))
  it("201 + status 1/2/100 → rejected (the 201 trap)", () => {
    for (const s of [1, 2, 100]) expect(classifyHubtelResponse(201, { status: s }).outcome).toBe("rejected")
  })
  it("2xx without a status → rejected (never assume success)", () => expect(classifyHubtelResponse(200, {}).outcome).toBe("rejected"))
  it("402 or status 12 → out_of_funds", () => {
    expect(classifyHubtelResponse(402, {}).outcome).toBe("out_of_funds")
    expect(classifyHubtelResponse(400, { status: 12 }).outcome).toBe("out_of_funds")
  })
  it("400 → rejected; 401/5xx → retryable", () => {
    expect(classifyHubtelResponse(400, { status: 4 }).outcome).toBe("rejected")
    expect(classifyHubtelResponse(401, {}).outcome).toBe("retryable")
    expect(classifyHubtelResponse(502, {}).outcome).toBe("retryable")
  })
})

describe("mapHubtelStatus", () => {
  it("maps DLR statuses", () => {
    expect(mapHubtelStatus("Delivered")).toBe("delivered")
    expect(mapHubtelStatus("Sent")).toBe("pending")
    expect(mapHubtelStatus("Pending")).toBe("pending")
    expect(mapHubtelStatus("")).toBe("pending")
    for (const s of ["Blacklisted", "Undeliverable/Failed", "Rejected", "NACK/0x0000000b/Invalid Destination Address"]) {
      expect(mapHubtelStatus(s)).toBe("failed")
    }
  })
})

describe("senders", () => {
  it("single: posts From/To/Content with Basic auth and returns messageId + rate", async () => {
    const f = fakeFetch(201, { rate: 0.0246, messageId: "m1", status: 0 })
    const r = await hubtelSendSingle(cfg(f), { from: "KINGS", to: "+233241234567", content: "hi" })
    expect(r).toMatchObject({ outcome: "accepted", messageId: "m1", rate: 0.0246 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://sms.hubtel.com/v1/messages/send")
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`)
    expect(JSON.parse(String(init.body))).toEqual({ From: "KINGS", To: "233241234567", Content: "hi" })
  })
  it("batch simple: returns batchId and recipient→messageId", async () => {
    const f = fakeFetch(200, { batchId: "b1", status: 0, data: [{ recipient: "233241234567", content: "x", messageId: "m1" }] })
    const r = await hubtelSendBatchSimple(cfg(f), { from: "KINGS", recipients: ["+233241234567"], content: "x" })
    expect(r).toMatchObject({ outcome: "accepted", batchId: "b1", messages: [{ recipient: "233241234567", messageId: "m1" }] })
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ From: "KINGS", Recipients: ["233241234567"], Content: "x" })
  })
  it("batch personalized: sends personalizedRecipients", async () => {
    const f = fakeFetch(200, { batchId: "b2", status: 0, data: [] })
    await hubtelSendBatchPersonalized(cfg(f), { from: "KINGS", items: [{ to: "0241234567", content: "Hi A" }] })
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ From: "KINGS", personalizedRecipients: [{ To: "233241234567", Content: "Hi A" }] })
  })
  it("network error → retryable", async () => {
    const f = vi.fn(async () => { throw new Error("boom") })
    const r = await hubtelSendSingle({ clientId: "a", clientSecret: "b", fetchImpl: f as unknown as typeof fetch }, { from: "X", to: "0241234567", content: "y" })
    expect(r.outcome).toBe("retryable")
  })
})

describe("status checks", () => {
  it("batch status maps each message", async () => {
    const f = fakeFetch(200, { batchId: "b1", data: [
      { rate: 0.0309, messageId: "m1", status: "Delivered", updateTime: "2026-10-10T10:00:00" },
      { rate: 0.0309, messageId: "m2", status: "Rejected" },
      { messageId: "m3", status: "Sent" },
    ] })
    const r = await hubtelGetBatchStatus(cfg(f), "b1")
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://sms.hubtel.com/v1/messages/batch/b1")
    expect(r.ok).toBe(true)
    expect(r.messages.map((m) => [m.messageId, m.state, m.rate])).toEqual([["m1", "delivered", 0.0309], ["m2", "failed", 0.0309], ["m3", "pending", undefined]])
  })
  it("non-2xx batch status → ok:false", async () => {
    expect((await hubtelGetBatchStatus(cfg(fakeFetch(404, {})), "x")).ok).toBe(false)
  })
  it("single message status", async () => {
    const r = await hubtelGetMessageStatus(cfg(fakeFetch(200, { rate: 0.03, messageId: "m9", status: "Delivered" })), "m9")
    expect(r).toMatchObject({ ok: true, messages: [{ messageId: "m9", state: "delivered", rate: 0.03 }] })
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/providers/hubtel.ts`**

```ts
/**
 * Hubtel SMS REST API — the only file that knows Hubtel's wire format (spec §5.4).
 * Never throws: every call resolves to a classified result.
 */
export interface HubtelConfig {
  clientId: string
  clientSecret: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const HUBTEL_BATCH_CHUNK = 100 // docs give no limit; conservative until live-tested

export function hubtelConfigFromEnv(): HubtelConfig | null {
  const clientId = process.env.HUBTEL_SMS_CLIENT_ID
  const clientSecret = process.env.HUBTEL_SMS_CLIENT_SECRET
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Hubtel expects 233XXXXXXXXX (no plus). */
export function toHubtelMsisdn(phone: string): string {
  const d = String(phone ?? "").replace(/\D/g, "")
  if (d.startsWith("233")) return d
  if (d.startsWith("0") && d.length === 10) return `233${d.slice(1)}`
  if (d.length === 9) return `233${d}`
  return d
}

export type HubtelOutcome = "accepted" | "rejected" | "out_of_funds" | "retryable"

export function classifyHubtelResponse(httpStatus: number, body: unknown): { outcome: HubtelOutcome; bodyStatus: number | null; error?: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const bodyStatus = typeof b.status === "number" ? b.status : null
  const desc = typeof b.statusDescription === "string" ? b.statusDescription : typeof b.message === "string" ? b.message : ""
  if (httpStatus === 0) return { outcome: "retryable", bodyStatus, error: desc || "network error" }
  if (httpStatus === 402 || bodyStatus === 12) return { outcome: "out_of_funds", bodyStatus, error: "Hubtel account out of funds" }
  if (httpStatus >= 200 && httpStatus < 300) {
    if (bodyStatus === 0) return { outcome: "accepted", bodyStatus }
    return { outcome: "rejected", bodyStatus, error: `Hubtel status ${bodyStatus ?? "missing"}${desc ? `: ${desc}` : ""}` }
  }
  if (httpStatus === 401 || httpStatus >= 500) return { outcome: "retryable", bodyStatus, error: `Hubtel HTTP ${httpStatus}` }
  return { outcome: "rejected", bodyStatus, error: `Hubtel HTTP ${httpStatus}${bodyStatus !== null ? ` status ${bodyStatus}` : ""}${desc ? `: ${desc}` : ""}` }
}

export type HubtelDeliveryState = "delivered" | "pending" | "failed"
export function mapHubtelStatus(status: string | null | undefined): HubtelDeliveryState {
  const s = (status ?? "").trim().toLowerCase()
  if (s === "delivered") return "delivered"
  if (s === "" || s === "sent" || s === "pending") return "pending"
  return "failed"
}

export interface HubtelSendResult {
  outcome: HubtelOutcome
  httpStatus: number
  bodyStatus: number | null
  error?: string
  messageId?: string
  rate?: number
  batchId?: string
  messages: { recipient: string; messageId: string }[]
}

async function call(cfg: HubtelConfig, method: "GET" | "POST", path: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const doFetch = cfg.fetchImpl ?? fetch
  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")
  try {
    const res = await doFetch(`${cfg.baseUrl ?? "https://sms.hubtel.com"}${path}`, {
      method,
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
    })
    const text = await res.text()
    let body: unknown = text
    try { body = JSON.parse(text) } catch { /* keep text */ }
    return { status: res.status, body }
  } catch (e) {
    return { status: 0, body: { message: String((e as Error)?.message ?? e) } }
  }
}

function toSendResult(status: number, body: unknown): HubtelSendResult {
  const c = classifyHubtelResponse(status, body)
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
  return {
    outcome: c.outcome, httpStatus: status, bodyStatus: c.bodyStatus, error: c.error,
    messageId: typeof b.messageId === "string" ? b.messageId : undefined,
    rate: typeof b.rate === "number" ? b.rate : undefined,
    batchId: typeof b.batchId === "string" ? b.batchId : undefined,
    messages: data
      .filter((d) => typeof d.recipient === "string" && typeof d.messageId === "string")
      .map((d) => ({ recipient: d.recipient as string, messageId: d.messageId as string })),
  }
}

export async function hubtelSendSingle(cfg: HubtelConfig, m: { from: string; to: string; content: string }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/send", { From: m.from, To: toHubtelMsisdn(m.to), Content: m.content })
  return toSendResult(r.status, r.body)
}

export async function hubtelSendBatchSimple(cfg: HubtelConfig, m: { from: string; recipients: string[]; content: string }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/simple/send", { From: m.from, Recipients: m.recipients.map(toHubtelMsisdn), Content: m.content })
  return toSendResult(r.status, r.body)
}

export async function hubtelSendBatchPersonalized(cfg: HubtelConfig, m: { from: string; items: { to: string; content: string }[] }): Promise<HubtelSendResult> {
  const r = await call(cfg, "POST", "/v1/messages/batch/personalized/send", {
    From: m.from,
    personalizedRecipients: m.items.map((i) => ({ To: toHubtelMsisdn(i.to), Content: i.content })),
  })
  return toSendResult(r.status, r.body)
}

export interface HubtelStatusEntry { messageId: string; state: HubtelDeliveryState; rawStatus: string; rate?: number; updateTime?: string }
export interface HubtelStatusResult { ok: boolean; error?: string; messages: HubtelStatusEntry[] }

function toEntry(d: Record<string, unknown>): HubtelStatusEntry | null {
  if (typeof d.messageId !== "string") return null
  const raw = typeof d.status === "string" ? d.status : ""
  return {
    messageId: d.messageId, state: mapHubtelStatus(raw), rawStatus: raw,
    rate: typeof d.rate === "number" ? d.rate : undefined,
    updateTime: typeof d.updateTime === "string" ? d.updateTime : undefined,
  }
}

export async function hubtelGetBatchStatus(cfg: HubtelConfig, batchId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/batch/${encodeURIComponent(batchId)}`)
  if (r.status < 200 || r.status >= 300) return { ok: false, error: `Hubtel HTTP ${r.status}`, messages: [] }
  const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>
  const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
  return { ok: true, messages: data.map(toEntry).filter((e): e is HubtelStatusEntry => e !== null) }
}

export async function hubtelGetMessageStatus(cfg: HubtelConfig, messageId: string): Promise<HubtelStatusResult> {
  const r = await call(cfg, "GET", `/v1/messages/${encodeURIComponent(messageId)}`)
  if (r.status < 200 || r.status >= 300) return { ok: false, error: `Hubtel HTTP ${r.status}`, messages: [] }
  const e = toEntry((r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>)
  return { ok: true, messages: e ? [e] : [] }
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(sms): Hubtel SMS adapter (send, batch, status, 201 trap)` + trailer.

---

### Task 8: Hubtel in provider routing + `sendSMS`

> **Amendment (after Task 7 review):** the adapter now has a fifth outcome `"unknown"` (Hubtel may have accepted: timeout after send, 5xx gateway, unparseable 2xx). In `sendSMSViaHubtel` treat `unknown` as success: log a warning ("outcome unknown — may have been sent, not failing over"), log the sms_logs row with `moolre_message_id: null`, and return `{ success: true, provider: "hubtel" }` — never fall over to another provider on `unknown` (an OTP or receipt would arrive twice). Only `rejected`, `retryable` and `out_of_funds` return `success: false`.

**Files:**
- Modify: `lib/sms/routing.ts`, `lib/sms/routing.test.ts`, `lib/sms-service.ts`, `lib/sms/notify.ts`, `app/admin/sms-centre/_components/ProvidersTab.tsx`

- [ ] **Step 1: Failing tests** (append to `lib/sms/routing.test.ts`)

```ts
import { narrowProvidersForSender } from "./routing"

describe("hubtel routing", () => {
  it("accepts hubtel as primary", () => {
    expect(parseRoutingConfig([{ key: "sms_primary_provider", value: "hubtel" }]).primary).toBe("hubtel")
  })
})

describe("narrowProvidersForSender", () => {
  const active = { local_status: "active", mnotify_local_status: "pending" }
  it("no custom sender → unchanged", () => {
    expect(narrowProvidersForSender(["hubtel", "moolre", "mnotify"], null, false)).toEqual(["hubtel", "moolre", "mnotify"])
  })
  it("custom sender with hubtel leading → hubtel only (fallback gateways never registered it)", () => {
    expect(narrowProvidersForSender(["hubtel", "moolre", "mnotify"], active, true)).toEqual(["hubtel"])
  })
  it("custom sender with moolre leading keeps today's narrowing, hubtel allowed for local active", () => {
    expect(narrowProvidersForSender(["moolre", "mnotify", "hubtel"], active, true)).toEqual(["moolre", "hubtel"])
  })
  it("unknown sender row leaves the order alone", () => {
    expect(narrowProvidersForSender(["moolre", "mnotify"], null, true)).toEqual(["moolre", "mnotify"])
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement routing changes** in `lib/sms/routing.ts`:

```ts
const VALID_PROVIDERS = ["moolre", "mnotify", "brevo", "hubtel"] as const
```
and append:
```ts
/**
 * Narrow a provider chain for a CUSTOM sender ID. Sender approval is ours (local_status);
 * Hubtel passes any sender through, the fallback gateways only accept IDs registered with
 * them. Once Hubtel leads, custom senders go via Hubtel only (spec §5.4).
 */
export function narrowProvidersForSender(
  order: string[],
  senderRow: { local_status: string | null; mnotify_local_status: string | null } | null,
  hasCustomSender: boolean
): string[] {
  if (!hasCustomSender) return order
  if (order[0] === "hubtel") return ["hubtel"]
  if (!senderRow) return order
  const approved = new Set<string>()
  if (senderRow.local_status === "active") { approved.add("moolre"); approved.add("hubtel") }
  if (senderRow.mnotify_local_status === "active") approved.add("mnotify")
  const narrowed = order.filter((p) => approved.size === 0 || approved.has(p))
  return narrowed.length > 0 ? narrowed : order
}
```

- [ ] **Step 4: Generic admin alert** — append to `lib/sms/notify.ts`:

```ts
/** Throttled in-app alert to every admin. `type` doubles as the throttle key. Never throws. */
export async function notifyAdminsThrottled(type: string, title: string, message: string, actionUrl = "/admin/sms", throttleMs = THROTTLE_MS): Promise<void> {
  try {
    const since = new Date(Date.now() - throttleMs).toISOString()
    const { data: recent } = await supabaseAdmin.from("notifications").select("id").eq("type", type).gte("created_at", since).limit(1)
    if (recent && recent.length > 0) return
    const { data: admins } = await supabaseAdmin.from("users").select("id").eq("role", "admin")
    if (!admins?.length) return
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin.from("notifications").insert(
      admins.map((a: { id: string }) => ({ user_id: a.id, title, message, type, read: false, action_url: actionUrl, created_at: now, updated_at: now }))
    )
    if (error) console.error(`[SMS-NOTIFY] ${type} insert failed:`, error.message)
  } catch (e) {
    console.error(`[SMS-NOTIFY] ${type} failed:`, e)
  }
}

export function notifyHubtelOutOfFunds(): Promise<void> {
  return notifyAdminsThrottled("sms_hubtel_out_of_funds", "Hubtel SMS out of funds",
    "Hubtel refused an SMS for lack of funds. Top up the Hubtel Disbursement account — queued messages retry automatically.")
}
```

- [ ] **Step 5: `sendSMSViaHubtel` in `lib/sms-service.ts`**

Imports at the top:
```ts
import { hubtelConfigFromEnv, hubtelSendSingle } from '@/lib/sms/providers/hubtel'
import { narrowProvidersForSender } from '@/lib/sms/routing'
```
(`getRoutingConfig` is already imported from the same module — merge into one import line.)

Add above `const SMS_SENDERS`:
```ts
/** Default "From" on Hubtel when no custom sender is chosen. Same brand as the Moolre default. */
export function platformSenderName(): string {
  return process.env.HUBTEL_SENDER_ID || process.env.MOOLRE_SENDER_ID || 'CLINGDTGOD'
}

/** Single SMS via Hubtel (spec §5.4). Logs to sms_logs like the other providers
 *  (moolre_message_id column is reused for the provider message id, as Brevo does). */
async function sendSMSViaHubtel(payload: SMSPayload): Promise<SendSMSResponse> {
  const cfg = hubtelConfigFromEnv()
  if (!cfg) return { success: false, error: 'Hubtel not configured', provider: 'hubtel' }
  const from = payload.senderId?.trim() ? payload.senderId.trim().toUpperCase() : platformSenderName()
  const res = await hubtelSendSingle(cfg, { from, to: payload.phone, content: payload.message })
  if (res.outcome === 'out_of_funds') {
    import('@/lib/sms/notify').then((m) => m.notifyHubtelOutOfFunds()).catch(() => {})
  }
  if (res.outcome !== 'accepted') {
    console.warn('[SMS] Hubtel send failed:', res.error)
    return { success: false, error: res.error ?? 'Hubtel send failed', provider: 'hubtel' }
  }
  if (!payload.skipLogging) {
    try {
      await supabase.from('sms_logs').insert({
        user_id: payload.userId || null,
        phone_number: payload.phone,
        message: logSafeSmsBody(payload),
        message_type: payload.type,
        reference_id: payload.reference || null,
        moolre_message_id: res.messageId ?? null,
        provider: 'hubtel',
        status: 'sent',
      })
    } catch (logError) {
      console.warn('[SMS] Failed to log SMS:', logError)
    }
  }
  return { success: true, messageId: res.messageId, provider: 'hubtel' }
}
```
Register it:
```ts
const SMS_SENDERS: Record<string, (p: SMSPayload) => Promise<SendSMSResponse>> = {
  moolre: sendSMSViaMoolre,
  brevo: sendSMSViaBrevo,
  mnotify: sendSMSViaMNotify,
  hubtel: sendSMSViaHubtel,
}

function isProviderConfigured(name: string): boolean {
  if (name === 'moolre') return !!MOOLRE_API_KEY
  if (name === 'brevo') return !!BREVO_API_KEY
  if (name === 'mnotify') return !!MNOTIFY_API_KEY
  if (name === 'hubtel') return !!hubtelConfigFromEnv()
  return false
}
```
In `sendSMS`, replace the whole "A custom (non-default) sender ID may be approved on only one provider" block with:
```ts
  // Custom sender IDs: approval is ours; narrow the chain to gateways that accept it.
  if (payload.senderId && payload.senderId.trim()) {
    const sid = payload.senderId.trim().toUpperCase()
    const { data: senderRow } = await supabase
      .from('sms_sender_ids')
      .select('local_status, mnotify_local_status')
      .eq('sender_id', sid)
      .eq('local_status', 'active')
      .maybeSingle()
    order = narrowProvidersForSender(order, senderRow ?? null, true)
  }
```
(The extra `.eq('local_status','active')` makes the lookup unique — the active-name index guarantees at most one row.)

- [ ] **Step 6: Admin provider list** — in `app/admin/sms-centre/_components/ProvidersTab.tsx` change line 15 to:
```ts
const PROVIDERS = ["hubtel", "moolre", "mnotify", "brevo"] as const
```
Check the file for a label map keyed by provider (e.g. `moolre: "Moolre"`); if present add `hubtel: "Hubtel"`.

- [ ] **Step 7: Run** `npx vitest run lib/sms/routing.test.ts` — PASS; `npx tsc --noEmit` — clean.
- [ ] **Step 8: Commit** — `feat(sms): Hubtel as a routable SMS provider` + trailer.

---

### Task 9: Campaign dispatch via routing (Hubtel batches) + drain updates

> **Amendments (after Task 7 review):**
> 1. Outcome `"unknown"` (Hubtel may have accepted): push the chunk to `sent` with `mid: null, bid: null`, log a warning, and continue. Never fall back to Moolre and never leave it pending (both would double-send). The DLR poller's 72 h close refunds it if it never shows delivered. Add a test: unknown on a platform-sender chunk → in `sent`, Moolre not called.
> 2. Mark rows sent **per chunk**, not after all chunks: `dispatchCampaign(items, senderId, onChunkSent?)` where `onChunkSent: (provider: string, rows: SentRow[]) => Promise<void>` is awaited after each accepted / unknown / fallback chunk (errors inside it are caught and logged by dispatchCampaign). `enqueueSend` passes its `mark` function as `onChunkSent` and no longer marks after the loop (keep `result` for the first-batch id update). A Vercel timeout mid-campaign then leaves only truly unsent rows pending. Test that onChunkSent is called once per placed chunk with the right provider.

**Files:**
- Create: `lib/sms/campaign-dispatch.ts`, `lib/sms/campaign-dispatch.test.ts`
- Modify: `lib/sms/send-service.ts`, `lib/sms/send-service.test.ts`, `lib/sms/send-drain.ts`, `lib/sms/send-drain.test.ts`

Rules (spec §5.4): when Hubtel is the routing primary and configured, campaigns go out as Hubtel batches of ≤100 (simple when every text in the chunk is identical, personalized otherwise). A chunk Hubtel refuses falls back to Moolre bulk **only if the campaign uses the platform sender**; custom-sender chunks stay `pending` for the drain (which retries via Hubtel). Out-of-funds stops dispatch (rows stay pending) and alerts admins. Otherwise (Hubtel not primary) behaviour is exactly today's Moolre bulk.

- [ ] **Step 1: Failing tests** (`lib/sms/campaign-dispatch.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel",
  hubtelCfg: { clientId: "a", clientSecret: "b" } as unknown,
  simple: vi.fn(),
  personalized: vi.fn(),
  moolre: vi.fn(),
  outOfFunds: vi.fn(() => Promise.resolve()),
}))
vi.mock("./routing", () => ({ getRoutingConfig: () => Promise.resolve({ primary: h.primary, fallbacks: [] }) }))
vi.mock("./providers/hubtel", async (orig) => ({
  ...(await orig<typeof import("./providers/hubtel")>()),
  hubtelConfigFromEnv: () => h.hubtelCfg,
  hubtelSendBatchSimple: h.simple,
  hubtelSendBatchPersonalized: h.personalized,
}))
vi.mock("@/lib/sms-service", () => ({ sendSMSBulkViaMoolre: h.moolre, platformSenderName: () => "PLATFORM" }))
vi.mock("./notify", () => ({ notifyHubtelOutOfFunds: h.outOfFunds }))

import { dispatchCampaign } from "./campaign-dispatch"

const items = (n: number, text = "hi") =>
  Array.from({ length: n }, (_, i) => ({ id: `id${i}`, phone: `+2332400000${String(i).padStart(2, "0")}`, message: text }))
const accepted = (its: { phone: string }[], batchId = "b1") => ({
  outcome: "accepted", httpStatus: 200, bodyStatus: 0, batchId,
  messages: its.map((x, i) => ({ recipient: x.phone.replace("+", ""), messageId: `m${i}` })),
})

beforeEach(() => {
  h.primary = "hubtel"; h.hubtelCfg = { clientId: "a", clientSecret: "b" }
  h.simple.mockReset(); h.personalized.mockReset(); h.moolre.mockReset(); h.outOfFunds.mockClear()
})

describe("dispatchCampaign", () => {
  it("hubtel primary: one simple batch per 100, ids mapped", async () => {
    h.simple.mockImplementation(async (_c: unknown, m: { recipients: string[] }) => accepted(m.recipients.map((r) => ({ phone: r }))))
    const r = await dispatchCampaign(items(150), null)
    expect(h.simple).toHaveBeenCalledTimes(2)
    expect(h.simple.mock.calls[0][1].from).toBe("PLATFORM")
    expect(r.provider).toBe("hubtel")
    expect(r.sent).toHaveLength(150)
    expect(r.sent[0]).toEqual({ id: "id0", mid: "m0", bid: "b1" })
  })
  it("differing texts use the personalized endpoint", async () => {
    h.personalized.mockResolvedValue(accepted([]))
    await dispatchCampaign([{ id: "a", phone: "+233240000001", message: "Hi A" }, { id: "b", phone: "+233240000002", message: "Hi B" }], "KINGS")
    expect(h.personalized).toHaveBeenCalledOnce()
    expect(h.personalized.mock.calls[0][1].from).toBe("KINGS")
  })
  it("platform sender: rejected chunk falls back to Moolre", async () => {
    h.simple.mockResolvedValue({ outcome: "rejected", httpStatus: 400, bodyStatus: 4, messages: [] })
    h.moolre.mockResolvedValue({ ok: true })
    const r = await dispatchCampaign(items(3), null)
    expect(h.moolre).toHaveBeenCalledOnce()
    expect(r.fallbackSent.map((s) => s.id)).toEqual(["id0", "id1", "id2"])
  })
  it("custom sender: rejected chunk stays pending (no Moolre)", async () => {
    h.simple.mockResolvedValue({ outcome: "retryable", httpStatus: 502, bodyStatus: null, messages: [] })
    const r = await dispatchCampaign(items(3), "KINGS")
    expect(h.moolre).not.toHaveBeenCalled()
    expect(r.sent).toEqual([])
    expect(r.fallbackSent).toEqual([])
  })
  it("out of funds stops further chunks and alerts", async () => {
    h.simple.mockResolvedValue({ outcome: "out_of_funds", httpStatus: 402, bodyStatus: null, messages: [] })
    const r = await dispatchCampaign(items(250), null)
    expect(h.simple).toHaveBeenCalledOnce()
    expect(r.outOfFunds).toBe(true)
    expect(h.outOfFunds).toHaveBeenCalled()
    expect(h.moolre).not.toHaveBeenCalled()
  })
  it("hubtel not primary → today's Moolre bulk", async () => {
    h.primary = "moolre"
    h.moolre.mockResolvedValue({ ok: true })
    const r = await dispatchCampaign(items(3), "KINGS")
    expect(h.simple).not.toHaveBeenCalled()
    expect(r.provider).toBe("moolre")
    expect(r.sent.map((s) => s.id)).toEqual(["id0", "id1", "id2"])
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/campaign-dispatch.ts`**

```ts
/**
 * Instant campaign dispatch (spec §5.4). Pure orchestration over the providers; the caller
 * persists the outcome. Never throws.
 *   sent         — accepted by the primary (Hubtel or, if not primary, Moolre) with ids
 *   fallbackSent — platform-sender chunks Hubtel refused and Moolre accepted
 *   everything else stays 'pending' for the cron drain.
 */
import { getRoutingConfig } from "./routing"
import {
  HUBTEL_BATCH_CHUNK, hubtelConfigFromEnv, hubtelSendBatchPersonalized, hubtelSendBatchSimple,
  toHubtelMsisdn, type HubtelSendResult,
} from "./providers/hubtel"
import { platformSenderName, sendSMSBulkViaMoolre } from "@/lib/sms-service"
import { notifyHubtelOutOfFunds } from "./notify"

export interface DispatchItem { id: string; phone: string; message: string }
export interface SentRow { id: string; mid: string | null; bid: string | null }
export interface DispatchResult {
  provider: "hubtel" | "moolre"
  sent: SentRow[]
  fallbackSent: SentRow[]
  outOfFunds: boolean
}

const MOOLRE_CHUNK = 100

async function moolreChunk(chunk: DispatchItem[], senderId: string | null): Promise<boolean> {
  try {
    const res = await sendSMSBulkViaMoolre(chunk.map((m) => ({ recipient: m.phone, message: m.message, ref: m.id })), senderId ?? undefined)
    return !!res.ok
  } catch {
    return false
  }
}

/** Map Hubtel's {recipient, messageId} back onto our rows (duplicate phones consume in order). */
function mapIds(chunk: DispatchItem[], res: HubtelSendResult): SentRow[] {
  const byPhone = new Map<string, string[]>()
  for (const m of res.messages) {
    const list = byPhone.get(m.recipient) ?? []
    list.push(m.messageId)
    byPhone.set(m.recipient, list)
  }
  return chunk.map((item) => ({
    id: item.id,
    mid: byPhone.get(toHubtelMsisdn(item.phone))?.shift() ?? null,
    bid: res.batchId ?? null,
  }))
}

export async function dispatchCampaign(items: DispatchItem[], senderId: string | null): Promise<DispatchResult> {
  const routing = await getRoutingConfig()
  const hubtel = hubtelConfigFromEnv()

  if (routing.primary !== "hubtel" || !hubtel) {
    const sent: SentRow[] = []
    for (let i = 0; i < items.length; i += MOOLRE_CHUNK) {
      const chunk = items.slice(i, i + MOOLRE_CHUNK)
      if (await moolreChunk(chunk, senderId)) sent.push(...chunk.map((c) => ({ id: c.id, mid: null, bid: null })))
    }
    return { provider: "moolre", sent, fallbackSent: [], outOfFunds: false }
  }

  const from = senderId ?? platformSenderName()
  const out: DispatchResult = { provider: "hubtel", sent: [], fallbackSent: [], outOfFunds: false }
  for (let i = 0; i < items.length; i += HUBTEL_BATCH_CHUNK) {
    const chunk = items.slice(i, i + HUBTEL_BATCH_CHUNK)
    const sameText = chunk.every((c) => c.message === chunk[0].message)
    const res = sameText
      ? await hubtelSendBatchSimple(hubtel, { from, recipients: chunk.map((c) => c.phone), content: chunk[0].message })
      : await hubtelSendBatchPersonalized(hubtel, { from, items: chunk.map((c) => ({ to: c.phone, content: c.message })) })

    if (res.outcome === "accepted") {
      out.sent.push(...mapIds(chunk, res))
      continue
    }
    if (res.outcome === "out_of_funds") {
      out.outOfFunds = true
      notifyHubtelOutOfFunds().catch(() => {})
      break // remaining rows stay pending; the drain retries once funded
    }
    console.warn(`[SMS-DISPATCH] Hubtel ${res.outcome} for chunk of ${chunk.length}:`, res.error)
    if (senderId === null && (await moolreChunk(chunk, null))) {
      out.fallbackSent.push(...chunk.map((c) => ({ id: c.id, mid: null, bid: null })))
    }
  }
  return out
}
```

- [ ] **Step 4: Run campaign-dispatch tests — PASS.**

- [ ] **Step 5: Rewire step 7 of `enqueueSend`** in `lib/sms/send-service.ts`

Remove the `sendSMSBulkViaMoolre` import and the `BULK_CHUNK` constant; add `import { dispatchCampaign } from "./campaign-dispatch"`. Replace the whole step-7 block (from the `// 7. INSTANT dispatch` comment through the `if (sentIds.length > 0) { … }` block) with:

```ts
  // 7. INSTANT dispatch through provider routing (Hubtel batches when primary). Deliberately
  //    OUTSIDE the refund block: rows are durable, so a failure here must NEVER refund a batch
  //    a provider already accepted. Rows not placed stay 'pending' for the cron drain.
  try {
    const result = await dispatchCampaign(
      inserted.map((m) => ({ id: m.id, phone: m.phone, message: prepared })),
      resolvedSenderId
    )
    const mark = async (provider: string, rows: { id: string; mid: string | null; bid: string | null }[]) => {
      if (rows.length === 0) return
      const { error } = await supabaseAdmin.rpc("mark_sms_messages_sent", { p_provider: provider, p_rows: rows })
      // Rows stay 'pending' and the drain may re-send them (at-least-once). Never refund here.
      if (error) console.error(`[SMS-SEND] mark-sent (${provider}) failed (cron will reconcile):`, error.message)
    }
    await mark(result.provider, result.sent)
    await mark("moolre", result.fallbackSent)
    const firstBatch = result.sent.find((r) => r.bid)?.bid
    if (firstBatch) {
      await supabaseAdmin.from("sms_send_logs").update({ provider_batch_id: firstBatch, provider: "hubtel" }).eq("id", sendLogId)
    }
  } catch (e) {
    console.error("[SMS-SEND] dispatch failed (rows stay pending for the drain):", e)
  }
```

- [ ] **Step 6: Update `lib/sms/send-service.test.ts`** — replace the `@/lib/sms-service` bulk mock with a `./campaign-dispatch` mock driven by the same state:
```ts
vi.mock("./campaign-dispatch", () => ({
  dispatchCampaign: (its: { id: string }[], senderId: string | null) => {
    h.state.calls.push({ fn: "bulk", args: { count: its.length, senderId: senderId ?? undefined } })
    return Promise.resolve({
      provider: "moolre",
      sent: h.state.bulkOk ? its.map((i) => ({ id: i.id, mid: null, bid: null })) : [],
      fallbackSent: [], outOfFunds: false,
    })
  },
}))
```
Tests that asserted the mark-sent `.update().in()` (via `h.state.msgUpdates`) must now assert an `rpc("mark_sms_messages_sent", …)` call in `h.state.calls` with `p_rows` of the sent ids. Keep every other assertion (refund on enqueue failure, never refund after dispatch, recompute called).

- [ ] **Step 7: Drain changes** in `lib/sms/send-drain.ts`

(a) Success update — add the Hubtel message id:
```ts
          .update({
            status: "sent",
            processed_at: new Date().toISOString(),
            ref: r.ref ?? r.messageId ?? null,
            provider: r.provider ?? null,
            provider_message_id: r.provider === "hubtel" ? r.messageId ?? null : null,
          })
```
(b) Replace the body of `refundMessage` (keep its signature) so both refund paths share one exactly-once RPC:
```ts
async function refundMessage(row: SmsMessageRow): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("refund_sms_message", { p_message_id: row.id })
  if (!error) return data === true
  console.error(`[SMS-DRAIN] Refund failed for message ${row.id}:`, error.message)
  await supabaseAdmin
    .from("sms_refund_failures")
    .insert({ sms_account_id: row.sms_account_id, credits: row.segments, reason: `refund_sms_message failed: ${error.message}` })
    .then(({ error: e }) => { if (e) console.error("[SMS-DRAIN] sms_refund_failures insert failed:", e.message) })
  return false
}
```
Note the counting change: an already-refunded message now returns `false` (not counted again in `refunded`), which is the correct summary.

(c) In `lib/sms/send-drain.test.ts`, update the fake `rpc` so `"refund_sms_message"` returns `{ data: true, error: null }` (and the existing "duplicate" case becomes `{ data: false, error: null }`); update assertions from `adjust_sms_units` to `refund_sms_message` with `{ p_message_id: <row id> }`.

- [ ] **Step 8: Run** `npx vitest run lib/sms` — PASS; `npx tsc --noEmit` — clean.
- [ ] **Step 9: Commit** — `feat(sms): campaigns dispatch through routing — Hubtel batches, platform-only Moolre fallback` + trailer.

---

### Task 10: Delivery-report polling + refunds

**Files:**
- Create: `lib/sms/delivery-poll.ts`, `lib/sms/delivery-poll.test.ts`, `app/api/cron/sms-hubtel-dlr/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Failing tests (pure parts)**

```ts
import { describe, it, expect, vi } from "vitest"
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
import { toDeliveryReports, summarizeApplied, DLR_GIVE_UP_MS } from "./delivery-poll"

describe("toDeliveryReports", () => {
  it("maps status entries to RPC rows", () => {
    expect(toDeliveryReports([
      { messageId: "m1", state: "delivered", rawStatus: "Delivered", rate: 0.03, updateTime: "2026-10-10T10:00:00" },
      { messageId: "m2", state: "pending", rawStatus: "Sent" },
    ])).toEqual([
      { mid: "m1", state: "delivered", rate: 0.03, at: "2026-10-10T10:00:00Z" },
      { mid: "m2", state: "pending", rate: null, at: null },
    ])
  })
})

describe("summarizeApplied", () => {
  it("counts outcomes and collects send logs", () => {
    const s = summarizeApplied([
      { out_message_id: "a", out_send_log_id: 1, out_outcome: "delivered", out_refunded: false },
      { out_message_id: "b", out_send_log_id: 1, out_outcome: "failed", out_refunded: true },
      { out_message_id: "c", out_send_log_id: 2, out_outcome: "failed", out_refunded: false },
    ])
    expect(s).toEqual({ delivered: 1, failed: 2, refunded: 1, sendLogIds: [1, 2] })
  })
})

it("gives up after 72 hours", () => expect(DLR_GIVE_UP_MS).toBe(72 * 3_600_000))
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/delivery-poll.ts`**

```ts
/**
 * Hubtel delivery reports (spec §5.5). Hubtel's REST API has no DLR webhook, so a cron polls
 * batch status. Final states are applied in SQL (apply_sms_delivery_reports), which refunds
 * each failed message exactly once (refund_sms_message, ref = message id — shared with the
 * drain). Messages still undelivered after 72 h are closed as failed and refunded.
 */
import { createClient } from "@supabase/supabase-js"
import { hubtelConfigFromEnv, hubtelGetBatchStatus, hubtelGetMessageStatus, type HubtelStatusEntry } from "./providers/hubtel"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export const DLR_GIVE_UP_MS = 72 * 3_600_000
const MIN_AGE_MS = 60_000 // give the telco a minute before the first check

export interface DeliveryReportRow { mid: string; state: "delivered" | "failed" | "pending"; rate: number | null; at: string | null }
export function toDeliveryReports(entries: HubtelStatusEntry[]): DeliveryReportRow[] {
  return entries.map((e) => ({
    mid: e.messageId,
    state: e.state,
    rate: e.rate ?? null,
    // Hubtel's updateTime has no zone ("2023-03-21T12:54:43"); Ghana is UTC+0.
    at: e.updateTime ? (/[zZ]|[+-]\d\d:?\d\d$/.test(e.updateTime) ? e.updateTime : `${e.updateTime}Z`) : null,
  }))
}

export interface AppliedRow { out_message_id: string; out_send_log_id: number; out_outcome: string; out_refunded: boolean }
export function summarizeApplied(rows: AppliedRow[]) {
  return {
    delivered: rows.filter((r) => r.out_outcome === "delivered").length,
    failed: rows.filter((r) => r.out_outcome === "failed").length,
    refunded: rows.filter((r) => r.out_refunded).length,
    sendLogIds: [...new Set(rows.map((r) => r.out_send_log_id))],
  }
}

export interface PollSummary { batches: number; singles: number; delivered: number; failed: number; refunded: number; closed: number; errors: number }

async function apply(rows: DeliveryReportRow[], touched: Set<number>, sum: PollSummary) {
  if (rows.length === 0) return
  const { data, error } = await supabaseAdmin.rpc("apply_sms_delivery_reports", { p_rows: rows })
  if (error) { sum.errors++; console.error("[SMS-DLR] apply failed:", error.message); return }
  const s = summarizeApplied((data ?? []) as AppliedRow[])
  sum.delivered += s.delivered; sum.failed += s.failed; sum.refunded += s.refunded
  s.sendLogIds.forEach((id) => touched.add(id))
}

export async function pollHubtelDeliveries(opts: { maxBatches?: number; maxSingles?: number; now?: number } = {}): Promise<PollSummary> {
  const sum: PollSummary = { batches: 0, singles: 0, delivered: 0, failed: 0, refunded: 0, closed: 0, errors: 0 }
  const cfg = hubtelConfigFromEnv()
  if (!cfg) return sum
  const now = opts.now ?? Date.now()
  const readyBefore = new Date(now - MIN_AGE_MS).toISOString()
  const giveUpBefore = new Date(now - DLR_GIVE_UP_MS).toISOString()
  const touched = new Set<number>()

  // 1. Batches with pending messages (oldest first).
  const { data: pend } = await supabaseAdmin.from("sms_messages")
    .select("provider_batch_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .not("provider_batch_id", "is", null).lte("processed_at", readyBefore).gte("processed_at", giveUpBefore)
    .order("processed_at", { ascending: true }).limit(1000)
  const batchIds = [...new Set(((pend ?? []) as { provider_batch_id: string }[]).map((r) => r.provider_batch_id))]
    .slice(0, opts.maxBatches ?? 20)
  for (const batchId of batchIds) {
    const res = await hubtelGetBatchStatus(cfg, batchId)
    sum.batches++
    if (!res.ok) { sum.errors++; continue }
    await apply(toDeliveryReports(res.messages), touched, sum)
  }

  // 2. Drain-sent singles (message id, no batch).
  const { data: singles } = await supabaseAdmin.from("sms_messages")
    .select("provider_message_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .is("provider_batch_id", null).not("provider_message_id", "is", null)
    .lte("processed_at", readyBefore).gte("processed_at", giveUpBefore)
    .order("processed_at", { ascending: true }).limit(opts.maxSingles ?? 50)
  for (const s of (singles ?? []) as { provider_message_id: string }[]) {
    const res = await hubtelGetMessageStatus(cfg, s.provider_message_id)
    sum.singles++
    if (!res.ok) { sum.errors++; continue }
    await apply(toDeliveryReports(res.messages), touched, sum)
  }

  // 3. Close anything still pending after 72 h as failed (refunded once).
  const { data: stale } = await supabaseAdmin.from("sms_messages")
    .select("id, send_log_id").eq("provider", "hubtel").eq("status", "sent").eq("delivery_status", "pending")
    .lt("processed_at", giveUpBefore).limit(200)
  for (const m of (stale ?? []) as { id: string; send_log_id: number }[]) {
    const { data, error } = await supabaseAdmin.rpc("refund_sms_message", { p_message_id: m.id })
    if (error) { sum.errors++; continue }
    sum.closed++
    if (data === true) sum.refunded++
    touched.add(m.send_log_id)
  }

  // 4. Roll campaigns up.
  for (const id of touched) {
    const { error } = await supabaseAdmin.rpc("recompute_sms_send_result", { p_send_log_id: id, max_attempts: 3 })
    if (error) { sum.errors++; console.error("[SMS-DLR] recompute failed:", id, error.message) }
  }
  return sum
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Cron route** `app/api/cron/sms-hubtel-dlr/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { pollHubtelDeliveries } from "@/lib/sms/delivery-poll"

/** Poll Hubtel delivery reports, refund failures once, close 72 h stragglers. Every 2 min. */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  try {
    const summary = await pollHubtelDeliveries()
    return NextResponse.json({ success: true, data: summary })
  } catch (e) {
    console.error("[CRON-SMS-DLR-HUBTEL] Error:", e)
    return NextResponse.json({ success: false, error: (e as Error)?.message ?? "Internal error" }, { status: 500 })
  }
}
```

- [ ] **Step 6: `vercel.json`** — add to `crons`:
```json
    {
      "path": "/api/cron/sms-hubtel-dlr",
      "schedule": "*/2 * * * *"
    },
```

- [ ] **Step 7: Verify the SQL path live (controller)** — inside a rolled-back transaction, prove a duplicate failed report refunds once:
```sql
BEGIN;
-- pick a sent, never-refunded message and fake a hubtel id on it
UPDATE sms_messages SET provider='hubtel', provider_message_id='plan-test-1', delivery_status='pending', refunded=false
WHERE id = (SELECT m.id FROM sms_messages m WHERE m.status='sent'
            AND NOT EXISTS (SELECT 1 FROM sms_unit_transactions t WHERE t.ref = m.id::text)
            ORDER BY m.created_at DESC LIMIT 1);
SELECT * FROM apply_sms_delivery_reports('[{"mid":"plan-test-1","state":"failed","rate":0.03,"at":null}]');
SELECT * FROM apply_sms_delivery_reports('[{"mid":"plan-test-1","state":"failed","rate":0.03,"at":null}]');
SELECT count(*) FROM sms_unit_transactions WHERE ref = (SELECT id::text FROM sms_messages WHERE provider_message_id='plan-test-1');
ROLLBACK;
```
Expected: first apply returns one row with `out_refunded=true`; second returns no rows; count = 1.

- [ ] **Step 8: Commit** — `feat(sms): Hubtel delivery polling with exactly-once refunds` + trailer.

---

### Task 11: Solvency gate on the Hubtel Disbursement balance

**Files:**
- Modify: `lib/ussd-hubtel/relay-handler.ts`, `lib/ussd-hubtel/relay-handler.test.ts`, `scripts/hubtel-relay/server.ts`, `scripts/hubtel-relay/README.md`, `lib/ussd-hubtel/relay.ts`, `lib/ussd-hubtel/relay.test.ts`
- Create: `lib/sms/wholesale.ts`, `lib/sms/wholesale.test.ts`
- Modify: `lib/sms/bundle-service.ts` (+test), `lib/sms/activation-service.ts` (+test), `app/api/cron/sms-pending-credits/route.ts`, `app/api/admin/sms-supply/route.ts`

Balance endpoint (docs supplied 2026-10-10): `GET https://trnf.hubtel.com/api/inter-transfers/prepaid/{Disbursement_Account_Number}`, Basic auth, IP-whitelisted → `{"responseCode":"0000","message":"Success","data":{"amount":11.50}}`. The relay stays logic-free: auth + forward.

- [ ] **Step 1: Failing relay tests** (append inside the `describe("relay handler")` block)

```ts
  it("balance: forwards to the prepaid endpoint with Basic auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ responseCode: "0000", data: { amount: 11.5 } }), { status: 200 }))
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "11684", statusBasicAuth: "BASICXYZ", disbursementAccount: "11691", fetchImpl: fetchImpl as any })
    const res = await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })
    expect(res).toMatchObject({ status: 200, body: { ok: true, upstreamStatus: 200, body: { responseCode: "0000", data: { amount: 11.5 } } } })
    const [url, init] = fetchImpl.mock.calls[0] as any
    expect(url).toBe("https://trnf.hubtel.com/api/inter-transfers/prepaid/11691")
    expect(init.headers.Authorization).toBe("Basic BASICXYZ")
  })

  it("balance: prefers a dedicated balance credential", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }))
    const handler = createRelayHandler({ secret: "s3cret", collectionAccount: "1", statusBasicAuth: "STATUS", balanceBasicAuth: "BAL", disbursementAccount: "2", fetchImpl: fetchImpl as any })
    await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })
    expect((fetchImpl.mock.calls[0] as any)[1].headers.Authorization).toBe("Basic BAL")
  })

  it("balance: 501 when no disbursement account is configured", async () => {
    const { handler } = setup()
    expect((await handler({ method: "GET", path: "/balance", query: new URLSearchParams(), authorization: auth, body: "" })).status).toBe(501)
  })
```

- [ ] **Step 2: Run** `npx vitest run lib/ussd-hubtel/relay-handler.test.ts` — FAIL.

- [ ] **Step 3: Implement in `lib/ussd-hubtel/relay-handler.ts`**

Extend `RelayConfig`:
```ts
  /** Hubtel Disbursement (prepaid) account number — SMS is paid from it. Optional. */
  disbursementAccount?: string
  /** Basic credential for the balance endpoint; defaults to statusBasicAuth. */
  balanceBasicAuth?: string
  balanceBaseUrl?: string
```
Inside `createRelayHandler`, next to `statusBase`:
```ts
  const balanceBase = cfg.balanceBaseUrl ?? "https://trnf.hubtel.com"
```
Before the final `return { status: 404 … }`:
```ts
    if (req.method === "GET" && req.path === "/balance") {
      if (!cfg.disbursementAccount) return { status: 501, body: { error: "balance not configured" } }
      const url = `${balanceBase}/api/inter-transfers/prepaid/${encodeURIComponent(cfg.disbursementAccount)}`
      try {
        const res = await doFetch(url, {
          method: "GET",
          headers: {
            Authorization: `Basic ${cfg.balanceBasicAuth ?? cfg.statusBasicAuth}`,
            Accept: "application/json", "Content-Type": "application/json", "Cache-Control": "no-cache",
          },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        return { status: 200, body: { ok: res.ok, upstreamStatus: res.status, body: await readBody(res) } }
      } catch (e: any) {
        return { status: 200, body: { ok: false, upstreamStatus: 0, body: String(e?.message ?? e) } }
      }
    }
```
Update the file's header comment: "…a fixed (whitelisted) source IP for three outbound calls." 

`scripts/hubtel-relay/server.ts` — extend the handler config (both new env vars optional, so the existing droplet keeps working until redeployed):
```ts
const handle = createRelayHandler({
  secret: process.env.RELAY_SECRET!,
  collectionAccount: process.env.HUBTEL_COLLECTION_ACCOUNT!,
  statusBasicAuth: process.env.HUBTEL_STATUS_BASIC_AUTH!,
  disbursementAccount: process.env.HUBTEL_DISBURSEMENT_ACCOUNT || undefined,
  balanceBasicAuth: process.env.HUBTEL_BALANCE_BASIC_AUTH || undefined,
})
```
`scripts/hubtel-relay/README.md` — add a section:
```md
## Balance route (SMS solvency gate)
`GET /balance` (Bearer RELAY_SECRET) → Hubtel Disbursement balance. Env on the droplet:
- `HUBTEL_DISBURSEMENT_ACCOUNT` — the Disbursement (prepaid) account number (required for /balance)
- `HUBTEL_BALANCE_BASIC_AUTH` — optional base64 `user:pass`; defaults to `HUBTEL_STATUS_BASIC_AUTH`
Confirm with the Hubtel Retail Systems Engineer that this droplet's IP is whitelisted for trnf.hubtel.com.
Redeploy: copy `scripts/hubtel-relay/server.ts` and `lib/ussd-hubtel/relay-handler.ts` (same paths), set env, `systemctl restart hubtel-relay`.
Check: `curl -s -H "Authorization: Bearer $RELAY_SECRET" https://<relay-host>/balance`
```

- [ ] **Step 4: Relay client** — failing test appended to `lib/ussd-hubtel/relay.test.ts`:

```ts
import { fetchDisbursementBalance } from "./relay"

describe("fetchDisbursementBalance", () => {
  beforeEach(() => { process.env.HUBTEL_RELAY_URL = "https://relay.test/"; process.env.HUBTEL_RELAY_SECRET = "s" })
  afterEach(() => { vi.unstubAllGlobals() })
  it("returns the amount on responseCode 0000", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, upstreamStatus: 200, body: { responseCode: "0000", data: { amount: 123.5 } } }), { status: 200 }))
    vi.stubGlobal("fetch", f)
    expect(await fetchDisbursementBalance()).toEqual({ ok: true, amountGhs: 123.5 })
    expect((f.mock.calls[0] as any)[0]).toBe("https://relay.test/balance")
    expect((f.mock.calls[0] as any)[1].headers.Authorization).toBe("Bearer s")
  })
  it("fails on any other response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, upstreamStatus: 200, body: { responseCode: "4000" } }), { status: 200 })))
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
  it("fails when the relay is not configured", async () => {
    delete process.env.HUBTEL_RELAY_URL
    expect((await fetchDisbursementBalance()).ok).toBe(false)
  })
})
```
(Add `beforeEach`, `afterEach` to the file's vitest import if missing.) Implement in `lib/ussd-hubtel/relay.ts`:
```ts
/** Hubtel Disbursement (prepaid) balance in GH₵ — the float SMS is paid from. Via the relay
 *  because trnf.hubtel.com only accepts whitelisted IPs. Never throws. */
export async function fetchDisbursementBalance(): Promise<{ ok: true; amountGhs: number } | { ok: false; error: string }> {
  const cfg = relayConfig()
  if (!cfg) return { ok: false, error: "relay not configured" }
  try {
    const res = await fetch(`${cfg.url}/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.secret}` },
      signal: AbortSignal.timeout(10_000),
    })
    const json: any = await res.json().catch(() => null)
    const body = json?.body
    if (res.ok && json?.ok && body?.responseCode === "0000" && typeof body?.data?.amount === "number") {
      return { ok: true, amountGhs: body.data.amount }
    }
    return { ok: false, error: `relay/hubtel ${json?.upstreamStatus ?? res.status}: ${JSON.stringify(body ?? null).slice(0, 200)}` }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
```

- [ ] **Step 5: Run relay tests — PASS.**

- [ ] **Step 6: Failing wholesale tests** (`lib/sms/wholesale.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  primary: "hubtel", hubtelCfg: {} as unknown, balance: { ok: true, amountGhs: 35 } as any,
  observed: null as number | null, moolre: 900, alerts: [] as string[],
}))
vi.mock("./routing", () => ({ getRoutingConfig: () => Promise.resolve({ primary: h.primary, fallbacks: [] }) }))
vi.mock("./providers/hubtel", () => ({ hubtelConfigFromEnv: () => h.hubtelCfg }))
vi.mock("@/lib/ussd-hubtel/relay", () => ({ fetchDisbursementBalance: () => Promise.resolve(h.balance) }))
vi.mock("@/lib/sms-service", () => ({ queryMoolreSmsBalance: () => Promise.resolve(h.moolre) }))
vi.mock("./platform-settings", () => ({ loadSmsSettings: () => Promise.resolve({ hubtelCostPerSms: 0.035, hubtelLowBalanceGhs: 50 }) }))
vi.mock("./notify", () => ({ notifyAdminsThrottled: (type: string) => { h.alerts.push(type); return Promise.resolve() } }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const q: any = { select: () => q, eq: () => q, not: () => q, gte: () => q, order: () => q, limit: () => q,
        maybeSingle: () => Promise.resolve({ data: h.observed === null ? null : { cost_ghs: h.observed }, error: null }) }
      return q
    },
  }),
}))

import { backedCredits, getWholesaleCredits } from "./wholesale"

beforeEach(() => { h.primary = "hubtel"; h.hubtelCfg = {}; h.balance = { ok: true, amountGhs: 35 }; h.observed = null; h.alerts = [] })

describe("backedCredits", () => {
  it("floors balance / cost", () => expect(backedCredits(35, 0.035)).toBe(1000))
  it("is 0 for bad input", () => {
    expect(backedCredits(-1, 0.03)).toBe(0)
    expect(backedCredits(10, 0)).toBe(0)
    expect(backedCredits(NaN, 0.03)).toBe(0)
  })
})

describe("getWholesaleCredits", () => {
  it("hubtel primary: balance ÷ fallback cost until rates are observed", async () => {
    expect(await getWholesaleCredits()).toBe(1000)
  })
  it("uses the highest observed rate when present", async () => {
    h.observed = 0.05
    expect(await getWholesaleCredits()).toBe(700)
  })
  it("fails closed when the balance can't be read", async () => {
    h.balance = { ok: false, error: "x" }
    expect(await getWholesaleCredits()).toBe(0)
  })
  it("alerts below the low-balance threshold", async () => {
    await getWholesaleCredits()
    expect(h.alerts).toContain("sms_hubtel_low_balance")
  })
  it("moolre primary: Moolre wholesale credits", async () => {
    h.primary = "moolre"
    expect(await getWholesaleCredits()).toBe(900)
  })
})
```

- [ ] **Step 7: Implement `lib/sms/wholesale.ts`**

```ts
/**
 * Backed SMS supply for the solvency gate (spec §5.5a). credit_sms_units_if_solvent only
 * issues credits while all balances + this purchase stay ≤ this number, so it must fail
 * CLOSED (0) whenever the real supply is unknown.
 *   Hubtel primary → Disbursement balance (GH₵) ÷ highest per-SMS rate seen in 7 days
 *                    (admin setting sms_hubtel_cost_per_sms until any rate is observed)
 *   otherwise      → Moolre wholesale credit balance (unchanged behaviour)
 */
import { createClient } from "@supabase/supabase-js"
import { getRoutingConfig } from "./routing"
import { hubtelConfigFromEnv } from "./providers/hubtel"
import { fetchDisbursementBalance } from "@/lib/ussd-hubtel/relay"
import { queryMoolreSmsBalance } from "@/lib/sms-service"
import { loadSmsSettings } from "./platform-settings"
import { notifyAdminsThrottled } from "./notify"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export function backedCredits(balanceGhs: number, costPerSms: number): number {
  if (!Number.isFinite(balanceGhs) || !Number.isFinite(costPerSms) || balanceGhs <= 0 || costPerSms <= 0) return 0
  return Math.floor(balanceGhs / costPerSms + 1e-9)
}

export async function maxObservedHubtelRate(days = 7): Promise<number | null> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data } = await supabaseAdmin.from("sms_messages").select("cost_ghs")
    .eq("provider", "hubtel").not("cost_ghs", "is", null).gte("processed_at", since)
    .order("cost_ghs", { ascending: false }).limit(1).maybeSingle()
  const v = Number((data as { cost_ghs?: number | string } | null)?.cost_ghs)
  return Number.isFinite(v) && v > 0 ? v : null
}

export async function getWholesaleCredits(): Promise<number> {
  const routing = await getRoutingConfig()
  if (routing.primary !== "hubtel" || !hubtelConfigFromEnv()) return queryMoolreSmsBalance()

  const bal = await fetchDisbursementBalance()
  if (!bal.ok) {
    console.error("[SMS-WHOLESALE] Hubtel balance unavailable — failing closed:", bal.error)
    return 0
  }
  const settings = await loadSmsSettings()
  if (bal.amountGhs < settings.hubtelLowBalanceGhs) {
    notifyAdminsThrottled("sms_hubtel_low_balance", "Hubtel SMS balance low",
      `Hubtel Disbursement balance is GH₵${bal.amountGhs.toFixed(2)} (alert below GH₵${settings.hubtelLowBalanceGhs}). Top it up to keep selling SMS credits.`).catch(() => {})
  }
  const rate = (await maxObservedHubtelRate()) ?? settings.hubtelCostPerSms
  return backedCredits(bal.amountGhs, rate)
}
```

- [ ] **Step 8: Switch the callers**

- `lib/sms/bundle-service.ts`: replace `import { queryMoolreSmsBalance } from "@/lib/sms-service"` with `import { getWholesaleCredits } from "./wholesale"`; in `issueUnits` replace `await queryMoolreSmsBalance()` with `await getWholesaleCredits()`.
- `lib/sms/activation-service.ts`: same swap in `claimWelcomeBonus`.
- `app/api/cron/sms-pending-credits/route.ts` and `app/api/admin/sms-supply/route.ts`: import `getWholesaleCredits` from `@/lib/sms/wholesale` and call it instead of `queryMoolreSmsBalance()`. In sms-supply, update the comment: "wholesaleBalance: backed credits from the active provider (Hubtel Disbursement ÷ rate, or Moolre)".
- `lib/sms/bundle-service.test.ts` line 69 and `lib/sms/activation-service.test.ts` line 105: replace the `@/lib/sms-service` mock with
  ```ts
  vi.mock("./wholesale", () => ({ getWholesaleCredits: () => Promise.resolve(h.state.wholesale) }))
  ```
- `lib/sms/notify.ts`: make `notifyAdminSmsShortfall`'s message provider-neutral: `` `${unitsPending} units are pending — top up the SMS wholesale balance (Hubtel Disbursement, or Moolre while it is primary) to release them.` ``

- [ ] **Step 9: Run** `npx vitest run lib/sms lib/ussd-hubtel` — PASS; `npx tsc --noEmit` — clean.
- [ ] **Step 10: Commit** — `feat(sms): solvency gate on the Hubtel Disbursement balance via relay /balance` + trailer.

---

### Task 12: Sender-ID rules + account mode service

**Files:**
- Create: `lib/sms/sender-rules-service.ts`, `lib/sms/sender-rules-service.test.ts`
- Create: `app/api/admin/sms-platform/sender-ids/[id]/route.ts`, `app/api/admin/sms-platform/accounts/[id]/route.ts`
- Modify: `app/api/sms/sender-ids/route.ts`, `lib/sms/moderation-service.ts`

- [ ] **Step 1: Failing tests (pure planners)**

```ts
import { describe, it, expect, vi } from "vitest"
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({}) }))
import { planModeChange, senderLimitFor } from "./sender-rules-service"

const row = (id: string, local_status: string, kyc_free = false) => ({ id, local_status, kyc_free })

describe("senderLimitFor", () => {
  it("platform 1, business 200", () => {
    expect(senderLimitFor("platform")).toBe(1)
    expect(senderLimitFor("business")).toBe(200)
  })
})

describe("planModeChange", () => {
  it("→ business unpauses every paused id", () => {
    expect(planModeChange("business", [row("a", "active", true), row("b", "paused"), row("c", "rejected")]))
      .toEqual({ unpause: ["b"], pause: [], markKycFree: null })
  })
  it("→ platform keeps the kyc_free id and pauses the rest", () => {
    expect(planModeChange("platform", [row("a", "active"), row("b", "active", true), row("c", "active")]))
      .toEqual({ unpause: [], pause: ["a", "c"], markKycFree: null })
  })
  it("→ platform without a kyc_free id keeps the oldest active as the free one", () => {
    expect(planModeChange("platform", [row("a", "active"), row("b", "active")]))
      .toEqual({ unpause: [], pause: ["b"], markKycFree: "a" })
  })
  it("→ platform with no active ids changes nothing", () => {
    expect(planModeChange("platform", [row("a", "pending")])).toEqual({ unpause: [], pause: [], markKycFree: null })
  })
})
```
(Rows are passed oldest-first, as the service queries them.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Export the audit helper** — in `lib/sms/moderation-service.ts` change `async function writeAuditLog(` to `export async function writeAuditLog(`.

- [ ] **Step 4: Implement `lib/sms/sender-rules-service.ts`**

```ts
/**
 * Sender-ID requests and account modes (spec §5.7, §5.6). Approval is ours — Hubtel needs no
 * registration — so an approved ID is active immediately. The DB guarantees no two ACTIVE
 * rows share a name (uq_sms_sender_ids_active_name); we check first for a friendly error.
 */
import { createClient } from "@supabase/supabase-js"
import { validateSenderName } from "./sender-name"
import { loadSmsSettings, type SmsMode } from "./platform-settings"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

type Result<T> = { ok: true; data: T } | { ok: false; error: string }
interface SenderRow { id: string; sender_id: string; sms_account_id: string; local_status: string; kyc_free: boolean; created_at: string }

const OPEN_STATUSES = ["pending", "active", "paused"]
export function senderLimitFor(mode: SmsMode): number {
  return mode === "business" ? 200 : 1
}

export interface ModePlan { unpause: string[]; pause: string[]; markKycFree: string | null }
/** rows oldest-first. Pure. */
export function planModeChange(target: SmsMode, rows: { id: string; local_status: string; kyc_free: boolean }[]): ModePlan {
  if (target === "business") {
    return { unpause: rows.filter((r) => r.local_status === "paused").map((r) => r.id), pause: [], markKycFree: null }
  }
  const active = rows.filter((r) => r.local_status === "active")
  const keep = active.find((r) => r.kyc_free) ?? active[0]
  if (!keep) return { unpause: [], pause: [], markKycFree: null }
  return {
    unpause: [],
    pause: active.filter((r) => r.id !== keep.id).map((r) => r.id),
    markKycFree: keep.kyc_free ? null : keep.id,
  }
}

async function accountMode(accountId: string): Promise<{ mode: SmsMode; default_sender_id: string | null } | null> {
  const { data } = await supabaseAdmin.from("sms_accounts").select("mode, default_sender_id").eq("id", accountId).maybeSingle()
  return (data as { mode: SmsMode; default_sender_id: string | null } | null) ?? null
}

async function activeElsewhere(name: string, accountId: string): Promise<boolean> {
  const { data } = await supabaseAdmin.from("sms_sender_ids").select("id")
    .eq("sender_id", name).eq("local_status", "active")
    .or(`sms_account_id.is.null,sms_account_id.neq.${accountId}`).limit(1)
  return (data ?? []).length > 0
}

const isUniqueViolation = (e: { code?: string } | null) => e?.code === "23505"

/** Customer request. Idempotent for an open request of the same name; re-opens a rejected/revoked one. */
export async function requestSenderId(accountId: string, raw: string): Promise<Result<SenderRow>> {
  const settings = await loadSmsSettings()
  const check = validateSenderName(raw, settings.protectedSenderNames)
  if (!check.ok) return { ok: false, error: check.reason }
  const name = check.name

  const acct = await accountMode(accountId)
  if (!acct) return { ok: false, error: "SMS account not found" }

  const { data: rowsData } = await supabaseAdmin.from("sms_sender_ids")
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").eq("sms_account_id", accountId)
  const rows = (rowsData ?? []) as SenderRow[]
  const existing = rows.find((r) => r.sender_id === name)
  if (existing && OPEN_STATUSES.includes(existing.local_status)) return { ok: true, data: existing }

  const open = rows.filter((r) => OPEN_STATUSES.includes(r.local_status)).length
  if (open >= senderLimitFor(acct.mode)) {
    return {
      ok: false,
      error: acct.mode === "platform"
        ? "Platform mode includes one sender ID. Verify your business to request up to 200."
        : "You've reached the limit of 200 sender IDs.",
    }
  }
  if (await activeElsewhere(name, accountId)) return { ok: false, error: "That sender ID is already in use by another account." }

  if (existing) {
    const { data, error } = await supabaseAdmin.from("sms_sender_ids")
      .update({ local_status: "pending", rejection_reason: null, revoked_at: null, kyc_free: acct.mode === "platform", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", existing.id).select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").single()
    if (error) return { ok: false, error: error.message }
    return { ok: true, data: data as SenderRow }
  }
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .insert({ sender_id: name, sms_account_id: accountId, local_status: "pending", kyc_free: acct.mode === "platform" })
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as SenderRow }
}

async function getRow(id: string): Promise<SenderRow | null> {
  const { data } = await supabaseAdmin.from("sms_sender_ids")
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").eq("id", id).maybeSingle()
  return (data as SenderRow | null) ?? null
}

export async function approveSenderIdRequest(adminId: string | null, id: string): Promise<Result<SenderRow>> {
  const row = await getRow(id)
  if (!row || !row.sms_account_id) return { ok: false, error: "Sender ID not found" }
  if (row.local_status !== "pending") return { ok: false, error: `Only pending requests can be approved (this one is ${row.local_status}).` }
  const acct = await accountMode(row.sms_account_id)
  if (!acct) return { ok: false, error: "SMS account not found" }
  if (acct.mode === "platform") {
    const { data: free } = await supabaseAdmin.from("sms_sender_ids").select("id")
      .eq("sms_account_id", row.sms_account_id).eq("local_status", "active").neq("id", id).limit(1)
    if ((free ?? []).length > 0) return { ok: false, error: "This Platform account already has its one sender ID. Revoke it first or approve after business verification." }
  }
  if (await activeElsewhere(row.sender_id, row.sms_account_id)) return { ok: false, error: "Another account already uses this sender ID." }

  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "active", approved_by: adminId, approved_at: now, rejection_reason: null, kyc_free: acct.mode === "platform" ? true : row.kyc_free, updated_at: now })
    .eq("id", id).eq("local_status", "pending")
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").maybeSingle()
  if (isUniqueViolation(error)) return { ok: false, error: "Another account already uses this sender ID." }
  if (error || !data) return { ok: false, error: error?.message ?? "Request changed — refresh and try again." }
  if (!acct.default_sender_id) {
    await supabaseAdmin.from("sms_accounts").update({ default_sender_id: id }).eq("id", row.sms_account_id)
  }
  if (adminId) writeAuditLog(adminId, "sms_sender_approve", null, { id, status: "pending" }, { id, status: "active" }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

export async function rejectSenderIdRequest(adminId: string | null, id: string, reason: string): Promise<Result<SenderRow>> {
  const why = (reason ?? "").trim()
  if (why.length < 3) return { ok: false, error: "A rejection reason is required." }
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "rejected", rejection_reason: why, updated_at: new Date().toISOString() })
    .eq("id", id).eq("local_status", "pending")
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only pending requests can be rejected." }
  if (adminId) writeAuditLog(adminId, "sms_sender_reject", null, { id }, { id, reason: why }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

export async function revokeSenderId(adminId: string | null, id: string, reason?: string): Promise<Result<SenderRow>> {
  const now = new Date().toISOString()
  const { data, error } = await supabaseAdmin.from("sms_sender_ids")
    .update({ local_status: "revoked", revoked_at: now, kyc_free: false, rejection_reason: reason?.trim() || null, updated_at: now })
    .eq("id", id).in("local_status", ["active", "paused"])
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at").maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only active or paused sender IDs can be revoked." }
  // A revoked default falls back to the platform sender.
  await supabaseAdmin.from("sms_accounts").update({ default_sender_id: null }).eq("default_sender_id", id)
  if (adminId) writeAuditLog(adminId, "sms_sender_revoke", null, { id }, { id, reason: reason ?? null }).catch(() => {})
  return { ok: true, data: data as SenderRow }
}

/** Switch an account's mode, pausing/unpausing sender IDs per planModeChange. */
export async function setAccountMode(adminId: string | null, accountId: string, mode: SmsMode): Promise<Result<{ mode: SmsMode; unpaused: number; paused: number; conflicts: string[] }>> {
  const { data: rowsData, error: rowsErr } = await supabaseAdmin.from("sms_sender_ids")
    .select("id, sender_id, sms_account_id, local_status, kyc_free, created_at")
    .eq("sms_account_id", accountId).order("created_at", { ascending: true })
  if (rowsErr) return { ok: false, error: rowsErr.message }
  const rows = (rowsData ?? []) as SenderRow[]
  const plan = planModeChange(mode, rows)
  const now = new Date().toISOString()

  const { error: accErr } = await supabaseAdmin.from("sms_accounts").update({ mode, mode_changed_at: now }).eq("id", accountId)
  if (accErr) return { ok: false, error: accErr.message }

  if (plan.markKycFree) await supabaseAdmin.from("sms_sender_ids").update({ kyc_free: true, updated_at: now }).eq("id", plan.markKycFree)
  if (plan.pause.length) {
    await supabaseAdmin.from("sms_sender_ids").update({ local_status: "paused", updated_at: now }).in("id", plan.pause)
    await supabaseAdmin.from("sms_accounts").update({ default_sender_id: plan.markKycFree ?? rows.find((r) => r.kyc_free && r.local_status === "active")?.id ?? null })
      .eq("id", accountId).in("default_sender_id", plan.pause)
  }
  // Unpause one by one: a name that became active on another account meanwhile stays paused.
  const conflicts: string[] = []
  let unpaused = 0
  for (const id of plan.unpause) {
    const { error } = await supabaseAdmin.from("sms_sender_ids").update({ local_status: "active", updated_at: now }).eq("id", id).eq("local_status", "paused")
    if (isUniqueViolation(error)) conflicts.push(rows.find((r) => r.id === id)?.sender_id ?? id)
    else if (!error) unpaused++
  }
  if (adminId) writeAuditLog(adminId, "sms_account_mode", null, { accountId }, { accountId, mode, ...plan, conflicts }).catch(() => {})
  return { ok: true, data: { mode, unpaused, paused: plan.pause.length, conflicts } }
}

export async function setApiRateLimitOverride(adminId: string | null, accountId: string, value: number | null): Promise<Result<{ api_rate_limit_override: number | null }>> {
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 10_000)) {
    return { ok: false, error: "Rate limit must be a whole number from 1 to 10,000 (or empty for the default)." }
  }
  const { error } = await supabaseAdmin.from("sms_accounts").update({ api_rate_limit_override: value }).eq("id", accountId)
  if (error) return { ok: false, error: error.message }
  if (adminId) writeAuditLog(adminId, "sms_account_rate_limit", null, { accountId }, { accountId, value }).catch(() => {})
  return { ok: true, data: { api_rate_limit_override: value } }
}
```

- [ ] **Step 5: Run the planner tests — PASS.**

- [ ] **Step 6: Routes**

`app/api/sms/sender-ids/route.ts` — swap the POST to the new rules (GET unchanged):
```ts
import { requestSenderId } from "@/lib/sms/sender-rules-service"
// …in POST, replace `submitSenderId(body.sender_id, account!.id)` with:
  const result = await requestSenderId(account!.id, body.sender_id)
```
and drop `submitSenderId` from the sender-id-service import.

`app/api/admin/sms-platform/sender-ids/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { approveSenderIdRequest, rejectSenderIdRequest, revokeSenderId } from "@/lib/sms/sender-rules-service"

// POST { action: "approve" | "reject" | "revoke", reason?: string }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { id } = await params
  let body: { action?: string; reason?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = (auth as { userId?: string }).userId ?? null
  const result =
    body.action === "approve" ? await approveSenderIdRequest(adminId, id) :
    body.action === "reject" ? await rejectSenderIdRequest(adminId, id, body.reason ?? "") :
    body.action === "revoke" ? await revokeSenderId(adminId, id, body.reason) :
    { ok: false as const, error: "action must be approve, reject or revoke" }
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true, data: result.data })
}
```
(Check `lib/admin-auth.ts` for the exact name of the admin id field in `verifyAdminAccess`'s success result — use it instead of `userId` if it differs.)

`app/api/admin/sms-platform/accounts/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { setAccountMode, setApiRateLimitOverride } from "@/lib/sms/sender-rules-service"

// PATCH { mode?: "platform" | "business", api_rate_limit_override?: number | null }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { id } = await params
  let body: { mode?: string; api_rate_limit_override?: number | null }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = (auth as { userId?: string }).userId ?? null
  const out: Record<string, unknown> = {}
  if (body.mode !== undefined) {
    if (body.mode !== "platform" && body.mode !== "business") return NextResponse.json({ success: false, error: "mode must be platform or business" }, { status: 400 })
    const r = await setAccountMode(adminId, id, body.mode)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    out.mode = r.data
  }
  if (body.api_rate_limit_override !== undefined) {
    const r = await setApiRateLimitOverride(adminId, id, body.api_rate_limit_override)
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
    out.api_rate_limit_override = r.data.api_rate_limit_override
  }
  return NextResponse.json({ success: true, data: out })
}
```

- [ ] **Step 7: Run** `npx vitest run lib/sms` and `npx tsc --noEmit` — PASS/clean.
- [ ] **Step 8: Commit** — `feat(sms): sender-ID request/approve/revoke rules and account mode changes` + trailer.

---

### Task 13: KYC backend

**Files:**
- Create: `lib/sms/kyc-rules.ts`, `lib/sms/kyc-rules.test.ts`, `lib/sms/kyc-service.ts`
- Create: `app/api/sms/business/route.ts`, `app/api/sms/business/documents/route.ts`, `app/api/sms/business/submit/route.ts`
- Create: `app/api/admin/sms-platform/business-reviews/route.ts`, `app/api/admin/sms-platform/business-reviews/[id]/route.ts`
- Create: `app/api/cron/sms-kyc-purge/route.ts`; Modify: `vercel.json`

- [ ] **Step 1: Failing tests** (`lib/sms/kyc-rules.test.ts`)

```ts
import { describe, it, expect } from "vitest"
import { validateKycDraft, missingForSubmit, nextKycStatus, docExtension, KYC_DOC_MAX_BYTES } from "./kyc-rules"

describe("validateKycDraft", () => {
  it("accepts a full draft, keeps only the card's last 4, normalises phone + website", () => {
    const r = validateKycDraft({
      business_name: "  Kings Data  ", description: "We sell data bundles in Kumasi", website: "kingsdata.com",
      whatsapp_number: "024 123 4567", ghana_card_number: "gha-123456789-0",
    })
    expect(r).toEqual({ ok: true, patch: {
      business_name: "Kings Data", description: "We sell data bundles in Kumasi", website: "https://kingsdata.com",
      whatsapp_number: "233241234567", ghana_card_last4: "7890",
    } })
  })
  it("only includes fields that were sent", () => {
    expect(validateKycDraft({ business_name: "Ab" })).toEqual({ ok: true, patch: { business_name: "Ab" } })
  })
  it("reports every invalid field", () => {
    const r = validateKycDraft({ business_name: "A", description: "short", website: "not a site", whatsapp_number: "123", ghana_card_number: "GHA-12-3" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["business_name", "description", "ghana_card_number", "website", "whatsapp_number"])
  })
})
```
(Ghana card `GHA-123456789-0` → digits `1234567890` → last 4 = `"7890"`: strip non-digits, take the last four.)

```ts
describe("missingForSubmit", () => {
  const full = { business_name: "Kings", description: "We sell data bundles", whatsapp_number: "233241234567", ghana_card_last4: "7890", ghana_card_doc_path: "a/b.jpg" }
  it("nothing missing", () => expect(missingForSubmit(full)).toEqual([]))
  it("lists missing fields", () => expect(missingForSubmit({ ...full, ghana_card_doc_path: null, description: null }))
    .toEqual(["description", "ghana_card_doc_path"]))
})

describe("nextKycStatus", () => {
  it("save", () => {
    expect(nextKycStatus(null, "save")).toBe("draft")
    expect(nextKycStatus("draft", "save")).toBe("draft")
    expect(nextKycStatus("rejected", "save")).toBe("draft")
    expect(nextKycStatus("submitted", "save")).toBeNull()
    expect(nextKycStatus("approved", "save")).toBeNull()
  })
  it("submit/approve/reject", () => {
    expect(nextKycStatus("draft", "submit")).toBe("submitted")
    expect(nextKycStatus("rejected", "submit")).toBeNull()
    expect(nextKycStatus("submitted", "approve")).toBe("approved")
    expect(nextKycStatus("submitted", "reject")).toBe("rejected")
    expect(nextKycStatus("draft", "approve")).toBeNull()
  })
})

describe("docExtension", () => {
  it("accepts images and PDFs up to 5 MB", () => {
    expect(docExtension("image/jpeg", 1000)).toEqual({ ok: true, ext: "jpg" })
    expect(docExtension("application/pdf", KYC_DOC_MAX_BYTES)).toEqual({ ok: true, ext: "pdf" })
  })
  it("rejects other types, empty and oversize files", () => {
    expect(docExtension("image/gif", 10).ok).toBe(false)
    expect(docExtension("image/png", 0).ok).toBe(false)
    expect(docExtension("image/png", KYC_DOC_MAX_BYTES + 1).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `lib/sms/kyc-rules.ts`**

```ts
/** Pure KYC rules (spec §5.6). The Ghana Card number is validated but only its last 4
 *  digits are stored; the uploaded card photo is the verification artifact. */
export const GHANA_CARD_RE = /^GHA-\d{9}-\d$/
export const KYC_DOC_MAX_BYTES = 5 * 1024 * 1024
const DOC_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" }

export type KycStatus = "draft" | "submitted" | "approved" | "rejected"
export type KycAction = "save" | "submit" | "approve" | "reject"

export interface KycDraftInput {
  business_name?: string; description?: string; website?: string; whatsapp_number?: string; ghana_card_number?: string
}
export interface KycDraftPatch {
  business_name?: string; description?: string; website?: string | null; whatsapp_number?: string; ghana_card_last4?: string
}

function normalizeGhanaPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, "")
  if (/^233\d{9}$/.test(d)) return d
  if (/^0\d{9}$/.test(d)) return `233${d.slice(1)}`
  if (/^\d{9}$/.test(d)) return `233${d}`
  return null
}

function normalizeWebsite(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    return /\.[a-z]{2,}$/i.test(u.hostname) ? withScheme : null
  } catch {
    return null
  }
}

export function validateKycDraft(input: KycDraftInput): { ok: true; patch: KycDraftPatch } | { ok: false; errors: Record<string, string> } {
  const patch: KycDraftPatch = {}
  const errors: Record<string, string> = {}
  if (input.business_name !== undefined) {
    const v = input.business_name.trim()
    if (v.length < 2 || v.length > 120) errors.business_name = "Business name must be 2–120 characters."
    else patch.business_name = v
  }
  if (input.description !== undefined) {
    const v = input.description.trim()
    if (v.length < 10 || v.length > 2000) errors.description = "Description must be 10–2000 characters."
    else patch.description = v
  }
  if (input.website !== undefined) {
    if (!input.website.trim()) patch.website = null
    else {
      const w = normalizeWebsite(input.website)
      if (!w) errors.website = "Enter a valid website, e.g. kingsdata.com."
      else patch.website = w
    }
  }
  if (input.whatsapp_number !== undefined) {
    const p = normalizeGhanaPhone(input.whatsapp_number)
    if (!p) errors.whatsapp_number = "Enter a Ghana WhatsApp number, e.g. 024 123 4567."
    else patch.whatsapp_number = p
  }
  if (input.ghana_card_number !== undefined) {
    const card = input.ghana_card_number.trim().toUpperCase()
    if (!GHANA_CARD_RE.test(card)) errors.ghana_card_number = "Ghana Card number must look like GHA-123456789-0."
    else patch.ghana_card_last4 = card.replace(/\D/g, "").slice(-4)
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, patch }
}

const REQUIRED_FOR_SUBMIT = ["business_name", "description", "whatsapp_number", "ghana_card_last4", "ghana_card_doc_path"] as const
export function missingForSubmit(row: Partial<Record<(typeof REQUIRED_FOR_SUBMIT)[number], string | null>>): string[] {
  return REQUIRED_FOR_SUBMIT.filter((k) => !row[k])
}

export function nextKycStatus(current: KycStatus | null, action: KycAction): KycStatus | null {
  switch (action) {
    case "save": return current === null || current === "draft" || current === "rejected" ? "draft" : null
    case "submit": return current === "draft" ? "submitted" : null
    case "approve": return current === "submitted" ? "approved" : null
    case "reject": return current === "submitted" ? "rejected" : null
  }
}

export function docExtension(mime: string, size: number): { ok: true; ext: string } | { ok: false; error: string } {
  const ext = DOC_TYPES[mime]
  if (!ext) return { ok: false, error: "Upload a JPG, PNG, WEBP or PDF." }
  if (size <= 0) return { ok: false, error: "The file is empty." }
  if (size > KYC_DOC_MAX_BYTES) return { ok: false, error: "Files must be 5 MB or smaller." }
  return { ok: true, ext }
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Implement `lib/sms/kyc-service.ts`**

```ts
/**
 * KYC (business verification) — spec §5.6. Private bucket `sms-kyc`; admins see documents via
 * 5-minute signed URLs; files are deleted 30 days after the decision (purgeKycDocuments).
 * Approval switches the account to Business mode and unpauses its sender IDs.
 */
import { createClient } from "@supabase/supabase-js"
import { docExtension, missingForSubmit, nextKycStatus, validateKycDraft, type KycDraftInput, type KycStatus } from "./kyc-rules"
import { setAccountMode } from "./sender-rules-service"
import { notifyAdminsThrottled } from "./notify"
import { writeAuditLog } from "./moderation-service"

const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const BUCKET = "sms-kyc"
const PURGE_AFTER_MS = 30 * 86_400_000

export interface KycProfile {
  id: string; sms_account_id: string; business_name: string | null; description: string | null; website: string | null
  whatsapp_number: string | null; ghana_card_last4: string | null; ghana_card_doc_path: string | null
  registration_doc_path: string | null; status: KycStatus; submitted_at: string | null; reviewed_at: string | null
  rejection_reason: string | null; created_at: string
}
type Result<T> = { ok: true; data: T } | { ok: false; error: string; fields?: Record<string, string> }

export async function getCurrentKyc(accountId: string): Promise<KycProfile | null> {
  const { data } = await supabaseAdmin.from("sms_business_profiles").select("*")
    .eq("sms_account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  return (data as KycProfile | null) ?? null
}

/** Save (or start) a draft. A rejected application starts a fresh draft row (history kept). */
export async function saveKycDraft(accountId: string, input: KycDraftInput): Promise<Result<KycProfile>> {
  const v = validateKycDraft(input)
  if (!v.ok) return { ok: false, error: "Please fix the highlighted fields.", fields: v.errors }
  const current = await getCurrentKyc(accountId)
  if (!nextKycStatus(current?.status ?? null, "save")) {
    return { ok: false, error: current?.status === "submitted" ? "Your application is under review." : "Your business is already verified." }
  }
  const now = new Date().toISOString()
  const q = current?.status === "draft"
    ? supabaseAdmin.from("sms_business_profiles").update({ ...v.patch, updated_at: now }).eq("id", current.id).eq("status", "draft")
    : supabaseAdmin.from("sms_business_profiles").insert({ ...v.patch, sms_account_id: accountId, status: "draft" })
  const { data, error } = await q.select("*").single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, data: data as KycProfile }
}

export async function uploadKycDocument(accountId: string, kind: "ghana_card" | "registration", file: File): Promise<Result<KycProfile>> {
  const t = docExtension(file.type, file.size)
  if (!t.ok) return { ok: false, error: t.error }
  const draft = await saveKycDraft(accountId, {})
  if (!draft.ok) return draft
  const path = `${accountId}/${kind}-${Date.now()}.${t.ext}`
  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET)
    .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false })
  if (upErr) return { ok: false, error: `Upload failed: ${upErr.message}` }
  const column = kind === "ghana_card" ? "ghana_card_doc_path" : "registration_doc_path"
  const old = draft.data[column]
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({ [column]: path, updated_at: new Date().toISOString() }).eq("id", draft.data.id).eq("status", "draft").select("*").single()
  if (error) {
    await supabaseAdmin.storage.from(BUCKET).remove([path])
    return { ok: false, error: error.message }
  }
  if (old) await supabaseAdmin.storage.from(BUCKET).remove([old])
  return { ok: true, data: data as KycProfile }
}

export async function submitKyc(accountId: string): Promise<Result<KycProfile>> {
  const current = await getCurrentKyc(accountId)
  if (!current || !nextKycStatus(current.status, "submit")) return { ok: false, error: "There is no draft to submit." }
  const missing = missingForSubmit(current)
  if (missing.length) return { ok: false, error: `Complete these first: ${missing.join(", ")}.` }
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", current.id).eq("status", "draft").select("*").single()
  if (error) return { ok: false, error: error.message }
  notifyAdminsThrottled("sms_kyc_submitted", "New SMS business verification",
    `${current.business_name} submitted business verification for SMS.`, "/admin/sms", 0).catch(() => {})
  return { ok: true, data: data as KycProfile }
}

export async function listKycForAdmin(status: KycStatus | "all" = "submitted"): Promise<KycProfile[]> {
  let q = supabaseAdmin.from("sms_business_profiles").select("*").order("submitted_at", { ascending: false, nullsFirst: false }).limit(200)
  if (status !== "all") q = q.eq("status", status)
  const { data } = await q
  return (data ?? []) as KycProfile[]
}

export async function getKycForAdmin(id: string): Promise<(KycProfile & { ghana_card_doc_url: string | null; registration_doc_url: string | null }) | null> {
  const { data } = await supabaseAdmin.from("sms_business_profiles").select("*").eq("id", id).maybeSingle()
  if (!data) return null
  const p = data as KycProfile
  const sign = async (path: string | null) => {
    if (!path) return null
    const { data: s } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, 300)
    return s?.signedUrl ?? null
  }
  return { ...p, ghana_card_doc_url: await sign(p.ghana_card_doc_path), registration_doc_url: await sign(p.registration_doc_path) }
}

async function notifyAccountOwner(accountId: string, title: string, message: string) {
  const { data: a } = await supabaseAdmin.from("sms_accounts").select("user_id").eq("id", accountId).maybeSingle()
  if (!a?.user_id) return
  const now = new Date().toISOString()
  await supabaseAdmin.from("notifications").insert({ user_id: a.user_id, title, message, type: "sms_kyc", read: false, action_url: "/dashboard/sms", created_at: now, updated_at: now })
}

async function decide(adminId: string | null, id: string, outcome: "approved" | "rejected", reason?: string): Promise<Result<KycProfile>> {
  const now = new Date()
  const { data, error } = await supabaseAdmin.from("sms_business_profiles")
    .update({
      status: outcome, reviewed_by: adminId, reviewed_at: now.toISOString(),
      rejection_reason: outcome === "rejected" ? reason : null,
      docs_purge_after: new Date(now.getTime() + PURGE_AFTER_MS).toISOString(), updated_at: now.toISOString(),
    })
    .eq("id", id).eq("status", "submitted").select("*").maybeSingle()
  if (error || !data) return { ok: false, error: error?.message ?? "Only submitted applications can be decided." }
  if (adminId) writeAuditLog(adminId, `sms_kyc_${outcome}`, null, { id, status: "submitted" }, { id, status: outcome, reason: reason ?? null }).catch(() => {})
  return { ok: true, data: data as KycProfile }
}

export async function approveKyc(adminId: string | null, id: string): Promise<Result<KycProfile & { modeChange: unknown }>> {
  const r = await decide(adminId, id, "approved")
  if (!r.ok) return r
  const mode = await setAccountMode(adminId, r.data.sms_account_id, "business")
  notifyAccountOwner(r.data.sms_account_id, "Business verified",
    "Your business is verified. You're now in Business mode and can request more sender IDs.").catch(() => {})
  return { ok: true, data: { ...r.data, modeChange: mode.ok ? mode.data : { error: mode.error } } }
}

export async function rejectKyc(adminId: string | null, id: string, reason: string): Promise<Result<KycProfile>> {
  const why = (reason ?? "").trim()
  if (why.length < 5) return { ok: false, error: "A rejection reason (5+ characters) is required." }
  const r = await decide(adminId, id, "rejected", why)
  if (r.ok) notifyAccountOwner(r.data.sms_account_id, "Business verification not approved",
    `Reason: ${why}. You can update your details and submit again.`).catch(() => {})
  return r
}

/** Delete decided applications' documents once docs_purge_after has passed. */
export async function purgeKycDocuments(now = new Date()): Promise<{ purged: number; errors: number }> {
  const { data } = await supabaseAdmin.from("sms_business_profiles")
    .select("id, ghana_card_doc_path, registration_doc_path").lt("docs_purge_after", now.toISOString())
    .or("ghana_card_doc_path.not.is.null,registration_doc_path.not.is.null").limit(200)
  let purged = 0, errors = 0
  for (const row of (data ?? []) as { id: string; ghana_card_doc_path: string | null; registration_doc_path: string | null }[]) {
    const paths = [row.ghana_card_doc_path, row.registration_doc_path].filter((p): p is string => !!p)
    const { error } = await supabaseAdmin.storage.from(BUCKET).remove(paths)
    if (error) { errors++; continue }
    await supabaseAdmin.from("sms_business_profiles").update({ ghana_card_doc_path: null, registration_doc_path: null }).eq("id", row.id)
    purged++
  }
  return { purged, errors }
}
```

- [ ] **Step 6: Customer routes** (all use `resolveAccount` from `@/lib/sms/tenant-auth`)

`app/api/sms/business/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { getCurrentKyc, saveKycDraft } from "@/lib/sms/kyc-service"

export async function GET(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  return NextResponse.json({ success: true, data: { mode: (account as { mode?: string }).mode ?? "platform", profile: await getCurrentKyc(account.id) } })
}

// PUT { business_name?, description?, website?, whatsapp_number?, ghana_card_number? }
export async function PUT(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const pick = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined)
  const r = await saveKycDraft(account.id, {
    business_name: pick("business_name"), description: pick("description"), website: pick("website"),
    whatsapp_number: pick("whatsapp_number"), ghana_card_number: pick("ghana_card_number"),
  })
  if (!r.ok) return NextResponse.json({ success: false, error: r.error, fields: r.fields }, { status: 400 })
  return NextResponse.json({ success: true, data: r.data })
}
```

`app/api/sms/business/documents/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { uploadKycDocument } from "@/lib/sms/kyc-service"

// POST multipart/form-data: kind=ghana_card|registration, file=<File>
export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  let form: FormData
  try { form = await request.formData() } catch { return NextResponse.json({ success: false, error: "Expected multipart form data" }, { status: 400 }) }
  const kind = form.get("kind")
  const file = form.get("file")
  if ((kind !== "ghana_card" && kind !== "registration") || !(file instanceof File)) {
    return NextResponse.json({ success: false, error: "kind (ghana_card|registration) and file are required" }, { status: 400 })
  }
  const r = await uploadKycDocument(account.id, kind, file)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: r.data })
}
```

`app/api/sms/business/submit/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { resolveAccount } from "@/lib/sms/tenant-auth"
import { submitKyc } from "@/lib/sms/kyc-service"

export async function POST(request: NextRequest) {
  const { account, error } = await resolveAccount(request)
  if (error) return error
  const r = await submitKyc(account.id)
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: r.data })
}
```

- [ ] **Step 7: Admin routes**

`app/api/admin/sms-platform/business-reviews/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { listKycForAdmin } from "@/lib/sms/kyc-service"

// GET ?status=submitted|approved|rejected|draft|all (default submitted)
export async function GET(request: NextRequest) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const s = request.nextUrl.searchParams.get("status") ?? "submitted"
  if (!["submitted", "approved", "rejected", "draft", "all"].includes(s)) {
    return NextResponse.json({ success: false, error: "invalid status" }, { status: 400 })
  }
  return NextResponse.json({ success: true, data: await listKycForAdmin(s as "submitted") })
}
```

`app/api/admin/sms-platform/business-reviews/[id]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyAdminAccess } from "@/lib/admin-auth"
import { approveKyc, getKycForAdmin, rejectKyc } from "@/lib/sms/kyc-service"

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { id } = await params
  const p = await getKycForAdmin(id)
  if (!p) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 })
  return NextResponse.json({ success: true, data: p })
}

// POST { action: "approve" | "reject", reason?: string }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyAdminAccess(request)
  if (!auth.isAdmin) return auth.errorResponse!
  const { id } = await params
  let body: { action?: string; reason?: string }
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 }) }
  const adminId = (auth as { userId?: string }).userId ?? null
  const r =
    body.action === "approve" ? await approveKyc(adminId, id) :
    body.action === "reject" ? await rejectKyc(adminId, id, body.reason ?? "") :
    { ok: false as const, error: "action must be approve or reject" }
  if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 400 })
  return NextResponse.json({ success: true, data: r.data })
}
```

- [ ] **Step 8: Purge cron** `app/api/cron/sms-kyc-purge/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { purgeKycDocuments } from "@/lib/sms/kyc-service"

/** Delete KYC documents 30 days after the admin's decision. Daily. */
export async function GET(request: NextRequest) {
  const auth = verifyCronAuth(request)
  if (!auth.authorized) return auth.errorResponse!
  return NextResponse.json({ success: true, data: await purgeKycDocuments() })
}
```
`vercel.json` crons:
```json
    {
      "path": "/api/cron/sms-kyc-purge",
      "schedule": "30 3 * * *"
    },
```

- [ ] **Step 9: Run** `npx vitest run lib/sms/kyc-rules.test.ts` — PASS; `npx tsc --noEmit` — clean.
- [ ] **Step 10: Commit** — `feat(sms): KYC backend — drafts, private documents, review, 30-day purge` + trailer.

---

### Task 14: Bundles per mode + revenue, Allowed Roles, API rate limit

**Files:**
- Modify: `lib/sms/foundation-rules.ts` (+test), `lib/sms/account-service.ts`, `lib/sms/bundle-service.ts` (+test), `app/api/sms/bundles/route.ts`, `app/api/admin/sms/bundles/route.ts`, `app/api/webhooks/paystack/route.ts`, `app/api/v1/sms/send/route.ts`

- [ ] **Step 1: Failing tests** (append to `lib/sms/foundation-rules.test.ts`)

```ts
import { deriveOwnerType, bundleVisibleTo } from "./foundation-rules"

describe("individual accounts via Allowed Roles", () => {
  it("dealer without a shop gets an individual account when dealers are allowed", () => {
    expect(deriveOwnerType({ role: "dealer", ownsShop: false, isSubAgent: false, allowedRoles: ["dealer"] }))
      .toEqual({ ownerType: "individual", ownerId: null })
  })
  it("not allowed → no account (today's behaviour)", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: false, isSubAgent: false, allowedRoles: ["shop_owner"] })).toBeNull()
  })
  it("shop owners keep shop accounts regardless", () => {
    expect(deriveOwnerType({ role: "user", ownsShop: true, isSubAgent: false, shopId: "s1", allowedRoles: [] })?.ownerType).toBe("shop")
  })
})

describe("bundleVisibleTo", () => {
  const b = { id: "1", active: true, owner_type_scope: "all" as const, mode: "platform" as const }
  it("matches mode", () => {
    expect(bundleVisibleTo(b, "shop", "platform")).toBe(true)
    expect(bundleVisibleTo(b, "shop", "business")).toBe(false)
  })
  it("respects active + scope", () => {
    expect(bundleVisibleTo({ ...b, active: false }, "shop", "platform")).toBe(false)
    expect(bundleVisibleTo({ ...b, owner_type_scope: "sub_agent" }, "shop", "platform")).toBe(false)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: `lib/sms/foundation-rules.ts`**

```ts
export type OwnerType = "platform" | "shop" | "sub_agent" | "individual"
```
Add `allowedRoles?: string[]` to `OwnerInput`, and in `deriveOwnerType` after the sub-agent line:
```ts
  // Users without a shop get an individual account only if their role is an Allowed Role.
  if (INDIVIDUAL_ROLES.includes(input.role) && input.allowedRoles?.includes(input.role)) {
    return { ownerType: "individual", ownerId: null }
  }
```
with `const INDIVIDUAL_ROLES = ["dealer", "user"]` above the function. Append:
```ts
export function bundleVisibleTo(
  bundle: BundleLike & { mode: "platform" | "business" },
  ownerType: OwnerType,
  mode: "platform" | "business"
): boolean {
  return bundle.mode === mode && canPurchaseBundle(bundle, ownerType).ok
}
```

- [ ] **Step 4: `lib/sms/account-service.ts`** — pass Allowed Roles and expose the new columns:
```ts
import { loadSmsSettings } from "./platform-settings"
```
Add to `SmsAccount`: `mode?: "platform" | "business"; api_rate_limit_override?: number | null; default_sender_id?: string | null; review_hold?: boolean`.
In `resolveOwnerContext`, load settings once and pass `allowedRoles` in the final `deriveOwnerType` call:
```ts
  const { allowedRoles } = await loadSmsSettings()
  return deriveOwnerType({
    role: u?.role ?? "user",
    ownsShop: !!shop && !isSub,
    isSubAgent: isSub,
    shopId: shop?.id,
    subAgentId: shop?.id,
    allowedRoles,
  })
```

- [ ] **Step 5: `lib/sms/bundle-service.ts`**

- `Bundle` gains `mode: "platform" | "business"; sort_order: number`.
- `listActiveBundles`:
```ts
export async function listActiveBundles(ownerType: OwnerType, mode: "platform" | "business" = "platform"): Promise<Bundle[]> {
  const { data } = await supabaseAdmin
    .from("sms_bundles").select("*").eq("active", true).eq("mode", mode)
    .order("sort_order", { ascending: true }).order("price_ghs", { ascending: true })
  return ((data as Bundle[]) ?? []).filter((b) => bundleVisibleTo(b, ownerType, mode))
}
```
(import `bundleVisibleTo`; `listAllBundles` orders by `mode`, then `sort_order`.)
- `createBundle` input adds `mode?: "platform" | "business"; sort_order?: number` and inserts `mode: input.mode ?? "platform", sort_order: input.sort_order ?? 0`; `updateBundle` patch type adds the same two keys. Validate in both: `mode` ∈ {platform, business} else throw `new Error("mode must be platform or business")`.
- Revenue: change `issueUnits` signature to `issueUnits(accountId, units, reason, ref, amountGhs: number | null = null)` and after a successful RPC (credited or pending) add:
```ts
  if (ref && amountGhs !== null && amountGhs > 0) {
    // Revenue for the admin "Total Revenue" card (spec §5.8). A pending credit carries the
    // amount on its pending row; the ledger trigger copies it when the credit settles.
    await Promise.all([
      supabaseAdmin.from("sms_unit_transactions").update({ amount_ghs: amountGhs }).eq("ref", ref).is("amount_ghs", null),
      supabaseAdmin.from("sms_pending_credits").update({ amount_ghs: amountGhs }).eq("ref", ref).is("amount_ghs", null),
    ])
  }
```
- `purchaseBundleViaWallet`: select `status, owner_type, mode` for the account; after the activation gate add
```ts
  if (b.mode !== ((acct as { mode?: string } | null)?.mode ?? "platform")) return { ok: false, error: "This bundle isn't available for your account mode" }
```
and call `issueUnits(accountId, b.units, "bundle_wallet", ref, Number(b.price_ghs))`.
- `purchaseUnitsByQuantity`: `issueUnits(accountId, credits, "bundle_wallet", ref, cost)`.
- `creditUnitsForPaystack(accountId, units, paystackRef, amountGhs: number | null = null)` → `issueUnits(accountId, units, "bundle_paystack", paystackRef, amountGhs)`.
- In `lib/sms/bundle-service.test.ts`, extend the fake bundle rows with `mode: "platform"`, account rows with `mode: "platform"`, and add one test: buying a `mode: "business"` bundle from a platform account returns the mode error without debiting the wallet.

- [ ] **Step 6: Callers**

- `app/api/sms/bundles/route.ts` line 16: `await listActiveBundles(account.owner_type as OwnerType, (account.mode ?? "platform") as "platform" | "business")`.
- `app/api/admin/sms/bundles/route.ts`: no code change needed (body passes through) — confirm `mode`/`sort_order` reach `createBundle`/`updateBundle`.
- `app/api/webhooks/paystack/route.ts`: line 89 → `creditUnitsForPaystack(metadata.sms_account_id, Number(smsBundle.units), reference, paidGhs)`; line 110 → `creditUnitsForPaystack(metadata.sms_account_id, credits, reference, paidGhs)`; apply the same to the two calls at lines ~154 and ~175 (use the amount variable in scope there; read that block and pass the paid GH₵ amount).

- [ ] **Step 7: API rate limit** in `app/api/v1/sms/send/route.ts`

Move the account lookup above the rate limit and replace the `rateLimitCount`/`postLimit` lines:
```ts
import { apiRateLimitFor, loadSmsSettings } from "@/lib/sms/platform-settings"
// …after authenticateApiKey:
  const account = user.environment === "test" ? null : await getOrCreateAccountForUser(user.id)
  const { apiRateLimitDefault } = await loadSmsSettings()
  const postLimit = apiRateLimitFor(account?.api_rate_limit_override, apiRateLimitDefault)
  const rateLimit = await applyRateLimit(request, "v1_sms_send_post", postLimit, 60 * 1000, user.id)
  if (!rateLimit.allowed) {
    return NextResponse.json({ success: false, error: `Rate limit exceeded. Your current limit is ${postLimit} requests/minute.` }, { status: 429 })
  }
  if (user.environment !== "test" && !account) {
    return NextResponse.json({ success: false, error: "No SMS account for this API key's owner (requires a shop, sub-agent, or admin account)" }, { status: 403 })
  }
```
(delete the old later `const account = …` and its 403 check). Also replace the default-sender lookup block (`let effectiveSenderId …`) so it prefers the account's default and never picks a paused ID:
```ts
  let effectiveSenderId = sender_id as string | undefined
  if (!effectiveSenderId && account!.default_sender_id) {
    const { data: def } = await supabaseAdmin.from("sms_sender_ids").select("sender_id")
      .eq("id", account!.default_sender_id).eq("local_status", "active").maybeSingle()
    effectiveSenderId = (def as { sender_id?: string } | null)?.sender_id ?? undefined
  }
```

- [ ] **Step 8: Run** `npx vitest run lib/sms` — PASS; `npx tsc --noEmit` — clean.
- [ ] **Step 9: Commit** — `feat(sms): per-mode bundles, purchase revenue, Allowed Roles, per-account API limit` + trailer.

---

### Task 15: Full verification, rollout, live Hubtel test

Controller-run. Stop and ask the user wherever a step needs them.

- [ ] **Step 1: Full checks**
```
npx tsc --noEmit
npm run test:run      # expect only the 9 known order-health-service failures
npm run build         # placeholder env is fine; must succeed (route-export check)
```

- [ ] **Step 2: Whole-implementation review** — dispatch the final code reviewer over `git diff <task-1-commit>^..HEAD` with the spec; fix Critical/Important findings and re-review.

- [ ] **Step 3: Ship code (policy record-only, Hubtel not primary)**
```
git push origin worktree-customer-ui-rebuild
git fetch origin main && git log --oneline HEAD..origin/main     # merge origin/main if anything is listed, re-run Step 1
git push origin HEAD:main
```
Watch the Vercel production deployment until READY (auto-deploy has been flaky — if none starts within ~3 min, trigger it via the Vercel API per [[reference-vercel-access]] with a user-provided token).

- [ ] **Step 4: Live checks with Moolre still primary (nothing customer-visible changes)**
```
node <sq.js> "select count(*) filter (where policy_shadow is not null) shadowed, count(*) from sms_send_logs where created_at > now() - interval '1 hour'"
```
After the next real customer send: `shadowed` > 0 and that send's status is unchanged (sent/partial as before). Spot-check one shadow's `decision`/`code`.

- [ ] **Step 5: User actions (ask; never handle secrets in chat)**
  1. Vercel env: `HUBTEL_SMS_CLIENT_ID`, `HUBTEL_SMS_CLIENT_SECRET` (optional `HUBTEL_SENDER_ID`); redeploy.
  2. Droplet: redeploy relay files, set `HUBTEL_DISBURSEMENT_ACCOUNT` (and `HUBTEL_BALANCE_BASIC_AUTH` if Hubtel says the balance API uses different keys), restart; confirm with Hubtel that the droplet IP is whitelisted for `trnf.hubtel.com`.
  3. Confirm whether the Disbursement account also funds other Hubtel payouts (sets the right `sms_hubtel_low_balance_ghs`).

- [ ] **Step 6: Balance check through the relay** — user runs the README `curl /balance`; expect `{"ok":true,"upstreamStatus":200,"body":{"responseCode":"0000",…}}`. If 401/403 upstream: credentials or whitelist — resolve with Hubtel before continuing.

- [ ] **Step 7: Live Hubtel test SMS, then go primary**
  1. Set primary: `node <sq.js> "update admin_settings set value='\"hubtel\"' where key='sms_primary_provider'"` — first `select value from admin_settings where key='sms_primary_provider'` and record the old value for rollback (match its exact jsonb/text shape when writing).
  2. Ask the user to send one admin SMS (SMS Centre) to their own phone. Confirm: received on the handset; `select provider, status from sms_logs order by created_at desc limit 1` → `hubtel / sent`.
  3. Ask the user for one small real campaign (2–3 own numbers) from a shop dashboard. Confirm `sms_messages` rows `provider='hubtel'`, `provider_batch_id` set, and within ~5 min `delivery_status='delivered'` with `cost_ghs` filled by the DLR cron.
  4. Any failure → restore the recorded old value (rollback = one setting) and investigate.

- [ ] **Step 8: Memory** — update `project-sms-platform-rebuild.md` (Phase 1 shipped: commits, migration applied, Hubtel primary yes/no, open items) and `MEMORY.md`.

- [ ] **Step 9: Report** with % complete for the SMS program (Phase 1 of 4 done) and the open user actions.

