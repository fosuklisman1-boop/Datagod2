-- 0147_admin_user_orders.sql
--
-- One user's orders across every order table that has a user_id column, for the Orders tab of the admin
-- user drawer (GET /api/admin/users/[id]/orders). Newest first, paged in SQL, with a total and per-source
-- counts from SQL aggregates (no rows are loaded into Node to be counted or merged).
-- ADDITIVE. Idempotent (CREATE OR REPLACE). One transaction. No tables, columns or indexes are changed.
-- Must be applied BEFORE the code that calls it is deployed.
--
--   admin_user_orders(p_user_id uuid, p_source text, p_status text, p_limit int, p_offset int)
--     RETURNS jsonb {"total": <bigint>, "counts": {"<source>": <bigint>, ...}, "rows": [ {...}, ... ]}
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
--   Row: source, id, reference, description, recipient, amount, status, created_at.
--   reference is the table's own code (reference_code / order_code); NULL for orders and api_orders.
--   p_status  NULL = any; otherwise a case-insensitive exact match on the table's status column.
--   counts    rows per source matching p_status (all sources, so the UI can label its source filter);
--             total = the count for p_source, or the sum when p_source is NULL.
--   Order     created_at DESC, then id DESC (stable paging). orders.created_at is timestamp without time
--             zone in some environments, so every created_at is cast to timestamptz.
--   Paging    p_limit clamped to 1..100 (NULL = 20), p_offset clamped to >= 0.
--   Errors    RAISE EXCEPTION 'BAD_INPUT' for a NULL user or an unknown source.
--
-- Each branch filters on user_id, which every table indexes (idx_*_user_id or (user_id, created_at)).
-- SECURITY DEFINER (it reads every user's orders), search_path pinned, EXECUTE for service_role only.

BEGIN;

-- Internal helper: the user's orders from every source, normalised to one row shape. Plain LANGUAGE sql,
-- no SECURITY DEFINER and no SET, so the planner inlines it into admin_user_orders and pushes the source
-- filter and the LIMIT into the branches. No grants: only admin_user_orders calls it, as its owner.
CREATE OR REPLACE FUNCTION public.admin_user_orders_union(p_user_id uuid, p_status text)
RETURNS TABLE (
  source      text,
  id          uuid,
  reference   text,
  description text,
  recipient   text,
  amount      numeric,
  status      text,
  created_at  timestamptz
)
LANGUAGE sql
STABLE
AS $fn$
  SELECT * FROM (
    SELECT 'data'::text, o.id, NULL::text,
           concat_ws(' ', o.network, o.size::text),
           o.phone_number::text, o.price::numeric, o.status::text, o.created_at::timestamptz
    FROM public.orders o
    WHERE o.user_id = p_user_id
    UNION ALL
    SELECT 'api', ao.id, NULL::text,
           concat_ws(' ', ao.network, ao.volume_gb::text || 'GB'),
           ao.recipient_phone::text, ao.price::numeric, ao.status::text, ao.created_at::timestamptz
    FROM public.api_orders ao
    WHERE ao.user_id = p_user_id
    UNION ALL
    SELECT 'standard', hd.id, hd.reference_code,
           concat_ws(' ', hd.network, hd.bundle_display),
           hd.beneficiary_phone, hd.amount::numeric, hd.status, hd.created_at
    FROM public.hubtel_data_orders hd
    WHERE hd.user_id = p_user_id
    UNION ALL
    SELECT 'airtime', air.id, air.reference_code,
           concat_ws(' ', air.network, 'airtime', air.airtime_amount::text),
           air.beneficiary_phone, air.total_paid::numeric, air.status, air.created_at
    FROM public.airtime_orders air
    WHERE air.user_id = p_user_id
    UNION ALL
    SELECT 'bills', hb.id, hb.reference_code,
           hb.biller,
           hb.account_number, hb.amount::numeric, hb.status, hb.created_at
    FROM public.hubtel_bill_orders hb
    WHERE hb.user_id = p_user_id
    UNION ALL
    SELECT 'results', rc.id, rc.reference_code,
           rc.exam_board || ' x' || rc.quantity::text,
           rc.customer_phone, rc.total_paid::numeric, rc.status, rc.created_at
    FROM public.results_checker_orders rc
    WHERE rc.user_id = p_user_id
    UNION ALL
    SELECT 'afa', afa.id, afa.order_code::text,
           'AFA ' || afa.full_name::text,
           afa.phone_number::text, afa.amount::numeric, afa.status::text, afa.created_at::timestamptz
    FROM public.afa_orders afa
    WHERE afa.user_id = p_user_id
  ) u (source, id, reference, description, recipient, amount, status, created_at)
  WHERE p_status IS NULL OR lower(u.status) = p_status
$fn$;

REVOKE ALL ON FUNCTION public.admin_user_orders_union(uuid, text) FROM PUBLIC, anon, authenticated;

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
  v_source text := lower(nullif(btrim(coalesce(p_source, '')), ''));
  v_status text := lower(nullif(btrim(coalesce(p_status, '')), ''));
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_counts jsonb;
  v_total  bigint;
  v_rows   jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'user is required';
  END IF;
  IF v_source IS NOT NULL AND v_source NOT IN ('data', 'api', 'standard', 'airtime', 'bills', 'results', 'afa') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown source';
  END IF;

  SELECT coalesce(jsonb_object_agg(c.source, c.n), '{}'::jsonb),
         coalesce(sum(c.n) FILTER (WHERE v_source IS NULL OR c.source = v_source), 0)
  INTO v_counts, v_total
  FROM (
    SELECT u.source, count(*) AS n
    FROM public.admin_user_orders_union(p_user_id, v_status) u
    GROUP BY u.source
  ) c;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'source',      p.source,
           'id',          p.id,
           'reference',   p.reference,
           'description', p.description,
           'recipient',   p.recipient,
           'amount',      p.amount,
           'status',      p.status,
           'created_at',  p.created_at
         ) ORDER BY p.created_at DESC NULLS LAST, p.id DESC), '[]'::jsonb)
  INTO v_rows
  FROM (
    SELECT u.*
    FROM public.admin_user_orders_union(p_user_id, v_status) u
    WHERE v_source IS NULL OR u.source = v_source
    ORDER BY u.created_at DESC NULLS LAST, u.id DESC
    LIMIT v_limit OFFSET v_offset
  ) p;

  RETURN jsonb_build_object('total', v_total, 'counts', v_counts, 'rows', v_rows);
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_user_orders(uuid, text, text, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_orders(uuid, text, text, int, int) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT public.admin_user_orders('<user id>', NULL, NULL, 20, 0);
--   SELECT has_function_privilege('authenticated', 'public.admin_user_orders(uuid,text,text,int,int)', 'EXECUTE'); -- false
