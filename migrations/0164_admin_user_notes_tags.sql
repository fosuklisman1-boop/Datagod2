-- 0164_admin_user_notes_tags.sql
-- Already applied to production on 2026-11-09 (as 0149_admin_user_notes_tags.sql)
--
-- Admin notes and tags on users, and the per-page activity / risk signals for the admin users page
-- (app/admin/users, its user drawer, /api/admin/users/[id]/notes, /api/admin/users/[id]/tags and GET /api/admin/users).
-- ADDITIVE (two new tables, their indexes, one new function). Idempotent (re-runnable). One transaction.
-- Must be applied BEFORE the code that calls it is deployed. 0160's admin_list_users / admin_export_users read
-- public.admin_user_tags when they are called, so they need this migration too.
--
--   public.admin_user_notes   free-text notes admins keep about a user
--     id          uuid PK
--     user_id     the user the note is about (auth.users; the note goes when the user is deleted)
--     author_id   the admin who wrote it (auth.users; set NULL if that admin account is deleted, the note stays)
--     body        text, 1..2000 characters (CHECK; the route trims first and refuses blank notes)
--     created_at, updated_at
--     Index (user_id, created_at DESC): the drawer lists one user's notes newest first.
--
--   public.admin_user_tags    short labels on a user, e.g. vip, fraud-watch
--     PRIMARY KEY (user_id, tag): one row per tag per user; it is also the user_id index (leading column) and
--     answers the list filter's EXISTS (user_id = x AND tag = y).
--     tag         1..32 characters of [a-z0-9-] (CHECK). The UI suggests vip, fraud-watch, bulk-buyer, reseller,
--                 support-priority (lib/admin-users/notes-tags.ts) but any tag that passes the CHECK is allowed.
--     created_by  the admin who added it; created_at
--     Index (tag, user_id): "which users carry tag x" without reading every row.
--
--   Both tables: RLS enabled with NO policies, and every privilege revoked from anon and authenticated, so only
--   the service role (the admin routes, which check the caller is an admin and write admin_audit_log) can read
--   or write them. Notes can hold sensitive remarks about a customer; nothing client-side may read them.
--
--   admin_user_signals(p_user_ids uuid[], p_failed_hours int, p_refund_hours int, p_credit_hours int)
--     RETURNS jsonb {"<user id>": {...}, ...}: one object per distinct, non-NULL id given (at most 200, else
--     'BAD_INPUT'); ids that match no user still get an object (all counts 0, dates NULL).
--       last_order_at         newest created_at over the 7 order tables 0162 reads (orders, api_orders,
--                             hubtel_data_orders, airtime_orders, hubtel_bill_orders, results_checker_orders,
--                             afa_orders); NULL if none. One max() per table on its (user_id, created_at DESC)
--                             index (0163 and 0117/0118): an index-only top-1 per table.
--       failed_orders         orders in those tables with lower(status) IN ('failed', 'error') created in the
--                             last p_failed_hours hours; for afa_orders also 'cancelled' (how AFA marks a failed
--                             registration). The hubtel tables (hubtel_data_orders, hubtel_bill_orders) move a
--                             failed order on to 'refunded' once it is refunded, so those show up as refunds
--                             instead. Each table's count stops at 50 (range scan on the same index), so the sum
--                             is at most 350.
--       refunds               refund credits to the user's wallet in the last p_refund_hours hours: transactions
--                             with type 'credit' and source airtime_refund, standard_bundle_refund,
--                             results_checker_refund, results_check_refund, order_refund or bill_refund (every
--                             source the refund paths write; they all credit through credit_wallet_safely or an
--                             insert with type 'credit'). NOT refund_clawback / refund_clawback_undo: those are
--                             taken from / returned to the shop owner of a refunded storefront order. No code
--                             writes type 'refund' or 'order_refund' transactions, so types are not matched.
--                             Stops at 50. Uses the (user_id, created_at DESC) index added by 0165 (works
--                             without it, slower).
--       admin_credits         admin_audit_log 'wallet_credit' rows for the user in the last p_credit_hours hours
--                             (0161 writes one per admin credit), and admin_credit_amount, their total amount.
--                             Stops at 50 rows. Index idx_admin_audit_log_target (target_user_id, created_at DESC).
--       created_at            auth.users.created_at
--       wallet_balance        wallets.balance (the larger one if a user ever had two rows; 0 if none)
--       phone_number          users.phone_number
--       phone_verified        users.phone_verified (false without a users row)
--       same_phone_accounts   users rows (this user included) whose phone_number is the same Ghana number in any
--                             stored form: 0XXXXXXXXX, XXXXXXXXX, 233XXXXXXXXX or +233XXXXXXXXX (the forms
--                             lib/phone-format.ts accepts); exact match when the number is not a Ghana mobile.
--                             idx_users_phone_number lookups; stops at 50. 0 without a phone.
--     Hours are clamped to 1..720. The thresholds that turn these numbers into flags live in the app
--     (lib/admin-users/risk-signals.ts), so they can be changed and tested without a migration; this function
--     only counts, and only for the ids it is given (the current page, at most 200 users).
--     Blacklisted phones are NOT checked here: the route uses lib/blacklist.ts so there is one definition.
--
--   SECURITY DEFINER (it reads every user's orders and money), search_path = public, pg_temp, every table
--   schema-qualified, EXECUTE for service_role only. jit = off (as 0160): 7 subqueries per id inflate the cost
--   estimate past jit_above_cost and JIT compilation would cost more than the query.
--
--   NOT done here: a "has risk flags" list filter. Deciding it for the whole user base means running these
--   counts for every user on every list call (the total needs all of them), which is what this design avoids.

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_user_notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_id  uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_user_notes_user ON public.admin_user_notes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.admin_user_tags (
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tag        text        NOT NULL CHECK (tag ~ '^[a-z0-9-]{1,32}$'),
  created_by uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_admin_user_tags_tag ON public.admin_user_tags (tag, user_id);

ALTER TABLE public.admin_user_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_user_tags  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_user_notes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.admin_user_tags  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.admin_user_notes TO service_role;
GRANT ALL ON public.admin_user_tags  TO service_role;

CREATE OR REPLACE FUNCTION public.admin_user_signals(
  p_user_ids     uuid[],
  p_failed_hours int DEFAULT 24,
  p_refund_hours int DEFAULT 168,
  p_credit_hours int DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET jit = off
AS $fn$
DECLARE
  c_cap          constant int := 50;
  v_ids          uuid[];
  v_failed_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_failed_hours, 24), 1), 720));
  v_refund_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_refund_hours, 168), 1), 720));
  v_credit_since timestamptz := now() - make_interval(hours => least(greatest(coalesce(p_credit_hours, 24), 1), 720));
  v_result       jsonb;
