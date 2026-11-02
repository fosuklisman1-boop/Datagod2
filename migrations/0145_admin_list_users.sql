-- 0145_admin_list_users.sql
--
-- Server-side list + stats for the admin users page (app/admin/users, GET /api/admin/users,
-- GET /api/admin/users/[id]/stats). Replaces paging every auth user through auth.admin.listUsers,
-- loading every shop / wallet / profile / customer row into Node and one shop_available_balance
-- query per shop owner.
-- ADDITIVE. Idempotent (re-runnable). One transaction. No tables, columns or indexes are changed.
-- Must be applied BEFORE the code that calls it is deployed.
--
--   admin_list_users(p_search, p_role, p_suspended, p_has_shop, p_pricing_mode,
--                    p_created_from, p_created_to, p_sort, p_dir, p_limit, p_offset)
--     RETURNS jsonb {"total": <bigint>, "rows": [ {...}, ... ]}
--       total  number of users matching the filters (ignores limit/offset; present even when the
--              requested page is past the end, so the UI can still show "0 of N")
--       rows   one object per user, in the requested order:
--              id, email, phone_number, first_name, last_name, role, is_suspended, pricing_mode,
--              created_at, last_sign_in_at, shop_id, shop_name, shop_created_at,
--              wallet_balance, shop_balance, customer_count, sub_agent_count
--     Base set is auth.users (same as the old auth.admin.listUsers loop). A user with no public.users
--     row gets role 'user', is_suspended false, pricing_mode 'role' (the old route's defaults).
--     Shop      the user's user_shops row (newest created_at if there were ever two).
--     Balances  wallet_balance = wallets.balance (0 if none);
--               shop_balance   = shop_available_balance.available_balance for the shop
--                                (0 if no shop or no balance row: the value the old route returned
--                                after its "insert a zero row" fallback; this function does not write).
--     Counts    customer_count  = shop_customers rows for the shop;
--               sub_agent_count = user_shops rows whose parent_shop_id is the shop. Both 0 without a shop.
--               Computed only for the returned page (index lookups), not for the whole filtered set.
--     Filters   NULL = no filter. p_role exact match; p_suspended / p_has_shop booleans;
--               p_pricing_mode 'role' | 'custom'; p_created_from inclusive, p_created_to EXCLUSIVE
--               (on auth.users.created_at).
--     Search    trimmed, first 100 chars, case-insensitive substring of email, phone_number or shop_name.
--               LIKE wildcards (\ % _) in the term are escaped, so they match literally.
--               If the term looks like a phone number (digits, optional leading +, spaces, dashes,
--               brackets) it also matches on digits: a 0XXXXXXXXX / 233XXXXXXXXX / +233 prefix is
--               reduced to the significant digits (lib/phone-format.ts ghanaSignificant) and matched as a
--               prefix of the stored number's significant digits, so 0244... finds 233244... and back;
--               a bare digit run is matched anywhere in the stored number's digits.
--     Sort      p_sort  created_at (default) | balance (wallet balance) | email (case-insensitive)
--                       | shop_balance | last_sign_in_at (never-signed-in users last in both directions)
--               p_dir   'desc' (default) | 'asc'. Ties broken by id in the same direction (stable paging).
--     Paging    p_limit clamped to 1..200 (NULL = 50), p_offset clamped to >= 0.
--     Errors    RAISE EXCEPTION 'BAD_INPUT' (detail says why) for an unknown sort, dir or pricing mode.
--
--   admin_user_stats(p_user_id uuid) RETURNS jsonb
--     Same JSON as get_user_financial_summary (optimize_admin_stats.sql), which the stats route has been
--     serving: {userId, wallet{balance,totalTopUps,totalSpent,transactionCount},
--     orders{total,completed,failed,pending}, shop{...}|null, withdrawals{totalWithdrawn,pendingCount,
--     completedCount,history[<=10]}}. All sums and counts are SQL aggregates.
--
-- Why jsonb {total, rows} rather than a total_count column via count(*) over (): with a window count, a page
-- past the end returns no rows and therefore no total, and every row repeats the same number. One jsonb
-- value always carries the total, and the route maps rows without guessing.
--
-- Indexes: none added. Filters and sorts are on columns spread over auth.users, users, user_shops, wallets
-- and shop_available_balance, and the total count needs the whole filtered set, so the plan is one hash-join
-- pass over those tables; per-column indexes would not be used. The search ORs over three tables, so a
-- pg_trgm index on any one column cannot serve it (and auth.users is not ours to index); pg_trgm is not
-- enabled in this project either. The per-page counts use the existing idx_shop_customers_shop_id and
-- idx_user_shops_parent; the balance lookup uses idx_shop_available_balance_shop_id.
--
-- jit = off on admin_list_users: the per-page count subqueries inflate the planner's cost estimate past
-- jit_above_cost, and JIT compilation then costs ~0.9 s per call against ~0.1 s of execution (measured on a
-- 20k-user stub in Postgres 16).
--
-- Both functions are SECURITY DEFINER (they read auth.users and every user's money) and EXECUTE is granted to
-- service_role only.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_list_users(
  p_search       text,
  p_role         text,
  p_suspended    boolean,
  p_has_shop     boolean,
  p_pricing_mode text,
  p_created_from timestamptz,
  p_created_to   timestamptz,
  p_sort         text,
  p_dir          text,
  p_limit        int,
  p_offset       int
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET jit = off
AS $fn$
DECLARE
  v_sort   text    := lower(coalesce(nullif(btrim(p_sort), ''), 'created_at'));
  v_dir    text    := lower(coalesce(nullif(btrim(p_dir), ''), 'desc'));
  v_asc    boolean;
  v_limit  int     := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int     := greatest(coalesce(p_offset, 0), 0);
  v_term   text    := left(nullif(btrim(coalesce(p_search, '')), ''), 100);
  v_like   text;
  v_digits text;
  v_anchor boolean := false;
  v_result jsonb;
BEGIN
  IF v_sort NOT IN ('created_at', 'balance', 'email', 'shop_balance', 'last_sign_in_at') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown sort';
  END IF;
  IF v_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown dir';
  END IF;
  IF p_pricing_mode IS NOT NULL AND p_pricing_mode NOT IN ('role', 'custom') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown pricing mode';
  END IF;
  v_asc := v_dir = 'asc';

  IF v_term IS NOT NULL THEN
    v_like := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    IF v_term ~ '^\+?[0-9][0-9 ()-]*$' THEN
      v_digits := regexp_replace(v_term, '\D', '', 'g');
      IF v_digits LIKE '233%' AND length(v_digits) > 3 THEN
        v_digits := substr(v_digits, 4);
        v_anchor := true;
      ELSIF v_digits LIKE '0%' THEN
        v_digits := substr(v_digits, 2);
        v_anchor := true;
      END IF;
      v_digits := nullif(v_digits, '');
    END IF;
  END IF;

  WITH shop AS (
    SELECT DISTINCT ON (s.user_id) s.id, s.user_id, s.shop_name, s.created_at
    FROM public.user_shops s
    ORDER BY s.user_id, s.created_at DESC NULLS LAST, s.id
  ),
  wallet AS (
    SELECT DISTINCT ON (w.user_id) w.user_id, w.balance
    FROM public.wallets w
    ORDER BY w.user_id, w.balance DESC NULLS LAST
  ),
  base AS (
    SELECT
      au.id,
      au.email::text                        AS email,
      au.created_at,
      au.last_sign_in_at,
      u.phone_number,
      u.first_name,
      u.last_name,
      coalesce(u.role, 'user')               AS role,
      coalesce(u.is_suspended, false)        AS is_suspended,
      coalesce(u.pricing_mode, 'role')       AS pricing_mode,
      sh.id                                  AS shop_id,
      sh.shop_name,
      sh.created_at                          AS shop_created_at,
      coalesce(w.balance, 0)                 AS wallet_balance,
      CASE WHEN sh.id IS NULL THEN 0 ELSE coalesce(sab.available_balance, 0) END AS shop_balance
    FROM auth.users au
    LEFT JOIN public.users u ON u.id = au.id
    LEFT JOIN shop sh        ON sh.user_id = au.id
    LEFT JOIN wallet w       ON w.user_id = au.id
    LEFT JOIN LATERAL (
      SELECT b.available_balance
      FROM public.shop_available_balance b
      WHERE b.shop_id = sh.id
      ORDER BY b.updated_at DESC NULLS LAST
      LIMIT 1
    ) sab ON true
    WHERE (p_role IS NULL         OR coalesce(u.role, 'user') = p_role)
      AND (p_suspended IS NULL    OR coalesce(u.is_suspended, false) = p_suspended)
      AND (p_has_shop IS NULL     OR (sh.id IS NOT NULL) = p_has_shop)
      AND (p_pricing_mode IS NULL OR coalesce(u.pricing_mode, 'role') = p_pricing_mode)
      AND (p_created_from IS NULL OR au.created_at >= p_created_from)
      AND (p_created_to IS NULL   OR au.created_at <  p_created_to)
      AND (
        v_like IS NULL
        OR au.email ILIKE v_like
        OR u.phone_number ILIKE v_like
        OR sh.shop_name ILIKE v_like
        OR (v_digits IS NOT NULL AND CASE
              WHEN v_anchor THEN regexp_replace(regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g'), '^(233|0)', '') LIKE v_digits || '%'
              ELSE regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g') LIKE '%' || v_digits || '%'
            END)
      )
  ),
  ranked AS (
    SELECT b.*,
      row_number() OVER (ORDER BY
        CASE WHEN v_asc     AND v_sort = 'created_at'      THEN b.created_at END ASC  NULLS LAST,
        CASE WHEN NOT v_asc AND v_sort = 'created_at'      THEN b.created_at END DESC NULLS LAST,
        CASE WHEN v_asc     AND v_sort = 'last_sign_in_at' THEN b.last_sign_in_at END ASC  NULLS LAST,
        CASE WHEN NOT v_asc AND v_sort = 'last_sign_in_at' THEN b.last_sign_in_at END DESC NULLS LAST,
        CASE WHEN v_asc     AND v_sort = 'balance'         THEN b.wallet_balance END ASC  NULLS LAST,
        CASE WHEN NOT v_asc AND v_sort = 'balance'         THEN b.wallet_balance END DESC NULLS LAST,
        CASE WHEN v_asc     AND v_sort = 'shop_balance'    THEN b.shop_balance END ASC  NULLS LAST,
        CASE WHEN NOT v_asc AND v_sort = 'shop_balance'    THEN b.shop_balance END DESC NULLS LAST,
        CASE WHEN v_asc     AND v_sort = 'email'           THEN lower(b.email) END ASC  NULLS LAST,
        CASE WHEN NOT v_asc AND v_sort = 'email'           THEN lower(b.email) END DESC NULLS LAST,
        CASE WHEN v_asc     THEN b.id END ASC,
        CASE WHEN NOT v_asc THEN b.id END DESC
      ) AS rn
    FROM base b
  ),
  page AS (
    SELECT r.*
    FROM ranked r
    WHERE r.rn > v_offset AND r.rn <= v_offset + v_limit
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM base),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id',              p.id,
        'email',           p.email,
        'phone_number',    p.phone_number,
        'first_name',      p.first_name,
        'last_name',       p.last_name,
        'role',            p.role,
        'is_suspended',    p.is_suspended,
        'pricing_mode',    p.pricing_mode,
        'created_at',      p.created_at,
        'last_sign_in_at', p.last_sign_in_at,
        'shop_id',         p.shop_id,
        'shop_name',       p.shop_name,
        'shop_created_at', p.shop_created_at,
        'wallet_balance',  p.wallet_balance,
        'shop_balance',    p.shop_balance,
        'customer_count',  CASE WHEN p.shop_id IS NULL THEN 0
                             ELSE (SELECT count(*) FROM public.shop_customers c WHERE c.shop_id = p.shop_id) END,
        'sub_agent_count', CASE WHEN p.shop_id IS NULL THEN 0
                             ELSE (SELECT count(*) FROM public.user_shops sa WHERE sa.parent_shop_id = p.shop_id) END
      ) ORDER BY p.rn)
      FROM page p
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int)
  TO service_role;

-- Same numbers and shape as get_user_financial_summary (optimize_admin_stats.sql); only hardened
-- (STABLE, search_path pinned, schema-qualified, service_role only) and returning jsonb.
CREATE OR REPLACE FUNCTION public.admin_user_stats(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet_balance    numeric;
  v_total_topups      numeric;
  v_total_spent       numeric;
  v_transaction_count bigint;
  v_orders_total      bigint;
  v_orders_completed  bigint;
  v_orders_failed     bigint;
  v_shop_id           uuid;
  v_shop_stats        jsonb := NULL;
  v_withdrawals       jsonb;
  v_history           jsonb;
BEGIN
  SELECT w.balance INTO v_wallet_balance FROM public.wallets w WHERE w.user_id = p_user_id;

  SELECT
    coalesce(sum(CASE WHEN t.type = 'credit' AND t.source = 'wallet_topup' AND t.status = 'completed' THEN t.amount ELSE 0 END), 0),
    coalesce(sum(CASE WHEN t.type = 'debit' AND t.status IN ('completed', 'success') THEN abs(t.amount) ELSE 0 END), 0),
    count(*)
  INTO v_total_topups, v_total_spent, v_transaction_count
  FROM public.transactions t
  WHERE t.user_id = p_user_id;

  SELECT
    count(*),
    count(*) FILTER (WHERE o.status IN ('completed', 'delivered', 'success')),
    count(*) FILTER (WHERE o.status = 'failed')
  INTO v_orders_total, v_orders_completed, v_orders_failed
  FROM public.orders o
  WHERE o.user_id = p_user_id;

  SELECT s.id INTO v_shop_id FROM public.user_shops s WHERE s.user_id = p_user_id;

  IF v_shop_id IS NOT NULL THEN
    SELECT jsonb_build_object(
      'shopId',           s.id,
      'shopName',         s.shop_name,
      'shopSlug',         s.shop_slug,
      'createdAt',        s.created_at,
      'totalOrders',      so.total_orders,
      'paidOrders',       so.paid_orders,
      'completedOrders',  so.completed_orders,
      'totalSales',       so.total_sales,
      'availableBalance', coalesce(b.available_balance, 0),
      'withdrawnAmount',  coalesce(b.withdrawn_profit, 0),
      'totalProfit',      coalesce(b.total_profit, 0),
      'pendingProfit',    coalesce(b.pending_profit, 0),
      'creditedProfit',   coalesce(b.credited_profit, 0),
      'profitRecords',    (SELECT count(*) FROM public.shop_profits sp WHERE sp.shop_id = v_shop_id)
    )
    INTO v_shop_stats
    FROM public.user_shops s
    LEFT JOIN public.shop_available_balance b ON b.shop_id = s.id
    CROSS JOIN LATERAL (
      SELECT
        count(*)                                                                     AS total_orders,
        count(*) FILTER (WHERE o.payment_status = 'completed')                       AS paid_orders,
        count(*) FILTER (WHERE o.order_status IN ('completed', 'delivered'))         AS completed_orders,
        coalesce(sum(o.total_price) FILTER (WHERE o.payment_status = 'completed'), 0) AS total_sales
      FROM public.shop_orders o
      WHERE o.shop_id = v_shop_id
    ) so
    WHERE s.id = v_shop_id;
  END IF;

  SELECT jsonb_agg(h) INTO v_history FROM (
    SELECT
      wr.id, wr.amount, wr.fee_amount AS "feeAmount", wr.net_amount AS "netAmount",
      wr.status, wr.withdrawal_method AS method, wr.created_at AS "createdAt", wr.reference_code AS "referenceCode"
    FROM public.withdrawal_requests wr
    WHERE wr.user_id = p_user_id
    ORDER BY wr.created_at DESC
    LIMIT 10
  ) h;

  SELECT jsonb_build_object(
    'totalWithdrawn', coalesce(sum(CASE WHEN wr.status IN ('completed', 'approved') THEN wr.net_amount ELSE 0 END), 0),
    'pendingCount',   count(*) FILTER (WHERE wr.status = 'pending'),
    'completedCount', count(*) FILTER (WHERE wr.status IN ('completed', 'approved')),
    'history',        coalesce(v_history, '[]'::jsonb)
  )
  INTO v_withdrawals
  FROM public.withdrawal_requests wr
  WHERE wr.user_id = p_user_id;

  RETURN jsonb_build_object(
    'userId', p_user_id,
    'wallet', jsonb_build_object(
      'balance',          coalesce(v_wallet_balance, 0),
      'totalTopUps',      v_total_topups,
      'totalSpent',       v_total_spent,
      'transactionCount', v_transaction_count
    ),
    'orders', jsonb_build_object(
      'total',     v_orders_total,
      'completed', v_orders_completed,
      'failed',    v_orders_failed,
      'pending',   v_orders_total - v_orders_completed - v_orders_failed
    ),
    'shop',        v_shop_stats,
    'withdrawals', v_withdrawals
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_user_stats(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_stats(uuid) TO service_role;

COMMIT;

-- Verify after apply:
--   SELECT (public.admin_list_users(NULL,NULL,NULL,NULL,NULL,NULL,NULL,'created_at','desc',5,0))->'total';  -- = count(*) FROM auth.users
--   SELECT public.admin_user_stats('<some user id>') = public.get_user_financial_summary('<same id>')::jsonb; -- true
--   SELECT has_function_privilege('authenticated', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int)', 'EXECUTE'); -- false
