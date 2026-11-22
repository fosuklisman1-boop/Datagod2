-- 0190_admin_order_queue.sql
--
-- Admin order work queue: two read-only SQL functions over combined_orders_view + mtn_fulfillment_tracking. ADDITIVE; service-role
-- only. NOT applied by the implementing agent. One transaction. Idempotent (CREATE OR REPLACE + REVOKE/GRANT). Creates NO table and
-- does NOT create or alter combined_orders_view. Ships dark: nothing calls these until later tasks of the plan.
--
--   admin_order_queue(...)         one page of orders for a queue view (needs_action, held, stuck, failed, all), each with its LATEST
--                                  fulfilment attempt, attempt count, reversal flag, held flag, and a failure_reason bucket
--                                  (total_count = rows matching before limit/offset).
--   admin_order_queue_counts(...)  the five view counts under the same filters (statuses excluded), so tabs and lists agree.
--
-- View rules: needs_action = status pending|reversed; held = status processing AND latest attempt abandoned or its mtn_order_id
-- LIKE 'UNKNOWN\_%'; stuck = status processing AND latest attempt pending|processing AND older than 2 hours; failed = status failed;
-- all = everything. When p_from is NULL, all and failed default to the last 7 days; needs_action, held, stuck ignore that default.
-- p_to is an exclusive upper bound. Search: ILIKE with \ % _ escaped, against phone, payment reference, customer email, store name.
-- failure_reason mirrors lib/order-queue/failure-reason.ts (same keywords, same order, same abandoned/UNKNOWN_/failed checks); the
-- PGlite test asserts SQL == TypeScript for every shared fixture. In LIKE patterns _ and % are wildcards, so keyword underscores are
-- escaped as \_ to match exactly what the TypeScript substring check matches.
--
-- PRE-CHECKS (each must return the stated value before applying):
--   SELECT to_regprocedure('public.admin_order_queue(text,text[],text[],text[],timestamptz,timestamptz,text,text,text,int,int)');  -- NULL
--   SELECT to_regclass('public.combined_orders_view'), to_regclass('public.mtn_fulfillment_tracking');                             -- both non-NULL
--
-- Self-test (self-rolling-back dry run): migrations/0190_admin_order_queue.selftest.sql
-- The run string must be built by CODE which asserts it contains no COMMIT and no bare END; statement
-- (the 0130 incident lesson); lib/order-queue/migration-0190.test.ts builds and checks it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.admin_order_queue(
  p_view            text,
  p_statuses        text[],
  p_networks        text[],
  p_types           text[],
  p_from            timestamptz,
  p_to              timestamptz,
  p_search          text,
  p_last_provider   text,
  p_failure_reason  text,
  p_limit           int,
  p_offset          int
)
RETURNS TABLE (
  id                  text,
  created_at          timestamptz,
  phone_number        text,
  price               numeric,
  network             text,
  status              text,
  payment_status      text,
  payment_reference   text,
  volume_gb           text,
  type                text,
  customer_email      text,
  store_name          text,
  shop_owner_email    text,
  last_provider       text,
  last_attempt_status text,
  last_error          text,
  attempt_count       int,
  has_reversal        bool,
  is_held             bool,
  failure_reason      text,
  total_count         bigint
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH base AS (
    SELECT
      v.id::text                       AS id,
      v.created_at::timestamptz        AS created_at,
      v.phone_number::text             AS phone_number,
      v.price::numeric                 AS price,
      v.network::text                  AS network,
      v.status::text                   AS status,
      v.payment_status::text           AS payment_status,
      v.payment_reference::text        AS payment_reference,
      v.volume_gb::text                AS volume_gb,
      v.type::text                     AS type,
      v.customer_email::text           AS customer_email,
      v.store_name::text               AS store_name,
      v.shop_owner_email::text         AS shop_owner_email,
      la.provider::text                AS last_provider,
      la.status::text                  AS last_attempt_status,
      la.mtn_order_id                  AS last_mtn_order_id,
      la.created_at                    AS last_attempt_at,
      (la.id IS NOT NULL)              AS has_attempt,
      coalesce(la.attempt_count, 0)::int      AS attempt_count,
      coalesce(la.has_reversal, false)        AS has_reversal,
      la.full_message                  AS full_message,
      left(la.full_message, 120)       AS last_error
    FROM public.combined_orders_view v
    LEFT JOIN LATERAL (
      SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at,
             coalesce(t.external_message, t.api_response_payload ->> 'message') AS full_message,
             count(*) OVER ()                       AS attempt_count,
             bool_or(t.status = 'reversed') OVER () AS has_reversal
        FROM (
               -- index-friendly form of coalesce(order_id, shop_order_id, api_order_id) = v.id (same precedence; casts on the v.id side only)
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id = v.id
               UNION ALL
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id IS NULL AND t.shop_order_id = (CASE WHEN v.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v.id::uuid END)
               UNION ALL
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id IS NULL AND t.shop_order_id IS NULL AND t.api_order_id = (CASE WHEN v.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v.id::uuid END)
             ) t
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1
    ) la ON true
    WHERE (p_statuses IS NULL OR cardinality(p_statuses) = 0 OR v.status::text = ANY (p_statuses))
      AND (p_networks IS NULL OR cardinality(p_networks) = 0 OR v.network::text = ANY (p_networks))
      AND (p_types    IS NULL OR cardinality(p_types)    = 0 OR v.type::text    = ANY (p_types))
      AND (p_from IS NULL OR v.created_at >= p_from)
      AND (p_to   IS NULL OR v.created_at <  p_to)
      AND (p_last_provider IS NULL OR la.provider::text = p_last_provider)
      AND (p_search IS NULL OR p_search = '' OR (
            v.phone_number::text       ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.payment_reference::text  ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.customer_email::text     ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.store_name::text         ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
      -- note: an order can appear in both held and stuck (processing + UNKNOWN_ id + old attempt)
      -- cheap row-level pre-filter per view (the attempt-dependent part is applied below)
      AND CASE p_view
            WHEN 'needs_action' THEN v.status::text IN ('pending', 'reversed')
            WHEN 'held'         THEN v.status::text = 'processing'
            WHEN 'stuck'        THEN v.status::text = 'processing'
            WHEN 'failed'       THEN v.status::text = 'failed' AND (p_from IS NOT NULL OR v.created_at >= now() - interval '7 days')
            WHEN 'all'          THEN (p_from IS NOT NULL OR v.created_at >= now() - interval '7 days')
            ELSE false
          END
  ),
  classified AS (
    SELECT b.*,
      coalesce(b.status = 'processing'
        AND (b.last_attempt_status = 'abandoned' OR coalesce(b.last_mtn_order_id, '') LIKE 'UNKNOWN\_%'), false) AS is_held,
      CASE
        WHEN NOT b.has_attempt THEN 'none'
        WHEN b.last_attempt_status = 'abandoned' OR coalesce(b.last_mtn_order_id, '') LIKE 'UNKNOWN\_%' THEN 'outcome_unknown'
        WHEN b.last_attempt_status IS DISTINCT FROM 'failed' THEN 'none'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%not enabled on mtn%', '%not\_on\_beneficiary\_list%', '%not approved for mtn%']) THEN 'not_enabled'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%insufficient%', '%zero or negative balance%', '%required: gh₵%']) THEN 'out_of_balance'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%rate limit%', '%rate-limiting%']) THEN 'rate_limited'
        WHEN lower(coalesce(b.full_message, '')) LIKE '%no active bundle%' THEN 'no_bundle'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%temporarily unavailable%', '%orders\_paused%', '%on hold%']) THEN 'supplier_unavailable'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%phone does not match%', '%phone number does not match%']) THEN 'wrong_number'
        ELSE 'rejected'
      END AS failure_reason
    FROM base b
  ),
  picked AS (
    SELECT c.*
      FROM classified c
     WHERE CASE p_view
             WHEN 'held'  THEN c.is_held
             WHEN 'stuck' THEN c.last_attempt_status IN ('pending', 'processing')
                               AND c.last_attempt_at < now() - interval '2 hours'
             ELSE true
           END
       AND (p_failure_reason IS NULL OR c.failure_reason = p_failure_reason)
  )
  SELECT p.id, p.created_at, p.phone_number, p.price, p.network, p.status, p.payment_status, p.payment_reference,
         p.volume_gb, p.type, p.customer_email, p.store_name, p.shop_owner_email,
         p.last_provider, p.last_attempt_status, p.last_error, p.attempt_count, p.has_reversal, p.is_held, p.failure_reason,
         count(*) OVER () AS total_count
    FROM picked p
   ORDER BY p.created_at DESC, p.id
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  OFFSET greatest(coalesce(p_offset, 0), 0)
$fn$;

