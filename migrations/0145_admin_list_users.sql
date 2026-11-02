-- 0145_admin_list_users.sql
--
-- Server-side list, export and stats for the admin users page (app/admin/users, GET /api/admin/users,
-- GET /api/admin/users/export, GET /api/admin/users/[id]/stats). Replaces paging every auth user through
-- auth.admin.listUsers, loading every shop / wallet / profile / customer row into Node and one
-- shop_available_balance query per shop owner.
-- ADDITIVE. Idempotent (re-runnable). One transaction. No tables, columns or indexes are changed.
-- Must be applied BEFORE the code that calls it is deployed. list and export also read public.admin_user_tags
-- (0149_admin_user_notes_tags.sql) when they are called: apply 0149 before deploying the code too.
--
--   admin_list_users(p_search, p_role, p_suspended, p_has_shop, p_pricing_mode,
--                    p_created_from, p_created_to, p_sort, p_dir, p_limit, p_offset, p_tag DEFAULT NULL)
--     RETURNS jsonb {"total": <bigint>, "rows": [ {...}, ... ]}
--       total  number of users matching the filters (ignores limit/offset; present even when the
--              requested page is past the end, so the UI can still show "0 of N")
--       rows   one object per user, in the requested order:
--              id, email, phone_number, first_name, last_name, role, is_suspended, pricing_mode,
--              created_at, last_sign_in_at, shop_id, shop_name, shop_created_at,
--              wallet_balance, shop_balance, customer_count, sub_agent_count,
--              tags (jsonb array of the user's admin tags, A-Z; [] when none)
--     Sort      p_sort  created_at (default) | balance (wallet balance) | email (case-insensitive)
--                       | shop_balance | last_sign_in_at (never-signed-in users last in both directions)
--               p_dir   'desc' (default) | 'asc'. Ties broken by id in the same direction (stable paging).
--     Paging    p_limit clamped to 1..200 (NULL = 50), p_offset clamped to >= 0.
--     Errors    RAISE EXCEPTION 'BAD_INPUT' (detail says why) for an unknown sort, dir or pricing mode.
--
--   admin_export_users(p_search, p_role, p_suspended, p_has_shop, p_pricing_mode,
--                      p_created_from, p_created_to, p_after_created_at, p_after_id, p_limit, p_tag DEFAULT NULL)
--     RETURNS jsonb {"rows": [ {...same row objects...} ], "next_cursor": {"created_at", "id"} | null}
--     Every user matching the same filters, in a FIXED order (created_at, id) ascending, keyset-paginated:
--     pass the previous call's next_cursor back as p_after_created_at / p_after_id (both NULL to start).
--     next_cursor is null when a call returns fewer than p_limit rows. If the last rows exactly fill a
--     chunk, the cursor is set and the following call returns no rows and a null cursor. Keyset paging neither skips
--     nor repeats a row when users sign up or are deleted mid-export. A NULL auth.users.created_at sorts as
--     -infinity (first). p_limit clamped to 1..5000 (NULL = 5000). Errors: 'BAD_INPUT' for half a cursor or
--     an unknown pricing mode.
--
--   Shared by both (one definition of "matches the filters", in public.admin_users_filtered):
--     Base set is auth.users (same as the old auth.admin.listUsers loop). A user with no public.users
--     row, or an empty role, gets role 'user'; no row also means is_suspended false, pricing_mode 'role'.
--     Shop      the user's user_shops row (newest created_at if there were ever two).
--     Balances  wallet_balance = wallets.balance (0 if none; the larger one if a user ever had two rows);
--               shop_balance   = shop_available_balance.available_balance for the shop (shop_id is UNIQUE)
--                                (0 if no shop or no balance row: the value the old route returned
--                                after its "insert a zero row" fallback; nothing here writes).
--     Counts    customer_count  = shop_customers rows for the shop;
--               sub_agent_count = user_shops rows whose parent_shop_id is the shop. Both 0 without a shop.
--               Computed only for the returned rows (index lookups), not for the whole filtered set.
--     Filters   NULL = no filter. p_role exact match; p_suspended / p_has_shop booleans;
--               p_pricing_mode 'role' | 'custom'; p_created_from inclusive, p_created_to EXCLUSIVE
--               (on auth.users.created_at).
--     Tag       p_tag NULL = no filter; otherwise only users carrying that admin tag
--               (public.admin_user_tags, created by 0149_admin_user_notes_tags.sql). Trimmed and lower-cased;
--               anything that is not 1..32 of [a-z0-9-] is 'BAD_INPUT'. Applied by list and export (one EXISTS
--               on the (user_id, tag) primary key per candidate row), not inside admin_users_filtered: that
--               helper is plain LANGUAGE sql, whose body is checked when it is created, and the tags table only
--               exists once 0149 has run. The plpgsql wrappers resolve the table when they are called.
--               => list and export need 0149 applied before they are CALLED (apply every migration before
--               deploying the code). Rows carry their tags the same way.
--     Search    trimmed, first 100 chars, case-insensitive substring of email, phone_number or shop_name.
--               LIKE wildcards (\ % _) in the term are escaped, so they match literally.
--               If the term looks like a phone number (digits, optional leading +, spaces, dashes,
--               brackets) it also matches on digits: a 0XXXXXXXXX / 233XXXXXXXXX / +233 prefix is
--               reduced to the significant digits (lib/phone-format.ts ghanaSignificant) and matched as a
--               prefix of the stored number's significant digits, so 0244... finds 233244... and back;
--               a bare digit run is matched anywhere in the stored number's digits.
--
--   admin_user_stats(p_user_id uuid) RETURNS jsonb
--     Same JSON as get_user_financial_summary (optimize_admin_stats.sql), which the stats route has been
--     serving: {userId, wallet{balance,totalTopUps,totalSpent,transactionCount},
--     orders{total,completed,failed,pending}, shop{...}|null, withdrawals{totalWithdrawn,pendingCount,
--     completedCount,history[<=10]}}. All sums and counts are SQL aggregates.
--
--   Internal helpers (no grants; only the functions above call them, as their owner):
--     admin_users_search_terms(p_search)  -> (like_pattern, digits, anchored): the escaped ILIKE pattern and
--                                            the phone-digit form of the search term.
--     admin_users_filtered(...)           -> the filtered, joined rows. Plain LANGUAGE sql with no SET clause
--                                            and no SECURITY DEFINER so the planner inlines it into its caller
--                                            (an export chunk then only joins users after the cursor). Every
--                                            table name is schema-qualified, so search_path does not matter.
--
-- Why jsonb {total, rows} rather than a total_count column via count(*) over (): with a window count, a page
-- past the end returns no rows and therefore no total, and every row repeats the same number. One jsonb
-- value always carries the total, and the route maps rows without guessing.
--
-- Indexes: none added. Filters and sorts are on columns spread over auth.users, users, user_shops, wallets
-- and shop_available_balance, and the total count needs the whole filtered set, so the plan is one hash-join
-- pass over those tables; per-column indexes would not be used. The search ORs over three tables, so a
-- pg_trgm index on any one column cannot serve it (and auth.users is not ours to index); pg_trgm is not
-- enabled in this project either. The per-row counts use the existing idx_shop_customers_shop_id and
-- idx_user_shops_parent.
--
-- jit = off: the per-row count subqueries inflate the planner's cost estimate past jit_above_cost, and JIT
-- compilation then costs ~0.9 s per call against ~0.1 s of execution (measured on a 20k-user stub in
-- Postgres 16). work_mem = 32MB keeps the hash joins and the sort of the filtered set in memory.
--
-- p_tag was added (as a trailing DEFAULT NULL argument) before this migration was first deployed. The DROP
-- FUNCTION IF EXISTS lines remove the earlier 11- and 10-argument signatures from any database the draft was
-- applied to, so a call without p_tag cannot become ambiguous between two overloads. They drop nothing else.
--
-- The three RPCs are SECURITY DEFINER (they read auth.users and every user's money), pin
-- search_path = public, pg_temp, and EXECUTE is granted to service_role only.

BEGIN;

DROP FUNCTION IF EXISTS public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int);
DROP FUNCTION IF EXISTS public.admin_export_users(text, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid, int);

CREATE OR REPLACE FUNCTION public.admin_users_search_terms(
  p_search text,
  OUT like_pattern text,
  OUT digits text,
  OUT anchored boolean
)
RETURNS record
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_term text := left(nullif(btrim(coalesce(p_search, '')), ''), 100);
BEGIN
  anchored := false;
  IF v_term IS NULL THEN
    RETURN;
  END IF;
  like_pattern := '%' || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  IF v_term ~ '^\+?[0-9][0-9 ()-]*$' THEN
    digits := regexp_replace(v_term, '\D', '', 'g');
    IF digits LIKE '233%' AND length(digits) > 3 THEN
      digits := substr(digits, 4);
      anchored := true;
    ELSIF digits LIKE '0%' THEN
      digits := substr(digits, 2);
      anchored := true;
    END IF;
    digits := nullif(digits, '');
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_users_search_terms(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_users_filtered(
  p_like             text,
  p_digits           text,
  p_anchor           boolean,
  p_role             text,
  p_suspended        boolean,
  p_has_shop         boolean,
  p_pricing_mode     text,
  p_created_from     timestamptz,
  p_created_to       timestamptz,
  p_after_created_at timestamptz,
  p_after_id         uuid
)
RETURNS TABLE (
  id              uuid,
  email           text,
  created_at      timestamptz,
  created_key     timestamptz,
  last_sign_in_at timestamptz,
  phone_number    text,
  first_name      text,
  last_name       text,
  role            text,
  is_suspended    boolean,
  pricing_mode    text,
  shop_id         uuid,
  shop_name       text,
  shop_created_at timestamptz,
  wallet_balance  numeric,
  shop_balance    numeric
)
LANGUAGE sql
STABLE
AS $fn$
  SELECT
    au.id,
    au.email::text,
    au.created_at,
    coalesce(au.created_at, '-infinity'::timestamptz),
    au.last_sign_in_at,
    u.phone_number::text,
    u.first_name::text,
    u.last_name::text,
    coalesce(nullif(u.role, ''), 'user')::text,
    coalesce(u.is_suspended, false),
    coalesce(u.pricing_mode, 'role')::text,
    sh.id,
    sh.shop_name::text,
    sh.created_at,
    coalesce(w.balance, 0)::numeric,
    CASE WHEN sh.id IS NULL THEN 0 ELSE coalesce(sab.available_balance, 0) END::numeric
  FROM auth.users au
  LEFT JOIN public.users u ON u.id = au.id
  LEFT JOIN (
    SELECT DISTINCT ON (s.user_id) s.id, s.user_id, s.shop_name, s.created_at
    FROM public.user_shops s
    ORDER BY s.user_id, s.created_at DESC NULLS LAST, s.id
  ) sh ON sh.user_id = au.id
  LEFT JOIN (
    SELECT DISTINCT ON (wl.user_id) wl.user_id, wl.balance
    FROM public.wallets wl
    ORDER BY wl.user_id, wl.balance DESC NULLS LAST
  ) w ON w.user_id = au.id
  LEFT JOIN public.shop_available_balance sab
    ON sab.shop_id = sh.id
  WHERE (p_role IS NULL         OR coalesce(nullif(u.role, ''), 'user') = p_role)
    AND (p_suspended IS NULL    OR coalesce(u.is_suspended, false) = p_suspended)
    AND (p_has_shop IS NULL     OR (sh.id IS NOT NULL) = p_has_shop)
    AND (p_pricing_mode IS NULL OR coalesce(u.pricing_mode, 'role') = p_pricing_mode)
    AND (p_created_from IS NULL OR au.created_at >= p_created_from)
    AND (p_created_to IS NULL   OR au.created_at <  p_created_to)
    AND (p_after_created_at IS NULL
         OR (coalesce(au.created_at, '-infinity'::timestamptz), au.id) > (p_after_created_at, p_after_id))
    AND (
      p_like IS NULL
      OR au.email ILIKE p_like
      OR u.phone_number ILIKE p_like
      OR sh.shop_name ILIKE p_like
      OR (p_digits IS NOT NULL AND CASE
            WHEN p_anchor THEN regexp_replace(regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g'), '^(233|0)', '') LIKE p_digits || '%'
            ELSE regexp_replace(coalesce(u.phone_number, ''), '\D', '', 'g') LIKE '%' || p_digits || '%'
          END)
    )
$fn$;

REVOKE ALL ON FUNCTION public.admin_users_filtered(text, text, boolean, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;

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
  p_offset       int,
  p_tag          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET jit = off
SET work_mem = '32MB'
AS $fn$
DECLARE
  v_sort   text := lower(coalesce(nullif(btrim(p_sort), ''), 'created_at'));
  v_dir    text := lower(coalesce(nullif(btrim(p_dir), ''), 'desc'));
  v_asc    boolean;
  v_limit  int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int  := greatest(coalesce(p_offset, 0), 0);
  v_tag    text := lower(nullif(btrim(coalesce(p_tag, '')), ''));
  v_like   text;
  v_digits text;
  v_anchor boolean;
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
  IF v_tag IS NOT NULL AND v_tag !~ '^[a-z0-9-]{1,32}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'bad tag';
  END IF;
  v_asc := v_dir = 'asc';

  SELECT t.like_pattern, t.digits, t.anchored INTO v_like, v_digits, v_anchor
  FROM public.admin_users_search_terms(p_search) t;

  WITH base AS (
    SELECT f.*
    FROM public.admin_users_filtered(
      v_like, v_digits, v_anchor, p_role, p_suspended, p_has_shop, p_pricing_mode,
      p_created_from, p_created_to, NULL, NULL
    ) f
    WHERE v_tag IS NULL
       OR EXISTS (SELECT 1 FROM public.admin_user_tags tg WHERE tg.user_id = f.id AND tg.tag = v_tag)
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
                             ELSE (SELECT count(*) FROM public.user_shops sa WHERE sa.parent_shop_id = p.shop_id) END,
        'tags',            coalesce((SELECT jsonb_agg(tg.tag ORDER BY tg.tag) FROM public.admin_user_tags tg
                                     WHERE tg.user_id = p.id), '[]'::jsonb)
      ) ORDER BY p.rn)
      FROM page p
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_users(text, text, boolean, boolean, text, timestamptz, timestamptz, text, text, int, int, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.admin_export_users(
  p_search           text,
  p_role             text,
  p_suspended        boolean,
  p_has_shop         boolean,
  p_pricing_mode     text,
  p_created_from     timestamptz,
  p_created_to       timestamptz,
  p_after_created_at timestamptz,
  p_after_id         uuid,
  p_limit            int,
  p_tag              text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET jit = off
SET work_mem = '32MB'
AS $fn$
DECLARE
  v_limit  int := least(greatest(coalesce(p_limit, 5000), 1), 5000);
  v_tag    text := lower(nullif(btrim(coalesce(p_tag, '')), ''));
  v_like   text;
  v_digits text;
  v_anchor boolean;
  v_rows    jsonb;
  v_count   int;
  v_last_at timestamptz;
  v_last_id uuid;
BEGIN
  IF (p_after_created_at IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'cursor needs both created_at and id';
  END IF;
  IF p_pricing_mode IS NOT NULL AND p_pricing_mode NOT IN ('role', 'custom') THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'unknown pricing mode';
  END IF;
  IF v_tag IS NOT NULL AND v_tag !~ '^[a-z0-9-]{1,32}$' THEN
    RAISE EXCEPTION 'BAD_INPUT' USING DETAIL = 'bad tag';
  END IF;

  SELECT t.like_pattern, t.digits, t.anchored INTO v_like, v_digits, v_anchor
  FROM public.admin_users_search_terms(p_search) t;

  WITH chunk AS (
    SELECT f.*, row_number() OVER (ORDER BY f.created_key, f.id) AS rn
    FROM (
      SELECT f.*
      FROM public.admin_users_filtered(
        v_like, v_digits, v_anchor, p_role, p_suspended, p_has_shop, p_pricing_mode,
        p_created_from, p_created_to, p_after_created_at, p_after_id
      ) f
      WHERE v_tag IS NULL
         OR EXISTS (SELECT 1 FROM public.admin_user_tags tg WHERE tg.user_id = f.id AND tg.tag = v_tag)
      ORDER BY f.created_key, f.id
      LIMIT v_limit
    ) f
  )
  SELECT
    coalesce(jsonb_agg(jsonb_build_object(
      'id',              c.id,
      'email',           c.email,
      'phone_number',    c.phone_number,
      'first_name',      c.first_name,
      'last_name',       c.last_name,
      'role',            c.role,
      'is_suspended',    c.is_suspended,
      'pricing_mode',    c.pricing_mode,
      'created_at',      c.created_at,
      'last_sign_in_at', c.last_sign_in_at,
      'shop_id',         c.shop_id,
      'shop_name',       c.shop_name,
      'shop_created_at', c.shop_created_at,
      'wallet_balance',  c.wallet_balance,
      'shop_balance',    c.shop_balance,
      'customer_count',  CASE WHEN c.shop_id IS NULL THEN 0
                           ELSE (SELECT count(*) FROM public.shop_customers sc WHERE sc.shop_id = c.shop_id) END,
      'sub_agent_count', CASE WHEN c.shop_id IS NULL THEN 0
                           ELSE (SELECT count(*) FROM public.user_shops sa WHERE sa.parent_shop_id = c.shop_id) END,
      'tags',            coalesce((SELECT jsonb_agg(tg.tag ORDER BY tg.tag) FROM public.admin_user_tags tg
                                   WHERE tg.user_id = c.id), '[]'::jsonb)
    ) ORDER BY c.rn), '[]'::jsonb),
    count(*),
    (array_agg(c.created_key ORDER BY c.rn DESC))[1],
    (array_agg(c.id ORDER BY c.rn DESC))[1]
  INTO v_rows, v_count, v_last_at, v_last_id
  FROM chunk c;

  IF v_count < v_limit THEN
    RETURN jsonb_build_object('rows', v_rows, 'next_cursor', NULL);
  END IF;

  RETURN jsonb_build_object(
    'rows', v_rows,
    'next_cursor', jsonb_build_object('created_at', v_last_at, 'id', v_last_id)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.admin_export_users(text, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid, int, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_export_users(text, text, boolean, boolean, text, timestamptz, timestamptz, timestamptz, uuid, int, text)
  TO service_role;

-- Same numbers and shape as get_user_financial_summary (optimize_admin_stats.sql); only hardened
-- (STABLE, search_path pinned, schema-qualified, service_role only) and returning jsonb.
CREATE OR REPLACE FUNCTION public.admin_user_stats(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
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
--   SELECT has_function_privilege('authenticated', 'public.admin_list_users(text,text,boolean,boolean,text,timestamptz,timestamptz,text,text,int,int,text)', 'EXECUTE'); -- false
