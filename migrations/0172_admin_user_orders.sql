-- 0172_admin_user_orders.sql
-- Already applied to production on 2026-11-09 (as 0147_admin_user_orders.sql)
--
-- One user's orders across every order table that has a user_id column, for the Orders tab of the admin
-- user drawer (GET /api/admin/users/[id]/orders). Newest first, paged in SQL. Nothing is loaded into Node to
-- be counted or merged.
-- ADDITIVE. Idempotent (CREATE OR REPLACE). One transaction. No tables, columns or indexes are changed here;
-- the (user_id, created_at DESC) indexes the branches use are in 0173_admin_user_orders_indexes.sql.
-- Must be applied BEFORE the code that calls it is deployed.
--
--   admin_user_orders(p_user_id uuid, p_source text, p_status text, p_limit int, p_offset int)
--     RETURNS jsonb {
--       "rows":           [ {...}, ... ]   the page
--       "has_more":       boolean          a row exists after this page (drives "Next" when counts are capped)
--       "counts":         {"<source>": n}  rows per source matching p_status, each capped at count_cap
--       "capped_sources": ["<source>",...] sources with more than count_cap matching rows
--       "count_cap":      1000
--       "total":          bigint           counts[p_source], or the sum of counts when p_source is NULL
--       "total_capped":   boolean          total is a lower bound (a counted source hit the cap)
--     }
--
--   Sources (p_source NULL = all of them):
--     data      public.orders                  dashboard data bundles   network + size, phone_number, price
--     api       public.api_orders              API data bundles         network + volume_gb, recipient_phone, price
--     standard  public.hubtel_data_orders      standard (Hubtel) data   network + bundle_display, beneficiary_phone, amount
--     airtime   public.airtime_orders          airtime                  network + airtime_amount, beneficiary_phone, total_paid
--     bills     public.hubtel_bill_orders      utility bills            biller, account_number, amount
--     results   public.results_checker_orders  results checker          exam_board x quantity, customer_phone, total_paid
--     afa       public.afa_orders              AFA registration         full_name, phone_number, amount
--   Not included: shop_orders and ussd_shop_orders (storefront customers' orders; they have no user_id,
--   only shop_id) and sandbox_orders (test keys, no money moves).
--
--   Row: source, id, reference, description, recipient, amount, status, payment_status, created_at.
--   reference       the table's own code (reference_code / order_code); NULL for orders and api_orders.
--   payment_status  the table's payment_status column for the tables that take payment outside the wallet
--                   (standard, bills, results: e.g. 'unpaid', 'pending_payment'); NULL for the wallet-paid
--                   tables. The UI labels unpaid rows rather than hiding them.
--   p_status  NULL = any; otherwise a case-insensitive exact match on the table's status column.
--   Order     created_at DESC, then id DESC (stable paging). orders.created_at is timestamp without time zone
--             in some environments: it is sorted on as stored (so the index is usable) and cast to timestamptz
--             only in the output.
--   Paging    p_limit clamped to 1..100 (NULL = 20), p_offset clamped to 0..10000.
--   Errors    RAISE EXCEPTION 'BAD_INPUT' for a NULL user or an unknown source.
--
-- Cost: each branch is its own ORDER BY created_at DESC, id DESC LIMIT p_offset + p_limit + 1 on
-- (user_id = p_user_id), which an index on (user_id, created_at DESC) serves by reading only that many index
-- entries (0173); the page is then picked from at most 7 x (offset + limit + 1) rows. A branch for a source other
-- than p_source is skipped by a one-time filter. Each count reads at most count_cap + 1 matching rows of its
-- table, so a user with 500k orders costs the same as one with 1,001.
-- SECURITY DEFINER (it reads every user's orders), search_path pinned, EXECUTE for service_role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_user_orders(
  p_user_id uuid,
  p_source  text,
  p_status  text,
  p_limit   int,
  p_offset  int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_cap    constant int := 1000;
  v_source text := lower(nullif(btrim(coalesce(p_source, '')), ''));
  v_status text := lower(nullif(btrim(coalesce(p_status, '')), ''));
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset int  := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_n      int;               -- rows each branch contributes: everything up to the end of this page, plus one
  v_counts jsonb;
  v_capped jsonb;
  v_total  bigint;
  v_tcap   boolean;
  v_rows   jsonb;
  v_more   boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user is required';
  END IF;
  IF v_source IS NOT NULL AND v_source NOT IN ('data', 'api', 'standard', 'airtime', 'bills', 'results', 'afa') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown source';
  END IF;
  v_n := v_offset + v_limit + 1;

  -- Counts, each stopping after c_cap + 1 matching rows.
  WITH c(source, n) AS (
    SELECT 'data', (SELECT count(*) FROM (SELECT 1 FROM public.orders o
      WHERE o.user_id = p_user_id AND (v_status IS NULL OR lower(o.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'api', (SELECT count(*) FROM (SELECT 1 FROM public.api_orders ao
      WHERE ao.user_id = p_user_id AND (v_status IS NULL OR lower(ao.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'standard', (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_data_orders hd
      WHERE hd.user_id = p_user_id AND (v_status IS NULL OR lower(hd.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'airtime', (SELECT count(*) FROM (SELECT 1 FROM public.airtime_orders air
      WHERE air.user_id = p_user_id AND (v_status IS NULL OR lower(air.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'bills', (SELECT count(*) FROM (SELECT 1 FROM public.hubtel_bill_orders hb
      WHERE hb.user_id = p_user_id AND (v_status IS NULL OR lower(hb.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'results', (SELECT count(*) FROM (SELECT 1 FROM public.results_checker_orders rc
      WHERE rc.user_id = p_user_id AND (v_status IS NULL OR lower(rc.status) = v_status) LIMIT c_cap + 1) x)
    UNION ALL SELECT 'afa', (SELECT count(*) FROM (SELECT 1 FROM public.afa_orders afa
      WHERE afa.user_id = p_user_id AND (v_status IS NULL OR lower(afa.status) = v_status) LIMIT c_cap + 1) x)
  )
  SELECT
    coalesce(jsonb_object_agg(c.source, least(c.n, c_cap)) FILTER (WHERE c.n > 0), '{}'::jsonb),
    coalesce(jsonb_agg(c.source) FILTER (WHERE c.n > c_cap), '[]'::jsonb),
    coalesce(sum(least(c.n, c_cap)) FILTER (WHERE v_source IS NULL OR c.source = v_source), 0),
    coalesce(bool_or(c.n > c_cap) FILTER (WHERE v_source IS NULL OR c.source = v_source), false)
  INTO v_counts, v_capped, v_total, v_tcap
  FROM c;

  -- The page. Each branch is a top-N on its own index; the merge only sees those rows.
  WITH u AS (
    (SELECT 'data'::text AS source, o.id, NULL::text AS reference,
            concat_ws(' ', o.network, o.size::text) AS description,
            o.phone_number::text AS recipient, o.price::numeric AS amount, o.status::text AS status,
            NULL::text AS payment_status, o.created_at::timestamptz AS created_at
     FROM public.orders o
     WHERE (v_source IS NULL OR v_source = 'data') AND o.user_id = p_user_id
       AND (v_status IS NULL OR lower(o.status) = v_status)
     ORDER BY o.created_at DESC, o.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'api', ao.id, NULL::text,
            concat_ws(' ', ao.network, ao.volume_gb::text || 'GB'),
            ao.recipient_phone::text, ao.price::numeric, ao.status::text, NULL::text, ao.created_at::timestamptz
     FROM public.api_orders ao
     WHERE (v_source IS NULL OR v_source = 'api') AND ao.user_id = p_user_id
       AND (v_status IS NULL OR lower(ao.status) = v_status)
     ORDER BY ao.created_at DESC, ao.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'standard', hd.id, hd.reference_code,
            concat_ws(' ', hd.network, hd.bundle_display),
            hd.beneficiary_phone, hd.amount::numeric, hd.status, hd.payment_status::text, hd.created_at
     FROM public.hubtel_data_orders hd
     WHERE (v_source IS NULL OR v_source = 'standard') AND hd.user_id = p_user_id
       AND (v_status IS NULL OR lower(hd.status) = v_status)
     ORDER BY hd.created_at DESC, hd.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'airtime', air.id, air.reference_code,
            concat_ws(' ', air.network, 'airtime', air.airtime_amount::text),
            air.beneficiary_phone, air.total_paid::numeric, air.status, NULL::text, air.created_at
     FROM public.airtime_orders air
     WHERE (v_source IS NULL OR v_source = 'airtime') AND air.user_id = p_user_id
       AND (v_status IS NULL OR lower(air.status) = v_status)
     ORDER BY air.created_at DESC, air.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'bills', hb.id, hb.reference_code, hb.biller,
            hb.account_number, hb.amount::numeric, hb.status, hb.payment_status::text, hb.created_at
     FROM public.hubtel_bill_orders hb
     WHERE (v_source IS NULL OR v_source = 'bills') AND hb.user_id = p_user_id
       AND (v_status IS NULL OR lower(hb.status) = v_status)
     ORDER BY hb.created_at DESC, hb.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'results', rc.id, rc.reference_code,
            rc.exam_board || ' x' || rc.quantity::text,
            rc.customer_phone, rc.total_paid::numeric, rc.status, rc.payment_status::text, rc.created_at
     FROM public.results_checker_orders rc
     WHERE (v_source IS NULL OR v_source = 'results') AND rc.user_id = p_user_id
       AND (v_status IS NULL OR lower(rc.status) = v_status)
     ORDER BY rc.created_at DESC, rc.id DESC LIMIT v_n)
    UNION ALL
    (SELECT 'afa', afa.id, afa.order_code::text,
            'AFA ' || afa.full_name::text,
            afa.phone_number::text, afa.amount::numeric, afa.status::text, NULL::text, afa.created_at::timestamptz
     FROM public.afa_orders afa
     WHERE (v_source IS NULL OR v_source = 'afa') AND afa.user_id = p_user_id
       AND (v_status IS NULL OR lower(afa.status) = v_status)
     ORDER BY afa.created_at DESC, afa.id DESC LIMIT v_n)
  ),
  ranked AS (
    SELECT u.*, row_number() OVER (ORDER BY u.created_at DESC, u.id DESC) AS rn FROM u
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'source',         r.source,
      'id',             r.id,
      'reference',      r.reference,
      'description',    r.description,
      'recipient',      r.recipient,
      'amount',         r.amount,
      'status',         r.status,
      'payment_status', r.payment_status,
      'created_at',     r.created_at
    ) ORDER BY r.rn) FILTER (WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit), '[]'::jsonb),
    coalesce(bool_or(r.rn > v_offset + v_limit), false)
  INTO v_rows, v_more
  FROM ranked r;

  RETURN jsonb_build_object(
    'rows', v_rows, 'has_more', v_more,
    'counts', v_counts, 'capped_sources', v_capped, 'count_cap', c_cap,
    'total', v_total, 'total_capped', v_tcap
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_user_orders(uuid, text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_orders(uuid, text, text, int, int) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT public.admin_user_orders('<user id>', NULL, NULL, 20, 0);
--   SELECT has_function_privilege('authenticated', 'public.admin_user_orders(uuid,text,text,int,int)', 'EXECUTE'); -- false