BEGIN
  IF p_user_ids IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user ids are required';
  END IF;
  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_user_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'at most 200 user ids';
  END IF;

  SELECT coalesce(jsonb_object_agg(s.id, jsonb_build_object(
    'last_order_at',       s.last_order_at,
    'failed_orders',       s.failed_orders,
    'refunds',             s.refunds,
    'admin_credits',       s.admin_credits,
    'admin_credit_amount', s.admin_credit_amount,
    'created_at',          s.created_at,
    'wallet_balance',      s.wallet_balance,
    'phone_number',        s.phone_number,
    'phone_verified',      s.phone_verified,
    'same_phone_accounts', s.same_phone_accounts
  )), '{}'::jsonb)
  INTO v_result
  FROM (
    SELECT
      i.id,
      greatest(
        (SELECT max(o.created_at)::timestamptz   FROM public.orders o                  WHERE o.user_id = i.id),
        (SELECT max(ao.created_at)::timestamptz  FROM public.api_orders ao             WHERE ao.user_id = i.id),
        (SELECT max(hd.created_at)::timestamptz  FROM public.hubtel_data_orders hd     WHERE hd.user_id = i.id),
        (SELECT max(air.created_at)::timestamptz FROM public.airtime_orders air        WHERE air.user_id = i.id),
        (SELECT max(hb.created_at)::timestamptz  FROM public.hubtel_bill_orders hb     WHERE hb.user_id = i.id),
        (SELECT max(rc.created_at)::timestamptz  FROM public.results_checker_orders rc WHERE rc.user_id = i.id),
        (SELECT max(afa.created_at)::timestamptz FROM public.afa_orders afa            WHERE afa.user_id = i.id)
      ) AS last_order_at,
      (SELECT count(*) FROM (SELECT 1 FROM public.orders o WHERE o.user_id = i.id
         AND o.created_at >= v_failed_since AND lower(o.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.api_orders ao WHERE ao.user_id = i.id
         AND ao.created_at >= v_failed_since AND lower(ao.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_data_orders hd WHERE hd.user_id = i.id
         AND hd.created_at >= v_failed_since AND lower(hd.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.airtime_orders air WHERE air.user_id = i.id
         AND air.created_at >= v_failed_since AND lower(air.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_bill_orders hb WHERE hb.user_id = i.id
         AND hb.created_at >= v_failed_since AND lower(hb.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.results_checker_orders rc WHERE rc.user_id = i.id
         AND rc.created_at >= v_failed_since AND lower(rc.status) IN ('failed', 'error') LIMIT c_cap) x)
      + (SELECT count(*) FROM (SELECT 1 FROM public.afa_orders afa WHERE afa.user_id = i.id
         AND afa.created_at >= v_failed_since AND lower(afa.status) IN ('failed', 'error', 'cancelled') LIMIT c_cap) x)
      AS failed_orders,
      (SELECT count(*) FROM (SELECT 1 FROM public.transactions t WHERE t.user_id = i.id
         AND t.created_at >= v_refund_since
         AND t.type = 'credit'
         AND t.source IN ('airtime_refund', 'standard_bundle_refund', 'results_checker_refund',
                          'results_check_refund', 'order_refund', 'bill_refund')
         LIMIT c_cap) x) AS refunds,
      cr.n AS admin_credits,
      cr.amount AS admin_credit_amount,
      au.created_at,
      coalesce((SELECT max(w.balance) FROM public.wallets w WHERE w.user_id = i.id), 0)::numeric AS wallet_balance,
      u.phone_number::text AS phone_number,
      coalesce(u.phone_verified, false) AS phone_verified,
      CASE
        WHEN nullif(btrim(coalesce(u.phone_number, '')), '') IS NULL THEN 0
        ELSE (SELECT count(*) FROM (SELECT 1 FROM public.users u2
               WHERE u2.phone_number = ANY (ph.forms) LIMIT c_cap) x)
      END AS same_phone_accounts
    FROM unnest(v_ids) AS i(id)
    LEFT JOIN auth.users au ON au.id = i.id
    LEFT JOIN public.users u ON u.id = i.id
    CROSS JOIN LATERAL (
      -- The Ghana significant digits (lib/phone-format.ts ghanaSignificant), then every form they may be stored in.
      SELECT CASE
        WHEN g.sig ~ '^[2-9][0-9]{8}$' THEN ARRAY['0' || g.sig, g.sig, '233' || g.sig, '+233' || g.sig]
        ELSE ARRAY[btrim(coalesce(u.phone_number, ''))]
      END AS forms
      FROM (SELECT regexp_replace(regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g'), '^(233|0)', '') AS sig) g
    ) ph
    CROSS JOIN LATERAL (
      SELECT count(*) AS n,
             coalesce(sum(CASE WHEN a.new_value->>'amount' ~ '^[0-9]+(\.[0-9]+)?$'
                               THEN (a.new_value->>'amount')::numeric END), 0) AS amount
      FROM (SELECT al.new_value FROM public.admin_audit_log al
            WHERE al.target_user_id = i.id AND al.action = 'wallet_credit' AND al.created_at >= v_credit_since
            LIMIT c_cap) a
    ) cr
  ) s;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_user_signals(uuid[], int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_signals(uuid[], int, int, int) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT relrowsecurity FROM pg_class WHERE oid IN ('public.admin_user_notes'::regclass, 'public.admin_user_tags'::regclass); -- t, t
--   SELECT count(*) FROM pg_policies WHERE tablename IN ('admin_user_notes', 'admin_user_tags');                           -- 0
--   SELECT public.admin_user_signals(ARRAY['<user id>']::uuid[]);
--   SELECT has_function_privilege('authenticated', 'public.admin_user_signals(uuid[],int,int,int)', 'EXECUTE');           -- false