CREATE OR REPLACE FUNCTION public.admin_order_queue_counts(
  p_networks        text[],
  p_types           text[],
  p_from            timestamptz,
  p_to              timestamptz,
  p_search          text,
  p_last_provider   text,
  p_failure_reason  text
)
RETURNS TABLE (view text, n bigint)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH base AS (
    SELECT
      v.status::text            AS status,
      v.created_at              AS created_at,
      la.status::text           AS last_attempt_status,
      la.mtn_order_id           AS last_mtn_order_id,
      la.created_at             AS last_attempt_at,
      (la.id IS NOT NULL)       AS has_attempt,
      la.full_message           AS full_message
    FROM public.combined_orders_view v
    LEFT JOIN LATERAL (
      SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at,
             coalesce(t.external_message, t.api_response_payload ->> 'message') AS full_message
        FROM (
               -- index-friendly form of coalesce(order_id, shop_order_id, api_order_id) = v.id (same precedence; casts on the v.id side only)
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id = v.id
               UNION ALL
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id IS NULL AND t.shop_order_id = (CASE WHEN v.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v.id::uuid END)
               UNION ALL
               SELECT t.id, t.provider, t.status, t.mtn_order_id, t.created_at, t.external_message, t.api_response_payload FROM public.mtn_fulfillment_tracking t
                WHERE t.order_id IS NULL AND t.shop_order_id IS NULL AND t.api_order_id = (CASE WHEN v.id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN v.id::uuid END)
             ) t
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1
    ) la ON true
    WHERE (p_networks IS NULL OR cardinality(p_networks) = 0 OR v.network::text = ANY (p_networks))
      AND (p_types    IS NULL OR cardinality(p_types)    = 0 OR v.type::text    = ANY (p_types))
      AND (p_from IS NULL OR v.created_at >= p_from)
      AND (p_to   IS NULL OR v.created_at <  p_to)
      AND (p_last_provider IS NULL OR la.provider::text = p_last_provider)
      AND (p_search IS NULL OR p_search = '' OR (
            v.phone_number::text       ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.payment_reference::text  ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.customer_email::text     ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         OR v.store_name::text         ILIKE '%' || replace(replace(replace(p_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'))
      -- rows no view can count are dropped before the attempt join is evaluated for them
      AND (v.status::text IN ('pending', 'reversed', 'processing', 'failed')
           OR p_from IS NOT NULL OR v.created_at >= now() - interval '7 days')
  ),
  classified AS (
    SELECT b.*,
      (b.last_attempt_status = 'abandoned' OR coalesce(b.last_mtn_order_id, '') LIKE 'UNKNOWN\_%') AS unknown_outcome,
      (p_from IS NOT NULL OR b.created_at >= now() - interval '7 days') AS in_window,
      CASE
        WHEN NOT b.has_attempt THEN 'none'
        WHEN b.last_attempt_status = 'abandoned' OR coalesce(b.last_mtn_order_id, '') LIKE 'UNKNOWN\_%' THEN 'outcome_unknown'
        WHEN b.last_attempt_status IS DISTINCT FROM 'failed' THEN 'none'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%not enabled on mtn%', '%not\_on\_beneficiary\_list%', '%not approved for mtn%']) THEN 'not_enabled'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%insufficient%', '%zero or negative balance%', '%required: gh₵%']) THEN 'out_of_balance'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%rate limit%', '%rate-limiting%']) THEN 'rate_limited'
        WHEN lower(coalesce(b.full_message, '')) LIKE '%no active bundle%' THEN 'no_bundle'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%temporarily unavailable%', '%orders\_paused%', '%on hold%']) THEN 'supplier_unavailable'
        WHEN lower(coalesce(b.full_message, '')) LIKE ANY (ARRAY['%phone does not match%', '%phone number does not match%']) THEN 'wrong_number'
        ELSE 'rejected'
      END AS failure_reason
    FROM base b
  ),
  agg AS (
    SELECT
      count(*) FILTER (WHERE c.status IN ('pending', 'reversed'))                                             AS needs_action,
      count(*) FILTER (WHERE c.status = 'processing' AND c.unknown_outcome)                                   AS held,
      count(*) FILTER (WHERE c.status = 'processing' AND c.last_attempt_status IN ('pending', 'processing')
                         AND c.last_attempt_at < now() - interval '2 hours')                                  AS stuck,
      count(*) FILTER (WHERE c.status = 'failed' AND c.in_window)                                             AS failed,
      count(*) FILTER (WHERE c.in_window)                                                                     AS all_rows
    FROM classified c
   WHERE p_failure_reason IS NULL OR c.failure_reason = p_failure_reason
  )
  SELECT x.view, x.n
    FROM agg a
   CROSS JOIN LATERAL (VALUES
     ('needs_action', a.needs_action),
     ('held',         a.held),
     ('stuck',        a.stuck),
     ('failed',       a.failed),
     ('all',          a.all_rows)
   ) AS x(view, n)
$fn$;

-- SECURITY INVOKER is deliberate: EXECUTE is service_role-only (REVOKE/GRANT below), so no definer elevation is needed.
-- Service-role only: these read orders, phones and customer emails across every account.
REVOKE ALL ON FUNCTION public.admin_order_queue(text, text[], text[], text[], timestamptz, timestamptz, text, text, text, int, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_order_queue_counts(text[], text[], timestamptz, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_order_queue(text, text[], text[], text[], timestamptz, timestamptz, text, text, text, int, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_order_queue_counts(text[], text[], timestamptz, timestamptz, text, text, text) TO service_role;

COMMIT;

-- Verify after apply (read-only):
--   SELECT has_function_privilege('anon', 'public.admin_order_queue(text,text[],text[],text[],timestamptz,timestamptz,text,text,text,int,int)', 'EXECUTE'),
--          has_function_privilege('authenticated', 'public.admin_order_queue_counts(text[],text[],timestamptz,timestamptz,text,text,text)', 'EXECUTE'),
--          has_function_privilege('service_role', 'public.admin_order_queue_counts(text[],text[],timestamptz,timestamptz,text,text,text)', 'EXECUTE');  -- false, false, true
--   SELECT * FROM public.admin_order_queue_counts(NULL, NULL, NULL, NULL, NULL, NULL, NULL);                                                        -- 5 rows
